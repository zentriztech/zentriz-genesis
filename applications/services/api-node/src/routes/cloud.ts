/**
 * cloud.ts — Cloud connections por tenant com suporte a múltiplos slots.
 *
 * GET  /api/tenant/cloud-connections              — listar todos os slots ativos
 * POST /api/tenant/cloud-connections              — adicionar novo slot (próximo slot_index livre)
 * PUT  /api/tenant/cloud-connections/:id          — editar slot existente
 * DELETE /api/tenant/cloud-connections/:id        — remover slot e compactar indices
 * POST /api/tenant/cloud-connections/reorder      — trocar posições de dois slots
 * POST /api/tenant/cloud-connections/:id/test     — testar credenciais do slot
 *
 * Compat: rotas antigas /api/tenant/cloud-connection mantidas como alias.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { encryptCredentials, decryptCredentials } from "../services/crypto.js";

function getUser(req: FastifyRequest): AuthUser {
  return (req as unknown as { user: AuthUser }).user;
}

type CloudProvider = "aws" | "azure" | "gcp";

const ALLOWED_KEYS: Record<CloudProvider, string[]> = {
  // G1-T6 (seam GATE 2): roleArn + externalId habilitam o AssumeRoleCredentialProvider
  // do GATE 2. No GATE 1 a provisão usa a conta ambiente (AmbientCredentialProvider),
  // então estes campos são opcionais e o path S3 legado (accessKeyId estático) segue igual.
  aws:   ["accessKeyId", "secretAccessKey", "region", "ecrRegistry", "ecsCluster", "roleArn", "externalId"],
  azure: ["clientId", "clientSecret", "subscriptionId", "tenantId", "resourceGroup", "containerAppName"],
  gcp:   ["serviceAccountKey", "projectId", "region", "serviceName"],
};

const REQUIRED_KEYS: Record<CloudProvider, string[]> = {
  aws:   ["accessKeyId", "secretAccessKey", "region"],
  azure: ["clientId", "clientSecret", "subscriptionId", "tenantId"],
  gcp:   ["serviceAccountKey", "projectId"],
};

function sanitize(provider: CloudProvider, raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ALLOWED_KEYS[provider]) {
    if (typeof raw[key] === "string" && raw[key].trim()) out[key] = raw[key].trim();
  }
  return out;
}

// Formata linha do banco → objeto público (sem credenciais)
function formatRow(row: Record<string, unknown>) {
  return {
    id:                   row.id,
    provider:             row.provider,
    label:                row.label ?? null,
    region:               row.region ?? null,
    serviceType:          row.service_type,
    slotIndex:            Number(row.slot_index ?? 0),
    status:               row.status,
    githubSecretsSyncedAt: (row.github_secrets_synced_at as Date | null)?.toISOString() ?? null,
    createdAt:            (row.created_at as Date).toISOString(),
    credentialsMasked:    row.credentials_masked ?? {},
  };
}

// Recompacta slot_index de 0..N após deleção ou reorder
async function recompactSlots(client: { query: (sql: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, tenantId: string) {
  const rows = await client.query(
    `SELECT id FROM tenant_cloud_connections
     WHERE tenant_id = $1 AND status = 'active'
     ORDER BY slot_index ASC, created_at ASC`,
    [tenantId]
  );
  for (let i = 0; i < rows.rows.length; i++) {
    await client.query(
      `UPDATE tenant_cloud_connections SET slot_index = $1 WHERE id = $2`,
      [i, rows.rows[i].id]
    );
  }
}

export async function cloudRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/tenant/cloud-connections ─────────────────────────────────────
  app.get("/api/tenant/cloud-connections", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.send([]);
    const res = await pool.query(
      `SELECT id, provider, label, region, service_type, slot_index,
              github_secrets_synced_at, status, created_at
       FROM tenant_cloud_connections
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY slot_index ASC`,
      [user.tenantId]
    );
    return reply.send(res.rows.map(formatRow));
  });

  // ── POST /api/tenant/cloud-connections — adicionar slot ───────────────────
  app.post<{ Body: { provider: CloudProvider; credentials: Record<string, string>; region?: string; label?: string } }>(
    "/api/tenant/cloud-connections",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
      }
      const tenantId = user.tenantId!;
      if (!tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });

      const { provider, credentials, region, label } = request.body ?? {};
      if (!["aws", "azure", "gcp"].includes(provider)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "provider deve ser aws, azure ou gcp" });
      }

      const sanitized = sanitize(provider, credentials ?? {});
      const missing   = REQUIRED_KEYS[provider].filter((k) => !sanitized[k]);
      if (missing.length) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: `Campos obrigatórios: ${missing.join(", ")}` });
      }

      // Verificar limite de 4 slots
      const countRes = await pool.query(
        "SELECT COUNT(*) FROM tenant_cloud_connections WHERE tenant_id = $1 AND status = 'active'",
        [tenantId]
      );
      if (Number(countRes.rows[0].count) >= 4) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Máximo de 4 cloud connections atingido" });
      }

      // Próximo slot_index livre
      const maxRes = await pool.query(
        "SELECT COALESCE(MAX(slot_index), -1) AS max FROM tenant_cloud_connections WHERE tenant_id = $1 AND status = 'active'",
        [tenantId]
      );
      const nextSlot = Number(maxRes.rows[0].max) + 1;

      const { encrypted, iv, tag } = encryptCredentials(JSON.stringify(sanitized));

      const ins = await pool.query(
        `INSERT INTO tenant_cloud_connections
           (tenant_id, provider, label, region, service_type, slot_index,
            encrypted_credentials, encryption_iv, encryption_tag, status)
         VALUES ($1,$2,$3,$4,'container',$5,$6,$7,$8,'active')
         RETURNING id, slot_index`,
        [tenantId, provider, label ?? null, region ?? sanitized.region ?? null,
         nextSlot, encrypted, iv, tag]
      );
      return reply.status(201).send({
        ok: true, id: ins.rows[0].id, slotIndex: ins.rows[0].slot_index,
        message: "Credenciais salvas com segurança"
      });
    }
  );

  // ── PUT /api/tenant/cloud-connections/:id — editar slot ───────────────────
  app.put<{
    Params: { id: string };
    Body: { provider?: CloudProvider; credentials?: Record<string, string>; region?: string; label?: string };
  }>("/api/tenant/cloud-connections/:id", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
    }
    const { id } = request.params;
    const { provider, credentials, region, label } = request.body ?? {};

    const existing = await pool.query(
      "SELECT * FROM tenant_cloud_connections WHERE id = $1 AND tenant_id = $2",
      [id, user.tenantId]
    );
    if (!existing.rows.length) return reply.status(404).send({ code: "NOT_FOUND" });

    const row      = existing.rows[0] as Record<string, unknown>;
    const prov     = (provider ?? row.provider) as CloudProvider;
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [];
    let p = 1;

    if (label !== undefined) { sets.push(`label = $${p++}`); params.push(label); }
    if (region !== undefined) { sets.push(`region = $${p++}`); params.push(region); }
    if (provider)             { sets.push(`provider = $${p++}`); params.push(provider); }

    // Re-encrypt only when credentials are provided
    if (credentials && Object.keys(credentials).length > 0) {
      // Merge with existing (decrypt → merge → re-encrypt)
      let existing_creds: Record<string, string> = {};
      try {
        existing_creds = JSON.parse(decryptCredentials({
          encrypted: row.encrypted_credentials as string,
          iv:        row.encryption_iv as string,
          tag:       row.encryption_tag as string,
        })) as Record<string, string>;
      } catch { /* use empty */ }
      const merged   = { ...existing_creds, ...sanitize(prov, credentials) };
      const { encrypted, iv, tag } = encryptCredentials(JSON.stringify(merged));
      sets.push(`encrypted_credentials = $${p++}`); params.push(encrypted);
      sets.push(`encryption_iv = $${p++}`);         params.push(iv);
      sets.push(`encryption_tag = $${p++}`);        params.push(tag);
    }

    params.push(id);
    await pool.query(
      `UPDATE tenant_cloud_connections SET ${sets.join(", ")} WHERE id = $${p}`,
      params
    );
    return reply.send({ ok: true });
  });

  // ── DELETE /api/tenant/cloud-connections/:id ──────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/api/tenant/cloud-connections/:id",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
      }
      const { id } = request.params;
      const client = await pool.connect();
      try {
        await client.query(
          "UPDATE tenant_cloud_connections SET status='revoked', updated_at=now() WHERE id=$1 AND tenant_id=$2",
          [id, user.tenantId]
        );
        await recompactSlots(
          client as Parameters<typeof recompactSlots>[0],
          user.tenantId!
        );
        return reply.send({ ok: true });
      } finally { client.release(); }
    }
  );

  // ── POST /api/tenant/cloud-connections/reorder ────────────────────────────
  app.post<{ Body: { idA: string; idB: string } }>(
    "/api/tenant/cloud-connections/reorder",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
      }
      const { idA, idB } = request.body ?? {};
      const client = await pool.connect();
      try {
        const rows = await client.query(
          "SELECT id, slot_index FROM tenant_cloud_connections WHERE id = ANY($1) AND tenant_id = $2",
          [[idA, idB], user.tenantId]
        );
        if (rows.rows.length !== 2) return reply.status(400).send({ code: "BAD_REQUEST", message: "IDs inválidos" });
        const [r1, r2] = rows.rows as { id: string; slot_index: number }[];
        // Swap usando valor temporário fora do range (99) para evitar conflito de UNIQUE
        await client.query("UPDATE tenant_cloud_connections SET slot_index = 99 WHERE id = $1", [r1.id]);
        await client.query("UPDATE tenant_cloud_connections SET slot_index = $1 WHERE id = $2", [r1.slot_index, r2.id]);
        await client.query("UPDATE tenant_cloud_connections SET slot_index = $1 WHERE id = $2", [r2.slot_index, r1.id]);
        return reply.send({ ok: true });
      } finally { client.release(); }
    }
  );

  // ── POST /api/tenant/cloud-connections/:id/test ───────────────────────────
  app.post<{ Params: { id: string } }>(
    "/api/tenant/cloud-connections/:id/test",
    async (request, reply) => {
      const user = getUser(request);
      if (!user.tenantId) return reply.status(400).send({ ok: false, message: "Sem tenant" });
      const { id } = request.params;
      const res = await pool.query(
        "SELECT provider, encrypted_credentials, encryption_iv, encryption_tag FROM tenant_cloud_connections WHERE id=$1 AND tenant_id=$2 AND status='active'",
        [id, user.tenantId]
      );
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return reply.send({ ok: false, message: "Slot não encontrado" });
      try {
        const creds   = JSON.parse(decryptCredentials({
          encrypted: row.encrypted_credentials as string,
          iv:        row.encryption_iv as string,
          tag:       row.encryption_tag as string,
        })) as Record<string, string>;
        const prov    = row.provider as CloudProvider;
        const checks  = { aws: "accessKeyId", azure: "clientId", gcp: "serviceAccountKey" };
        const ok      = Boolean(creds[checks[prov]]);
        return reply.send({ ok, provider: prov, message: ok ? "Credenciais válidas" : "Credenciais incompletas" });
      } catch {
        return reply.send({ ok: false, message: "Erro ao descriptografar credenciais" });
      }
    }
  );

  // ── Aliases de compatibilidade (rotas antigas) ────────────────────────────

  app.get("/api/tenant/cloud-connection", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.send({ connection: null });
    const res = await pool.query(
      `SELECT id, tenant_id, provider, region, service_type, slot_index,
              github_secrets_synced_at, status, created_at
       FROM tenant_cloud_connections
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY slot_index ASC LIMIT 1`,
      [user.tenantId]
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return reply.send({ connection: null });
    return reply.send({
      connection: {
        id: row.id, tenantId: row.tenant_id, provider: row.provider,
        region: row.region ?? null, serviceType: row.service_type,
        githubSecretsSyncedAt: (row.github_secrets_synced_at as Date | null)?.toISOString() ?? null,
        status: row.status, createdAt: (row.created_at as Date).toISOString(),
      }
    });
  });

  app.post<{ Body: { provider: CloudProvider; credentials: Record<string, string>; region?: string } }>(
    "/api/tenant/cloud-connection",
    async (request, reply) => {
      // Redirecionar para novo endpoint usando body original
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
      }
      const tenantId = user.tenantId!;
      const { provider, credentials, region } = request.body ?? {};
      if (!["aws", "azure", "gcp"].includes(provider)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "provider inválido" });
      }
      const sanitized = sanitize(provider, credentials ?? {});
      const missing   = REQUIRED_KEYS[provider].filter((k) => !sanitized[k]);
      if (missing.length) return reply.status(400).send({ code: "BAD_REQUEST", message: `Campos obrigatórios: ${missing.join(", ")}` });
      const { encrypted, iv, tag } = encryptCredentials(JSON.stringify(sanitized));
      // Upsert no slot 0 (comportamento compat)
      await pool.query(
        `INSERT INTO tenant_cloud_connections
           (tenant_id, provider, region, service_type, slot_index,
            encrypted_credentials, encryption_iv, encryption_tag, status)
         VALUES ($1,$2,$3,'container',0,$4,$5,$6,'active')
         ON CONFLICT (tenant_id, slot_index) DO UPDATE
           SET provider=$2, region=$3, encrypted_credentials=$4,
               encryption_iv=$5, encryption_tag=$6, status='active', updated_at=now()`,
        [tenantId, provider, region ?? sanitized.region ?? null, encrypted, iv, tag]
      );
      return reply.status(201).send({ ok: true, provider, message: "Credenciais salvas" });
    }
  );

  app.delete<{ Params: { provider: string } }>(
    "/api/tenant/cloud-connection/:provider",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
      }
      await pool.query(
        "UPDATE tenant_cloud_connections SET status='revoked', updated_at=now() WHERE tenant_id=$1 AND provider=$2",
        [user.tenantId, request.params.provider]
      );
      return reply.send({ ok: true });
    }
  );

  app.post("/api/tenant/cloud-connection/test", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.status(400).send({ ok: false, message: "Sem tenant" });
    const res = await pool.query(
      "SELECT id, provider, encrypted_credentials, encryption_iv, encryption_tag FROM tenant_cloud_connections WHERE tenant_id=$1 AND status='active' ORDER BY slot_index ASC LIMIT 1",
      [user.tenantId]
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return reply.send({ ok: false, message: "Nenhuma conexão configurada" });
    try {
      const creds  = JSON.parse(decryptCredentials({ encrypted: row.encrypted_credentials as string, iv: row.encryption_iv as string, tag: row.encryption_tag as string })) as Record<string, string>;
      const prov   = row.provider as CloudProvider;
      const checks = { aws: "accessKeyId", azure: "clientId", gcp: "serviceAccountKey" };
      const ok     = Boolean(creds[checks[prov]]);
      return reply.send({ ok, provider: prov, message: ok ? "Credenciais válidas" : "Credenciais incompletas" });
    } catch { return reply.send({ ok: false, message: "Erro ao descriptografar" }); }
  });
}
