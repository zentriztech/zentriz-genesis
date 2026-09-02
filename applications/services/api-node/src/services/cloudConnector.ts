/**
 * cloudConnector.ts — Syncs tenant cloud credentials as GitHub Actions secrets.
 *
 * Maps provider credentials to standardized GitHub secret names:
 *
 * AWS:
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_REGION
 *   AWS_ECR_REGISTRY        (optional: if provided)
 *   AWS_ECS_CLUSTER         (optional: if provided)
 *
 * Azure:
 *   AZURE_CREDENTIALS       (JSON: { clientId, clientSecret, subscriptionId, tenantId })
 *   AZURE_RESOURCE_GROUP    (optional)
 *   AZURE_CONTAINER_APP     (optional: container app name)
 *
 * GCP:
 *   GCP_SA_KEY              (JSON: service account key file content)
 *   GCP_PROJECT_ID
 *   GCP_REGION              (optional)
 *   GCP_SERVICE_NAME        (optional: Cloud Run service name)
 */

import { pool } from "../db/client.js";
import { decryptCredentials, type EncryptedPayload } from "./crypto.js";
import { setRepoSecret, deleteRepoSecret } from "./github.js";

// ── Credential shapes ─────────────────────────────────────────────────────────

export interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  ecrRegistry?: string;
  ecsCluster?: string;
  // G1-T6 (seam GATE 2): grant cross-account via sts:AssumeRole + externalId.
  // No GATE 1 (conta Zentriz) não são usados; no GATE 2 alimentam o
  // AssumeRoleCredentialProvider. accessKeyId/secretAccessKey ficam opcionais
  // quando roleArn está presente (modelo de role tem precedência).
  roleArn?: string;
  externalId?: string;
}

export interface AzureCredentials {
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  tenantId: string;
  resourceGroup?: string;
  containerAppName?: string;
}

export interface GCPCredentials {
  serviceAccountKey: string; // full JSON string
  projectId: string;
  region?: string;
  serviceName?: string;
}

export type CloudCredentials = AWSCredentials | AzureCredentials | GCPCredentials;

export interface CloudConnection {
  id: string;
  tenantId: string;
  provider: "aws" | "azure" | "gcp";
  region: string | null;
  serviceType: string;
  slotIndex: number;
  label: string | null;
  githubSecretsSyncedAt: string | null;
  status: string;
  createdAt: string;
}

// ── Secret name mappings ──────────────────────────────────────────────────────

function getSecretMap(provider: "aws" | "azure" | "gcp", credentials: CloudCredentials): Record<string, string> {
  if (provider === "aws") {
    const c = credentials as AWSCredentials;
    const map: Record<string, string> = {
      AWS_ACCESS_KEY_ID:     c.accessKeyId,
      AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
      AWS_REGION:            c.region,
    };
    if (c.ecrRegistry)  map.AWS_ECR_REGISTRY = c.ecrRegistry;
    if (c.ecsCluster)   map.AWS_ECS_CLUSTER  = c.ecsCluster;
    return map;
  }

  if (provider === "azure") {
    const c = credentials as AzureCredentials;
    const azureCreds = JSON.stringify({
      clientId:       c.clientId,
      clientSecret:   c.clientSecret,
      subscriptionId: c.subscriptionId,
      tenantId:       c.tenantId,
    });
    const map: Record<string, string> = { AZURE_CREDENTIALS: azureCreds };
    if (c.resourceGroup)     map.AZURE_RESOURCE_GROUP   = c.resourceGroup;
    if (c.containerAppName)  map.AZURE_CONTAINER_APP    = c.containerAppName;
    return map;
  }

  // GCP
  const c = credentials as GCPCredentials;
  const map: Record<string, string> = {
    GCP_SA_KEY:     c.serviceAccountKey,
    GCP_PROJECT_ID: c.projectId,
  };
  if (c.region)      map.GCP_REGION       = c.region;
  if (c.serviceName) map.GCP_SERVICE_NAME = c.serviceName;
  return map;
}

