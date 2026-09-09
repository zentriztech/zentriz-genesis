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
  recordCtoUsage, recordRawUsage, CHAT_JOB_DEADLINE_MS, FILE_JOB_DEADLINE_MS,
  type SpecChatJobStatus, type SpecChatJobKind,
} from "../services/specChatJobs.js";
import { extractSpecMarkdown, httpPost, httpGet } from "./specs.js";
import { parseSpecPath } from "./specFiles.js";
import type { ValidationFinding } from "../services/specValidation.js";
import { productScopeEnabled, buildProductMap, selectSiblingBodies } from "../services/productContext.js";
import { applySpecEditResponse, looksLikeEdits } from "../services/specFileEdits.js";
import { MANIFEST_PATH } from "../services/specManifest.js";
import { DIAGRAMS_PATH, MIN_DIAGRAMS } from "../services/specDiagrams.js";
// GAP-68: `import type` de propósito — `gapContinuity` importa `httpPost` de `routes/specs.js`, e um
// import de valor fecharia um ciclo entre os dois arquivos de rota no carregamento do módulo.
import type { PersistentGapRef } from "../services/gapContinuity.js";
import { focusFactBlock } from "../services/gapFocus.js";
// 🔴 A1: prestação de contas por GAP — instrução no pedido, leitura vetada na resposta.
import {
  gapOutcomeInstruction, parseGapOutcomes, priorOutcomeFactBlock, summarizeOutcomes,
  // 🔴 GAP-131: a cadeia de vias já tentadas (profundidade > 1).
  attemptHistoryFactBlock, type GapAttemptHistory,
  type GapOutcome,
} from "../services/gapOutcomes.js";
import type { FocusPlan } from "../services/gapFocus.js";
import { loadArchetypeCatalog, type Archetype } from "../services/archetypeCatalog.js";

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

/**
 * F1 (2026-09-05) — o CTO entrega EDIÇÕES (search/replace) em vez da spec inteira.
 *
 * POR QUE A FLAG VIVE AQUI E NÃO NOS AGENTS: é esta função que escreve a regra "Devolva a SPEC
 * INTEIRA revisada" no `task`. Se a decisão do formato morasse no agents, o prompt chegaria ao
 * modelo se contradizendo (a api pedindo o documento inteiro, o agents pedindo só os edits) — e o
 * modelo obedeceria o hábito, reemitindo 98k chars e truncando de novo. Com a flag aqui, a api
 * reescreve a regra e MARCA o pedido (`inputs.edit_format`); o agents é tolerante (materializa os
 * edits quando aparecem, sem flag própria), então api e agents podem ser deployados em qualquer
 * ordem: flag ON com agents velho = o modelo manda edits e o gate de artefato reprova (nada é
 * aplicado); flag OFF com agents novo = nenhum artefato vem como edits e nada muda.
 *
 * Causa que isto ataca: a spec do NVX LastMile tem 98.045 chars e o CTO reemitia o documento
 * inteiro → ~75% dos 64.000 tokens de saída do Opus 5 gastos copiando o que não mudou → corte.
 */
export function ctoEditFormatEnabled(): boolean {
  return (process.env.SPEC_CTO_EDIT_FORMAT ?? "whole").trim().toLowerCase() === "edits";
}

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
  /**
   * T1: a resposta bateu no teto de saída do modelo (`stop_reason=max_tokens`) → a spec revisada
   * está INCOMPLETA. Propagado do `_truncated` do runtime para a UI avisar "não aplique".
   */
  truncated?: boolean;
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
  // F1: quando ON, a regra 4 (e o OBJETIVO) param de pedir o documento inteiro — ver
  // `ctoEditFormatEnabled`. O agents descreve o FORMATO dos edits e materializa o resultado.
  const editMode = ctoEditFormatEnabled();
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
      ? `resolver os GAPs e ENRIQUECER a spec para um produto real, funcional e Connect-compliant, ${
          editMode
            ? "entregando as EDIÇÕES da spec (search/replace, ver o formato adiante)"
            : "devolvendo a spec COMPLETA revisada"
        } e um summary com perguntas/premissas/features.`
      : `aplicar SOMENTE as mudanças que o usuário pediu na última mensagem, ${
          editMode
            ? "entregando as EDIÇÕES da spec (search/replace, ver o formato adiante)"
            : "devolvendo a spec COMPLETA e revisada"
        }, e uma resposta curta explicando o que mudou.`}

REGRAS:
1. ${resolveGaps
      ? "PRESERVE o conteúdo válido existente; você PODE adicionar/expandir seções para enriquecer, mas nunca descarte requisitos válidos."
      : "PRESERVE tudo o que o usuário não pediu para alterar — não regenere a spec do zero."}
2. ${resolveGaps
      ? "Trate os GAPs com profundidade de especialista e sem criar novas inconsistências."
      : "Aplique de forma cirúrgica o que foi pedido na última mensagem (adicionar/remover/ajustar)."}
3. Mantenha a spec consistente e implementável (FRs com critérios de aceite DADO/QUANDO/ENTÃO, modelo de dados, stack).
4. ${editMode
      ? `Devolva APENAS AS EDIÇÕES (search/replace) do artefato Markdown principal — NÃO reescreva o
   documento inteiro. O formato exato dos edits está descrito adiante, na seção "Formato de entrega".
   O servidor aplica as suas edições sobre a spec atual e monta o documento final.
   IMPORTANTE: o artefato principal DEVE ter o caminho EXATO "docs/spec/PRODUCT_SPEC.md"
   (esse é o único path aceito — usar outro caminho REPROVA a revisão e força um retrabalho lento).`
      : `Devolva a SPEC INTEIRA revisada como o artefato Markdown principal (não só o trecho alterado).
   IMPORTANTE: o artefato principal DEVE ter o caminho EXATO "docs/spec/PRODUCT_SPEC.md"
   (esse é o único path aceito — usar outro caminho REPROVA a revisão e força um retrabalho lento).`}
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
      // F1/D1: a DECISÃO do formato nasce aqui (a api monta a regra 4). O agents é tolerante: só
      // descreve o formato dos edits quando vê esta marca e materializa o artefato quando ele vier
      // como `format:"edits"` — logo api e agents podem ser deployados em qualquer ordem.
      edit_format: editMode ? "edits" : undefined,
      constraints: resolveGaps
        ? [
            "resolve-validation-gaps",
            "enrich-to-real-functional-product",
            "connect-compliant-contract",
            editMode ? "return-edits-not-full-spec" : "return-full-revised-spec",
            "no-new-contradictions",
          ]
        : [
            "preserve-unrequested-content",
            "apply-only-requested-changes",
            editMode ? "return-edits-not-full-spec" : "return-full-revised-spec",
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

/** P4: teto do contexto extra (mapa + GAPs) no modo por-arquivo. */
const RAW_FILE_CONTEXT_BUDGET = 12_000;

/**
 * PR-4 (2026-09-05) — ORÇAMENTO DE SAÍDA do `/invoke/raw`, derivado do TAMANHO DO ARQUIVO.
 *
 * Era `max_tokens: 8000` fixo para arquivos de até 20.000 chars. Só para DEVOLVER um arquivo de
 * 20.000 chars de Markdown pt-BR o modelo precisa de ~6.500 tokens — ou seja, o teto ficava a
 * poucas centenas de tokens da borda e qualquer acréscimo pedido pelo humano cortava a resposta.
 * E o corte era SILENCIOSO: `call_bedrock_direct` não expunha `stop_reason`, então a api aplicava o
 * arquivo MUTILADO por cima do bom (a mesma família do truncamento de 64k que este épico ataca).
 *
 * ~2,8 chars/token é o pior caso medido em pt-BR com Markdown; +2.000 tokens de folga cobrem o que
 * o pedido ACRESCENTA. O teto de 32.000 é seguro porque `call_bedrock_direct` passa `timeout`
 * explícito (sem ele o SDK recusa max_tokens > 21.333 — ver `_nonstreaming_timeout_sec`).
 */
export function rawMaxTokensFor(chars: number): number {
  const need = Math.ceil(Math.max(0, chars) / 2.8) + 2_000;
  return Math.min(32_000, Math.max(8_000, need));
}

/**
 * A5.1 (2026-09-06) — orçamento de saída do "Resolver GAPs POR ARQUIVO".
 *
 * MEDIDO EM PROD (run `b3932af7`, rodada 2, `nvx-lastmile-backend.md`): 10.517 chars + 5 GAPs →
 * `rawMaxTokensFor(10.517 + 5×900)` = 8.000 (o PISO da fórmula) → `spec_cto out=8000 TRUNCATED`.
 * A rodada inteira foi descartada pelo guard T1 e o laço autônomo parou como `stalled`: 7.179
 * tokens de entrada + 8.000 de saída pagos para ZERO progresso.
 *
 * POR QUE A FÓRMULA DO CHAT NÃO SERVE AQUI: `rawMaxTokensFor` dimensiona "devolver ESTE arquivo com
 * uma edição humana pequena" (chars/2,8 + 2.000 de folga). O "Resolver GAPs" é o oposto: o arquivo
 * CRESCE por definição — o CTO escreve o requisito/contrato/critério que faltava, com nomes, campos,
 * limites e códigos de erro. A folga de 900 tokens por GAP subestimou isso em prod.
 *
 * POR QUE CONCEDER O MÁXIMO: `max_tokens` é TETO, não gasto — só se paga o que for gerado. A entrada
 * já é limitada a `maxGapFileChars()` (48.000 chars ≈ 17.000 tokens no formato `whole`), então 32.000 permite ~2× de
 * crescimento, que é a forma desta tarefa. E a corrupção continua vetada: `_truncated` recusa a
 * rodada (não mutila o arquivo) e o laço para. Racionar o teto não economizou nada — desperdiçou uma
 * rodada inteira. 32.000 é o teto seguro do caminho (`call_bedrock_direct` recebe `timeout`
 * explícito; sem ele o SDK recusa max_tokens > 21.333).
 */
export const GAP_FILE_MAX_TOKENS = 32_000;

/**
 * Teto de ESPERA do socket, derivado do orçamento concedido. Antes era 180 s fixo — menor que o
 * tempo físico de gerar o que o próprio código pedia (ver `FILE_JOB_DEADLINE_MS`).
 *
 * Piso de 60 tokens/s: conservador contra os 89–115 tokens/s medidos hoje em prod (Opus 5 direto,
 * `project_agent_metrics`), + 30 s de overhead de rede/fallback. Nunca abaixo dos 180 s de antes
 * (nenhuma regressão para arquivos pequenos) e sempre ABAIXO de `FILE_JOB_DEADLINE_MS`, senão o
 * guard do job mataria a espera antes do socket e o erro exibido seria o genérico.
 */
export function rawSocketTimeoutMs(maxTokens: number): number {
  const ms = Math.ceil(Math.max(0, maxTokens) / 60) * 1_000 + 30_000;
  return Math.min(FILE_JOB_DEADLINE_MS - 30_000, Math.max(180_000, ms));
}

/**
 * G7 (lado consumidor) — bloco `cag` do `/invoke/raw`.
 *
 * O endpoint só recupera lições se o CHAMADOR pedir (ele também serve o gate semântico e o
 * planejador de evolução, que não devem mudar de prompt nem pagar tokens por isto). O `project_id`
 * vai como UUID REAL: os agents filtram `project_id = %s::uuid OR project_id IS NULL`, e o
 * pseudo-projeto `"spec_chat"` faria o Postgres estourar → zero lições, em silêncio.
 * `query` é o texto que orienta a busca semântica; `CAG_ENABLED=off` continua vencendo tudo.
 */
function cagBlock(projectId: string | null, query: string): Record<string, unknown> {
  return { cag: { role: "CTO", stack_key: "generic", project_id: projectId, query: query.slice(0, 4_000) } };
}

function buildRawFileRequest(
  content: string,
  messages: ChatMessage[],
  filePath: string,
  /** Fase 1 P4: o chat por-arquivo rodava com contexto ZERO (defeito E) — era o caminho mais cego. */
  ctx: ChatContext = EMPTY_CTX,
  /** Projeto REAL — escopo da recuperação de lições (G7). Ver `cagBlock`. */
  scopeProjectId: string | null = null,
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
    max_tokens: rawMaxTokensFor(content.length),
    // Consulta = o PEDIDO humano (a intenção da rodada) + o arquivo; não a spec inteira.
    ...cagBlock(scopeProjectId, `${lastUser}\n${filePath}`),
  };
}

// ── PR-4: "Resolver GAPs" POR ARQUIVO (F2) ────────────────────────────────────
// Este é o caminho que mata a CAUSA do truncamento de 64k: em vez de mandar o CTO reemitir a spec
// inteira (98k chars → ~75% do orçamento de saída gasto copiando o que não mudou), uma rodada trata
// UM arquivo e só os GAPs daquele arquivo.
//
// POR QUE NÃO PASSA PELO CTO (`spec_intake_and_normalize`): aquele modo é NORMALIZADOR — regenera um
// PRODUCT_SPEC completo e descarta o conteúdo original (ver a nota de RAW_FILE_SYSTEM acima). Mandar
// `tecnico/dados.md` por lá o transformaria numa spec inteira. Aqui o papel é de CTO-EDITOR: o
// mesmo rigor arquitetural do "Resolver GAPs", mas exercido DENTRO do arquivo, preservando o resto.
/**
 * A5.5 (2026-09-06) — a regra que impede o editor de MOVER a contradição em vez de resolvê-la.
 *
 * Medido em prod (run `dd587b75`, passe 1): 21 findings resolvidos e a contagem total SUBINDO de
 * 20 → 24. O par decisivo: "RESOLVIDO 422 vs 400" em `api-entregas-entregadores.md` e, na mesma
 * rodada, "NOVO 400 vs 422" em `definicao-de-pronto.md`. Sem ver o irmão, o editor escolhia um lado
 * e a divergência migrava de arquivo — o laço pagava LLM para andar de lado, para sempre.
 *
 * A regra é o par obrigatório do bloco de irmãos (`services/specSiblingContext.ts`): o código passou
 * a MOSTRAR o irmão citado; esta instrução diz o que fazer com ele. Sem a regra, o irmão no contexto
 * só aumenta a chance de o editor copiar conteúdo alheio para dentro do arquivo.
 */
