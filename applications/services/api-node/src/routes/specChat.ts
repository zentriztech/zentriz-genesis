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
 *
 * DURABILIDADE (migração 089, 2026-09-04): o job também NASCE NO POSTGRES (`spec_chat_jobs`) na
 * mesma transação da mensagem do usuário. Antes vivia só no Map abaixo: sair da tela matava o
 * poll, o job seguia vivo nos agents e o resultado nascia inalcançável — medido em prod, um job
 * concluiu com 95.199 bytes de spec revisada e o trabalho foi jogado fora. Agora:
 *   • `agents_job_id` é gravado logo após o dispatch → recoletável até depois de um restart;
 *   • quem garante a coleta é o `specChatWorker` (server-side) — o usuário não precisa voltar;
 *   • `GET /api/spec-chat/in-flight` e `/history` permitem REHIDRATAR a tela;
 *   • o teto expira a ESPERA, nunca o TRABALHO (`deadline_at`, 40 min < TTL de 45 min do agente).
 * O Map continua como cache quente (latência baixa para quem está com a tela aberta) e como
 * fallback quando o banco recusa a escrita. Fonte da verdade = Postgres.
 */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { resolveWorkbenchLlm, agentsLlmFields } from "../services/tenantLlmConfig.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import {
  createSpecChatJob, setAgentsJobId, touchSpecChatJob, finishSpecChatJob, getSpecChatJob,
  findInFlightSpecChatJob, markSpecChatJobCollected, loadSpecChatHistory, judgeCtoResult,
  CHAT_JOB_DEADLINE_MS, FILE_JOB_DEADLINE_MS, type SpecChatJobStatus,
} from "../services/specChatJobs.js";
import { extractSpecMarkdown, httpPost, httpGet } from "./specs.js";
import { parseSpecPath } from "./specFiles.js";
import type { ValidationFinding } from "../services/specValidation.js";
import { productScopeEnabled, buildProductMap, selectSiblingBodies } from "../services/productContext.js";

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

// Impressão da spec NO MOMENTO DO ENVIO. Guardamos só o hash (não a spec de entrada: medido em
// prod, 40 jobs = 144 kB só de saída) para a rehidratação saber dizer "a spec mudou desde então"
// antes de o usuário aplicar uma revisão feita sobre uma base antiga.
function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
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

