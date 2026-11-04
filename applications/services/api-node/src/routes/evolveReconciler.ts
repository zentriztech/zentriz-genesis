/**
 * Consulta dos achados do reconciliador do /evolve (tarefa 1.8). Somente leitura, admin Zentriz.
 *   GET /api/admin/evolve-reconciler/findings?kind=&projectId=&ticketId=&open=true|false&limit=
 * `projectId`/`ticketId` são convertidos em hash no servidor (os achados não guardam o id em claro) e não são ecoados.
 * Não existe rota de escrita.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { hashId } from "../services/anomalyDetectors.js";
import { listFindings } from "../services/evolveReconciler.js";
import { resolveReconcilerMode } from "../services/featureFlags.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

export async function evolveReconcilerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);
  app.get<{ Querystring: { kind?: string; projectId?: string; ticketId?: string; open?: string; limit?: string } }>(
    "/api/admin/evolve-reconciler/findings",
    async (request, reply) => {
      const u = getUser(request);
      if (!(u?.role === "zentriz_admin" && !u?.svc)) return reply.status(403).send({ code: "FORBIDDEN" });
      // M-19: com o reconciliador `off` a rota nova não existe (a autorização acima segue valendo e vem primeiro).
      const mode = await resolveReconcilerMode(pool);
      if (mode === "off") return reply.status(404).send({ code: "NOT_FOUND", message: "Reconciliador desligado" });
      const q = request.query ?? {};
      const findings = await listFindings(pool, {
        kind: q.kind || undefined,
        projectHash: q.projectId ? hashId(q.projectId) : undefined,
        ticketHash: q.ticketId ? hashId(q.ticketId) : undefined,
        open: q.open === "true" ? true : q.open === "false" ? false : undefined,
        limit: Number(q.limit) || 100,
      });
      return reply.send({ mode, findings });
    },
  );
}