/**
 * 🔴 GAP-71 (2026-09-07) — a regra que proíbe ANULAR o trecho ofensor em vez de reescrevê-lo.
 *
 * MEDIDO em prod (NVX LastMile, `modelo-dados.md`, run `f101303f`): 4 rodadas aplicadas, 13/7/7/8
 * edições ancoradas, e as MESMAS 11 âncoras nas 6 validações seguintes. O CTO havia criado uma
 * convenção própria — declarar o trecho "errata nula com efeito de remoção" e mandar ler outro
 * requisito (`REQ-CONTACT-01`, `VISIB-ANON-01`, `D-24`) — que aparece **23 vezes** no arquivo. Os
 * literais ofensores continuam no disco, e o juiz, que relê o texto original, escreve no `rationale`:
 * "Duas prescrições executáveis opostas coexistem no mesmo arquivo … A correção é reescrever
 * fisicamente §8.6 (c)".
 *
 * A regra não decide conteúdo: diz como a CORREÇÃO é lida por quem valida. Anulação por errata é
 * exatamente o motor do GAP-8 — o GAP não fecha e o arquivo cresce.
 */
function ANNULMENT_RULE(n: string): string {
  return [
    `${n}) ANULAR NÃO É CORRIGIR: nunca resolva uma contradição acrescentando em outro ponto do arquivo`,
    "   uma errata, nota, requisito, tabela ou REGRA DE SUBSTITUIÇÃO TEXTUAL GLOBAL ('toda redação deste",
    "   arquivo que diga X, leia-se Y') que declare o trecho ofensor 'nulo', 'sem efeito',",
    "   'superado' ou que mande 'ler REQ-X em vez dele'. Quem valida relê o TRECHO ORIGINAL, encontra a",
    "   prescrição antiga ainda lá e reabre o mesmo problema — e o arquivo só cresceu. Corrija NO LUGAR:",
    "   apague a frase/linha/célula que não vale mais, ou substitua o texto dela pela decisão que vale.",
    "   Se o arquivo já tem uma errata sobre o trecho, APLIQUE-A no texto agora e remova a errata.",
  ].join(" ");
}

function DIVERGENCE_RULE(n: string): string {
  return [
    `${n}) DIVERGÊNCIA ENTRE ARQUIVOS: quando o GAP diz que este arquivo contradiz um irmão (dois`,
    "   valores para a mesma regra), o irmão vai no CONTEXTO SÓ-LEITURA abaixo. Adote o valor do",
    "   arquivo que DEFINE o assunto (o contrato de API define código HTTP; o modelo de dados define",
    "   campo e tipo; o glossário define nome) — se quem define é ESTE arquivo, mantenha o seu valor e",
    "   diga na linha final que o irmão precisa acompanhar. NUNCA invente um terceiro valor e NUNCA",
    "   'resolva' apenas aqui de um jeito que deixe o irmão divergente: isso não fecha o GAP, só o move.",
  ].join(" ");
}

const GAP_FILE_SYSTEM = [
  "Você é o CTO/arquiteto responsável pela especificação de um produto de software.",
  "Recebe UM arquivo da especificação e a lista de GAPs (problemas de uma validação adversarial) que",
  "pertencem a ESTE arquivo. Corrija cada GAP com profundidade de especialista: decida o que falta,",
  "escreva o requisito/contrato/critério que resolve o problema e seja concreto (nomes, campos,",
  "limites, códigos de erro) — nunca responda com generalidades ou com um TODO.",
  "REGRAS DE ESCOPO (invioláveis):",
  "1) PRESERVE todo o conteúdo do arquivo que não precisa mudar — você está EDITANDO, não reescrevendo.",
  "2) NÃO renomeie nem reordene seções existentes sem necessidade, e NÃO remova requisito válido.",
  "3) NÃO traga para este arquivo o conteúdo de arquivos irmãos (o contexto é só leitura).",
  "4) Se um GAP claramente não é deste arquivo, deixe-o como está e explique na última linha.",
  DIVERGENCE_RULE("5"),
  ANNULMENT_RULE("6"),
  "Devolva SOMENTE o conteúdo final COMPLETO do arquivo, sem cercas de código e sem preâmbulo.",
].join(" ");

/**
 * A5.2 (2026-09-06) — o MESMO papel do GAP_FILE_SYSTEM, mas entregando EDIÇÕES em vez do arquivo.
 *
 * Medido em prod: `privacidade-lgpd.md` (~47k chars, 9 GAPs) estourou os 32.000 tokens de saída
 * QUATRO vezes (69.058 chars gerados e ainda incompleto) porque o formato "arquivo inteiro" faz o
 * custo de saída crescer com o TAMANHO DO ARQUIVO em vez do tamanho da correção. Ver
 * `services/specFileEdits.ts` para a análise completa e para o veto de corrupção.
 *
 * As regras de escopo são as mesmas — só o CANAL de entrega muda. A instrução de ancoragem é
 * explícita porque o único jeito de este formato falhar é âncora inexistente ou ambígua, e é isso
 * que o aplicador recusa.
 */
const GAP_FILE_EDITS_SYSTEM = [
  "Você é o CTO/arquiteto responsável pela especificação de um produto de software.",
  "Recebe UM arquivo da especificação e a lista de GAPs (problemas de uma validação adversarial) que",
  "pertencem a ESTE arquivo. Corrija cada GAP com profundidade de especialista: decida o que falta,",
  "escreva o requisito/contrato/critério que resolve o problema e seja concreto (nomes, campos,",
  "limites, códigos de erro) — nunca responda com generalidades ou com um TODO.",
  "FORMATO DA RESPOSTA (obrigatório): NÃO reemita o arquivo. Devolva APENAS blocos de edição, assim:",
  "<<<<<<< SEARCH",
  "(trecho EXATO e literal do arquivo atual, copiado caractere por caractere)",
  "=======",
  "(o trecho já corrigido, que substitui o de cima)",
  ">>>>>>> REPLACE",
  "REGRAS DOS BLOCOS (invioláveis):",
  "1) O trecho em SEARCH precisa existir LITERALMENTE no arquivo e ser ÚNICO — inclua linhas de",
  "   contexto (o cabeçalho da seção, por exemplo) até que só case em um lugar.",
  "2) Para ACRESCENTAR conteúdo novo, use como SEARCH a última linha existente do ponto de inserção e",
  "   repita-a no REPLACE seguida do conteúdo novo. Nunca use SEARCH vazio.",
  "3) Um bloco por edição; quantos blocos precisar. Ordene-os de cima para baixo no arquivo.",
  "4) NÃO renomeie nem reordene seções existentes sem necessidade, e NÃO remova requisito válido.",
  "5) NÃO traga para este arquivo o conteúdo de arquivos irmãos (o contexto é só leitura).",
  "6) Se um GAP claramente não é deste arquivo, não invente edição para ele.",
  // GAP-65: sem esta regra o agente não tem COMO apagar um `=======` residual (a linha que ele
  // copiaria no SEARCH era lida como o separador do bloco) e o blocker de corrupção nunca fecha.
  "7) Se o trecho a corrigir contém uma linha formada só por `=`, `<` ou `>` (resíduo de conflito de",
  "   merge no arquivo), COPIE essa linha normalmente dentro do SEARCH e omita-a no REPLACE: assim ela",
  "   é apagada. O separador do bloco é sempre o ÚLTIMO `=======` do bloco, então marcadores que vêm",
  "   antes dele são lidos como texto do arquivo. Nunca escreva um marcador no lado REPLACE.",
  DIVERGENCE_RULE("8"),
  ANNULMENT_RULE("9"),
  "Fora dos blocos, escreva no máximo uma linha final de observação. Nada de preâmbulo.",
].join(" ");

/**
 * A5.2 — canal de entrega do "Resolver GAPs por arquivo".
 *
 * Default `edits` porque o formato `whole` está PROVADO insuficiente para arquivo grande (4/4
 * falhas em prod). `SPEC_GAP_FILE_EDIT_FORMAT=whole` restaura o comportamento anterior sem deploy —
 * é o rollback de comportamento, separado da flag do CTO da spec inteira (`SPEC_CTO_EDIT_FORMAT`),
 * que rege OUTRO caminho (`/invoke/cto/async`) e tem outro aplicador (nos agents).
 */
export function gapFileEditsEnabled(): boolean {
  return (process.env.SPEC_GAP_FILE_EDIT_FORMAT ?? "edits").trim().toLowerCase() !== "whole";
}

/**
 * Teto de conteúdo do "Resolver GAPs por arquivo".
 *
 * No formato `whole` o teto de ENTRADA existia para a SAÍDA caber no orçamento (o arquivo voltava
 * inteiro) — daí 48.000. No formato `edits` a saída não é mais proporcional ao arquivo, então o
 * limite passa a ser só a janela de contexto: 120.000 chars ≈ 43.000 tokens de entrada, folgado
 * dentro dos 200k, e destrava arquivos que hoje o laço recusa com FILE_TOO_LARGE sem ter como
 * dividi-los sozinho.
 */
export function maxGapFileChars(): number {
  return gapFileEditsEnabled() ? 120_000 : 48_000;
}

/**
 * A5.5 — kill-switch do bloco de irmãos citados. Nasce LIGADA porque o comportamento sem ela está
 * PROVADO insuficiente (a contradição migra de arquivo); `SPEC_GAP_SIBLING_CONTEXT=off` volta ao
 * comportamento anterior sem deploy, se o custo de entrada incomodar.
 */
export function gapSiblingContextEnabled(): boolean {
  return (process.env.SPEC_GAP_SIBLING_CONTEXT ?? "on").trim().toLowerCase() !== "off";
}

/**
 * A1: a lista vai NUMERADA porque o número é a chave do desfecho que o agente devolve
 * (`gapOutcomes`). Sem numeração, a prestação de contas só poderia referenciar o GAP pelo título —
 * e casar título por semelhança de texto é exatamente a automação fixa que a Lei proíbe.
 */
function fmtGapForFile(f: ValidationFinding, i: number): string {
  const sev = (f.severity || "info").toUpperCase();
  const anchor = (f as { anchor?: string | null }).anchor;
  const loc = anchor ? ` (em: ${anchor})` : f.line ? ` (linha ~${f.line})` : "";
  return `${i + 1}) [${sev}]${loc} ${f.title}${f.rationale ? `\n   motivo: ${f.rationale}` : ""}`;
}

/**
 * Pedido de "Resolver GAPs" escopado em UM arquivo. `findings` são os GAPs ATIVOS já atribuídos a
 * este arquivo (specGapScope) — o modelo não escolhe o que é seu, só resolve o que é.
 */
/**
 * GAP-14 — o bloco de FATOS do manifesto, só quando o arquivo em edição é o `README.md` da raiz.
 *
 * Vazio para qualquer outro arquivo (é o comportamento anterior). Não diz o que escrever: diz o que a
 * fábrica lê no frontmatter e qual é o catálogo fechado de arquétipos — as MESMAS regras que o
 * Estágio A reaplica na validação seguinte e que `assessManifest` veta na escrita.
 */
export function manifestFactBlock(filePath: string): string {
  if (filePath.trim().toLowerCase() !== MANIFEST_PATH.toLowerCase()) return "";
  const ids = loadArchetypeCatalog().archetypes.map((a) => a.id).join(", ");
  return [
    "--- FATOS DO MANIFESTO (este arquivo é o README.md do projeto — leia antes de editar) ---",
    "O bloco YAML de abertura é CONTRATO DE MÁQUINA: a fábrica o lê para rotear o projeto.",
    `• \`archetype\` só pode ser um destes: ${ids}. Valor fora da lista é BLOQUEADOR de validação.`,
    "• Mantenha o `archetype` atual — corrigi-lo não é um GAP deste arquivo.",
    "• NÃO acrescente `spec_hash` nem `status_spec`: estado vive no banco, não no documento.",
    "• O `---` de abertura continua sendo a PRIMEIRA linha do arquivo.",
    "--- FIM DOS FATOS DO MANIFESTO ---",
    "",
  ].join("\n");
}

/**
 * 🔴 GAP-122 — FATOS DO ÍNDICE para quando o arquivo em edição é o manifesto: a árvore ATUAL da spec e,
 * dela, o que este README não cita. Vazio para qualquer outro arquivo (ou se a árvore não puder ser
 * lida — o laço não afirma o que não mediu).
 *
 * Existe porque `arquitetura-modelo.md` foi criado e ficou fora do índice, inclusive depois de o chat
 * REESCREVER o README: o pedido de edição entregava o catálogo de arquétipos e as regras do frontmatter,
 * mas não a árvore, então "existe um arquivo novo" era informação que o editor não tinha.
 */
async function gapIndexBlock(projectId: string, filePath: string, fileContent: string): Promise<string> {
  if (filePath.trim().toLowerCase() !== MANIFEST_PATH.toLowerCase()) return "";
  try {
    const [{ loadSpecFiles }, { unindexedFiles, indexCoverageFactBlock }] = await Promise.all([
      import("../services/specGapScope.js"),
      import("../services/specIndexCoverage.js"),
    ]);
    const files = await loadSpecFiles(pool, projectId);
    if (files.length < 2) return ""; // spec de arquivo único não tem índice a cobrar
    const paths = files.map((f) => f.path);
    const orphans = unindexedFiles(fileContent, paths);
    const block = indexCoverageFactBlock(paths, orphans);
    console.log(
      `[SpecChat] fatos do índice entregues projeto=${projectId.slice(0, 8)} arquivos=${paths.length}`
      + ` fora_do_indice=${orphans.length}${orphans.length ? ` [${orphans.join(", ")}]` : ""} chars=${block.length}`,
    );
    return block;
  } catch (e) {
    console.warn(`[SpecChat] fatos do índice indisponíveis (segue sem eles): ${(e as Error).message}`);
    return "";
  }
}

