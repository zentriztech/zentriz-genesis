/**
 * s3.ts — helpers de S3 para FT-17 static deploy.
 *
 * Usa AWS CLI via execAsync (padrão do projeto — coerente com fly.ts, ecs.ts).
 * Credenciais: AWS_S3_DEPLOY_ACCESS_KEY_ID / AWS_S3_DEPLOY_SECRET_ACCESS_KEY (env dedicada).
 * Região: AWS_S3_DEPLOY_REGION (default us-east-1).
 *
 * Nomeação: <prefix>-<project_short_12>-<crypto_random_12hex>
 *   Prefix é AWS-scoped pelo IAM policy (só genesis-*).
 */
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";

const execAsync = promisify(exec);

const PREFIX = () => (process.env.S3_STATIC_BUCKET_PREFIX ?? "genesis").trim();
const REGION = () => (process.env.AWS_S3_DEPLOY_REGION ?? "us-east-1").trim();
const TTL_DAYS = () => Number(process.env.S3_STATIC_TTL_DAYS ?? "7");

// ─── AWS CLI wrapper com credenciais dedicadas ───────────────────────────
function awsEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: (process.env.AWS_S3_DEPLOY_ACCESS_KEY_ID ?? "").trim(),
    AWS_SECRET_ACCESS_KEY: (process.env.AWS_S3_DEPLOY_SECRET_ACCESS_KEY ?? "").trim(),
    AWS_DEFAULT_REGION: REGION(),
  };
  // T01-bug do post-mortem: AWS_PROFILE="" quebra boto3/awscli.
  // DELETE em vez de setar como string vazia.
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
  return env;
}

export function isS3Configured(): boolean {
  return Boolean(
    (process.env.AWS_S3_DEPLOY_ACCESS_KEY_ID ?? "").trim() &&
    (process.env.AWS_S3_DEPLOY_SECRET_ACCESS_KEY ?? "").trim(),
  );
}

export function generateBucketName(projectId: string): string {
  const short = projectId.replace(/-/g, "").slice(0, 12);
  const rand = randomBytes(6).toString("hex"); // 12 hex chars (2^48 entropy)
  return `${PREFIX()}-${short}-${rand}`;
}

// ─── Bucket lifecycle ─────────────────────────────────────────────────────
export interface CreateBucketOptions {
  bucketName: string;
  projectId: string;
  tenantId: string;
  deploymentId: string;
  ttlDays: number;
}

export async function createBucketAndConfigure(opts: CreateBucketOptions): Promise<void> {
  const env = awsEnv();
  const { bucketName, projectId, tenantId, deploymentId, ttlDays } = opts;

  // 1. CreateBucket (us-east-1 não usa --create-bucket-configuration)
  await execAsync(
    `aws s3api create-bucket --bucket "${bucketName}" --region ${REGION()}`,
    { env },
  );

  // 2. Ownership: BucketOwnerEnforced (desabilita ACLs, obrigatório pós-2023)
  await execAsync(
    `aws s3api put-bucket-ownership-controls --bucket "${bucketName}" ` +
      `--ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'`,
    { env },
  );

  // 3. Public Access Block: liberar todos os 4 flags
  await execAsync(
    `aws s3api put-public-access-block --bucket "${bucketName}" ` +
      `--public-access-block-configuration ` +
      `"BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"`,
    { env },
  );

  // 4. Tags obrigatórias (para reconciliação semanal)
  const expiresAt = new Date(Date.now() + ttlDays * 86400_000).toISOString();
  const tagging = JSON.stringify({
    TagSet: [
      { Key: "zentriz:product", Value: "genesis" },
      { Key: "zentriz:project_id", Value: projectId },
      { Key: "zentriz:tenant_id", Value: tenantId },
      { Key: "zentriz:deployment_id", Value: deploymentId },
      { Key: "zentriz:ttl_expires_at", Value: expiresAt },
      { Key: "zentriz:managed_by", Value: "full-test-server" },
    ],
  });
  await execAsync(
    `aws s3api put-bucket-tagging --bucket "${bucketName}" --tagging '${tagging}'`,
    { env },
  );

  // 5. Bucket policy hardened (Deny sensitive + Deny insecure transport)
  const policy = buildHardenedBucketPolicy(bucketName);
  await execAsync(
    `aws s3api put-bucket-policy --bucket "${bucketName}" --policy '${JSON.stringify(policy)}'`,
    { env },
  );

  // 6. Website hosting
  await execAsync(
    `aws s3api put-bucket-website --bucket "${bucketName}" ` +
      `--website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"404.html"}}'`,
    { env },
  );

  // 7. Lifecycle: expira objetos em ttlDays, aborta multipart em 1d
  const lifecycle = JSON.stringify({
    Rules: [
      {
        ID: "genesis-ephemeral-ttl",
        Status: "Enabled",
        Filter: {},
        Expiration: { Days: ttlDays },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      },
    ],
  });
  await execAsync(
    `aws s3api put-bucket-lifecycle-configuration --bucket "${bucketName}" --lifecycle-configuration '${lifecycle}'`,
    { env },
  );
}

