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
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { extractSpecMarkdown, httpPost, httpGet } from "./specs.js";
import { parseSpecPath } from "./specFiles.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// UUID canônico — user.id vem do JWT já como UUID, mas normalizamos para não gravar lixo.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// C1 (revisão adversarial): runtime.py trunca spec_raw em [:30000] e o artefato do CTO tem
// teto ~20k. Em modo por-arquivo, mandar um arquivo grande faria o CTO revisar uma versão
// TRUNCADA → o apply sobrescreveria o arquivo real com a versão cortada (perda de dados).
// Bloqueamos o chat por-arquivo acima deste teto (o chat da spec inteira continua liberado).
const MAX_FILE_CHAT_CHARS = 20_000;

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
  /** RFC-0004 Onda 0 (S3): dono do job — o poll só devolve ao usuário que o criou. */
  ownerUserId: string;
  projectId?: string | null;
  /** T4.3: modo por-arquivo — capturados NO ENVIO para o apply ser consistente. */
  sentFilePath?: string | null;
  sentBaseSha?: string | null;
}
const _chatJobs = new Map<string, ChatJob>();

setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of _chatJobs) {
    if (job.createdAt < cutoff) _chatJobs.delete(id);
  }
}, 5 * 60_000);

// Modo SPEC INTEIRA (sem filePath): refina a PRODUCT_SPEC via CTO normalizador (cto/async).
// O modo por-arquivo NÃO passa por aqui — ver buildRawFileRequest (usa /invoke/raw cirúrgico).
function buildChatMessage(
  specMarkdown: string,
  messages: ChatMessage[],
): Record<string, unknown> {
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

// ── Modo POR-ARQUIVO (T4.3): edição CIRÚRGICA via /invoke/raw ─────────────────
// A revisão adversarial ao VIVO (Validação PÓS) provou que o modo spec_intake_and_normalize
// do CTO é um NORMALIZADOR: ele REGENERA um PRODUCT_SPEC completo (Metadados/Visão/FRs/DoD…)
// e DESCARTA o conteúdo original do arquivo → aplicar = perda de dados. Para editar UM arquivo
// usamos /invoke/raw (síncrono, prompt controlado): instruímos o modelo a devolver o CONTEÚDO
// FINAL COMPLETO do arquivo preservando tudo o que não foi pedido. NÃO passa pelo enforcer/normalizador.
const RAW_FILE_SYSTEM = [
  "Você é um editor de texto técnico. Recebe o CONTEÚDO ATUAL de UM arquivo (Markdown) e um PEDIDO.",
  "Aplique EXATAMENTE o pedido PRESERVANDO todo o resto do arquivo.",
  "NÃO reescreva, NÃO normalize, NÃO adicione seções não pedidas, NÃO gere um novo documento/spec.",
  "Devolva SOMENTE o conteúdo final COMPLETO do arquivo, sem cercas de código, sem comentários, sem preâmbulo.",
].join(" ");

function buildRawFileRequest(
  content: string,
  messages: ChatMessage[],
  filePath: string,
): Record<string, unknown> {
  const history = messages.slice(-12);
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
  // Histórico só para dar contexto iterativo — o modelo edita o CONTEÚDO ATUAL, não o transcript.
  const transcript = history
    .map((m) => `${m.role === "user" ? "USUÁRIO" : "EDITOR"}: ${m.content}`)
    .join("\n");
  const userMessage = [
    `ARQUIVO: ${filePath}`,
    "",
    "--- CONTEÚDO ATUAL ---",
    content,
    "--- FIM ---",
    "",
    transcript ? `HISTÓRICO DA CONVERSA:\n${transcript}\n` : "",
    `PEDIDO: ${lastUser}`,
    "",
    "Devolva agora o conteúdo final completo do arquivo (apenas o texto do arquivo).",
  ].join("\n");
  return {
    prompt_override: RAW_FILE_SYSTEM,
    user_message: userMessage,
    max_tokens: 8000,
  };
}

// Remove cerca de código envolvente (```md … ```) SE o modelo tiver desobedecido e cercado
// o arquivo inteiro. Não toca em cercas internas legítimas (só o par externo que abraça tudo).
function stripOuterFence(s: string): string {
  const t = s.replace(/\r\n/g, "\n").trim();
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : t;
}

function runFileChatJob(jobId: string, raw: Record<string, unknown>, agentsUrl: string): void {
  const job = _chatJobs.get(jobId);
  if (!job) return;
  job.status = "running";
  const base = agentsUrl.replace(/\/$/, "");

  // Síncrono: /invoke/raw responde no próprio request (não há fila/poll no lado dos agentes).
  httpPost(`${base}/invoke/raw`, JSON.stringify(raw), 180_000)
    .then((text) => {
      const j = _chatJobs.get(jobId);
      if (!j) return;
      const data = JSON.parse(text) as { response?: string; model_used?: string };
      const md = stripOuterFence(data.response ?? "");
      // Sanidade: resposta vazia/trivial = falha (o /invoke/raw já escala fallback internamente,
      // então vazio aqui significa que nem o fallback produziu conteúdo). NÃO aplicamos lixo.
      if (!md || md.trim().length < 2) {
        j.status = "error";
        j.error = "A IA não retornou conteúdo para o arquivo. Reformule o pedido e tente de novo.";
        console.warn(`[SpecChat] job=${jobId} raw vazio — model=${data.model_used ?? "?"}`);
        return;
      }
      j.specMarkdown = md;
      // /invoke/raw devolve SÓ o conteúdo do arquivo — a "resposta" ao usuário é sintetizada aqui.
      j.reply = "Revisão pronta — confira e clique em “Aplicar ao arquivo”.";
      j.status = "done";
      console.log(`[SpecChat] ✓ job=${jobId} DONE (raw) — ${md.length} chars, model=${data.model_used ?? "?"}`);
    })
    .catch((err) => {
      const j = _chatJobs.get(jobId);
      if (j) { j.status = "error"; j.error = err instanceof Error ? err.message.slice(0, 300) : String(err); }
    });
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
              // H4 (revisão adversarial): agents devolve status="done" mesmo quando o CTO
              // BLOQUEOU/FALHOU a revisão (envelope.status BLOCKED/FAIL) — antes gravávamos
              // uma spec vazia/parcial e o usuário podia APLICAR isso por cima da spec real.
              // Agora: só é sucesso com envelope OK e markdown não-trivial; senão é erro claro.
              const agentStatus = String((pollData.result as { status?: string }).status ?? "").toUpperCase();
              const md = extractSpecMarkdown(pollData.result);
              if (agentStatus === "BLOCKED" || agentStatus === "FAIL" || !md || md.trim().length < 20) {
                j.status = "error";
                j.error = (agentStatus === "BLOCKED" || agentStatus === "FAIL")
                  ? `O CTO não conseguiu revisar (${agentStatus}). Reformule o pedido e tente de novo.`
                  : "O CTO não retornou uma spec revisada válida. Reformule o pedido e tente de novo.";
                console.warn(`[SpecChat] job=${jobId} rejeitado — agentStatus=${agentStatus} mdLen=${md?.length ?? 0}`);
                return;
              }
              j.specMarkdown = md;
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
async function persistMessage(
  projectId: string,
  role: "user" | "assistant",
  content: string,
  opts?: { filePath?: string | null; userId?: string | null },
): Promise<void> {
  const client = await pool.connect();
  try {
    const proj = (await client.query(
      "SELECT tenant_id FROM projects WHERE id = $1", [projectId],
    )).rows[0];
    if (!proj) return;
    // T4.3 (migração 077): file_path escopa o histórico por arquivo; user_id (UUID validado)
    // dá autoria. Colunas são ADD COLUMN IF NOT EXISTS → INSERT tolera schema antigo? Não:
    // se a migração não rodou, este INSERT falha e cai no catch (best-effort) — aceitável.
    const filePath = opts?.filePath ?? null;
    const userId = opts?.userId && UUID_RE.test(opts.userId) ? opts.userId : null;
    await client.query(
      `INSERT INTO spec_chat_messages (project_id, tenant_id, role, content, file_path, user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, proj.tenant_id ?? null, role, content, filePath, userId],
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
  app.post<{ Body: { specMarkdown?: string; messages?: ChatMessage[]; projectId?: string; filePath?: string; baseSha?: string } }>(
    "/api/spec-chat",
    async (request, reply) => {
      const user = getUser(request);
      // RFC-0002 A.1: conta de gestão (zentriz_admin) não refina spec (autoria + LLM).
      if (denyCreationForManagement(user, reply)) return;
      // RFC-0004 Onda 0 (S6): spec é autoria HUMANA — token de máquina não conversa com o CTO.
      if (user.svc === "runner") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não usa o chat de spec." });
      }
      const body = request.body ?? {};
      const specMarkdown = (body.specMarkdown ?? "").trim();
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const projectId = body.projectId?.trim() || null;
      // T4.3: modo por-arquivo (opcional). filePath validado por parseSpecPath (M2), baseSha
      // é o sha que o usuário viu — capturado aqui para o apply detectar edição concorrente.
      const rawFilePath = body.filePath?.trim() || null;
      const baseSha = body.baseSha?.trim() || null;
      let filePath: string | null = null;
      if (rawFilePath) {
        const parsed = parseSpecPath(rawFilePath);
        if (!parsed) {
          return reply.status(400).send({ code: "BAD_REQUEST", message: "filePath inválido" });
        }
        // caminho normalizado (relDir/filename) — o mesmo formato que a árvore/PUT usam.
        filePath = parsed.relDir ? `${parsed.relDir}/${parsed.filename}` : parsed.filename;
        // Editar UM arquivo exige um projeto (é onde a árvore/arquivos vivem).
        if (!projectId) {
          return reply.status(400).send({ code: "BAD_REQUEST", message: "filePath exige projectId" });
        }
      }

      if (!specMarkdown) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "specMarkdown obrigatório" });
      }
      // C1: em modo por-arquivo, bloqueia conteúdo acima do teto (evita revisão truncada → apply
      // sobrescrevendo o arquivo real com versão cortada). O chat da spec inteira não tem esse apply.
      if (filePath && specMarkdown.length > MAX_FILE_CHAT_CHARS) {
        return reply.status(413).send({
          code: "FILE_TOO_LARGE",
          message: `Arquivo grande demais para o chat por-arquivo (${specMarkdown.length} > ${MAX_FILE_CHAT_CHARS} caracteres). Edite manualmente ou divida o arquivo.`,
        });
      }
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content?.trim();
      if (!lastUser) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Envie ao menos uma mensagem do usuário" });
      }

      // RFC-0004 Onda 0 (S2): projectId do body era aceito SEM checagem de acesso — tenant A
      // gravava mensagens no histórico de spec do tenant B (prompt injection armazenada
      // cross-tenant quando o histórico virar contexto). Agora: acesso verificado ANTES.
      if (projectId) {
        const client = await pool.connect();
        try {
          const proj = (await client.query(
            "SELECT tenant_id, created_by FROM projects WHERE id = $1", [projectId],
          )).rows[0];
          if (!proj || !canAccessProjectRow(user, proj)) {
            return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
          }
        } finally {
          client.release();
        }
      }

      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) {
        return reply.status(503).send({ code: "SERVICE_UNAVAILABLE", message: "Serviço de agentes não configurado" });
      }

      // Persiste a mensagem do usuário (se houver projeto associado) — best-effort.
      if (projectId) void persistMessage(projectId, "user", lastUser, { filePath, userId: user.id });

      const jobId = randomUUID(); // S3: id não-adivinhável (o antigo scj-<ts>-<5 base36> era fraco)
      const job: ChatJob = {
        id: jobId, status: "pending", createdAt: Date.now(), projectId, ownerUserId: user.id,
        sentFilePath: filePath, sentBaseSha: baseSha,
      };
      _chatJobs.set(jobId, job);

      if (filePath) {
        // Modo por-arquivo: edição cirúrgica via /invoke/raw (preserva o conteúdo original).
        runFileChatJob(jobId, buildRawFileRequest(specMarkdown, messages, filePath), agentsUrl);
      } else {
        // Spec inteira: CTO normalizador via cto/async (regenera a PRODUCT_SPEC — correto aqui).
        runChatJob(jobId, buildChatMessage(specMarkdown, messages), agentsUrl);
      }

      return reply.status(202).send({ jobId, status: "pending", filePath, baseSha });
    },
  );

  // GET /api/spec-chat/:jobId — poll
  app.get<{ Params: { jobId: string } }>(
    "/api/spec-chat/:jobId",
    async (request, reply) => {
      const { jobId } = request.params;
      const job = _chatJobs.get(jobId);
      // S3: binding de dono — sem isso, qualquer autenticado com o jobId lia a spec revisada
      // de outro tenant (mesma classe do binding de token da rota B). 404 (não 403) para não
      // vazar a existência do job.
      if (!job || job.ownerUserId !== getUser(request).id) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado ou expirado" });
      }
      if (job.status === "done") {
        // Persiste a resposta da IA uma única vez (marca com _persisted).
        const marker = job as unknown as { _persisted?: boolean };
        if (job.projectId && job.reply && !marker._persisted) {
          marker._persisted = true;
          void persistMessage(job.projectId, "assistant", job.reply, { filePath: job.sentFilePath });
        }
        // T4.3: devolve filePath/baseSha capturados NO ENVIO → o apply grava no arquivo certo
        // e detecta edição concorrente (o baseSha é o que o usuário via quando pediu a revisão).
        return reply.send({
          jobId, status: "done", specMarkdown: job.specMarkdown, reply: job.reply,
          filePath: job.sentFilePath ?? null, baseSha: job.sentBaseSha ?? null,
        });
      }
      if (job.status === "error") {
        return reply.send({ jobId, status: "error", error: job.error });
      }
      const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
      return reply.send({ jobId, status: job.status, elapsed });
    },
  );
}