function buildGapFileRequest(
  content: string,
  filePath: string,
  findings: ValidationFinding[],
  ctx: ChatContext = EMPTY_CTX,
  /** Projeto REAL — escopo da recuperação de lições (G7). Ver `cagBlock`. */
  scopeProjectId: string | null = null,
  /** A5.5: irmãos CITADOS pelos GAPs, só leitura. Vazio = comportamento anterior. */
  siblingBlock = "",
  /**
   * A5.7/GAP-7: `content` é um RECORTE do arquivo (arquivo acima do teto de entrada), não o arquivo
   * inteiro. Anunciar isso é obrigatório: um modelo que pensa estar vendo o arquivo todo conclui que
   * a seção ausente não existe e a recria — troca um GAP por uma contradição interna.
   */
  digested = false,
  /**
   * GAP-22: FATOS do registro de oráculos (quem é a fonte única de cada contrato em disputa). Vazio =
   * este arquivo não tem papel em nenhum contrato decidido (ou a flag está desligada).
   */
  oracleBlock = "",
  /**
   * GAP-29: a tentativa ANTERIOR neste arquivo foi descartada por estourar a margem — e por quanto.
   * Vazio = primeira tentativa (ou recusa de outra natureza). Sem isto o laço repete, ao preço cheio
   * de Opus 5, uma resposta que ele já sabe que vai recusar.
   */
  priorRejectionBlock = "",
  /**
   * 🔴 GAP-68: destes GAPs, quais já foram entregues antes e sobreviveram à edição. Vazio = nenhum
   * reincidente conhecido (ou a reconciliação do GAP-67 não rodou — e aí o laço não afirma nada).
   */
  persistentGapBlock = "",
  /**
   * 🔴 GAP-81: a rodada é DEDICADA e a lista de GAPs abaixo está restrita. Vazio = rodada normal (todos
   * os GAPs do arquivo). Entregar a lista curta SEM este bloco seria pior que não focar: o modelo leria
   * "o arquivo só tem estes defeitos" e removeria como redundante o que ficou de fora.
   */
  focusBlock = "",
  /**
   * 🔴 A1: o que o agente DECLAROU sobre estes GAPs na rodada anterior deste arquivo (o que tentou,
   * o que faltou, o argumento de "não é defeito" que o juiz não aceitou). Vazio = primeira rodada do
   * arquivo, ou nenhum desfecho relevante. Ver `priorOutcomeFactBlock`.
   */
  priorOutcomeBlock = "",
  /**
   * 🔴 GAP-121: esta rodada é de CONSOLIDAÇÃO PURA — o laço mediu que NÃO há margem de crescimento para
   * este arquivo, então o pedido é só REMOVER redeclaração (delta ≤ 0). Vazio = rodada normal.
   *
   * Quando presente, o pedido muda de natureza e três coisas mudam junto, ou o pedido fica incoerente:
   * o rótulo da lista de GAPs (eles são CONTEXTO do que remover, não a tarefa), a prestação de contas
   * por GAP (pedir desfecho de GAP que não se pediu para consertar produziria `nao_declarado` em massa,
   * e pelo A1 isso é dívida do agente) e a instrução final ("resolva TODOS os GAPs" seria justamente o
   * crescimento que o veto vai descartar).
   */
  consolidationBlock = "",
  /**
   * 🔴 GAP-122: a árvore ATUAL da spec e o que o índice deste README não cita. Só o manifesto recebe
   * (ver `gapIndexBlock`); vazio = outro arquivo, ou árvore não medida.
   */
  indexBlock = "",
  /**
   * 🔴 GAP-131: a cadeia de vias que o agente JÁ TENTOU nestes GAPs (2+ tentativas), do próprio relato
   * dele. Vazio = nenhum GAP desta leva tem histórico com mais de uma tentativa. Vem no fim da lista de
   * parâmetros de propósito: é fato de ROTA, e a ordem no prompt é decidida no array abaixo.
   */
  attemptHistoryBlock = "",
): Record<string, unknown> {
  // A1: o corte do orçamento é DECLARADO. Antes, a lista era fatiada no meio de um item e o modelo
  // recebia um GAP pela metade sem saber que havia mais — e com a prestação de contas por número, um
  // item invisível voltaria como `nao_declarado` sem ninguém saber por quê. Corta por ITEM INTEIRO.
  const gapsAll = findings.map(fmtGapForFile);
  const gapsFit: string[] = [];
  let gapsLen = 0;
  for (const g of gapsAll) {
    if (gapsLen + g.length + 1 > FINDINGS_BUDGET) break;
    gapsFit.push(g);
    gapsLen += g.length + 1;
  }
  const gapsOmitted = gapsAll.length - gapsFit.length;
  const gaps = gapsFit.join("\n")
    + (gapsOmitted > 0
      ? `\n…(${gapsOmitted} GAP(s) deste arquivo NÃO couberam nesta rodada e continuam ATIVOS — não os declare)…`
      : "");
  const edits = gapFileEditsEnabled();
  // Mapa do produto (Fase 1) como contexto só-leitura: o arquivo é uma PARTE de um todo, e sem saber
  // onde ele vive o CTO-editor duplica o que já está no irmão.
  const contextBlock = (ctx.productMapBlock ?? "").slice(0, RAW_FILE_CONTEXT_BUDGET);
  const userMessage = [
    `ARQUIVO: ${filePath}`,
    "",
    contextBlock
      ? `--- CONTEXTO SÓ-LEITURA (onde este arquivo vive; NÃO o copie para o arquivo) ---\n${contextBlock}\n--- FIM DO CONTEXTO ---\n`
      : "",
    // A5.5: vem ANTES do conteúdo a editar de propósito — quando o editor chegar ao arquivo alvo já
    // sabe o que o irmão define, e a última coisa que lê antes de gerar é o pedido, não o irmão.
    siblingBlock
      ? `--- ARQUIVOS IRMÃOS CITADOS PELOS GAPs (SÓ LEITURA — não os copie, não os edite) ---\n${siblingBlock}\n--- FIM DOS IRMÃOS ---\n`
      : "",
    // GAP-22: vem DEPOIS dos irmãos e ANTES do conteúdo porque é o que resolve o que o irmão só
    // expõe: saber que o outro arquivo diz 400 não basta se a cada rodada se re-decide quem manda.
    oracleBlock,
    // GAP-14: quando o arquivo em edição É o manifesto, o frontmatter deixa de ser prosa — é o
    // contrato que a fábrica LÊ para rotear o projeto. Em prod o editor trocou `archetype` por
    // `backend_api` (fora do catálogo) e rebaixou a spec a BLOCKER estrutural. O código não escolhe o
    // conteúdo: entrega o FATO (o catálogo fechado) para a decisão do agente ser informada.
    manifestFactBlock(filePath),
    // 🔴 GAP-122: colado nos fatos do manifesto porque é da mesma natureza (o que a máquina lê e o que
    // o índice precisa cobrir) e vem ANTES do conteúdo: o editor chega ao README já sabendo quais
    // arquivos existem hoje, em vez de indexar de memória a árvore de quando o arquivo foi escrito.
    indexBlock,
    digested
      ? "--- RECORTE DIRIGIDO DO ARQUIVO (NÃO é o arquivo inteiro; leia as REGRAS dentro do bloco) ---"
      : "--- CONTEÚDO ATUAL DO ARQUIVO ---",
    content,
    digested ? "--- FIM DO RECORTE ---" : "--- FIM DO CONTEÚDO ---",
    "",
    // 🔴 GAP-81: o aviso da rodada dedicada vem COLADO na lista, e antes dela — é o enquadramento da
    // lista, não uma observação geral. O rótulo muda junto: "GAPs deste arquivo" seria falso quando a
    // lista está restrita, e a falsidade no rótulo é o que faria o modelo consolidar o que ficou fora.
    focusBlock,
    // 🔴 GAP-121: na consolidação pura o aviso vem ANTES da lista pelo mesmo motivo do GAP-81 — é o
    // enquadramento dela. E o rótulo muda: "GAPs A RESOLVER" seria um pedido que o veto de consolidação
    // vai descartar por tamanho, e o agente gastaria a rodada obedecendo ao rótulo errado.
    consolidationBlock,
    consolidationBlock
      ? `--- GAPs ABERTOS DESTE ARQUIVO (${findings.length} — CONTEXTO desta rodada, NÃO a tarefa; seguem ATIVOS) ---`
      : focusBlock
        ? `--- GAPs A RESOLVER NESTA RODADA (${findings.length} — lista RESTRINGIDA; o arquivo tem outros) ---`
        : `--- GAPs A RESOLVER NESTE ARQUIVO (${findings.length}) ---`,
    gaps,
    "--- FIM DOS GAPs ---",
    "",
    // GAP-68: vem COLADO na lista de GAPs porque é uma qualificação dela — diz quais daqueles itens
    // não são novidade. Longe da lista, o modelo lê como advertência genérica e não liga ao item.
    persistentGapBlock,
    // GAP-29: vem por ÚLTIMO, antes só da instrução de formato, porque é a correção de rota — o
    // modelo lê o pedido inteiro e só então descobre que a resposta óbvia já foi reprovada.
    priorRejectionBlock,
    // 🔴 A1: o relato que o PRÓPRIO agente deu destes GAPs na rodada anterior deste arquivo. Vem
    // depois da recusa por tamanho porque é da mesma natureza (correção de rota) e mais específico:
    // não diz "sua resposta era grande", diz "você mesmo disse que não conseguiu, e por quê".
    priorOutcomeBlock,
    // 🔴 GAP-131: colado no relato da rodada anterior porque é o MESMO fato com profundidade — o relato
    // diz "a última via falhou", este diz "estas N já falharam". Medido em prod: o mesmo GAP declarado
    // `corrigido` 8× seguidas, porque o agente só via a última tentativa e podia voltar a uma anterior.
    attemptHistoryBlock,
    // 🔴 A1: o contrato de prestação de contas fecha o pedido, colado na instrução de formato — as
    // duas coisas que o modelo tem de produzir ficam juntas, e o número que ele declara é o da lista
    // que acabou de ler. `gapsFit.length` (não `findings.length`): pedir desfecho de um GAP que o
    // orçamento cortou seria pedir declaração sobre o que ele não viu.
    // 🔴 GAP-121: na consolidação pura NÃO se pede prestação de contas por GAP. Pelo A1 o desfecho
    // ausente é dívida do agente; cobrar desfecho de conserto que esta rodada não pediu produziria uma
    // leva inteira de `nao_declarado` — o laço registraria como omissão do agente o que foi decisão do
    // próprio laço.
    consolidationBlock ? "" : gapOutcomeInstruction(gapsFit.length),
    consolidationBlock
      ? (edits
        ? "Devolva agora SOMENTE os blocos <<<<<<< SEARCH / ======= / >>>>>>> REPLACE que REMOVEM a"
          + " redeclaração, deixando no lugar a citação do arquivo-oráculo. O arquivo tem de ENCOLHER"
          + " nesta rodada. Não reemita o arquivo e não acrescente texto novo além da citação."
        : "Devolva agora o conteúdo final completo do arquivo APENAS com as redeclarações removidas e"
          + " substituídas pela citação do arquivo-oráculo. O arquivo tem de ENCOLHER nesta rodada.")
      : edits
        // A instrução final repete o formato porque é a última coisa que o modelo lê antes de gerar —
        // e o hábito de reemitir o documento inteiro é justamente o que causou 4 truncamentos em prod.
        ? "Resolva TODOS os GAPs acima e devolva agora SOMENTE os blocos <<<<<<< SEARCH / ======= / >>>>>>> REPLACE. Não reemita o arquivo."
        : "Resolva TODOS os GAPs acima editando o arquivo e devolva agora o conteúdo final completo dele.",
  ].join("\n");
  return {
    prompt_override: edits ? GAP_FILE_EDITS_SYSTEM : GAP_FILE_SYSTEM,
    user_message: userMessage,
    // A saída CRESCE (o arquivo ganha o que faltava) — e o teto derivado do tamanho reprovou a
    // rodada 2 em prod com `out=8000 TRUNCATED`. Ver `GAP_FILE_MAX_TOKENS` (teto ≠ gasto).
    max_tokens: GAP_FILE_MAX_TOKENS,
    // Consulta = os GAPs a resolver; é o que define de que lição esta rodada precisa.
    ...cagBlock(scopeProjectId, `${filePath}\n${gaps}`),
  };
}

/**
 * A5.5 — carrega os irmãos que os GAPs deste arquivo CITAM, para o bloco só-leitura.
 *
 * Best-effort de propósito: é contexto que melhora a decisão, não pré-condição. Se o banco ou o disco
 * falharem, a rodada segue como antes (com o defeito conhecido) em vez de não acontecer. Os dois
 * chamadores — o botão humano e o laço autônomo — passam por aqui para não divergirem.
 */
/**
 * A5.7/GAP-7 — recorte do arquivo ALVO quando ele passou do teto de entrada.
 *
 * Só existe no formato `edits`: lá a saída é proporcional à CORREÇÃO, então ler um recorte verbatim
 * basta para montar `SEARCH/REPLACE` válidos. No formato `whole` o modelo devolveria o "arquivo
 * inteiro" a partir de um recorte — arquivo mutilado — e o teto continua valendo.
 *
 * Diferente do bloco de irmãos, este NÃO é best-effort: se o recorte falhar, a rodada tem de falhar
 * (mandar o arquivo cortado sem o aviso e sem o sumário é o cenário que corrompe a spec).
 */