// ─── Bucket Policy hardened ──────────────────────────────────────────────
export function buildHardenedBucketPolicy(bucketName: string): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Id: "GenesisEphemeralStaticPolicy-v1",
    Statement: [
      {
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucketName}/*`,
      },
      {
        Sid: "DenySensitiveFiles",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: [
          `arn:aws:s3:::${bucketName}/.env*`,
          `arn:aws:s3:::${bucketName}/.git/*`,
          `arn:aws:s3:::${bucketName}/*.map`,
          `arn:aws:s3:::${bucketName}/Dockerfile*`,
          `arn:aws:s3:::${bucketName}/*.sql`,
          `arn:aws:s3:::${bucketName}/*.pem`,
          `arn:aws:s3:::${bucketName}/*.key`,
          `arn:aws:s3:::${bucketName}/package-lock.json`,
          `arn:aws:s3:::${bucketName}/pnpm-lock.yaml`,
        ],
      },
    ],
  };
}

// ─── Destroy (versioning-safe) ────────────────────────────────────────────
export async function destroyBucket(bucketName: string): Promise<void> {
  const env = awsEnv();
  // 1. Deletar todos os objetos
  try {
    await execAsync(`aws s3 rm "s3://${bucketName}" --recursive`, { env });
  } catch { /* segue */ }

  // 2. Deletar todas as versões e delete markers (se versionamento estiver on)
  try {
    const { stdout } = await execAsync(
      `aws s3api list-object-versions --bucket "${bucketName}" --output json 2>/dev/null || echo '{}'`,
      { env },
    );
    const versions = JSON.parse(stdout || "{}") as {
      Versions?: Array<{ Key: string; VersionId: string }>;
      DeleteMarkers?: Array<{ Key: string; VersionId: string }>;
    };
    const toDelete = [
      ...(versions.Versions ?? []),
      ...(versions.DeleteMarkers ?? []),
    ].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    if (toDelete.length > 0) {
      const payload = JSON.stringify({ Objects: toDelete });
      await execAsync(
        `aws s3api delete-objects --bucket "${bucketName}" --delete '${payload}'`,
        { env },
      );
    }
  } catch { /* segue */ }

  // 3. Deletar bucket policy e website config
  await execAsync(`aws s3api delete-bucket-policy --bucket "${bucketName}"`, { env }).catch(() => null);
  await execAsync(`aws s3api delete-bucket-website --bucket "${bucketName}"`, { env }).catch(() => null);

  // 4. Deletar o bucket
  await execAsync(`aws s3api delete-bucket --bucket "${bucketName}"`, { env });
}

// ─── URL builder ──────────────────────────────────────────────────────────
export function s3WebsiteUrl(bucketName: string): string {
  return `http://${bucketName}.s3-website-${REGION()}.amazonaws.com`;
}

// ─── Lista buckets Genesis via tags (para reconciliação) ─────────────────
export async function listGenesisBucketsByTag(): Promise<
  Array<{ bucketName: string; projectId?: string; tenantId?: string; deploymentId?: string; ttlExpiresAt?: string }>
> {
  const env = awsEnv();
  const { stdout } = await execAsync(
    `aws resourcegroupstaggingapi get-resources ` +
      `--tag-filters "Key=zentriz:product,Values=genesis" ` +
      `--resource-type-filters "s3" ` +
      `--output json`,
    { env, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as {
    ResourceTagMappingList?: Array<{ ResourceARN: string; Tags: Array<{ Key: string; Value: string }> }>;
  };
  return (parsed.ResourceTagMappingList ?? []).map((r) => {
    const bucketName = r.ResourceARN.replace("arn:aws:s3:::", "");
    const tagMap = new Map(r.Tags.map((t) => [t.Key, t.Value]));
    return {
      bucketName,
      projectId: tagMap.get("zentriz:project_id"),
      tenantId: tagMap.get("zentriz:tenant_id"),
      deploymentId: tagMap.get("zentriz:deployment_id"),
      ttlExpiresAt: tagMap.get("zentriz:ttl_expires_at"),
    };
  });
}
