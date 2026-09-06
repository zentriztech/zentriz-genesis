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
 *
 * PR-5 (2026-09-05) — MODO POR ARQUIVO (migração 095). Com a spec dividida (PR-3) o arquivo
 * primário é só o ÍNDICE: o laço acima mandaria o índice ao CTO normalizador e receberia uma spec
 * inteira de volta — a MESMA causa do truncamento de 64k tokens de saída que este épico mata. Com
 * 2+ arquivos na árvore o laço passa a operar assim:
 *
 *   fila de arquivos (mais blockers primeiro, specGapScope/094)
 *     → 1 ARQUIVO por rodada (CTO-EDITOR escopado, só os GAPs daquele arquivo)
 *     → escreve NAQUELE arquivo (snapshot + guardas idênticas)
 *     → repete até a fila esvaziar  → então UMA validação adversarial (PASSE) → mede e recomeça.
 *
 * Por que a validação só no fim do passe: ela é caríssima (2 estágios de LLM sobre a spec inteira) e
 * limitada a 4/h por spec — validar depois de cada arquivo esgotaria o limite antes do 5º arquivo.
 * Por isso `max_rounds` (o teto do Jean) passa a contar PASSES, e `round` conta arquivos revisados,
 * com teto próprio (`AUTONOMY_MAX_FILE_ROUNDS`) só para limitar o custo.
 *
 * Falha em UM arquivo (CTO recusou, revisão truncada, encolhimento) NÃO derruba o laço: o arquivo é
 * marcado como tratado no passe, com o motivo no log, e a fila segue. Duas falhas de arquivo
 * SEGUIDAS param (o problema não é do arquivo, é do modelo/serviço). O que continua derrubando o
 * laço é o que é do PROJETO: edição humana, spec que saiu de edição, snapshot indisponível.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { sha256Hex } from "../lib/specTreeHash.js";
import { projectFindingsState, type EnrichedFinding } from "./findingTriage.js";
import { startValidation } from "./specValidation.js";
import { getSpecChatJob } from "./specChatJobs.js";
import { snapshotSpecFile } from "./specSnapshots.js";
import { resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";
// Só o TIPO: o módulo em si é carregado por `import()` dinâmico apenas no modo por arquivo (ele
// alcança `routes/specs.js` → `db/client.js`, que o modo `whole` não precisa pagar).
import type { GapFileBucket, GapGroups, SpecFileRef } from "./specGapScope.js";
import { MANIFEST_PATH, assessManifest, expectedArchetype } from "./specManifest.js";

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
 * Teto de RODADAS-ARQUIVO **por passe**. Existe só para limitar custo: um arquivo revisado pelo
 * CTO-editor custa ~1/10 de uma rodada de spec inteira, então 12 arquivos cabem folgadamente no
 * orçamento de uma rodada antiga. Quem manda na convergência é `max_rounds` (passes), não este número.
 *
 * GAP-3 (medido 2026-09-06): este teto era GLOBAL (`round >= 12`, e `round` nunca zera). Com uma spec
 * de 11 arquivos, o passe 1 consumia 8 rodadas e o passe 2 morria na 4ª — o laço encerrava em
 * `exhausted` com "teto de 12 arquivos", tendo feito UM único passe de validação, embora a UI e a
 * própria mensagem anunciassem "até 5 passes". Provado nos runs `a4ad542f` (morreu exatamente em
 * `round=12`, `passes=1`) e `dd587b75` (`round=9` ao ENTRAR no passe 2). Agora o teto conta o passe
 * corrente; o custo total continua limitado por `AUTONOMY_MAX_TOTAL_FILE_ROUNDS`, pelo `max_rounds`
 * e pelo `AUTONOMY_DEADLINE_MS`.
 */
export const AUTONOMY_MAX_FILE_ROUNDS = 12;
/**
 * Teto ABSOLUTO de rodadas-arquivo do laço inteiro (todos os passes). É a trava de custo que o teto
 * por passe deixou de ser: 5 passes × 12 arquivos seria caro demais para rodar sem humano na frente.
 */
export const AUTONOMY_MAX_TOTAL_FILE_ROUNDS = 30;
/** Duas falhas SEGUIDAS em nível de arquivo = o problema é o modelo/serviço, não o arquivo. */
const MAX_FILE_FAILURES = 2;

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
  /** PR-5: arquivo tratado nesta rodada (`null`/ausente = rodada de spec inteira). */
  filePath?: string | null;
  /** PR-5: a que PASSE de validação esta rodada pertence (0-based). */
  pass?: number;
  chatJobId?: string | null;
  validationRunId?: string | null;
  gapsBefore?: number | null;
  gapsAfter?: number | null;
  blockers?: number | null;
  warnings?: number | null;
  applied?: boolean;
  specChars?: number | null;
  note?: string;
  /**
   * A5.3/GAP-5: esta rodada é a CRIAÇÃO do manifesto (e não a edição de um `README.md` que já
   * existe). Discriminar pelo caminho não serve: depois de criado, o manifesto ganha GAPs próprios e
   * volta à fila como arquivo normal — foi assim que o laço pagou uma rodada de criação para o guard
   * recusá-la com "o manifesto passou a existir" (medido no run `75b3cf5d`, passe 2, rodada 11).
   */
  manifestCreation?: boolean;
}

/** PR-5: `whole` = spec de um arquivo só (comportamento da 090); `per_file` = fila de arquivos. */
export type AutonomyMode = "whole" | "per_file";

