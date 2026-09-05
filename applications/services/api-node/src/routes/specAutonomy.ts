/**
 * specAutonomy.ts — rotas do MODO AUTÔNOMO da Bancada (2026-09-05).
 *
 *   POST /api/spec-autonomy                → inicia o laço (Resolver GAPs → Salvar → Validar × N)
 *   GET  /api/spec-autonomy?projectId=      → estado do laço (ativo ou o último) + log das rodadas
 *   POST /api/spec-autonomy/:id/stop        → interrompe o laço
 *
 * Autorização (mesma regra do chat de spec e do `spec-content`, RFC-0004 Onda 0):
 *   • `denyCreationForManagement` — conta de gestão não refina spec (autoria + LLM);
 *   • `svc:"runner"` 403 — token de máquina não reescreve a spec do cliente;
 *   • `canAccessProjectRow` — acesso ao projeto ANTES de qualquer leitura de conteúdo;
 *   • só o DONO do laço (ou quem tem acesso ao projeto) pode pará-lo.
 * A máquina de estados e todas as guardas de conteúdo vivem em `services/specAutonomy.ts`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import {
  startAutonomyRun, getAutonomyRun, getLatestAutonomyRun, stopAutonomyRun,
  autonomyEnabled, isTerminalAutonomyStatus, AUTONOMY_MAX_ROUNDS, type AutonomyRun,
} from "../services/specAutonomy.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

/** Contrato do wire: só o que a Bancada desenha (o `rounds` é o log de ações por rodada). */
function toWire(run: AutonomyRun) {
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    active: !isTerminalAutonomyStatus(run.status),
    round: run.round,
    maxRounds: run.maxRounds,
    gapsInitial: run.gapsInitial,
    gapsCurrent: run.gapsCurrent,
    rounds: run.rounds,
    lastError: run.lastError,
    deadlineAt: run.deadlineAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  };
}

async function loadProjectForUser(projectId: string, user: AuthUser): Promise<{ tenantId: string | null } | null> {
  const proj = (await pool.query("SELECT tenant_id, created_by FROM projects WHERE id = $1", [projectId])).rows[0];
  if (!proj || !canAccessProjectRow(user, proj)) return null;
  return { tenantId: (proj as { tenant_id?: string | null }).tenant_id ?? null };
}

export async function specAutonomyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Body: { projectId?: string; maxRounds?: number } }>(
    "/api/spec-autonomy",
    async (request, reply) => {
      const user = getUser(request);
      if (denyCreationForManagement(user, reply)) return;
      if (user.svc === "runner") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não opera o modo autônomo." });
      }
      if (!autonomyEnabled()) {
        return reply.status(503).send({ code: "AUTONOMY_DISABLED", message: "Modo autônomo desligado nesta instalação." });
      }
      const projectId = request.body?.projectId?.trim();
      if (!projectId) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "projectId obrigatório" });
      }
      const proj = await loadProjectForUser(projectId, user);
      if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

      const res = await startAutonomyRun(pool, {
        projectId, tenantId: proj.tenantId, ownerUserId: user.id, maxRounds: request.body?.maxRounds,
      });
      if (!res.ok) return reply.status(res.status).send({ code: res.code, message: res.message });
      return reply.status(202).send({ run: toWire(res.run), maxRoundsAllowed: AUTONOMY_MAX_ROUNDS });
    },
  );

  app.get<{ Querystring: { projectId?: string } }>(
    "/api/spec-autonomy",
    async (request, reply) => {
      const user = getUser(request);
      const projectId = request.query?.projectId?.trim();
      if (!projectId) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "projectId obrigatório" });
      }
      const proj = await loadProjectForUser(projectId, user);
      if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const run = await getLatestAutonomyRun(pool, projectId);
      return reply.send({
        run: run ? toWire(run) : null,
        enabled: autonomyEnabled(),
        maxRoundsAllowed: AUTONOMY_MAX_ROUNDS,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/spec-autonomy/:id/stop",
    async (request, reply) => {
      const user = getUser(request);
      if (user.svc === "runner") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não opera o modo autônomo." });
      }
      const run = await getAutonomyRun(pool, request.params.id);
      if (!run) return reply.status(404).send({ code: "NOT_FOUND", message: "Execução não encontrada" });
      // Escopo por PROJETO (não só por dono): quem pode editar a spec pode parar o laço que a escreve.
      if (!(await loadProjectForUser(run.projectId, user))) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Execução não encontrada" });
      }
      if (isTerminalAutonomyStatus(run.status)) {
        return reply.send({ run: toWire(run), stopped: false });
      }
      await stopAutonomyRun(pool, run.id);
      const after = await getAutonomyRun(pool, run.id);
      return reply.send({ run: after ? toWire(after) : null, stopped: true });
    },
  );
}