async function gapFileTargetContent(
  filePath: string,
  content: string,
  findings: ValidationFinding[],
): Promise<{ text: string; digested: boolean } | { tooLarge: true; cap: number }> {
  const cap = maxGapFileChars();
  if (content.length <= cap) return { text: content, digested: false };
  if (!gapFileEditsEnabled()) return { tooLarge: true, cap };
  const { buildFileDigest } = await import("../services/specFileDigest.js");
  const d = buildFileDigest(filePath, content, findings, cap);
  // 🔴 GAP-72: a contagem que importa é a ANCORADA — "7/57 seções" parecia saudável enquanto 8 dos 11
  // GAPs despachados apontavam seção que o CTO não recebeu. Sem este número no log, o defeito é invisível.
  console.log(
    `[SpecChat] alvo recortado ${filePath}: ${content.length} chars > teto ${cap} → resumo dirigido de ` +
    `${d.text.length} chars (${d.used}/${d.total} seções; ancoradas ${d.anchored}/${d.anchorsLocated}` +
    `${d.anchorsDropped.length > 0 ? `, FORA por orçamento: ${d.anchorsDropped.join(", ")}` : ""}` +
    `${d.anchorsUnlocatable.length > 0 ? `, não endereçáveis: ${d.anchorsUnlocatable.join(", ")}` : ""}` +
    // 🔴 GAP-73: a âncora sozinha não fecha o GAP quando o literal ofensor mora em OUTRA seção citada
    // no rationale. Este par é o que diz se a outra ponta da contradição chegou ao prompt.
    `; citadas ${d.cited}/${d.citedLocated}` +
    `${d.citedDropped.length > 0 ? `, FORA por orçamento: ${d.citedDropped.join(", ")}` : ""}` +
    // 🔴 GAP-74: seção grande demais para caber inteira (medido: `§7.4`, 16.399 chars) vinha como
    // "FORA por orçamento" duas rodadas seguidas e travava 2 dos 4 GAPs que não fechavam. `janelas`
    // separa "não veio" de "veio recortada" — sem isso o log não distingue os dois casos.
    `${d.windowed > 0 ? `; janelas ${d.windowed}: ${[...d.anchorsWindowed, ...d.citedWindowed].join(", ")}` : ""})`,
  );
  return { text: d.text, digested: d.digested };
}

async function gapSiblingBlock(
  projectId: string,
  filePath: string,
  findings: ValidationFinding[],
): Promise<string> {
  if (!gapSiblingContextEnabled()) return "";
  try {
    const [{ loadSpecFiles }, { buildSiblingContext }] = await Promise.all([
      import("../services/specGapScope.js"),
      import("../services/specSiblingContext.js"),
    ]);
    const files = await loadSpecFiles(pool, projectId);
    if (files.length < 2) return ""; // spec de arquivo único não tem irmão a citar
    const { block, used, omitted, citedUsed, citedDropped, citedWindowed } =
      await buildSiblingContext(files, filePath, findings);
    if (used.length || omitted.length) {
      console.log(
        `[SpecChat] irmãos citados projeto=${projectId.slice(0, 8)} alvo=${filePath} usados=[${used.join(", ")}]`
        + `${omitted.length ? ` fora_do_orcamento=[${omitted.join(", ")}]` : ""} chars=${block.length}`
        // 🔴 GAP-75: 14 de 20 GAPs deste projeto são cross-file, e 7 das 14 seções de irmão citadas
        // NUNCA chegavam ao prompt (127 a 3.214 chars, com o bloco em 49k de 60k — era ORDEM). Sem este
        // par no log, a diferença entre "o irmão veio" e "o trecho do irmão veio" fica invisível.
        + `; seções citadas ${citedUsed.length}/${citedUsed.length + citedDropped.length}`
        + `${citedWindowed.length ? ` (janelas: ${citedWindowed.join(", ")})` : ""}`
        + `${citedDropped.length ? ` FORA: ${citedDropped.join(", ")}` : ""}`,
      );
    }
    return block;
  } catch (e) {
    console.warn(`[SpecChat] contexto de irmãos indisponível (segue sem ele): ${(e as Error).message}`);
    return "";
  }
}

/**
 * GAP-22 — FATOS do registro de oráculos para o arquivo em edição.
 *
 * Só LÊ o que já foi decidido: quem decide é `ensureOracleDecisions` (um agente), acionado pelo laço
 * autônomo antes de despachar a rodada. O botão humano, por isso, aproveita as decisões existentes mas
 * não paga uma decisão nova — clicar em "Resolver GAPs" não deve disparar uma segunda chamada de LLM
 * pelas costas do usuário.
 *
 * Best-effort: sem registro (ou com a flag desligada) a rodada segue como antes.
 */
async function gapOracleBlock(
  projectId: string, filePath: string, fileChars?: number, growthBudget?: number,
): Promise<string> {
  try {
    const { loadOracleDecisions, oracleFactBlock, oracleRegistryEnabled } = await import("../services/specOracles.js");
    if (!oracleRegistryEnabled()) return "";
    const decisions = await loadOracleDecisions(pool, projectId);
    if (decisions.length === 0) return "";
    // GAP-25: `fileChars` é o tamanho do arquivo INTEIRO (não do recorte) — o veto compara arquivo
    // inteiro contra arquivo inteiro, então o número anunciado tem de ser o mesmo que será julgado.
    // GAP-28: `growthBudget` é o que SOBROU do orçamento deste passe (só o laço sabe). Ausente no
    // botão humano — ali o bloco cai no orçamento cheio, que é o que aquele caminho de fato enfrenta.
    const block = oracleFactBlock(decisions, filePath, fileChars, growthBudget);
    if (block) {
      console.log(`[SpecChat] oráculos aplicados projeto=${projectId.slice(0, 8)} alvo=${filePath} contratos=${decisions.length} chars=${block.length}`);
    }
    return block;
  } catch (e) {
    console.warn(`[SpecChat] registro de oráculos indisponível (segue sem ele): ${(e as Error).message}`);
    return "";
  }
}

/**
 * GAP-29 — o FATO da tentativa anterior descartada, para a retentativa não ser uma repetição paga.
 *
 * MEDIDO na run `d7acccb8` (NVX LastMile): `autenticacao-sessao.md` foi descartado três vezes
 * entregando +2.661, +2.740 e +2.740 caracteres contra margens de 580 e 1.143 — o pedido era
 * IDÊNTICO nas três, porque nada dizia ao agente que a tentativa anterior tinha existido. Aqui o
 * código só transporta o número; a estratégia (consolidar primeiro, entregar em partes, ou insistir
 * porque o acréscimo é indispensável) é decisão do agente.
 *
 * GAP-31 — o veto que descarta a rodada tem DUAS causas (estourar a margem do passe **ou** não
 * consolidar nada: nem citar o oráculo nem encolher). A primeira versão deste bloco falava sempre em
 * tamanho, então uma recusa por "não consolidou" com delta pequeno viraria "você entregou +50
 * caracteres contra margem de 2.000" — números certos, causa errada, e o agente sairia encolhendo o
 * arquivo em vez de citar o oráculo. Agora o MOTIVO registrado pelo laço vai literal, e a orientação
 * de "pagar o crescimento removendo redeclaração" só aparece quando a recusa foi de fato por margem.
 */
export function priorRejectionFactBlock(
  prior: { delta: number; budget: number; pass: number; reason?: string | null } | null | undefined,
): string {
  if (!prior) return "";
  const reason = prior.reason?.trim();
  // Sem motivo gravado (rodada anterior ao GAP-31), só o número positivo é fato interpretável.
  if (!reason && prior.delta <= 0) return "";
  const overBudget = prior.delta > prior.budget;
  const sign = prior.delta >= 0 ? "+" : "";
  const lines = [
    "--- TENTATIVA ANTERIOR NESTE ARQUIVO (fato registrado pelo laço) ---",
    `No passe ${prior.pass} a sua revisão deste arquivo foi DESCARTADA INTEIRA. Ela entregou`
    + ` ${sign}${prior.delta} caracteres e a margem de crescimento que o passe tinha era ${prior.budget}.`
    + " Nada dela foi salvo — o conteúdo acima é o de ANTES dela e os GAPs seguem abertos.",
  ];
  if (reason) lines.push(`MOTIVO EXATO registrado pelo laço: ${reason}`);
  lines.push(
    overBudget
      ? "NÃO repita a mesma tentativa: entregar de novo um crescimento desse tamanho gasta a rodada e não"
        + " fecha GAP nenhum. Se o conserto exige texto novo, PAGUE-O removendo as redeclarações que o"
        + " bloco de fonte única aponta; se ainda não couber, resolva nesta rodada os GAPs que CABEM na"
        + " margem, deixando o arquivo coerente, e deixe os demais para a próxima — GAP fechado em parte é"
        + " progresso, rodada descartada não é."
      : "NÃO repita a mesma tentativa: ela já foi recusada pelo motivo acima. Ataque o motivo — se o que"
        + " falta é apontar a fonte única, cite o caminho do arquivo-oráculo no lugar da redeclaração e"
        + " remova o texto redundante; entregar o mesmo conteúdo de novo gasta a rodada sem fechar GAP.",
    "--- FIM DA TENTATIVA ANTERIOR ---",
  );
  return lines.join("\n");
}

/**
 * 🔴 GAP-121 — o FATO de que esta rodada pede SÓ REMOÇÃO, porque não há margem para o arquivo crescer.
 *
 * MEDIDO em prod 2026-09-08 (NVX LastMile, run `3660bcf2`): a margem anunciada caiu 2.000 → 1.095 →
 * 216 → **0** e ficou em 0 pelas rodadas 4 a 12; **9 das 24 rodadas não escreveram nada**, sempre nos
 * MESMOS 4–5 arquivos que redeclaram contrato de oráculo. O agente não é o problema — ele reduziu o
 * próprio delta de +2.547 para +324 entre passes. O problema é o PEDIDO: "conserte estes N GAPs **e**
 * consolide as redeclarações" cresce antes de encolher, e o veto do GAP-22 julga o delta LÍQUIDO
 * tudo-ou-nada ⇒ a rodada inteira é descartada e os GAPs voltam idênticos no passe seguinte (47 → 48).
 *
 * A cura é de ORDEM, não de teto: subir o teto reabriria o GAP-8 (a spec só crescia) e ratear o
 * orçamento entre 12 arquivos daria ~167 chars por arquivo, menos do que uma errata precisa — ninguém
 * escreveria. Então, quando a aritmética diz que não cabe, pede-se PRIMEIRO só a remoção: delta ≤ 0
 * passa o veto, é aplicada, e o encolhimento credita `growthAllowance` (`runGrowthUsed` soma os deltas
 * aplicados) financiando a errata na rodada seguinte.
 *
 * O bloco não escolhe o que remover nem o que citar — isso é decisão do agente (Lei: 100% LLM). Ele
 * entrega os dois fatos que o agente não podia deduzir do texto que recebe: quantos contratos deste
 * arquivo têm oráculo em outro lugar, e que a margem de hoje não paga texto novo. E diz explicitamente
 * que os GAPs seguem ATIVOS: sem isso o modelo leria a lista como "resolvido por omissão" e, pior,
 * poderia apagar a seção do GAP para "fechá-lo" encolhendo — perda de spec disfarçada de progresso.
 */
export function consolidationOnlyFactBlock(
  info: { reason: string; affordable: number; restates: number; shrinkFloor?: number } | null | undefined,
): string {
  if (!info) return "";
  return [
    "--- ESTA RODADA É DE CONSOLIDAÇÃO PURA (decisão do laço, com o motivo medido) ---",
    `O laço mediu que ${info.restates} contrato(s) reafirmado(s) neste arquivo têm fonte única em OUTRO`
    + ` arquivo (o bloco de fonte única acima diz quais) e que ${info.reason}.`,
    "Por isso o pedido de HOJE é só um: REMOVER a redeclaração e deixar no lugar a citação do"
    + " arquivo-oráculo. O arquivo tem de ENCOLHER — uma rodada que entregue crescimento será"
    + " DESCARTADA INTEIRA pelo veto de consolidação, como já aconteceu com este arquivo.",
    "Os GAPs listados abaixo NÃO são a tarefa desta rodada: eles seguem ATIVOS e o laço NÃO os cobrará"
    + " de você agora. Não os declare como resolvidos e, sobretudo, NÃO apague a seção que um GAP"
    + " aponta para fazer o arquivo encolher — remover o assunto não é consertar o defeito. Eles estão"
    + " aqui como CONTEXTO: mostram onde o texto vai precisar de espaço, e é esse espaço que a remoção"
    + " de hoje abre.",
    "O que você encolher agora vira margem de crescimento nas próximas rodadas deste laço — é assim que"
    + " a errata que falta passa a caber.",
    // O laço veta perda de spec acima de 30% do arquivo (`MIN_SHRINK_RATIO`) e nesse caso NADA é escrito.
    // O piso é fato, não conselho: sem ele, "encolha" convida ao corte que mata a própria rodada.
    typeof info.shrinkFloor === "number" && info.shrinkFloor > 0
      ? `LIMITE: o arquivo não pode terminar esta rodada com menos de ${info.shrinkFloor} caracteres — o`
        + " laço trata perda maior que isso como spec destruída, VETA a rodada e nada é escrito. Se houver"
        + " mais redeclaração do que cabe neste corte, remova a parte que couber e deixe o resto para a"
        + " próxima rodada."
      : "",
    "--- FIM DO AVISO DE CONSOLIDAÇÃO PURA ---",
  ].filter(Boolean).join("\n");
}

/**
 * 🔴 GAP-68 — o FATO de que estes GAPs já foram entregues a um agente antes e SOBREVIVERAM à edição.
 *
 * MEDIDO em prod 2026-09-07 (NVX LastMile, run `b1bc1195`): a reconciliação do GAP-67 mostrou que
 * **8 de 14** GAPs contados como fechados eram o MESMO defeito com a âncora renumerada pela edição
 * anterior. O agente não tinha como saber: cada rodada lhe entrega o GAP como novidade, ele reescreve
 * a seção, o número muda, o juiz reencontra o defeito sob o nome novo e a spec engorda. É o motor
 * medido do GAP-8 (a spec só cresce: 1,13 milhão de chars).
 *
 * O bloco não manda o agente fazer nada de novo — informa a ÚNICA coisa que ele não podia deduzir do
 * texto que recebe: que a resposta óbvia (reescrever/renumerar a seção) JÁ foi tentada aqui e
 * falhou. Mesma família do `priorRejectionFactBlock`, com uma diferença: ali a rodada foi descartada
 * e o arquivo não mudou; aqui a rodada foi APLICADA e o defeito continuou.
 *
 * A afirmação tem fonte declarada de propósito ("um revisor comparou as duas listas"): é juízo de
 * agente, não medida de código, e um pareamento errado que se apresente como fato manda o CTO apagar
 * texto que talvez não devesse.
 */
