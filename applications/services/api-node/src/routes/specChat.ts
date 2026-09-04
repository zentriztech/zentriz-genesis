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
import type { ValidationFinding } from "../services/specValidation.js";

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

// ── Onda 1: contexto do CHAT (spec inteira + arquivos IRMÃOS + relatório de validação) ──
// O CTO precisava CONHECER a spec atual, os arquivos irmãos (Produto>Projeto>Spec) e os GAPs
// da validação adversarial para agir sobre o arquivo em questão. Antes o /invoke/cto/async só
// recebia o `specMarkdown` (arquivo primário) → o CTO respondia "não tenho acesso à spec atual
// nem ao relatório de validação". Montamos um bloco SÓ-LEITURA com ORÇAMENTO de caracteres —
// o runtime trunca `spec_raw` em ~30k, então o contexto extra vai no `task`/`inputs`, NUNCA
// inflando o spec_raw (que continua sendo só a spec a revisar).
const SIBLINGS_BUDGET = 14_000;
const FINDINGS_BUDGET = 6_000;

interface ChatContext {
  siblingsBlock: string; // "" quando não há irmãos além do arquivo primário
  findingsBlock: string; // "" quando nunca validado / sem findings
  findings: ValidationFinding[];
  derivedStatus: string;
}
const EMPTY_CTX: ChatContext = { siblingsBlock: "", findingsBlock: "", findings: [], derivedStatus: "never_validated" };

function fmtFinding(f: ValidationFinding): string {
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  const sev = (f.severity || "info").toUpperCase();
  return `- [${sev}] ${loc} — ${f.title}${f.rationale ? `: ${f.rationale}` : ""}`;
}

/**
 * Carrega o contexto SÓ-LEITURA do chat de spec inteira: (a) conteúdo de TODOS os arquivos
 * irmãos do produto (menos o primário, já enviado como spec_raw), cortado por orçamento; e
 * (b) os findings da última run de validação (GAPs conhecidos). Best-effort: qualquer falha
 * devolve contexto vazio — jamais derruba a rota do chat.
 */
async function loadChatContext(projectId: string, primaryContent: string): Promise<ChatContext> {
  try {
    const { computeCurrentSpecHash } = await import("../services/specValidation.js");
    const current = await computeCurrentSpecHash(pool, projectId);

    let siblingsBlock = "";
    if (current && current.files.length > 1) {
      const primaryTrim = primaryContent.trim();
      const parts: string[] = [];
      let used = 0;
      for (const f of current.files) {
        const body = f.content ?? "";
        // Não duplica o arquivo primário (idêntico ao spec_raw enviado).
        if (body.trim() === primaryTrim) continue;
        const remaining = SIBLINGS_BUDGET - used;
        if (remaining <= 0) { parts.push("\n### (demais arquivos omitidos por limite de contexto)"); break; }
        const path = f.rel_dir ? `${f.rel_dir}/${f.filename}` : f.filename;
        const clipped = body.length > remaining ? body.slice(0, remaining) + "\n…(truncado)…" : body;
        parts.push(`\n### ARQUIVO: ${path}\n${clipped}`);
        used += clipped.length;
      }
      if (parts.length) siblingsBlock = parts.join("\n");
    }

    // Findings da última run (qualquer status) — expõe os GAPs conhecidos ao CTO.
    const latest = (await pool.query(
      "SELECT status, findings FROM spec_validation_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
      [projectId],
    )).rows[0] as { status?: string; findings?: ValidationFinding[] } | undefined;
    let findingsBlock = "";
    let findings: ValidationFinding[] = [];
    if (Array.isArray(latest?.findings) && latest!.findings.length) {
      findings = latest!.findings;
      let block = findings.map(fmtFinding).join("\n");
      if (block.length > FINDINGS_BUDGET) block = block.slice(0, FINDINGS_BUDGET) + "\n…(demais findings omitidos)…";
      findingsBlock = block;
    }
    return { siblingsBlock, findingsBlock, findings, derivedStatus: latest?.status ?? "never_validated" };
  } catch (e) {
    console.warn(`[SpecChat] loadChatContext falhou (best-effort): ${e instanceof Error ? e.message : String(e)}`);
    return EMPTY_CTX;
  }
}

