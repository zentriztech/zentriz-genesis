/**
 * specAutonomy.ts — MODO AUTÔNOMO da Bancada (migração 090).
 *
 * Pedido do Jean (2026-09-05): *"[x] Ativar modo autônomo, para o CTO entrar em modo recursivo
 * registrando ações e resolver os GAPs atuais, rodar o validar, e repetir até 5 vezes"*, com
 * *"apenas GAPs vermelhos e amarelos sustenta a necessidade de mais uma rodada"*.
 *
 * O que isto automatiza são as QUATRO ações manuais de hoje, encadeadas pelo servidor:
 *   Resolver GAPs (CTO) → Salvar rascunho (disco) → Validar (adversarial) → contar GAPs → repetir.
 * O passo "Salvar rascunho" é o que o humano esquecia: a validação lê do DISCO, então sem a
 * escrita a rodada seguinte revalidaria a spec ANTIGA e o laço nunca convergiria.
 *
 * DESENHO (ver project/docs/plans/BANCADA-MODO-AUTONOMO-GAPS-2026-09-05.md):
 *  • Estado 100% no Postgres (`spec_autonomy_runs`) e avanço pelo tick de 20 s do specChatWorker —
 *    zero processos novos, e um restart da api no meio de uma rodada NÃO perde o laço.
 *  • Toda transição é um claim (`WHERE id = $ AND status = <esperado>` + rowCount): dois ticks
 *    sobrepostos não aplicam a mesma spec duas vezes.
 *  • Cada rodada grava um item em `rounds` (JSONB) — o "registrando ações" do pedido — e um turno
 *    de assistente em `spec_chat_messages`, para as ações aparecerem NO CHAT da Bancada.
 *  • Reusa o caminho do botão manual (`dispatchResolveGapsJob` → mesmo contexto, prompt e gate H4)
 *    e o ciclo de validação (`startValidation` + `projectFindingsState`). Nada é reimplementado.
 *
 * GUARDAS (cada uma fecha um modo de falha real deste sistema — GAPs A–L do plano):
 *  • edição humana no meio do laço → NÃO sobrescreve (stalled);
 *  • revisão que ENCOLHE a spec (< 70% dos chars) → NÃO aplica (stalled);
 *  • spec idêntica / GAPs que não caem 2× seguidas → stalled (não queima as 5 rodadas em vão);
 *  • `SPEC_EDITABLE_STATUSES` revalidado a CADA rodada (a spec pode entrar em fábrica no meio);
 *  • rate-limit de 4 validações/h NÃO derruba o laço: a rodada espera e revalida no tick seguinte;
 *  • deadline global + kill-switch `SPEC_AUTONOMY=off`.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Pool } from "pg";
import { sha256Hex } from "../lib/specTreeHash.js";
import { projectFindingsState, type EnrichedFinding } from "./findingTriage.js";
import { startValidation } from "./specValidation.js";
import { getSpecChatJob } from "./specChatJobs.js";
import { snapshotSpecFile } from "./specSnapshots.js";
import { resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";

type Db = Pick<Pool, "query" | "connect">;

export type AutonomyStatus =
  | "pending" | "cto_running" | "applying" | "validating"
  | "succeeded" | "exhausted" | "stalled" | "failed" | "stopped";

const ACTIVE_STATUSES: AutonomyStatus[] = ["pending", "cto_running", "applying", "validating"];

/** Teto de rodadas do pedido do Jean. Serve de teto DURO também para o body da rota. */
export const AUTONOMY_MAX_ROUNDS = 5;
/**
 * Deadline global: 5 rodadas × (40 min de teto do job do CTO + validação) ≈ 3,75 h. 4,5 h dá
 * folga sem deixar um laço órfão vivo para sempre. Expira a ESPERA, nunca o TRABALHO.
 */
export const AUTONOMY_DEADLINE_MS = 4.5 * 60 * 60_000;
/** Abaixo disto a "revisão" perdeu conteúdo — o CTO normalizador já descartou spec em prod. */
const MIN_SHRINK_RATIO = 0.7;
/** Duas rodadas seguidas sem derrubar GAP importante = o modelo não está convergindo. */
const MAX_NO_PROGRESS = 2;

/**
 * Kill-switch sem redeploy. **Nasce DESLIGADO** (G4, 2026-09-05): a feature escreve na spec do
 * cliente sem humano no meio, então qualquer instalação nova (dev, homolog, um deploy futuro que
 * esqueça o `.env`) tem de ser fail-closed. Em prod a flag é ligada EXPLICITAMENTE no `.env`.
 */
export function autonomyEnabled(): boolean {
  return (process.env.SPEC_AUTONOMY ?? "off").trim().toLowerCase() !== "off";
}

// ── T2: guarda de INTEGRIDADE da revisão (truncamento / perda de seções) ─────

/** Títulos de seção de nível 2 — a unidade que o CTO normalizador perde quando corta. */
function headingsOf(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1].trim().toLowerCase());
  }
  return out;
}