export function persistentGapFactBlock(refs: PersistentGapRef[] | null | undefined): string {
  const list = (refs ?? []).filter((r) => r && r.times >= 2);
  if (list.length === 0) return "";
  const worst = Math.max(...list.map((r) => r.times));
  // 🔴 GAP-71: as duas formas de reincidência coexistem na mesma leva e NÃO se descrevem com a mesma
  // frase. "Só mudou de endereço" é verdade sobre `renamed` e mentira sobre `stable` (a âncora nem se
  // moveu) — e uma afirmação falsa aqui manda o agente renumerar seção justamente quando o que falta
  // é reescrever o trecho onde ele está.
  const renamed = list.filter((r) => r.kind !== "stable");
  const stable = list.filter((r) => r.kind === "stable");
  const untouched = list.filter((r) => r.untouched === true);
  const lines = [
    "--- ESTES GAPs JÁ FORAM ENTREGUES ANTES E SOBREVIVERAM À EDIÇÃO (fato registrado pelo laço) ---",
  ];
  if (renamed.length > 0) {
    lines.push(
      `Depois de cada rodada, um revisor compara a lista de problemas de antes com a de depois. Ele`
      + ` concluiu que ${renamed.length === 1 ? "1 dos GAPs abaixo" : `${renamed.length} dos GAPs abaixo`}`
      + " NÃO é novo: já havia sido apontado numa rodada anterior, um agente editou o arquivo, e o"
      + " problema CONTINUOU — só mudou de endereço no documento.",
    );
  }
  if (stable.length > 0) {
    lines.push(
      `O laço também contou, validação por validação, quantas vezes cada problema foi reencontrado no`
      + ` MESMO endereço: ${stable.length === 1 ? "1 dos GAPs abaixo já voltou assim" : `${stable.length} dos GAPs abaixo já voltaram assim`}.`
      + " Aqui a âncora nem se moveu: rodadas anteriores editaram este arquivo e o trecho apontado"
      + " continua dizendo o que dizia.",
    );
  }
  for (const r of list) {
    const de = r.anchorBefore && r.anchorBefore !== r.anchor ? `${r.anchorBefore} → ${r.anchor ?? "(sem âncora)"}` : (r.anchor ?? "(sem âncora)");
    // GAP-71: o fato mais duro que existe sobre a rodada anterior vai COLADO no item, porque é ele
    // que diz o que fazer diferente — não "tente mais", e sim "o trecho está lá, intocado".
    const intacto = r.untouched === true ? " ⚠️ a rodada anterior NÃO alterou este trecho (ele está idêntico no arquivo acima)" : "";
    lines.push(`• ${de} — ${r.times}ª aparição :: ${r.title}${r.why ? ` (o revisor: ${r.why})` : ""}${intacto}`);
  }
  lines.push(
    // 🔴 GAP-71: "é por isso que a âncora mudou" só é verdade quando HOUVE rebatismo. Numa leva
    // puramente `stable` a âncora não se moveu, e afirmar que se moveu mandaria o agente atacar um
    // sintoma que não existe. O diagnóstico muda; o pedido (decidir e apagar) é o mesmo.
    (renamed.length > 0
      ? "RENUMERAR, RENOMEAR OU REESCREVER A SEÇÃO NÃO FECHA ESTES GAPs — foi exatamente o que a rodada"
        + " anterior fez, e é por isso que a âncora mudou e o problema não."
      : "REESCREVER A SEÇÃO COM OUTRAS PALAVRAS NÃO FECHA ESTES GAPs — rodadas anteriores já editaram"
        + " este arquivo e o problema foi reencontrado no MESMO endereço.")
    + " Feche-os na RAIZ: decida qual"
    + " das duas afirmações em conflito é a que VALE, deixe-a em UM lugar só, e APAGUE a outra (ou"
    + " troque-a por uma remissão ao arquivo-oráculo). Se a decisão não é sua, diga explicitamente no"
    + " texto quem decide e o que fica valendo até lá — uma decisão registrada fecha o GAP; uma"
    + " reformulação mais elegante do mesmo impasse não.",
  );
  if (untouched.length > 0) {
    // 🔴 GAP-71 (medido em prod): o CTO passou a anular trechos por errata — `modelo-dados.md` acumulou
    // 23 ocorrências de "errata nula" e as 11 âncoras voltaram nas 6 validações seguintes, com os
    // literais ofensores intactos no disco. O juiz relê o texto ORIGINAL: anulação não é correção.
    lines.push(
      `ATENÇÃO — ${untouched.length === 1 ? "1 desses trechos está" : `${untouched.length} desses trechos estão`}`
      + " marcado(s) como INTOCADO(s) acima. O que não funciona (e já foi tentado neste arquivo):"
      + " acrescentar em outro lugar uma errata, uma nota de rodapé, um requisito novo ou uma tabela de"
      + " decisões dizendo que aquele trecho é 'nulo', 'sem efeito', 'superado' ou que se deve 'ler"
      + " REQ-X em vez dele'. O validador NÃO lê a errata como remoção: ele relê o trecho original,"
      + " encontra a prescrição antiga ainda lá e reabre o GAP — e o arquivo só engordou."
      + " Nesta rodada, EDITE O PRÓPRIO TRECHO: apague a frase/linha/célula que contradiz a decisão, ou"
      + " substitua o texto dela pela decisão que vale. Se já existe uma errata sobre ele, aplique-a"
      + " agora no texto e REMOVA a errata: ela deixa de ter função quando o texto está correto.",
    );
  }
  lines.push(
    worst >= 3
      ? `ATENÇÃO: um deles está na ${worst}ª aparição. Se a sua edição desta vez não REMOVER o texto`
        + " conflitante, ele volta de novo e a rodada foi gasta à toa."
      : "Trocar o texto por uma versão mais longa que preserve as duas afirmações reabre o GAP na"
        + " próxima validação.",
    "--- FIM DOS GAPs REINCIDENTES ---",
  );
  return lines.join("\n");
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
  patch: { status: Exclude<SpecChatJobStatus, "pending" | "running">; specMarkdown?: string | null; reply?: string | null; error?: string | null; modelUsed?: string | null; truncated?: boolean | null; editsApplied?: number | null; gapOutcomes?: GapOutcome[] | null },
): void {
  const j = _chatJobs.get(jobId);
  if (j) {
    // O contrato do Map só tem 4 estados; interrupted/lost são erros com causa para o cliente.
    j.status = patch.status === "done" ? "done" : "error";
    if (patch.specMarkdown) j.specMarkdown = patch.specMarkdown;
    if (patch.reply) j.reply = patch.reply;
    if (patch.error) j.error = patch.error;
    // T1: o cache quente também carrega o aviso — quem está com a tela aberta é justamente
    // quem corre o risco de aplicar uma spec cortada.
    if (patch.truncated != null) j.truncated = patch.truncated === true;
  }
  void finishSpecChatJob(pool, jobId, patch);
}