// ── Main sync function ────────────────────────────────────────────────────────

/**
 * Reads tenant's cloud credentials from DB, decrypts them,
 * and pushes each as a GitHub Actions secret to the specified repository.
 *
 * Returns the number of secrets synced.
 */
export async function syncSecretsToGitHub(
  tenantId: string,
  owner: string,
  repoName: string,
  installationId: number,
  connectionId?: string,
): Promise<{ synced: number; provider: string }> {
  const client = await pool.connect();
  try {
    // Item 2 (corrigido): quando o deploy escolhe uma conexão específica, sincroniza
    // ELA (não o slot 0). Sem connectionId (push inicial legado), mantém slot 0.
    const res = connectionId
      ? await client.query(
          `SELECT id, provider, encrypted_credentials, encryption_iv, encryption_tag
           FROM tenant_cloud_connections
           WHERE id = $1 AND tenant_id = $2 AND status = 'active' LIMIT 1`,
          [connectionId, tenantId],
        )
      : await client.query(
          `SELECT id, provider, encrypted_credentials, encryption_iv, encryption_tag
           FROM tenant_cloud_connections
           WHERE tenant_id = $1 AND status = 'active'
           ORDER BY slot_index ASC LIMIT 1`,
          [tenantId],
        );
    const row = res.rows[0];
    if (!row) return { synced: 0, provider: "none" };

    const provider = row.provider as "aws" | "azure" | "gcp";

    // Decrypt
    const payload: EncryptedPayload = {
      encrypted: row.encrypted_credentials as string,
      iv:        row.encryption_iv as string,
      tag:       row.encryption_tag as string,
    };
    const credentialsJson = decryptCredentials(payload);
    const credentials = JSON.parse(credentialsJson) as CloudCredentials;

    const secretMap = getSecretMap(provider, credentials);

    // Push each secret to GitHub repo
    let synced = 0;
    for (const [name, value] of Object.entries(secretMap)) {
      if (!value) continue;
      await setRepoSecret(installationId, owner, repoName, name, value);
      synced++;
    }

    // Record sync timestamp
    await client.query(
      "UPDATE tenant_cloud_connections SET github_secrets_synced_at = now(), updated_at = now() WHERE id = $1",
      [row.id],
    );

    console.log(`[CloudConnector] Synced ${synced} ${provider} secrets to ${owner}/${repoName}`);
    return { synced, provider };
  } finally {
    client.release();
  }
}

/** Nomes COMPLETOS de secrets que este módulo pode ter sincronizado, por provider (inclui os
 *  opcionais). Usado no teardown para purgar as credenciais do repo (deleteRepoSecret é 404-safe). */
const SECRET_NAMES_BY_PROVIDER: Record<"aws" | "azure" | "gcp", string[]> = {
  aws:   ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_ECR_REGISTRY", "AWS_ECS_CLUSTER"],
  azure: ["AZURE_CREDENTIALS", "AZURE_RESOURCE_GROUP", "AZURE_CONTAINER_APP"],
  gcp:   ["GCP_SA_KEY", "GCP_PROJECT_ID", "GCP_REGION", "GCP_SERVICE_NAME"],
};

/**
 * Remove do repo os secrets de cloud sincronizados para um provider. Chamado no teardown de
 * demo (após o run de destruição concluir com sucesso — o run de teardown ainda precisa das
 * credenciais em runtime). Idempotente e best-effort.
 */
export async function removeSyncedSecrets(
  installationId: number,
  owner: string,
  repoName: string,
  provider: "aws" | "azure" | "gcp",
): Promise<number> {
  let removed = 0;
  for (const name of SECRET_NAMES_BY_PROVIDER[provider]) {
    try {
      await deleteRepoSecret(installationId, owner, repoName, name);
      removed++;
    } catch (err) {
      console.warn(`[CloudConnector] falha ao remover secret ${name} de ${owner}/${repoName}:`, err);
    }
  }
  console.log(`[CloudConnector] Removidos ${removed} secrets ${provider} de ${owner}/${repoName}`);
  return removed;
}

