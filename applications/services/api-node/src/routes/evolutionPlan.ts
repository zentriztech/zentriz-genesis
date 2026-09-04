/**
 * evolutionPlan.ts — Evoluir E2: rotas da Bancada para GERAR os artefatos de evolução do filho.
 *  POST /api/projects/:id/evolution-plan            {request?} → {jobId}   (job assíncrono; /invoke/raw)
 *  GET  /api/projects/:id/evolution-plan/:jobId      → {status, result?, error?}
 * Guardas: acesso ao projeto (tenant), spec editável (mesma regra do /spec-file), `extra.evolution=true`,
 * sem token de serviço, 1 job vivo por filho. Nada aqui promove — o humano revisa e promove.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { SPEC_EDITABLE_STATUSES } from "../services/projectStatus.js";
import { httpPost } from "./specs.js";
import { activePlanJobFor, createPlanJob, getPlanJob, runEvolutionPlan } from "../services/evolutionPlanner.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

export async function evolutionPlanRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { id: string }; Body: { request?: string } }>(
    "/api/projects/:id/evolution-plan",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const user = getUser(request);
      if (denyCreationForManagement(user, reply)) return;
      if (user.svc === "runner") return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não planeja evolução (autoria humana)." });
      const proj = (await pool.query(
        "SELECT id, tenant_id, created_by, status, extra FROM projects WHERE id = $1", [request.params.id],
      )).rows[0] as { id: string; tenant_id: string | null; created_by: string | null; status: string; extra: Record<string, unknown> | null } | undefined;
      if (!proj || !canAccessProjectRow(user, proj)) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (proj.extra?.evolution !== true) return reply.status(409).send({ code: "NOT_EVOLUTION", message: "Este projeto não é uma evolução — use Evoluir no projeto aceito." });
      if (!SPEC_EDITABLE_STATUSES.has(proj.status)) return reply.status(409).send({ code: "SPEC_LOCKED", message: `Spec bloqueada: projeto em '${proj.status}'.` });
      const live = activePlanJobFor(proj.id);
      if (live) return reply.status(409).send({ code: "PLAN_IN_PROGRESS", message: "Já existe um planejamento em andamento para esta evolução.", jobId: live.id });
      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) return reply.status(503).send({ code: "AGENTS_UNAVAILABLE", message: "Serviço de agentes não configurado." });

      const job = createPlanJob(proj.id, user.id);
      const requestText = typeof request.body?.request === "string" ? request.body.request.trim().slice(0, 8000) : null;
      const base = agentsUrl.replace(/\/$/, "");
      void runEvolutionPlan(pool, job, requestText, (body) => httpPost(`${base}/invoke/raw`, JSON.stringify(body), 300_000))
        .catch((e) => { job.status = "error"; job.error = e instanceof Error ? e.message.slice(0, 300) : String(e); });
      return reply.status(202).send({ jobId: job.id, status: job.status });
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    "/api/projects/:id/evolution-plan/:jobId",
    async (request, reply) => {
      const user = getUser(request);
      const job = getPlanJob(request.params.jobId);
      if (!job || job.projectId !== request.params.id) return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado (pode ter expirado após restart)." });
      if (job.ownerUserId !== user.id && user.role !== "zentriz_admin") return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado." });
      return reply.send({ jobId: job.id, status: job.status, result: job.result ?? null, error: job.error ?? null });
    },
  );
}
