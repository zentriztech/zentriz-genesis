/**
 * Consulta dos alertas de anomalia de custo/uso de LLM (tarefa 1.6). Somente leitura, admin Zentriz.
 *   GET /api/admin/llm-anomaly/alerts?scopeHash=&projectId=&tenantId=&detector=&since=&limit=
 * `projectId`/`tenantId` são convertidos em hash no servidor (os alertas não guardam o id em claro) e não são ecoados.
 * Não existe rota de escrita: nenhum alerta altera o LLM Guard.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { anomalyMode } from "../lib/anomalyAlerts.js";
import { hashId } from "../services/anomalyDetectors.js";
import { listAnomalyAlerts } from "../services/llmAnomaly.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

export async function llmAnomalyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);
  app.get<{ Querystring: { scopeHash?: string; projectId?: string; tenantId?: string; detector?: string; since?: string; limit?: string } }>(
    "/api/admin/llm-anomaly/alerts",
    async (request, reply) => {
      const u = getUser(request);
      if (!(u?.role === "zentriz_admin" && !u?.svc)) return reply.status(403).send({ code: "FORBIDDEN" });
      const q = request.query ?? {};
      const since = q.since && !Number.isNaN(Date.parse(q.since)) ? q.since : undefined;
      const scopeHash = q.scopeHash || (q.projectId ? hashId(q.projectId) : q.tenantId ? hashId(q.tenantId) : undefined);
      const alerts = await listAnomalyAlerts(pool, { scopeHash, detector: q.detector, since, limit: Number(q.limit) || 100 });
      return reply.send({ mode: anomalyMode(), alerts });
    },
  );
}
