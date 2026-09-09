/**
 * specAutonomy.test.ts — MODO AUTÔNOMO da Bancada (migração 090, 2026-09-05).
 *
 * Cobre o que o pedido do Jean travou e o que a revisão adversarial listou como risco de PERDA
 * DE DADOS ou de DINHEIRO:
 *   • "apenas GAPs vermelhos e amarelos sustenta mais uma rodada" (info e triados NÃO contam);
 *   • guarda de edição humana (não sobrescreve spec editada por fora);
 *   • guarda de encolhimento (não aplica revisão que perdeu conteúdo);
 *   • rate-limit de 4 validações/h NÃO derruba o laço (GAP-A);
 *   • teto de 5 rodadas e parada por falta de progresso.
 *
 * 2026-09-05 (T2/G2/G4) — o incidente que motivou as guardas novas: a spec do NVX LastMile
 * (98.045 chars) faz o CTO bater no teto de 64k tokens de SAÍDA. A resposta volta `status: OK`,
 * cortada no meio, e o laço a APLICAVA: 7 das 14 seções desapareceram do disco. Agora:
 *   • T2 — revisão truncada ou com seções a menos → `stalled`, disco INTACTO;
 *   • G2 — o conteúdo anterior vai para `project_spec_snapshots` ANTES de qualquer escrita, e
 *     falhar o snapshot ABORTA a escrita (rede de segurança é pré-condição, não enfeite);
 *   • G4 — `SPEC_AUTONOMY` nasce DESLIGADO (fail-closed em instalação nova).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// ── dublês dos colaboradores ──────────────────────────────────────────────────
let findings: Array<{ severity: string; triage?: unknown }> = [];
let latestRunId: string | null = "run-0";
// GAP-41: o diff finding-a-finding entre as duas últimas validações. `null` reproduz o caso em que
// não há duas validações para comparar (ou a consulta falhou) — o laço volta a olhar só o agregado.
// GAP-154: `closedOnUnchangedText` é OPCIONAL no dublê de propósito — é assim que a cobertura legada
// chega ao laço (balde ausente), e o teste do saldo histórico depende de poder omiti-lo.
let delta: { closed: unknown[]; opened: unknown[]; openedOnNewSurface: number;
             openedOnUnchangedText?: number; closedOnUnchangedText?: number } | null = null;
/** 🔴 GAP-154: o que o laço DIZ ao Jean no chat (o dublê de `spec_chat_messages` empilha aqui). */
const chatNotes: string[] = [];
/**
 * 🔴 GAP-76: o NÍVEL de GAPs no subconjunto que as DUAS últimas validações julgaram por inteiro.
 * `null` reproduz "não foi possível medir" (cobertura ausente em algum dos lados) — e aí o laço volta a
 * decidir pelo agregado, como antes.
 */
let comparable: { files: string[]; before: number; now: number; same: number } | null = null;
/**
 * ⚠️ `importOriginal` de propósito: `vi.mock(mod, () => ({...}))` substitui o módulo INTEIRO, então um
 * export NOVO consumido pelo `specAutonomy.ts` derrubava 27 testes com `… is not a function` (queimado
 * no GAP-76 — e o `.catch()` não salva, o TypeError é sincrônico). `findingTriage` é puro (só `crypto`),
 * então herdar o original e dublar só o que toca banco é seguro e imuniza a suíte.
 */
vi.mock("./findingTriage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./findingTriage.js")>()),
  projectFindingsState: vi.fn(async () => ({ latestRunId, findings, resolved: [], counts: {} })),
  gapDeltaSinceLastRun: vi.fn(async () => delta ?? { closed: [], opened: [], openedOnNewSurface: 0, openedOnUnchangedText: 0 }),
  comparableTallySinceLastRun: vi.fn(async () => comparable),
}));

/**
 * 🔴 GAP-77 — o veredicto de promovibilidade é dublado: o que este arquivo testa é se o LAÇO chama o
 * juiz nos dois fins de laço, grava o parecer no log e o repete na mensagem final. O julgamento em si
 * (guardas de elegibilidade, fail-CLOSED, tetos) tem suíte própria em `gapPromotionVerdict.test.ts`.
 * `verdict = null` reproduz o recurso desligado/indisponível — o laço tem de encerrar como antes.
 */
let verdict: {
  candidates: number; released: number; impeditive: number; promotable: boolean;
  rejected?: Array<{ file: string; anchor: string; why: string }>;
} | null = null;
/** 🔴 GAP-82 — quando `true`, a prova de trabalho dublada é a de ESGOTAMENTO (0 fechado). */
let provaEsgotamento = false;
vi.mock("./gapPromotionVerdict.js", () => ({
  verdictConfig: vi.fn(() => ({ minGapsResolved: verdict ? 3 : 0, minRecurrence: 3, minFocusRounds: 2, maxPerRun: 3, maxPerSpec: 8 })),
  focusRoundsByFile: vi.fn(async () => new Map<string, number>([["produto.md", 4]])),
  // 🔴 GAP-81: rodadas DEDICADAS por âncora — conta separada da de arquivo, e é ela que abre o gatilho.
  focusRoundsByAnchor: vi.fn(async () => new Map<string, number>([["4 autenticacao", 2]])),
  attackedRoundsByAnchor: vi.fn(async () => new Map<string, number>()),
  anchoredSection: vi.fn(() => "## 4. Autenticação\ntexto\n"),
  // 🔴 GAP-82: a prova de trabalho entra dublada — por padrão PROVADA por fechamento, que é o
  // comportamento antigo. `provaEsgotamento` troca para a prova por esgotamento do laço, e a lógica das
  // duas provas tem suíte própria (`gapPromotionVerdict.test.ts`).
  proveWork: vi.fn(() => provaEsgotamento
    ? { proven: true, kind: "exhausted", detail: "laço ESGOTADO (exhausted) com 0 GAP(s) fechado(s): 5 passe(s) de validação, 21 rodada(s) aplicada(s), 21 rodada(s) de foco INDIVIDUAL paga(s), 4 validação(ões) com números reconciliados" }
    : { proven: true, kind: "resolved", detail: "3 GAP(s) fechado(s) e reconciliado(s) nesta run (mínimo 3)" }),
  specFileShas: vi.fn(async () => new Map<string, string>()),
  // 🔴 GAP-124: o laço passou a ler o snapshot (sha + conteúdo) para medir obsolescência pela
  // SEÇÃO ancorada. `vi.mock` troca o módulo inteiro, então export novo tem de aparecer aqui.
  specFileSnapshots: vi.fn(async () => new Map<string, { sha: string; content: string }>()),
  selectVerdictCandidates: vi.fn(() => ({
    candidates: Array.from({ length: verdict?.candidates ?? 0 }, (_, i) => ({
      finding: { severity: "blocker", title: `t${i}` }, fingerprint: `fp${i}`, file: "produto.md",
      anchor: `## ${i}`, times: 4, focusRounds: 3, section: "trecho",
    })),
    rejected: verdict?.rejected ?? [],
    enabled: true,
    reason: `${verdict?.candidates ?? 0} GAP(s) elegível(is) a veredicto`,
  })),
  runVerdictRound: vi.fn(async () => ({
    verdicts: Array.from({ length: verdict?.released ?? 0 }, (_, i) => ({
      fingerprint: `fp${i}`, file: "produto.md", anchor: `## ${i}`, severity: "warning", title: "t",
      impact: "nao_impeditivo", reason: "redundância consistente entre os dois trechos", factoryArtifact: "POST /x",
      accusation: "nenhum dano ao artefato", times: 4, focusRounds: 3,
    })),
    ran: true, reason: `${verdict?.released ?? 0} declarado(s) não-impeditivo(s)`, released: verdict?.released ?? 0, model: "dublê",
  })),
  saveVerdicts: vi.fn(async (_db: unknown, a: { verdicts: unknown[] }) => a.verdicts.length),
  livePromotionVerdicts: vi.fn(async () => []),
  promotabilityReport: vi.fn(() => ({
    impeditive: verdict?.impeditive ?? 0,
    released: verdict?.released ?? 0,
    promotable: verdict?.promotable ?? false,
    blockers: verdict?.promotable ? [] : [`${verdict?.impeditive ?? 0} GAP(s) importante(s) seguem impeditivos`],
  })),
}));

/**
 * 🔴 GAP-67: quantos pares "fechado + novo" do diff cru eram O MESMO defeito com âncora nova, e se a
 * reconciliação por agente rodou. `reconciled: false` (o default, que reproduz reconciliador
 * indisponível) proíbe o laço de tratar saldo favorável como progresso — é a única forma de o
 * `no_progress_streak` não ser zerado por deriva de âncora, medida em prod na run `b1bc1195`.
 */
let continuity: { persisted: number; reconciled: boolean; reason?: string } = { persisted: 0, reconciled: false, reason: "dublê" };
vi.mock("./gapContinuity.js", () => ({
  reconcileGapDelta: vi.fn(async (closed: unknown[], opened: unknown[]) => {
    const n = Math.min(continuity.persisted, closed.length, opened.length);
    return {
      closed: closed.slice(n), opened: opened.slice(n),
      persisted: closed.slice(0, n).map((c, i) => ({ closed: c, opened: opened[i], why: "seção renumerada" })),
      reconciled: continuity.reconciled, reason: continuity.reason, truncated: 0, model: "dublê",
    };
  }),
  // GAP-68: o dublê tem de existir — o laço chama `buildPersistentRefs` sempre que reconcilia com
  // reincidentes, e um mock incompleto quebraria com "not a function" em vez de medir o laço.
  buildPersistentRefs: vi.fn((persisted: unknown[]) =>
    persisted.map((_, i) => ({
      fingerprint: `fp-${i}`, file: "modelo-dados.md", anchor: `§${i}`, anchorBefore: `§${i}.1`,
      title: `reincidente ${i}`, why: "seção renumerada", times: 2,
    }))),
}));

const startValidation = vi.fn(async () => ({ ok: true as const, runId: "vr-1", reused: false }));
// GAP-19: a pendência de cobertura é ACUMULADA (`stage_b_full_sha` × sha atual) e vem daqui —
// `coberturaAcumulada = null` reproduz "não foi possível medir" (comportamento legado).
let coberturaAcumulada: { unjudged: string[]; judged: number; total: number } | null = null;
vi.mock("./specValidation.js", () => ({
  startValidation: (...a: unknown[]) => startValidation(...(a as [])),
  unjudgedSpecFiles: async () => coberturaAcumulada,
  // Feature dos DESENHOS: esta suíte é do modo `whole`, onde o documento de diagramas NÃO é criado (a
  // spec é um arquivo só). O dublê existe porque mock de módulo substitui o módulo inteiro — sem esta
  // chave, um caminho que chegasse aqui quebraria com TypeError em vez de seguir sem desenhar.
  computeCurrentSpecHash: vi.fn(async () => null),
}));

// `truncated` (T1) chega do runtime via `spec_chat_jobs.truncated` — é o sinal que o laço consulta.
let job: {
  status: string; specMarkdown: string | null; error: string | null; truncated?: boolean;
  /** GAP-12 (migração 098): nº de blocos ancorados que geraram `specMarkdown`. */
  editsApplied?: number | null;
} | null = null;
/** 🔴 GAP-119: `true` = SELECT rodou e não há linha do job; `null` = leitura falhou (indecidível). */
let jobRowMissing: boolean | null = true;
vi.mock("./specChatJobs.js", () => ({
  getSpecChatJob: vi.fn(async () => job),
  specChatJobMissing: vi.fn(async () => jobRowMissing),
}));