// 60 min: o teto do job de spec inteira é 40 min (deadline_at) e o poll em processo precisa
// sobreviver até lá. Com 30 min o cache era varrido COM O JOB AINDA VIVO e o poll morria no meio.
// Isto é só cache: a linha em `spec_chat_jobs` sobrevive à varredura.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
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
  /**
   * Fase 1 (escopo de PRODUTO, flag `SPEC_CONTEXT_PRODUCT_SCOPE`): índice determinístico
   * Produto > Projeto > arquivo. "" quando a flag está off, o produto tem 1 projeto vigente
   * (custo zero no caso mais comum) ou o mapa não pôde ser montado.
   */
  productMapBlock: string;
  /** Furos do contexto (spec ilegível, escopo divergente) — logados; não silenciados (GAP-10). */
  contextWarnings: string[];
  /**
   * `true` = os blocos de contexto vão como CAMPOS PRÓPRIOS para o runtime emitir
   * (`context_emit: "v2"`) e a api PARA de colá-los no `task`. Sem isto, ligar a emissão no
   * runtime mandaria o mesmo texto duas vezes. Só liga junto com a flag.
   */
  emitV2: boolean;
}
const EMPTY_CTX: ChatContext = {
  siblingsBlock: "", findingsBlock: "", findings: [], derivedStatus: "never_validated",
  productMapBlock: "", contextWarnings: [], emitV2: false,
};

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
async function loadChatContext(
  projectId: string,
  primaryContent: string,
  /** Mensagem do humano — só usada na seleção por relevância do corpo dos irmãos (P2). */
  userMessage = "",
  /**
   * P4: no chat POR-ARQUIVO o modelo recebe o MAPA (para saber onde aquele arquivo vive) mas NÃO o
   * corpo dos irmãos — é edição pontual e o `/invoke/raw` tem teto próprio.
   */
  opts: { siblingBodies?: boolean } = {},
): Promise<ChatContext> {
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
      // RFC-0005: só GAPs ATIVOS vão como trabalho; Refutados vão como "não tratar / não reintroduzir";
      // Ignorados (risco aceito pelo humano) não vão.
      const { enrichRunFindings } = await import("../services/findingTriage.js");
      const enriched = await enrichRunFindings(pool, projectId, latest!.findings).catch(() => null);
      const active = enriched ? enriched.filter((f) => !f.triage) : latest!.findings;
      const refuted = enriched ? enriched.filter((f) => f.triage?.state === "refuted") : [];
      findings = active;
      let block = active.map(fmtFinding).join("\n");
      if (block.length > FINDINGS_BUDGET) block = block.slice(0, FINDINGS_BUDGET) + "\n…(demais findings omitidos)…";
      if (refuted.length) {
        block += `\n\nREFUTADOS PELO HUMANO (falsos positivos — NÃO tratar, NÃO reintroduzir texto para "resolvê-los"):\n` +
          refuted.slice(0, 20).map((f) => `- ${f.file || "(spec)"} — ${f.title}`).join("\n");
      }
      findingsBlock = block;
    }

    // ── Fase 1: escopo de PRODUTO (flag off → nada abaixo roda; contexto byte-idêntico ao antigo) ──
    let productMapBlock = "";
    const contextWarnings: string[] = [];
    let emitV2 = false;
    if (productScopeEnabled()) {
      emitV2 = true;
      // Falha do mapa NÃO derruba o chat (mas também não fica invisível — GAP-10).
      const map = await buildProductMap(pool, projectId).catch((e) => {
        contextWarnings.push(`mapa do produto falhou: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (map) {
        productMapBlock = map.block;
        contextWarnings.push(...map.warnings);
        // Corpo dos irmãos por relevância (P2), SOMANDO ao bloco de irmãos do mesmo projeto (que
        // continua existindo; em prod ele é vazio porque 58/58 projetos têm 1 arquivo).
        const picked = opts.siblingBodies === false
          ? { block: "", included: [] as string[], omitted: [] as string[] }
          : selectSiblingBodies(map, { findings, userMessage });
        if (picked.block) siblingsBlock = siblingsBlock ? `${siblingsBlock}\n${picked.block}` : picked.block;
        console.info(
          `[SpecChat] contexto de produto: projeto=${projectId} produto=${map.productName ?? "—"} ` +
          `projetos=${map.projects.length} corpos=${picked.included.length} omitidos=${picked.omitted.length} ` +
          `mapa=${productMapBlock.length}c irmãos=${siblingsBlock.length}c`,
        );
      }
      for (const w of contextWarnings) console.warn(`[SpecChat] ⚠️ contexto: ${w}`);
    }

    return {
      siblingsBlock, findingsBlock, findings, derivedStatus: latest?.status ?? "never_validated",
      productMapBlock, contextWarnings, emitV2,
    };
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
  /** Projeto REAL — só para o ESCOPO do circuit breaker dos agents (ver `circuit_scope` abaixo). */
  scopeProjectId: string | null = null,
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

  // Com `emitV2` (flag de produto ligada) os blocos viajam como CAMPOS e o runtime os emite com
  // orçamento derivado do modelo — colá-los aqui TAMBÉM mandaria o mesmo texto duas vezes (era o
  // que já acontecia de fato: `task` + `inputs`, sendo que os `inputs` eram inertes).
  const contextSections = ctx.emitV2 ? "" : [
    ctx.siblingsBlock
      ? `\n\n─── ARQUIVOS IRMÃOS DO PRODUTO (SÓ LEITURA — contexto do Produto>Projeto>Spec) ───\n${ctx.siblingsBlock}`
      : "",
    ctx.findingsBlock
      ? `\n\n─── RELATÓRIO DE VALIDAÇÃO / GAPs A RESOLVER (adversarial) ───\n${ctx.findingsBlock}`
      : "",
  ].join("");

  // Onda A (épico spec-rica): no modo RESOLVER GAPS o CTO deixa de ser normalizador passivo e
  // atua como ARQUITETO DE PRODUTO — questiona dimensão, propõe features de mercado, resolve GAPs
  // com profundidade de especialista — e a spec passa a DECLARAR o contrato Connect · Auto Care
  // (senão a fábrica adivinha por heurística e gera produto genérico). Ver
  // [[genesis-spec-rica-connect-compliant-epic-2026-09-04]].
  const connectContract = [
    'D) CONTRATO DE INTEROPERABILIDADE (Genesis · Connect · Auto Care) — OBRIGATÓRIO: inclua na spec uma',
    '   seção "## Contrato de Interoperabilidade (Connect)" declarando EXPLICITAMENTE (não deixe a fábrica adivinhar):',
    "   - systemId (slug ^[a-z][a-z0-9-]*$) e integrationTier alvo (tier0-generic | tier1-integration-ready |",
    "     tier2-deadpool-ready | tier3-genesis-deadpool-native);",
    "   - SERVIÇOS do produto e, para cada um: responsabilidade, dependências e INTERFACES no formato",
    "     {nome, tipo: http|event|queue|stream|cron|internal, contractRef (rota/OpenAPI/tópico)};",
    "   - EVENTOS publicados/consumidos (nome + payload) e, havendo entrega de valor, os ValueEvent aplicáveis",
    "     (project_delivered | deploy_completed | pipeline_run_completed | spec_promoted);",
    "   - healthModel (endpoint de health + sinais + se é SLO-crítico) e baseline de OBSERVABILIDADE",
    "     (sinais/dashboards/alertas mínimos) para o plano de sustentação Auto Care (Deadpool);",
    "   - owners (técnico e de produto) e ações seguras conhecidas (safe actions) quando aplicável.",
  ].join("\n");

  const resolveGapsBlock = resolveGaps
    ? `

ESTE TURNO É "RESOLVER GAPS" — AJA COMO ARQUITETO DE PRODUTO, NÃO COMO NORMALIZADOR PASSIVO:
A) Trate CADA item do RELATÓRIO DE VALIDAÇÃO de forma ADVERSARIAL e PROFUNDA, com skills de
   ESPECIALISTA do tema (segurança, modelo de dados, contratos de API, infraestrutura, regras de
   negócio), priorizando blockers > warnings > info. NÃO introduza contradições novas ao corrigir
   (ex.: citar blocklist de JWT sem declarar o \`jti\`; citar campo que não existe no modelo de dados).
B) ENRIQUEÇA a spec para representar o PRODUTO REAL e FUNCIONAL que a fábrica vai gerar, dimensionando
   o TAMANHO da aplicação. Onde o usuário (muitas vezes leigo) deixou lacunas de dimensionamento, ASSUMA
   um padrão sensato e seguro e MARQUE no texto como "Premissa:"; e, no summary, faça 2-5 PERGUNTAS
   objetivas de dimensionamento (escala/nº de usuários, multi-tenant?, papéis/permissões, integrações
   externas, compliance/LGPD, SLA/disponibilidade, distribuição de infra) para o usuário confirmar ou
   corrigir na PRÓXIMA rodada do chat.
C) PROPONHA features ancoradas em como produtos reais do domínio funcionam (pesquisa de mercado): liste-as
   no summary e incorpore as ESSENCIAIS como FRs na spec (marcadas "Proposto:"), sem inflar escopo além do
   núcleo de valor.
${connectContract}
E) DIMENSÃO ARQUITETURAL E INFRA (ciente de decomposição): se o produto for MULTI-COMPONENTE (ex.: backend +
   frontend + worker) ou depender de INFRA COMPARTILHADA (banco/cache/fila/busca — ex.: "PostgreSQL 16 · Redis 7"),
   NÃO deixe isso implícito: (1) declare na spec uma seção "## Infraestrutura, Dependências e Distribuição" com
   cada serviço de dado (versão, esquema/migrações iniciais, env, portas) e a ESTRATÉGIA DE DISTRIBUIÇÃO
   (docker-compose na mesma máquina do backend — default MVP — OU Terraform/serviço gerenciado); marque escolhas
   incertas como "Premissa:" e faça a pergunta de distribuição no summary; e (2) RECOMENDE explicitamente no summary
   DECOMPOR o produto em N projetos (backend, frontend, infra/database) via a ação "Decompor produto" da Bancada,
   pois a fábrica gera um projeto por vez — um único documento monolítico vira um app que não sobe de verdade.
No summary (pode ser mais longo NESTE turno): liste GAPs resolvidos (e como), premissas assumidas,
perguntas de dimensionamento e features propostas.`
    : "";

  const persona = resolveGaps
    ? "Você é um CTO sênior E estrategista de produto, com profundidade de ESPECIALISTA nos temas da spec"
    : "Você é um CTO sênior refinando uma especificação de produto EM CONJUNTO com o usuário";

  const task = `
${persona}, num chat iterativo cuja conversa é PERSISTIDA. Você recebe a SPEC ATUAL (em Markdown),
o HISTÓRICO da conversa, a ÚLTIMA MENSAGEM do usuário e — quando houver — os ARQUIVOS IRMÃOS do
produto e o RELATÓRIO DE VALIDAÇÃO adversarial. Você TEM acesso a tudo isso abaixo; use-o com precisão.

OBJETIVO: ${resolveGaps
      ? "resolver os GAPs e ENRIQUECER a spec para um produto real, funcional e Connect-compliant, devolvendo a spec COMPLETA revisada e um summary com perguntas/premissas/features."
      : "aplicar SOMENTE as mudanças que o usuário pediu na última mensagem, devolvendo a spec COMPLETA e revisada, e uma resposta curta explicando o que mudou."}

REGRAS:
1. ${resolveGaps
      ? "PRESERVE o conteúdo válido existente; você PODE adicionar/expandir seções para enriquecer, mas nunca descarte requisitos válidos."
      : "PRESERVE tudo o que o usuário não pediu para alterar — não regenere a spec do zero."}
2. ${resolveGaps
      ? "Trate os GAPs com profundidade de especialista e sem criar novas inconsistências."
      : "Aplique de forma cirúrgica o que foi pedido na última mensagem (adicionar/remover/ajustar)."}
3. Mantenha a spec consistente e implementável (FRs com critérios de aceite DADO/QUANDO/ENTÃO, modelo de dados, stack).
4. Devolva a SPEC INTEIRA revisada como o artefato Markdown principal (não só o trecho alterado).
   IMPORTANTE: o artefato principal DEVE ter o caminho EXATO "docs/spec/PRODUCT_SPEC.md"
   (esse é o único path aceito — usar outro caminho REPROVA a revisão e força um retrabalho lento).
5. No campo summary, ${resolveGaps
      ? "responda em português listando GAPs resolvidos, premissas assumidas, perguntas de dimensionamento (2-5) e features propostas."
      : "escreva uma resposta CURTA (1-3 frases) ao usuário, em português, dizendo o que você mudou."}${resolveGapsBlock}

Os ARQUIVOS IRMÃOS são contexto SÓ-LEITURA (não os reescreva) — servem para você entender o
produto inteiro. O RELATÓRIO DE VALIDAÇÃO lista GAPs já detectados na spec.

ÚLTIMA MENSAGEM DO USUÁRIO: "${lastUser.replace(/"/g, '\\"')}"

HISTÓRICO DO CHAT:
${transcript}${contextSections}
`.trim();

  return {
    project_id: "spec_chat",
    // 🔴 2026-09-05 — o `project_id` acima é um PSEUDO-projeto (mantido: paths de artefato, logs e
    // persistência do lado dos agents dependem dele). Como o circuit breaker do runtime era chaveado
    // por ele, TODA a Bancada compartilhava UM breaker: 3 falhas seguidas de qualquer cliente
    // bloqueavam o chat de spec de TODOS os tenants, sem sequer chamar o modelo. `circuit_scope`
    // isola o breaker por projeto real (o runtime prefere este campo ao `project_id`).
    circuit_scope: scopeProjectId ? `spec_chat:${scopeProjectId}` : "spec_chat",
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
      // Fase 1 (P1/P3): índice do produto + marca que autoriza o runtime a EMITIR estes campos
      // (`build_user_message`). Sem a marca o runtime os ignora, como sempre fez — assim api e
      // agents podem ser deployados em qualquer ordem sem duplicar nem perder contexto.
      product_map: ctx.productMapBlock || undefined,
      context_emit: ctx.emitV2 ? "v2" : undefined,
      resolve_gaps: resolveGaps || undefined,
      input_type: "spec_refinement",
      constraints: resolveGaps
        ? [
            "resolve-validation-gaps",
            "enrich-to-real-functional-product",
            "connect-compliant-contract",
            "return-full-revised-spec",
            "no-new-contradictions",
          ]
        : [
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

/** P4: teto do contexto extra (mapa + GAPs) no modo por-arquivo — o `/invoke/raw` tem max_tokens 8k. */
const RAW_FILE_CONTEXT_BUDGET = 12_000;

function buildRawFileRequest(
  content: string,
  messages: ChatMessage[],
  filePath: string,
  /** Fase 1 P4: o chat por-arquivo rodava com contexto ZERO (defeito E) — era o caminho mais cego. */
  ctx: ChatContext = EMPTY_CTX,
): Record<string, unknown> {
  const history = messages.slice(-12);
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
  // Histórico só para dar contexto iterativo — o modelo edita o CONTEÚDO ATUAL, não o transcript.
  const transcript = history
    .map((m) => `${m.role === "user" ? "USUÁRIO" : "EDITOR"}: ${m.content}`)
    .join("\n");
  // Mapa + GAPs entram como CONTEXTO SÓ-LEITURA e cabem no orçamento; a edição continua sendo de UM
  // arquivo (o retorno é um único documento — o modelo é fisicamente incapaz de tocar num irmão).
  const contextBlock = ctx.emitV2
    ? [ctx.productMapBlock, ctx.findingsBlock ? `GAPs conhecidos desta spec:\n${ctx.findingsBlock}` : ""]
        .filter(Boolean).join("\n\n").slice(0, RAW_FILE_CONTEXT_BUDGET)
    : "";
  const userMessage = [
    `ARQUIVO: ${filePath}`,
    "",
    contextBlock
      ? `--- CONTEXTO SÓ-LEITURA (onde este arquivo vive; NÃO o copie para o arquivo) ---\n${contextBlock}\n--- FIM DO CONTEXTO ---\n`
      : "",
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

/**
 * Encerra o job nos DOIS lugares: cache quente (Map) e Postgres.
 * O Map serve à latência de quem está olhando; o banco é o que sobrevive a sair da tela, ao
 * restart da api e ao deploy. `finishSpecChatJob` é claim-locked, então o poll em processo e o
 * `specChatWorker` podem correr juntos sem duplicar a resposta no histórico.
 */
function settleJob(
  jobId: string,
  patch: { status: Exclude<SpecChatJobStatus, "pending" | "running">; specMarkdown?: string | null; reply?: string | null; error?: string | null; modelUsed?: string | null },
): void {
  const j = _chatJobs.get(jobId);
  if (j) {
    // O contrato do Map só tem 4 estados; interrupted/lost são erros com causa para o cliente.
    j.status = patch.status === "done" ? "done" : "error";
    if (patch.specMarkdown) j.specMarkdown = patch.specMarkdown;
    if (patch.reply) j.reply = patch.reply;
    if (patch.error) j.error = patch.error;
  }
  void finishSpecChatJob(pool, jobId, patch);
}

function runFileChatJob(jobId: string, raw: Record<string, unknown>, agentsUrl: string): void {
  const job = _chatJobs.get(jobId);
  if (!job) return;
  job.status = "running";
  const base = agentsUrl.replace(/\/$/, "");

  // D4: o modo por-arquivo não tinha teto algum — uma resposta que nunca chegasse deixava o job
  // `running` até o TTL do Map varrer, e o frontend girava para sempre. O `/invoke/raw` tem
  // timeout de 180 s; o teto do job (FILE_JOB_DEADLINE_MS) é a rede de segurança acima disso.
  const guard = setTimeout(() => {
    settleJob(jobId, { status: "error", error: "A IA não respondeu no tempo máximo desta edição. Tente de novo." });
  }, FILE_JOB_DEADLINE_MS);
  guard.unref?.();

  // Síncrono: /invoke/raw responde no próprio request (não há fila/poll no lado dos agentes).
  httpPost(`${base}/invoke/raw`, JSON.stringify(raw), 180_000)
    .then((text) => {
      clearTimeout(guard);
      const data = JSON.parse(text) as { response?: string; model_used?: string };
      const md = stripOuterFence(data.response ?? "");
      // Sanidade: resposta vazia/trivial = falha (o /invoke/raw já escala fallback internamente,
      // então vazio aqui significa que nem o fallback produziu conteúdo). NÃO aplicamos lixo.
      if (!md || md.trim().length < 2) {
        console.warn(`[SpecChat] job=${jobId} raw vazio — model=${data.model_used ?? "?"}`);
        settleJob(jobId, { status: "error", error: "A IA não retornou conteúdo para o arquivo. Reformule o pedido e tente de novo." });
        return;
      }
      settleJob(jobId, {
        status: "done",
        specMarkdown: md,
        // /invoke/raw devolve SÓ o conteúdo do arquivo — a "resposta" ao usuário é sintetizada aqui.
        reply: "Revisão pronta — confira e clique em “Aplicar ao arquivo”.",
        modelUsed: data.model_used ?? null,
      });
      console.log(`[SpecChat] ✓ job=${jobId} DONE (raw) — ${md.length} chars, model=${data.model_used ?? "?"}`);
    })
    .catch((err) => {
      clearTimeout(guard);
      settleJob(jobId, { status: "error", error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    });
}

function runChatJob(jobId: string, message: Record<string, unknown>, agentsUrl: string): void {
  const job = _chatJobs.get(jobId);
  if (!job) return;
  job.status = "running";

  const base = agentsUrl.replace(/\/$/, "");
  const startedAt = Date.now();
  // 🔴 F17 (medido em prod 2026-09-04): o teto ANTERIOR era 18 min (1_080_000) e as durações reais
  // foram 18m58s (72.519 chars OK) e 19m12s (78.700 chars OK) — ou seja, o teto DESCARTAVA trabalho
  // bom e pago em Opus 5. O teto agora é 40 min, alinhado ao `deadline_at` da linha no banco e ao
  // TTL de 45 min do `_async_jobs` dos agents: expira a ESPERA, nunca o TRABALHO.
  const MAX_MS = CHAT_JOB_DEADLINE_MS;

  httpPost(`${base}/invoke/cto/async`, JSON.stringify(message), 30_000)
    .then((startText) => {
      const startData = JSON.parse(startText) as { jobId: string };
      const agentsJobId = startData.jobId;
      if (!agentsJobId) throw new Error("agents /invoke/cto/async did not return a jobId");

      console.log(`[SpecChat] job=${jobId} agents_job=${agentsJobId} started`);
      // CHAVE do late collect: sem isto gravado, um restart da api torna o resultado irrecuperável.
      void setAgentsJobId(pool, jobId, agentsJobId);

      // Poll em processo: existe só para dar latência baixa a quem está com a tela aberta. Se este
      // processo morrer, o `specChatWorker` adota o job pelo `agents_job_id` — o resultado não se
      // perde mais por ninguém estar olhando (era a causa raiz do "sai da tela e perde o estado").
      const timer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        if (elapsed > MAX_MS / 1000) {
          clearInterval(timer);
          settleJob(jobId, {
            status: "error",
            error: "O CTO passou do tempo máximo (40 min). Se ele terminar depois, a revisão aparece ao reabrir a Bancada.",
          });
          return;
        }
        // Heartbeat: diz ao worker "alguém já está cuidando deste job" (evita probe duplicado).
        void touchSpecChatJob(pool, jobId);

        httpGet(`${base}/invoke/cto/status/${agentsJobId}`, 60_000)
          .then((pollText) => {
            const pollData = JSON.parse(pollText) as {
              status: string; result?: Record<string, unknown>; error?: string;
            };
            if (pollData.status === "done" && pollData.result) {
              clearInterval(timer);
              // H4 (revisão adversarial): agents devolve status="done" mesmo quando o CTO
              // BLOQUEOU/FALHOU a revisão (envelope.status BLOCKED/FAIL) — antes gravávamos
              // uma spec vazia/parcial e o usuário podia APLICAR isso por cima da spec real.
              // O mesmo gate roda no worker (judgeCtoResult), para os dois caminhos coincidirem.
              const verdict = judgeCtoResult(pollData.result, extractSpecMarkdown);
              if (verdict.status !== "done") {
                console.warn(`[SpecChat] job=${jobId} rejeitado pelo gate H4 — ${verdict.error}`);
              } else {
                console.log(`[SpecChat] ✓ job=${jobId} DONE — ${verdict.specMarkdown?.length} chars`);
              }
              settleJob(jobId, verdict);
            } else if (pollData.status === "error") {
              clearInterval(timer);
              settleJob(jobId, { status: "error", error: pollData.error ?? "CTO job failed" });
            }
          })
          .catch((pollErr) => {
            // Não encerra o job aqui: uma falha isolada de rede não é motivo para descartar uma
            // revisão de 19 minutos. Quem declara `lost` (404 ou 5 falhas seguidas) é o worker.
            const errMsg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            console.warn(`[SpecChat] poll error job=${jobId} agents=${agentsJobId} elapsed=${elapsed}s: ${errMsg}`);
          });
      }, 8_000);
      timer.unref?.();
    })
    .catch((err) => {
      settleJob(jobId, { status: "error", error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    });
}

/**
 * NOTA: `persistMessage` foi REMOVIDA. As duas gravações do histórico passaram para
 * `services/specChatJobs.ts`, amarradas ao ciclo de vida do job:
 *   • a mensagem do USUÁRIO entra na mesma transação do INSERT do job (sem turno órfão);
 *   • a resposta do ASSISTENTE entra em `finishSpecChatJob`, idempotente pelo índice único
 *     parcial `(job_id, role)` — antes ela era gravada LAZY dentro do GET, com uma marca
 *     `_persisted` que vivia em memória: sem poll, o turno nunca era gravado (medido em prod:
 *     22 mensagens `user` × 18 `assistant` no mesmo projeto = 4 respostas perdidas), e com dois
 *     pollers a mesma resposta podia ser inserida duas vezes.
 */

/**
 * MODO AUTÔNOMO (2026-09-05): dispara "Resolver GAPs" pelo MESMO caminho do botão manual.
 *
 * Existe para o `specAutonomy` não reimplementar contexto (irmãos + findings ativos), prompt,
 * persistência do turno do usuário nem o gate H4 — se o servidor resolvesse GAPs por um caminho
 * paralelo, o autônomo divergiria do manual no primeiro ajuste de prompt. As checagens de
 * autorização (dono/tenant, `svc:"runner"`, `denyCreationForManagement`) ficam na ROTA do
 * autônomo: aqui já se assume um pedido autorizado.
 *
 * Devolve `NO_GAPS` quando não há finding ATIVO — para o laço isso é SUCESSO, não erro.
 */
export async function dispatchResolveGapsJob(opts: {
  jobId: string;
  projectId: string;
  tenantId: string | null;
  ownerUserId: string;
  specMarkdown: string;
  userMessage: string;
  agentsUrl: string;
  llm: Record<string, unknown>;
}): Promise<{ ok: true; gaps: number } | { ok: false; code: "NO_GAPS" }> {
  const ctx = await loadChatContext(opts.projectId, opts.specMarkdown, opts.userMessage);
  if (ctx.findings.length === 0) return { ok: false, code: "NO_GAPS" };

  _chatJobs.set(opts.jobId, {
    id: opts.jobId, status: "pending", createdAt: Date.now(),
    projectId: opts.projectId, ownerUserId: opts.ownerUserId,
    sentFilePath: null, sentBaseSha: null,
  });
  await createSpecChatJob(pool, {
    id: opts.jobId, projectId: opts.projectId, tenantId: opts.tenantId, ownerUserId: opts.ownerUserId,
    kind: "resolve_gaps", filePath: null, baseSha: null, baseSpecSha: sha256(opts.specMarkdown),
    userMessage: opts.userMessage,
  });
  runChatJob(opts.jobId, { ...buildChatMessage(opts.specMarkdown, [], ctx, true, opts.projectId), ...opts.llm }, opts.agentsUrl);
  return { ok: true, gaps: ctx.findings.length };
}

/** Traduz o estado do banco para o contrato da rota (o cliente só conhece 4 estados). */
function wireStatus(status: SpecChatJobStatus): "pending" | "running" | "done" | "error" {
  if (status === "done") return "done";
  if (status === "pending" || status === "running") return status;
  return "error"; // error | interrupted | lost — a CAUSA vai no campo `error`
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
      // tenant do projeto: usado só para relatório/retenção na linha do job — NUNCA para autorizar
      // (a autorização é `canAccessProjectRow` + binding de dono).
      let projectTenantId: string | null = null;
      if (projectId) {
        const client = await pool.connect();
        try {
          const proj = (await client.query(
            "SELECT tenant_id, created_by FROM projects WHERE id = $1", [projectId],
          )).rows[0];
          if (!proj || !canAccessProjectRow(user, proj)) {
            return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
          }
          projectTenantId = (proj as { tenant_id?: string | null }).tenant_id ?? null;
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
      // Fase 1 (P4): o modo POR-ARQUIVO deixa de rodar cego — recebe o MAPA do produto e os GAPs
      // (sem corpo de irmãos). Com a flag off ambos os caminhos ficam como estavam.
      const loadCtx = projectId && (!filePath || productScopeEnabled());
      const ctx = loadCtx
        ? await loadChatContext(projectId!, specMarkdown, lastUser ?? "", { siblingBodies: !filePath })
        : EMPTY_CTX;

      // Resolver GAPs sem findings em aberto = nada a fazer → erro claro (não gera turno vazio).
      if (resolveGaps && ctx.findings.length === 0) {
        return reply.status(409).send({
          code: "NO_GAPS",
          message: "Nenhum GAP ATIVO na última validação (ignorados/refutados não são tratados). Rode Validar para (re)avaliar a spec.",
        });
      }

      // Mensagem do usuário a persistir/logar: sintetizada em Resolver GAPs.
      const persistedUserMsg = resolveGaps
        ? `🛠️ Resolver GAPs — pedi ao CTO para corrigir os ${ctx.findings.length} GAP(s) da validação adversarial.`
        : (lastUser ?? "");

      const jobId = randomUUID(); // S3: id não-adivinhável (o antigo scj-<ts>-<5 base36> era fraco)
      const job: ChatJob = {
        id: jobId, status: "pending", createdAt: Date.now(), projectId, ownerUserId: user.id,
        sentFilePath: filePath, sentBaseSha: baseSha,
      };
      _chatJobs.set(jobId, job);

      // Migração 089: o job + a mensagem do usuário nascem no banco NA MESMA TRANSAÇÃO. Antes a
      // mensagem era gravada fire-and-forget ANTES de o job existir → se o dispatch falhasse
      // sobrava uma pergunta órfã que a rehidratação exibiria como turno sem resposta.
      // Best-effort: se o banco recusar, o job segue só no Map (comportamento antigo).
      await createSpecChatJob(pool, {
        id: jobId, projectId, tenantId: projectTenantId, ownerUserId: user.id,
        kind: filePath ? "file" : (resolveGaps ? "resolve_gaps" : "chat"),
        filePath, baseSha, baseSpecSha: sha256(specMarkdown),
        userMessage: persistedUserMsg || null,
      });

      // A Bancada usa a MESMA config de LLM da fábrica (modelo, rework e credenciais do tenant/projeto).
      // Sem config do tenant → campos omitidos → agents seguem no env (comportamento anterior).
      const llm = agentsLlmFields(await resolveWorkbenchLlm({ projectId, tenantId: user.tenantId }));
      if (filePath) {
        // Modo por-arquivo: edição cirúrgica via /invoke/raw (preserva o conteúdo original).
        runFileChatJob(jobId, { ...buildRawFileRequest(specMarkdown, messages, filePath, ctx), ...llm }, agentsUrl);
      } else {
        // Spec inteira: CTO normalizador via cto/async (regenera a PRODUCT_SPEC — correto aqui),
        // agora COM contexto dos irmãos + relatório de validação (e instrução de resolver GAPs).
        runChatJob(jobId, { ...buildChatMessage(specMarkdown, messages, ctx, resolveGaps, projectId), ...llm }, agentsUrl);
      }

      // `deadlineAt` no 202: o teto de espera passa a ser DITADO PELO SERVIDOR. O cliente tinha um
      // 18 min hardcoded que, medido em prod, era MENOR que a duração real (18m58s / 19m12s) —
      // ele descartava revisões que o CTO havia concluído. Um número, uma fonte.
      const deadlineAt = new Date(Date.now() + (filePath ? FILE_JOB_DEADLINE_MS : CHAT_JOB_DEADLINE_MS)).toISOString();
      return reply.status(202).send({ jobId, status: "pending", filePath, baseSha, deadlineAt });
    },
  );

  // GET /api/spec-chat/in-flight?projectId=&filePath= — REHIDRATAÇÃO da tela.
  // Rota registrada ANTES de /:jobId (find-my-way dá precedência a segmento estático, mas a
  // ordem explícita evita depender disso). É o endpoint que faltava: sem ele o frontend não
  // tinha como perguntar "existe revisão em voo neste projeto?" e redisparava um segundo Opus 5.
  app.get<{ Querystring: { projectId?: string; filePath?: string } }>(
    "/api/spec-chat/in-flight",
    async (request, reply) => {
      const user = getUser(request);
      const projectId = (request.query.projectId ?? "").trim();
      // Fail-closed em três camadas (a classe do P0 cross-tenant de /api/deadpool/*):
      // 1) formato, 2) acesso ao projeto, 3) binding de dono no próprio SQL.
      if (!UUID_RE.test(projectId)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "projectId inválido" });
      }
      const proj = (await pool.query(
        "SELECT tenant_id, created_by FROM projects WHERE id = $1", [projectId],
      )).rows[0];
      if (!proj || !canAccessProjectRow(user, proj)) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      }
      let filePath: string | null = null;
      if (request.query.filePath?.trim()) {
        const parsed = parseSpecPath(request.query.filePath.trim());
        if (!parsed) return reply.status(400).send({ code: "BAD_REQUEST", message: "filePath inválido" });
        filePath = parsed.relDir ? `${parsed.relDir}/${parsed.filename}` : parsed.filename;
      }
      const job = await findInFlightSpecChatJob(pool, { projectId, filePath, ownerUserId: user.id });
      if (!job) return reply.send({ job: null });
      // Escalares apenas — `spec_markdown` (até 95 kB) só sai pelo GET /:jobId, quando o cliente
      // decidir buscar o resultado. Este endpoint roda a cada mount da tela.
      const createdMs = new Date(job.createdAt).getTime();
      return reply.send({
        job: {
          jobId: job.id,
          status: wireStatus(job.status),
          kind: job.kind,
          filePath: job.filePath,
          baseSha: job.baseSha,
          baseSpecSha: job.baseSpecSha,
          error: job.error,
          elapsed: Number.isFinite(createdMs) ? Math.round((Date.now() - createdMs) / 1000) : 0,
          deadlineAt: job.deadlineAt,
          // ISO sempre: o mapper do serviço faz `String(created_at)` (→ `Date.prototype.toString`,
          // "Fri Sep 04 2026 …"), formato que só o parser leniente do JS entende.
          createdAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : null,
          // `true` = terminou enquanto ninguém olhava; o cliente deve OFERECER (não aplicar) o
          // resultado, porque a spec no editor pode ter sido editada à mão nesse meio-tempo.
          recovered: job.status === "done" && !job.collectedAt,
          // `true` = job REPROVADO (enforcer/BLOCKED, interrupção, perda) que ainda assim carrega uma
          // spec gravada. O cliente busca o resultado pelo GET /:jobId e OFERECE, avisando o motivo.
          salvaged: job.status !== "done" && job.hasSpecMarkdown,
        },
      });
    },
  );

  // GET /api/spec-chat/history?projectId=&filePath= — o chat deixa de nascer vazio.
  // `spec_chat_messages` era WRITE-ONLY (zero SELECT em todo o api-node): o diálogo era gravado
  // desde a migração 041 e NUNCA lido de volta — metade visível do "perdi o estado".
  app.get<{ Querystring: { projectId?: string; filePath?: string; limit?: string } }>(
    "/api/spec-chat/history",
    async (request, reply) => {
      const user = getUser(request);
      const projectId = (request.query.projectId ?? "").trim();
      if (!UUID_RE.test(projectId)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "projectId inválido" });
      }
      const proj = (await pool.query(
        "SELECT tenant_id, created_by FROM projects WHERE id = $1", [projectId],
      )).rows[0];
      if (!proj || !canAccessProjectRow(user, proj)) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      }
      let filePath: string | null = null;
      if (request.query.filePath?.trim()) {
        const parsed = parseSpecPath(request.query.filePath.trim());
        if (!parsed) return reply.status(400).send({ code: "BAD_REQUEST", message: "filePath inválido" });
        filePath = parsed.relDir ? `${parsed.relDir}/${parsed.filename}` : parsed.filename;
      }
      const limit = Number.parseInt(request.query.limit ?? "40", 10);
      const messages = await loadSpecChatHistory(pool, {
        projectId, filePath, limit: Number.isFinite(limit) ? limit : 40,
      });
      return reply.send({ messages });
    },
  );

  // GET /api/spec-chat/:jobId — poll
  app.get<{ Params: { jobId: string } }>(
    "/api/spec-chat/:jobId",
    async (request, reply) => {
      const { jobId } = request.params;
      const user = getUser(request);
      const mem = _chatJobs.get(jobId);
      // Fonte da verdade = banco; o Map é cache quente e fallback (se a escrita da migração 089
      // tiver falhado, o job existe só em memória e o comportamento antigo é preservado).
      const db = UUID_RE.test(jobId) ? await getSpecChatJob(pool, jobId) : null;
      const ownerUserId = db?.ownerUserId || mem?.ownerUserId;
      // S3: binding de dono — sem isso, qualquer autenticado com o jobId lia a spec revisada
      // de outro tenant (mesma classe do binding de token da rota B). 404 (não 403) para não
      // vazar a existência do job.
      if (!ownerUserId || ownerUserId !== user.id) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado ou expirado" });
      }

      // Estado efetivo: o terminal do BANCO vence (é o que o worker escreve quando coleta um job
      // que este processo não estava mais pollando); na ausência dele, o cache.
      const dbTerminal = db && db.status !== "pending" && db.status !== "running";
      const status = dbTerminal ? wireStatus(db!.status) : (mem?.status ?? wireStatus(db?.status ?? "pending"));
      const specMarkdown = dbTerminal ? db!.specMarkdown : (mem?.specMarkdown ?? db?.specMarkdown ?? null);
      const replyText = dbTerminal ? db!.reply : (mem?.reply ?? db?.reply ?? null);
      const errorText = dbTerminal ? db!.error : (mem?.error ?? db?.error ?? null);
      const filePath = db?.filePath ?? mem?.sentFilePath ?? null;
      const baseSha = db?.baseSha ?? mem?.sentBaseSha ?? null;

      if (status === "done") {
        // O cliente recebeu o resultado → para de ser reofertado pelo in-flight para sempre.
        if (db) void markSpecChatJobCollected(pool, jobId);
        // T4.3: devolve filePath/baseSha capturados NO ENVIO → o apply grava no arquivo certo
        // e detecta edição concorrente (o baseSha é o que o usuário via quando pediu a revisão).
        return reply.send({
          jobId, status: "done", specMarkdown, reply: replyText,
          filePath, baseSha, baseSpecSha: db?.baseSpecSha ?? null,
        });
      }
      if (status === "error") {
        if (db) void markSpecChatJobCollected(pool, jobId);
        // Um envelope reprovado pelo enforcer ainda carrega a spec inteira (judgeCtoResult a
        // preserva). Devolvemos junto do MOTIVO: o cliente OFERECE (nunca aplica sozinho) — mesmo
        // contrato do card de revisão recuperada da migração 089. Antes ~20 min de Opus 5 iam
        // para o lixo porque a rota só devolvia a mensagem de erro.
        return reply.send({
          jobId, status: "error", error: errorText,
          specMarkdown: specMarkdown ?? null,
          filePath, baseSha, baseSpecSha: db?.baseSpecSha ?? null,
        });
      }
      const createdMs = db ? new Date(db.createdAt).getTime() : (mem?.createdAt ?? Date.now());
      // Elapsed derivado do `created_at` do BANCO: antes vinha de um `Date.now()` por processo, e
      // cada reattach do frontend recomeçava a contagem (dava 18 min novos a cada volta à tela).
      const elapsed = Math.round((Date.now() - (Number.isFinite(createdMs) ? createdMs : Date.now())) / 1000);
      return reply.send({ jobId, status, elapsed, deadlineAt: db?.deadlineAt ?? null });
    },
  );
}