function mapConnRow(row: Record<string, unknown>): CloudConnection {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    provider: row.provider as "aws" | "azure" | "gcp",
    region: (row.region as string | null) ?? null,
    serviceType: row.service_type as string,
    slotIndex: Number(row.slot_index ?? 0),
    label: (row.label as string | null) ?? null,
    githubSecretsSyncedAt: (row.github_secrets_synced_at as Date | null)?.toISOString() ?? null,
    status: row.status as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

const CONN_COLS =
  "id, tenant_id, provider, region, service_type, slot_index, label, github_secrets_synced_at, status, created_at";

/**
 * Returns a cloud connection for a tenant (without credentials). Sem connectionId,
 * devolve o slot 0 (compat). Com connectionId, devolve ELA (scoped ao tenant).
 */
export async function getCloudConnection(
  tenantId: string,
  connectionId?: string,
): Promise<CloudConnection | null> {
  const client = await pool.connect();
  try {
    const res = connectionId
      ? await client.query(
          `SELECT ${CONN_COLS} FROM tenant_cloud_connections
           WHERE id = $1 AND tenant_id = $2 AND status = 'active' LIMIT 1`,
          [connectionId, tenantId],
        )
      : await client.query(
          `SELECT ${CONN_COLS} FROM tenant_cloud_connections
           WHERE tenant_id = $1 AND status = 'active'
           ORDER BY slot_index ASC LIMIT 1`,
          [tenantId],
        );
    const row = res.rows[0];
    return row ? mapConnRow(row) : null;
  } finally {
    client.release();
  }
}

/** Material de credencial AWS que o Deadpool precisa para monitorar a CONTA do tenant (fork B). */
export interface AwsMonitoringCredentials {
  /** Região da conta do tenant (coluna ou credencial); o poller passa a pollar NELA, não no default. */
  region: string | null;
  /** AssumeRole cross-account (preferido). NÃO é segredo. */
  roleArn: string | null;
  externalId: string | null;
  /**
   * Payload CIFRADO das chaves estáticas, encaminhado AS-IS ao Deadpool (que decripta em memória
   * com a chave compartilhada). ``null`` quando a conexão é só-role (nada estático a propagar) —
   * assim nunca movemos chave em claro nem obrigamos o Deadpool a decriptar um payload inútil.
   */
  credentialsEnc: { encrypted: string; iv: string; tag: string } | null;
}

/**
 * Fork B — resolve as credenciais AWS de monitoramento do tenant para propagar ao Deadpool no
 * activate. Lê a conexão AWS ativa (a específica por ``connectionId``, senão o menor slot), decripta
 * SÓ para extrair region/roleArn/externalId (não-segredos) e reencaminha o CIPHERTEXT das chaves
 * estáticas. Retorna ``null`` se o tenant não tem conexão AWS ativa (Deadpool cai na identidade do
 * container / instance role — comportamento fork A). NUNCA lança por erro de decrypt: nesse caso
 * devolve só a região conhecida (degradação limpa; o activate segue e o poller usa o default).
 */
export async function getAwsMonitoringCredentials(
  tenantId: string,
  connectionId?: string,
): Promise<AwsMonitoringCredentials | null> {
  const client = await pool.connect();
  try {
    const res = connectionId
      ? await client.query(
          `SELECT id, provider, region, encrypted_credentials, encryption_iv, encryption_tag
           FROM tenant_cloud_connections
           WHERE id = $1 AND tenant_id = $2 AND provider = 'aws' AND status = 'active' LIMIT 1`,
          [connectionId, tenantId],
        )
      : await client.query(
          `SELECT id, provider, region, encrypted_credentials, encryption_iv, encryption_tag
           FROM tenant_cloud_connections
           WHERE tenant_id = $1 AND provider = 'aws' AND status = 'active'
           ORDER BY slot_index ASC LIMIT 1`,
          [tenantId],
        );
    const row = res.rows[0];
    if (!row) return null;

    const rawPayload = {
      encrypted: row.encrypted_credentials as string,
      iv: row.encryption_iv as string,
      tag: row.encryption_tag as string,
    };
    const columnRegion = (row.region as string | null) ?? null;
    try {
      const creds = JSON.parse(decryptCredentials(rawPayload)) as AWSCredentials;
      const hasStatic = Boolean(creds.accessKeyId && creds.secretAccessKey);
      return {
        region: creds.region ?? columnRegion,
        roleArn: creds.roleArn ?? null,
        externalId: creds.externalId ?? null,
        // Só propaga o ciphertext quando há chaves estáticas de fato; conexão só-role → null.
        credentialsEnc: hasStatic ? rawPayload : null,
      };
    } catch (err) {
      console.warn(`[CloudConnector] falha ao decriptar conexão AWS ${row.id} p/ monitoramento (degradado):`, err);
      return { region: columnRegion, roleArn: null, externalId: null, credentialsEnc: null };
    }
  } finally {
    client.release();
  }
}

/** Credencial AWS DECIFRADA do tenant para o pipeline de deploy empurrar artefato na CONTA DELE.
 *  region/roleArn saem sempre que a conexão existe; accessKeyId/secretAccessKey só quando há
 *  chaves estáticas de fato (conexão só-role deixa as chaves vazias — a política decide o que
 *  fazer). Retorna null quando o tenant NÃO tem conexão AWS ativa. NUNCA lança por erro de
 *  decrypt: loga e devolve null (degradação → a política trata como "sem conta configurada"). */
export interface AwsDeployCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string | null;
  roleArn: string | null;
}