const dispatchResolveGapsJob = vi.fn(async () => ({ ok: true as const, gaps: 3 }));
vi.mock("../routes/specChat.js", () => ({
  dispatchResolveGapsJob: (...a: unknown[]) => dispatchResolveGapsJob(...(a as [])),
  // Idem: no modo `whole` este caminho não é usado, mas o mock tem de EXISTIR (o módulo é substituído).
  dispatchDiagramsJob: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("./tenantLlmConfig.js", () => ({
  resolveWorkbenchLlm: vi.fn(async () => ({})),
  agentsLlmFields: vi.fn(() => ({})),
}));

vi.mock("./projectStatus.js", () => ({ SPEC_EDITABLE_STATUSES: new Set(["draft", "spec_submitted"]) }));

// GAP-46: para provar QUAL lista de arquivos o laço entrega ao survey de findings.
import { projectFindingsState, gapDeltaSinceLastRun } from "./findingTriage.js";

import {
  tallyGaps, autonomyEnabled, AUTONOMY_MAX_ROUNDS, startAutonomyRun, advanceAutonomyRun,
  isTerminalAutonomyStatus, assessRevisionIntegrity, passGrowthUsed, lastRejectedAttempt, runGrowthUsed, growthAllowance,
  type AutonomyStatus,
} from "./specAutonomy.js";
import { proportionalGrowthBudget } from "./specOracles.js";

// ── banco falso: uma linha de spec_autonomy_runs em memória ───────────────────
interface FakeRow { [k: string]: unknown }
let run: FakeRow | null = null;
let projectStatus = "draft";
let specPath = "";
/** GAP-46: árvore de `project_spec_files` como o laço a lê (canonicalização `rel_dir/filename`). */
let specTreeFiles: Array<{ filename: string; rel_dir: string | null }> = [];
let insertFails23505 = false;
// G2: `project_spec_snapshots` é a rede de segurança da spec. O log deixa provar que o conteúdo
// ANTERIOR foi guardado ANTES da escrita, e o flag simula a rede rasgada (banco fora do ar).
let snapshotFails = false;
const sqlLog: Array<{ sql: string; params: unknown[] }> = [];

function nowIso(): string { return new Date().toISOString(); }

const db = {
  async query(sql: string, values: unknown[] = []): Promise<{ rows: FakeRow[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, " ").trim();
    sqlLog.push({ sql: s, params: values });

    if (s.includes("project_spec_snapshots")) {
      if (snapshotFails) throw new Error("snapshot indisponível");
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith("SELECT file_path FROM project_spec_files")) {
      return { rows: specPath ? [{ file_path: specPath }] : [], rowCount: specPath ? 1 : 0 };
    }
    // GAP-46: a árvore ATUAL da spec — é o que diz à contagem quais findings apontam para arquivo que
    // já saiu. Lista vazia reproduz "não sei" (leitura transitória), e o esperado é comportamento legado.
    if (s.startsWith("SELECT filename, rel_dir FROM project_spec_files")) {
      return { rows: [...specTreeFiles], rowCount: specTreeFiles.length };
    }
    if (s.startsWith("SELECT status FROM projects")) return { rows: [{ status: projectStatus }], rowCount: 1 };
    if (s.startsWith("UPDATE project_spec_files") || s.startsWith("UPDATE projects")) return { rows: [], rowCount: 1 };
    // 🔴 GAP-154: o chat é onde o Jean lê o passe (lei do GAP-67), então o dublê passou a GUARDAR o texto
    // — antes ele era engolido e nenhum teste podia afirmar o que o laço diz em voz alta ao humano.
    if (s.startsWith("INSERT INTO spec_chat_messages")) {
      chatNotes.push(String(values.find((v) => typeof v === "string" && v.includes("🤖")) ?? ""));
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith("SELECT status, stage_b_ran, stage_b_coverage FROM spec_validation_runs")) {
      return { rows: [{ status: validationStatus, stage_b_ran: stageBRan, stage_b_coverage: stageBCoverage }], rowCount: 1 };
    }
    // GAP-18 (migração 101): cobertura da validação ANTERIOR (a comparação de superfície medida).
    if (s.startsWith("SELECT stage_b_coverage FROM spec_validation_runs")) {
      return { rows: prevCoverage ? [{ stage_b_coverage: prevCoverage }] : [], rowCount: prevCoverage ? 1 : 0 };
    }
    // GAP-11 (migração 100): "ainda há resultado do estágio B a coletar para esta validação?"
    if (s.startsWith("SELECT 1 FROM spec_validation_runs")) {
      return { rows: stageBPending ? [{ "?column?": 1 }] : [], rowCount: stageBPending ? 1 : 0 };
    }

    if (s.startsWith("INSERT INTO spec_autonomy_runs")) {
      if (insertFails23505) throw Object.assign(new Error("dup"), { code: "23505" });
      run = {
        id: values[0], project_id: values[1], tenant_id: values[2], owner_user_id: values[3],
        status: "pending", round: 0, max_rounds: values[4], chat_job_id: null, validation_run_id: null,
        base_spec_sha: null, gaps_initial: values[5], gaps_current: values[5], no_progress_streak: 0,
        rounds: [], last_error: null, deadline_at: new Date(Date.now() + 3.6e6).toISOString(),
        created_at: nowIso(), updated_at: nowIso(), finished_at: null,
      };
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("SELECT id, project_id") || s.includes("FROM spec_autonomy_runs WHERE id = $1")) {
      return { rows: run && run.id === values[0] ? [run] : [], rowCount: run ? 1 : 0 };
    }
    if (s.includes("FROM spec_autonomy_runs WHERE project_id = $1")) {
      return { rows: run ? [run] : [], rowCount: run ? 1 : 0 };
    }
    if (s.startsWith("SELECT id FROM spec_autonomy_runs")) {
      return { rows: run && !isTerminalAutonomyStatus(run.status as AutonomyStatus) ? [{ id: run.id }] : [], rowCount: 1 };
    }

    if (s.startsWith("UPDATE spec_autonomy_runs")) {
      if (!run) return { rows: [], rowCount: 0 };
      // Claim: respeita `WHERE ... status = <esperado>` / `status = ANY(...)` / `round = $N`.
      const mStatus = s.match(/status = '([a-z_]+)'(?! ,)/g);
      const expected = s.match(/AND status = '([a-z_]+)'/)?.[1];
      if (expected && run.status !== expected) return { rows: [], rowCount: 0 };
      if (s.includes("status = ANY($5::text[])")) {
        const allowed = values[4] as string[];
        if (!allowed.includes(run.status as string)) return { rows: [], rowCount: 0 };
      }
      const mRound = s.match(/AND round = \$(\d+)/);
      if (mRound && run.round !== values[Number(mRound[1]) - 1]) return { rows: [], rowCount: 0 };
      void mStatus;

      // Aplica os SETs que a máquina de estados usa (posicional, igual ao SQL real).
      const setStatus = s.match(/SET status = '([a-z_]+)'/)?.[1] ?? s.match(/SET status = \$(\d+)/)?.[1];
      if (setStatus && /^[a-z_]+$/.test(setStatus)) run.status = setStatus;
      else if (setStatus) run.status = values[Number(setStatus) - 1] as string;
      const assign = (col: string) => {
        const m = s.match(new RegExp(`${col} = \\$(\\d+)`));
        if (m) run![col] = values[Number(m[1]) - 1];
      };
      for (const c of ["round", "chat_job_id", "base_spec_sha", "gaps_current", "no_progress_streak",
        "validation_run_id", "last_error", "max_rounds"]) assign(c);
      if (/validation_run_id = NULL/.test(s)) run.validation_run_id = null;
      if (/chat_job_id = NULL/.test(s)) run.chat_job_id = null;
      if (/rounds = rounds \|\| \$2::jsonb/.test(s)) {
        run.rounds = [...(run.rounds as unknown[]), ...JSON.parse(values[1] as string)];
      } else if (/rounds = \$2::jsonb/.test(s)) {
        run.rounds = JSON.parse(values[1] as string);
      }
      if (/finished_at = now\(\)/.test(s)) run.finished_at = nowIso();
      run.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
  connect: async () => { throw new Error("não usado"); },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

let validationStatus = "passed";
/** GAP-13 (migração 099): `false` = estágio adversarial NÃO rodou → contagem não comparável. */
let stageBRan: boolean | null = true;
/** GAP-11 (migração 100): `true` = job do estágio B ainda vivo no agents, resultado por coletar. */
let stageBPending = false;
/** GAP-18 (migração 101): cobertura desta validação. `null` = run legada (coluna NULL). */
let stageBCoverage: unknown = null;
/** GAP-18: cobertura da validação ANTERIOR — muda a resposta de "a superfície medida mudou?". */
let prevCoverage: unknown = null;

function writeSpec(content: string): void {
  const dir = mkdtempSync(join(tmpdir(), "spec-autonomy-"));
  specPath = join(dir, "PRODUCT_SPEC.md");
  writeFileSync(specPath, content, "utf-8");
}

const BASE_SPEC = "# Spec\n\n" + "conteúdo relevante da spec do produto. ".repeat(200);

beforeEach(() => {
  run = null;
  job = null;
  jobRowMissing = true;
  projectStatus = "draft";
  latestRunId = "run-0";
  validationStatus = "passed";
  stageBRan = true;
  stageBPending = false;
  stageBCoverage = null;
  prevCoverage = null;
  comparable = null;
  verdict = null;
  provaEsgotamento = false;
  coberturaAcumulada = null;
  delta = null;
  continuity = { persisted: 0, reconciled: false, reason: "dublê" };
  insertFails23505 = false;
  snapshotFails = false;
  specTreeFiles = [];
  sqlLog.length = 0;
  chatNotes.length = 0;
  findings = [{ severity: "blocker" }, { severity: "warning" }, { severity: "info" }];
  writeSpec(BASE_SPEC);
  process.env.API_AGENTS_URL = "http://agents:8000";
  startValidation.mockClear().mockResolvedValue({ ok: true as const, runId: "vr-1", reused: false });
  dispatchResolveGapsJob.mockClear().mockResolvedValue({ ok: true as const, gaps: 3 });
  // G4: a flag nasce DESLIGADA no código (fail-closed). Os testes de comportamento do laço
  // precisam ligá-la explicitamente — o default OFF tem teste próprio no fim do arquivo.
  process.env.SPEC_AUTONOMY = "on";
});

afterEach(() => { delete process.env.SPEC_AUTONOMY; });

async function start(maxRounds?: number) {
  const res = await startAutonomyRun(db, { projectId: PROJECT, tenantId: null, ownerUserId: OWNER, maxRounds });
  if (!res.ok) throw new Error(`start falhou: ${res.code}`);
  return res.run;
}

// ── 1. critério de parada ─────────────────────────────────────────────────────

describe("tallyGaps — só vermelho e amarelo ATIVOS sustentam nova rodada", () => {
  it("conta blocker+warning ativos e ignora info", () => {
    const t = tallyGaps([
      { severity: "blocker" }, { severity: "warning" }, { severity: "warning" }, { severity: "info" },
    ] as never);
    expect(t).toMatchObject({ important: 3, blockers: 1, warnings: 2, info: 1, active: 4 });
  });

  it("finding TRIADO (ignorado/refutado) não conta — é risco aceito ou falso positivo", () => {
    const t = tallyGaps([
      { severity: "blocker", triage: { state: "ignored" } },
      { severity: "warning", triage: { state: "refuted" } },
      { severity: "blocker" },
    ] as never);
    expect(t.important).toBe(1);
    expect(t.active).toBe(1);
  });

  it("spec só com info → zero importantes (o laço encerra em sucesso)", () => {
    expect(tallyGaps([{ severity: "info" }, { severity: "info" }] as never).important).toBe(0);
  });
});

describe("kill-switch e teto de rodadas", () => {
  it("SPEC_AUTONOMY=off desliga sem redeploy", async () => {
    process.env.SPEC_AUTONOMY = "off";
    expect(autonomyEnabled()).toBe(false);
    const res = await startAutonomyRun(db, { projectId: PROJECT, tenantId: null, ownerUserId: OWNER });
    expect(res).toMatchObject({ ok: false, code: "AUTONOMY_DISABLED", status: 503 });
  });

  it("maxRounds é limitado ao teto de 5 do pedido", async () => {
    const r = await start(99);
    expect(r.maxRounds).toBe(AUTONOMY_MAX_ROUNDS);
    expect(AUTONOMY_MAX_ROUNDS).toBe(5);
  });
});

// ── 2. recusas de arranque ────────────────────────────────────────────────────

describe("startAutonomyRun — recusas com motivo acionável", () => {
  it("sem GAP importante ativo → NO_GAPS (não gasta LLM)", async () => {
    findings = [{ severity: "info" }];
    const res = await startAutonomyRun(db, { projectId: PROJECT, tenantId: null, ownerUserId: OWNER });
    expect(res).toMatchObject({ ok: false, code: "NO_GAPS", status: 409 });
  });

  it("sem validação anterior → NO_VALIDATION", async () => {
    latestRunId = null;
    const res = await startAutonomyRun(db, { projectId: PROJECT, tenantId: null, ownerUserId: OWNER });
    expect(res).toMatchObject({ ok: false, code: "NO_VALIDATION" });
  });

  it("spec em fábrica → SPEC_LOCKED", async () => {
    projectStatus = "running";
    const res = await startAutonomyRun(db, { projectId: PROJECT, tenantId: null, ownerUserId: OWNER });
    expect(res).toMatchObject({ ok: false, code: "SPEC_LOCKED", status: 409 });
  });

  it("spec ilegível no disco → SPEC_FILES_MISSING", async () => {
    specPath = "";
    const res = await startAutonomyRun(db, { projectId: PROJECT, tenantId: null, ownerUserId: OWNER });
    expect(res).toMatchObject({ ok: false, code: "SPEC_FILES_MISSING", status: 422 });
  });

  it("laço já ativo no projeto → AUTONOMY_ALREADY_RUNNING (índice único parcial)", async () => {
    insertFails23505 = true;
    const res = await startAutonomyRun(db, { projectId: PROJECT, tenantId: null, ownerUserId: OWNER });
    expect(res).toMatchObject({ ok: false, code: "AUTONOMY_ALREADY_RUNNING", status: 409 });
  });
});

// ── 3. guardas de aplicação (perda de dados) ─────────────────────────────────

describe("guardas de aplicação da revisão", () => {
  it("aplica a revisão no disco e dispara a validação (caminho felizes)", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);              // pending → cto_running
    expect(dispatchResolveGapsJob).toHaveBeenCalledTimes(1);
    const revised = BASE_SPEC + "\n\n## Resolvido\n\nFR-99 detalhado.";
    job = { status: "done", specMarkdown: revised, error: null };
    await advanceAutonomyRun(db, r.id);              // cto_running → applying → validating
    expect(readFileSync(specPath, "utf-8")).toBe(revised);
    expect(startValidation).toHaveBeenCalledTimes(1);
    expect(run!.status).toBe("validating");
  });

  it("spec editada por fora → NÃO sobrescreve (stalled)", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    writeFileSync(specPath, BASE_SPEC + "\n\nEDIÇÃO HUMANA no meio do laço.", "utf-8");
    job = { status: "done", specMarkdown: BASE_SPEC + "\n\nrevisão do CTO", error: null };
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("stalled");
    expect(readFileSync(specPath, "utf-8")).toContain("EDIÇÃO HUMANA");
    expect(startValidation).not.toHaveBeenCalled();
  });

  it("revisão que ENCOLHE a spec (<70%) → NÃO aplica (stalled)", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    job = { status: "done", specMarkdown: "# Spec\n\nresumo curto", error: null };
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("stalled");
    expect(readFileSync(specPath, "utf-8")).toBe(BASE_SPEC);
  });

  it("revisão idêntica ao disco → não escreve, mas segue para a validação", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    job = { status: "done", specMarkdown: BASE_SPEC, error: null };
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("validating");
    expect(startValidation).toHaveBeenCalledTimes(1);
  });

  it("CTO BLOCKED (gate H4) → laço não aplica nada e reporta o motivo", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    job = { status: "error", specMarkdown: null, error: "O CTO não conseguiu revisar (BLOCKED)." };
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("pending");            // 1ª falha: tenta a rodada de novo
    expect(run!.no_progress_streak).toBe(1);
    expect(readFileSync(specPath, "utf-8")).toBe(BASE_SPEC);
  });
});