export interface AutonomyRun {
  id: string;
  projectId: string;
  tenantId: string | null;
  ownerUserId: string;
  status: AutonomyStatus;
  mode: AutonomyMode;
  /** `whole`: rodadas do ciclo completo. `per_file`: ARQUIVOS revisados (teto próprio). */
  round: number;
  /** PR-5: passes de validação concluídos — é este que respeita `maxRounds`. */
  passes: number;
  /** Arquivo em revisão nesta rodada (só em `per_file`). */
  currentFile: string | null;
  /** Arquivos já tratados no passe corrente (zerado a cada validação). */
  filesDone: string[];
  /** Falhas consecutivas em nível de arquivo (2 param o laço). */
  fileFailures: number;
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
  "created_at, updated_at, finished_at, mode, passes, current_file, files_done, file_failures";

function rowToRun(r: Record<string, unknown>): AutonomyRun {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    tenantId: (r.tenant_id as string | null) ?? null,
    ownerUserId: String(r.owner_user_id ?? ""),
    status: (r.status as AutonomyStatus) ?? "pending",
    // Migração 095 ausente (banco atrás do código) → `whole`: o laço segue exatamente como na 090.
    mode: r.mode === "per_file" ? "per_file" : "whole",
    passes: Number(r.passes ?? 0),
    currentFile: (r.current_file as string | null) ?? null,
    filesDone: Array.isArray(r.files_done) ? (r.files_done as unknown[]).map((x) => String(x)) : [],
    fileFailures: Number(r.file_failures ?? 0),
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

/**
 * PR-5: quantos arquivos a spec tem. É o ÚNICO sinal que decide o modo da rodada — e é decisão de
 * transporte, não de julgamento (com 1 arquivo não existe "por arquivo"). Recalculado a cada rodada:
 * se o humano dividir a spec no meio do laço, a rodada seguinte já entra no modo certo.
 */
async function specFileCount(db: Db, projectId: string): Promise<number> {
  const row = (await db.query(
    "SELECT count(*)::int AS n FROM project_spec_files WHERE project_id = $1", [projectId],
  )).rows[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * PR-5: um arquivo da árvore pelo path canônico (`rel_dir/filename`). A canonicalização vive no
 * `specGapScope` (mesma da UI, do PUT e da fila de GAPs) — importada dinamicamente para o modo
 * `whole` não pagar o módulo.
 */
async function readSpecFileAt(db: Db, projectId: string, path: string): Promise<PrimarySpec | null> {
  const { loadSpecFiles } = await import("./specGapScope.js");
  const ref = (await loadSpecFiles(db, projectId)).find((f) => f.path === path);
  if (!ref) return null;
  const buf = await readFile(ref.filePath).catch(() => null);
  if (buf === null) return null;
  return { filePath: ref.filePath, content: buf.toString("utf-8"), sha: sha256Hex(buf) };
}

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
 *
 * PR-5: serve aos DOIS modos — recebe o `filePath` do arquivo a escrever (o primário no modo
 * `whole`, o arquivo da rodada no modo `per_file`). O snapshot é por arquivo, então a rede de
 * segurança continua exata em qualquer um dos dois.
 */
async function writeSpecFile(
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
  // PR-5: no modo por arquivo "rodada 7/5" mentiria — `round` conta ARQUIVOS e `passes` conta os
  // ciclos de validação (que são o teto do Jean).
  const progress = run.mode === "per_file"
    ? `arquivos revisados: ${run.round} em ${run.passes} passe(s) de ${run.maxRounds}`
    : `rodadas executadas: ${run.round}/${run.maxRounds}`;
  await postChatNote(db, run,
    `${FINAL_LABEL[status] ?? "Modo autônomo encerrado"} — ${progress}${tally}\n\n${note}`);
  console.info(`[SpecAutonomy] run=${run.id} project=${run.projectId} → ${status} (${progress}): ${note}`);
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

  // PR-5: o modo é DERIVADO da árvore (2+ arquivos = por arquivo) e revalidado a cada rodada. Aqui
  // ele entra na linha só para a Bancada já desenhar o laço certo desde o primeiro poll.
  const fileCount = await specFileCount(db, opts.projectId).catch(() => 1);
  const mode: AutonomyMode = fileCount > 1 ? "per_file" : "whole";

  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO spec_autonomy_runs
         (id, project_id, tenant_id, owner_user_id, status, round, max_rounds, gaps_initial, gaps_current, deadline_at, mode)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6, $6, now() + ($7 || ' milliseconds')::interval, $8)`,
      [id, opts.projectId, opts.tenantId, opts.ownerUserId, maxRounds, gaps.important, String(AUTONOMY_DEADLINE_MS), mode],
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
  await postChatNote(db, run, mode === "per_file"
    ? `🤖 **Modo autônomo ativado (por arquivo)** — a spec tem ${fileCount} arquivos, então vou tratar **um arquivo por rodada** (os com bloqueadores primeiro), salvar cada um, e só validar a spec inteira quando a fila terminar. Até ${maxRounds} passe(s) de validação, enquanto sobrar GAP 🔴 blocker ou 🟡 warning ATIVO (itens de baixo risco não sustentam rodada).\n\nPonto de partida: ${gaps.important} GAP(s) importante(s) — 🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}.`
    : `🤖 **Modo autônomo ativado** — vou resolver os GAPs, salvar, validar e repetir por até ${maxRounds} rodada(s), enquanto sobrar GAP 🔴 blocker ou 🟡 warning ATIVO (itens de baixo risco não sustentam rodada).\n\nPonto de partida: ${gaps.important} GAP(s) importante(s) — 🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}.`);
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
    case "applying": return applyStep(db, run);
    case "validating": return checkValidation(db, run);
    default: return false;
  }
}

/** PR-5: qual "apply" roda — o do arquivo da rodada ou o da spec inteira. */
function applyStep(db: Db, run: AutonomyRun): Promise<boolean> {
  return run.mode === "per_file" && run.currentFile ? applyFileRound(db, run) : applyAndValidate(db, run);
}

/**
 * pending → começa a rodada. O MODO é decidido aqui, pela árvore (não por flag): 2+ arquivos →
 * fila por arquivo (PR-5); 1 arquivo → o ciclo da 090, byte por byte como era.
 */
async function startRound(db: Db, run: AutonomyRun): Promise<boolean> {
  const fileCount = await specFileCount(db, run.projectId).catch(() => 1);
  if (fileCount > 1) return startFileRound(db, run);
  return startWholeRound(db, run);
}

/** pending (spec de 1 arquivo) → dispara Resolver GAPs pelo MESMO caminho do botão manual. */
async function startWholeRound(db: Db, run: AutonomyRun): Promise<boolean> {
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
            gaps_current = $5, validation_run_id = NULL, mode = 'whole', current_file = NULL,
            updated_at = now()
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

// ── PR-5: a fila de arquivos ─────────────────────────────────────────────────

/**
 * Fila de arquivos da rodada: só os que têm GAP IMPORTANTE (🔴/🟡) ativo, blockers primeiro. A
 * `gapQueue` do specGapScope inclui arquivos que só têm `info` — para o laço isso seria gastar Opus
 * em "baixo risco", contra a regra do Jean ("apenas vermelhos e amarelos sustenta rodada").
 */
function importantFileQueue(list: GapFileBucket[]): string[] {
  return list
    .filter((b) => b.blockers + b.warnings > 0)
    .slice()
    .sort((a, b) => b.blockers - a.blockers
      || (b.blockers + b.warnings) - (a.blockers + a.warnings)
      || a.path.localeCompare(b.path))
    .map((b) => b.path);
}

/**
 * A5.3 — o GAP `no_readme` está ATIVO? É o único finding que aponta um arquivo que NÃO EXISTE, e
 * por isso jamais entrou na fila (que é por arquivo da árvore). Ele é procurado nos DOIS lados do
 * escopo: `unrouted` (onde nasce, com `file` vazio) e `byPath` (se o roteador LLM o tiver atribuído
 * a algum arquivo — atribuição que não o resolve, porque o Estágio A só aceita `README.md` na raiz).
 *
 * Se o humano triou o finding (risco aceito / falso positivo), ele não vem em `scope` — logo o laço
 * NÃO cria manifesto contra a decisão do humano.
 */
function manifestGapFindings(scope: GapGroups): EnrichedFinding[] {
  const isManifestGap = (f: EnrichedFinding) =>
    (f.anchor ?? "") === "no_readme" && (f.severity === "blocker" || f.severity === "warning");
  const out = scope.unrouted.filter(isManifestGap);
  for (const list of scope.byPath.values()) out.push(...list.filter(isManifestGap));
  return out;
}

/** Quantos arquivos foram efetivamente ESCRITOS no passe corrente (lido do log de rodadas). */
function appliedInPass(run: AutonomyRun): number {
  return run.rounds.filter((r) => (r.pass ?? 0) === run.passes && r.applied === true).length;
}

/**
 * Fecha o arquivo corrente SEM aplicar e devolve o laço para a fila. Não é falha do laço: outro
 * arquivo pode ser revisado com sucesso no mesmo passe. `failure` conta para o `MAX_FILE_FAILURES`
 * (duas seguidas = o problema é o modelo/serviço, não o arquivo).
 */
async function skipFileAndContinue(
  db: Db, run: AutonomyRun, path: string, note: string, opts: { failure: boolean; fromStatus: AutonomyStatus },
): Promise<boolean> {
  const failures = opts.failure ? run.fileFailures + 1 : run.fileFailures;
  const fresh = (await getAutonomyRun(db, run.id)) ?? run;
  await patchLastRound(db, fresh, { applied: false, filePath: path, note });
  if (opts.failure && failures >= MAX_FILE_FAILURES) {
    await finishRun(db, fresh, "stalled",
      `${MAX_FILE_FAILURES} arquivos seguidos sem revisão aplicável (último: \`${path}\` — ${note}). Parei para não gastar mais LLM. Os arquivos já revisados neste passe estão salvos e íntegros no disco.`,
      { gaps: await currentGaps(db, run.projectId).catch(() => null) });
    return true;
  }
  await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'pending', chat_job_id = NULL, current_file = NULL, file_failures = $2,
            files_done = files_done || $3::jsonb, last_error = $4, updated_at = now()
      WHERE id = $1 AND status = $5`,
    [run.id, failures, JSON.stringify([path]), note.slice(0, 500), opts.fromStatus],
  );
  return true;
}

/**
 * pending (spec DIVIDIDA) → uma rodada = UM arquivo. Ordem de decisões (cada uma fecha um modo de
 * falha real): teto de passes → teto de custo → spec ainda editável → GAPs restantes → escopo
 * (quem é de quem, via specGapScope/094) → fila → despacho do CTO-EDITOR.
 */
async function startFileRound(db: Db, run: AutonomyRun): Promise<boolean> {
  if (run.passes >= run.maxRounds) {
    const gaps = await currentGaps(db, run.projectId).catch(() => null);
    await finishRun(db, run, "exhausted",
      `Limite de ${run.maxRounds} passe(s) de validação atingido (${run.round} arquivo(s) revisado(s)). Revise os GAPs restantes na aba GAPs e triagem o que for risco aceito.`, { gaps });
    return true;
  }
  // GAP-3: o teto de arquivos é do PASSE (o do laço inteiro é o `TOTAL`). Sem isto, uma spec com mais
  // arquivos que o teto gastava todos os passes no primeiro e nunca chegava à 2ª validação.
  const roundsInPass = run.rounds.filter((r) => (r.pass ?? 0) === run.passes).length;
  if (roundsInPass >= AUTONOMY_MAX_FILE_ROUNDS || run.round >= AUTONOMY_MAX_TOTAL_FILE_ROUNDS) {
    const gaps = await currentGaps(db, run.projectId).catch(() => null);
    const perPass = roundsInPass >= AUTONOMY_MAX_FILE_ROUNDS;
    await finishRun(db, run, "exhausted",
      perPass
        ? `Teto de ${AUTONOMY_MAX_FILE_ROUNDS} arquivos revisados neste passe atingido (${run.round} no laço todo). Tudo o que foi revisado está salvo — rode o modo autônomo de novo para continuar de onde parou.`
        : `Teto de ${AUTONOMY_MAX_TOTAL_FILE_ROUNDS} arquivos revisados neste laço atingido. Tudo o que foi revisado está salvo — rode o modo autônomo de novo para continuar de onde parou.`,
      { gaps });
    return true;
  }
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled", `A spec deixou de ser editável no meio do laço (projeto em '${editable.status}') — nada foi alterado.`);
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

  // A que arquivo pertence cada GAP. `route: true` paga UMA vez por run de validação o agente que
  // decide os globais (Stage A) — sem ele os transversais ficariam eternamente fora da fila.
  const { ensureGapScope, buckets } = await import("./specGapScope.js");
  const llm = agentsLlmFields(await resolveWorkbenchLlm({ projectId: run.projectId, tenantId: run.tenantId }));
  const { scope, routing } = await ensureGapScope(db, run.projectId, { route: true, llm });
  if (routing) {
    console.info(`[SpecAutonomy] run=${run.id} roteamento de GAPs: routed=${routing.routed} restantes=${routing.stillUnrouted}${routing.skipped ? ` (skip: ${routing.reason})` : ""}`);
  }
  // A5.3: o manifesto é o ÚNICO alvo que pode não existir ainda — entra no FIM da fila (os GAPs de
  // conteúdo valem mais que o índice, e criar o arquivo muda o hash da árvore).
  const manifestTarget = manifestGapFindings(scope).length > 0
    && !run.filesDone.includes(MANIFEST_PATH)
    && !scope.files.some((f) => f.path.toLowerCase() === MANIFEST_PATH.toLowerCase());
  const queue = [
    ...importantFileQueue(buckets(scope)),
    ...(manifestTarget ? [MANIFEST_PATH] : []),
  ].filter((p) => !run.filesDone.includes(p));

  if (queue.length === 0) {
    const applied = appliedInPass(run);
    if (applied === 0) {
      // Nada foi escrito neste passe: validar seria queimar uma das 4 validações/h para medir a
      // MESMA spec. O motivo mais comum é GAP importante sem arquivo definido (o roteador não
      // decidiu) — dizê-lo é melhor que "sem progresso".
      const unroutedImportant = scope.unrouted.filter((f) => f.severity === "blocker" || f.severity === "warning").length;
      await finishRun(db, run, "stalled", unroutedImportant > 0
        ? `${unroutedImportant} GAP(s) importante(s) continuam SEM arquivo definido — não sei em qual arquivo da spec resolvê-los, e não vou adivinhar. Abra a aba GAPs e resolva-os no arquivo certo (ou rode Validar de novo para o validador reatribuí-los).`
        : "Nenhum arquivo da spec pôde ser revisado neste passe — a spec no disco está intacta. Veja o log das rodadas para o motivo de cada arquivo.",
        { gaps });
      return true;
    }
    // Fila esvaziada com trabalho aplicado → UMA validação adversarial para medir o passe inteiro.
    const claim = await db.query(
      `UPDATE spec_autonomy_runs
          SET status = 'validating', passes = passes + 1, files_done = '[]'::jsonb, current_file = NULL,
              validation_run_id = NULL, gaps_current = $2, updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [run.id, gaps.important],
    );
    if ((claim.rowCount ?? 0) === 0) return false;
    await postChatNote(db, run,
      `🤖 **Passe ${run.passes + 1}/${run.maxRounds} — fila de arquivos concluída** (${applied} arquivo(s) revisado(s) e salvo(s)). Validando a spec inteira para medir o resultado.`);
    const fresh = (await getAutonomyRun(db, run.id))!;
    await kickValidation(db, fresh);
    return true;
  }

  const target = queue[0];
  const file = await readSpecFileAt(db, run.projectId, target);
  // A5.3: o manifesto não tem arquivo para ler nem GAPs "deste arquivo" — é criação, não edição.
  // GAP-5: o que decide é a EXISTÊNCIA, não o nome. Depois de criado, o `README.md` ganha GAPs
  // próprios e volta à fila como qualquer outro arquivo — aí o caminho certo é o CTO-editor.
  if (target === MANIFEST_PATH && !file) return startManifestRound(db, run, scope, gaps, agentsUrl, llm);
  if (!file) {
    // Arquivo saiu da árvore/disco entre a validação e agora (split, remoção). Não é falha do
    // modelo: só sai da fila deste passe.
    return skipFileAndContinue(db, run, target, "arquivo não está mais legível no disco", { failure: false, fromStatus: "pending" });
  }
  // Só 🔴/🟡 vão ao CTO: `info` é "baixo risco" e não sustenta rodada — mandá-los inflaria a saída
  // (o arquivo volta inteiro) sem mover o critério de parada.
  const fileFindings = (scope.byPath.get(target) ?? []).filter((f) => f.severity === "blocker" || f.severity === "warning");
  const fileBlockers = fileFindings.filter((f) => f.severity === "blocker").length;

  const nextRound = run.round + 1;
  const jobId = randomUUID();
  // CLAIM antes do dispatch (dois ticks sobrepostos não pagam dois CTOs pelo mesmo arquivo).
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'cto_running', mode = 'per_file', round = $2, chat_job_id = $3, base_spec_sha = $4,
            current_file = $5, gaps_current = $6, validation_run_id = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending' AND round = $7`,
    [run.id, nextRound, jobId, file.sha, target, gaps.important, run.round],
  );
  if ((claim.rowCount ?? 0) === 0) return false;

  await appendRoundLog(db, run.id, {
    round: nextRound, pass: run.passes, startedAt: new Date().toISOString(), chatJobId: jobId,
    filePath: target, gapsBefore: gaps.important, blockers: fileBlockers, warnings: fileFindings.length - fileBlockers,
    specChars: file.content.length,
    note: `\`${target}\` enviado ao CTO (${fileFindings.length} GAP(s) deste arquivo).`,
  });

  const { dispatchGapFileJob } = await import("../routes/specChat.js");
  try {
    const res = await dispatchGapFileJob({
      jobId, projectId: run.projectId, tenantId: run.tenantId, ownerUserId: run.ownerUserId,
      filePath: target, fileContent: file.content, findings: fileFindings, agentsUrl, llm,
      userMessage: `🤖 Modo autônomo — passe ${run.passes + 1}/${run.maxRounds}, arquivo ${nextRound}: resolver ${fileFindings.length} GAP(s) de \`${target}\` (🔴 ${fileBlockers} · 🟡 ${fileFindings.length - fileBlockers}).`,
    });
    if (!res.ok) {
      // Arquivo grande demais para caber no orçamento de saída, ou sem GAP no fim das contas: o
      // arquivo sai da fila com o motivo registrado e o laço segue no próximo.
      const fresh = (await getAutonomyRun(db, run.id))!;
      return skipFileAndContinue(db, fresh, target, res.message, { failure: false, fromStatus: "cto_running" });
    }
    console.info(`[SpecAutonomy] run=${run.id} passe ${run.passes + 1}/${run.maxRounds} arquivo ${nextRound} (${target}) → CTO job=${jobId} (${res.gaps} GAPs)`);
    return true;
  } catch (e) {
    const fresh = (await getAutonomyRun(db, run.id))!;
    await finishRun(db, fresh, "failed", `Falha ao acionar o CTO: ${msg(e).slice(0, 300)}`);
    return true;
  }
}

