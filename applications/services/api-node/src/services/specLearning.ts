/**
 * specLearning.ts — G7/A3.3: a BANCADA passa a aprender (migração 096).
 *
 * PROBLEMA MEDIDO EM PROD (2026-09-05): `lessons_corpus` = **0 linhas**. O Genesis tem corpus,
 * embeddings (pgvector), indexer e retrieval (`context_loader` → CAG), mas o ÚNICO produtor de
 * lição era o Cyborg, no accept/reject de uma ENTREGA. O laço de refinamento de spec — onde um
 * validador adversarial aponta GAPs e o CTO reescreve, rodada após rodada — não deixava aprendizado
 * nenhum: cada produto novo repetia os mesmos GAPs do produto anterior.
 *
 * ⚖️ LEI (100% LLM): este arquivo **não decide o que é lição**. Ele monta o RELATÓRIO do episódio
 * (o que o validador apontou, o que cada rodada mudou, como terminou) e entrega ao
 * `/invoke/lesson_extract/async` do agents, onde o `LessonExtractor` — com prompt próprio de
 * engenharia de especificação — decide. Sem LLM não há lição (não existe fallback por regex).
 *
 * O que é responsabilidade DAQUI (transporte + veto de contaminação):
 *   • **Claim idempotente** (`learning_kicked_at`): uma extração por run, mesmo com 2 réplicas da
 *     api e mesmo depois de restart. Reclama ANTES de chamar o agents — dois kicks custariam duas
 *     chamadas de LLM pelo mesmo episódio.
 *   • **Desacoplado das transições**: varre runs TERMINADAS em vez de pendurar o gancho em cada
 *     caminho de `finishRun` (são muitos: succeeded/exhausted/stalled/failed/stopped + reaper).
 *     Um caminho novo de encerramento passa a aprender sem ninguém lembrar de plugar o gancho.
 *   • **Anonimização na ENTRADA**: o corpus é global (vira prompt de outros tenants), então o
 *     material vai com os arquivos rotulados (`arquivo A/B/C`) em vez dos nomes reais, e os termos
 *     identificáveis do projeto seguem como `forbidden_terms` — o veto do extrator descarta a lição
 *     que desobedecer o prompt.
 *   • **`stack_key: "generic"`**: lição de como ESCREVER spec não é de uma stack. O retrieval filtra
 *     `stack_key = <atual> OR 'generic'` — com um stack_key específico a lição nunca reapareceria
 *     para os outros projetos, que é justamente o ponto do G7.
 *
 * Não há flag nova: o interruptor real é `RAG_ENABLED` no container do agents (`off` responde
 * `mode:"off"` sem gastar modelo, e isso fica registrado em `learning_result` — foi o silêncio que
 * deixou o G7 invisível por meses).
 */