/** Cercas de código abertas e não fechadas indicam documento cortado no meio de um bloco. */
function fenceCount(md: string): number {
  let n = 0;
  for (const line of md.split("\n")) if (/^\s*```/.test(line)) n += 1;
  return n;
}

export type RevisionIntegrity = { ok: true } | { ok: false; reason: string; detail: string };

/**
 * Recusa aplicar uma revisão INCOMPLETA. Medido em prod 2026-09-05: a spec do NVX LastMile
 * (98.045 chars) faz o CTO regenerar o documento inteiro e bater no teto de 64k tokens de SAÍDA
 * do Opus 5 — `stop_reason=max_tokens`. O texto para no meio de uma linha (`… ON deliveries(
 * courier_id) WHERE`) e, se aplicado, o que o modelo não chegou a reescrever é APAGADO da spec.
 * A guarda de encolhimento (70%) não pega isso: cortar 3 das 14 seções ainda deixa 80% dos chars.
 *
 * Três sinais, do mais forte para o mais fraco:
 *  1. `truncated` — o próprio provedor disse que cortou (`_truncated` do runtime);
 *  2. contagem de `##` menor que a base — tolerante a RENOMEAÇÃO (o set-diff só compõe a mensagem);
 *  3. cerca ``` ímpar quando a base tinha número par — bloco de código aberto e nunca fechado.
 */
export function assessRevisionIntegrity(base: string, revised: string, truncated: boolean): RevisionIntegrity {
  if (truncated) {
    return {
      ok: false,
      reason: "truncada no teto de saída do modelo",
      detail: `a resposta do CTO foi CORTADA no limite de tokens de saída — o fim do documento não chegou a ser gerado (revisão com ${revised.length} caracteres; a spec atual tem ${base.length})`,
    };
  }
  const baseHeads = headingsOf(base);
  const revHeads = headingsOf(revised);
  if (revHeads.length < baseHeads.length) {
    const missing = baseHeads.filter((h) => !revHeads.includes(h)).slice(0, 6);
    return {
      ok: false,
      reason: "seções desaparecidas",
      detail: `a revisão tem ${revHeads.length} seções contra ${baseHeads.length} da spec atual` +
        (missing.length ? ` — sumiram, entre outras: ${missing.map((h) => `“${h}”`).join(", ")}` : ""),
    };
  }
  const baseFences = fenceCount(base);
  const revFences = fenceCount(revised);
  if (revFences % 2 === 1 && baseFences % 2 === 0) {
    return {
      ok: false,
      reason: "bloco de código aberto",
      detail: `a revisão terminou com um bloco de código sem fechar (${revFences} cercas, ímpar) — sinal de documento cortado no meio`,
    };
  }
  return { ok: true };
}

export interface AutonomyRoundLog {
  round: number;
  startedAt: string;
  finishedAt?: string;
  chatJobId?: string | null;
  validationRunId?: string | null;
  gapsBefore?: number | null;
  gapsAfter?: number | null;
  blockers?: number | null;
  warnings?: number | null;
  applied?: boolean;
  specChars?: number | null;
  note?: string;
}

export interface AutonomyRun {
  id: string;
  projectId: string;
  tenantId: string | null;
  ownerUserId: string;
  status: AutonomyStatus;
  round: number;
  maxRounds: number;
  chatJobId: string | null;
  validationRunId: string | null;
  baseSpecSha: string | null;
  gapsInitial: number | null;
  gapsCurrent: number | null;
  noProgressStreak: number;
  rounds: AutonomyRoundLog[];
  lastError: string | null;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const COLS =
  "id, project_id, tenant_id, owner_user_id, status, round, max_rounds, chat_job_id, validation_run_id, " +
  "base_spec_sha, gaps_initial, gaps_current, no_progress_streak, rounds, last_error, deadline_at, " +
  "created_at, updated_at, finished_at";

function rowToRun(r: Record<string, unknown>): AutonomyRun {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    tenantId: (r.tenant_id as string | null) ?? null,
    ownerUserId: String(r.owner_user_id ?? ""),
    status: (r.status as AutonomyStatus) ?? "pending",
    round: Number(r.round ?? 0),
    maxRounds: Number(r.max_rounds ?? AUTONOMY_MAX_ROUNDS),
    chatJobId: (r.chat_job_id as string | null) ?? null,
    validationRunId: (r.validation_run_id as string | null) ?? null,
    baseSpecSha: (r.base_spec_sha as string | null) ?? null,
    gapsInitial: r.gaps_initial === null || r.gaps_initial === undefined ? null : Number(r.gaps_initial),
    gapsCurrent: r.gaps_current === null || r.gaps_current === undefined ? null : Number(r.gaps_current),
    noProgressStreak: Number(r.no_progress_streak ?? 0),
    rounds: Array.isArray(r.rounds) ? (r.rounds as AutonomyRoundLog[]) : [],
    lastError: (r.last_error as string | null) ?? null,
    deadlineAt: String(r.deadline_at ?? ""),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isTerminalAutonomyStatus(s: AutonomyStatus): boolean {
  return !ACTIVE_STATUSES.includes(s);
}

// ── contagem de GAPs "importantes" (a regra de parada do Jean) ────────────────

export interface GapTally { important: number; blockers: number; warnings: number; active: number; info: number }

/**
 * "Apenas GAPs vermelhos e amarelos sustenta mais uma rodada" (Jean, 2026-09-05).
 * ATIVO = sem triagem humana (`ignored` é risco aceito, `refuted` é falso positivo — nenhum dos
 * dois conta). `info` NUNCA sustenta rodada: é o "baixo risco" do pedido.
 * `countFindings` do findingTriage não expõe `warningsActive`, por isso derivamos aqui.
 */
export function tallyGaps(findings: EnrichedFinding[]): GapTally {
  const t: GapTally = { important: 0, blockers: 0, warnings: 0, active: 0, info: 0 };
  for (const f of findings) {
    if (f.triage) continue;
    t.active += 1;
    if (f.severity === "blocker") { t.blockers += 1; t.important += 1; }
    else if (f.severity === "warning") { t.warnings += 1; t.important += 1; }
    else t.info += 1;
  }
  return t;
}

async function currentGaps(db: Db, projectId: string): Promise<GapTally> {
  const state = await projectFindingsState(db, projectId);
  return tallyGaps(state.findings);
}

// ── leitura/escrita da spec primária (espelha PATCH /api/projects/:id/spec-content) ──

interface PrimarySpec { filePath: string; content: string; sha: string }

async function readPrimarySpec(db: Db, projectId: string): Promise<PrimarySpec | null> {
  const row = (await db.query(
    "SELECT file_path FROM project_spec_files WHERE project_id = $1 ORDER BY is_primary DESC, created_at DESC LIMIT 1",
    [projectId],
  )).rows[0] as { file_path?: string } | undefined;
  if (!row?.file_path) return null;
  const buf = await readFile(row.file_path).catch(() => null);
  if (buf === null) return null;
  return { filePath: row.file_path, content: buf.toString("utf-8"), sha: sha256Hex(buf) };
}

/**
 * Mesma sequência do PATCH manual: conteúdo → content_sha256 → spec_dirty_at.
 *
 * G2: antes de sobrescrever, o conteúdo ANTERIOR vai para `project_spec_snapshots`. Aqui o
 * snapshot é OBRIGATÓRIO (lança se falhar): o laço escreve sem humano no meio, então sem rede de
 * segurança ele não escreve. `previous` é o que está no disco AGORA (já lido pelo chamador).
 */
async function writePrimarySpec(
  db: Db, projectId: string, filePath: string, content: string,
  snapshot: { previous: string; reason: string; createdBy?: string | null },
): Promise<void> {
  const saved = await snapshotSpecFile(db as Pool, {
    projectId, filePath, content: snapshot.previous,
    reason: snapshot.reason, createdBy: snapshot.createdBy ?? null,
  });
  if (!saved) {
    throw new Error("não foi possível guardar o snapshot da spec atual — escrita abortada para não perder conteúdo");
  }
  await writeFile(filePath, content, "utf-8");
  await db.query(
    "UPDATE project_spec_files SET content_sha256 = $1 WHERE project_id = $2 AND file_path = $3",
    [sha256Hex(Buffer.from(content, "utf-8")), projectId, filePath],
  );
  await db.query("UPDATE projects SET spec_dirty_at = now() WHERE id = $1", [projectId]);
}

async function projectStatusOf(db: Db, projectId: string): Promise<string | null> {
  const row = (await db.query("SELECT status FROM projects WHERE id = $1", [projectId])).rows[0] as
    { status?: string } | undefined;
  return row?.status ? String(row.status) : null;
}

async function specEditable(db: Db, projectId: string): Promise<{ ok: true } | { ok: false; status: string }> {
  const { SPEC_EDITABLE_STATUSES } = await import("./projectStatus.js");
  const st = await projectStatusOf(db, projectId);
  if (!st || !SPEC_EDITABLE_STATUSES.has(st)) return { ok: false, status: st ?? "desconhecido" };
  return { ok: true };
}

// ── persistência do log de ações ─────────────────────────────────────────────

/** Turno de assistente SEM job_id: o log do laço aparece no chat da Bancada, não num arquivo. */
async function postChatNote(db: Db, run: AutonomyRun, content: string): Promise<void> {
  try {
    await db.query(
      `INSERT INTO spec_chat_messages (project_id, tenant_id, role, content, file_path, job_id)
         VALUES ($1, $2, 'assistant', $3, NULL, NULL)`,
      [run.projectId, run.tenantId, content],
    );
  } catch (e) {
    console.warn(`[SpecAutonomy] nota no chat falhou (best-effort): ${msg(e)}`);
  }
}

async function appendRoundLog(db: Db, runId: string, entry: AutonomyRoundLog): Promise<void> {
  await db.query(
    "UPDATE spec_autonomy_runs SET rounds = rounds || $2::jsonb, updated_at = now() WHERE id = $1",
    [runId, JSON.stringify([entry])],
  );
}

/** Atualiza o ÚLTIMO item de `rounds` (fecha a rodada com o resultado medido). */
async function patchLastRound(db: Db, run: AutonomyRun, patch: Partial<AutonomyRoundLog>): Promise<void> {
  const rounds = [...run.rounds];
  if (rounds.length === 0) return;
  rounds[rounds.length - 1] = { ...rounds[rounds.length - 1], ...patch, finishedAt: new Date().toISOString() };
  await db.query("UPDATE spec_autonomy_runs SET rounds = $2::jsonb, updated_at = now() WHERE id = $1",
    [run.id, JSON.stringify(rounds)]);
}

const FINAL_LABEL: Record<string, string> = {
  succeeded: "✅ Modo autônomo concluído — nenhum GAP vermelho ou amarelo ativo restante",
  exhausted: "⏹️ Modo autônomo encerrado no limite de rodadas",
  stalled: "⚠️ Modo autônomo interrompido (sem progresso ou guarda de segurança)",
  failed: "🔴 Modo autônomo falhou",
  stopped: "⏹️ Modo autônomo interrompido pelo usuário",
};

async function finishRun(
  db: Db, run: AutonomyRun, status: AutonomyStatus, note: string, extra: { gaps?: GapTally | null } = {},
): Promise<void> {
  const r = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = $2, last_error = $3, gaps_current = COALESCE($4, gaps_current),
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = ANY($5::text[])`,
    [run.id, status, note.slice(0, 800), extra.gaps ? extra.gaps.important : null, ACTIVE_STATUSES],
  );
  if ((r.rowCount ?? 0) === 0) return; // outra transição já encerrou (claim perdido)
  const tally = extra.gaps
    ? ` · GAPs importantes restantes: ${extra.gaps.important} (🔴 ${extra.gaps.blockers} · 🟡 ${extra.gaps.warnings})`
    : "";
  await postChatNote(db, run,
    `${FINAL_LABEL[status] ?? "Modo autônomo encerrado"} — rodadas executadas: ${run.round}/${run.maxRounds}${tally}\n\n${note}`);
  console.info(`[SpecAutonomy] run=${run.id} project=${run.projectId} → ${status} (round ${run.round}/${run.maxRounds}): ${note}`);
}