/** Sha do vazio: a pré-condição de CRIAÇÃO é "o arquivo continua não existindo" (If-Match de criação). */
const EMPTY_SHA = sha256Hex(Buffer.alloc(0));

/**
 * A5.3 — rodada que CRIA o manifesto (`README.md`), o único alvo do laço que ainda não existe.
 *
 * Difere da rodada normal em três pontos, todos consequência de ser criação e não edição:
 *  • não há arquivo para ler → a base é o vazio (`EMPTY_SHA`), e a guarda de edição humana passa a
 *    significar "alguém criou o README no meio da rodada" (aí o laço NÃO sobrescreve);
 *  • não há "GAPs deste arquivo" para mandar ao CTO — o insumo é a árvore + o arquivo primário;
 *  • o conteúdo é do agente; o código só entrega fatos e veta (`assessManifest`).
 */
async function startManifestRound(
  db: Db, run: AutonomyRun, scope: GapGroups, gaps: GapTally,
  agentsUrl: string, llm: Record<string, unknown>,
): Promise<boolean> {
  const row = (await db.query("SELECT title, extra FROM projects WHERE id = $1", [run.projectId])).rows[0] as
    { title?: string; extra?: unknown } | undefined;
  const primary = scope.files.find((f) => f.isPrimary) ?? scope.files[0];
  if (!primary) {
    return skipFileAndContinue(db, run, MANIFEST_PATH,
      "a spec não tem nenhum arquivo para basear o manifesto", { failure: false, fromStatus: "pending" });
  }
  const primaryContent = await readFile(primary.filePath, "utf-8").catch(() => null);
  if (primaryContent === null) {
    return skipFileAndContinue(db, run, MANIFEST_PATH,
      `arquivo primário \`${primary.path}\` não está legível no disco`, { failure: false, fromStatus: "pending" });
  }

  const nextRound = run.round + 1;
  const jobId = randomUUID();
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'cto_running', mode = 'per_file', round = $2, chat_job_id = $3, base_spec_sha = $4,
            current_file = $5, gaps_current = $6, validation_run_id = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending' AND round = $7`,
    [run.id, nextRound, jobId, EMPTY_SHA, MANIFEST_PATH, gaps.important, run.round],
  );
  if ((claim.rowCount ?? 0) === 0) return false;

  const manifestGaps = manifestGapFindings(scope);
  await appendRoundLog(db, run.id, {
    round: nextRound, pass: run.passes, startedAt: new Date().toISOString(), chatJobId: jobId,
    filePath: MANIFEST_PATH, manifestCreation: true, gapsBefore: gaps.important,
    blockers: manifestGaps.filter((f) => f.severity === "blocker").length,
    warnings: manifestGaps.filter((f) => f.severity === "warning").length,
    specChars: 0,
    note: `\`${MANIFEST_PATH}\` não existe — pedindo ao CTO o manifesto do projeto (${scope.files.length} arquivo(s) na árvore).`,
  });

  const { dispatchManifestJob } = await import("../routes/specChat.js");
  try {
    await dispatchManifestJob({
      jobId, projectId: run.projectId, tenantId: run.tenantId, ownerUserId: run.ownerUserId,
      projectTitle: (row?.title ?? "").trim() || "projeto sem título",
      archetype: expectedArchetype(row?.extra ?? null),
      files: scope.files.map((f) => f.path),
      primaryPath: primary.path, primaryContent, agentsUrl, llm,
      userMessage: `🤖 Modo autônomo — passe ${run.passes + 1}/${run.maxRounds}, arquivo ${nextRound}: criar o manifesto \`${MANIFEST_PATH}\` (GAP "Spec sem manifesto").`,
    });
    console.info(`[SpecAutonomy] run=${run.id} passe ${run.passes + 1}/${run.maxRounds} arquivo ${nextRound} (${MANIFEST_PATH}, CRIAÇÃO) → CTO job=${jobId}`);
    return true;
  } catch (e) {
    const fresh = (await getAutonomyRun(db, run.id))!;
    return skipFileAndContinue(db, fresh, MANIFEST_PATH, `falha ao pedir o manifesto: ${msg(e).slice(0, 300)}`,
      { failure: true, fromStatus: "cto_running" });
  }
}