import type { Pool } from "pg";
import { httpPost, httpGet } from "../routes/specs.js";
import type { AutonomyRun, AutonomyRoundLog } from "./specAutonomy.js";
import { resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";
import { cutEvidence } from "./evidenceCut.js";

type Db = Pick<Pool, "query">;

/** Kicks por tick: o tick é de 20 s e cada kick é 1 POST curto (a extração roda no agents). */
const MAX_KICKS_PER_TICK = 3;
/** Polls por tick: só telemetria — a persistência da lição não depende deste poll. */
const MAX_POLLS_PER_TICK = 5;
/** Teto do material enviado ao extrator (o extrator ainda corta em 38k). */
export const LEARNING_MATERIAL_MAX_CHARS = 24_000;
/** Depois disto, desistimos do poll (o TTL do job no agents é 45 min). */
const LEARNING_POLL_MAX_MIN = 20;
/** Tentativas de kick por episódio: cobre janela de deploy/agents fora do ar sem virar loop. */
const MAX_KICK_ATTEMPTS = 3;
/** GAPs listados no relatório, por lado (início/fim). Mais que isso é ruído para a lição. */
const MAX_FINDINGS_PER_SIDE = 30;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface LearningFinding {
  severity?: string | null;
  title?: string | null;
  rationale?: string | null;
  file?: string | null;
  category?: string | null;
}

export interface LearningEpisode {
  run: Pick<AutonomyRun,
    "id" | "status" | "mode" | "round" | "passes" | "maxRounds" | "gapsInitial" | "gapsCurrent" |
    "rounds" | "lastError" | "createdAt" | "finishedAt">;
  /** GAPs da validação que ORIGINOU o laço (a última concluída antes de ele começar). */
  gapsBefore: LearningFinding[];
  /** GAPs da última validação concluída DENTRO do laço (o que sobrou). */
  gapsAfter: LearningFinding[];
  /**
   * 🔴 GAP-56: houve validação DEPOIS do laço? Sem isto, `gapsAfter` vazio era escrito no material
   * como *"nenhum — todos foram resolvidos"*, e a ausência de MEDIÇÃO virava prova de sucesso. É a
   * pior forma do defeito, porque a lição resultante é global: ensina a outros produtos que um laço
   * que não mediu nada "resolveu tudo".
   */
  afterMeasured?: boolean;
  /** Caminhos reais dos arquivos tocados — usados só para ROTULAR (nunca vão no material). */
  filePaths: string[];
  /**
   * 🔴 GAP-58: termos identificáveis a MASCARAR no texto livre (título do projeto, tenant, nomes de
   * arquivo). São os MESMOS que vão como `forbidden_terms` ao extrator: o que o veto proíbe na SAÍDA
   * não pode entrar na ENTRADA, senão o modelo cita o termo e a lição inteira é descartada.
   */
  maskTerms?: string[];
}

/** Rótulo estável e anônimo por arquivo: `arquivo A`, `arquivo B`, … */
export function fileLabels(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  for (const p of paths) {
    if (!p || out.has(p)) continue;
    const letter = i < 26 ? String.fromCharCode(65 + i) : `${i + 1}`;
    out.set(p, `arquivo ${letter}`);
    i += 1;
  }
  return out;
}

/**
 * Termos que NÃO podem aparecer na lição (veto de contaminação do corpus global).
 * Inclui título do projeto, nome do tenant, cada palavra "grande" desses nomes (o modelo tende a
 * citar só o nome do produto), os nomes de arquivo sem extensão e o prefixo do id.
 */
export function forbiddenTermsFor(opts: {
  projectTitle?: string | null; tenantName?: string | null; projectId?: string | null;
  filePaths?: string[];
}): string[] {
  const terms = new Set<string>();
  const push = (s: string | null | undefined) => {
    const v = (s ?? "").trim();
    if (v.length >= 4) terms.add(v);
  };
  for (const full of [opts.projectTitle, opts.tenantName]) {
    push(full);
    for (const word of (full ?? "").split(/[\s/_\-.]+/)) push(word);
  }
  for (const p of opts.filePaths ?? []) {
    const base = p.split("/").pop() ?? p;
    push(base);
    push(base.replace(/\.[a-z0-9]+$/i, ""));
  }
  if (opts.projectId) push(opts.projectId.slice(0, 8));
  // Palavras genéricas demais causariam veto de TODA lição útil (o veto é literal, não semântico).
  const GENERIC = new Set([
    "spec", "specs", "backend", "frontend", "mobile", "portal", "produto", "projeto", "readme",
    "index", "docs", "product_spec", "product", "apis", "core", "main", "novo", "sistema",
  ]);
  const isGeneric = (t: string) => {
    const low = t.toLowerCase();
    return GENERIC.has(low) || GENERIC.has(low.replace(/\.[a-z0-9]+$/, ""));
  };
  return [...terms].filter((t) => !isGeneric(t));
}

/**
 * 🔴 GAP-58 (2ª metade, medida DEPOIS do primeiro conserto): rotular `note`/`last_error` não bastou.
 * O maior volume de texto livre do material são os `title`/`rationale` dos findings — escritos pelo
 * VALIDADOR, que cita nome de produto e de arquivo à vontade. Provado no container de prod: mesmo com
 * as notas rotuladas, o material ainda continha `nvx`, `lastmile` e `modelo-dados` (dentro dos
 * `rationale`). Aqui os termos identificáveis — os MESMOS que vão como `forbidden_terms` ao extrator —
 * são mascarados, e sobra do padrão `<nome>.md` cai em rótulo genérico: lição de engenharia de spec
 * não precisa do nome do arquivo de ninguém.
 */
export function maskIdentifiers(text: string, terms: string[]): string {
  // Resíduo PRIMEIRO, e não por último: um nome de arquivo é o token mais longo e mais identificável.
  // Medido no próprio teste: mascarar termo antes quebrava `nvx-lastmile-backend.md` no meio
  // (`lastmile` → «produto») e o que sobrava do padrão de arquivo era só `backend.md` — o `nvx`
  // (nome do cliente, 3 chars, abaixo do piso de termo) escapava para o corpus GLOBAL.
  let out = text.replace(/\b[\w][\w.-]*\.(?:md|markdown)\b/gi, "«arquivo da spec»");
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (term.length < 4) continue;
    // Um termo com extensão é nome de ARQUIVO; sem extensão, é nome de projeto/tenant. Trocar tudo
    // por «produto» faria a lição dizer "o «produto» tem 198 mil chars" — máscara certa, frase falsa.
    const kind = /\.[a-z0-9]{1,8}$/i.test(term) ? "«arquivo da spec»" : "«produto»";
    out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), kind);
  }
  return out;
}