// ── 4. validação: rate-limit, orçamento e progresso ──────────────────────────

describe("validação dentro do laço", () => {
  async function reachValidating(maxRounds?: number) {
    const r = await start(maxRounds);
    await advanceAutonomyRun(db, r.id);
    job = { status: "done", specMarkdown: BASE_SPEC + "\n\nmelhoria substantiva do CTO.", error: null };
    await advanceAutonomyRun(db, r.id);
    return r;
  }

  it("GAP-A: rate-limit de 4/h NÃO derruba o laço — revalida no tick seguinte", async () => {
    startValidation.mockResolvedValueOnce({
      ok: false, code: "RATE_LIMITED", message: "Limite de 4 validações/hora por spec.", status: 429,
    } as never);
    const r = await reachValidating();
    expect(run!.status).toBe("validating");
    expect(run!.validation_run_id).toBeFalsy();
    await advanceAutonomyRun(db, r.id);            // tick seguinte tenta de novo
    expect(startValidation).toHaveBeenCalledTimes(2);
    expect(run!.validation_run_id).toBe("vr-1");
  });

  /**
   * 🔴 GAP-44 (medido em prod 2026-09-07) — o one-flight de validação é por PROJETO, não por conteúdo.
   * A validação `a17bf391` nasceu 05:58; a run de autonomia `fb57dec7` começou 06:00, reescreveu 7
   * arquivos entre 06:02 e 06:13 e, ao pedir sua validação, recebeu `a17bf391` de volta — uma leitura
   * que não viu UM byte do que o passe escreveu. Ela morreu no deadline e o passe foi debitado como
   * "sem medição". Mesmo se tivesse passado, mediria o conteúdo ERRADO.
   */
  it("🔴 GAP-44: validação em voo de conteúdo ANTERIOR ao passe não é adotada como medição dele", async () => {
    startValidation.mockResolvedValueOnce({
      ok: true, runId: "vr-antiga", reused: true, staleReuse: true,
    } as never);
    const r = await reachValidating();
    expect(run!.status).toBe("validating");
    expect(run!.validation_run_id).toBeFalsy();       // 🔴 NÃO herdou a run velha
    expect(String(run!.last_error)).toContain("não mede o que o passe escreveu");
    await advanceAutonomyRun(db, r.id);               // tick seguinte: a run em voo já terminou
    expect(startValidation).toHaveBeenCalledTimes(2);
    expect(run!.validation_run_id).toBe("vr-1");
  });

  it("GAP-44: reuso de run que mede o MESMO conteúdo continua sendo adotado (sem regressão)", async () => {
    startValidation.mockResolvedValueOnce({ ok: true, runId: "vr-mesma", reused: true } as never);
    await reachValidating();
    expect(run!.validation_run_id).toBe("vr-mesma");
  });

  it("GAP-B: orçamento do tenant estourado (402) → failed com a mensagem financeira", async () => {
    startValidation.mockResolvedValueOnce({
      ok: false, code: "TENANT_LLM_BUDGET_EXCEEDED", message: "Orçamento de LLM excedido.", status: 402,
    } as never);
    await reachValidating();
    expect(run!.status).toBe("failed");
    expect(String(run!.last_error)).toContain("TENANT_LLM_BUDGET_EXCEEDED");
  });

  it("zero GAPs importantes após validar → succeeded (info em aberto não impede)", async () => {
    const r = await reachValidating();
    findings = [{ severity: "info" }];
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("succeeded");
  });

  it("GAPs caíram mas sobraram → nova rodada (round 2)", async () => {
    const r = await reachValidating();
    findings = [{ severity: "blocker" }];
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("pending");
    expect(run!.gaps_current).toBe(1);
    expect((run!.rounds as unknown[]).length).toBe(1);
    await advanceAutonomyRun(db, r.id);
    expect(run!.round).toBe(2);
    expect(dispatchResolveGapsJob).toHaveBeenCalledTimes(2);
  });

  it("teto de rodadas atingido com GAP em aberto → exhausted", async () => {
    const r = await reachValidating(1);
    await advanceAutonomyRun(db, r.id);            // ainda 3 findings (1 blocker + 1 warning)
    expect(run!.status).toBe("exhausted");
    expect(run!.round).toBe(1);
  });

  /**
   * 🔴 GAP-77 — o Jean deu ao juiz autoridade para dizer se um GAP REINCIDENTE impede promover à
   * Fábrica, e reservou o gatilho ao defeito que voltou DEPOIS de foco individual pago. O lugar do laço
   * onde isso cabe é o fim: `exhausted` (teto) e `stalled` (não-progresso) — os dois pontos em que ele
   * ia mandar o humano "tratar à mão" sobre defeitos que ele já provou não conseguir fechar.
   *
   * O que estes testes travam:
   *  - o veredicto roda nos DOIS fins de laço, e o parecer entra no log da rodada E na mensagem final;
   *  - a severidade NÃO muda (limite (a)): o total importante continua sendo dito, `gaps_current`
   *    continua sendo o mesmo número, e nada vira `succeeded` por parecer;
   *  - as RECUSAS de elegibilidade ficam no log (auditoria da guarda (c));
   *  - veredicto indisponível/desligado → mensagem antiga, sem inventar liberação (fail-CLOSED).
   */
  describe("🔴 GAP-77 — veredicto de promovibilidade no fim do laço", () => {
    it("teto de rodadas: o juiz julga os reincidentes e o parecer entra no log e na mensagem", async () => {
      verdict = { candidates: 2, released: 1, impeditive: 1, promotable: false };
      const r = await reachValidating(1);
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      const last = (run!.rounds as Array<Record<string, unknown>>).at(-1)!;
      expect(last).toMatchObject({ verdictCandidates: 2, verdictReleased: 1, verdictImpeditive: 1, promotable: false });
      expect(String(run!.last_error)).toContain("Rodada adversarial de promovibilidade");
      expect(String(run!.last_error)).toContain("NÃO promovível");
      // limite (a): o total importante continua declarado, nada foi reclassificado.
      expect(String(run!.last_error)).toContain("2 GAP(s) importante(s) em aberto");
      expect(run!.gaps_current).toBe(2);
    });

    it("spec declarada PROMOVÍVEL não vira `succeeded` — promover segue ato humano", async () => {
      verdict = { candidates: 1, released: 1, impeditive: 0, promotable: true };
      const r = await reachValidating(1);
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");        // NÃO `succeeded`
      expect(String(run!.last_error)).toContain("Spec PROMOVÍVEL à Fábrica");
      expect(String(run!.last_error)).toContain("ato humano");
      expect((run!.rounds as Array<Record<string, unknown>>).at(-1)).toMatchObject({ promotable: true });
    });

    it("duas rodadas sem progresso: o parecer também aparece no `stalled`", async () => {
      verdict = { candidates: 1, released: 0, impeditive: 2, promotable: false };
      const r = await reachValidating(5);
      await advanceAutonomyRun(db, r.id);
      job = { status: "done", specMarkdown: BASE_SPEC + "\n\noutra tentativa do CTO.", error: null };
      await advanceAutonomyRun(db, r.id);
      await advanceAutonomyRun(db, r.id);
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("stalled");
      expect(String(run!.last_error)).toContain("sem derrubar GAP importante");
      expect(String(run!.last_error)).toContain("promovibilidade");
    });

    it("as RECUSAS de elegibilidade vão para o log — auditoria da guarda (c)", async () => {
      verdict = {
        candidates: 0, released: 0, impeditive: 2, promotable: false,
        rejected: [{ file: "produto.md", anchor: "## 4", why: "o trecho sobreviveu byte a byte: é NÃO-TENTADO" }],
      };
      const r = await reachValidating(1);
      await advanceAutonomyRun(db, r.id);
      const last = (run!.rounds as Array<Record<string, unknown>>).at(-1)!;
      expect(JSON.stringify(last.verdictRejected)).toContain("NÃO-TENTADO");
      expect(last).toMatchObject({ verdictCandidates: 0, verdictReleased: 0 });
    });

    /**
     * 🔴 GAP-83 — a rodada terminal tem de sair do tick com AS DUAS gravações: a medição da validação
     * (GAP-76) e o parecer do juiz (GAP-77).
     *
     * MEDIDO em prod na run `88339651`, rodada 21: `gapsAfter`, `gapsClosed`, `gapsComparableBefore/Now/
     * Same` e `comparableFiles` foram gravados pela validação e DESAPARECERAM quando o veredicto gravou
     * os campos dele, no mesmo tick — porque `patchLastRound` reescrevia o array inteiro a partir do
     * mesmo snapshot em memória (lost update dentro do próprio processo). Consequência: em TODA run que
     * termina pelo caminho do veredicto, o parecer de promovibilidade ficava sem a única medição de
     * nível auditável, e a nota da validação desaparecia do log.
     */
    it("GAP-83: o veredicto NÃO apaga a medição da validação da mesma rodada", async () => {
      verdict = { candidates: 2, released: 1, impeditive: 1, promotable: false };
      comparable = { files: ["produto.md"], before: 3, now: 2, same: 2 };
      const r = await reachValidating(1);
      await advanceAutonomyRun(db, r.id);
      const last = (run!.rounds as Array<Record<string, unknown>>).at(-1)!;
      // Os dois conjuntos convivem na MESMA rodada.
      expect(last).toMatchObject({
        gapsComparableBefore: 3, gapsComparableNow: 2, gapsComparableSame: 2, comparableFiles: 1,
        verdictCandidates: 2, verdictImpeditive: 1, promotable: false,
      });
      expect(last.gapsAfter).toBe(2);
      // E a nota carrega as duas leituras, na ordem em que foram escritas.
      expect(String(last.note)).toContain("Nível COMPARÁVEL");
      expect(String(last.note)).toContain("promovibilidade");
    });

    /**
     * 🔴 GAP-82 — o poder do juiz também abre por ESGOTAMENTO do laço, e o log tem de dizer isso com os
     * números: um parecer dado depois de "0 fechado" não pode parecer um parecer dado depois de trabalho
     * bem-sucedido.
     */
    it("GAP-82: prova por esgotamento vai gravada e declarada na mensagem final", async () => {
      verdict = { candidates: 2, released: 1, impeditive: 1, promotable: false };
      provaEsgotamento = true;
      const r = await reachValidating(1);
      await advanceAutonomyRun(db, r.id);
      const last = (run!.rounds as Array<Record<string, unknown>>).at(-1)!;
      expect(last.workProof).toBe("exhausted");
      expect(last.gapsClosedTotal).toBe(0);
      expect(String(last.verdictWork)).toContain("0 GAP(s) fechado(s)");
      expect(String(run!.last_error)).toContain("laço esgotou o orçamento sem fechar GAP");
    });

    it("veredicto desligado → mensagem antiga, sem campo de parecer no log (fail-CLOSED)", async () => {
      verdict = null;                                 // `minGapsResolved: 0` no dublê
      const r = await reachValidating(1);
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).not.toContain("promovibilidade");
      expect(String(run!.last_error)).toContain("Trate na aba GAPs");
      expect((run!.rounds as Array<Record<string, unknown>>).at(-1)!.verdictCandidates).toBeUndefined();
    });
  });

  it("duas rodadas sem derrubar GAP importante → stalled (não queima as 5)", async () => {
    const r = await reachValidating(5);
    await advanceAutonomyRun(db, r.id);            // rodada 1: GAPs iguais → streak 1
    expect(run!.status).toBe("pending");
    expect(run!.no_progress_streak).toBe(1);
    await advanceAutonomyRun(db, r.id);            // rodada 2 dispara
    job = { status: "done", specMarkdown: BASE_SPEC + "\n\noutra tentativa do CTO.", error: null };
    await advanceAutonomyRun(db, r.id);            // aplica + valida
    await advanceAutonomyRun(db, r.id);            // mede: continua igual → streak 2
    expect(run!.status).toBe("stalled");
  });

  // 🔴 GAP-43 (2026-09-07): esta asserção pedia `no_progress_streak = 1`. Ela estava ERRADA e a prova
  // veio de prod: o passe 0 da run `fb57dec7` reescreveu SETE arquivos com sucesso e levou streak = 1
  // porque a validação que o mediria morreu no deadline (GAP-44). O streak existe para matar laço que
  // não converge — e uma medição perdida não diz nada sobre convergência. Agora: perdoa UMA vez por run
  // (sem tocar no streak) e, na segunda, PARA dizendo que faltou medição.
  it("validação em 'superseded' NÃO mediu ⇒ não conta como passe sem progresso (GAP-43)", async () => {
    const r = await reachValidating(5);
    validationStatus = "superseded";
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("pending");
    expect(run!.no_progress_streak).toBe(0);
    const log = JSON.stringify(run!.rounds);
    expect(log).toContain("sem medição de GAPs");
    expect(log).toContain('"unmeasured":true');
  });

  it("🔴 GAP-43 — SEGUNDA validação sem medição encerra a run culpando a MEDIÇÃO, não a convergência", async () => {
    const r = await reachValidating(5);
    validationStatus = "superseded";
    await advanceAutonomyRun(db, r.id);              // 1ª: perdoada
    expect(run!.status).toBe("pending");
    await advanceAutonomyRun(db, r.id);              // dispara a rodada seguinte
    job = { status: "done", specMarkdown: BASE_SPEC + "\n\noutra tentativa do CTO.", error: null };
    await advanceAutonomyRun(db, r.id);              // aplica + valida
    await advanceAutonomyRun(db, r.id);              // 2ª validação também não mede
    expect(run!.status).toBe("stalled");
    expect(String(run!.last_error)).toContain("sem medir os GAPs");
    expect(String(run!.last_error)).toContain("falta de medição");
    // o perdão é de UMA vez: o streak nunca foi usado para justificar a parada
    expect(run!.no_progress_streak).toBe(0);
  });

  /**
   * 🔴 GAP-45 (medido em prod 2026-09-07) — a validação, que é evento do PASSE, gravava o recorte
   * 🔴/🟡 do PROJETO INTEIRO sobre os campos `blockers`/`warnings` da última rodada, que significam
   * "GAPs DESTE arquivo". Na run `5d377da0` a rodada 6 ficou `observabilidade-operacao.md — 🔴 23 · 🟡 21`
   * (23+21 = 44 = o total do projeto) enquanto a rodada 9, o MESMO arquivo, dizia 🔴 2 · 🟡 4 — e é
   * exatamente esse par que o portal desenha ao lado do nome do arquivo. Irmão do GAP-30, que salvou a
   * `note` e deixou os números mentindo.
   */
  it("🔴 GAP-45: a validação NÃO sobrescreve o 🔴/🟡 da rodada — o total do passe vai em campo próprio", async () => {
    const r = await reachValidating(5);
    // A rodada foi despachada com o recorte de ANTES (1 blocker + 1 warning, do beforeEach).
    const antes = (run!.rounds as Array<Record<string, unknown>>).at(-1)!;
    expect(antes.blockers).toBe(1);
    expect(antes.warnings).toBe(1);
    // A validação do passe mede um recorte DIFERENTE — é a única variável do teste.
    findings = [
      { severity: "blocker" }, { severity: "blocker" }, { severity: "blocker" },
      { severity: "warning" }, { severity: "warning" },
    ];
    await advanceAutonomyRun(db, r.id);
    const depois = (run!.rounds as Array<Record<string, unknown>>).at(-1)!;
    expect(depois.blockers).toBe(1);          // 🔴 intocado: continua sendo o recorte da RODADA
    expect(depois.warnings).toBe(1);
    expect(depois.passBlockers).toBe(3);      // o recorte do PASSE, rotulado como tal
    expect(depois.passWarnings).toBe(2);
    expect(depois.gapsAfter).toBe(5);
  });

  /**
   * 🔴 GAP-46 — a contagem que decide a parada do laço não sabia quais arquivos AINDA existem.
   *
   * `surveyFindings` (`findingTriage.ts:268`) só resolve um finding por REMOÇÃO do arquivo quando
   * recebe `currentFiles`; o laço chamava `projectFindingsState` sem esse argumento. Efeito: GAP em
   * arquivo que saiu da spec ficava ATIVO para sempre (nenhuma rotação de cobertura o rejulgaria), e a
   * lista da Bancada — que SEMPRE passou `currentFiles` — divergia do laço. Latente no NVX hoje
   * (medido: os 7 arquivos citados nos findings existem todos), ativo no primeiro `split`/remoção.
   */
  describe("GAP-46 — a contagem enxerga arquivo REMOVIDO da spec", () => {
    it("a árvore atual da spec é entregue ao survey (e ao diff finding-a-finding)", async () => {
      specTreeFiles = [
        { filename: "README.md", rel_dir: "" },
        { filename: "01-api.md", rel_dir: "backend" },
        { filename: "modelo.md", rel_dir: "/dados/" },   // barras nas pontas são normalizadas
      ];
      const r = await reachValidating(5);
      await advanceAutonomyRun(db, r.id);
      const esperado = ["README.md", "backend/01-api.md", "dados/modelo.md"];
      expect(projectFindingsState).toHaveBeenCalledWith(db, PROJECT, { currentFiles: esperado });
      expect(gapDeltaSinceLastRun).toHaveBeenCalledWith(db, PROJECT, esperado);
    });

    it("🔴 árvore VAZIA não vira 'todos os arquivos foram removidos' — cai no legado (`null`)", async () => {
      // Sem esta guarda uma leitura transitória apagaria a contagem inteira e o laço declararia
      // `succeeded` sobre uma spec cheia de GAPs. Erro seguro = não detectar remoção nenhuma.
      specTreeFiles = [];
      const r = await reachValidating(5);
      await advanceAutonomyRun(db, r.id);
      expect(projectFindingsState).toHaveBeenCalledWith(db, PROJECT, { currentFiles: null });
      expect(gapDeltaSinceLastRun).toHaveBeenCalledWith(db, PROJECT, null);
    });
  });

  // GAP-13 (medido em prod 2026-09-06, run c3757985): a validação `8e3286b2` durou 230 ms, achou 1
  // blocker estrutural no Estágio A e por isso NÃO rodou o adversarial. O laço registrou "21 → 1 GAP"
  // como progresso e, no tick seguinte, "1 → 21" como regressão. Nenhum dos dois é medida da spec.
  describe("GAP-13 — contagem de validação PARCIAL não é comparável", () => {
    it("estágio B pulado → NÃO conta progresso, mantém a contagem e diz o motivo", async () => {
      const r = await reachValidating(5);
      expect(run!.gaps_current).toBe(2);            // 1 blocker + 1 warning da validação completa
      stageBRan = false;
      validationStatus = "failed";
      findings = [{ severity: "blocker" }];          // a leitura parcial "só" vê 1 GAP
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("pending");
      expect(run!.gaps_current).toBe(2);            // 🔴 o "1" NÃO virou a nova verdade
      expect(run!.no_progress_streak).toBe(1);      // nada foi provado → não zera o streak
      const note = JSON.stringify(run!.rounds);
      expect(note).toContain("PARCIAL");
      expect(note).toContain("NÃO são comparáveis");
      // 🔴 GAP-30: a nota da rodada (o que aconteceu com o ARQUIVO) sobrevive à nota do PASSE.
      expect(note).toContain("Spec aplicada no disco");
    });

    it("🔴 zero GAPs numa validação PARCIAL não declara `succeeded` (vitória fictícia)", async () => {
      const r = await reachValidating(5);
      stageBRan = false;
      validationStatus = "passed";
      findings = [];                                 // o Estágio A não achou nada — mas ninguém julgou o resto
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("pending");
      expect(run!.status).not.toBe("succeeded");
    });

    it("parcial no segundo passe sem progresso → stalled explicando o bloqueador estrutural", async () => {
      const r = await reachValidating(5);
      await advanceAutonomyRun(db, r.id);           // rodada 1 completa, GAPs iguais → streak 1
      expect(run!.no_progress_streak).toBe(1);
      await advanceAutonomyRun(db, r.id);           // dispara rodada 2
      job = { status: "done", specMarkdown: BASE_SPEC + "\n\noutra tentativa do CTO.", error: null };
      await advanceAutonomyRun(db, r.id);           // aplica + valida
      stageBRan = false;
      validationStatus = "failed";
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("stalled");
      expect(String(run!.last_error)).toContain("estrutural");
    });

    it("`stage_b_ran` NULL (run anterior à migração 099) mantém a comparação de antes", async () => {
      const r = await reachValidating(5);
      stageBRan = null;
      findings = [{ severity: "blocker" }];
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("pending");
      expect(run!.gaps_current).toBe(1);            // comportamento histórico intocado
      expect(run!.no_progress_streak).toBe(0);
    });
  });

  // GAP-11 (medido em prod 2026-09-06): a validação `16e467cf` esperou 20m40s, estourou o teto e
  // terminou 'error' com 0 findings — enquanto o job adversarial seguia vivo no agents. O teto
  // expira a ESPERA, nunca o RESULTADO: com coleta pendente o laço aguarda em vez de gastar rodada.
  describe("GAP-11 — validação em erro com resultado pendente de coleta", () => {
    it("resultado pendente → o laço ESPERA (sem rodada sem progresso, sem transição)", async () => {
      const r = await reachValidating(5);
      validationStatus = "error";
      stageBPending = true;
      expect(await advanceAutonomyRun(db, r.id)).toBe(false);
      expect(run!.status).toBe("validating");         // continua esperando o coletor
      expect(run!.no_progress_streak).toBe(0);        // 🔴 nada foi gasto por causa do relógio
      expect(JSON.stringify(run!.rounds)).not.toContain("sem medição de GAPs");
    });

    it("coleta encerrada (nada a recuperar) → registra a falta de medição e revalida (GAP-43)", async () => {
      const r = await reachValidating(5);
      validationStatus = "error";
      stageBPending = false;                          // coletor já desistiu / job perdido
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("pending");
      // GAP-43: o resultado morreu de verdade, mas isso ainda não é "o passe não progrediu" — o streak
      // (freio de custo por NÃO CONVERGÊNCIA) não avança na primeira vez; a marca `unmeasured` é que
      // segura a segunda.
      expect(run!.no_progress_streak).toBe(0);
      expect(JSON.stringify(run!.rounds)).toContain("sem medição de GAPs");
      expect(JSON.stringify(run!.rounds)).toContain('"unmeasured":true');
    });

    it("teto de passes + pendência não força `stalled` por relógio (espera primeiro)", async () => {
      const r = await reachValidating(1);             // teto 1 → o próximo veredito encerraria a run
      validationStatus = "error";
      stageBPending = true;
      expect(await advanceAutonomyRun(db, r.id)).toBe(false);
      expect(run!.status).toBe("validating");
      expect(run!.status).not.toBe("stalled");
    });
  });

  // GAP-18/GAP-19 (medido em prod 2026-09-06, NVX LastMile: 12 arquivos / 950.965 chars): o estágio
  // adversarial julgava por INTEIRO sempre os MESMOS 2 arquivos (promoção determinística por tamanho)
  // e os outros 10 entravam só como sumário de cabeçalhos. "Zero GAP" ali é zero GAP em 2/12 da spec.
  describe("GAP-19 — `succeeded` exige que o juiz tenha lido a spec INTEIRA", () => {
    it("🔴 zero GAPs com cobertura INCOMPLETA → revalida (não declara sucesso sobre parte da spec)", async () => {
      const r = await reachValidating(5);
      findings = [];
      stageBCoverage = { full: ["01-spec.md"], outlineOnly: ["modelo-dados.md"], oversized: [] };
      coberturaAcumulada = { unjudged: ["modelo-dados.md"], judged: 1, total: 2 };
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).not.toBe("succeeded");
      expect(run!.status).toBe("validating");            // segue no laço, sem alvo → o tick revalida
      expect(run!.validation_run_id).toBeNull();
      const upd = sqlLog.filter((q) => q.sql.includes("UPDATE spec_autonomy_runs") && q.sql.includes("round = round + 1"));
      expect(upd.length).toBeGreaterThan(0);
      expect(JSON.stringify(run!.rounds)).toContain("Cobertura desta validação");
    });

    it("cobertura COMPLETA → succeeded dizendo quantos arquivos foram julgados por inteiro", async () => {
      const r = await reachValidating(5);
      findings = [];
      stageBCoverage = { full: ["01-spec.md", "modelo-dados.md"], outlineOnly: [], oversized: [] };
      coberturaAcumulada = { unjudged: [], judged: 2, total: 2 };
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("succeeded");
      expect(String(run!.last_error)).toContain("julgou os 2 arquivo(s) da spec por INTEIRO");
      expect(JSON.stringify(run!.rounds)).not.toContain("Cobertura desta validação");
    });

    it("🔴 spec grande: `outlineOnly` desta run NUNCA é vazio — o que fecha a conta é a UNIÃO das rodadas", async () => {
      // Defeito pego antes do deploy: medir a pendência pelo `outlineOnly` de UMA validação faria o
      // laço revalidar até o teto e terminar `exhausted` mesmo com a spec inteira já julgada — numa
      // spec de 950.965 chars contra teto de 400.000, nenhuma run isolada leva os 12 arquivos.
      const r = await reachValidating(5);
      findings = [];
      stageBCoverage = { full: ["g.md", "h.md"], outlineOnly: ["a.md", "b.md"], oversized: [] };
      coberturaAcumulada = { unjudged: [], judged: 12, total: 12 };   // as rodadas anteriores cobriram o resto
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("succeeded");
      expect(String(run!.last_error)).toContain("julgou os 12 arquivo(s) da spec por INTEIRO");
    });

    it("cobertura ausente (run anterior à migração 101) → comportamento legado: succeeded", async () => {
      const r = await reachValidating(5);
      findings = [];
      stageBCoverage = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("succeeded");
    });

    it("o que falta não cabe nem sozinho → stalled pedindo a DIVISÃO (rotação não resolve)", async () => {
      const r = await reachValidating(5);
      findings = [];
      stageBCoverage = { full: ["01-spec.md"], outlineOnly: ["monstro.md"], oversized: ["monstro.md"] };
      coberturaAcumulada = { unjudged: ["monstro.md"], judged: 1, total: 2 };
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("stalled");
      expect(String(run!.last_error)).toContain("Dividir");
      expect(String(run!.last_error)).toContain("monstro.md");
    });

    it("teto de rodadas + cobertura incompleta → exhausted honesto, nunca `succeeded`", async () => {
      const r = await reachValidating(1);
      findings = [];
      stageBCoverage = { full: ["01-spec.md"], outlineOnly: ["modelo-dados.md"], oversized: [] };
      coberturaAcumulada = { unjudged: ["modelo-dados.md"], judged: 1, total: 2 };
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).toContain("NÃO declaro a spec validada");
    });

    it("🔴 superfície medida MUDOU → contagem não comparável: o streak não avança (lei do GAP-13)", async () => {
      const r = await reachValidating(5);
      // Mesmos 2 GAPs importantes de antes, mas o juiz leu OUTRO arquivo: a contagem igual não prova
      // laço travado. Sem isto a rotação de cobertura mataria a run por `stalled` em 2 rodadas.
      stageBCoverage = { full: ["modelo-dados.md"], outlineOnly: ["01-spec.md"], oversized: [] };
      prevCoverage = { full: ["01-spec.md"], outlineOnly: ["modelo-dados.md"], oversized: [] };
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("pending");
      expect(run!.no_progress_streak).toBe(0);
      // GAP-76: a ressalva saiu do FIM da nota para o lugar da seta `antes → agora`, que deixou de
      // existir quando as duas contagens não são comparáveis.
      expect(JSON.stringify(run!.rounds)).toContain("a superfície medida MUDOU");
      expect(JSON.stringify(run!.rounds)).not.toContain("2 → 2 GAP(s)");
    });

    describe("GAP-76 — o agregado não é progresso quando a superfície não é comparável", () => {
      /**
       * Medido em prod 2026-09-07 (NVX LastMile): a contagem do laço caiu de 23 para 20 findings entre
       * duas validações e no subconjunto julgado por inteiro nas DUAS era 20 → 20, as mesmas 20 âncoras,
       * zero fechado — apesar de 22 edições aplicadas. O código antigo lia essa queda como progresso,
       * zerava o `no_progress_streak` e seguia pagando LLM por uma melhora que nunca houve.
       */
      it("🔴 agregado que CAIU com a superfície MUDADA não zera mais o freio", async () => {
        const r = await reachValidating(5);
        run!.no_progress_streak = 1;
        findings = [{ severity: "blocker" }];   // agregado 2 → 1: "caiu"
        stageBCoverage = { full: ["modelo-dados.md"], outlineOnly: [], oversized: [] };
        prevCoverage = { full: ["visao-escopo.md"], outlineOnly: [], oversized: [] };
        comparable = { files: ["modelo-dados.md"], before: 20, now: 20, same: 20 };
        await advanceAutonomyRun(db, r.id);
        expect(run!.no_progress_streak).toBe(1);   // ANTES desta correção: 0
        const log = JSON.stringify(run!.rounds);
        expect(log).toContain("as MESMAS 20 âncoras, zero fechado");
        expect(log).toContain('"gapsComparableBefore":20');
        expect(log).toContain('"comparableFiles":1');
      });

      it("queda no nível COMPARÁVEL é progresso, mesmo com a superfície mudada", async () => {
        const r = await reachValidating(5);
        run!.no_progress_streak = 1;
        stageBCoverage = { full: ["modelo-dados.md"], outlineOnly: [], oversized: [] };
        prevCoverage = { full: ["modelo-dados.md", "visao-escopo.md"], outlineOnly: [], oversized: [] };
        comparable = { files: ["modelo-dados.md"], before: 20, now: 18, same: 18 };
        await advanceAutonomyRun(db, r.id);
        expect(run!.no_progress_streak).toBe(0);
      });

      it("mesma superfície: queda do agregado continua sendo progresso (não apertei demais)", async () => {
        const r = await reachValidating(5);
        run!.no_progress_streak = 1;
        findings = [{ severity: "blocker" }];
        const mesma = { full: ["01-spec.md"], outlineOnly: [], oversized: [] };
        stageBCoverage = mesma;
        prevCoverage = { ...mesma };
        await advanceAutonomyRun(db, r.id);
        expect(run!.no_progress_streak).toBe(0);
        expect(JSON.stringify(run!.rounds)).toContain("2 → 1 GAP(s)");
      });

      it("nenhum arquivo em comum: o laço DIZ que não há nível comparável (não inventa um)", async () => {
        const r = await reachValidating(5);
        stageBCoverage = { full: ["modelo-dados.md"], outlineOnly: [], oversized: [] };
        prevCoverage = { full: ["visao-escopo.md"], outlineOnly: [], oversized: [] };
        comparable = { files: [], before: 0, now: 0, same: 0 };
        await advanceAutonomyRun(db, r.id);
        const log = JSON.stringify(run!.rounds);
        expect(log).toContain("NÃO existe nível comparável");
        expect(log).not.toContain("Nível COMPARÁVEL");
      });
    });

    it("mesma superfície e mesma contagem → streak avança normalmente (o freio continua vivo)", async () => {
      const r = await reachValidating(5);
      stageBCoverage = { full: ["01-spec.md"], outlineOnly: ["modelo-dados.md"], oversized: [] };
      prevCoverage = { full: ["01-spec.md"], outlineOnly: ["modelo-dados.md"], oversized: [] };
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("pending");
      expect(run!.no_progress_streak).toBe(1);
      expect(JSON.stringify(run!.rounds)).not.toContain("Superfície medida MUDOU");
    });
  });

  /**
   * 🔴 GAP-41 — o laço só sabia comparar o AGREGADO. Medido em prod (NVX LastMile, 4 janelas de 10
   * runs): 11–17 GAPs saem e 11–25 entram por passe, `openedOnNewSurface = 0` em todas. Um total
   * parado era indistinguível de "nada aconteceu" — e a pergunta do Jean ("a contagem tem de CAIR")
   * ficava sem resposta.
   */
  describe("GAP-41 — diferença finding-a-finding no log e no chat", () => {
    it("registra fechados/novos na rodada e diz em voz alta que é REGRESSÃO, não descoberta", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}], opened: [{}, {}], openedOnNewSurface: 0 };
      await advanceAutonomyRun(db, r.id);
      const rounds = run!.rounds as Array<Record<string, unknown>>;
      expect(rounds.at(-1)).toMatchObject({ gapsClosed: 1, gapsOpened: 2 });
      const note = JSON.stringify(run!.rounds);
      expect(note).toContain("1 fechado(s), 2 novo(s)");
      expect(note).toContain("REGRESSÃO/reformulação, não descoberta");
    });

    it("saldo FAVORÁVEL conta como progresso mesmo com o agregado parado (sobrevive à rotação)", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}, {}, {}], opened: [{}], openedOnNewSurface: 0 };
      // GAP-67: o saldo só é progresso quando a diferença foi RECONCILIADA — sem isso, "3 fecharam"
      // pode ser deriva de âncora. Aqui o reconciliador rodou e não achou rebatismo.
      continuity = { persisted: 0, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      expect(run!.gaps_current).toBe(2);            // agregado idêntico ao do passe anterior
      expect(run!.no_progress_streak).toBe(0);      // …mas saíram 3 e entrou 1
    });

    it("🔴 fechar 1 e abrir 25 NÃO é progresso: o freio de gasto continua vivo", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}], opened: Array.from({ length: 25 }, () => ({})), openedOnNewSurface: 0 };
      await advanceAutonomyRun(db, r.id);
      expect(run!.no_progress_streak).toBe(1);
      await advanceAutonomyRun(db, r.id);           // dispara rodada 2
      job = { status: "done", specMarkdown: BASE_SPEC + "\n\noutra tentativa do CTO.", error: null };
      await advanceAutonomyRun(db, r.id);
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("stalled");          // 2 passes sem saldo → para de gastar LLM
    });

    it("parcela de DESCOBERTA aparece separada quando o arquivo é inédito", async () => {
      const r = await reachValidating(5);
      delta = { closed: [], opened: [{}, {}], openedOnNewSurface: 2 };
      await advanceAutonomyRun(db, r.id);
      expect(JSON.stringify(run!.rounds)).toContain("2 em arquivo julgado por INTEIRO pela 1ª vez");
    });

    /**
     * 🔴 GAP-126 — MEDIDO em prod (`9e5ea585` → `e231e5ea`): 3 dos 9 novos estavam em `visao-escopo.md`
     * com sha IDÊNTICO nas duas coberturas e sem uma única rodada tocando o arquivo. Eles entravam no
     * saldo `closed > opened` como regressão do laço e avançavam o `no_progress_streak` — o freio que
     * MATA a run. E o chat dizia "1 fechado × 7 novos" afirmando uma causalidade que os shas negam.
     */
    it("🔴 GAP-126: novo em arquivo de sha IDÊNTICO não punie o saldo — a run que fechou 1 progrediu", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}], opened: [{}, {}, {}], openedOnNewSurface: 0, openedOnUnchangedText: 3 };
      continuity = { persisted: 0, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      expect(run!.no_progress_streak).toBe(0);   // 1 fechado × 0 atribuível
      const rounds = JSON.stringify(run!.rounds);
      expect(rounds).toContain("3 NÃO são regressão desta edição");
      expect(rounds).toContain("sha IDÊNTICO");
      expect(rounds).toContain("Parcela atribuível a esta edição: 0");
      expect(rounds).not.toContain("REGRESSÃO/reformulação, não descoberta");
    });

    it("🔴 GAP-126 não inventa progresso: zero fechado segue sem progresso mesmo com todos os novos não-atribuíveis", async () => {
      const r = await reachValidating(5);
      delta = { closed: [], opened: [{}, {}, {}], openedOnNewSurface: 1, openedOnUnchangedText: 2 };
      continuity = { persisted: 0, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      expect(run!.no_progress_streak).toBe(1);   // `0 > 0` é falso — o freio de gasto continua vivo
      expect(JSON.stringify(run!.rounds)).toContain("Parcela atribuível a esta edição: 0");
    });

    it("🔴 GAP-126: os baldes somados nunca passam do total de novos (nem com reconciliação cortando)", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}], opened: [{}, {}], openedOnNewSurface: 2, openedOnUnchangedText: 2 };
      continuity = { persisted: 0, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      expect(JSON.stringify(run!.rounds)).toContain("Parcela atribuível a esta edição: 0");
      // A guarda é "nenhum balde NEGATIVO", e tem de ser dita sobre o NÚMERO — `not.toContain("-2")`
      // sobre o JSON inteiro colidia com o UUID de fixture (`11111111-2222-…`) sempre que algum ramo
      // citava o id da run, e o teste falhava de forma intermitente por um motivo que não era o dele.
      expect(JSON.stringify(run!.rounds)).not.toMatch(/atribuível a esta edição: -/);
      const last = (run!.rounds as Array<Record<string, unknown>>).at(-1)!;
      expect(Number(last.gapsOpenedAttributable)).toBeGreaterThanOrEqual(0);
    });

    it("🔴 GAP-126: ZERO novos não é caracterizado como regressão (afirmação sobre conjunto vazio)", async () => {
      // A nota do passe 1 da run `a52b5e1b` (prod, 2026-09-08) saiu com "8 fechado(s), 0 novo(s) — todos
      // em arquivo já julgado antes, ou seja REGRESSÃO": não havia nenhum para caracterizar.
      const r = await reachValidating(5);
      delta = { closed: [{}, {}], opened: [], openedOnNewSurface: 0, openedOnUnchangedText: 0 };
      continuity = { persisted: 0, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      const rounds = JSON.stringify(run!.rounds);
      expect(rounds).toContain("2 fechado(s), 0 novo(s)");
      expect(rounds).not.toContain("REGRESSÃO/reformulação");
    });

    it("🔴 GAP-126: regressão de verdade (sha mudou) continua sendo relatada como regressão e punindo o saldo", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}], opened: [{}, {}], openedOnNewSurface: 0, openedOnUnchangedText: 0 };
      continuity = { persisted: 0, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      expect(run!.no_progress_streak).toBe(1);   // 1 fechado × 2 atribuíveis
      expect(JSON.stringify(run!.rounds)).toContain("REGRESSÃO/reformulação, não descoberta");
    });

    /**
     * 🔴 GAP-154 — a atribuição do GAP-126 era de UM LADO SÓ: o débito descontado, o crédito inteiro.
     * MEDIDO em prod (7 entradas de passe do NVX): 48 fechados × 47 abertos, 44 destes em arquivo de sha
     * IDÊNTICO. Como o refutador é não-determinístico (~60% de churn entre validações da mesma spec — a
     * razão do `SPEC_VALIDATOR_VOTES=3`), "fechou num arquivo intocado" é o juiz parando de relatar, não
     * conserto. E é este saldo que zera o `no_progress_streak`, o freio que decide se o laço segue gastando.
     */
    describe("🔴 GAP-154 — o crédito também é auditado", () => {
      it("todos os fechados em arquivo intocado ⇒ saldo NÃO é progresso (o freio volta a morder)", async () => {
        const r = await reachValidating(5);
        delta = { closed: [{}, {}, {}], opened: [{}], openedOnNewSurface: 0, openedOnUnchangedText: 0,
                  closedOnUnchangedText: 3 };
        continuity = { persisted: 0, reconciled: true };
        await advanceAutonomyRun(db, r.id);
        expect(run!.no_progress_streak).toBe(1);   // 0 atribuível × 1 atribuível — antes disto era 3 × 1
        const rounds = JSON.stringify(run!.rounds);
        expect(rounds).toContain("sha IDÊNTICO ao da validação anterior");
        expect(rounds).toContain("Fechamento atribuível a esta edição: 0");
        const last = (run!.rounds as Array<Record<string, unknown>>).at(-1)!;
        expect(last.gapsClosedUnchangedText).toBe(3);
        expect(last.gapsClosedAttributable).toBe(0);
      });

      it("fechamento em arquivo EDITADO segue valendo: o crédito legítimo não é confiscado", async () => {
        const r = await reachValidating(5);
        delta = { closed: [{}, {}, {}], opened: [{}], openedOnNewSurface: 0, openedOnUnchangedText: 0,
                  closedOnUnchangedText: 1 };
        continuity = { persisted: 0, reconciled: true };
        await advanceAutonomyRun(db, r.id);
        expect(run!.no_progress_streak).toBe(0);   // 2 atribuíveis × 1 atribuível
        expect(JSON.stringify(run!.rounds)).toContain("Fechamento atribuível a esta edição: 2");
      });

      it("balde AUSENTE não desconta nada (cobertura legada mantém o saldo histórico)", async () => {
        // Assimetria DECLARADA: sem sha para comparar, supor variância mataria por streak toda run de
        // cobertura antiga — punição por ausência de instrumento, não por falta de progresso.
        const r = await reachValidating(5);
        delta = { closed: [{}, {}], opened: [{}], openedOnNewSurface: 0, openedOnUnchangedText: 0 };
        continuity = { persisted: 0, reconciled: true };
        await advanceAutonomyRun(db, r.id);
        expect(run!.no_progress_streak).toBe(0);
        expect(JSON.stringify(run!.rounds)).not.toContain("Fechamento atribuível");
      });

      it("`SPEC_GAP_CLOSED_ATTRIBUTION=off` restaura o número cheio — e DECLARA que o desconto está desligado", async () => {
        const antes = process.env.SPEC_GAP_CLOSED_ATTRIBUTION;
        process.env.SPEC_GAP_CLOSED_ATTRIBUTION = "off";
        try {
          const r = await reachValidating(5);
          delta = { closed: [{}, {}, {}], opened: [{}], openedOnNewSurface: 0, openedOnUnchangedText: 0,
                    closedOnUnchangedText: 3 };
          continuity = { persisted: 0, reconciled: true };
          await advanceAutonomyRun(db, r.id);
          expect(run!.no_progress_streak).toBe(0);   // saldo antigo: 3 fechados × 1 aberto
          const rounds = JSON.stringify(run!.rounds);
          // O balde continua MEDIDO e dito em voz alta: reverter o comportamento nunca apaga o fato.
          expect(rounds).toContain("saíram de arquivo com sha IDÊNTICO");
          expect(rounds).toContain("SPEC_GAP_CLOSED_ATTRIBUTION=off");
        } finally {
          if (antes === undefined) delete process.env.SPEC_GAP_CLOSED_ATTRIBUTION;
          else process.env.SPEC_GAP_CLOSED_ATTRIBUTION = antes;
        }
      });

      it("desconto NUNCA passa do crédito: saldo atribuível não fica negativo", async () => {
        const r = await reachValidating(5);
        delta = { closed: [{}], opened: [], openedOnNewSurface: 0, openedOnUnchangedText: 0,
                  closedOnUnchangedText: 5 };   // balde maior que o próprio conjunto (não deve acontecer)
        continuity = { persisted: 0, reconciled: true };
        await advanceAutonomyRun(db, r.id);
        const last = (run!.rounds as Array<Record<string, unknown>>).at(-1)!;
        expect(Number(last.gapsClosedAttributable)).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(run!.rounds)).not.toMatch(/Fechamento atribuível a esta edição: -/);
      });

      it("o desconto aparece no CHAT, não só no detalhe da rodada (é lá que o Jean lê o passe)", async () => {
        const r = await reachValidating(5);
        delta = { closed: [{}, {}, {}], opened: [{}], openedOnNewSurface: 0, openedOnUnchangedText: 0,
                  closedOnUnchangedText: 2 };
        continuity = { persisted: 0, reconciled: true };
        await advanceAutonomyRun(db, r.id);
        const chat = chatNotes.join("\n");
        expect(chat).toContain("2 saíram de arquivo de sha idêntico");
        expect(chat).toContain("**1** fechamento(s) atribuível(is)");
      });
    });
  });

  /**
   * 🔴 GAP-67 — o diff casava por fingerprint EXATO (`file|source|anchor`), então a renumeração de
   * seção feita pela edição DO PRÓPRIO CTO rebatizava o defeito não-corrigido: 1 fechado + 1 novo.
   * MEDIDO em prod (NVX LastMile, run `b1bc1195`, passe 1): `11 fechado / 12 novo` com 8+ pares
   * idênticos em âncora diferente (`§6.1`→`§6`, `§4.2 Passo 3`→`PRIV-JANELA-01`). Identidade de
   * defeito é julgamento de agente — Jaccard de título sobre os pares reais deu ZERO fantasma.
   */
  describe("GAP-67 — rebatismo por deriva de âncora não conta como fechado nem como novo", () => {
    it("par rebatizado sai das duas contagens e vira `gapsPersisted`", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}, {}, {}], opened: [{}, {}], openedOnNewSurface: 0 };
      continuity = { persisted: 2, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      const rounds = run!.rounds as Array<Record<string, unknown>>;
      expect(rounds.at(-1)).toMatchObject({ gapsClosed: 1, gapsOpened: 0, gapsPersisted: 2 });
      const note = JSON.stringify(run!.rounds);
      expect(note).toContain("1 fechado(s), 0 novo(s)");
      expect(note).toContain("MESMO defeito rebatizado");
    });

    it("🔴 saldo favorável SEM reconciliação NÃO zera o streak (deriva de âncora fabrica o gatilho)", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}, {}, {}], opened: [{}], openedOnNewSurface: 0 };
      continuity = { persisted: 0, reconciled: false, reason: "reconciliador indisponível" };
      await advanceAutonomyRun(db, r.id);
      expect(run!.gaps_current).toBe(2);
      expect(run!.no_progress_streak).toBe(1);      // sem reconciliar, 3×1 não prova nada
      expect(JSON.stringify(run!.rounds)).toContain("NÃO reconciliados");
    });

    it("sem reconciliação, `gapsPersisted` é null — não finge medida que não existe", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}], opened: [{}], openedOnNewSurface: 0 };
      continuity = { persisted: 0, reconciled: false, reason: "API_AGENTS_URL ausente" };
      await advanceAutonomyRun(db, r.id);
      const rounds = run!.rounds as Array<Record<string, unknown>>;
      expect(rounds.at(-1)!.gapsPersisted).toBeNull();
      expect(JSON.stringify(run!.rounds)).toContain("API_AGENTS_URL ausente");
    });

    it("rebatismo COMPLETO (tudo pareado) deixa a contagem em 0/0 e diz que nada fechou", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}, {}], opened: [{}, {}], openedOnNewSurface: 0 };
      continuity = { persisted: 2, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      const rounds = run!.rounds as Array<Record<string, unknown>>;
      expect(rounds.at(-1)).toMatchObject({ gapsClosed: 0, gapsOpened: 0, gapsPersisted: 2 });
      expect(run!.no_progress_streak).toBe(1);      // 0 × 0 não é saldo favorável
    });

    it("`openedOnNewSurface` não pode passar dos novos que sobraram após a reconciliação", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}, {}], opened: [{}, {}], openedOnNewSurface: 2 };
      continuity = { persisted: 2, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      // 0 novos sobraram ⇒ a nota NÃO pode alegar descoberta em arquivo inédito.
      expect(JSON.stringify(run!.rounds)).not.toContain("em arquivo julgado por INTEIRO pela 1ª vez");
    });

    it("reconciliado e sem rebatismo: declara que os números são identidade real", async () => {
      const r = await reachValidating(5);
      delta = { closed: [{}], opened: [{}, {}], openedOnNewSurface: 0 };
      continuity = { persisted: 0, reconciled: true };
      await advanceAutonomyRun(db, r.id);
      expect(JSON.stringify(run!.rounds)).toContain("identidade real");
    });
  });

  it("validação ainda rodando → nenhuma transição (o tick só espera)", async () => {
    const r = await reachValidating();
    validationStatus = "running";
    expect(await advanceAutonomyRun(db, r.id)).toBe(false);
    expect(run!.status).toBe("validating");
  });
});