/**
 * A5.3 — escreve o manifesto APROVADO no disco e registra o arquivo novo na árvore.
 *
 * Ordem: disco → linha em `project_spec_files` → `spec_dirty_at`. Não há snapshot porque não há
 * conteúdo anterior a preservar; a pré-condição (`ON CONFLICT DO NOTHING` + checagem do chamador) é
 * "não existia". `is_primary` fica FALSO: o primário atual continua sendo o primário — o manifesto é
 * a porta de entrada, e mudar o primário no meio de um laço trocaria o alvo de todas as outras ações.
 */
async function createManifestFile(db: Db, projectId: string, content: string): Promise<string> {
  const uploadDir = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
  const physical = path.resolve(uploadDir, projectId, MANIFEST_PATH);
  await mkdir(path.dirname(physical), { recursive: true });
  await writeFile(physical, content, "utf-8");
  await db.query(
    `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
     VALUES ($1, $2, $3, 'text/markdown', '', false, $4) ON CONFLICT DO NOTHING`,
    [projectId, MANIFEST_PATH, physical, sha256Hex(Buffer.from(content, "utf-8"))],
  );
  await db.query("UPDATE projects SET spec_dirty_at = now() WHERE id = $1", [projectId]);
  return physical;
}

/**
 * applying (manifesto) → CRIA o arquivo se o veto aprovar. As guardas aqui são de outra natureza:
 * não existe "encolheu" nem "veio igual" (não havia base), e o que substitui `assessRevisionIntegrity`
 * é o `assessManifest` — cada recusa dele corresponde a um finding que o Estágio A reaplicaria, ou
 * seja: escrever assim faria o laço andar para trás.
 */
