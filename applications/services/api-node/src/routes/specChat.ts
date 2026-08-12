/**
 * specChat.ts — Chat de edição de spec (Feature #63).
 *
 * Endpoints (padrão job-based, igual ao spec-preview de specs.ts — não bloqueia o request):
 *   POST /api/spec-chat       → enfileira job no agente CTO, devolve { jobId }
 *   GET  /api/spec-chat/:jobId → status/resultado { status, specMarkdown, reply }
 *
 * O usuário conversa com a IA para melhorar a spec iterativamente. A cada turno enviamos
 * a spec ATUAL + o histórico do chat + a última mensagem do usuário ao CTO; ele devolve a
 * spec REVISADA (artifact .md) + uma resposta curta (summary). Reusa os helpers de specs.ts
 * (httpPost/httpGet/extractSpecMarkdown) para não duplicar a mecânica de fila+poll.
 *
 * Persistência: quando `projectId` é informado (edição de spec de projeto existente), as
 * mensagens (a do usuário + a resposta da IA) são gravadas em spec_chat_messages (migração
 * 041). Sem projectId (spec ainda sem projeto), o histórico fica só no cliente.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { extractSpecMarkdown, httpPost, httpGet } from "./specs.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

// ── In-memory job store (transiente, igual ao _specJobs) ──────────────────────
type JobStatus = "pending" | "running" | "done" | "error";
interface ChatJob {
  id: string;
  status: JobStatus;
  specMarkdown?: string;
  reply?: string;
  error?: string;
  createdAt: number;
}
const _chatJobs = new Map<string, ChatJob>();

setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of _chatJobs) {
    if (job.createdAt < cutoff) _chatJobs.delete(id);
  }
}, 5 * 60_000);

function buildChatMessage(specMarkdown: string, messages: ChatMessage[]): Record<string, unknown> {
  // Mantém apenas as últimas mensagens para não estourar o contexto do agente.
  const history = messages.slice(-12);
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const transcript = history
    .map((m) => `${m.role === "user" ? "USUÁRIO" : "CTO"}: ${m.content}`)
    .join("\n\n");

  const task = `
Você é um CTO sênior refinando uma especificação de produto EM CONJUNTO com o usuário,
num chat iterativo. Você recebe a SPEC ATUAL (em Markdown), o HISTÓRICO da conversa e a
ÚLTIMA MENSAGEM do usuário.

OBJETIVO: aplicar SOMENTE as mudanças que o usuário pediu na última mensagem, devolvendo a
spec COMPLETA e revisada, e uma resposta curta explicando o que mudou.

REGRAS:
1. PRESERVE tudo o que o usuário não pediu para alterar — não regenere a spec do zero.
2. Aplique de forma cirúrgica o que foi pedido na última mensagem (adicionar/remover/ajustar).
3. Mantenha a spec consistente e implementável (FRs com critérios de aceite, modelo de dados, stack).
4. Devolva a SPEC INTEIRA revisada como o artefato Markdown principal (não só o trecho alterado).
5. No campo summary, escreva uma resposta CURTA (1-3 frases) ao usuário, em português, dizendo o que você mudou.

ÚLTIMA MENSAGEM DO USUÁRIO: "${lastUser.replace(/"/g, '\\"')}"

HISTÓRICO DO CHAT:
${transcript}
`.trim();

  return {
    project_id: "spec_chat",
    agent: "CTO",
    variant: "generic",
    mode: "spec_intake_and_normalize",
    request_id: `spec-chat-${Date.now()}`,
    task_id: null,
    task,
    inputs: {
      spec_raw: specMarkdown,
      product_spec: specMarkdown,
      chat_transcript: transcript,
      user_message: lastUser,
      input_type: "spec_refinement",
      constraints: [
        "preserve-unrequested-content",
        "apply-only-requested-changes",
        "return-full-revised-spec",
      ],
    },
    existing_artifacts: [],
    limits: { max_rounds: 1, timeout_sec: 120 },
  };
}

function runChatJob(jobId: string, message: Record<string, unknown>, agentsUrl: string): void {
  const job = _chatJobs.get(jobId);
  if (!job) return;
  job.status = "running";

  const base = agentsUrl.replace(/\/$/, "");
  const startedAt = Date.now();
  const MAX_MS = 660_000; // 11 min

  httpPost(`${base}/invoke/cto/async`, JSON.stringify(message), 30_000)
    .then((startText) => {
      const startData = JSON.parse(startText) as { jobId: string };
      const agentsJobId = startData.jobId;
      if (!agentsJobId) throw new Error("agents /invoke/cto/async did not return a jobId");

      console.log(`[SpecChat] job=${jobId} agents_job=${agentsJobId} started`);

      const timer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        if (elapsed > MAX_MS / 1000) {
          clearInterval(timer);
          const j = _chatJobs.get(jobId);
          if (j) { j.status = "error"; j.error = "Timeout: CTO demorou mais de 11 minutos."; }
          return;
        }

        httpGet(`${base}/invoke/cto/status/${agentsJobId}`, 60_000)
          .then((pollText) => {
            const pollData = JSON.parse(pollText) as {
              status: string; result?: Record<string, unknown>; error?: string;
            };
            const j = _chatJobs.get(jobId);
            if (!j) { clearInterval(timer); return; }

            if (pollData.status === "done" && pollData.result) {
              clearInterval(timer);
              j.specMarkdown = extractSpecMarkdown(pollData.result);
              j.reply = (pollData.result.summary as string | undefined)?.trim()
                || "Spec atualizada conforme solicitado.";
              j.status = "done";
              console.log(`[SpecChat] ✓ job=${jobId} DONE — ${j.specMarkdown?.length} chars`);
            } else if (pollData.status === "error") {
              clearInterval(timer);
              j.status = "error";
              j.error = pollData.error ?? "CTO job failed";
            }
          })
          .catch((pollErr) => {
            const errMsg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            console.warn(`[SpecChat] poll error job=${jobId} agents=${agentsJobId} elapsed=${elapsed}s: ${errMsg}`);
          });
      }, 8_000);

      (job as unknown as Record<string, unknown>)._timer = timer;
    })
    .catch((err) => {
      const j = _chatJobs.get(jobId);
      if (j) { j.status = "error"; j.error = err instanceof Error ? err.message.slice(0, 300) : String(err); }
    });
}

/** Grava uma mensagem do chat (best-effort — nunca derruba a rota). */
async function persistMessage(projectId: string, role: "user" | "assistant", content: string): Promise<void> {
  const client = await pool.connect();
  try {
    const proj = (await client.query(
      "SELECT tenant_id FROM projects WHERE id = $1", [projectId],
    )).rows[0];
    if (!proj) return;
    await client.query(
      `INSERT INTO spec_chat_messages (project_id, tenant_id, role, content) VALUES ($1, $2, $3, $4)`,
      [projectId, proj.tenant_id ?? null, role, content],
    );
  } catch (e) {
    console.warn(`[SpecChat] persistMessage falhou (best-effort): ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    client.release();
  }
}

export async function specChatRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // POST /api/spec-chat — enfileira job de refinamento e devolve jobId
  app.post<{ Body: { specMarkdown?: string; messages?: ChatMessage[]; projectId?: string } }>(
    "/api/spec-chat",
    async (request, reply) => {
      const body = request.body ?? {};
      const specMarkdown = (body.specMarkdown ?? "").trim();
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const projectId = body.projectId?.trim() || null;

      if (!specMarkdown) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "specMarkdown obrigatório" });
      }
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content?.trim();
      if (!lastUser) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Envie ao menos uma mensagem do usuário" });
      }

      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) {
        return reply.status(503).send({ code: "SERVICE_UNAVAILABLE", message: "Serviço de agentes não configurado" });
      }

      // Persiste a mensagem do usuário (se houver projeto associado) — best-effort.
      if (projectId) void persistMessage(projectId, "user", lastUser);

      const jobId = `scj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const job: ChatJob & { projectId?: string | null } = { id: jobId, status: "pending", createdAt: Date.now(), projectId };
      _chatJobs.set(jobId, job);

      runChatJob(jobId, buildChatMessage(specMarkdown, messages), agentsUrl);

      return reply.status(202).send({ jobId, status: "pending" });
    },
  );

  // GET /api/spec-chat/:jobId — poll
  app.get<{ Params: { jobId: string } }>(
    "/api/spec-chat/:jobId",
    async (request, reply) => {
      const { jobId } = request.params;
      const job = _chatJobs.get(jobId) as (ChatJob & { projectId?: string | null }) | undefined;
      if (!job) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado ou expirado" });
      }
      if (job.status === "done") {
        // Persiste a resposta da IA uma única vez (marca com _persisted).
        const marker = job as unknown as { _persisted?: boolean };
        if (job.projectId && job.reply && !marker._persisted) {
          marker._persisted = true;
          void persistMessage(job.projectId, "assistant", job.reply);
        }
        return reply.send({ jobId, status: "done", specMarkdown: job.specMarkdown, reply: job.reply });
      }
      if (job.status === "error") {
        return reply.send({ jobId, status: "error", error: job.error });
      }
      const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
      return reply.send({ jobId, status: job.status, elapsed });
    },
  );
}