// ── 5. T2 — integridade da revisão medida por SEÇÃO, não por tamanho ─────────
//
// A guarda de encolhimento (70% dos chars) NÃO pega o corte no teto de saída: perder 3 de 14
// seções ainda deixa ~80% dos caracteres. Foi assim que o LastMile perdeu 7 seções em prod.

const SECTIONED_SPEC = [
  "# PRODUCT SPEC", "",
  "## 1. Contexto", "ctx ".repeat(300), "",
  "## 2. Requisitos", "req ".repeat(300), "",
  "## 3. Modelo de dados", "```sql", "CREATE TABLE deliveries (id uuid);", "```", "dados ".repeat(300), "",
  "## 4. Observabilidade", "obs ".repeat(200), "",
].join("\n");

describe("assessRevisionIntegrity", () => {
  it("aceita revisão que preserva as seções", () => {
    const revised = SECTIONED_SPEC.replace("## 2. Requisitos", "## 2. Requisitos");
    expect(assessRevisionIntegrity(SECTIONED_SPEC, revised, false)).toEqual({ ok: true });
  });

  it("aceita revisão que ACRESCENTA seções (o CTO pode expandir a spec)", () => {
    const revised = `${SECTIONED_SPEC}\n## 5. Segurança\nNova seção.\n`;
    expect(assessRevisionIntegrity(SECTIONED_SPEC, revised, false).ok).toBe(true);
  });

  it("aceita RENOMEAÇÃO de seção (a guarda conta seções, não casa nome a nome)", () => {
    const revised = SECTIONED_SPEC.replace("## 4. Observabilidade", "## 4. Observabilidade e SLOs");
    expect(assessRevisionIntegrity(SECTIONED_SPEC, revised, false).ok).toBe(true);
  });

  it("🔴 recusa quando o provedor disse que CORTOU (sinal mais forte que qualquer heurística)", () => {
    const r = assessRevisionIntegrity(SECTIONED_SPEC, SECTIONED_SPEC, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("truncada");
  });

  it("🔴 recusa perda de seção mesmo com >80% dos caracteres (o caso do LastMile)", () => {
    const revised = SECTIONED_SPEC.slice(0, SECTIONED_SPEC.indexOf("## 4. Observabilidade"));
    expect(revised.length / SECTIONED_SPEC.length).toBeGreaterThan(0.7);   // a guarda antiga deixaria passar
    const r = assessRevisionIntegrity(SECTIONED_SPEC, revised, false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("seções desaparecidas");
      expect(r.detail.toLowerCase()).toContain("observabilidade");
    }
  });

  it("🔴 recusa bloco de código aberto (cortou no meio de uma cerca)", () => {
    const revised = `${SECTIONED_SPEC}\n## 5. Anexo\n\`\`\`sql\nCREATE INDEX ON deliveries(courier_id) WHERE`;
    const r = assessRevisionIntegrity(SECTIONED_SPEC, revised, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bloco de código aberto");
  });

  it("NÃO acusa cerca ímpar quando a BASE já era ímpar (defeito preexistente da spec)", () => {
    const base = `${SECTIONED_SPEC}\n\`\`\`sql\nsem fechar`;
    expect(assessRevisionIntegrity(base, `${base}\nmais texto`, false).ok).toBe(true);
  });

  /**
   * GAP-12 — o veto que impedia o laço de DESFAZER o próprio estrago (e a causa mecânica do GAP-8).
   *
   * Medido em prod (run `c3757985`, passe 1, rodada 1): 6 edições ancoradas removeram as quatro
   * seções-fantasma "contrato mínimo … (substitui X enquanto ausente)" que o GAP-10 havia escrito na
   * spec (34.531 → 28.232 chars) e esta função descartou a rodada paga por contagem de `##`.
   */
  describe("GAP-12 — remoção por EDIÇÃO ANCORADA é decisão, não perda", () => {
    const withoutObs = SECTIONED_SPEC.slice(0, SECTIONED_SPEC.indexOf("## 4. Observabilidade"));

    it("aceita seção a menos quando o conteúdo veio de blocos ancorados, e DECLARA o que saiu", () => {
      const r = assessRevisionIntegrity(SECTIONED_SPEC, withoutObs, false, { anchoredEdits: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.removedSections).toEqual(["4. observabilidade"]);
    });

    it("continua RECUSANDO a mesma perda quando veio arquivo inteiro (comportamento intocado)", () => {
      const r = assessRevisionIntegrity(SECTIONED_SPEC, withoutObs, false);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("seções desaparecidas");
    });

    it("`truncated` do provedor vence a permissão de remover (o corte é FATO, não decisão)", () => {
      const r = assessRevisionIntegrity(SECTIONED_SPEC, withoutObs, true, { anchoredEdits: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("truncada");
    });

    it("cerca de código aberta continua vetada mesmo em edições ancoradas", () => {
      const revised = `${SECTIONED_SPEC}\n\`\`\`sql\nCREATE INDEX ON deliveries(courier_id) WHERE`;
      const r = assessRevisionIntegrity(SECTIONED_SPEC, revised, false, { anchoredEdits: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("bloco de código aberto");
    });

    it("não confunde RENOMEAÇÃO com remoção (contagem igual ⇒ nada declarado)", () => {
      const revised = SECTIONED_SPEC.replace("## 4. Observabilidade", "## 4. Observabilidade e SLOs");
      const r = assessRevisionIntegrity(SECTIONED_SPEC, revised, false, { anchoredEdits: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.removedSections).toBeUndefined();
    });
  });
});

describe("T2 + G2 dentro do laço — o disco é a última coisa a mudar", () => {
  async function reachApplying(specOnDisk: string) {
    writeSpec(specOnDisk);
    const r = await start();
    await advanceAutonomyRun(db, r.id);                 // pending → cto_running
    return r;
  }

  it("🔴 revisão TRUNCADA (T1 no job) → stalled, disco INTACTO e sem gastar validação", async () => {
    const r = await reachApplying(SECTIONED_SPEC);
    job = { status: "done", specMarkdown: `${SECTIONED_SPEC}\n## 5. Anexo\nmelhoria`, truncated: true, error: null };
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("stalled");
    expect(readFileSync(specPath, "utf-8")).toBe(SECTIONED_SPEC);
    expect(startValidation).not.toHaveBeenCalled();
    expect(String(run!.last_error)).toContain("NÃO apliquei");
  });

  it("🔴 revisão que PERDEU seção (sem sinal do provedor) → stalled, disco INTACTO", async () => {
    const r = await reachApplying(SECTIONED_SPEC);
    job = { status: "done", specMarkdown: SECTIONED_SPEC.slice(0, SECTIONED_SPEC.indexOf("## 4. Observabilidade")), error: null };
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("stalled");
    expect(readFileSync(specPath, "utf-8")).toBe(SECTIONED_SPEC);
    expect(startValidation).not.toHaveBeenCalled();
  });

  it("GAP-12: a MESMA perda de seção é APLICADA quando o job veio de edições ancoradas, e declarada", async () => {
    const r = await reachApplying(SECTIONED_SPEC);
    const revised = SECTIONED_SPEC.slice(0, SECTIONED_SPEC.indexOf("## 4. Observabilidade"));
    job = { status: "done", specMarkdown: revised, error: null, editsApplied: 6 };
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("validating");
    expect(readFileSync(specPath, "utf-8")).toBe(revised);
    // "cortar é aceitável, mentir sobre o corte não": o título removido aparece no log da rodada.
    expect(JSON.stringify(run!.rounds)).toContain("REMOVIDA");
    expect(JSON.stringify(run!.rounds).toLowerCase()).toContain("observabilidade");
  });

  it("G2: o conteúdo ANTERIOR vai para project_spec_snapshots antes da escrita", async () => {
    const r = await reachApplying(SECTIONED_SPEC);
    const revised = `${SECTIONED_SPEC}\n## 5. Segurança\nSeção nova com o GAP resolvido.\n`;
    job = { status: "done", specMarkdown: revised, error: null };
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("validating");
    expect(readFileSync(specPath, "utf-8")).toBe(revised);
    const snap = sqlLog.find((c) => /INSERT INTO project_spec_snapshots/.test(c.sql));
    expect(snap).toBeDefined();
    expect(snap!.params[3]).toBe(SECTIONED_SPEC);       // o que foi SUBSTITUÍDO, não o que entrou
    expect(String(snap!.params[6])).toContain("autonomy:round-1");
  });

  it("🔴 G2: snapshot indisponível ABORTA a escrita (rede de segurança é pré-condição)", async () => {
    const r = await reachApplying(SECTIONED_SPEC);
    job = { status: "done", specMarkdown: `${SECTIONED_SPEC}\n## 5. Segurança\nnova seção.\n`, error: null };
    snapshotFails = true;
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("stalled");
    expect(readFileSync(specPath, "utf-8")).toBe(SECTIONED_SPEC);
    expect(String(run!.last_error).toLowerCase()).toContain("snapshot");
    expect(startValidation).not.toHaveBeenCalled();
  });
});

// ── 6. G4 — a flag nasce desligada ───────────────────────────────────────────

describe("autonomyEnabled (G4 — fail-closed)", () => {
  it("SEM a variável no ambiente → DESLIGADO (instalação nova não escreve spec sozinha)", async () => {
    delete process.env.SPEC_AUTONOMY;
    expect(autonomyEnabled()).toBe(false);
    const res = await startAutonomyRun(db, { projectId: PROJECT, tenantId: null, ownerUserId: OWNER });
    expect(res).toMatchObject({ ok: false, code: "AUTONOMY_DISABLED" });
  });

  it("liga só com valor explícito", () => {
    process.env.SPEC_AUTONOMY = "on";
    expect(autonomyEnabled()).toBe(true);
    process.env.SPEC_AUTONOMY = "off";
    expect(autonomyEnabled()).toBe(false);
  });
});

// ── 7. GAP-28 — o orçamento de crescimento é do PASSE, não de cada arquivo ────
//
// Medido na run `889af4f3`, passe 2: 8 de 11 rodadas descartadas INTEIRAS pelo veto de crescimento,
// cada uma uma chamada de Opus 5 já paga. O objetivo verdadeiro nunca foi "nenhum arquivo cresce" —
// é a SPEC não inflar. Quem encolheu financia quem precisa crescer; o saldo é propriedade do passe.

const R = (p: Partial<{ round: number; pass: number; applied: boolean; deltaChars: number | null }>) => ({
  round: p.round ?? 1, pass: p.pass ?? 0, startedAt: "2026-09-07T00:00:00.000Z",
  ...(p.applied === undefined ? {} : { applied: p.applied }),
  ...(p.deltaChars === undefined ? {} : { deltaChars: p.deltaChars }),
});

describe("passGrowthUsed (GAP-28)", () => {
  it("soma só as rodadas APLICADAS do passe corrente", () => {
    const used = passGrowthUsed({
      passes: 1,
      rounds: [
        R({ round: 1, pass: 0, applied: true, deltaChars: 9_999 }),   // passe anterior: já pago lá
        R({ round: 2, pass: 1, applied: true, deltaChars: 1_200 }),
        R({ round: 3, pass: 1, applied: false, deltaChars: 8_000 }),  // vetada: não saiu do disco
        R({ round: 4, pass: 1, applied: true, deltaChars: 300 }),
      ] as never,
    });
    expect(used).toBe(1_500);
  });

  it("o arquivo que ENCOLHEU devolve margem para o próximo (é isso que muda o rendimento)", () => {
    const used = passGrowthUsed({
      passes: 2,
      rounds: [
        R({ round: 1, pass: 2, applied: true, deltaChars: -6_300 }),
        R({ round: 2, pass: 2, applied: true, deltaChars: 1_800 }),
      ] as never,
    });
    expect(used).toBe(-4_500); // saldo NEGATIVO ⇒ `passGrowthBudget` devolve orçamento cheio
  });

  it("rodada antiga SEM `deltaChars` conta como 0 — não inventa gasto retroativo", () => {
    const used = passGrowthUsed({
      passes: 0,
      rounds: [R({ round: 1, pass: 0, applied: true }), R({ round: 2, pass: 0, applied: true, deltaChars: 700 })] as never,
    });
    expect(used).toBe(700);
  });

  it("passe sem nenhuma rodada aplicada não consumiu nada", () => {
    expect(passGrowthUsed({ passes: 3, rounds: [R({ pass: 3, applied: false, deltaChars: 5_000 })] as never })).toBe(0);
    expect(passGrowthUsed({ passes: 0, rounds: [] as never })).toBe(0);
  });
});

// ── 9. GAP-33 — o orçamento é do LAÇO; quem chega depois na fila não paga a conta ─
//
// Medido no passe 4 da run `d7acccb8`: 3 de 6 rodadas descartadas com +2.873, +448 e +143 chars,
// porque os primeiros da fila gastaram os 2.000 do passe. Descartar Opus 5 para poupar 143
// caracteres numa spec de ~950 mil não protege nada.

describe("runGrowthUsed + growthAllowance (GAP-33)", () => {
  it("soma as rodadas aplicadas de TODOS os passes", () => {
    const rounds = [
      R({ round: 1, pass: 0, applied: true, deltaChars: 1_420 }),
      R({ round: 2, pass: 1, applied: true, deltaChars: 188 }),
      R({ round: 3, pass: 2, applied: false, deltaChars: 9_999 }), // vetada: não saiu do disco
      R({ round: 4, pass: 3, applied: true, deltaChars: 1_671 }),
    ] as never;
    expect(runGrowthUsed({ rounds })).toBe(3_279);
  });

  it("o passe 4 da run medida deixa de estrangular quem chega depois", () => {
    // Fatos da run `d7acccb8`: gasto acumulado 4.627 chars ao chegar na rodada 26.
    const rounds = [
      R({ round: 1, pass: 0, applied: true, deltaChars: 1_420 }),
      R({ round: 2, pass: 1, applied: true, deltaChars: 188 }),
      R({ round: 3, pass: 2, applied: true, deltaChars: 1_348 }),
      R({ round: 4, pass: 3, applied: true, deltaChars: 1_671 }),
    ] as never;
    // Antes (por passe): 2.000 − 1.671 = 329 ⇒ os +448 da rodada 26 morriam.
    expect(passGrowthUsed({ passes: 3, rounds })).toBe(1_671);
    // Agora (no laço): 2.000 × 4 − 4.627 = 3.373 ⇒ +448 e +143 passam.
    expect(growthAllowance({ passes: 3, rounds }, 2_000)).toBe(3_373);
  });

  it("estourar num passe APERTA o seguinte — nada é de graça", () => {
    const rounds = [R({ round: 1, pass: 0, applied: true, deltaChars: 5_000 })] as never;
    // Passe 1 gastou 5.000 de 2.000. No passe 2 o teto acumulado é 4.000 ⇒ margem ZERO, não negativa.
    expect(growthAllowance({ passes: 1, rounds }, 2_000)).toBe(0);
    // Só no passe 4 o laço volta a ter margem (2.000 × 4 = 8.000 − 5.000).
    expect(growthAllowance({ passes: 3, rounds }, 2_000)).toBe(3_000);
  });

  it("encolher gera crédito que ATRAVESSA passes (o GAP-28 na escala certa)", () => {
    const rounds = [R({ round: 1, pass: 0, applied: true, deltaChars: -4_332 })] as never;
    expect(growthAllowance({ passes: 1, rounds }, 2_000)).toBe(8_332); // 4.000 + 4.332 devolvidos
  });

  it("laço sem rodada nenhuma tem exatamente o orçamento do primeiro passe", () => {
    expect(growthAllowance({ passes: 0, rounds: [] as never }, 2_000)).toBe(2_000);
    expect(runGrowthUsed({ rounds: [] as never })).toBe(0);
  });
});

// ── 7b. GAP-36 — o orçamento é uma FRAÇÃO da massa da spec, não um absoluto ────
//
// Medido na run `6d407460` (NVX LastMile, ~950 mil chars): as DUAS primeiras rodadas do laço foram
// descartadas com a margem CHEIA — `privacidade-lgpd.md` +4.492 e `modelo-dados.md` +5.404 contra
// 2.000 —, com 16 e 6 edições ancoradas já aplicadas. Recusa não gasta margem, então a parede de
// 2.000 seria a mesma em toda rodada do passe: o passe inteiro caminhava para `stalled`.

describe("growthAllowance + proportionalGrowthBudget (GAP-36)", () => {
  const NVX_BYTES = 950_000;

  it("a parcela proporcional é RATIO × massa (2% do NVX ≈ 19.000)", () => {
    expect(proportionalGrowthBudget(NVX_BYTES)).toBe(19_000);
  });

  it("massa ausente, zero ou inválida ⇒ só o piso (regra do GAP-33 intacta)", () => {
    expect(proportionalGrowthBudget(0)).toBe(0);
    expect(proportionalGrowthBudget(-1)).toBe(0);
    expect(proportionalGrowthBudget(Number.NaN)).toBe(0);
    expect(growthAllowance({ passes: 0, rounds: [] as never }, 2_000, 0)).toBe(2_000);
    expect(growthAllowance({ passes: 3, rounds: [] as never }, 2_000)).toBe(8_000);
  });

  it("as duas rodadas MEDIDAS da run 6d407460 passam a caber", () => {
    // Passe 0, nada aplicado: antes a margem era 2.000 e as duas morriam.
    const allowance = growthAllowance(
      { passes: 0, rounds: [] as never }, 2_000, proportionalGrowthBudget(NVX_BYTES),
    );
    expect(allowance).toBe(19_000);
    expect(4_492).toBeLessThanOrEqual(allowance);
    expect(5_404).toBeLessThanOrEqual(allowance);
    // …e o gasto das duas juntas ainda deixa margem para o resto do passe.
    const after = growthAllowance(
      {
        passes: 0,
        rounds: [
          R({ round: 1, pass: 0, applied: true, deltaChars: 4_492 }),
          R({ round: 2, pass: 0, applied: true, deltaChars: 5_404 }),
        ] as never,
      },
      2_000, proportionalGrowthBudget(NVX_BYTES),
    );
    expect(after).toBe(9_104);
  });

  it("a doença do GAP-8 continua RECUSADA de saída (+22.651 numa rodada)", () => {
    const allowance = growthAllowance(
      { passes: 0, rounds: [] as never }, 2_000, proportionalGrowthBudget(NVX_BYTES),
    );
    expect(22_651).toBeGreaterThan(allowance);
    // Mesmo no último passe do laço a conta cumulativa não alcança a inflação de UMA rodada do GAP-8.
    expect(22_651).toBeGreaterThan(
      growthAllowance({ passes: 4, rounds: [] as never }, 2_000, proportionalGrowthBudget(NVX_BYTES)),
    );
  });

  it("é MONÓTONO: spec pequena não fica mais restrita do que já era", () => {
    // Landpage de 5.000 bytes: 2% = 100 ⇒ o piso do GAP-33 vence e o comportamento é o de hoje.
    expect(proportionalGrowthBudget(5_000)).toBe(100);
    expect(growthAllowance({ passes: 0, rounds: [] as never }, 2_000, proportionalGrowthBudget(5_000)))
      .toBe(2_000);
    expect(growthAllowance({ passes: 4, rounds: [] as never }, 2_000, proportionalGrowthBudget(5_000)))
      .toBe(10_000);
  });

  it("o crédito por encolhimento (GAP-33) segue valendo sobre o teto proporcional", () => {
    const rounds = [R({ round: 1, pass: 0, applied: true, deltaChars: -4_332 })] as never;
    expect(growthAllowance({ passes: 0, rounds }, 2_000, proportionalGrowthBudget(NVX_BYTES)))
      .toBe(23_332);
  });
});

// ── 8. GAP-29 — a tentativa descartada volta ao agente como FATO ──────────────
//
// Medido na run `d7acccb8`: `autenticacao-sessao.md` foi descartado 3× entregando +2.661, +2.740 e
// +2.740 chars contra margens de 580 e 1.143. O pedido era IDÊNTICO nas três — o laço pagava Opus 5
// para repetir uma resposta que ele já sabia que ia recusar.

const REJ = (p: {
  round: number; pass?: number; filePath: string;
  rejectedDelta?: number; rejectedBudget?: number; rejectedReason?: string; applied?: boolean;
}) => ({
  round: p.round, pass: p.pass ?? 0, startedAt: "2026-09-07T00:00:00.000Z", filePath: p.filePath,
  ...(p.applied === undefined ? {} : { applied: p.applied }),
  ...(p.rejectedDelta === undefined ? {} : { rejectedDelta: p.rejectedDelta }),
  ...(p.rejectedBudget === undefined ? {} : { rejectedBudget: p.rejectedBudget }),
  ...(p.rejectedReason === undefined ? {} : { rejectedReason: p.rejectedReason }),
});

describe("lastRejectedAttempt (GAP-29/GAP-31)", () => {
  it("devolve a recusa MAIS RECENTE do arquivo, atravessando passes", () => {
    const got = lastRejectedAttempt({
      rounds: [
        REJ({ round: 8, pass: 0, filePath: "autenticacao-sessao.md", rejectedDelta: 2_661, rejectedBudget: 580 }),
        REJ({ round: 11, pass: 1, filePath: "modelo-dados.md", applied: true }),
        REJ({
          round: 14, pass: 1, filePath: "autenticacao-sessao.md",
          rejectedDelta: 2_740, rejectedBudget: 1_143, rejectedReason: "consolidação recusada: cresceu 2740",
        }),
      ] as never,
    }, "autenticacao-sessao.md");
    expect(got).toEqual({ delta: 2_740, budget: 1_143, pass: 2, reason: "consolidação recusada: cresceu 2740" });
  });

  it("não confunde arquivos — a recusa de um não instrui o outro", () => {
    const rounds = [REJ({ round: 8, filePath: "autenticacao-sessao.md", rejectedDelta: 2_661, rejectedBudget: 580 })] as never;
    expect(lastRejectedAttempt({ rounds }, "modelo-dados.md")).toBeNull();
    expect(lastRejectedAttempt({ rounds }, "AUTENTICACAO-SESSAO.MD")).not.toBeNull(); // caminho é comparado sem caixa
  });

  it("rodada que falhou por OUTRO motivo (sem `rejectedDelta`) não vira instrução de tamanho", () => {
    const rounds = [REJ({ round: 3, filePath: "visao-escopo.md", applied: false })] as never;
    expect(lastRejectedAttempt({ rounds }, "visao-escopo.md")).toBeNull();
  });

  it("primeira tentativa não recebe fato nenhum", () => {
    expect(lastRejectedAttempt({ rounds: [] as never }, "modelo-dados.md")).toBeNull();
  });

  // GAP-31: rodada gravada ANTES do motivo existir não pode virar uma causa inventada.
  it("recusa antiga sem motivo gravado devolve `reason: null`", () => {
    const rounds = [REJ({ round: 8, filePath: "README.md", rejectedDelta: 4_675, rejectedBudget: 2_000 })] as never;
    expect(lastRejectedAttempt({ rounds }, "README.md")).toEqual({ delta: 4_675, budget: 2_000, pass: 1, reason: null });
  });
});
