/**
 * s3.ts — helpers de S3 para FT-17 static deploy.
 *
 * Ops in-container (destroy/list) usam o AWS SDK v3 — o container api (node:20-alpine)
 * NÃO tem aws-cli, então as versões antigas via execAsync falhavam com "aws: not found"
 * (quebrava s3CleanupWorker + s3ReconciliationWorker silenciosamente).
 * O CREATE de bucket roda no HOST via scripts/s3_deploy_runner.py (que tem aws-cli);
 * createBucketAndConfigure abaixo é legado sem consumidor in-container (@deprecated).
 *
 * Credenciais: AWS_S3_DEPLOY_ACCESS_KEY_ID / AWS_S3_DEPLOY_SECRET_ACCESS_KEY (env dedicada).
 * Região: AWS_S3_DEPLOY_REGION (default us-east-1).
 *
 * Nomeação: <prefix>-<project_short_12>-<crypto_random_12hex>
 *   Prefix é AWS-scoped pelo IAM policy (só genesis-*).
 */
import { randomBytes } from "node:crypto";
import {
  S3Client,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketPolicyCommand,
  DeleteBucketWebsiteCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from "@aws-sdk/client-resource-groups-tagging-api";

const PREFIX = () => (process.env.S3_STATIC_BUCKET_PREFIX ?? "genesis").trim();
const REGION = () => (process.env.AWS_S3_DEPLOY_REGION ?? "us-east-1").trim();

// ─── AWS SDK clients (credenciais explícitas — evita bug de AWS_PROFILE do post-mortem) ───
function deployCredentials() {
  return {
    accessKeyId: (process.env.AWS_S3_DEPLOY_ACCESS_KEY_ID ?? "").trim(),
    secretAccessKey: (process.env.AWS_S3_DEPLOY_SECRET_ACCESS_KEY ?? "").trim(),
  };
}

let _s3: S3Client | null = null;
function s3Client(): S3Client {
  if (!_s3) _s3 = new S3Client({ region: REGION(), credentials: deployCredentials() });
  return _s3;
}

let _tagging: ResourceGroupsTaggingAPIClient | null = null;
function taggingClient(): ResourceGroupsTaggingAPIClient {
  if (!_tagging) _tagging = new ResourceGroupsTaggingAPIClient({ region: REGION(), credentials: deployCredentials() });
  return _tagging;
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

// ─── Destroy (versioning-safe, via SDK) ──────────────────────────────────
// NOTA: o CREATE de bucket + upload roda no HOST via scripts/s3_deploy_runner.py
// (que tem aws-cli). A configuração de bucket in-container foi removida — era código
// morto (sem consumidor) que dependia do aws-cli ausente no container api.

function isNoSuchBucket(err: unknown): boolean {
  const name = (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code ?? "";
  return name === "NoSuchBucket" || name === "NotFound";
}

export async function destroyBucket(bucketName: string): Promise<void> {
  const s3 = s3Client();

  // 1. Deletar todos os objetos (paginado, lotes ≤1000)
  try {
    let token: string | undefined;
    do {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken: token }));
      const objs = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
      for (let i = 0; i < objs.length; i += 1000) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: objs.slice(i, i + 1000) } }));
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  } catch (err) { if (!isNoSuchBucket(err)) { /* segue */ } }

  // 2. Deletar versões e delete markers (se versionamento estiver on)
  try {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const v = await s3.send(new ListObjectVersionsCommand({
        Bucket: bucketName, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
      }));
      const toDelete = [...(v.Versions ?? []), ...(v.DeleteMarkers ?? [])]
        .map((x) => ({ Key: x.Key!, VersionId: x.VersionId! }))
        .filter((x) => x.Key && x.VersionId);
      for (let i = 0; i < toDelete.length; i += 1000) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: toDelete.slice(i, i + 1000) } }));
      }
      if (v.IsTruncated) { keyMarker = v.NextKeyMarker; versionIdMarker = v.NextVersionIdMarker; }
      else { keyMarker = undefined; versionIdMarker = undefined; }
    } while (keyMarker || versionIdMarker);
  } catch (err) { if (!isNoSuchBucket(err)) { /* segue */ } }

  // 3. Deletar policy e website config (best-effort)
  await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucketName })).catch(() => null);
  await s3.send(new DeleteBucketWebsiteCommand({ Bucket: bucketName })).catch(() => null);

  // 4. Deletar o bucket — NoSuchBucket = idempotente (reconciliação assume seguro)
  try {
    await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
  } catch (err) {
    if (!isNoSuchBucket(err)) throw err;
  }
}

// ─── URL builder ──────────────────────────────────────────────────────────
export function s3WebsiteUrl(bucketName: string): string {
  return `http://${bucketName}.s3-website-${REGION()}.amazonaws.com`;
}

// ─── Lista buckets Genesis via tags (para reconciliação) ─────────────────
export async function listGenesisBucketsByTag(): Promise<
  Array<{ bucketName: string; projectId?: string; tenantId?: string; deploymentId?: string; ttlExpiresAt?: string }>
> {
  const tagging = taggingClient();
  const out: Array<{ bucketName: string; projectId?: string; tenantId?: string; deploymentId?: string; ttlExpiresAt?: string }> = [];
  let paginationToken: string | undefined;
  do {
    const res = await tagging.send(new GetResourcesCommand({
      TagFilters: [{ Key: "zentriz:product", Values: ["genesis"] }],
      ResourceTypeFilters: ["s3"],
      PaginationToken: paginationToken,
    }));
    for (const r of res.ResourceTagMappingList ?? []) {
      const bucketName = (r.ResourceARN ?? "").replace("arn:aws:s3:::", "");
      if (!bucketName) continue;
      const tagMap = new Map((r.Tags ?? []).map((t) => [t.Key, t.Value]));
      out.push({
        bucketName,
        projectId: tagMap.get("zentriz:project_id"),
        tenantId: tagMap.get("zentriz:tenant_id"),
        deploymentId: tagMap.get("zentriz:deployment_id"),
        ttlExpiresAt: tagMap.get("zentriz:ttl_expires_at"),
      });
    }
    paginationToken = res.PaginationToken || undefined;
  } while (paginationToken);
  return out;
}