/**
 * 🔴 GAP-58 — ROTULA os nomes reais de arquivo que aparecem em TEXTO LIVRE.
 *
 * MEDIDO em prod 2026-09-07: o material ia com os campos `file`/`filePath` rotulados, mas
 * `note` e `last_error` são frases geradas pelo laço e passavam CRUAS — ex.:
 * *"`modelo-dados.md` salvo no disco (183918 → 191852 chars)"* e
 * *"último: `nvx-lastmile-backend.md` — CTO não entregou revisão"* (esse último carrega o nome do
 * PRODUTO DO CLIENTE). O corpus é global e `stack_key: "generic"`, então o custo é duplo: ou a
 * lição sai contaminada, ou ela cita o termo e o veto de `forbidden_terms` a DESCARTA — perdendo o
 * aprendizado do episódio. Substituição literal (transporte), não julgamento de conteúdo.
 */
export function labelFreeText(text: string, labels: Map<string, string>): string {
  let out = text;
  // Mais longos primeiro: `a/b/modelo-dados.md` antes de `modelo-dados.md`.
  const entries = [...labels.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [path, label] of entries) {
    const base = path.split("/").pop() ?? path;
    for (const needle of [path, base, base.replace(/\.[a-z0-9]+$/i, "")]) {
      if (needle.length < 4 || !out.includes(needle)) continue;
      // Fronteira que inclui `-` e `_`: sem ela, o arquivo `dados.md` da árvore rotulava o PEDAÇO
      // `dados` de `modelo-dados.md` (outro arquivo) e o texto virava "o modelo-arquivo A cita…" —
      // mentira sobre qual arquivo tem o problema, que é o oposto do que a lição precisa.
      const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?<![\\w-])${esc}(?![\\w-])`, "g"), label);
    }
  }
  return out;
}

/** Rótulo de arquivo + máscara de identificadores, na ordem: o rótulo informa, a máscara protege. */
function scrub(text: string, labels: Map<string, string>, terms: string[]): string {
  return maskIdentifiers(labelFreeText(text, labels), terms);
}

function findingLine(f: LearningFinding, labels: Map<string, string>, terms: string[]): string {
  const sev = (f.severity ?? "info").toString();
  const icon = sev === "blocker" ? "🔴" : sev === "warning" ? "🟡" : "⚪";
  const where = f.file ? ` [${labels.get(f.file) ?? "arquivo"}]` : "";
  const cat = f.category ? ` (${f.category})` : "";
  // GAP-58: `title`/`rationale` são texto do VALIDADOR e citam produto e arquivo pelo nome real.
  // 🔴 GAP-128: a lição é destilada DESTE texto — corte silencioso ensina meia verdade à Fábrica.
  const why = cutEvidence(scrub((f.rationale ?? "").trim(), labels, terms).replace(/\s+/g, " "), 320);
  const title = scrub((f.title ?? "").trim(), labels, terms).slice(0, 200);
  return `- ${icon}${cat}${where} ${title}${why ? ` — ${why}` : ""}`;
}

function roundLine(r: AutonomyRoundLog, labels: Map<string, string>, terms: string[]): string {
  const target = r.filePath ? (labels.get(r.filePath) ?? "arquivo") : "spec inteira";
  const before = r.gapsBefore ?? null;
  const after = r.gapsAfter ?? null;
  const delta = before !== null && after !== null ? `GAPs ${before} → ${after}` : "GAPs não medidos";
  const sev = r.blockers !== null && r.blockers !== undefined ? ` (🔴 ${r.blockers} · 🟡 ${r.warnings ?? 0})` : "";
  const applied = r.applied ? "revisão aplicada" : "nada aplicado";
  const chars = r.specChars ? ` · ${r.specChars} chars` : "";
  // GAP-58: `note` é frase livre do laço e cita o arquivo pelo nome REAL — rotular antes de cortar.
  const note = r.note ? ` · ${scrub(r.note, labels, terms).replace(/\s+/g, " ").slice(0, 240)}` : "";
  return `- rodada ${r.round} (passe ${r.pass ?? 0}, ${target}): ${delta}${sev} · ${applied}${chars}${note}`;
}

/**
 * Monta o relatório do episódio — a ENTRADA do extrator. Texto puro, sem nome de cliente/produto e
 * com os arquivos rotulados. É aqui que mora o valor: sem o "o que o validador apontou" e o "o que
 * a rodada mudou", o modelo só teria contadores e devolveria banalidade.
 */
export function buildLearningMaterial(ep: LearningEpisode): string {
  const labels = fileLabels([...ep.filePaths, ...ep.run.rounds.map((r) => r.filePath ?? "").filter(Boolean)]);
  // GAP-58: os MESMOS termos que vão como `forbidden_terms` ao extrator são mascarados já na entrada.
  // Mandar o termo proibido no material e depois vetar a lição que o repete é jogar contra o modelo.
  const terms = ep.maskTerms ?? [];
  const run = ep.run;
  const progress = run.mode === "per_file"
    ? `${run.round} arquivo(s) revisado(s) em ${run.passes} passe(s) de validação (teto ${run.maxRounds})`
    : `${run.round} rodada(s) de ${run.maxRounds}`;
  const parts: string[] = [];
  parts.push("# Episódio: laço autônomo de refinamento de especificação (Bancada do Genesis)");
  parts.push([
    `Resultado: **${run.status}**`,
    `Progresso: ${progress}`,
    `GAPs importantes: ${run.gapsInitial ?? "?"} no início → ${run.gapsCurrent ?? "?"} no fim`,
    `Arquivos na spec: ${Math.max(1, labels.size)}`,
    run.lastError
      // GAP-58: `last_error` já trouxe `nvx-lastmile-backend.md` (nome do produto do cliente) em prod.
      ? `Motivo do encerramento: ${scrub(run.lastError, labels, terms).replace(/\s+/g, " ").slice(0, 400)}`
      : "",
  ].filter(Boolean).join("\n"));

  if (ep.gapsBefore.length) {
    parts.push(`## GAPs que o validador adversarial apontou ANTES do laço (${ep.gapsBefore.length})\n` +
      ep.gapsBefore.slice(0, MAX_FINDINGS_PER_SIDE).map((f) => findingLine(f, labels, terms)).join("\n"));
  }
  if (ep.gapsAfter.length) {
    parts.push(`## GAPs que CONTINUAVAM depois do laço (${ep.gapsAfter.length}) — resistiram às revisões\n` +
      ep.gapsAfter.slice(0, MAX_FINDINGS_PER_SIDE).map((f) => findingLine(f, labels, terms)).join("\n"));
  } else if (ep.afterMeasured === true && ep.gapsBefore.length) {
    parts.push("## GAPs que CONTINUAVAM depois do laço: nenhum — todos foram resolvidos");
  } else {
    // 🔴 GAP-56: sem validação depois do laço não se sabe NADA sobre o resultado — dizer
    // "todos foram resolvidos" aqui é inventar o desfecho do episódio (e era o que acontecia:
    // medido em prod, runs `stopped` com 41 → 41 GAPs entravam com essa frase). A afirmação de
    // sucesso exige `afterMeasured === true`: **fail-closed**, porque quem esquecer de informar a
    // medição não pode ganhar o crédito por ela.
    parts.push([
      "## GAPs depois do laço: **NÃO MEDIDOS**",
      "O laço terminou sem uma nova validação adversarial concluída, então NÃO se sabe quais GAPs",
      "foram resolvidos. Não trate as revisões deste episódio como bem-sucedidas: use apenas o que",
      "os GAPs de ANTES e o histórico das rodadas mostram.",
    ].join("\n"));
  }
  if (run.rounds.length) {
    parts.push(`## O que cada rodada fez\n${run.rounds.map((r) => roundLine(r, labels, terms)).join("\n")}`);
  }
  parts.push([
    "## Pergunta a responder",
    "Que lições de ENGENHARIA DE ESPECIFICAÇÃO este episódio ensina para os PRÓXIMOS produtos —",
    "regras generalizáveis que evitariam esses GAPs desde a primeira escrita da spec?",
  ].join("\n"));
  const text = parts.join("\n\n");
  return text.length > LEARNING_MATERIAL_MAX_CHARS ? `${text.slice(0, LEARNING_MATERIAL_MAX_CHARS)}\n…[relatório truncado]` : text;
}