export async function getAwsDeployCredentials(
  tenantId: string,
  connectionId?: string,
): Promise<AwsDeployCredentials | null> {
  const client = await pool.connect();
  try {
    const res = connectionId
      ? await client.query(
          `SELECT id, region, encrypted_credentials, encryption_iv, encryption_tag
           FROM tenant_cloud_connections
           WHERE id = $1 AND tenant_id = $2 AND provider = 'aws' AND status = 'active' LIMIT 1`,
          [connectionId, tenantId],
        )
      : await client.query(
          `SELECT id, region, encrypted_credentials, encryption_iv, encryption_tag
           FROM tenant_cloud_connections
           WHERE tenant_id = $1 AND provider = 'aws' AND status = 'active'
           ORDER BY slot_index ASC LIMIT 1`,
          [tenantId],
        );
    const row = res.rows[0];
    if (!row) return null;

    const columnRegion = (row.region as string | null) ?? null;
    try {
      const creds = JSON.parse(
        decryptCredentials({
          encrypted: row.encrypted_credentials as string,
          iv: row.encryption_iv as string,
          tag: row.encryption_tag as string,
        }),
      ) as AWSCredentials;
      return {
        accessKeyId: (creds.accessKeyId ?? "").trim(),
        secretAccessKey: (creds.secretAccessKey ?? "").trim(),
        region: creds.region ?? columnRegion,
        roleArn: creds.roleArn ?? null,
      };
    } catch (err) {
      console.warn(`[CloudConnector] falha ao decifrar conexão AWS ${row.id} p/ deploy (tratado como sem-conta):`, err);
      return null;
    }
  } finally {
    client.release();
  }
}

/** Lista TODAS as conexões ativas do tenant (p/ o select de deploy). Sem credenciais. */
export async function listCloudConnections(tenantId: string): Promise<CloudConnection[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT ${CONN_COLS} FROM tenant_cloud_connections
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY slot_index ASC`,
      [tenantId],
    );
    return res.rows.map(mapConnRow);
  } finally {
    client.release();
  }
}
