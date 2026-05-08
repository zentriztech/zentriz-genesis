/**
 * runtimeConfig.ts — Configuração dinâmica do runtime Genesis
 *
 * GET  /api/admin/runtime-config          — listar todas as chaves (global + tenant override)
 * PUT  /api/admin/runtime-config/:key     — criar ou atualizar valor de uma chave
 * DELETE /api/admin/runtime-config/:key   — remover override de tenant (restaura global)
 * GET  /api/admin/runtime-config/resolved — valores resolvidos (merge global + tenant)
 *
 * Acesso: zentriz_admin vê e edita tudo (global + qualquer tenant).
 *         tenant_admin vê os defaults globais + seus overrides; só edita seus overrides.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(r: FastifyRequest): AuthUser {
  return (r as unknown as { user: AuthUser }).user;
}

// Chaves permitidas e seus metadados de exibição
const CONFIG_KEYS: Record<string, { label: string; group: string; unit: string; min: number; max: number }> = {
  AGENT_TIMEOUT_ENGINEER: { label: "Timeout Engineer",  group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_CTO:      { label: "Timeout CTO",       group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_PM:       { label: "Timeout PM",        group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_DEV:      { label: "Timeout Dev",       group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_QA:       { label: "Timeout QA",        group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_MONITOR:  { label: "Timeout Monitor",   group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_DEVOPS:   { label: "Timeout DevOps",    group: "timeouts", unit: "s", min: 60,  max: 3600 },
  REQUEST_TIMEOUT:        { label: "Timeout HTTP base", group: "timeouts", unit: "s", min: 60,  max: 3600 },
  MAX_QA_REWORK:          { label: "Máx. ciclos QA",    group: "limits",   unit: "",  min: 1,   max: 10   },
  CLAUDE_MAX_TOKENS:      { label: "Max tokens (padrão)",   group: "tokens", unit: "tk", min: 1000, max: 64000 },
  CLAUDE_MAX_TOKENS_DEV:  { label: "Max tokens Dev",        group: "tokens", unit: "tk", min: 1000, max: 64000 },
  CLAUDE_MAX_TOKENS_PM:   { label: "Max tokens PM",         group: "tokens", unit: "tk", min: 1000, max: 64000 },
  CLAUDE_MAX_TOKENS_ENGINEER: { label: "Max tokens Engineer", group: "tokens", unit: "tk", min: 1000, max: 64000 },
};

export async function runtimeConfigRoutes(app: FastifyInstance): Promise<void> {
  // Todas as rotas exigem autenticação JWT (Bearer) — inclusive o runner usa Bearer
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/admin/runtime-config/resolved ─────────────────────────────────
  // Valores efetivos: global sobrescrito pelo override do tenant.
  // Acessível por zentriz_admin, tenant_admin e zentriz_admin com token de runner.
  app.get("/api/admin/runtime-config/resolved", async (request, reply) => {
    const user     = getUser(request);
    const tenantId = user.role === "zentriz_admin" ? null : user.tenantId ?? null;

    const result = await pool.query(
      `SELECT key, value, tenant_id
       FROM genesis_runtime_config
       WHERE tenant_id IS NULL OR tenant_id = $1
       ORDER BY tenant_id NULLS FIRST`,
      [tenantId]
    );

    const resolved: Record<string, string> = {};
    for (const row of result.rows) {
      resolved[row.key] = row.value;
    }
    return reply.send(resolved);
  });

  // ── GET /api/admin/runtime-config ─────────────────────────────────────────
  // Lista todas as chaves com metadados, valor global e override do tenant
  app.get("/api/admin/runtime-config", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin" && user.role !== "tenant_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
    }

    const tenantId = user.role === "zentriz_admin" ? null : user.tenantId;

    const result = await pool.query(
      `SELECT key, value, description, tenant_id, updated_at, updated_by
       FROM genesis_runtime_config
       WHERE tenant_id IS NULL OR tenant_id = $1
       ORDER BY key`,
      [tenantId]
    );

    // Organizar por chave: { global, tenantOverride }
    const byKey: Record<string, { global?: string; override?: string; updatedAt?: string; updatedBy?: string; description?: string }> = {};
    for (const row of result.rows) {
      if (!byKey[row.key]) byKey[row.key] = {};
      if (row.tenant_id === null) {
        byKey[row.key].global      = row.value;
        byKey[row.key].description = row.description;
      } else {
        byKey[row.key].override  = row.value;
        byKey[row.key].updatedAt = row.updated_at;
        byKey[row.key].updatedBy = row.updated_by;
      }
    }

    // Montar lista enriquecida com metadados
    const configs = Object.entries(CONFIG_KEYS).map(([key, meta]) => {
      const data = byKey[key] ?? {};
      return {
        key,
        label:       meta.label,
        group:       meta.group,
        unit:        meta.unit,
        min:         meta.min,
        max:         meta.max,
        globalValue: data.global ?? null,
        tenantValue: data.override ?? null,
        effectiveValue: data.override ?? data.global ?? null,
        description: data.description ?? null,
        hasOverride: !!data.override,
        updatedAt:   data.updatedAt ?? null,
      };
    });

    return reply.send(configs);
  });

  // ── PUT /api/admin/runtime-config/:key ─────────────────────────────────────
  // Cria ou atualiza valor. zentriz_admin pode definir global (sem tenant_id)
  // ou para um tenant específico. tenant_admin só pode definir seu próprio override.
  app.put<{ Params: { key: string }; Body: { value: string | number; tenantId?: string } }>(
    "/api/admin/runtime-config/:key",
    async (request, reply) => {
      const user     = getUser(request);
      const { key }  = request.params;
      const { value, tenantId: bodyTenantId } = request.body ?? {};

      if (user.role !== "zentriz_admin" && user.role !== "tenant_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }

      if (!CONFIG_KEYS[key]) {
        return reply.status(400).send({ code: "INVALID_KEY", message: `Chave '${key}' não é configurável` });
      }

      const meta = CONFIG_KEYS[key];
      const numVal = Number(value);
      if (isNaN(numVal) || numVal < meta.min || numVal > meta.max) {
        return reply.status(400).send({
          code: "OUT_OF_RANGE",
          message: `Valor deve ser entre ${meta.min} e ${meta.max} ${meta.unit}`,
        });
      }

      // Determinar target_tenant_id
      let targetTenantId: string | null = null;
      if (user.role === "zentriz_admin") {
        // zentriz_admin sem tenantId no body = global
        targetTenantId = bodyTenantId ?? null;
      } else {
        // tenant_admin só pode editar seu próprio override
        targetTenantId = user.tenantId ?? null;
      }

      await pool.query(
        `INSERT INTO genesis_runtime_config (key, value, tenant_id, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (key, tenant_id) DO UPDATE
           SET value = $2, updated_by = $4, updated_at = NOW()`,
        [key, String(numVal), targetTenantId, user.id]
      );

      return reply.send({
        ok:       true,
        key,
        value:    String(numVal),
        tenantId: targetTenantId,
        global:   targetTenantId === null,
      });
    }
  );

  // ── DELETE /api/admin/runtime-config/:key ──────────────────────────────────
  // Remove override do tenant (restaura valor global).
  // zentriz_admin pode remover global se fornecer tenantId=null explicitamente.
  app.delete<{ Params: { key: string }; Querystring: { tenantId?: string } }>(
    "/api/admin/runtime-config/:key",
    async (request, reply) => {
      const user    = getUser(request);
      const { key } = request.params;

      if (user.role !== "zentriz_admin" && user.role !== "tenant_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }

      // tenant_admin só pode remover seu próprio override
      const targetTenantId = user.role === "zentriz_admin"
        ? (request.query.tenantId ?? user.tenantId ?? null)
        : user.tenantId ?? null;

      // Nunca deixar deletar os defaults globais via tenant_admin
      if (user.role === "tenant_admin" && targetTenantId === null) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "tenant_admin não pode remover configuração global" });
      }

      const result = await pool.query(
        `DELETE FROM genesis_runtime_config WHERE key = $1 AND tenant_id IS NOT DISTINCT FROM $2`,
        [key, targetTenantId]
      );

      if (result.rowCount === 0) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Configuração não encontrada" });
      }

      return reply.send({ ok: true, key, restored: "global" });
    }
  );
}