// ── leitura do episódio no banco ──────────────────────────────────────────────

function parseFindings(raw: unknown): LearningFinding[] {
  const arr = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(arr)) return [];
  return (arr as Record<string, unknown>[])
    .filter((f) => f && typeof f === "object")
    .map((f) => ({
      severity: (f.severity as string) ?? null,
      title: (f.title as string) ?? null,
      rationale: (f.rationale as string) ?? null,
      file: (f.file as string) ?? null,
      category: (f.category as string) ?? null,
    }))
    // `info` não sustenta rodada nem lição: o episódio girou em torno de blocker/warning.
    .filter((f) => f.severity === "blocker" || f.severity === "warning");
}

/**
 * GAPs do começo e do fim DESTE episódio.
 *
 * 🔴 GAP-55 (medido em prod 2026-09-07) — a janela era do PROJETO, não da RUN: começava
 * `created_at - 12 HORAS` e pegava `ORDER BY created_at ASC LIMIT 12`. No NVX LastMile havia
 * **30 validações** nessa janela contra **1** dentro do laço, então:
 *   • `before` = a validação MAIS ANTIGA das 12h (06/09 19:45, de OUTRO episódio);
 *   • `after`  = a **12ª mais antiga** (06/09 22:30) — anterior até ao INÍCIO do laço (07/09 07:22).
 * O relatório então ensinava ao corpus *"o laço levou 19 GAPs → 15"* enquanto a própria run
 * registrava **41 → 41** (nada resolvido). Duas mentiras somadas: material internamente
 * contraditório e crédito por melhora de outro episódio. Como o corpus é GLOBAL, o erro se
 * propaga para os próximos produtos — é o oposto do G7.
 *
 * Escopo correto (e o mesmo que o laço usou de fato):
 *   • `before` = ÚLTIMA validação concluída **até** o início do laço — exatamente a que
 *     `startAutonomyRun` leu para calcular `gaps_initial`;
 *   • `after`  = ÚLTIMA validação concluída **dentro** do laço; se não houve nenhuma,
 *     `afterMeasured = false` (ver GAP-56 — ausência de medição não é sucesso).
 */
