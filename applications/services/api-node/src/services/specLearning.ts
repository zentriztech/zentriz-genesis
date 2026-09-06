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

type Db = Pick<Pool, "query">;

/** Kicks por tick: o tick é de 20 s e cada kick é 1 POST curto (a extração roda no agents). */
const MAX_KICKS_PER_TICK = 3;
/** Polls por tick: só telemetria — a persistência da lição não depende deste poll. */
const MAX_POLLS_PER_TICK = 5;
/** Teto do material enviado ao extrator (o extrator ainda corta em 38k). */
export const LEARNING_MATERIAL_MAX_CHARS = 24_000;
/** Depois disto, desistimos do poll (o TTL do job no agents é 45 min). */
const LEARNING_POLL_MAX_MIN = 20;
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
  /** GAPs da primeira validação do episódio (o que o validador apontou ANTES do laço). */
  gapsBefore: LearningFinding[];
  /** GAPs da última validação (o que sobrou). */
  gapsAfter: LearningFinding[];
  /** Caminhos reais dos arquivos tocados — usados só para ROTULAR (nunca vão no material). */
  filePaths: string[];
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

function findingLine(f: LearningFinding, labels: Map<string, string>): string {
  const sev = (f.severity ?? "info").toString();
  const icon = sev === "blocker" ? "🔴" : sev === "warning" ? "🟡" : "⚪";
  const where = f.file ? ` [${labels.get(f.file) ?? "arquivo"}]` : "";
  const cat = f.category ? ` (${f.category})` : "";
  const why = (f.rationale ?? "").trim().replace(/\s+/g, " ").slice(0, 320);
  return `- ${icon}${cat}${where} ${(f.title ?? "").trim().slice(0, 200)}${why ? ` — ${why}` : ""}`;
}

function roundLine(r: AutonomyRoundLog, labels: Map<string, string>): string {
  const target = r.filePath ? (labels.get(r.filePath) ?? "arquivo") : "spec inteira";
  const before = r.gapsBefore ?? null;
  const after = r.gapsAfter ?? null;
  const delta = before !== null && after !== null ? `GAPs ${before} → ${after}` : "GAPs não medidos";
  const sev = r.blockers !== null && r.blockers !== undefined ? ` (🔴 ${r.blockers} · 🟡 ${r.warnings ?? 0})` : "";
  const applied = r.applied ? "revisão aplicada" : "nada aplicado";
  const chars = r.specChars ? ` · ${r.specChars} chars` : "";
  const note = r.note ? ` · ${r.note.replace(/\s+/g, " ").slice(0, 240)}` : "";
  return `- rodada ${r.round} (passe ${r.pass ?? 0}, ${target}): ${delta}${sev} · ${applied}${chars}${note}`;
}

/**
 * Monta o relatório do episódio — a ENTRADA do extrator. Texto puro, sem nome de cliente/produto e
 * com os arquivos rotulados. É aqui que mora o valor: sem o "o que o validador apontou" e o "o que
 * a rodada mudou", o modelo só teria contadores e devolveria banalidade.
 */
export function buildLearningMaterial(ep: LearningEpisode): string {
  const labels = fileLabels([...ep.filePaths, ...ep.run.rounds.map((r) => r.filePath ?? "").filter(Boolean)]);
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
    run.lastError ? `Motivo do encerramento: ${run.lastError.replace(/\s+/g, " ").slice(0, 400)}` : "",
  ].filter(Boolean).join("\n"));

  if (ep.gapsBefore.length) {
    parts.push(`## GAPs que o validador adversarial apontou ANTES do laço (${ep.gapsBefore.length})\n` +
      ep.gapsBefore.slice(0, MAX_FINDINGS_PER_SIDE).map((f) => findingLine(f, labels)).join("\n"));
  }
  if (ep.gapsAfter.length) {
    parts.push(`## GAPs que CONTINUAVAM depois do laço (${ep.gapsAfter.length}) — resistiram às revisões\n` +
      ep.gapsAfter.slice(0, MAX_FINDINGS_PER_SIDE).map((f) => findingLine(f, labels)).join("\n"));
  } else if (ep.gapsBefore.length) {
    parts.push("## GAPs que CONTINUAVAM depois do laço: nenhum — todos foram resolvidos");
  }
  if (run.rounds.length) {
    parts.push(`## O que cada rodada fez\n${run.rounds.map((r) => roundLine(r, labels)).join("\n")}`);
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
 * GAPs do começo e do fim do episódio. Fonte: as validações do PROJETO na janela do laço — a
 * primeira delas é a que originou o laço (o `startAutonomyRun` exige uma validação anterior).
 */
export async function loadEpisodeFindings(
  db: Db, projectId: string, createdAt: string, finishedAt: string | null,
): Promise<{ before: LearningFinding[]; after: LearningFinding[] }> {
  const rows = (await db.query(
    `SELECT findings, created_at FROM spec_validation_runs
       WHERE project_id = $1
         AND created_at <= COALESCE($3::timestamptz, now()) + interval '5 minutes'
         AND created_at >= $2::timestamptz - interval '12 hours'
         AND status IN ('passed', 'failed')
       ORDER BY created_at ASC LIMIT 12`,
    [projectId, createdAt, finishedAt],
  )).rows as Array<Record<string, unknown>>;
  if (rows.length === 0) return { before: [], after: [] };
  const before = parseFindings(rows[0].findings);
  const after = rows.length > 1 ? parseFindings(rows[rows.length - 1].findings) : [];
  return { before, after };
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
  "rounds, last_error, created_at, finished_at, learning_job_id, learning_kicked_at";

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
    createdAt: String(r.created_at ?? ""),
    finishedAt: (r.finished_at as string | null) ?? null,
  };
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
      const { before, after } = await loadEpisodeFindings(db, run.projectId, run.createdAt, run.finishedAt)
        .catch((e) => { console.warn(`[SpecLearning] GAPs do episódio ${run.id}: ${msg(e)}`); return { before: [], after: [] }; });
      const material = buildLearningMaterial({ run, gapsBefore: before, gapsAfter: after, filePaths });
      const llm = await resolveWorkbenchLlm({ projectId: run.projectId, tenantId: run.tenantId }).catch(() => null);
      const body = JSON.stringify({
        material,
        kind: "spec",
        project_id: run.projectId,
        // Lição de COMO escrever spec não é de uma stack: `generic` é o que o retrieval sempre vê.
        stack_key: "generic",
        forbidden_terms: forbiddenTermsFor({
          projectTitle: identity.projectTitle, tenantName: identity.tenantName,
          projectId: run.projectId, filePaths,
        }),
        ...(llm ? agentsLlmFields(llm) : {}),
      });
      const started = JSON.parse(await post(`${base}/invoke/lesson_extract/async`, body, 30_000)) as { jobId?: string };
      if (!started.jobId) throw new Error("agents /invoke/lesson_extract/async não retornou jobId");
      await db.query(
        "UPDATE spec_autonomy_runs SET learning_job_id = $2, updated_at = now() WHERE id = $1",
        [run.id, started.jobId],
      ).catch(() => {});
      out.kicked += 1;
      console.info(`[SpecLearning] episódio ${run.id} (${run.status}) → job ${started.jobId}, material ${material.length} chars`);
    } catch (e) {
      await recordResult(db, run.id, { error: msg(e).slice(0, 300) });
      console.warn(`[SpecLearning] kick do episódio ${run.id} falhou: ${msg(e)}`);
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