// ── ciclo de vida ────────────────────────────────────────────────────────────

export type StartAutonomyResult =
  | { ok: true; run: AutonomyRun }
  | { ok: false; status: number; code: string; message: string };

/**
 * Cria o laço. Recusa cedo (com motivo acionável) tudo o que tornaria o laço inútil ou perigoso:
 * flag desligada, spec em fábrica, spec ilegível no disco, sem validação anterior, sem GAP
 * importante ativo, ou laço já ativo no mesmo projeto (índice único parcial da migração 090).
 */
export async function startAutonomyRun(db: Db, opts: {
  projectId: string; tenantId: string | null; ownerUserId: string; maxRounds?: number;
}): Promise<StartAutonomyResult> {
  if (!autonomyEnabled()) {
    return { ok: false, status: 503, code: "AUTONOMY_DISABLED", message: "Modo autônomo desligado nesta instalação (SPEC_AUTONOMY=off)." };
  }
  const maxRounds = Math.min(Math.max(Math.trunc(opts.maxRounds ?? AUTONOMY_MAX_ROUNDS) || AUTONOMY_MAX_ROUNDS, 1), AUTONOMY_MAX_ROUNDS);

  const editable = await specEditable(db, opts.projectId);
  if (!editable.ok) {
    return { ok: false, status: 409, code: "SPEC_LOCKED", message: `Spec bloqueada para edição: projeto em '${editable.status}'. Pare o projeto ou use Evoluir.` };
  }
  const spec = await readPrimarySpec(db, opts.projectId);
  if (!spec) {
    return { ok: false, status: 422, code: "SPEC_FILES_MISSING", message: "Spec sem arquivo legível no disco — o modo autônomo não tem o que revisar." };
  }
  const state = await projectFindingsState(db, opts.projectId);
  if (!state.latestRunId) {
    return { ok: false, status: 409, code: "NO_VALIDATION", message: "Rode Validar uma vez antes: o modo autônomo parte dos GAPs da última validação." };
  }
  const gaps = tallyGaps(state.findings);
  if (gaps.important === 0) {
    return { ok: false, status: 409, code: "NO_GAPS", message: `Nenhum GAP vermelho ou amarelo ATIVO na última validação${gaps.info ? ` (${gaps.info} de baixo risco não sustentam rodada)` : ""}.` };
  }

  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO spec_autonomy_runs
         (id, project_id, tenant_id, owner_user_id, status, round, max_rounds, gaps_initial, gaps_current, deadline_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6, $6, now() + ($7 || ' milliseconds')::interval)`,
      [id, opts.projectId, opts.tenantId, opts.ownerUserId, maxRounds, gaps.important, String(AUTONOMY_DEADLINE_MS)],
    );
  } catch (e) {
    // 23505 = índice único parcial → já existe laço ativo neste projeto.
    if ((e as { code?: string }).code === "23505") {
      const active = await getActiveAutonomyRun(db, opts.projectId);
      return { ok: false, status: 409, code: "AUTONOMY_ALREADY_RUNNING", message: `Já existe um modo autônomo em andamento neste projeto (rodada ${active?.round ?? "?"}/${active?.maxRounds ?? maxRounds}).` };
    }
    throw e;
  }
  const run = (await getAutonomyRun(db, id))!;
  await postChatNote(db, run,
    `🤖 **Modo autônomo ativado** — vou resolver os GAPs, salvar, validar e repetir por até ${maxRounds} rodada(s), enquanto sobrar GAP 🔴 blocker ou 🟡 warning ATIVO (itens de baixo risco não sustentam rodada).\n\nPonto de partida: ${gaps.important} GAP(s) importante(s) — 🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}.`);
  // Primeira rodada já neste request (latência), sem bloquear a resposta.
  setImmediate(() => { void advanceAutonomyRun(db, id).catch((e) => console.error(`[SpecAutonomy] advance inicial falhou: ${msg(e)}`)); });
  return { ok: true, run };
}

export async function getAutonomyRun(db: Db, id: string): Promise<AutonomyRun | null> {
  const r = (await db.query(`SELECT ${COLS} FROM spec_autonomy_runs WHERE id = $1`, [id])).rows[0] as
    Record<string, unknown> | undefined;
  return r ? rowToRun(r) : null;
}

export async function getActiveAutonomyRun(db: Db, projectId: string): Promise<AutonomyRun | null> {
  const r = (await db.query(
    `SELECT ${COLS} FROM spec_autonomy_runs WHERE project_id = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
    [projectId, ACTIVE_STATUSES],
  )).rows[0] as Record<string, unknown> | undefined;
  return r ? rowToRun(r) : null;
}