export async function loadEpisodeFindings(
  db: Db, projectId: string, createdAt: string, finishedAt: string | null,
): Promise<{ before: LearningFinding[]; after: LearningFinding[]; afterMeasured: boolean }> {
  // A validação que ORIGINOU o laço. `+ 30s` cobre a corrida entre o fim da validação e o clique
  // que cria a run (o laço parte da última validação conhecida naquele instante).
  const beforeRow = (await db.query(
    `SELECT findings FROM spec_validation_runs
       WHERE project_id = $1 AND status IN ('passed', 'failed')
         AND created_at <= $2::timestamptz + interval '30 seconds'
       ORDER BY created_at DESC LIMIT 1`,
    [projectId, createdAt],
  )).rows[0] as Record<string, unknown> | undefined;
  // A última validação concluída DENTRO do laço (estritamente depois do início dele).
  const afterRow = (await db.query(
    `SELECT findings FROM spec_validation_runs
       WHERE project_id = $1 AND status IN ('passed', 'failed')
         AND created_at > $2::timestamptz + interval '30 seconds'
         AND created_at <= COALESCE($3::timestamptz, now()) + interval '5 minutes'
       ORDER BY created_at DESC LIMIT 1`,
    [projectId, createdAt, finishedAt],
  )).rows[0] as Record<string, unknown> | undefined;
  return {
    before: beforeRow ? parseFindings(beforeRow.findings) : [],
    after: afterRow ? parseFindings(afterRow.findings) : [],
    afterMeasured: Boolean(afterRow),
  };
}

interface ProjectIdentity { projectTitle: string | null; tenantName: string | null }

