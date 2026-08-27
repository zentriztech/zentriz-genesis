/**
 * deployments.ts — Gestão de deploys efêmeros (S3 static) por tenant.
 *
 * GET    /api/deployments                 — lista deploys do tenant (zentriz_admin vê todos)
 * DELETE /api/deployments/:deploymentId    — destrói um deploy (type-to-confirm no portal)
 *
 * A destruição reusa destroyDeployment (ephemeralDeploy.ts), que agora funciona
 * in-container via AWS SDK (remove bucket S3 + marca status='destroyed').
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { destroyDeployment } from "../services/ephemeralDeploy.js";
import { resolveScopedTenantId } from "../lib/tenantScope.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

// Status "ativos" por tipo de deploy (default da listagem; ?includeInactive=1 traz os demais).
const EPHEMERAL_ACTIVE = ["provisioning", "running", "running_degraded"];
// Espelha o índice único uq_backend_active_per_project (migração 033).
const BACKEND_ACTIVE = [
  "provisioning", "building", "pushing", "migrating",
  "creating_service", "waiting_cert_dns", "running", "running_degraded",
];

function toIso(v: unknown): string | null {
  return (v as Date)?.toISOString?.() ?? (v as string | null) ?? null;
}

// Preview estático efêmero publicado pelo Genesis no S3 (com TTL / botão de excluir).
function mapEphemeralRow(row: Record<string, unknown>) {
  return {
    kind:            "ephemeral" as const,
    id:              row.id,
    projectId:       row.project_id,
    projectTitle:    row.project_title ?? null,
    tenantId:        row.tenant_id,
    status:          row.status,
    appUrl:          row.app_url ?? null,
    healthUrl:       null,
    bucketName:      row.bucket_name ?? null,
    provider:        row.provider,
    runtimeTarget:   null,
    deploymentClass: null,
    logGroup:        null,
    createdAt:       toIso(row.created_at),
    expiresAt:       toIso(row.expires_at),
    errorMsg:        row.error_msg ?? null,
  };
}

// Deploy durável / runtime (backend_deployments) — serviço real provisionado ou onboarded
// (aws/azure/gcp). NÃO é apagável por esta tela (é a localização viva que o Auto Care monitora).
function mapBackendRow(row: Record<string, unknown>) {
  return {
    kind:            "backend" as const,
    id:              row.id,
    projectId:       row.project_id,
    projectTitle:    row.project_title ?? null,
    tenantId:        row.tenant_id,
    status:          row.status,
    appUrl:          row.app_url ?? null,
    healthUrl:       row.health_url ?? null,
    bucketName:      null,
    provider:        row.provider,
    runtimeTarget:   row.runtime_target ?? null,
    deploymentClass: row.class ?? null,
    logGroup:        row.log_group ?? null,
    createdAt:       toIso(row.created_at),
    expiresAt:       toIso(row.expires_at),
    errorMsg:        row.error_msg ?? null,
  };
}

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/deployments ────────────────────────────────────────────────
  // zentriz_admin → todos; demais → apenas do próprio tenant.
  // ?includeInactive=1 inclui failed/destroyed (default: só ativos).
  app.get<{ Querystring: { includeInactive?: string; tenantId?: string } }>(
    "/api/deployments",
    async (request, reply) => {
      const user = getUser(request);
      const includeInactive = request.query.includeInactive === "1";

      // Master: sem ?tenantId= vê todos; com ?tenantId= (seletor do portal) filtra ao tenant.
      // Demais papéis: sempre restritos ao próprio tenant (helper ignora qualquer ?tenantId=).
      const scopedTenantId = resolveScopedTenantId(user, request.query);
      if (user.role !== "zentriz_admin" && !scopedTenantId) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem tenant" });
      }

      // ── (1) Deploys efêmeros S3 estáticos (ephemeral_deployments) ────────────
      const ephWhere: string[] = ["e.provider = 's3-static'"];
      const ephParams: unknown[] = [];
      if (scopedTenantId) {
        ephParams.push(scopedTenantId);
        ephWhere.push(`e.tenant_id = $${ephParams.length}`);
      }
      if (!includeInactive) {
        ephParams.push(EPHEMERAL_ACTIVE);
        ephWhere.push(`e.status = ANY($${ephParams.length})`);
      }
      const ephResult = await pool.query(
        `SELECT e.id, e.project_id, e.tenant_id, e.status, e.app_url, e.bucket_name,
                e.provider, e.created_at, e.expires_at, e.error_msg,
                p.title AS project_title
           FROM ephemeral_deployments e
           LEFT JOIN projects p ON p.id = e.project_id
          WHERE ${ephWhere.join(" AND ")}
          ORDER BY e.created_at DESC
          LIMIT 200`,
        ephParams,
      );

      // ── (2) Deploys duráveis / runtime (backend_deployments) ─────────────────
      // Escopo por tenant via projects (fonte autoritativa; bd.tenant_id é denormalizado e pode ser NULL).
      const bdWhere: string[] = [];
      const bdParams: unknown[] = [];
      if (scopedTenantId) {
        bdParams.push(scopedTenantId);
        bdWhere.push(`p.tenant_id = $${bdParams.length}`);
      }
      if (!includeInactive) {
        bdParams.push(BACKEND_ACTIVE);
        bdWhere.push(`bd.status = ANY($${bdParams.length})`);
      }
      const bdResult = await pool.query(
        `SELECT bd.id, bd.project_id, COALESCE(bd.tenant_id, p.tenant_id) AS tenant_id,
                bd.status, bd.app_url, bd.health_url, bd.provider, bd.runtime_target,
                bd.class, bd.log_group, bd.error_msg, bd.created_at, bd.expires_at,
                p.title AS project_title
           FROM backend_deployments bd
           LEFT JOIN projects p ON p.id = bd.project_id
          ${bdWhere.length ? "WHERE " + bdWhere.join(" AND ") : ""}
          ORDER BY bd.created_at DESC
          LIMIT 200`,
        bdParams,
      );

      const deployments = [
        ...ephResult.rows.map(mapEphemeralRow),
        ...bdResult.rows.map(mapBackendRow),
      ].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

      return reply.send({ deployments });
    },
  );

  // ── DELETE /api/deployments/:deploymentId ─────────────────────────────────
  // Type-to-confirm é feito no portal; aqui validamos escopo por tenant.
  app.delete<{ Params: { deploymentId: string } }>(
    "/api/deployments/:deploymentId",
    async (request, reply) => {
      const user = getUser(request);
      const { deploymentId } = request.params;

      const dep = (await pool.query<{ tenant_id: string | null }>(
        "SELECT tenant_id FROM ephemeral_deployments WHERE id = $1",
        [deploymentId],
      )).rows[0];
      if (!dep) return reply.status(404).send({ code: "NOT_FOUND", message: "Deploy não encontrado" });

      if (user.role !== "zentriz_admin" && dep.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão sobre este deploy" });
      }

      await destroyDeployment(deploymentId);
      return reply.send({ ok: true });
    },
  );
}