/** Último laço do projeto (ativo ou terminal) — é o que a Bancada desenha ao abrir a tela. */
export async function getLatestAutonomyRun(db: Db, projectId: string): Promise<AutonomyRun | null> {
  const r = (await db.query(
    `SELECT ${COLS} FROM spec_autonomy_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  )).rows[0] as Record<string, unknown> | undefined;
  return r ? rowToRun(r) : null;
}

/** Parada pelo humano. Não cancela o job do CTO em voo (o resultado dele continua coletável). */
export async function stopAutonomyRun(db: Db, id: string): Promise<boolean> {
  const run = await getAutonomyRun(db, id);
  if (!run || isTerminalAutonomyStatus(run.status)) return false;
  await finishRun(db, run, "stopped", "Interrompido pelo usuário. A revisão em voo (se houver) continua disponível no chat.");
  return true;
}

// ── a máquina de estados ─────────────────────────────────────────────────────

/**
 * Um tick: avança TODAS as runs vivas (mais antiga primeiro). Chamado pelo specChatWorker.
 * Nunca lança — uma run com problema não pode parar as outras.
 */
export async function advanceAutonomyRunsTick(db: Db): Promise<{ scanned: number; advanced: number }> {
  const out = { scanned: 0, advanced: 0 };
  if (!autonomyEnabled()) return out;
  let ids: string[] = [];
  try {
    ids = ((await db.query(
      `SELECT id FROM spec_autonomy_runs WHERE status = ANY($1::text[]) ORDER BY updated_at LIMIT 10`,
      [ACTIVE_STATUSES],
    )).rows as Array<{ id: string }>).map((r) => String(r.id));
  } catch (e) {
    console.warn(`[SpecAutonomy] varredura falhou: ${msg(e)}`);
    return out;
  }
  out.scanned = ids.length;
  for (const id of ids) {
    try {
      if (await advanceAutonomyRun(db, id)) out.advanced += 1;
    } catch (e) {
      console.error(`[SpecAutonomy] run=${id} erro no avanço: ${msg(e)}`);
    }
  }
  return out;
}

/** Avança UMA run um passo. Devolve true se houve transição de estado. */
export async function advanceAutonomyRun(db: Db, id: string): Promise<boolean> {
  const run = await getAutonomyRun(db, id);
  if (!run || isTerminalAutonomyStatus(run.status)) return false;

  // Deadline global: encerra a ESPERA (o job do CTO em voo permanece coletável pelo worker).
  if (run.deadlineAt && Date.now() > new Date(run.deadlineAt).getTime()) {
    const gaps = await currentGaps(db, run.projectId).catch(() => null);
    await finishRun(db, run, "stalled", "Tempo máximo do laço autônomo atingido (4h30). Rode Validar para ver o estado atual da spec.", { gaps });
    return true;
  }

  switch (run.status) {
    case "pending": return startRound(db, run);
    case "cto_running": return checkCto(db, run);
    case "applying": return applyAndValidate(db, run);
    case "validating": return checkValidation(db, run);
    default: return false;
  }
}

/** pending → dispara Resolver GAPs pelo MESMO caminho do botão manual. */
async function startRound(db: Db, run: AutonomyRun): Promise<boolean> {
  if (run.round >= run.maxRounds) {
    const gaps = await currentGaps(db, run.projectId).catch(() => null);
    await finishRun(db, run, "exhausted",
      `Limite de ${run.maxRounds} rodada(s) atingido. Revise os GAPs restantes na aba GAPs e triagem o que for risco aceito.`, { gaps });
    return true;
  }
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled", `A spec deixou de ser editável no meio do laço (projeto em '${editable.status}') — nada foi alterado.`);
    return true;
  }
  const spec = await readPrimarySpec(db, run.projectId);
  if (!spec) {
    await finishRun(db, run, "failed", "Spec sem arquivo legível no disco — laço encerrado sem alterar nada.");
    return true;
  }
  const gaps = await currentGaps(db, run.projectId);
  if (gaps.important === 0) {
    await finishRun(db, run, "succeeded",
      `Nenhum GAP vermelho ou amarelo ATIVO restante${gaps.info ? ` (${gaps.info} item(ns) de baixo risco seguem em aberto, por desenho)` : ""}.`, { gaps });
    return true;
  }
  const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
  if (!agentsUrl) {
    await finishRun(db, run, "failed", "Serviço de agentes não configurado (API_AGENTS_URL) — laço encerrado.");
    return true;
  }

  const nextRound = run.round + 1;
  const jobId = randomUUID();
  // CLAIM antes do dispatch: se dois ticks se sobrepuserem, só um dispara o CTO (Opus 5 é caro).
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'cto_running', round = $2, chat_job_id = $3, base_spec_sha = $4,
            gaps_current = $5, validation_run_id = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending' AND round = $6`,
    [run.id, nextRound, jobId, spec.sha, gaps.important, run.round],
  );
  if ((claim.rowCount ?? 0) === 0) return false;

  await appendRoundLog(db, run.id, {
    round: nextRound, startedAt: new Date().toISOString(), chatJobId: jobId,
    gapsBefore: gaps.important, blockers: gaps.blockers, warnings: gaps.warnings,
    specChars: spec.content.length,
    note: `Resolver GAPs enviado ao CTO (${gaps.important} GAP importante(s)).`,
  });

  const { dispatchResolveGapsJob } = await import("../routes/specChat.js");
  try {
    const llm = agentsLlmFields(await resolveWorkbenchLlm({ projectId: run.projectId, tenantId: run.tenantId }));
    const res = await dispatchResolveGapsJob({
      jobId, projectId: run.projectId, tenantId: run.tenantId, ownerUserId: run.ownerUserId,
      specMarkdown: spec.content, agentsUrl, llm,
      userMessage: `🤖 Modo autônomo — rodada ${nextRound}/${run.maxRounds}: resolver ${gaps.important} GAP(s) importante(s) (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}).`,
    });
    if (!res.ok) {
      // O contexto do chat não viu GAP ativo → nada a resolver = sucesso, não erro (GAP-E).
      const fresh = (await getAutonomyRun(db, run.id))!;
      await finishRun(db, fresh, "succeeded", "Nenhum GAP ATIVO restante ao montar a rodada — laço encerrado com sucesso.");
      return true;
    }
    console.info(`[SpecAutonomy] run=${run.id} rodada ${nextRound}/${run.maxRounds} → CTO job=${jobId} (${res.gaps} GAPs no contexto)`);
    return true;
  } catch (e) {
    const fresh = (await getAutonomyRun(db, run.id))!;
    await finishRun(db, fresh, "failed", `Falha ao acionar o CTO: ${msg(e).slice(0, 300)}`);
    return true;
  }
}

/** cto_running → o job é durável: só LEMOS o estado (quem finaliza é o poll/worker do chat). */
async function checkCto(db: Db, run: AutonomyRun): Promise<boolean> {
  if (!run.chatJobId) {
    await finishRun(db, run, "failed", "Rodada sem job do CTO associado (estado inconsistente).");
    return true;
  }
  const job = await getSpecChatJob(db, run.chatJobId);
  if (!job) {
    // A escrita do job pode ter falhado (createSpecChatJob é best-effort). Sem linha não há o que
    // coletar: dá a rodada por perdida em vez de esperar para sempre.
    await finishRun(db, run, "failed", "O job do CTO desta rodada não existe mais no banco — laço encerrado sem alterar a spec.");
    return true;
  }
  if (job.status === "pending" || job.status === "running") return false; // segue em voo

  if (job.status === "done" && job.specMarkdown) {
    const claim = await db.query(
      "UPDATE spec_autonomy_runs SET status = 'applying', updated_at = now() WHERE id = $1 AND status = 'cto_running'",
      [run.id],
    );
    if ((claim.rowCount ?? 0) === 0) return false;
    // Aplica já neste tick (não faz sentido esperar 20 s com a revisão pronta na mão).
    const fresh = (await getAutonomyRun(db, run.id))!;
    await applyAndValidate(db, fresh);
    return true;
  }

  // error | interrupted | lost — inclui o gate H4 (BLOCKED/FAIL do envelope do CTO).
  const streak = run.noProgressStreak + 1;
  await patchLastRound(db, run, { applied: false, note: `CTO não entregou revisão: ${job.error ?? job.status}` });
  if (streak >= MAX_NO_PROGRESS || run.round >= run.maxRounds) {
    await finishRun(db, { ...run, noProgressStreak: streak }, "stalled",
      `O CTO não conseguiu entregar a revisão (${job.error ?? job.status}). Laço encerrado sem alterar a spec.`);
    return true;
  }
  await db.query(
    "UPDATE spec_autonomy_runs SET status = 'pending', no_progress_streak = $2, last_error = $3, chat_job_id = NULL, updated_at = now() WHERE id = $1 AND status = 'cto_running'",
    [run.id, streak, (job.error ?? job.status).slice(0, 500)],
  );
  return true;
}

/** applying → guardas de segurança, escrita no disco e disparo da validação. */
async function applyAndValidate(db: Db, run: AutonomyRun): Promise<boolean> {
  if (!run.chatJobId) {
    await finishRun(db, run, "failed", "Rodada sem job do CTO associado (estado inconsistente).");
    return true;
  }
  const job = await getSpecChatJob(db, run.chatJobId);
  const revised = job?.specMarkdown ?? null;
  if (!revised) {
    await finishRun(db, run, "failed", "A revisão do CTO desapareceu antes de ser aplicada.");
    return true;
  }
  const spec = await readPrimarySpec(db, run.projectId);
  if (!spec) {
    await finishRun(db, run, "failed", "Spec sem arquivo legível no disco na hora de aplicar — nada foi escrito.");
    return true;
  }
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled", `A spec deixou de ser editável antes de aplicar (projeto em '${editable.status}') — nada foi escrito.`);
    return true;
  }

  const revisedSha = sha256Hex(Buffer.from(revised, "utf-8"));
  let applied = false;
  let note = "";
  if (spec.sha === revisedSha) {
    // Já está no disco: ou a revisão é idêntica à base, ou um tick anterior aplicou e morreu
    // antes do UPDATE. Nos dois casos: não escreve, mas segue para a validação (idempotente).
    note = "Revisão idêntica ao conteúdo em disco — nada a escrever.";
  } else if (spec.sha !== run.baseSpecSha) {
    // 🔴 GUARDA DE EDIÇÃO HUMANA: a spec mudou desde o envio ao CTO. Aplicar apagaria a edição
    // do humano em silêncio — exatamente o que o card "Revisão recuperada" existe para evitar.
    await patchLastRound(db, run, { applied: false, note: "spec editada por fora durante a rodada" });
    await finishRun(db, run, "stalled",
      "A spec foi editada por fora durante a rodada — NÃO sobrescrevi sua edição. A revisão do CTO continua disponível no chat para você aplicar manualmente.");
    return true;
  } else if (revised.length < spec.content.length * MIN_SHRINK_RATIO) {
    // 🔴 GUARDA DE ENCOLHIMENTO: o CTO normalizador já descartou conteúdo válido em prod.
    await patchLastRound(db, run, { applied: false, note: `revisão encolheu (${revised.length} < ${Math.round(spec.content.length * MIN_SHRINK_RATIO)} chars)` });
    await finishRun(db, run, "stalled",
      `A revisão do CTO veio com ${revised.length} caracteres contra ${spec.content.length} da spec atual (perda > ${Math.round((1 - MIN_SHRINK_RATIO) * 100)}%). NÃO apliquei — a revisão está no chat para você conferir.`);
    return true;
  } else {
    // 🔴 T2 — GUARDA DE INTEGRIDADE: revisão truncada no teto de saída ou com seções a menos.
    // Sem ela, o laço APLICAVA uma spec cortada e a rodada seguinte partia do documento mutilado
    // (foi assim que 7 das 14 seções do NVX LastMile desapareceram em prod, 2026-09-05).
    const integrity = assessRevisionIntegrity(spec.content, revised, job?.truncated === true);
    if (!integrity.ok) {
      await patchLastRound(db, run, { applied: false, note: `revisão recusada (${integrity.reason}): ${integrity.detail}` });
      await finishRun(db, run, "stalled",
        `NÃO apliquei a revisão desta rodada: ${integrity.detail}. A spec no disco está INTACTA e a revisão parcial continua no chat para você aproveitar o que servir. ` +
        `Caminho recomendado para specs grandes: revisar POR ARQUIVO (spec dividida) ou tratar os GAPs em blocos menores — a resposta inteira não cabe no teto de saída do modelo.`);
      return true;
    }
    try {
      await writePrimarySpec(db, run.projectId, spec.filePath, revised, {
        previous: spec.content,
        reason: `autonomy:round-${run.round}`,
        createdBy: run.ownerUserId,
      });
    } catch (e) {
      // G2: snapshot é pré-condição da escrita autônoma. Falhou → não escreve, encerra com motivo.
      await patchLastRound(db, run, { applied: false, note: `escrita abortada: ${msg(e)}` });
      await finishRun(db, run, "stalled",
        `NÃO apliquei a revisão: ${msg(e)}. A spec no disco está INTACTA e a revisão continua no chat.`);
      return true;
    }
    applied = true;
    note = `Spec aplicada no disco (${spec.content.length} → ${revised.length} chars).`;
  }

  await patchLastRound(db, run, { applied, specChars: revised.length, note });
  const claim = await db.query(
    "UPDATE spec_autonomy_runs SET status = 'validating', validation_run_id = NULL, updated_at = now() WHERE id = $1 AND status = 'applying'",
    [run.id],
  );
  if ((claim.rowCount ?? 0) === 0) return false;
  const fresh = (await getAutonomyRun(db, run.id))!;
  await kickValidation(db, fresh);
  return true;
}