async function applyManifestRound(db: Db, run: AutonomyRun, revised: string, truncated: boolean): Promise<boolean> {
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled",
      `A spec deixou de ser editável antes de criar o manifesto (projeto em '${editable.status}') — nada foi escrito.`);
    return true;
  }
  if (truncated) {
    return skipFileAndContinue(db, run, MANIFEST_PATH,
      "o manifesto voltou truncado (teto de saída) — não escrevo índice pela metade", { failure: true, fromStatus: "applying" });
  }
  // Guarda de criação concorrente: se o README passou a existir durante a rodada (humano, split),
  // a proposta do CTO NÃO sobrescreve — ela fica no chat do arquivo.
  const already = await readSpecFileAt(db, run.projectId, MANIFEST_PATH);
  if (already) {
    return skipFileAndContinue(db, run, MANIFEST_PATH,
      "o manifesto passou a existir durante a rodada — não sobrescrevi", { failure: false, fromStatus: "applying" });
  }
  const row = (await db.query("SELECT extra FROM projects WHERE id = $1", [run.projectId])).rows[0] as
    { extra?: unknown } | undefined;
  const verdict = assessManifest(revised, { expected: expectedArchetype(row?.extra ?? null) });
  if (!verdict.ok) {
    return skipFileAndContinue(db, run, MANIFEST_PATH, `manifesto recusado (${verdict.code}): ${verdict.message}`,
      { failure: true, fromStatus: "applying" });
  }
  try {
    await createManifestFile(db, run.projectId, verdict.content);
  } catch (e) {
    await patchLastRound(db, run, { applied: false, filePath: MANIFEST_PATH, note: `criação abortada: ${msg(e)}` });
    await finishRun(db, run, "stalled",
      `NÃO criei o manifesto \`${MANIFEST_PATH}\`: ${msg(e)}. A spec no disco está INTACTA e a proposta continua no chat.`);
    return true;
  }
  await patchLastRound(db, run, {
    applied: true, filePath: MANIFEST_PATH, specChars: verdict.content.length,
    note: `\`${MANIFEST_PATH}\` CRIADO (${verdict.content.length} chars, arquétipo \`${verdict.archetypeId}\`).`,
  });
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'pending', chat_job_id = NULL, current_file = NULL, file_failures = 0,
            files_done = files_done || $2::jsonb, updated_at = now()
      WHERE id = $1 AND status = 'applying'`,
    [run.id, JSON.stringify([MANIFEST_PATH])],
  );
  if ((claim.rowCount ?? 0) === 0) return false;
  await postChatNote(db, run,
    `🤖 **Arquivo ${run.round} do passe ${run.passes + 1}** — \`${MANIFEST_PATH}\`: manifesto do projeto **criado** (${verdict.content.length} chars, arquétipo \`${verdict.archetypeId}\`). Era o GAP que nenhuma ação da Bancada sabia resolver.`);
  return true;
}