function runFileChatJob(
  jobId: string,
  raw: Record<string, unknown>,
  agentsUrl: string,
  /** Resposta exibida ao humano quando dá certo (o `/invoke/raw` devolve só o arquivo). */
  doneReply = "Revisão pronta — confira e clique em “Aplicar ao arquivo”.",
  /**
   * A5.2 — conteúdo base quando a resposta esperada são EDIÇÕES (search/replace) em vez do arquivo.
   * Presente só no caminho "Resolver GAPs por arquivo" com `SPEC_GAP_FILE_EDIT_FORMAT=edits`.
   * `null` = a resposta é o arquivo inteiro (comportamento histórico, intocado).
   */
  editsBase: string | null = null,
  /**
   * 🔴 A1 — a lista EXATA de GAPs que este pedido despachou, na ordem em que foi numerada no prompt.
   * Presente só no caminho "Resolver GAPs por arquivo". `null` = a rodada não pediu prestação de
   * contas (chat livre, criação de arquivo) e nada é gravado em `gap_outcomes`.
   */
  outcomeGaps: ValidationFinding[] | null = null,
): void {
  const job = _chatJobs.get(jobId);
  if (!job) return;
  job.status = "running";
  const base = agentsUrl.replace(/\/$/, "");

  // D4: o modo por-arquivo não tinha teto algum — uma resposta que nunca chegasse deixava o job
  // `running` até o TTL do Map varrer, e o frontend girava para sempre. O socket do `/invoke/raw`
  // é derivado do orçamento de saída (`rawSocketTimeoutMs`); o teto do job (FILE_JOB_DEADLINE_MS)
  // é a rede de segurança ACIMA dele.
  const guard = setTimeout(() => {
    settleJob(jobId, { status: "error", error: "A IA não respondeu no tempo máximo desta edição. Tente de novo." });
  }, FILE_JOB_DEADLINE_MS);
  guard.unref?.();

  // A5.1: a espera acompanha o que foi PEDIDO. Um socket fixo de 180 s descartava geração que
  // seguia viva nos agents (medido em prod: 47.816 chars → 21.649 tokens de orçamento).
  const socketMs = rawSocketTimeoutMs(Number(raw.max_tokens ?? 0) || 8_000);
  // Síncrono: /invoke/raw responde no próprio request (não há fila/poll no lado dos agentes).
  httpPost(`${base}/invoke/raw`, JSON.stringify(raw), socketMs)
    .then((text) => {
      clearTimeout(guard);
      const data = JSON.parse(text) as {
        response?: string; model_used?: string;
        // PR-4: campos aditivos do `/invoke/raw` (ausentes se o agents for antigo → tratados como 0/false).
        usage?: { input_tokens?: number; output_tokens?: number } | null; stop_reason?: string | null; truncated?: boolean;
      };
      const md = stripOuterFence(data.response ?? "");
      // PR-4/G5: o gasto deste caminho era INVISÍVEL ao cost cap. Debita ANTES de qualquer veredito —
      // o token foi queimado mesmo quando a resposta é imprestável.
      void recordRawUsage(pool, { id: jobId, projectId: job.projectId ?? null }, data);
      // Sanidade: resposta vazia/trivial = falha (o /invoke/raw já escala fallback internamente,
      // então vazio aqui significa que nem o fallback produziu conteúdo). NÃO aplicamos lixo.
      if (!md || md.trim().length < 2) {
        console.warn(`[SpecChat] job=${jobId} raw vazio — model=${data.model_used ?? "?"}`);
        settleJob(jobId, { status: "error", modelUsed: data.model_used ?? null, error: "A IA não retornou conteúdo para o arquivo. Reformule o pedido e tente de novo." });
        return;
      }
      // ── A5.2: resposta em EDIÇÕES (search/replace) ────────────────────────────────────────────
      // Só quando o chamador mandou a base. Se o modelo desobedecer e reemitir o arquivo inteiro
      // (o hábito que causou os 4 truncamentos), NÃO jogamos fora trabalho pago: sem nenhum marcador
      // de bloco, o resultado segue para o gate histórico de arquivo completo, logo abaixo.
      if (editsBase != null && looksLikeEdits(data.response ?? "")) {
        // `stripOuterFence` não vale aqui: os marcadores não são uma cerca de código e um `trim`
        // global poderia comer indentação que faz parte do trecho a casar.
        const applied = applySpecEditResponse(editsBase, (data.response ?? "").replace(/\r\n/g, "\n"));
        if (!applied.ok) {
          console.warn(`[SpecChat] job=${jobId} edits REPROVADOS (${applied.code}) — ${applied.message}`);
          settleJob(jobId, {
            status: "error",
            modelUsed: data.model_used ?? null,
            // Deliberadamente NÃO marca `truncated`: a causa foi a âncora, não o teto — e `truncated`
            // tem significado próprio para o laço (`assessRevisionIntegrity`).
            error: `A IA devolveu edições que não puderam ser ancoradas no arquivo — nada foi alterado. ${applied.message}`,
          });
          return;
        }
        // POR QUE `truncated` NÃO É PROPAGADO NUM `done` DE EDIÇÕES: no formato de arquivo inteiro,
        // corte = documento mutilado (daí o veto de `assessRevisionIntegrity`). Aqui o corte só
        // descarta o bloco que não fechou — os aplicados são íntegros e o resto do arquivo não muda.
        // Marcar `truncated` faria o laço autônomo recusar um resultado BOM (e pago).
        const partial = applied.dropped > 0 || data.truncated === true;
        // GAP-26: bloco recusado individualmente é FATO da rodada — o laço precisa saber que aquele
        // GAP continua aberto, senão lê "aplicado" e conta como progresso o que não aconteceu.
        const refused = applied.skipped.length > 0
          ? `\n\n⚠️ ${applied.skipped.length} edição(ões) RECUSADA(S) (as demais foram aplicadas): `
            + `${applied.skipped.slice(0, 3).map((s) => s.message).join(" · ")}`
            + `${applied.skipped.length > 3 ? ` … e mais ${applied.skipped.length - 3}.` : ""}`
            + " O que elas tentavam corrigir continua nos GAPs."
          : "";
        if (applied.skipped.length > 0) {
          console.warn(`[SpecChat] job=${jobId} ${applied.applied} edição(ões) aplicada(s), ${applied.skipped.length} recusada(s): ${applied.skipped.map((s) => `${s.index + 1}/${s.code}`).join(", ")}`);
        }
        // 🔴 A1: a prestação de contas é lida AQUI porque este é o único ponto que tem as três coisas
        // ao mesmo tempo: a lista despachada, o texto cru da resposta e quantas edições ANCORADAS o
        // aplicador realmente gravou (o único veto de contradição que é fato). Lida depois do apply,
        // nunca antes — declarar `corrigido` só é contraditório em face do que o arquivo recebeu.
        const contas = outcomeGaps && outcomeGaps.length > 0
          ? parseGapOutcomes(data.response ?? "", outcomeGaps, { appliedEdits: applied.applied })
          : null;
        // A1: o que o agente declarou vai TAMBÉM para o chat — o humano na Bancada precisa ver "3
        // fechados, 2 que ele não conseguiu e 1 que ele contesta" sem abrir o banco. Só os verbos que
        // pedem atenção; `corrigido` limpo já está no "N edição(ões) aplicada(s)".
        const contasNota = (() => {
          if (!contas) return "";
          const abertos = contas.outcomes.filter((o) => o.verb === "permanece_aberto");
          const contestados = contas.outcomes.filter((o) => o.contested);
          const naoDefeito = contas.outcomes.filter((o) => o.verb === "nao_e_defeito");
          const outroArquivo = contas.outcomes.filter((o) => o.verb === "nao_e_deste_arquivo");
          const calados = contas.outcomes.filter((o) => o.verb === "nao_declarado");
          const partes: string[] = [];
          if (abertos.length > 0) partes.push(`${abertos.length} que a IA declarou que NÃO conseguiu fechar`);
          if (naoDefeito.length > 0) partes.push(`${naoDefeito.length} que ela considera que não são defeito (o juiz decide na próxima validação)`);
          if (outroArquivo.length > 0) partes.push(`${outroArquivo.length} que pertencem a outro arquivo`);
          if (contestados.length > 0) partes.push(`${contestados.length} declarado(s) como corrigido(s) SEM edição aplicada`);
          if (calados.length > 0) partes.push(`${calados.length} sem desfecho declarado`);
          return partes.length > 0 ? `\n\n📋 Prestação de contas da IA: ${partes.join(" · ")}.` : "";
        })();
        if (contas) {
          const resumo = summarizeOutcomes(contas.outcomes);
          console.log(
            `[SpecChat] job=${jobId} DESFECHO ${contas.ran ? "declarado" : "AUSENTE"} — ${JSON.stringify(resumo)}`
            + (contas.rejected.length > 0 ? ` · ${contas.rejected.length} linha(s) RECUSADA(S): ${contas.rejected.slice(0, 3).map((r) => r.why).join(" · ")}` : ""),
          );
        }
        settleJob(jobId, {
          status: "done",
          specMarkdown: applied.content,
          modelUsed: data.model_used ?? null,
          // A1: grava SEMPRE que a rodada pediu contas — inclusive o bloco ausente (todos
          // `nao_declarado`). É a diferença entre "o agente calou" e "ninguém perguntou", e sem ela o
          // laço não pode cobrar na rodada seguinte o que ele mesmo não registrou ter pedido.
          gapOutcomes: contas ? contas.outcomes : null,
          // GAP-12 (migração 098): o FATO de que este conteúdo saiu de N blocos ANCORADOS. Quem
          // consome é o modo autônomo, noutro processo e noutro tick: sem persistir, ele só sabe o
          // que PEDIU (edições) e não o que RECEBEU — e o modelo pode reemitir o arquivo inteiro.
          editsApplied: applied.applied,
          reply: (partial
            ? `${doneReply}\n\n⚠️ A resposta bateu no teto de saída: ${applied.applied} edição(ões) aplicada(s) e ${applied.dropped} incompleta(s) descartada(s). O que faltou continua nos GAPs — rode de novo para o restante.`
            : `${doneReply}\n\n${applied.applied} edição(ões) aplicada(s) ao arquivo.`) + refused + contasNota,
        });
        console.log(
          `[SpecChat] ✓ job=${jobId} DONE (edits) — ${applied.applied} aplicadas, ${applied.dropped} descartadas, ` +
          `${editsBase.length}→${applied.content.length} chars, out=${data.usage?.output_tokens ?? "?"}, model=${data.model_used ?? "?"}`,
        );
        return;
      }
      if (editsBase != null) {
        console.warn(`[SpecChat] job=${jobId} pediu EDITS e veio arquivo inteiro (${md.length} chars) — aplicando o gate de arquivo completo`);
      }
      // PR-4/T1: bateu no teto de saída → o arquivo devolvido está CORTADO. Aqui o resultado é
      // aplicado POR CIMA de um arquivo bom, então entregar truncado é perda de dados. Recusamos:
      // melhor a rodada falhar (e o laço parar) do que mutilar a spec.
      if (data.truncated === true) {
        console.warn(`[SpecChat] job=${jobId} raw TRUNCADO (stop_reason=${data.stop_reason ?? "?"}) — ${md.length} chars descartados`);
        settleJob(jobId, {
          status: "error",
          truncated: true,
          // `model_used` faltava aqui e no caminho vazio: o job de erro nascia sem modelo e a
          // análise de custo ficava cega justamente nas rodadas que só gastaram (GAP registrado).
          modelUsed: data.model_used ?? null,
          error: "A resposta da IA bateu no teto de saída do modelo e o arquivo voltou INCOMPLETO — nada foi aplicado. Divida o arquivo (ou peça menos de uma vez) e tente de novo.",
        });
        return;
      }
      settleJob(jobId, {
        status: "done",
        specMarkdown: md,
        // /invoke/raw devolve SÓ o conteúdo do arquivo — a "resposta" ao usuário é sintetizada aqui.
        reply: doneReply,
        modelUsed: data.model_used ?? null,
      });
      console.log(`[SpecChat] ✓ job=${jobId} DONE (raw) — ${md.length} chars, model=${data.model_used ?? "?"}`);
    })
    .catch((err) => {
      clearTimeout(guard);
      settleJob(jobId, { status: "error", error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    });
}

function runChatJob(jobId: string, message: Record<string, unknown>, agentsUrl: string, kind: SpecChatJobKind): void {
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
                console.log(`[SpecChat] ✓ job=${jobId} DONE${verdict.truncated ? " TRUNCADO" : ""} — ${verdict.specMarkdown?.length} chars`);
              }
              // G5: o CTO da Bancada custa tokens de Opus como qualquer agente da fábrica, mas
              // este caminho (api → /invoke/cto/async) NÃO passa pelo runner, então nada era
              // debitado em `project_agent_metrics`. Idempotente por task_id: se o worker
              // coletar o mesmo job, o segundo INSERT não acontece.
              void recordCtoUsage(pool, { id: jobId, projectId: job.projectId ?? null, kind }, pollData.result);
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
  runChatJob(opts.jobId, { ...buildChatMessage(opts.specMarkdown, [], ctx, true, opts.projectId), ...opts.llm }, opts.agentsUrl, "resolve_gaps");
  return { ok: true, gaps: ctx.findings.length };
}

/**
 * PR-5 (F2, 2026-09-05): dispara "Resolver GAPs DESTE ARQUIVO" pelo MESMO caminho do botão do PR-4.
 *
 * É o que o laço autônomo usa depois da divisão da spec. Existe por dois motivos:
 *   • o `dispatchResolveGapsJob` manda a spec INTEIRA ao CTO normalizador — depois do split o
 *     primário é só o ÍNDICE, então aquele caminho revisaria o índice (e o CTO reemitiria a spec
 *     inteira: exatamente a causa do truncamento de 64k que este épico mata);
 *   • o prompt, o orçamento de saída (`rawMaxTokensFor`) e as regras de escopo do CTO-EDITOR vivem
 *     aqui. Se o laço montasse o pedido por conta própria, divergiria do botão no primeiro ajuste.
 *
 * Autorização é do CHAMADOR (a rota do autônomo já validou dono/tenant). Aqui só se recusa o que
 * tornaria a rodada inútil ou perigosa: sem GAP para este arquivo, ou arquivo acima do teto.
 */
export async function dispatchGapFileJob(opts: {
  jobId: string;
  projectId: string;
  tenantId: string | null;
  ownerUserId: string;
  filePath: string;
  fileContent: string;
  findings: ValidationFinding[];
  userMessage: string;
  agentsUrl: string;
  llm: Record<string, unknown>;
  /** GAP-28: margem de crescimento que resta no passe. Só o laço autônomo informa. */
  growthBudget?: number;
  /**
   * GAP-29/GAP-31: a tentativa anterior neste arquivo foi DESCARTADA pelo veto de consolidação —
   * tamanho que ela entregou, margem que havia e o MOTIVO exato. Só o laço autônomo tem esse
   * histórico; o botão humano não retenta.
   */
  priorRejection?: { delta: number; budget: number; pass: number; reason?: string | null } | null;
  /**
   * 🔴 GAP-68: os GAPs desta leva que a reconciliação do GAP-67 identificou como REINCIDENTES —
   * já entregues antes, editados, e voltaram só com a âncora trocada. Só o laço autônomo tem esse
   * histórico (o botão humano não encadeia rodadas).
   */
  persistentGaps?: PersistentGapRef[] | null;
  /**
   * 🔴 GAP-81: esta rodada é DEDICADA (a lista de `findings` já vem restrita aos teimosos, ou a um só).
   * Só o laço autônomo escala assim; o botão humano manda sempre a lista inteira do arquivo. Sem este
   * fato o modelo leria a lista curta como "o arquivo só tem estes defeitos" e consolidaria o resto.
   */
  focus?: FocusPlan | null;
  /**
   * 🔴 A1: os desfechos que o agente DECLAROU na rodada anterior deste arquivo (do job anterior).
   * Só o laço autônomo os tem (o botão humano não encadeia rodadas). Ausente/vazio = primeira rodada
   * do arquivo ou nada relevante a devolver.
   */
  priorOutcomes?: GapOutcome[] | null;
  /**
   * 🔴 GAP-131: as cadeias de tentativas (2+ vias já declaradas) dos GAPs desta leva, lidas pelo laço
   * (`declaredAttemptHistory` + `selectAttemptHistory`). Só o laço autônomo as tem. Ausente = nenhum
   * reincidente com histórico, ou a leitura falhou (e aí o laço não afirma nada).
   */
  attemptHistory?: GapAttemptHistory[] | null;
  /**
   * 🔴 GAP-121: o laço mediu que não há margem para este arquivo crescer e despachou uma rodada de
   * CONSOLIDAÇÃO PURA — remoção de redeclaração, sem pedir o texto novo dos GAPs (que seguem ativos).
   * Só o laço autônomo sabe disso (é a aritmética do orçamento da run); o botão humano nunca manda.
   */
  consolidationOnly?: { reason: string; affordable: number; restates: number; shrinkFloor?: number } | null;
}): Promise<{ ok: true; gaps: number } | { ok: false; code: "NO_GAPS_IN_FILE" | "FILE_TOO_LARGE"; message: string }> {
  if (opts.findings.length === 0) {
    return { ok: false, code: "NO_GAPS_IN_FILE", message: `Nenhum GAP ativo atribuído a ${opts.filePath}.` };
  }
  // A5.7/GAP-7: acima do teto o arquivo NÃO é mais recusado no formato `edits` — entra recortado pelas
  // seções que os GAPs apontam. Era daqui que saía "divida este arquivo", que pede ao humano
  // exatamente o que ele acionou o autônomo para não fazer (e o arquivo ficava irrevisável para sempre).
  const target = await gapFileTargetContent(opts.filePath, opts.fileContent, opts.findings);
  if ("tooLarge" in target) {
    return {
      ok: false, code: "FILE_TOO_LARGE",
      message: `${opts.filePath} tem ${opts.fileContent.length} caracteres (teto ${target.cap}) — não cabe na janela de contexto desta rodada. Divida este arquivo.`,
    };
  }
  // Mapa do produto como contexto só-leitura (Fase 1). Best-effort e só com a flag ligada — sem ele
  // o CTO-editor não sabe onde este arquivo vive e duplica o que já está no irmão.
  const ctx = productScopeEnabled()
    ? await loadChatContext(opts.projectId, opts.fileContent, opts.userMessage, { siblingBodies: false })
    : EMPTY_CTX;
  // A5.5: o mapa do produto diz ONDE o arquivo vive; o irmão citado diz O QUE ele já normatiza — é o
  // que faltava para a divergência ser resolvida em vez de migrar para o próximo arquivo.
  const siblings = await gapSiblingBlock(opts.projectId, opts.filePath, opts.findings);
  // GAP-22: o irmão só-leitura diz O QUE o outro arquivo normatiza; o registro de oráculos diz QUEM
  // MANDA — e é isso que faltava para a contradição ser CONSOLIDADA em vez de migrar de arquivo (24
  // dos 26 blockers do NVX eram desta família, com o mesmo contrato reaparecendo em 5 rodadas).
  const oracles = await gapOracleBlock(opts.projectId, opts.filePath, opts.fileContent.length, opts.growthBudget);
  // GAP-29/GAP-31: o prompt NÃO é persistido em `spec_chat_jobs` (só o `reply`), então sem esta linha
  // a entrega do fato da recusa anterior é INAUDITÁVEL em produção — dá para ver que o laço gravou a
  // recusa, não que o agente a recebeu. Loga o que foi entregue, não o texto (que é longo e derivável).
  // GAP-68: o bloco é montado a partir das refs que o laço guardou; o log diz quantos GAPs desta leva
  // são reincidentes e qual a pior reincidência. Sem esta linha, "o agente foi avisado" seria
  // indemonstrável em prod — o prompt não é persistido, só o `reply`. E `reincidentes=0` com refs
  // presentes é o sintoma de ação INERTE (fingerprint mudou entre o registro e o despacho).
  const persistentBlock = persistentGapFactBlock(opts.persistentGaps);
  if ((opts.persistentGaps ?? []).length > 0) {
    const pg = opts.persistentGaps!;
    console.log(
      `[SpecChat] fato de reincidência entregue alvo=${opts.filePath} reincidentes=${pg.length}`
      + ` pior=${Math.max(...pg.map((r) => r.times))}ª chars=${persistentBlock.length}`,
    );
  }
  // 🔴 GAP-81: o fato da rodada dedicada. Logado porque o prompt não é persistido — sem esta linha,
  // "o agente soube que a rodada era só para o teimoso" seria indemonstrável em prod, e o degrau da
  // escalada não poderia ser auditado contra a reincidência que ele deveria ter quebrado.
  const focusBlock = opts.focus ? focusFactBlock(opts.focus) : "";
  if (opts.focus && opts.focus.level > 0) {
    console.log(
      `[SpecChat] rodada DEDICADA alvo=${opts.filePath} nivel=${opts.focus.level}`
      + ` gaps=${opts.findings.length} adiados=${opts.focus.deferred} ancoras=${opts.focus.anchors.join(", ")}`,
    );
  }
  // 🔴 A1: o relato anterior DO PRÓPRIO AGENTE. Logado pelo mesmo motivo dos outros fatos — o prompt
  // não é persistido, só o `reply`, então sem esta linha "o agente recebeu o próprio relato" seria
  // indemonstrável em prod. `entregues=0` com desfechos presentes é o sintoma de relato INERTE
  // (todos `corrigido` limpos ou `nao_declarado` — nada que mude a rodada).
  const priorOutcomeBlock = priorOutcomeFactBlock(opts.priorOutcomes);
  if ((opts.priorOutcomes ?? []).length > 0) {
    console.log(
      `[SpecChat] relato anterior entregue alvo=${opts.filePath}`
      + ` desfechos=${opts.priorOutcomes!.length} chars=${priorOutcomeBlock.length}`
      + ` resumo=${JSON.stringify(summarizeOutcomes(opts.priorOutcomes!))}`,
    );
  }
  // 🔴 GAP-131: as vias já tentadas. Logado pelo mesmo motivo de todos os outros fatos — o prompt não
  // é persistido, só o `reply`. `gaps=0` com histórico presente é o sintoma de cadeia INERTE (o
  // casamento por identidade vetou tudo), e é isso que separa "não avisei" de "não havia o que avisar".
  const attemptHistoryBlock = attemptHistoryFactBlock(opts.attemptHistory);
  if ((opts.attemptHistory ?? []).length > 0) {
    const h = opts.attemptHistory!;
    console.log(
      `[SpecChat] vias já tentadas entregues alvo=${opts.filePath} gaps=${h.length}`
      + ` pior=${Math.max(...h.map((x) => x.attempts.length))} vias chars=${attemptHistoryBlock.length}`,
    );
  }
  const priorBlock = priorRejectionFactBlock(opts.priorRejection);
  if (priorBlock) {
    const p = opts.priorRejection!;
    console.log(
      `[SpecChat] fato de recusa anterior entregue alvo=${opts.filePath} delta=${p.delta} margem=${p.budget}`
      + ` passe=${p.pass} motivo=${p.reason ? "gravado" : "ausente(rodada antiga)"} chars=${priorBlock.length}`,
    );
  }
  // 🔴 GAP-121: o prompt não é persistido (só o `reply`), então sem esta linha "o agente foi avisado de
  // que a rodada era só de remoção" seria indemonstrável em prod — e a auditoria não poderia separar
  // "encolheu porque foi pedido" de "encolheu por conta própria".
  // 🔴 GAP-122: os fatos do índice, só quando o alvo é o manifesto. Vem com log próprio porque o prompt
  // não é persistido: sem ele, "o editor soube do arquivo novo" seria indemonstrável em prod.
  const indexBlock = await gapIndexBlock(opts.projectId, opts.filePath, opts.fileContent);
  const consolidationBlock = consolidationOnlyFactBlock(opts.consolidationOnly);
  if (consolidationBlock) {
    const c = opts.consolidationOnly!;
    console.log(
      `[SpecChat] rodada de CONSOLIDAÇÃO PURA alvo=${opts.filePath} redeclarações=${c.restates}`
      + ` margem=${c.affordable} gaps_como_contexto=${opts.findings.length} chars=${consolidationBlock.length}`
      + ` motivo=${c.reason}`,
    );
  }

  _chatJobs.set(opts.jobId, {
    id: opts.jobId, status: "pending", createdAt: Date.now(),
    projectId: opts.projectId, ownerUserId: opts.ownerUserId,
    sentFilePath: opts.filePath, sentBaseSha: sha256(opts.fileContent),
  });
  await createSpecChatJob(pool, {
    id: opts.jobId, projectId: opts.projectId, tenantId: opts.tenantId, ownerUserId: opts.ownerUserId,
    // `kind: "file"` (migração 089) → herda durabilidade, rehidratação por `filePath` e o apply com If-Match.
    kind: "file", filePath: opts.filePath, baseSha: sha256(opts.fileContent),
    baseSpecSha: sha256(opts.fileContent), userMessage: opts.userMessage,
  });
  runFileChatJob(
    opts.jobId,
    {
      ...buildGapFileRequest(
        target.text, opts.filePath, opts.findings, ctx, opts.projectId, siblings, target.digested, oracles,
        priorBlock, persistentBlock, focusBlock, priorOutcomeBlock, consolidationBlock, indexBlock,
        attemptHistoryBlock,
      ),
      ...opts.llm,
    },
    opts.agentsUrl,
    consolidationBlock
      ? `Consolidação de \`${opts.filePath}\` pronta (remoção de redeclaração; os ${opts.findings.length} GAP(s) seguem abertos).`
      : `Revisão dos ${opts.findings.length} GAP(s) de \`${opts.filePath}\` pronta.`,
    // A base das edições é EXATAMENTE o conteúdo cujo sha virou `baseSha` — o apply com If-Match
    // continua comparando a mesma impressão.
    gapFileEditsEnabled() ? opts.fileContent : null,
    // 🔴 A1: a MESMA lista, na MESMA ordem, é o que dá sentido ao número que o agente declara. Passar
    // outra lista (ou reordenada) faria o desfecho apontar para o GAP errado — daí ela viajar junto
    // com o pedido em vez de ser recuperada depois.
    // 🔴 GAP-121: `null` na consolidação pura. A prestação de contas é lida da resposta e o que falta
    // vira `nao_declarado` — cobrar desfecho de conserto que ESTE pedido não fez gravaria em
    // `gap_outcomes` uma leva de omissões que são decisão do laço, e o A1 as devolveria ao agente na
    // rodada seguinte como dívida dele. Rodada que não pede conserto não cobra conta.
    consolidationBlock ? null : opts.findings,
  );
  return { ok: true, gaps: opts.findings.length };
}

// ── A5.3: o manifesto (README.md) que faltava ────────────────────────────────
//
// POR QUE ESTE CAMINHO EXISTE: o finding `no_readme` do Estágio A aponta um arquivo que NÃO
// EXISTE. Nenhum caminho da Bancada sabia criar arquivo — "Resolver GAPs por arquivo" edita um
// arquivo existente, o CTO da spec inteira reescreve o primário. Resultado medido em prod: o GAP
// sustentava rodada do laço autônomo para sempre e nunca podia cair. Ver `services/specManifest.ts`.
//
// O conteúdo é decisão do AGENTE (Lei: 100% LLM). O código só entrega os FATOS (título, arquétipo
// do `project_type`, árvore de arquivos) e veta o que o validador reprovaria.
const MANIFEST_SYSTEM = [
  "Você é o CTO/arquiteto responsável pela especificação de um produto de software.",
  "A especificação deste projeto está dividida em vários arquivos Markdown, mas falta o MANIFESTO",
  "(`README.md` na raiz): o documento de entrada que declara o que este projeto é e indexa os demais.",
  "Escreva esse manifesto do zero, a partir da árvore de arquivos e da spec primária que recebe.",
  "FORMATO (obrigatório, nesta ordem):",
  "1) Um bloco YAML de frontmatter, com `---` na PRIMEIRA linha do arquivo e `---` fechando, contendo",
  "   EXATAMENTE estas chaves: `kind: project`, `archetype: <o id informado>`,",
  "   `stack: [t1, t2, ...]` (tecnologias que a própria spec já determina), `depends_on: [...]`",
  "   (outros projetos/produtos de que este depende; lista vazia se nenhum) e `deploy_target: <um dos informados>`.",
  "2) `# <título do projeto>` seguido de UM parágrafo dizendo o que o sistema faz e para quem.",
  "3) Uma seção `## Índice da especificação` listando CADA arquivo da árvore com uma linha dizendo",
  "   o que ele normatiza (use o caminho exato entre backticks).",
  "4) Opcionalmente uma seção curta `## Decisões estruturais` com o que vale para todos os arquivos.",
  "REGRAS (invioláveis):",
  "a) NUNCA inclua `spec_hash` nem `status_spec` no frontmatter — estado vive no banco, não no arquivo.",
  "b) Não invente arquivo que não está na árvore, e não repita o conteúdo dos arquivos: isto é um índice.",
  "c) Não altere o arquétipo informado — ele é o tipo com que a fábrica já roteia este projeto. Se",
  "   nenhum for informado, ESCOLHA um id da lista oferecida; jamais invente um id fora dela.",
  "Devolva SOMENTE o conteúdo final do arquivo, começando em `---`, sem cercas de código e sem preâmbulo.",
].join(" ");

/** Orçamento de saída do manifesto: é um índice curto, não uma spec. Teto ≠ gasto. */
const MANIFEST_MAX_TOKENS = 8_000;

/**
 * Pedido do manifesto. O `archetype` NÃO é escolha do modelo quando o banco já sabe
 * (`projects.extra.project_type`) — mandamos o id e o veto recusa qualquer outro. Quando o banco NÃO
 * sabe (spec importada crua, sem `project_type`), o catálogo inteiro vai como menu e a escolha é do
 * agente: adivinhar o tipo no código seria decidir arquitetura por automação fixa (Lei do Jean), e
 * cravar um id errado faria o manifesto MENTIR sobre o produto.
 */
function buildManifestRequest(opts: {
  projectTitle: string;
  archetype: Archetype | null;
  files: string[];
  primaryPath: string;
  primaryContent: string;
  scopeProjectId: string | null;
}): Record<string, unknown> {
  const arch = opts.archetype
    ? [
      `ARQUÉTIPO (use exatamente este id): ${opts.archetype.id} — ${opts.archetype.description}`,
      `VOCABULÁRIO DE STACK sugerido para este arquétipo: ${opts.archetype.validStacks.join(", ")}`,
      `VALORES ACEITOS EM deploy_target: ${opts.archetype.deployTargets.join(", ")}`,
    ]
    : [
      "ARQUÉTIPO: este projeto não declara tipo no banco — ESCOLHA o id que descreve o produto, entre:",
      ...loadArchetypeCatalog().archetypes.map((a) =>
        `- ${a.id} — ${a.description} · stack: ${a.validStacks.join(", ")} · deploy_target: ${a.deployTargets.join(", ")}`),
    ];
  const userMessage = [
    `PROJETO: ${opts.projectTitle}`,
    ...arch,
    "",
    `--- ÁRVORE DA ESPECIFICAÇÃO (${opts.files.length} arquivos; o manifesto será o \`README.md\` na raiz) ---`,
    ...opts.files.map((p) => `- ${p}${p === opts.primaryPath ? "  (arquivo primário / índice atual)" : ""}`),
    "--- FIM DA ÁRVORE ---",
    "",
    `--- CONTEÚDO DO ARQUIVO PRIMÁRIO (\`${opts.primaryPath}\`, só leitura) ---`,
    opts.primaryContent.slice(0, 40_000),
    "--- FIM DO CONTEÚDO ---",
    "",
    "Escreva agora o `README.md` completo deste projeto, no formato exigido.",
  ].join("\n");
  return {
    prompt_override: MANIFEST_SYSTEM,
    user_message: userMessage,
    max_tokens: MANIFEST_MAX_TOKENS,
    ...cagBlock(opts.scopeProjectId, `manifesto README.md ${opts.projectTitle}`),
  };
}

/**
 * Enfileira o job que ESCREVE o manifesto. Mesma mecânica durável dos outros jobs de arquivo
 * (`kind: "file"`, `filePath` = README.md): sobrevive a restart e é recoletável pelo worker.
 *
 * `baseSha` é o sha do vazio: o arquivo não existe ainda, então a pré-condição de escrita é
 * "continua não existindo" — o mesmo contrato do If-Match para criação.
 */
export async function dispatchManifestJob(opts: {
  jobId: string;
  projectId: string;
  tenantId: string | null;
  ownerUserId: string;
  projectTitle: string;
  archetype: Archetype | null;
  files: string[];
  primaryPath: string;
  primaryContent: string;
  userMessage: string;
  agentsUrl: string;
  llm: Record<string, unknown>;
}): Promise<{ ok: true }> {
  const emptySha = sha256("");
  _chatJobs.set(opts.jobId, {
    id: opts.jobId, status: "pending", createdAt: Date.now(),
    projectId: opts.projectId, ownerUserId: opts.ownerUserId,
    sentFilePath: MANIFEST_PATH, sentBaseSha: emptySha,
  });
  await createSpecChatJob(pool, {
    id: opts.jobId, projectId: opts.projectId, tenantId: opts.tenantId, ownerUserId: opts.ownerUserId,
    kind: "file", filePath: MANIFEST_PATH, baseSha: emptySha, baseSpecSha: emptySha,
    userMessage: opts.userMessage,
  });
  runFileChatJob(
    opts.jobId,
    { ...buildManifestRequest({ ...opts, scopeProjectId: opts.projectId }), ...opts.llm },
    opts.agentsUrl,
    `Manifesto \`${MANIFEST_PATH}\` proposto — confira antes de aplicar.`,
    // Arquivo NOVO: não existe base para ancorar edições; a resposta é o arquivo inteiro.
    null,
  );
  return { ok: true };
}

// ── Diagramas da arquitetura (feature do Jean, 2026-09-08) ───────────────────
//
// POR QUE ESTE CAMINHO EXISTE: a spec fechada descreve a arquitetura em prosa normativa, e o usuário
// pediu para VER. O portal já renderiza ```mermaid como SVG na aba Spec, então um arquivo de spec com
// cercas mermaid é o entregável — sem nenhum trabalho de UI. Mesma mecânica de CRIAÇÃO do manifesto
// (A5.3), porque é o único caminho da Bancada que sabe escrever arquivo que ainda não existe.
//
// O conteúdo é decisão do AGENTE (Lei: 100% LLM): quais recortes o produto precisa, o que entra em
// cada desenho e que tipo de diagrama serve. O código entrega os FATOS (a spec inteira, declarando o
// que não caberá) e veta só o que não desenha (`services/specDiagrams.ts`).
const DIAGRAMS_SYSTEM = [
  "Você é o arquiteto responsável por DESENHAR a arquitetura que a especificação deste produto já decidiu.",
  `Escreva um documento Markdown com NO MÍNIMO ${MIN_DIAGRAMS} diagramas Mermaid dessa arquitetura.`,
  "O objetivo é o leitor ENTENDER na prática como ficam as aplicações e a infraestrutura — não é um índice",
  "nem um resumo em prosa: o valor está nos desenhos.",
  "FORMATO (obrigatório):",
  "1) `# <título>` na primeira linha, seguido de UM parágrafo dizendo o que o documento mostra.",
  "2) Para CADA diagrama: um cabeçalho `## <nome do recorte>`, o diagrama numa cerca ```mermaid e, depois",
  "   da cerca, um parágrafo curto explicando o que ele mostra e o que fica DE FORA dele.",
  "REGRAS (invioláveis):",
  "a) Desenhe apenas o que a especificação determina. Se a spec não decide um componente, ele NÃO entra no",
  "   desenho — inventar caixinha aqui é decidir arquitetura por fora da spec.",
  `b) Os ${MIN_DIAGRAMS}+ diagramas são RECORTES DIFERENTES do mesmo sistema, não a mesma figura repetida.`,
  "   Recortes que quase todo produto precisa: visão global (atores, aplicações e dependências), APIs e",
  "   fluxos entre serviços, e infraestrutura/implantação. Se o produto pede outro recorte (sequência de",
  "   autenticação, máquina de estados de um pedido, modelo de dados, topologia multi-tenant), use-o —",
  "   a escolha é sua, os exemplos acima não são gabarito.",
  "c) Cada bloco começa com o tipo de diagrama Mermaid na primeira linha (`flowchart TD`, `graph LR`,",
  "   `sequenceDiagram`, `erDiagram`, `stateDiagram-v2`, `C4Context`, …). Sintaxe inválida não vira desenho:",
  "   o leitor recebe código cru, e aí o documento não serve para nada.",
  "d) Rótulo com espaço, acento, parêntese, dois-pontos, barra ou hífen vai SEMPRE entre aspas dentro dos",
  '   colchetes — `A["API de pedidos (v2)"]`, nunca `A[API de pedidos (v2)]`. Identificadores dos nós em',
  "   inglês, curtos e sem acento; os RÓTULOS em português.",
  "e) Não use `<br>`, HTML, `click`, `%%{init}%%` nem imagens externas. Nada de frontmatter YAML no arquivo.",
  "f) Nomeie no desenho os componentes com os MESMOS nomes que a spec usa — o leitor precisa achar cada",
  "   caixa no texto normativo.",
  "Devolva SOMENTE o conteúdo final do arquivo, começando em `# `, sem preâmbulo e sem cerca em volta do",
  "documento (as cercas ```mermaid dos diagramas, sim).",
].join(" ");

/** Orçamento de saída dos desenhos: é um documento de figuras, não uma spec. Teto ≠ gasto. */
const DIAGRAMS_MAX_TOKENS = 16_000;

/**
 * Pedido dos diagramas. O insumo é a spec MONTADA pelo chamador (`buildValidationInput`) — o mesmo
 * assembler da validação, que declara no inventário o que entrou integral e o que entrou só como
 * sumário. É a lição do GAP-54: quem desenha a arquitetura tem de RECEBER a arquitetura, e um recorte
 * silencioso faria o agente desenhar o produto que ele conseguiu ler.
 */
function buildDiagramsRequest(opts: {
  projectTitle: string;
  archetype: Archetype | null;
  specText: string;
  scopeProjectId: string | null;
}): Record<string, unknown> {
  const userMessage = [
    `PROJETO: ${opts.projectTitle}`,
    ...(opts.archetype ? [`ARQUÉTIPO: ${opts.archetype.id} — ${opts.archetype.description}`] : []),
    "",
    "--- ESPECIFICAÇÃO (só leitura; é a arquitetura que você vai desenhar) ---",
    opts.specText,
    "--- FIM DA ESPECIFICAÇÃO ---",
    "",
    `Escreva agora o documento completo com os diagramas Mermaid da arquitetura deste produto (mínimo ${MIN_DIAGRAMS}).`,
  ].join("\n");
  return {
    prompt_override: DIAGRAMS_SYSTEM,
    user_message: userMessage,
    max_tokens: DIAGRAMS_MAX_TOKENS,
    ...cagBlock(opts.scopeProjectId, `diagramas de arquitetura ${opts.projectTitle}`),
  };
}

/**
 * Enfileira o job que ESCREVE o documento de diagramas. Idêntico em mecânica ao do manifesto: job
 * durável `kind: "file"` com `baseSha` do vazio (a pré-condição é "o arquivo continua não existindo").
 */
export async function dispatchDiagramsJob(opts: {
  jobId: string;
  projectId: string;
  tenantId: string | null;
  ownerUserId: string;
  projectTitle: string;
  archetype: Archetype | null;
  specText: string;
  userMessage: string;
  agentsUrl: string;
  llm: Record<string, unknown>;
}): Promise<{ ok: true }> {
  const emptySha = sha256("");
  _chatJobs.set(opts.jobId, {
    id: opts.jobId, status: "pending", createdAt: Date.now(),
    projectId: opts.projectId, ownerUserId: opts.ownerUserId,
    sentFilePath: DIAGRAMS_PATH, sentBaseSha: emptySha,
  });
  await createSpecChatJob(pool, {
    id: opts.jobId, projectId: opts.projectId, tenantId: opts.tenantId, ownerUserId: opts.ownerUserId,
    kind: "file", filePath: DIAGRAMS_PATH, baseSha: emptySha, baseSpecSha: emptySha,
    userMessage: opts.userMessage,
  });
  runFileChatJob(
    opts.jobId,
    { ...buildDiagramsRequest({ ...opts, scopeProjectId: opts.projectId }), ...opts.llm },
    opts.agentsUrl,
    `Diagramas da arquitetura (\`${DIAGRAMS_PATH}\`) propostos — confira antes de aplicar.`,
    // Arquivo NOVO: não existe base para ancorar edições; a resposta é o arquivo inteiro.
    null,
  );
  return { ok: true };
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
      // Resolver GAPs exige projeto (é de onde vêm a árvore e os findings).
      // PR-4 (F2): com `filePath`, resolve os GAPs DAQUELE arquivo — é o modo que existe para a spec
      // dividida (antes isto era 400: "Resolver GAPs não opera em modo por-arquivo").
      if (resolveGaps && !projectId) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Resolver GAPs exige projectId" });
      }
      const gapsPerFile = resolveGaps && !!filePath;
      // C1: em modo por-arquivo, bloqueia conteúdo acima do teto (evita revisão truncada → apply
      // sobrescrevendo o arquivo real com versão cortada). O chat da spec inteira não tem esse apply.
      // O teto do Resolver GAPs por arquivo é maior: o orçamento de saída agora é derivado do
      // tamanho do arquivo (`rawMaxTokensFor`) em vez de fixo em 8k.
      const fileChatCap = gapsPerFile ? maxGapFileChars() : MAX_FILE_CHAT_CHARS;
      // A5.7/GAP-7: em "Resolver GAPs por arquivo" no formato `edits`, o arquivo acima do teto deixa de
      // ser recusado — entra recortado pelas seções que os GAPs apontam (ver `gapFileTargetContent`).
      // O chat livre por arquivo e o formato `whole` continuam recusando: lá o modelo devolve o arquivo
      // INTEIRO, e reemitir "o arquivo inteiro" a partir de um recorte mutilaria o arquivo.
      const canDigestOversize = gapsPerFile && gapFileEditsEnabled();
      if (filePath && !canDigestOversize && specMarkdown.length > fileChatCap) {
        return reply.status(413).send({
          code: "FILE_TOO_LARGE",
          message: `Arquivo grande demais para edição por IA (${specMarkdown.length} > ${fileChatCap} caracteres). Divida o arquivo e tente de novo.`,
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
      // No modo por-arquivo quem responde isso é o escopo (abaixo): `ctx.findings` é do PROJETO e
      // pode vir vazio só porque a flag de contexto está off.
      if (resolveGaps && !gapsPerFile && ctx.findings.length === 0) {
        return reply.status(409).send({
          code: "NO_GAPS",
          message: "Nenhum GAP ATIVO na última validação (ignorados/refutados não são tratados). Rode Validar para (re)avaliar a spec.",
        });
      }

      // PR-4: GAPs DESTE arquivo. O `file` de cada finding vem do validador (decisão de LLM); o que
      // não tiver arquivo resolvível é roteado por agente UMA vez e persistido na run (migração 094).
      let fileGaps: ValidationFinding[] = [];
      if (gapsPerFile) {
        const { ensureGapScope } = await import("../services/specGapScope.js");
        const { scope, routing } = await ensureGapScope(pool, projectId!, { route: true });
        if (routing) {
          console.log(`[SpecChat] roteamento de GAPs projeto=${projectId!.slice(0, 8)} routed=${routing.routed} restantes=${routing.stillUnrouted}${routing.skipped ? ` (skip: ${routing.reason})` : ""}`);
        }
        if (scope.totalActive === 0) {
          return reply.status(409).send({
            code: "NO_GAPS",
            message: "Nenhum GAP ATIVO na última validação (ignorados/refutados não são tratados). Rode Validar para (re)avaliar a spec.",
          });
        }
        fileGaps = scope.byPath.get(filePath!) ?? [];
        if (fileGaps.length === 0) {
          return reply.status(409).send({
            code: "NO_GAPS_IN_FILE",
            message: `Este arquivo não tem GAP ATIVO (o projeto tem ${scope.totalActive}${scope.unrouted.length ? `, sendo ${scope.unrouted.length} ainda sem arquivo definido` : ""}). Abra um arquivo com GAPs ou resolva pela spec inteira.`,
            totalActive: scope.totalActive,
            unrouted: scope.unrouted.length,
          });
        }
      }

      // Mensagem do usuário a persistir/logar: sintetizada em Resolver GAPs.
      const persistedUserMsg = gapsPerFile
        ? `🛠️ Resolver GAPs de \`${filePath}\` — pedi ao CTO para corrigir os ${fileGaps.length} GAP(s) deste arquivo.`
        : resolveGaps
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
      if (gapsPerFile) {
        // PR-4: CTO-EDITOR escopado — resolve os GAPs deste arquivo sem tocar nos irmãos e sem
        // passar pelo normalizador (que regeneraria uma PRODUCT_SPEC inteira em cima do arquivo).
        // A5.7: o botão humano recorta o arquivo grande pelo MESMO caminho do laço (o guard acima já
        // garantiu que o recorte é possível) — dois recortes diferentes dariam dois resultados.
        const humanTarget = await gapFileTargetContent(filePath!, specMarkdown, fileGaps);
        runFileChatJob(
          jobId,
          { ...buildGapFileRequest("tooLarge" in humanTarget ? specMarkdown : humanTarget.text, filePath!, fileGaps, ctx, projectId, await gapSiblingBlock(projectId!, filePath!, fileGaps), !("tooLarge" in humanTarget) && humanTarget.digested), ...llm },
          agentsUrl,
          `Revisão dos ${fileGaps.length} GAP(s) deste arquivo pronta — confira e clique em “Aplicar ao arquivo”.`,
          gapFileEditsEnabled() ? specMarkdown : null,
        );
      } else if (filePath) {
        // Modo por-arquivo: edição cirúrgica via /invoke/raw (preserva o conteúdo original).
        runFileChatJob(jobId, { ...buildRawFileRequest(specMarkdown, messages, filePath, ctx, projectId), ...llm }, agentsUrl);
      } else {
        // Spec inteira: CTO normalizador via cto/async (regenera a PRODUCT_SPEC — correto aqui),
        // agora COM contexto dos irmãos + relatório de validação (e instrução de resolver GAPs).
        runChatJob(jobId, { ...buildChatMessage(specMarkdown, messages, ctx, resolveGaps, projectId), ...llm }, agentsUrl, resolveGaps ? "resolve_gaps" : "chat");
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
          // T1: já aqui, para a tela poder marcar o card de oferta como "revisão INCOMPLETA"
          // antes mesmo de baixar a spec pelo GET /:jobId.
          truncated: job.truncated === true,
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
      // T1: `truncated` = a resposta bateu no teto de saída do modelo e a spec revisada está
      // INCOMPLETA. Vai nos dois estados terminais: o cliente precisa OFERECER com aviso em vez
      // de encher o editor (uma spec cortada aplicada apaga o que o modelo não chegou a reescrever).
      const truncated = dbTerminal ? db!.truncated === true : (mem?.truncated === true || db?.truncated === true);

      if (status === "done") {
        // O cliente recebeu o resultado → para de ser reofertado pelo in-flight para sempre.
        if (db) void markSpecChatJobCollected(pool, jobId);
        // T4.3: devolve filePath/baseSha capturados NO ENVIO → o apply grava no arquivo certo
        // e detecta edição concorrente (o baseSha é o que o usuário via quando pediu a revisão).
        return reply.send({
          jobId, status: "done", specMarkdown, reply: replyText,
          filePath, baseSha, baseSpecSha: db?.baseSpecSha ?? null, truncated,
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
          filePath, baseSha, baseSpecSha: db?.baseSpecSha ?? null, truncated,
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
