/**
 * specQuestions.ts (rotas) — D3: perguntas da fábrica ao humano e respostas que retomam o run.
 *
 *  POST /api/projects/:id/questions  — runner (svc:runner) ou zentriz_admin: a fábrica pergunta → needs_spec_input
 *  GET  /api/projects/:id/questions  — histórico do projeto (tenant-scoped)
 *  GET  /api/spec-questions          — fila do tenant (perguntas abertas); zentriz_admin vê todas
 *  POST /api/projects/:id/answer     — humano responde → spec_submitted + redispara o run (retoma do checkpoint)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { dispatchProjectRun } from "../services/runnerDispatch.js";
import {
  answerSpecQuestion, listOpenQuestions, listProjectQuestions, raiseSpecQuestions, SPEC_QUESTION_MAX_ROUNDS,
} from "../services/specQuestions.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getUser(request: FastifyRequest): AuthUser {
  return (request as FastifyRequest & { user: AuthUser }).user;
}

async function loadAccessibleProject(projectId: string, user: AuthUser) {
  if (!UUID_RE.test(projectId)) return null;
  const row = (await pool.query("SELECT id, tenant_id, created_by, status, title FROM projects WHERE id = $1", [projectId])).rows[0] as
    { id: string; tenant_id: string | null; created_by: string | null; status: string; title: string | null } | undefined;
  if (!row || !canAccessProjectRow(user, row)) return null;
  return row;
}

export async function specQuestionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { id: string }; Body: { stage?: string; questions?: unknown; askedBy?: string; requestId?: string } }>(
    "/api/projects/:id/questions",
    async (request, reply) => {
      const user = getUser(request);
      // Só a FÁBRICA (token de máquina svc:runner) ou a Zentriz podem fazer o projeto perguntar.
      if (user.svc !== "runner" && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Só a fábrica registra perguntas." });
      }
      const row = await loadAccessibleProject(request.params.id, user);
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const body = request.body ?? {};
      const r = await raiseSpecQuestions(pool, {
        projectId: row.id, stage: body.stage, questions: body.questions, askedBy: body.askedBy, requestId: body.requestId ?? null,
      });
      if (!r.ok) {
        if (r.code === "QUESTION_ROUNDS_EXCEEDED") {
          return reply.status(409).send({ code: r.code, message: `Teto de ${SPEC_QUESTION_MAX_ROUNDS} rodada(s) de perguntas atingido.`, round: r.round, maxRounds: SPEC_QUESTION_MAX_ROUNDS });
        }
        if (r.code === "QUESTION_ALREADY_OPEN") {
          return reply.status(409).send({ code: r.code, message: "Já existe pergunta aberta para este projeto.", round: r.round, questionId: r.questionId });
        }
        return reply.status(r.code === "NOT_FOUND" ? 404 : 400).send({ code: r.code });
      }
      return reply.status(201).send({ questionId: r.questionId, round: r.round, maxRounds: SPEC_QUESTION_MAX_ROUNDS, status: "needs_spec_input" });
    },
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/questions", async (request, reply) => {
    const row = await loadAccessibleProject(request.params.id, getUser(request));
    if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
    return reply.send({ projectId: row.id, status: row.status, maxRounds: SPEC_QUESTION_MAX_ROUNDS, questions: await listProjectQuestions(pool, row.id) });
  });

  app.get<{ Querystring: { limit?: string } }>("/api/spec-questions", async (request, reply) => {
    const user = getUser(request);
    if (user.svc === "runner") return reply.status(403).send({ code: "FORBIDDEN" });
    const tenantId = user.role === "zentriz_admin" ? null : user.tenantId;
    if (user.role !== "zentriz_admin" && !tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });
    const limit = parseInt(request.query.limit ?? "100", 10) || 100;
    return reply.send({ questions: await listOpenQuestions(pool, tenantId, limit) });
  });

  app.post<{ Params: { id: string }; Body: { answer?: string; questionId?: string } }>(
    "/api/projects/:id/answer",
    async (request, reply) => {
      const user = getUser(request);
      // Resposta é ato HUMANO de AUTORIA de requisito: token de máquina não responde à própria pergunta;
      // conta de gestão (zentriz_admin) não redige requisito do tenant (RFC-0002 A.1); só tenant_admin/owner
      // (D3: "responde o tenant_admin") — adversarial D3 #C.
      if (user.svc === "runner") return reply.status(403).send({ code: "FORBIDDEN", message: "Só um humano responde às perguntas da fábrica." });
      if (denyCreationForManagement(user, reply)) return;
      if (!["tenant_admin", "owner"].includes(user.role)) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Só o administrador do tenant responde às perguntas da fábrica." });
      }
      const row = await loadAccessibleProject(request.params.id, user);
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const r = await answerSpecQuestion(pool, { projectId: row.id, answer: request.body?.answer ?? "", userId: user.id, questionId: request.body?.questionId ?? null });
      if (!r.ok) {
        const http = r.code === "NOT_FOUND" ? 404 : r.code === "WRONG_STATUS" || r.code === "NO_OPEN_QUESTION" ? 409 : 400;
        return reply.status(http).send({ code: r.code, status: r.status });
      }
      // Retoma a fábrica do checkpoint (LEI 11) — a resposta já está em projects.extra.spec_answers.
      let dispatch: { dispatched: boolean; reason?: string } = { dispatched: false, reason: "not_attempted" };
      try {
        const d = await dispatchProjectRun(pool, row.id);
        dispatch = { dispatched: d.dispatched, reason: d.reason };
      } catch (e) {
        dispatch = { dispatched: false, reason: e instanceof Error ? e.message : String(e) };
      }
      return reply.send({ ok: true, questionId: r.questionId, round: r.round, status: "spec_submitted", dispatch });
    },
  );
}