async function loadIdentity(db: Db, projectId: string): Promise<ProjectIdentity> {
  try {
    const r = (await db.query(
      `SELECT p.title, t.name AS tenant_name FROM projects p
         LEFT JOIN tenants t ON t.id = p.tenant_id WHERE p.id = $1`,
      [projectId],
    )).rows[0] as { title?: string; tenant_name?: string } | undefined;
    return { projectTitle: r?.title ?? null, tenantName: r?.tenant_name ?? null };
  } catch (e) {
    // Sem identidade não há veto confiável → melhor NÃO extrair do que contaminar o corpus.
    console.warn(`[SpecLearning] identidade do projeto ${projectId} indisponível: ${msg(e)}`);
    throw e;
  }
}

/**
 * Paths CANÔNICOS (`rel_dir/filename`) — a mesma forma que o `AutonomyRoundLog.filePath` e o
 * `finding.file` usam. Com `file_path` (absoluto no disco) os rótulos não casariam com as rodadas.
 */
async function loadFilePaths(db: Db, projectId: string): Promise<string[]> {
  const { loadSpecFiles } = await import("./specGapScope.js");
  const files = await loadSpecFiles(db, projectId).catch(() => []);
  return files.map((f) => f.path).filter(Boolean);
}

// ── o tick ────────────────────────────────────────────────────────────────────

export interface LearningTickResult {
  scanned: number; kicked: number; skipped: number; polled: number; finished: number;
}

export interface LearningTransport {
  post: (url: string, body: string, timeoutMs: number) => Promise<string>;
  get: (url: string, timeoutMs: number) => Promise<string>;
}

const RUN_COLS =
  "id, project_id, tenant_id, status, mode, round, passes, max_rounds, gaps_initial, gaps_current, " +
  "rounds, last_error, created_at, finished_at, learning_job_id, learning_kicked_at, learning_result";

/**
 * `TIMESTAMPTZ` chega do driver `pg` como **Date**, e `String(date)` produz
 * "Sat Sep 05 2026 12:15:39 GMT+0000 (Coordinated Universal Time)" — que o Postgres recusa
 * (`invalid input syntax for type timestamp with time zone`). MEDIDO em prod na primeira rodada do
 * G7: a janela de validações não era lida e o material ia sem os GAPs de antes/depois, que é
 * justamente o valor da lição. ISO-8601 sempre.
 */
function tsIso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  const parsed = new Date(String(v));
  return Number.isNaN(parsed.getTime()) ? String(v) : parsed.toISOString();
}

function rowToEpisodeRun(r: Record<string, unknown>): LearningEpisode["run"] & { projectId: string; tenantId: string | null } {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    tenantId: (r.tenant_id as string | null) ?? null,
    status: (r.status as AutonomyRun["status"]),
    mode: r.mode === "per_file" ? "per_file" : "whole",
    round: Number(r.round ?? 0),
    passes: Number(r.passes ?? 0),
    maxRounds: Number(r.max_rounds ?? 0),
    gapsInitial: r.gaps_initial === null || r.gaps_initial === undefined ? null : Number(r.gaps_initial),
    gapsCurrent: r.gaps_current === null || r.gaps_current === undefined ? null : Number(r.gaps_current),
    rounds: Array.isArray(r.rounds) ? (r.rounds as AutonomyRoundLog[]) : [],
    lastError: (r.last_error as string | null) ?? null,
    createdAt: tsIso(r.created_at) ?? "",
    finishedAt: tsIso(r.finished_at),
  };
}

/** Quantas vezes já tentamos extrair este episódio (guardado no próprio `learning_result`). */
function attemptsOf(raw: unknown): number {
  if (!raw) return 0;
  try {
    const o = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
    return Number(o?.attempts ?? 0) || 0;
  } catch { return 0; }
}

async function recordResult(db: Db, runId: string, result: Record<string, unknown>): Promise<void> {
  await db.query(
    "UPDATE spec_autonomy_runs SET learning_result = $2::jsonb, updated_at = now() WHERE id = $1",
    [runId, JSON.stringify(result)],
  ).catch((e) => console.warn(`[SpecLearning] registro do resultado ${runId}: ${msg(e)}`));
}

/**
 * Fase 1 — reclama runs terminadas e dispara a extração. Fase 2 — recolhe a telemetria dos jobs.
 * Nunca lança: aprender é acessório, não pode derrubar o worker da Bancada.
 */