/** Dispara a validação; rate-limit NÃO derruba o laço (GAP-A) — espera o tick seguinte. */
async function kickValidation(db: Db, run: AutonomyRun): Promise<void> {
  const res = await startValidation(db as Pool, {
    projectId: run.projectId, tenantId: run.tenantId, requestedBy: run.ownerUserId,
  });
  if (res.ok) {
    await db.query(
      "UPDATE spec_autonomy_runs SET validation_run_id = $2, updated_at = now() WHERE id = $1 AND status = 'validating'",
      [run.id, res.runId],
    );
    await patchLastRound(db, run, { validationRunId: res.runId });
    return;
  }
  if (res.code === "RATE_LIMITED") {
    // 4 validações/h por spec. Não é falha do laço: registra e revalida no próximo tick.
    await db.query("UPDATE spec_autonomy_runs SET last_error = $2, updated_at = now() WHERE id = $1", [run.id, res.message]);
    console.info(`[SpecAutonomy] run=${run.id} validação em espera (rate-limit) — revalida no próximo tick.`);
    return;
  }
  await finishRun(db, run, "failed", `Validação não pôde ser iniciada (${res.code}): ${res.message}`);
}

/** validating → lê a run de validação e decide: sucesso, nova rodada, esgotado ou travado. */
async function checkValidation(db: Db, run: AutonomyRun): Promise<boolean> {
  if (!run.validationRunId) {
    await kickValidation(db, run); // retry do rate-limit / da falha transitória
    return false;
  }
  const vr = (await db.query(
    "SELECT status FROM spec_validation_runs WHERE id = $1", [run.validationRunId],
  )).rows[0] as { status?: string } | undefined;
  if (!vr) {
    await finishRun(db, run, "failed", "A run de validação desta rodada desapareceu.");
    return true;
  }
  const st = String(vr.status);
  if (st === "pending" || st === "running") return false;

  // superseded/error: não mediu GAP nenhum. Conta como rodada sem progresso e tenta de novo.
  if (st !== "passed" && st !== "failed") {
    const streak = run.noProgressStreak + 1;
    await patchLastRound(db, run, { note: `validação terminou em '${st}' (sem medição de GAPs)` });
    if (streak >= MAX_NO_PROGRESS || run.round >= run.maxRounds) {
      await finishRun(db, { ...run, noProgressStreak: streak }, "stalled",
        `A validação terminou em '${st}' e não foi possível medir os GAPs. Rode Validar manualmente para ver o estado atual.`);
      return true;
    }
    await db.query(
      "UPDATE spec_autonomy_runs SET status = 'pending', no_progress_streak = $2, updated_at = now() WHERE id = $1 AND status = 'validating'",
      [run.id, streak],
    );
    return true;
  }

  const gaps = await currentGaps(db, run.projectId);
  const before = run.gapsCurrent ?? gaps.important;
  const progressed = gaps.important < before;
  const streak = progressed ? 0 : run.noProgressStreak + 1;
  await patchLastRound(db, run, {
    gapsAfter: gaps.important, blockers: gaps.blockers, warnings: gaps.warnings,
    validationRunId: run.validationRunId,
    note: `Validação ${st}: ${before} → ${gaps.important} GAP(s) importante(s) (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings} · ℹ️ ${gaps.info}).`,
  });
  await postChatNote(db, run,
    `🤖 **Rodada ${run.round}/${run.maxRounds} concluída** — validação **${st}**: GAPs importantes ${before} → **${gaps.important}** (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}; ℹ️ ${gaps.info} de baixo risco não sustentam nova rodada).`);

  if (gaps.important === 0) {
    await finishRun(db, run, "succeeded",
      `Nenhum GAP vermelho ou amarelo ATIVO restante${gaps.info ? ` (${gaps.info} item(ns) de baixo risco seguem em aberto, por desenho)` : ""}.`, { gaps });
    return true;
  }
  if (run.round >= run.maxRounds) {
    await finishRun(db, run, "exhausted",
      `Limite de ${run.maxRounds} rodada(s) atingido com ${gaps.important} GAP(s) importante(s) em aberto (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}). Trate na aba GAPs ou rode o modo autônomo de novo.`, { gaps });
    return true;
  }
  if (streak >= MAX_NO_PROGRESS) {
    await finishRun(db, run, "stalled",
      `Duas rodadas seguidas sem derrubar GAP importante (${gaps.important} em aberto). Parei para não gastar mais LLM em um laço que não converge — trate os GAPs restantes à mão ou triagem o que for risco aceito.`, { gaps });
    return true;
  }
  await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'pending', gaps_current = $2, no_progress_streak = $3, updated_at = now()
      WHERE id = $1 AND status = 'validating'`,
    [run.id, gaps.important, streak],
  );
  return true;
}

/**
 * Reaper de BOOT: nada a "matar" — o laço é reconstruível do banco e o tick o retoma. Só corrige
 * o caso irrecuperável: `cto_running` cuja linha de job nunca existiu (a api caiu entre o claim e
 * o `createSpecChatJob`), que ficaria girando no `checkCto` para sempre.
 */
export async function reapAutonomyRuns(db: Db): Promise<number> {
  try {
    const r = await db.query(
      `UPDATE spec_autonomy_runs a
          SET status = 'failed', last_error = $1, finished_at = now(), updated_at = now()
        WHERE a.status = 'cto_running'
          AND NOT EXISTS (SELECT 1 FROM spec_chat_jobs j WHERE j.id = a.chat_job_id)`,
      ["A rodada foi interrompida antes de o job do CTO ser registrado — reinicie o modo autônomo."],
    );
    const n = r.rowCount ?? 0;
    if (n) console.info(`[SpecAutonomy] reaper de boot: ${n} laço(s) sem job do CTO encerrado(s).`);
    return n;
  } catch (e) {
    console.warn(`[SpecAutonomy] reapAutonomyRuns falhou: ${msg(e)}`);
    return 0;
  }
}