/**
 * applying (modo por arquivo) → escreve NO ARQUIVO da rodada e volta para a fila (a validação só
 * roda quando a fila esvazia). As guardas são as MESMAS do modo inteiro, com uma diferença de
 * escopo: o que é problema DAQUELE arquivo (truncamento, encolhimento, revisão idêntica) tira o
 * arquivo da fila; o que é do PROJETO (edição humana, spec travada, snapshot indisponível) para o
 * laço, porque vale para todos os arquivos.
 */
async function applyFileRound(db: Db, run: AutonomyRun): Promise<boolean> {
  const target = run.currentFile!;
  if (!run.chatJobId) {
    return skipFileAndContinue(db, run, target, "rodada sem job do CTO associado", { failure: true, fromStatus: "applying" });
  }
  const job = await getSpecChatJob(db, run.chatJobId);
  const revised = job?.specMarkdown ?? null;
  if (!revised) {
    return skipFileAndContinue(db, run, target, "a revisão do CTO desapareceu antes de ser aplicada", { failure: true, fromStatus: "applying" });
  }
  // A5.3: o manifesto é CRIAÇÃO — as guardas de edição (base, encolhimento, integridade) não se
  // aplicam a um arquivo que não existia, e `readSpecFileAt` abaixo devolveria null.
  // GAP-5: quem decide é a rodada REGISTRADA, não o nome do arquivo. Se o `README.md` já existia, a
  // rodada foi de edição e tem de ser aplicada como tal — senão o guard de criação descartaria uma
  // revisão paga com "o manifesto passou a existir".
  const lastRound = run.rounds[run.rounds.length - 1];
  if (lastRound?.manifestCreation === true && lastRound.round === run.round) {
    return applyManifestRound(db, run, revised, job?.truncated === true);
  }
  const file = await readSpecFileAt(db, run.projectId, target);
  if (!file) {
    return skipFileAndContinue(db, run, target, "arquivo não está mais legível no disco", { failure: false, fromStatus: "applying" });
  }
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled", `A spec deixou de ser editável antes de aplicar (projeto em '${editable.status}') — nada foi escrito.`);
    return true;
  }

  const revisedSha = sha256Hex(Buffer.from(revised, "utf-8"));
  if (revisedSha === file.sha) {
    // O CTO devolveu o arquivo IGUAL tendo GAPs para resolver: não há o que escrever e não houve
    // progresso — conta como falha de arquivo (duas seguidas param o laço).
    return skipFileAndContinue(db, run, target, "o CTO devolveu o arquivo sem alteração", { failure: true, fromStatus: "applying" });
  }
  if (file.sha !== run.baseSpecSha) {
    // 🔴 GUARDA DE EDIÇÃO HUMANA (do PROJETO): o humano mexeu neste arquivo durante a rodada.
    await patchLastRound(db, run, { applied: false, filePath: target, note: "arquivo editado por fora durante a rodada" });
    await finishRun(db, run, "stalled",
      `O arquivo \`${target}\` foi editado por fora durante a rodada — NÃO sobrescrevi sua edição. A revisão do CTO continua disponível no chat deste arquivo para você aplicar manualmente.`);
    return true;
  }
  if (revised.length < file.content.length * MIN_SHRINK_RATIO) {
    return skipFileAndContinue(db, run, target,
      `revisão encolheu (${revised.length} < ${Math.round(file.content.length * MIN_SHRINK_RATIO)} chars)`,
      { failure: true, fromStatus: "applying" });
  }
  const integrity = assessRevisionIntegrity(file.content, revised, job?.truncated === true);
  if (!integrity.ok) {
    return skipFileAndContinue(db, run, target, `revisão recusada (${integrity.reason}): ${integrity.detail}`,
      { failure: true, fromStatus: "applying" });
  }
  try {
    await writeSpecFile(db, run.projectId, file.filePath, revised, {
      previous: file.content,
      reason: `autonomy:pass-${run.passes + 1}:file-${run.round}`,
      createdBy: run.ownerUserId,
    });
  } catch (e) {
    // G2: snapshot é pré-condição da escrita autônoma — e a falha é do BANCO, não do arquivo.
    await patchLastRound(db, run, { applied: false, filePath: target, note: `escrita abortada: ${msg(e)}` });
    await finishRun(db, run, "stalled",
      `NÃO apliquei a revisão de \`${target}\`: ${msg(e)}. A spec no disco está INTACTA e a revisão continua no chat.`);
    return true;
  }

  await patchLastRound(db, run, {
    applied: true, filePath: target, specChars: revised.length,
    note: `\`${target}\` salvo no disco (${file.content.length} → ${revised.length} chars).`,
  });
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'pending', chat_job_id = NULL, current_file = NULL, file_failures = 0,
            files_done = files_done || $2::jsonb, updated_at = now()
      WHERE id = $1 AND status = 'applying'`,
    [run.id, JSON.stringify([target])],
  );
  if ((claim.rowCount ?? 0) === 0) return false;
  await postChatNote(db, run,
    `🤖 **Arquivo ${run.round} do passe ${run.passes + 1}** — \`${target}\`: revisão do CTO aplicada e salva (${file.content.length} → ${revised.length} chars). Seguindo para o próximo arquivo da fila.`);
  return true;
}

