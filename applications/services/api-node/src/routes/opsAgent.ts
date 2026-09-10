/**
 * opsAgent.ts (rotas) — o agente interno de operações, exposto só à conta de gestão.
 *
 * ⚖️ Jean, 2026-09-10: *"podemos ter um agente de IA usando LLM configurável na conta principal da
 * Zentriz para executar e auxiliar em operações internas"*.
 *
 * Por que só `zentriz_admin`: o agente lê o banco INTEIRO da plataforma, cruzando tenants. Um
 * `tenant_admin` que o alcançasse leria o negócio dos concorrentes dele. Não há escopo de tenant
 * aqui — há ausência de escopo, e é por isso que a porta é a mais estreita possível.
 *
 * POST /api/management/ops-agent/ask      — pergunta → resposta + trace de ferramentas
 * GET  /api/management/ops-agent/history  — auditoria das últimas execuções
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { ask, MAX_PASSOS } from "../services/opsAgent.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

function requireManagement(request: FastifyRequest, reply: FastifyReply): boolean {
  if (getUser(request)?.role !== "zentriz_admin") {
    reply.status(403).send({ code: "FORBIDDEN", message: "Somente a conta de gestão da Zentriz." });
    return false;
  }
  return true;
}

export async function opsAgentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  app.post("/api/management/ops-agent/ask", async (request, reply) => {
    if (!requireManagement(request, reply)) return;
    const user = getUser(request);
    const body = (request.body as { question?: string }) ?? {};
    const question = String(body.question ?? "").trim();
    if (!question) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "question é obrigatório" });
    }
    if (question.length > 4000) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "pergunta longa demais (máx. 4000 caracteres)" });
    }

    const r = await ask({ question, userId: user.id, userEmail: user.email });

    // Sem slot na conta de gestão a resposta é 409 e NÃO 500: não é falha do sistema, é
    // configuração que falta — e a tela precisa saber a diferença para mandar o operador ao
    // lugar certo (Zentriz → LLM da plataforma).
    if (!r.ok && r.code === "PLATFORM_LLM_NOT_CONFIGURED") {
      return reply.status(409).send({ code: r.code, message: r.error, steps: r.steps });
    }
    return reply.send({
      ok: r.ok, answer: r.answer, steps: r.steps, max_steps: MAX_PASSOS,
      provider: r.provider, model_id: r.modelId,
      duration_ms: r.durationMs, input_tokens: r.inputTokens, output_tokens: r.outputTokens,
      ...(r.error ? { error: r.error, code: r.code } : {}),
    });
  });

  app.get("/api/management/ops-agent/history", async (request, reply) => {
    if (!requireManagement(request, reply)) return;
    const q = (request.query as { limit?: string }) ?? {};
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);
    try {
      const res = await pool.query(
        `SELECT id, user_email, question, answer, provider, model_id, steps, status, error,
                duration_ms, input_tokens, output_tokens, created_at
         FROM ops_agent_runs ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return reply.send({ runs: res.rows });
    } catch {
      // Migration 126 ainda não aplicada: histórico vazio é melhor que 500 numa tela de leitura.
      return reply.send({ runs: [] });
    }
  });
}