// Modo SPEC INTEIRA (sem filePath): refina a PRODUCT_SPEC via CTO normalizador (cto/async).
// O modo por-arquivo NÃO passa por aqui — ver buildRawFileRequest (usa /invoke/raw cirúrgico).
function buildChatMessage(
  specMarkdown: string,
  messages: ChatMessage[],
  ctx: ChatContext = EMPTY_CTX,
  resolveGaps = false,
): Record<string, unknown> {
  // Mantém apenas as últimas mensagens para não estourar o contexto do agente.
  const history = messages.slice(-12);
  // Em "Resolver GAPs" a instrução é sintetizada aqui (o cliente pode não enviar mensagem).
  const lastUser = resolveGaps
    ? "Resolva de forma ADVERSARIAL e cirúrgica TODOS os GAPs listados no RELATÓRIO DE VALIDAÇÃO, ajustando a spec para eliminá-los sem introduzir novos problemas nem remover conteúdo válido."
    : ([...history].reverse().find((m) => m.role === "user")?.content ?? "");
  const transcript = history
    .map((m) => `${m.role === "user" ? "USUÁRIO" : "CTO"}: ${m.content}`)
    .join("\n\n");

  const contextSections = [
    ctx.siblingsBlock
      ? `\n\n─── ARQUIVOS IRMÃOS DO PRODUTO (SÓ LEITURA — contexto do Produto>Projeto>Spec) ───\n${ctx.siblingsBlock}`
      : "",
    ctx.findingsBlock
      ? `\n\n─── RELATÓRIO DE VALIDAÇÃO / GAPs A RESOLVER (adversarial) ───\n${ctx.findingsBlock}`
      : "",
  ].join("");

  const gapRule = resolveGaps
    ? "\n6. Este turno é RESOLVER GAPS: trate CADA item do relatório de validação, priorizando blockers > warnings > info; resuma no summary quais GAPs foram resolvidos e como."
    : "";

  const task = `
Você é um CTO sênior refinando uma especificação de produto EM CONJUNTO com o usuário,
num chat iterativo. Você recebe a SPEC ATUAL (em Markdown), o HISTÓRICO da conversa, a
ÚLTIMA MENSAGEM do usuário e — quando houver — os ARQUIVOS IRMÃOS do produto e o RELATÓRIO
DE VALIDAÇÃO adversarial. Você TEM acesso a tudo isso abaixo; use-o para agir com precisão.

OBJETIVO: aplicar SOMENTE as mudanças que o usuário pediu na última mensagem, devolvendo a
spec COMPLETA e revisada, e uma resposta curta explicando o que mudou.

REGRAS:
1. PRESERVE tudo o que o usuário não pediu para alterar — não regenere a spec do zero.
2. Aplique de forma cirúrgica o que foi pedido na última mensagem (adicionar/remover/ajustar).
3. Mantenha a spec consistente e implementável (FRs com critérios de aceite, modelo de dados, stack).
4. Devolva a SPEC INTEIRA revisada como o artefato Markdown principal (não só o trecho alterado).
   IMPORTANTE: o artefato principal DEVE ter o caminho EXATO "docs/spec/PRODUCT_SPEC.md"
   (esse é o único path aceito — usar outro caminho REPROVA a revisão e força um retrabalho lento).
5. No campo summary, escreva uma resposta CURTA (1-3 frases) ao usuário, em português, dizendo o que você mudou.${gapRule}

Os ARQUIVOS IRMÃOS são contexto SÓ-LEITURA (não os reescreva) — servem para você entender o
produto inteiro. O RELATÓRIO DE VALIDAÇÃO lista GAPs já detectados na spec.

ÚLTIMA MENSAGEM DO USUÁRIO: "${lastUser.replace(/"/g, '\\"')}"

HISTÓRICO DO CHAT:
${transcript}${contextSections}
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
      sibling_files_context: ctx.siblingsBlock || undefined,
      validation_report: ctx.findingsBlock || undefined,
      resolve_gaps: resolveGaps || undefined,
      input_type: "spec_refinement",
      constraints: [
        "preserve-unrequested-content",
        "apply-only-requested-changes",
        "return-full-revised-spec",
      ],
    },
    existing_artifacts: [],
    // NOTA: hoje `limits` é INERTE nesta rota — o wrapper /invoke/cto/async (server.py) embrulha
    // o corpo inteiro sob `input` (não há `input` de topo aqui), e runtime.py lê message.get("limits")
    // no topo → sempre {} → cai no default REQUEST_TIMEOUT/900 (por isso o antigo 120 nunca matou a
    // geração de 7-8 min). Mantemos 900 (= o default real) por clareza, caso o wrapper passe a
    // preservar `limits`. O teto EFETIVO do job é o MAX_MS do runChatJob (18 min, cobre 1 gen +
    // eventual repair). Ver [[genesis-resolver-gaps-timeout-fix]].
    limits: { max_rounds: 1, timeout_sec: 900 },
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
  // 18 min: uma revisão de spec inteira (regenera o PRODUCT_SPEC) leva ~7-8 min; esse teto dá
  // folga inclusive p/ um eventual repair único do envelope. O frontend usa o MESMO teto (18 min).
  const MAX_MS = 1_080_000; // 18 min

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
          if (j) { j.status = "error"; j.error = "Timeout: CTO demorou mais de 18 minutos."; }
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
  app.post<{ Body: { specMarkdown?: string; messages?: ChatMessage[]; projectId?: string; filePath?: string; baseSha?: string; resolveGaps?: boolean } }>(
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
      // Onda 1: "Resolver GAPs" — turno especial (spec inteira) que manda o CTO resolver os
      // findings da validação adversarial. A instrução é sintetizada no servidor.
      const resolveGaps = body.resolveGaps === true;
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
      // Resolver GAPs é sempre no escopo da SPEC INTEIRA de um projeto (nunca por-arquivo).
      if (resolveGaps) {
        if (!projectId) return reply.status(400).send({ code: "BAD_REQUEST", message: "Resolver GAPs exige projectId" });
        if (filePath) return reply.status(400).send({ code: "BAD_REQUEST", message: "Resolver GAPs não opera em modo por-arquivo" });
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
      // Em Resolver GAPs a mensagem é sintetizada no servidor — não exige mensagem do cliente.
      if (!resolveGaps && !lastUser) {
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

      // Onda 1: no modo SPEC INTEIRA com projeto, carrega contexto SÓ-LEITURA (irmãos + GAPs)
      // para o CTO agir com precisão. Best-effort (falha → contexto vazio, sem derrubar a rota).
      const ctx = projectId && !filePath ? await loadChatContext(projectId, specMarkdown) : EMPTY_CTX;

      // Resolver GAPs sem findings em aberto = nada a fazer → erro claro (não gera turno vazio).
      if (resolveGaps && ctx.findings.length === 0) {
        return reply.status(409).send({
          code: "NO_GAPS",
          message: "Nenhum GAP em aberto na última validação. Rode Validar para (re)avaliar a spec.",
        });
      }

      // Mensagem do usuário a persistir/logar: sintetizada em Resolver GAPs.
      const persistedUserMsg = resolveGaps
        ? `🛠️ Resolver GAPs — pedi ao CTO para corrigir os ${ctx.findings.length} GAP(s) da validação adversarial.`
        : (lastUser ?? "");

      // Persiste a mensagem do usuário (se houver projeto associado) — best-effort.
      if (projectId && persistedUserMsg) void persistMessage(projectId, "user", persistedUserMsg, { filePath, userId: user.id });

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
        // Spec inteira: CTO normalizador via cto/async (regenera a PRODUCT_SPEC — correto aqui),
        // agora COM contexto dos irmãos + relatório de validação (e instrução de resolver GAPs).
        runChatJob(jobId, buildChatMessage(specMarkdown, messages, ctx, resolveGaps), agentsUrl);
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