/** cto_running → o job é durável: só LEMOS o estado (quem finaliza é o poll/worker do chat). */
async function checkCto(db: Db, run: AutonomyRun): Promise<boolean> {
  if (!run.chatJobId) {
    await finishRun(db, run, "failed", "Rodada sem job do CTO associado (estado inconsistente).");
    return true;
  }
  const perFile = run.mode === "per_file" && !!run.currentFile;
  const job = await getSpecChatJob(db, run.chatJobId);
  if (!job) {
    // A escrita do job pode ter falhado (createSpecChatJob é best-effort). Sem linha não há o que
    // coletar: dá a rodada por perdida em vez de esperar para sempre.
    if (perFile) {
      return skipFileAndContinue(db, run, run.currentFile!, "o job do CTO deste arquivo não existe no banco",
        { failure: true, fromStatus: "cto_running" });
    }
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
    await applyStep(db, fresh);
    return true;
  }

  // error | interrupted | lost — inclui o gate H4 (BLOCKED/FAIL do envelope do CTO).
  // Por arquivo: a falha é DAQUELE arquivo (429, arquivo difícil, BLOCKED do envelope) — o laço
  // segue na fila e só para com `MAX_FILE_FAILURES` seguidas.
  if (perFile) {
    return skipFileAndContinue(db, run, run.currentFile!, `CTO não entregou revisão: ${job.error ?? job.status}`,
      { failure: true, fromStatus: "cto_running" });
  }
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
      await writeSpecFile(db, run.projectId, spec.filePath, revised, {
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

  // PR-5: no modo por arquivo o teto do Jean é medido em PASSES (uma validação por passe); `round`
  // conta arquivos e tem teto próprio (`AUTONOMY_MAX_FILE_ROUNDS`).
  const perFile = run.mode === "per_file";
  const atCap = perFile ? run.passes >= run.maxRounds : run.round >= run.maxRounds;

  // superseded/error: não mediu GAP nenhum. Conta como rodada sem progresso e tenta de novo.
  if (st !== "passed" && st !== "failed") {
    const streak = run.noProgressStreak + 1;
    await patchLastRound(db, run, { note: `validação terminou em '${st}' (sem medição de GAPs)` });
    if (streak >= MAX_NO_PROGRESS || atCap) {
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
  const cycleLabel = perFile
    ? `**Passe ${run.passes}/${run.maxRounds} concluído** (${appliedInPass({ ...run, passes: run.passes - 1 })} arquivo(s) revisado(s))`
    : `**Rodada ${run.round}/${run.maxRounds} concluída**`;
  await postChatNote(db, run,
    `🤖 ${cycleLabel} — validação **${st}**: GAPs importantes ${before} → **${gaps.important}** (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}; ℹ️ ${gaps.info} de baixo risco não sustentam nova rodada).`);

  if (gaps.important === 0) {
    await finishRun(db, run, "succeeded",
      `Nenhum GAP vermelho ou amarelo ATIVO restante${gaps.info ? ` (${gaps.info} item(ns) de baixo risco seguem em aberto, por desenho)` : ""}.`, { gaps });
    return true;
  }
  if (atCap) {
    await finishRun(db, run, "exhausted",
      `Limite de ${run.maxRounds} ${perFile ? "passe(s) de validação" : "rodada(s)"} atingido com ${gaps.important} GAP(s) importante(s) em aberto (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}). Trate na aba GAPs ou rode o modo autônomo de novo.`, { gaps });
    return true;
  }
  if (streak >= MAX_NO_PROGRESS) {
    await finishRun(db, run, "stalled",
      `Dois ${perFile ? "passes" : "rodadas"} seguidos sem derrubar GAP importante (${gaps.important} em aberto). Parei para não gastar mais LLM em um laço que não converge — trate os GAPs restantes à mão ou triagem o que for risco aceito.`, { gaps });
    return true;
  }
  await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'pending', gaps_current = $2, no_progress_streak = $3, file_failures = 0, updated_at = now()
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
