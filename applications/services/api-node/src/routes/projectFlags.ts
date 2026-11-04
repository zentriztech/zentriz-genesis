/**
 * projectFlags.ts — flags EFETIVAS de um projeto, para o runner (M-03).
 *
 *   GET /api/projects/:id/effective-flags  →  { attachmentsStrict, taskInheritTransitive, sources }
 *
 * Por que existe: `ATTACHMENTS_STRICT` e `TASK_INHERIT_TRANSITIVE` eram lidas do ambiente de DOIS containers (api e runner)
 * sem coordenação. Agora a api resolve o valor do TENANT do projeto (tenant explícito > global > env > off, ver
 * services/featureFlags.ts) e o runner apenas CONSOME este valor — o runner não lê mais essas variáveis de ambiente.
 * Menor ponto: o runner já fala com `/api/projects/:id/*` com o token escopado ao projeto (MUST-MATCH em auth.ts).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { effectiveProjectFlags } from "../services/featureFlags.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

export async function projectFlagsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);
  app.get<{ Params: { id: string } }>("/api/projects/:id/effective-flags", async (request, reply) => {
    const user = getUser(request);
    const row = (await pool.query("SELECT id, tenant_id, created_by FROM projects WHERE id = $1", [request.params.id]).catch(() => ({ rows: [] })))
      .rows[0] as { id: string; tenant_id: string | null; created_by: string | null } | undefined;
    if (!row || !canAccessProjectRow(user, row)) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
    }
    return reply.send(await effectiveProjectFlags(pool, row.tenant_id ? String(row.tenant_id) : null));
  });
}
