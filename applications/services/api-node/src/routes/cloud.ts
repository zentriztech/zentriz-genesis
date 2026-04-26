import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { encryptCredentials, decryptCredentials } from "../services/crypto.js";
import { getCloudConnection } from "../services/cloudConnector.js";

function getUser(req: FastifyRequest): AuthUser {
  return (req as unknown as { user: AuthUser }).user;
}

type CloudProvider = "aws" | "azure" | "gcp";

// Allowed credential keys per provider (whitelist for safety)
const ALLOWED_KEYS: Record<CloudProvider, string[]> = {
  aws:   ["accessKeyId", "secretAccessKey", "region", "ecrRegistry", "ecsCluster"],
  azure: ["clientId", "clientSecret", "subscriptionId", "tenantId", "resourceGroup", "containerAppName"],
  gcp:   ["serviceAccountKey", "projectId", "region", "serviceName"],
};

function sanitizeCredentials(provider: CloudProvider, raw: Record<string, string>): Record<string, string> {
  const allowed = ALLOWED_KEYS[provider];
  const sanitized: Record<string, string> = {};
  for (const key of allowed) {
    if (typeof raw[key] === "string" && raw[key].trim()) {
      sanitized[key] = raw[key].trim();
    }
  }
  return sanitized;
}

export async function cloudRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // POST /api/tenant/cloud-connection — save or update cloud credentials
  app.post<{
    Body: { provider: CloudProvider; credentials: Record<string, string>; region?: string; serviceType?: string };
  }>("/api/tenant/cloud-connection", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas admins de tenant podem conectar cloud" });
    }
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
    }
    const tenantId = user.tenantId!;
    const { provider, credentials, region, serviceType = "container" } = request.body ?? {};

    if (!["aws", "azure", "gcp"].includes(provider)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "provider deve ser aws, azure ou gcp" });
    }
    if (!credentials || typeof credentials !== "object") {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "credentials obrigatório" });
    }

    const sanitized = sanitizeCredentials(provider, credentials);
    if (Object.keys(sanitized).length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nenhuma credencial válida fornecida" });
    }

    // Validate required fields
    const required: Record<CloudProvider, string[]> = {
      aws:   ["accessKeyId", "secretAccessKey", "region"],
      azure: ["clientId", "clientSecret", "subscriptionId", "tenantId"],
      gcp:   ["serviceAccountKey", "projectId"],
    };
    const missing = required[provider].filter((k) => !sanitized[k]);
    if (missing.length > 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: `Campos obrigatórios ausentes: ${missing.join(", ")}` });
    }

    // Encrypt credentials
    const { encrypted, iv, tag } = encryptCredentials(JSON.stringify(sanitized));

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO tenant_cloud_connections
           (tenant_id, provider, region, service_type, encrypted_credentials, encryption_iv, encryption_tag, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now())
         ON CONFLICT (tenant_id, provider) DO UPDATE
           SET encrypted_credentials=$5, encryption_iv=$6, encryption_tag=$7,
               region=$3, service_type=$4, status='active', updated_at=now()`,
        [tenantId, provider, region ?? sanitized.region ?? null, serviceType, encrypted, iv, tag],
      );
      return reply.status(201).send({ ok: true, provider, message: "Credenciais salvas com segurança" });
    } finally {
      client.release();
    }
  });

  // GET /api/tenant/cloud-connection — returns connection status (no credentials)
  app.get("/api/tenant/cloud-connection", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.send({ connection: null });
    const connection = await getCloudConnection(user.tenantId);
    return reply.send({ connection });
  });

  // DELETE /api/tenant/cloud-connection/:provider — revoke
  app.delete<{ Params: { provider: string } }>("/api/tenant/cloud-connection/:provider", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
    }
    const { provider } = request.params;
    const client = await pool.connect();
    try {
      await client.query(
        "UPDATE tenant_cloud_connections SET status='revoked', updated_at=now() WHERE tenant_id=$1 AND provider=$2",
        [user.tenantId, provider],
      );
      return reply.send({ ok: true });
    } finally {
      client.release();
    }
  });

  // POST /api/tenant/cloud-connection/test — verify credentials are readable
  app.post("/api/tenant/cloud-connection/test", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.status(400).send({ ok: false, message: "Sem tenant" });
    const client = await pool.connect();
    try {
      const res = await client.query(
        "SELECT provider, encrypted_credentials, encryption_iv, encryption_tag FROM tenant_cloud_connections WHERE tenant_id=$1 AND status='active' LIMIT 1",
        [user.tenantId],
      );
      const row = res.rows[0];
      if (!row) return reply.send({ ok: false, message: "Nenhuma conexão cloud configurada" });
      // Try to decrypt — if it works, credentials are valid
      try {
        const decrypted = decryptCredentials({
          encrypted: row.encrypted_credentials as string,
          iv: row.encryption_iv as string,
          tag: row.encryption_tag as string,
        });
        const creds = JSON.parse(decrypted) as Record<string, string>;
        const provider = row.provider as CloudProvider;
        const required = { aws: "accessKeyId", azure: "clientId", gcp: "serviceAccountKey" };
        const hasRequired = Boolean(creds[required[provider]]);
        return reply.send({ ok: hasRequired, provider, message: hasRequired ? "Credenciais válidas" : "Credenciais incompletas" });
      } catch {
        return reply.send({ ok: false, message: "Erro ao descriptografar credenciais" });
      }
    } finally {
      client.release();
    }
  });
}