export async function collectBancadaLessonsTick(
  db: Db, transport?: Partial<LearningTransport>,
): Promise<LearningTickResult> {
  const out: LearningTickResult = { scanned: 0, kicked: 0, skipped: 0, polled: 0, finished: 0 };
  const base = (process.env.API_AGENTS_URL ?? "").trim().replace(/\/$/, "");
  const post = transport?.post ?? httpPost;
  const get = transport?.get ?? httpGet;
  if (!base) return out; // sem agents não há extração (e não há como saber que houve episódio)

  // ── fase 1: kick ────────────────────────────────────────────────────────────
  let pending: Array<Record<string, unknown>> = [];
  try {
    pending = (await db.query(
      `SELECT ${RUN_COLS} FROM spec_autonomy_runs
         WHERE learning_kicked_at IS NULL AND finished_at IS NOT NULL
         ORDER BY finished_at ASC LIMIT $1`,
      [MAX_KICKS_PER_TICK],
    )).rows as Array<Record<string, unknown>>;
  } catch (e) {
    // Migração 096 ausente (banco atrás do código) → nada a fazer, sem ruído a cada 20 s.
    if (!/learning_kicked_at/.test(msg(e))) console.warn(`[SpecLearning] varredura falhou: ${msg(e)}`);
    return out;
  }
  out.scanned = pending.length;

  for (const row of pending) {
    const run = rowToEpisodeRun(row);
    // CLAIM primeiro: duas réplicas da api no mesmo tick custariam duas chamadas de LLM.
    const claimed = await db.query(
      "UPDATE spec_autonomy_runs SET learning_kicked_at = now(), updated_at = now() WHERE id = $1 AND learning_kicked_at IS NULL",
      [run.id],
    ).catch((e) => { console.warn(`[SpecLearning] claim ${run.id}: ${msg(e)}`); return { rowCount: 0 }; });
    if ((claimed.rowCount ?? 0) === 0) continue;

    if (run.rounds.length === 0) {
      // Laço que morreu antes da primeira rodada (spec travada, guarda de segurança) não tem
      // episódio para aprender. Fica reclamado com o motivo — sem isso, varreríamos para sempre.
      out.skipped += 1;
      await recordResult(db, run.id, { skipped: "sem rodadas executadas", status: run.status });
      continue;
    }

    try {
      const identity = await loadIdentity(db, run.projectId);
      const filePaths = await loadFilePaths(db, run.projectId);
      const { before, after, afterMeasured } = await loadEpisodeFindings(db, run.projectId, run.createdAt, run.finishedAt)
        .catch((e) => {
          console.warn(`[SpecLearning] GAPs do episódio ${run.id}: ${msg(e)}`);
          // Falhar em LER a medição não autoriza dizer que o laço resolveu tudo (GAP-56).
          return { before: [], after: [], afterMeasured: false };
        });
      // 🔴 GAP-58: os termos são calculados ANTES do material e o MESMO array serve às duas pontas —
      // máscara na entrada e `forbidden_terms` na saída. Dois cálculos independentes divergiriam, e a
      // divergência tem custo real: termo que passa na entrada e é vetado na saída DESCARTA a lição.
      const maskTerms = forbiddenTermsFor({
        projectTitle: identity.projectTitle, tenantName: identity.tenantName,
        projectId: run.projectId, filePaths,
      });
      const material = buildLearningMaterial({
        run, gapsBefore: before, gapsAfter: after, afterMeasured, filePaths, maskTerms,
      });
      const llm = await resolveWorkbenchLlm({ projectId: run.projectId, tenantId: run.tenantId }).catch(() => null);
      const body = JSON.stringify({
        material,
        kind: "spec",
        project_id: run.projectId,
        // Lição de COMO escrever spec não é de uma stack: `generic` é o que o retrieval sempre vê.
        stack_key: "generic",
        forbidden_terms: maskTerms,
        ...(llm ? agentsLlmFields(llm) : {}),
      });
      const started = JSON.parse(await post(`${base}/invoke/lesson_extract/async`, body, 30_000)) as { jobId?: string };
      if (!started.jobId) throw new Error("agents /invoke/lesson_extract/async não retornou jobId");
      // 🔴 GAP-57: `learning_result = NULL` é OBRIGATÓRIO aqui. Quando o 1º kick falha (retry do
      // `MAX_KICK_ATTEMPTS`), o erro fica gravado em `learning_result`; se o retry der certo e o
      // erro permanecer, a fase 2 — que seleciona `learning_result IS NULL` — **nunca** faz poll:
      // o episódio guarda para sempre o erro antigo. Medido em prod: a run 013ca0e5 exibia
      // `{"error":"connect ECONNREFUSED …","attempts":1}` enquanto o agents havia persistido
      // **4 lições** às 07:43:29 para esse mesmo job. É o defeito que o G7 nasceu para matar:
      // a telemetria do aprendizado mentindo — e mentindo no sentido pessimista, o que faz
      // parecer que a Bancada não aprende.
      const saved = await db.query(
        "UPDATE spec_autonomy_runs SET learning_job_id = $2, learning_result = NULL, updated_at = now() WHERE id = $1",
        [run.id, started.jobId],
      ).catch((e) => { console.warn(`[SpecLearning] job ${started.jobId} do episódio ${run.id} não persistido: ${msg(e)}`); return null; });
      if (!saved) {
        // Sem jobId gravado o episódio fica invisível (reclamado, sem poll e sem resultado):
        // registrar é o mínimo honesto — a lição pode até existir no corpus.
        await recordResult(db, run.id, { error: "jobId não persistido — resultado desconhecido", jobId: started.jobId });
      }
      out.kicked += 1;
      console.info(`[SpecLearning] episódio ${run.id} (${run.status}) → job ${started.jobId}, material ${material.length} chars`);
    } catch (e) {
      // Falha de kick é quase sempre TRANSITÓRIA — e a primeira que aconteceu em prod foi
      // exatamente isso: o tick disparou na janela em que o agents ainda rodava a imagem antiga
      // (sem a rota) e devolveu 404. Sem retry, aquele episódio perderia o aprendizado para sempre,
      // porque a run já estava reclamada. Devolvemos a run à fila até `MAX_KICK_ATTEMPTS`.
      const attempts = attemptsOf(row.learning_result) + 1;
      await recordResult(db, run.id, { error: msg(e).slice(0, 300), attempts });
      if (attempts < MAX_KICK_ATTEMPTS) {
        await db.query(
          "UPDATE spec_autonomy_runs SET learning_kicked_at = NULL, updated_at = now() WHERE id = $1",
          [run.id],
        ).catch(() => {});
      }
      console.warn(`[SpecLearning] kick do episódio ${run.id} falhou (tentativa ${attempts}/${MAX_KICK_ATTEMPTS}): ${msg(e)}`);
    }
  }

  // ── fase 2: poll (só telemetria — a lição já foi persistida pelo agents) ────
  let polling: Array<Record<string, unknown>> = [];
  try {
    polling = (await db.query(
      `SELECT id, learning_job_id, learning_kicked_at FROM spec_autonomy_runs
         WHERE learning_job_id IS NOT NULL AND learning_result IS NULL
         ORDER BY learning_kicked_at ASC LIMIT $1`,
      [MAX_POLLS_PER_TICK],
    )).rows as Array<Record<string, unknown>>;
  } catch {
    return out;
  }
  for (const row of polling) {
    const id = String(row.id);
    const jobId = String(row.learning_job_id ?? "");
    const kickedMs = Date.parse(String(row.learning_kicked_at ?? "")) || 0;
    if (kickedMs && Date.now() - kickedMs > LEARNING_POLL_MAX_MIN * 60_000) {
      await recordResult(db, id, { error: `sem resposta do agents em ${LEARNING_POLL_MAX_MIN} min`, jobId });
      continue;
    }
    out.polled += 1;
    try {
      const poll = JSON.parse(await get(`${base}/invoke/lesson_extract/status/${jobId}`, 30_000)) as
        { status?: string; result?: Record<string, unknown>; error?: string };
      if (poll.status === "done") {
        await recordResult(db, id, { ...(poll.result ?? {}), jobId });
        out.finished += 1;
        const r = poll.result ?? {};
        console.info(`[SpecLearning] episódio ${id}: mode=${String(r.mode)} extraídas=${String(r.extracted)} persistidas=${String(r.persisted)}`);
      } else if (poll.status === "error") {
        await recordResult(db, id, { error: (poll.error ?? "extração falhou").slice(0, 300), jobId });
        out.finished += 1;
      }
    } catch (e) {
      const m = msg(e);
      if (/\b404\b/.test(m)) {
        // TTL do job estourou (45 min) — a lição pode ter sido persistida; só a telemetria morreu.
        await recordResult(db, id, { error: "agents perdeu o job (TTL) — resultado desconhecido", jobId });
        out.finished += 1;
      } else {
        console.warn(`[SpecLearning] poll ${id}: ${m}`);
      }
    }
  }
  return out;
}
