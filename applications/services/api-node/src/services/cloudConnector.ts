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
import { setRepoSecret } from "./github.js";

// ── Credential shapes ─────────────────────────────────────────────────────────

export interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  ecrRegistry?: string;
  ecsCluster?: string;
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
): Promise<{ synced: number; provider: string }> {
  const client = await pool.connect();
  try {
    const res = await client.query(
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

/**
 * Returns the active cloud connection for a tenant (without credentials).
 */
export async function getCloudConnection(tenantId: string): Promise<CloudConnection | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT id, tenant_id, provider, region, service_type, github_secrets_synced_at, status, created_at
       FROM tenant_cloud_connections
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY slot_index ASC LIMIT 1`,
      [tenantId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      provider: row.provider as "aws" | "azure" | "gcp",
      region: row.region as string | null,
      serviceType: row.service_type as string,
      githubSecretsSyncedAt: (row.github_secrets_synced_at as Date | null)?.toISOString() ?? null,
      status: row.status as string,
      createdAt: (row.created_at as Date).toISOString(),
    };
  } finally {
    client.release();
  }
}
