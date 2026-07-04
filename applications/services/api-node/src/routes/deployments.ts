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

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

const ACTIVE_STATUSES = ["provisioning", "running", "running_degraded"];

function mapRow(row: Record<string, unknown>) {
  return {
    id:           row.id,
    projectId:    row.project_id,
    projectTitle: row.project_title ?? null,
    tenantId:     row.tenant_id,
    status:       row.status,
    appUrl:       row.app_url ?? null,
    bucketName:   row.bucket_name ?? null,
    provider:     row.provider,
    createdAt:    (row.created_at as Date)?.toISOString?.() ?? row.created_at,
    expiresAt:    (row.expires_at as Date)?.toISOString?.() ?? row.expires_at,
    errorMsg:     row.error_msg ?? null,
  };
}

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/deployments ────────────────────────────────────────────────
  // zentriz_admin → todos; demais → apenas do próprio tenant.
  // ?includeInactive=1 inclui failed/destroyed (default: só ativos).
  app.get<{ Querystring: { includeInactive?: string } }>(
    "/api/deployments",
    async (request, reply) => {
      const user = getUser(request);
      const includeInactive = request.query.includeInactive === "1";

      const where: string[] = ["e.provider = 's3-static'"];
      const params: unknown[] = [];

      if (user.role !== "zentriz_admin") {
        if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Sem tenant" });
        params.push(user.tenantId);
        where.push(`e.tenant_id = $${params.length}`);
      }
      if (!includeInactive) {
        where.push(`e.status IN ('provisioning','running','running_degraded')`);
      }

      const result = await pool.query(
        `SELECT e.id, e.project_id, e.tenant_id, e.status, e.app_url, e.bucket_name,
                e.provider, e.created_at, e.expires_at, e.error_msg,
                p.title AS project_title
           FROM ephemeral_deployments e
           LEFT JOIN projects p ON p.id = e.project_id
          WHERE ${where.join(" AND ")}
          ORDER BY e.created_at DESC
          LIMIT 200`,
        params,
      );
      return reply.send({ deployments: result.rows.map(mapRow) });
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
