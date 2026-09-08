/**
 * specAutonomy.perFile.test.ts — PR-5 (F2): laço autônomo POR ARQUIVO (migração 095, 2026-09-05).
 *
 * Por que este arquivo existe: depois do split (PR-3) a spec do NVX LastMile deixou de ser um
 * `.md` de 98.045 chars e virou uma ÁRVORE. O laço da 090 mandaria o ÍNDICE ao CTO normalizador e
 * receberia uma spec inteira de volta — a MESMA causa do truncamento de 64k tokens de saída. O
 * modo por arquivo trata UM arquivo por rodada, com os GAPs DAQUELE arquivo (PR-4/specGapScope).
 *
 * O que estes testes travam (cada um é um modo de falha que custa dado ou dinheiro):
 *   • a fila é por RISCO (blockers primeiro) e só 🔴/🟡 vão ao CTO — `info` não sustenta rodada;
 *   • uma rodada escreve UM arquivo: os outros arquivos da árvore ficam byte a byte intactos;
 *   • a validação adversarial (limite de 4/h) roda UMA vez por PASSE, não por arquivo;
 *   • `maxRounds` é medido em PASSES no modo por arquivo (senão "rodada 7/5" mentiria);
 *   • falha de ARQUIVO (truncado, grande demais, CTO BLOCKED) tira o arquivo da fila e o laço
 *     segue; duas seguidas param o laço; falha de PROJETO (edição humana) para na hora;
 *   • GAP importante sem arquivo definido NÃO é adivinhado — o laço para e diz isso;
 *   • árvore com 1 arquivo continua no ciclo da 090 (zero regressão).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// ── a árvore de spec em disco (temporária, real: o laço escreve de verdade) ────
interface TreeFile { path: string; filePath: string; isPrimary: boolean }
let tree: TreeFile[] = [];
let root = "";

function makeTree(files: Array<{ path: string; content: string; isPrimary?: boolean }>): void {
  root = mkdtempSync(join(tmpdir(), "spec-perfile-"));
  tree = files.map((f) => {
    const filePath = join(root, f.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, f.content, "utf-8");
    return { path: f.path, filePath, isPrimary: f.isPrimary === true };
  });
}
function onDisk(path: string): string {
  return readFileSync(tree.find((f) => f.path === path)!.filePath, "utf-8");
}

/** Seções de verdade: `assessRevisionIntegrity` conta seções, então o corpo importa. */
function body(title: string, sections: number): string {
  const out = [`# ${title}`, ""];
  for (let i = 1; i <= sections; i++) out.push(`## ${i}. Seção ${i}`, `${title} conteúdo ${i}. `.repeat(60), "");
  return out.join("\n");
}

// ── dublês dos colaboradores ──────────────────────────────────────────────────
type F = { file: string; severity: string; title: string; fingerprint: string; anchor?: string; source?: string };
let findings: F[] = [];
let latestRunId: string | null = "run-0";
/**
 * ⚠️ `importOriginal` de propósito — ver a nota gêmea em `specAutonomy.test.ts`: mock de módulo é
 * FÁBRICA e substitui o módulo inteiro, então export novo no `specAutonomy.ts` derrubava a suíte com
 * TypeError sincrônico (queimado no GAP-76). `findingTriage` é puro, herdar o original é seguro.
 */
vi.mock("./findingTriage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./findingTriage.js")>()),
  projectFindingsState: vi.fn(async () => ({ latestRunId, findings, resolved: [], counts: {} })),
  // GAP-41: aqui o diff não é o objeto de teste (tem suíte própria) — vazio = comportamento legado.
  gapDeltaSinceLastRun: vi.fn(async () => ({ closed: [], opened: [], openedOnNewSurface: 0 })),
  // GAP-76: idem para o nível comparável — `null` = não foi possível medir (comportamento legado).
  comparableTallySinceLastRun: vi.fn(async () => null),
}));

// GAP-77: neste arquivo o veredicto fica DESLIGADO por padrão (`minGapsResolved: 0`) — o objeto de
// teste é a fila do modo por arquivo, e o parecer do juiz tem suíte própria
// (`gapPromotionVerdict.test.ts`) mais os testes de fim de laço em `specAutonomy.test.ts`.
// 🔴 GAP-115: os fins de laço DESTE modo (tetos de `startFileRound`) não chamavam o juiz, então o
// dublê passou a ser LIGÁVEL (`veredicto = {...}`) só para provar essa chamada.
let veredicto: { candidates: number; released: number; impeditive: number; promotable: boolean } | null = null;
vi.mock("./gapPromotionVerdict.js", () => ({
  verdictConfig: vi.fn(() => ({ minGapsResolved: veredicto ? 3 : 0, minRecurrence: 3, minFocusRounds: 2, minAttackRounds: 3, maxPerRun: 3, maxPerSpec: 8 })),
  // 🔴 GAP-81: `startFileRound` lê as rodadas já pagas neste arquivo para decidir o degrau de foco.
  // Vazio por padrão = nenhuma escalada (o resto da suíte mede o comportamento normal); os casos de
  // foco enchem `rodadasPagas`. A lógica do planejador tem suíte própria (`gapFocus.test.ts`).
  focusRoundsByFile: vi.fn(async () => rodadasPagas),
  focusRoundsByAnchor: vi.fn(async () => new Map<string, number>()),
  attackedRoundsByAnchor: vi.fn(async () => new Map<string, number>()),
  anchoredSection: vi.fn(() => "## 1. Seção 1\ntexto\n"),
  proveWork: vi.fn(() => ({ proven: true, kind: "exhausted", detail: "laço ESGOTADO (exhausted) com 0 GAP(s) fechado(s)" })),
  specFileShas: vi.fn(async () => new Map<string, string>()),
  // 🔴 GAP-124: o laço passou a ler o snapshot (sha + conteúdo) para medir obsolescência pela
  // SEÇÃO ancorada. `vi.mock` troca o módulo inteiro, então export novo tem de aparecer aqui.
  specFileSnapshots: vi.fn(async () => new Map<string, { sha: string; content: string }>()),
  selectVerdictCandidates: vi.fn(() => ({
    candidates: Array.from({ length: veredicto?.candidates ?? 0 }, (_, i) => ({
      finding: { severity: "blocker", title: `t${i}` }, fingerprint: `fp${i}`, file: "backend/01-api.md",
      anchor: `## ${i}`, times: 4, focusRounds: 0, attackedRounds: 3, section: "trecho",
    })),
    rejected: [], enabled: true, reason: `${veredicto?.candidates ?? 0} GAP(s) elegível(is) a veredicto`,
  })),
  runVerdictRound: vi.fn(async () => ({
    verdicts: [], ran: true, reason: `${veredicto?.released ?? 0} declarado(s) não-impeditivo(s)`,
    released: veredicto?.released ?? 0, model: "dublê",
  })),
  saveVerdicts: vi.fn(async () => 0),
  livePromotionVerdicts: vi.fn(async () => []),
  promotabilityReport: vi.fn(() => ({
    impeditive: veredicto?.impeditive ?? 0, released: veredicto?.released ?? 0,
    promotable: veredicto?.promotable ?? false,
    blockers: veredicto?.promotable ? [] : [`${veredicto?.impeditive ?? 0} GAP(s) importante(s) seguem impeditivos`],
  })),
}));
let rodadasPagas = new Map<string, number>();

// `specGapScope` real alcança `routes/specs.js` → `db/client.js` (pool de verdade). Aqui ele é
// dublado: o que este arquivo testa é a FILA do laço, não o roteador (que tem suíte própria).
let unroutedFindings: F[] = [];
vi.mock("./specGapScope.js", () => ({
  loadSpecFiles: vi.fn(async () => tree),
  // 🔴 GAP-115: o veredicto de fim de laço lê os GAPs SEM arquivo por aqui. Vazio = todos roteados,
  // que é a premissa desta suíte (a fila só existe porque cada GAP tem arquivo).
  gapScopeForProject: vi.fn(async () => ({ unrouted: [] as F[] })),
  buckets: vi.fn((groups: { files: TreeFile[]; byPath: Map<string, F[]> }) => groups.files.map((f) => {
    const list = groups.byPath.get(f.path) ?? [];
    return {
      path: f.path, isPrimary: f.isPrimary, active: list.length,
      blockers: list.filter((x) => x.severity === "blocker").length,
      warnings: list.filter((x) => x.severity === "warning").length,
      routed: 0,
    };
  })),
  ensureGapScope: vi.fn(async () => {
    const byPath = new Map<string, F[]>();
    for (const f of findings) {
      if (!tree.some((t) => t.path === f.file)) continue;
      const list = byPath.get(f.file);
      if (list) list.push(f); else byPath.set(f.file, [f]);
    }
    return {
      scope: {
        latestRunId, files: tree, byPath, unrouted: unroutedFindings,
        totalActive: findings.length + unroutedFindings.length, routesUsed: {},
      },
      routing: null,
    };
  }),
}));

// GAP-22: o registro de oráculos também alcança `routes/specs.js` → pool real, então é dublado. O
// papel do arquivo (`oracleRoleForFile`) é lógica PURA e vem reimplementada aqui de propósito: quem a
// testa de verdade é `specOracles.test.ts`; aqui o que se prova é o VETO do laço.
interface FakeDecision { contractKey: string; oraclePath: string; ruleSummary: string; restatedIn: string[] }
let oracleDecisions: FakeDecision[] = [];
let oracleRegistryOn = true;
/** 🔴 GAP-70 — pool da graça de consolidação. `0` = kill-switch (default destes casos). */
let gracaDeConsolidacao = 0;
const ensureOracleDecisions = vi.fn(async () => ({
  decisions: oracleDecisions, decided: 0, skipped: true, reason: "dublê", model: null,
}));
vi.mock("./specOracles.js", () => ({
  // GAP-25: o orçamento é FONTE ÚNICA em specOracles (o veto julga e o prompt anuncia o MESMO número).
  ORACLE_GROWTH_BUDGET: 2000,
  // GAP-36: parcela proporcional à massa da spec. Nos dublês os arquivos têm poucos KB, então 2% é
  // irrisório e o piso de 2.000 continua vencendo — é o que mantém estes casos medindo o VETO em vez da
  // calibração do orçamento (essa é medida em `specAutonomy.test.ts`).
  proportionalGrowthBudget: (bytes: number) => (bytes > 0 ? Math.ceil(bytes * 0.02) : 0),
  // 🔴 GAP-69: janela da dívida das runs IRMÃS. `0` no dublê = kill-switch ligado, então estes casos
  // seguem medindo o VETO com o orçamento de uma run só — a dívida da janela é medida em
  // `growthWindow.test.ts`. Sem esta chave o mock quebra com "No export is defined", que é como o
  // GAP-69 apareceu aqui na primeira rodada de testes.
  ORACLE_GROWTH_WINDOW_HOURS: 0,
  // 🔴 GAP-70: graça de consolidação. Nasce DESLIGADA no dublê (getter, para cada caso poder ligá-la)
  // — assim TODOS os casos do GAP-64 acima continuam medindo o penhasco original, o que é a prova de
  // monotonicidade da correção: a graça só ALARGA o limite, nunca aperta.
  get ORACLE_CONSOLIDATION_GRACE() { return gracaDeConsolidacao; },
  // GAP-64: tolerância de quase-conformidade — fração da margem que RESTA, por isso se extingue com
  // ela. Reimplementada aqui (é lógica pura, testada em `specOracles.test.ts`); com o piso de 2.000 do
  // dublê, a banda destes casos é de 100 chars.
  growthOverflowTolerance: (allowance: number) => (allowance > 0 ? Math.floor(allowance * 0.05) : 0),
  oracleRegistryEnabled: () => oracleRegistryOn,
  loadOracleDecisions: vi.fn(async () => oracleDecisions),
  ensureOracleDecisions: (...a: unknown[]) => ensureOracleDecisions(...(a as [])),
  oracleRoleForFile: (ds: FakeDecision[], target: string) => {
    const same = (p: string) => p.toLowerCase() === target.toLowerCase();
    return {
      owns: ds.filter((d) => same(d.oraclePath)),
      restates: ds.filter((d) => !same(d.oraclePath) && d.restatedIn.some(same)),
    };
  },
}));

const startValidation = vi.fn(async () => ({ ok: true as const, runId: "vr-1", reused: false }));
// GAP-19: a pendência de cobertura é ACUMULADA (`stage_b_full_sha` × sha atual) e vem daqui —
// `coberturaAcumulada = null` reproduz "não foi possível medir" (comportamento legado).
let coberturaAcumulada: { unjudged: string[]; judged: number; total: number } | null = null;
vi.mock("./specValidation.js", () => ({
  startValidation: (...a: unknown[]) => startValidation(...(a as [])),
  unjudgedSpecFiles: async () => coberturaAcumulada,
  // 🔴 C4: o freio de "zero sem cobertura" nos ticks `pending`/`whole` mede pela regra do GAP-21
  // (`trackedCoverageState`), que devolve `null` quando o projeto não rastreia cobertura — e `null` é
  // exatamente o default destes testes, ou seja, comportamento legado.
  trackedCoverageState: async () => coberturaAcumulada,
  // Feature dos DESENHOS: a rodada dos diagramas manda a spec INTEIRA ao arquiteto, e é daqui que ela
  // sai (o mesmo assembler da validação). `especLegivel = false` reproduz "spec ilegível no disco",
  // que é a guarda que faz a run encerrar sem desenhar em vez de falhar.
  computeCurrentSpecHash: vi.fn(async () => (especLegivel
    ? {
      specHash: "hash-da-arvore",
      files: tree.map((f) => ({
        filename: f.path.includes("/") ? f.path.slice(f.path.lastIndexOf("/") + 1) : f.path,
        rel_dir: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "",
        file_path: f.filePath, content: readFileSync(f.filePath, "utf-8"), contentSha256: "sha",
      })),
    }
    : null)),
}));
let especLegivel = true;

let job: { status: string; specMarkdown: string | null; error: string | null; truncated?: boolean } | null = null;
/**
 * 🔴 GAP-119: prova de ausência da LINHA do job, separada da leitura do job. `true` = o SELECT rodou
 * e não há linha; `false` = a linha está lá (a leitura anterior é que não a viu); `null` = a leitura
 * falhou, ausência INDECIDÍVEL.
 */
let jobRowMissing: boolean | null = true;
vi.mock("./specChatJobs.js", () => ({
  getSpecChatJob: vi.fn(async () => job),
  specChatJobMissing: vi.fn(async () => jobRowMissing),
}));

const dispatchResolveGapsJob = vi.fn(async () => ({ ok: true as const, gaps: 3 }));
const dispatchGapFileJob = vi.fn(async () => ({ ok: true as const, gaps: 2 }) as unknown);
const dispatchManifestJob = vi.fn(async () => ({ ok: true as const }));
const dispatchDiagramsJob = vi.fn(async () => ({ ok: true as const }));
vi.mock("../routes/specChat.js", () => ({
  dispatchResolveGapsJob: (...a: unknown[]) => dispatchResolveGapsJob(...(a as [])),
  dispatchGapFileJob: (...a: unknown[]) => dispatchGapFileJob(...(a as [])),
  dispatchManifestJob: (...a: unknown[]) => dispatchManifestJob(...(a as [])),
  dispatchDiagramsJob: (...a: unknown[]) => dispatchDiagramsJob(...(a as [])),
}));

vi.mock("./tenantLlmConfig.js", () => ({
  resolveWorkbenchLlm: vi.fn(async () => ({})),
  agentsLlmFields: vi.fn(() => ({})),
}));
vi.mock("./projectStatus.js", () => ({ SPEC_EDITABLE_STATUSES: new Set(["draft", "spec_submitted"]) }));

import {
  startAutonomyRun, advanceAutonomyRun, isTerminalAutonomyStatus,
  AUTONOMY_MAX_FILE_ROUNDS, AUTONOMY_MAX_TOTAL_FILE_ROUNDS, type AutonomyStatus,
} from "./specAutonomy.js";

// ── banco falso (uma linha de spec_autonomy_runs em memória) ───────────────────
interface FakeRow { [k: string]: unknown }
let run: FakeRow | null = null;
let projectStatus = "draft";
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
    if (s.startsWith("SELECT count(*)::int AS n FROM project_spec_files")) {
      return { rows: [{ n: tree.length }], rowCount: 1 };
    }
    if (s.startsWith("SELECT file_path FROM project_spec_files")) {
      const primary = tree.find((f) => f.isPrimary) ?? tree[0];
      return { rows: primary ? [{ file_path: primary.filePath }] : [], rowCount: primary ? 1 : 0 };
    }
    if (s.startsWith("SELECT status FROM projects")) return { rows: [{ status: projectStatus }], rowCount: 1 };
    // Título e arquétipo do projeto: quem lê são os despachos de CRIAÇÃO (manifesto e diagramas).
    if (s.startsWith("SELECT title, extra FROM projects")) return { rows: [{ title: TITULO, extra: null }], rowCount: 1 };
    if (s.startsWith("UPDATE project_spec_files") || s.startsWith("UPDATE projects")) return { rows: [], rowCount: 1 };
    if (s.startsWith("INSERT INTO spec_chat_messages")) return { rows: [], rowCount: 1 };
    if (s.startsWith("SELECT status, stage_b_ran, stage_b_coverage FROM spec_validation_runs")) {
      // GAP-13 (migração 099): `true` = validação COMPLETA — é o caso destes testes.
      // GAP-18 (migração 101): cobertura NULL = run legada → gate de cobertura não interfere.
      return { rows: [{ status: validationStatus, stage_b_ran: true, stage_b_coverage: null }], rowCount: 1 };
    }
    if (s.startsWith("SELECT stage_b_coverage FROM spec_validation_runs")) {
      // `null` (default) = nenhuma cobertura registrada. Os casos do C4 põem aqui o `oversized`, que é
      // o único campo que o freio de cobertura consulta nesta linha.
      return coberturaDaUltimaRun
        ? { rows: [{ stage_b_coverage: coberturaDaUltimaRun }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // 🔴 GAP-71/81: o histórico que dá a reincidência de âncora ESTÁVEL. Vazio por padrão (nenhum GAP é
    // teimoso); os casos de foco preenchem `validacoesPassadas`.
    if (s.startsWith("SELECT findings, stage_b_coverage FROM spec_validation_runs")) {
      return { rows: validacoesPassadas, rowCount: validacoesPassadas.length };
    }
    // GAP-22: o conteúdo em que os GAPs foram medidos — chave de idempotência da decisão de oráculos.
    if (s.startsWith("SELECT spec_hash FROM spec_validation_runs")) return { rows: [{ spec_hash: "hash-do-conteudo" }], rowCount: 1 };

    if (s.startsWith("INSERT INTO spec_autonomy_runs")) {
      run = {
        id: values[0], project_id: values[1], tenant_id: values[2], owner_user_id: values[3],
        status: "pending", round: 0, max_rounds: values[4], chat_job_id: null, validation_run_id: null,
        base_spec_sha: null, gaps_initial: values[5], gaps_current: values[5], no_progress_streak: 0,
        rounds: [], last_error: null, deadline_at: new Date(Date.now() + 3.6e6).toISOString(),
        created_at: nowIso(), updated_at: nowIso(), finished_at: null,
        // migração 095
        mode: values[7], passes: 0, current_file: null, files_done: [], file_failures: 0,
        // migração 103 (GAP-36): massa da spec medida na criação — denominador FIXO do orçamento.
        spec_bytes: values[8],
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
      const expected = s.match(/AND status = '([a-z_]+)'/)?.[1];
      if (expected && run.status !== expected) return { rows: [], rowCount: 0 };
      if (s.includes("status = ANY($5::text[])")) {
        const allowed = values[4] as string[];
        if (!allowed.includes(run.status as string)) return { rows: [], rowCount: 0 };
      }
      const mRound = s.match(/AND round = \$(\d+)/);
      if (mRound && run.round !== values[Number(mRound[1]) - 1]) return { rows: [], rowCount: 0 };

      const setStatus = s.match(/SET status = '([a-z_]+)'/)?.[1] ?? s.match(/SET status = \$(\d+)/)?.[1];
      if (setStatus && /^[a-z_]+$/.test(setStatus)) run.status = setStatus;
      else if (setStatus) run.status = values[Number(setStatus) - 1] as string;

      const assign = (col: string) => {
        const m = s.match(new RegExp(`${col} = \\$(\\d+)`));
        if (m) run![col] = values[Number(m[1]) - 1];
      };
      for (const c of ["round", "chat_job_id", "base_spec_sha", "gaps_current", "no_progress_streak",
        "validation_run_id", "last_error", "max_rounds", "current_file", "file_failures"]) assign(c);
      if (/validation_run_id = NULL/.test(s)) run.validation_run_id = null;
      if (/chat_job_id = NULL/.test(s)) run.chat_job_id = null;
      if (/current_file = NULL/.test(s)) run.current_file = null;
      if (/file_failures = 0/.test(s)) run.file_failures = 0;
      if (/mode = '([a-z_]+)'/.test(s)) run.mode = s.match(/mode = '([a-z_]+)'/)![1];
      if (/passes = passes \+ 1/.test(s)) run.passes = Number(run.passes ?? 0) + 1;
      // C4: no modo `whole` o freio de cobertura gasta uma RODADA (o contador do modo de 1 arquivo).
      if (/round = round \+ 1/.test(s)) run.round = Number(run.round ?? 0) + 1;
      if (/files_done = '\[\]'::jsonb/.test(s)) run.files_done = [];
      const mDone = s.match(/files_done = files_done \|\| \$(\d+)::jsonb/);
      if (mDone) {
        run.files_done = [...(run.files_done as unknown[]), ...JSON.parse(values[Number(mDone[1]) - 1] as string)];
      }
      // `mergeIntoLastRound` (GAP-71b): funde o patch NA ÚLTIMA rodada, no banco, sem reescrever o
      // array — é assim que a marca da rodada dedicada (GAP-81) e as refs de reincidência chegam ao log.
      if (/rounds = jsonb_set\(/.test(s)) {
        const arr = [...(run.rounds as Record<string, unknown>[])];
        if (arr.length === 0) return { rows: [], rowCount: 0 };
        arr[arr.length - 1] = { ...arr[arr.length - 1], ...JSON.parse(values[1] as string) };
        run.rounds = arr;
        run.updated_at = nowIso();
        return { rows: [], rowCount: 1 };
      }
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
/** Validações anteriores do projeto (para a reincidência de âncora estável do GAP-71). */
let validacoesPassadas: FakeRow[] = [];
/** 🔴 C4: `stage_b_coverage` da validação mais recente — só o `oversized` importa ao freio. */
let coberturaDaUltimaRun: Record<string, unknown> | null = null;

const TITULO = "NVX LastMile";
const INDEX = body("Índice", 2);
const API = body("Backend API", 5);
const WEB = body("Frontend Web", 4);

function gap(file: string, severity: string, title: string): F {
  return { file, severity, title, fingerprint: `${file}:${severity}:${title}` };
}

beforeEach(() => {
  run = null;
  job = null;
  jobRowMissing = true;
  projectStatus = "draft";
  latestRunId = "run-0";
  validationStatus = "passed";
  coberturaAcumulada = null;
  coberturaDaUltimaRun = null;
  validacoesPassadas = [];
  rodadasPagas = new Map();
  veredicto = null;          // GAP-115: veredicto desligado por padrão neste arquivo
  snapshotFails = false;
  sqlLog.length = 0;
  unroutedFindings = [];
  oracleDecisions = [];
  oracleRegistryOn = true;
  gracaDeConsolidacao = 0;   // GAP-70: cada caso liga a graça se quiser medi-la
  ensureOracleDecisions.mockClear();
  makeTree([
    { path: "00-indice.md", content: INDEX, isPrimary: true },
    { path: "backend/01-api.md", content: API },
    { path: "frontend/01-web.md", content: WEB },
  ]);
  // api: 2 blockers + 1 warning + 1 info · web: 1 warning · índice: nada
  findings = [
    gap("backend/01-api.md", "blocker", "sem authz"),
    gap("backend/01-api.md", "blocker", "sem idempotência"),
    gap("backend/01-api.md", "warning", "sem paginação"),
    gap("backend/01-api.md", "info", "poderia citar SLO"),
    gap("frontend/01-web.md", "warning", "sem critérios de aceite"),
  ];
  process.env.API_AGENTS_URL = "http://agents:8000";
  process.env.SPEC_AUTONOMY = "on";
  startValidation.mockClear().mockResolvedValue({ ok: true as const, runId: "vr-1", reused: false });
  dispatchResolveGapsJob.mockClear().mockResolvedValue({ ok: true as const, gaps: 3 });
  dispatchGapFileJob.mockClear().mockResolvedValue({ ok: true as const, gaps: 2 });
  dispatchManifestJob.mockClear().mockResolvedValue({ ok: true as const });
});

afterEach(() => { delete process.env.SPEC_AUTONOMY; });

async function start(maxRounds?: number) {
  const res = await startAutonomyRun(db, { projectId: PROJECT, tenantId: null, ownerUserId: OWNER, maxRounds });
  if (!res.ok) throw new Error(`start falhou: ${res.code}`);
  return res.run;
}
/** Argumentos da última chamada ao CTO-editor (o transporte por arquivo). */
type FileCall = { filePath: string; findings: F[]; fileContent: string; userMessage: string; growthBudget?: number };
function fileCalls(): FileCall[] {
  return dispatchGapFileJob.mock.calls.map((c) => (c as unknown as unknown[])[0] as never);
}
function lastFileCall(): FileCall {
  return fileCalls().at(-1)!;
}
/** Fecha a rodada do arquivo corrente com uma revisão do CTO (ou uma falha). */
async function ctoReturns(runId: string, spec: string | null, extra: Partial<{ status: string; error: string; truncated: boolean }> = {}) {
  job = { status: extra.status ?? (spec ? "done" : "error"), specMarkdown: spec, error: extra.error ?? null, truncated: extra.truncated };
  await advanceAutonomyRun(db, runId);
}

// ── 1. modo e fila ────────────────────────────────────────────────────────────

describe("modo derivado da árvore", () => {
  it("2+ arquivos → per_file; a spec de 1 arquivo continua no ciclo da 090", async () => {
    const r = await start();
    expect(r.mode).toBe("per_file");
    await advanceAutonomyRun(db, r.id);
    expect(dispatchGapFileJob).toHaveBeenCalledTimes(1);
    expect(dispatchResolveGapsJob).not.toHaveBeenCalled();

    // árvore com 1 arquivo só: nada de fila por arquivo (zero regressão da 090)
    run = null;
    makeTree([{ path: "PRODUCT_SPEC.md", content: API, isPrimary: true }]);
    findings = [gap("PRODUCT_SPEC.md", "blocker", "sem authz")];
    dispatchGapFileJob.mockClear();
    const r2 = await start();
    expect(r2.mode).toBe("whole");
    await advanceAutonomyRun(db, r2.id);
    expect(dispatchResolveGapsJob).toHaveBeenCalledTimes(1);
    expect(dispatchGapFileJob).not.toHaveBeenCalled();
  });

  it("a fila começa pelo arquivo com mais BLOCKERS e manda só 🔴/🟡 daquele arquivo", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    const call = lastFileCall();
    expect(call.filePath).toBe("backend/01-api.md");       // 2 blockers > 1 warning do web
    expect(call.fileContent).toBe(API);                    // o ARQUIVO, não a spec inteira
    expect(call.findings).toHaveLength(3);                 // o `info` do mesmo arquivo NÃO vai
    expect(call.findings.every((f) => f.severity !== "info")).toBe(true);
    expect(call.findings.every((f) => f.file === "backend/01-api.md")).toBe(true);
    expect(run!.current_file).toBe("backend/01-api.md");
    expect(String(call.userMessage)).toContain("backend/01-api.md");
  });

  it("arquivo sem GAP importante (o índice) nunca entra na fila", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz por escopo.\n`);
    await advanceAutonomyRun(db, r.id);                    // 2º arquivo da fila
    const paths = fileCalls().map((c) => c.filePath);
    expect(paths).toEqual(["backend/01-api.md", "frontend/01-web.md"]);
    expect(paths).not.toContain("00-indice.md");
  });
});

// ── 1.1 GAP-119: ausência da LINHA do job não é rodada perdida ────────────────

/**
 * 🔴 GAP-119 — medido em prod (run `74f54cce`, 2026-09-08): a rodada 1 (`modelo-dados.md`) foi dada
 * por perdida com "o job do CTO deste arquivo não existe no banco" 20 s depois do despacho, enquanto o
 * job existia no banco desde 300 ms e 31 s depois ENTREGOU (3 edições, 218.479 → 219.556 chars, com
 * in=77.862/out=2.939 já debitados). O arquivo foi para `files_done` sem revisão e o trabalho pago foi
 * jogado fora. A ausência era MENTIRA: `createSpecChatJob` é transação (invisível antes do COMMIT) e um
 * erro de leitura virava `null` dentro de `getSpecChatJob`.
 *
 * O que estes testes travam: sem prova de ausência + carência vencida, o laço ESPERA — e quando as duas
 * coisas se confirmam ele descarta como antes, dizendo no texto que esperou.
 */
describe("🔴 GAP-119 — o laço não mata a rodada por ausência que não provou", () => {
  /** Envelhece a rodada corrente para além da carência (a carência real é de 120 s). */
  function envelheceRodada(minutos: number): void {
    const rounds = run!.rounds as Array<Record<string, unknown>>;
    rounds[rounds.length - 1].startedAt = new Date(Date.now() - minutos * 60_000).toISOString();
  }

  it("job ainda invisível numa rodada RECENTE → espera, não descarta o arquivo", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("cto_running");
    job = null;                                            // o tick não vê o job (transação em voo)
    jobRowMissing = true;                                  // e a prova diz "não há linha" AGORA
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("cto_running");               // a rodada continua viva
    expect(run!.files_done).toEqual([]);                   // o arquivo NÃO foi consumido
    expect(run!.file_failures).toBe(0);
    expect(run!.chat_job_id).toBeTruthy();
  });

  it("ausência INDECIDÍVEL (leitura falhou) → espera mesmo com a carência vencida", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    job = null;
    jobRowMissing = null;                                  // o SELECT de prova também falhou
    envelheceRodada(10);
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("cto_running");
    expect(run!.files_done).toEqual([]);
    expect(run!.file_failures).toBe(0);
  });

  it("a linha ESTÁ no banco (só a leitura anterior não a viu) → espera", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    job = null;
    jobRowMissing = false;
    envelheceRodada(10);
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("cto_running");
    expect(run!.files_done).toEqual([]);
  });

  it("ausência PROVADA + carência vencida → descarta o arquivo dizendo que esperou", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    job = null;
    jobRowMissing = true;
    envelheceRodada(10);
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("pending");                   // volta para a fila (comportamento antigo)
    expect(run!.files_done).toEqual(["backend/01-api.md"]);
    expect(run!.file_failures).toBe(1);
    expect(String(run!.last_error)).toContain("não existe no banco");
    expect(String(run!.last_error)).toContain("carência");
    // GAP-119 (2ª parte): `last_error` diz QUANDO — o campo não é limpo por rodada boa, e sem a
    // procedência uma recusa do arquivo 1 seguia sendo lida como falha do laço nove rodadas depois.
    expect(String(run!.last_error)).toContain("arquivo 1 (passe 1)");
  });

  it("job que aparece DEPOIS da espera é aplicado normalmente — o trabalho pago não se perde", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    job = null;
    await advanceAutonomyRun(db, r.id);                    // tick que antes matava a rodada
    expect(run!.status).toBe("cto_running");
    const revised = `${API}\n## 6. Segurança\nauthz por escopo.\n`;
    await ctoReturns(r.id, revised);                       // o job commitou e entregou
    expect(onDisk("backend/01-api.md")).toBe(revised);
    expect(run!.files_done).toEqual(["backend/01-api.md"]);
    expect(run!.file_failures).toBe(0);
  });
});

// ── 2. escrita cirúrgica + uma validação por PASSE ────────────────────────────

describe("uma rodada escreve UM arquivo", () => {
  it("escreve só o arquivo da rodada e deixa os outros byte a byte intactos", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    const revised = `${API}\n## 6. Segurança\nauthz por escopo + idempotência por chave.\n`;
    await ctoReturns(r.id, revised);
    expect(onDisk("backend/01-api.md")).toBe(revised);
    expect(onDisk("frontend/01-web.md")).toBe(WEB);
    expect(onDisk("00-indice.md")).toBe(INDEX);
    expect(run!.status).toBe("pending");                   // volta para a fila, NÃO valida
    expect(run!.files_done).toEqual(["backend/01-api.md"]);
    expect(run!.round).toBe(1);
    expect(startValidation).not.toHaveBeenCalled();
  });

  it("G2: o conteúdo anterior DAQUELE arquivo vai para o snapshot antes da escrita", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz.\n`);
    const snap = sqlLog.find((c) => /INSERT INTO project_spec_snapshots/.test(c.sql));
    expect(snap!.params[3]).toBe(API);                     // o que foi SUBSTITUÍDO
    expect(String(snap!.params[6])).toContain("autonomy:pass-1:file-1");
  });

  it("🔴 snapshot indisponível ABORTA a escrita (rede de segurança é pré-condição)", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    snapshotFails = true;
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz.\n`);
    expect(run!.status).toBe("stalled");
    expect(onDisk("backend/01-api.md")).toBe(API);
    expect(String(run!.last_error).toLowerCase()).toContain("snapshot");
  });

  it("a fila esvaziada dispara UMA validação para os dois arquivos (limite de 4/h)", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz.\n`);
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${WEB}\n## 5. Aceite\nCritérios objetivos.\n`);
    expect(run!.round).toBe(2);
    expect(startValidation).not.toHaveBeenCalled();        // ainda não: só quando a fila esvazia
    await advanceAutonomyRun(db, r.id);                    // fila vazia → valida o passe
    expect(run!.status).toBe("validating");
    expect(startValidation).toHaveBeenCalledTimes(1);
    expect(run!.passes).toBe(1);
    expect(run!.files_done).toEqual([]);                   // novo passe começa com a fila cheia
  });
});

// ── 2.1 GAP-81: a escalada de foco no arquivo teimoso ────────────────────────

/**
 * 🔴 GAP-81 — aqui se prova o TRANSPORTE da escalada (o planejador tem suíte própria em
 * `gapFocus.test.ts`): a lista que chega ao CTO encolhe, o agente é AVISADO de que ela foi restringida,
 * e a rodada fica marcada no log — sem a marca, o veredicto do GAP-77 não tem como contar foco pago e o
 * gatilho do Jean ("focamos neles individualmente algumas vezes") nunca abre.
 */
describe("GAP-81 — rodada DEDICADA ao GAP teimoso", () => {
  const TEIMOSO = {
    file: "backend/01-api.md", severity: "blocker", title: "sem authz", anchor: "§4",
    source: "stage_b", category: "security_gap",
  };

  /** 3 GAPs importantes no `01-api.md`, dos quais só `§4` reapareceu em validações COMPETENTES. */
  function comUmTeimoso() {
    findings = [
      { ...gap("backend/01-api.md", "blocker", "sem authz"), anchor: "§4", source: "stage_b" },
      { ...gap("backend/01-api.md", "blocker", "sem idempotência"), anchor: "§5", source: "stage_b" },
      { ...gap("backend/01-api.md", "warning", "sem paginação"), anchor: "§6", source: "stage_b" },
    ];
    validacoesPassadas = [
      { findings: [TEIMOSO], stage_b_coverage: { full: ["backend/01-api.md"] } },
      { findings: [TEIMOSO], stage_b_coverage: { full: ["backend/01-api.md"] } },
    ];
  }
  const ultimaRodada = () => (run!.rounds as Array<Record<string, unknown>>).at(-1)!;

  it("sem reincidência, a rodada segue NORMAL — a escalada não pode ser o caso comum", async () => {
    comUmTeimoso();
    validacoesPassadas = [];
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    expect(lastFileCall().findings).toHaveLength(3);
    expect(ultimaRodada().focusLevel).toBeUndefined();
    expect(lastFileCall().userMessage).not.toMatch(/DEDICADA/);
  });

  it("nível 1: só o reincidente vai ao CTO, e os adiados ficam DECLARADOS no log", async () => {
    comUmTeimoso();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    const call = lastFileCall();
    expect(call.findings.map((f) => f.anchor)).toEqual(["§4"]);
    // O agente PRECISA saber que a lista foi cortada — senão conclui que o arquivo só tem este defeito
    // e "consolida" o resto (família GAP-73).
    expect(call.userMessage).toMatch(/rodada DEDICADA/);
    expect(call.userMessage).toMatch(/2 adiado\(s\), seguem ativos/);
    expect(ultimaRodada()).toMatchObject({
      filePath: "backend/01-api.md", focusLevel: 1, focusDeferred: 2, focusAnchors: ["§4"],
    });
    // A âncora MEDIDA no apply é a da lista restrita: medir as outras acusaria de "intocado" um GAP que
    // esta rodada nem pediu.
    expect(ultimaRodada().gapAnchors).toEqual(["§4"]);
    expect(String(ultimaRodada().note)).toMatch(/REINCIDENTES/);
    // E o `gapsBefore` continua sendo a conta REAL do arquivo — a restrição é de escopo, não de contagem.
    expect(ultimaRodada().gapsBefore).toBe(3);
  });

  it("nível 2: com rodadas já pagas no arquivo, a rodada trata UM defeito só", async () => {
    comUmTeimoso();
    // Dois teimosos: no nível 1 iriam os dois; o degrau 2 escolhe o mais insistente.
    validacoesPassadas = [
      { findings: [TEIMOSO, { ...TEIMOSO, title: "sem idempotência", anchor: "§5" }], stage_b_coverage: { full: ["backend/01-api.md"] } },
      { findings: [TEIMOSO, { ...TEIMOSO, title: "sem idempotência", anchor: "§5" }], stage_b_coverage: { full: ["backend/01-api.md"] } },
      { findings: [TEIMOSO], stage_b_coverage: { full: ["backend/01-api.md"] } },
    ];
    rodadasPagas = new Map([["backend/01-api.md", 3]]);
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    expect(lastFileCall().findings.map((f) => f.anchor)).toEqual(["§4"]);
    expect(ultimaRodada()).toMatchObject({ focusLevel: 2, focusDeferred: 2, focusAnchors: ["§4"] });
    expect(String(ultimaRodada().note)).toMatch(/foco INDIVIDUAL/);
  });

  it("o GAP adiado NÃO é perdido: volta no passe seguinte", async () => {
    comUmTeimoso();
    const r = await start(3);
    await advanceAutonomyRun(db, r.id);
    expect(lastFileCall().findings.map((f) => f.anchor)).toEqual(["§4"]);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz por escopo.\n`);
    expect(run!.files_done).toEqual(["backend/01-api.md"]);
    await advanceAutonomyRun(db, r.id);                      // fila vazia (o web não tem GAP) → valida
    expect(run!.status).toBe("validating");
    // A validação mediu: o teimoso caiu, os DOIS adiados seguem em aberto — ninguém os fechou por
    // omissão, que é a garantia sem a qual restringir a rodada seria perder trabalho.
    findings = [
      { ...gap("backend/01-api.md", "blocker", "sem idempotência"), anchor: "§5", source: "stage_b" },
      { ...gap("backend/01-api.md", "warning", "sem paginação"), anchor: "§6", source: "stage_b" },
    ];
    validacoesPassadas = [];
    await advanceAutonomyRun(db, r.id);                      // validação medida → passe 2
    expect(run!.passes).toBe(1);
    await advanceAutonomyRun(db, r.id);
    expect(lastFileCall().filePath).toBe("backend/01-api.md");
    expect(lastFileCall().findings.map((f) => f.anchor)).toEqual(["§5", "§6"]);
  });

  it("falha ao ler as rodadas pagas não derruba a rodada — degrada para sem escalada", async () => {
    comUmTeimoso();
    const { focusRoundsByFile } = await import("./gapPromotionVerdict.js");
    vi.mocked(focusRoundsByFile).mockRejectedValueOnce(new Error("coluna não existe"));
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    expect(dispatchGapFileJob).toHaveBeenCalledTimes(1);
    // Sem a conta, `fileRounds = 0` ⇒ o degrau 2 não acontece, mas o degrau 1 (que não depende dela) sim.
    expect(ultimaRodada().focusLevel).toBe(1);
  });
});

// ── 3. tetos: passes (não arquivos) respeitam o limite do Jean ────────────────

describe("tetos do laço por arquivo", () => {
  /** Roda o passe inteiro: revisa cada arquivo da fila até a validação (ou o fim do laço). */
  async function drainPass(runId: string) {
    for (let i = 0; i < 12; i++) {
      await advanceAutonomyRun(db, runId);
      if (run!.status === "cto_running") {
        const target = String(run!.current_file);
        await ctoReturns(runId, `${onDisk(target)}\n## 99. Ajuste ${i}\nconteúdo novo do CTO.\n`);
      }
      if (run!.status === "validating" || isTerminalAutonomyStatus(run!.status as AutonomyStatus)) return;
    }
    throw new Error(`passe não terminou (status ${String(run!.status)})`);
  }

  it("maxRounds conta PASSES de validação, não arquivos revisados", async () => {
    const r = await start(1);
    await drainPass(r.id);
    expect(run!.status).toBe("validating");
    expect(run!.round).toBe(2);                            // 2 arquivos revisados…
    expect(run!.passes).toBe(1);                           // …em 1 passe
    await advanceAutonomyRun(db, r.id);                    // mediu: GAPs seguem em aberto
    expect(run!.status).toBe("exhausted");
    expect(String(run!.last_error)).toContain("passe(s) de validação");
  });

  it("GAPs caíram mas sobraram → novo passe, com a fila recomposta", async () => {
    const r = await start(3);
    await drainPass(r.id);
    findings = [gap("frontend/01-web.md", "blocker", "sem estado de erro")];
    await advanceAutonomyRun(db, r.id);                    // validação medida
    expect(run!.status).toBe("pending");
    expect(run!.passes).toBe(1);
    await advanceAutonomyRun(db, r.id);
    expect(lastFileCall().filePath).toBe("frontend/01-web.md");
    expect(run!.round).toBe(3);                            // 3º arquivo revisado no laço
  });

  /**
   * 🔴 GAP-117 — MEDIDO ao vivo em prod (run `f55ac180`, NVX LastMile, 2026-09-08): a spec tem 12
   * arquivos e o teto por passe é 12. O laço revisou os 12, voltou ao `startFileRound` e MORREU no
   * teto — `passes = 0`, um tick antes da validação que fecharia o passe. O `last_error` provou a
   * consequência: *"veredicto indisponível: … 0 de 2 passe(s) de validação concluído(s)"*. Ou seja:
   * para QUALQUER spec com 12+ arquivos na fila, o passe nunca fechava, a prova de trabalho do
   * GAP-82/114 era inalcançável e, com ela, o veredicto (GAP-115) e os desenhos (GAP-116).
   *
   * A cura não é um número maior (com 13 arquivos quebraria de novo): o teto por passe é teto DO
   * PASSE — "pare de revisar arquivos", não "encerre o laço". Fecha o passe e paga UMA validação.
   */
  describe("🔴 GAP-117 — o teto POR PASSE fecha o passe; quem encerra o laço é o teto do LAÇO", () => {
    /** As notas que o laço escreveu no chat da Bancada. */
    function notas(): string[] {
      return sqlLog
        .filter((q) => q.sql.startsWith("INSERT INTO spec_chat_messages"))
        .map((q) => String((q.params as unknown[])[2]));
    }

    it("teto do passe COM trabalho aplicado → valida o passe (não encerra), e diz o motivo", async () => {
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: true }));
      run!.status = "pending";
      run!.current_file = null;
      run!.files_done = ["backend/01-api.md"];
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("validating");
      expect(run!.passes).toBe(1);                            // o passe FOI contado
      expect(run!.files_done).toEqual([]);                    // e a fila do passe seguinte recomeça
      expect(isTerminalAutonomyStatus(run!.status as AutonomyStatus)).toBe(false);
      // Honestidade: o usuário vê que o passe fechou por TETO, não por ter acabado o serviço.
      const nota = notas().at(-1)!;
      expect(nota).toContain(`teto de ${AUTONOMY_MAX_FILE_ROUNDS} arquivo(s) por passe atingido`);
      expect(nota).toContain("Validando a spec inteira");
    });

    it("teto do passe SEM nada aplicado → encerra (validar mediria a MESMA spec)", async () => {
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: false }));
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).toContain("neste passe");
      expect(run!.passes).toBe(0);
    });

    /**
     * 🔴 GAP-123 — este teste afirmava o DEFEITO ("continua encerrando, mesmo com trabalho aplicado").
     * MEDIDO na run `731c58ce` (NVX LastMile, 2026-09-08): o teto do laço encerrou com 5 rodadas
     * APLICADAS que nenhuma validação mediu (+1071 chars escritos das 22:08:37 às 22:18:06; a última
     * validação fechou às 22:06:31) e com `passes = 2` de `max_rounds = 5` — orçamento sobrando. A run
     * então reportou `47` como estado final (o número de 22:06) e o veredicto de promovibilidade julgou
     * achados dessa validação vencida. Uma das 5 era a rodada que FECHOU o GAP-122.
     *
     * O teto do laço continua sendo o freio de CUSTO — ele impede rodada nova de CTO, que é o que custa.
     * Medir o que já foi escrito custa UMA validação e é a única forma de a contagem final ser o disco.
     */
    it("teto do LAÇO com trabalho aplicado → MEDE o passe antes de encerrar (não joga o trabalho fora)", async () => {
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      const antes = fileCalls().length;
      run!.round = AUTONOMY_MAX_TOTAL_FILE_ROUNDS;
      run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: true }));
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("validating");
      expect(isTerminalAutonomyStatus(run!.status as AutonomyStatus)).toBe(false);
      expect(run!.passes).toBe(1);                            // o passe FOI contado
      expect(fileCalls().length).toBe(antes);                 // e NENHUM arquivo novo foi ao CTO
      const nota = notas().at(-1)!;
      expect(nota).toContain(`teto de ${AUTONOMY_MAX_TOTAL_FILE_ROUNDS} arquivo(s) no laço atingido`);
      expect(nota).toContain("Validando a spec inteira");
    });

    it("GAP-123: medido o passe, a volta ao teto do LAÇO encerra — uma validação, não um laço infinito", async () => {
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      run!.round = AUTONOMY_MAX_TOTAL_FILE_ROUNDS;
      run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: true }));
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);                     // teto do laço → valida o passe
      expect(run!.status).toBe("validating");
      findings = [gap("frontend/01-web.md", "blocker", "sem estado de erro")];
      await advanceAutonomyRun(db, r.id);                     // validação medida → passe 2
      expect(run!.status).toBe("pending");
      const chamadas = fileCalls().length;
      await advanceAutonomyRun(db, r.id);                     // teto do laço de novo, agora sem nada a medir
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).toContain("neste laço atingido");
      expect(fileCalls().length).toBe(chamadas);              // o teto de CUSTO seguiu valendo
    });

    it("teto do LAÇO SEM nada aplicado no passe → encerra (validar mediria a MESMA spec)", async () => {
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      run!.round = AUTONOMY_MAX_TOTAL_FILE_ROUNDS;
      run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: false }));
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).toContain("neste laço atingido");
      expect(run!.passes).toBe(0);
    });

    /**
     * 🔴 GAP-123, a outra ponta: quando o orçamento de PASSES acabou não há validação a pagar — e é aí
     * que o resto tem de ser declarado. Cortar é ok; mentir sobre o corte não.
     */
    it("teto de PASSES com rodada aplicada não medida → a mensagem final DECLARA o que ficou fora", async () => {
      const r = await start(1);
      await advanceAutonomyRun(db, r.id);
      run!.passes = 1;                                        // orçamento de passes esgotado
      run!.rounds = [{ round: 1, pass: 1, applied: true }, { round: 2, pass: 1, applied: true }];
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).toContain("2 arquivo(s) salvo(s) no último passe NÃO entraram nesta contagem");
      expect(String(run!.last_error)).toContain("rode Validar");
    });

    it("teto de PASSES sem rodada aplicada → nada a declarar (mensagem limpa)", async () => {
      const r = await start(1);
      await advanceAutonomyRun(db, r.id);
      run!.passes = 1;
      run!.rounds = [{ round: 1, pass: 1, applied: false }];
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).not.toContain("NÃO entraram nesta contagem");
    });

    it("o passe fechado pelo teto vira PASSE 2 de verdade: o laço volta a revisar arquivos", async () => {
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: true }));
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);                     // teto → validando
      expect(run!.status).toBe("validating");
      findings = [gap("frontend/01-web.md", "blocker", "sem estado de erro")];
      await advanceAutonomyRun(db, r.id);                     // validação medida → passe 2
      expect(run!.status).toBe("pending");
      expect(run!.passes).toBe(1);
      const antes = fileCalls().length;
      await advanceAutonomyRun(db, r.id);
      expect(fileCalls().length).toBe(antes + 1);             // o passe 2 recebeu seu arquivo
      expect(lastFileCall().filePath).toBe("frontend/01-web.md");
    });
  });

  it("teto de arquivos do laço existe e é maior que o de passes", () => {
    expect(AUTONOMY_MAX_FILE_ROUNDS).toBeGreaterThan(5);
    // GAP-3: o teto por passe não pode ser o teto do laço — senão uma spec com mais arquivos que o
    // teto gasta todos os passes no primeiro e nunca chega à 2ª validação.
    expect(AUTONOMY_MAX_TOTAL_FILE_ROUNDS).toBeGreaterThan(AUTONOMY_MAX_FILE_ROUNDS);
  });

  it("GAP-3: o teto de arquivos é do PASSE — o passe 2 não herda as rodadas do passe 1", async () => {
    const r = await start(3);
    await drainPass(r.id);
    findings = [gap("frontend/01-web.md", "blocker", "sem estado de erro")];
    await advanceAutonomyRun(db, r.id);                    // validação medida → passe 2
    expect(run!.passes).toBe(1);
    // O passe 1 gastou MUITAS rodadas-arquivo (spec grande). Com o teto global antigo o laço morria
    // aqui em `exhausted` anunciando "até 3 passes" — foi o que aconteceu nos runs a4ad542f/dd587b75.
    run!.rounds = [
      ...(run!.rounds as unknown[]),
      ...Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: 100 + i, pass: 0, applied: true })),
    ];
    run!.round = AUTONOMY_MAX_FILE_ROUNDS + 3;
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("cto_running");               // o passe 2 recebeu seu arquivo
    expect(lastFileCall().filePath).toBe("frontend/01-web.md");
  });

  it("GAP-3: dentro do MESMO passe o teto continua valendo (trava de custo)", async () => {
    const r = await start(3);
    await advanceAutonomyRun(db, r.id);
    // 12 rodadas já gastas NESTE passe → nenhum arquivo novo vai ao CTO.
    run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: true }));
    run!.status = "pending";
    run!.current_file = null;
    const antes = fileCalls().length;
    await advanceAutonomyRun(db, r.id);
    expect(fileCalls().length).toBe(antes);                 // a trava de custo funcionou
    // 🔴 GAP-117: …mas o passe fechou e vai ser MEDIDO (antes o laço morria aqui, com `passes=0`).
    expect(run!.status).toBe("validating");
    expect(run!.passes).toBe(1);
  });

  /**
   * 🔴 GAP-115 — MEDIDO em prod (run `10b1a4e1`: 30 rodadas, 2 passes, 44 → 44 GAPs). O veredicto de
   * promovibilidade só era chamado no tick `validating`. Esta run acabou pelo TETO DE ARQUIVOS, aqui em
   * `startFileRound`, e encerrou SEM veredicto nenhum — a run com mais trabalho pago do projeto. Ou
   * seja: a única saída LEGAL do laço (o juiz decidindo se o GAP impede promover) era inalcançável por
   * construção sempre que o teto de arquivos chegasse antes do teto de passes.
   */
  describe("🔴 GAP-115 — o fim de laço por TETO DE ARQUIVOS também chama o juiz", () => {
    it("teto do passe com GAPs em aberto: o parecer entra na mensagem final e no log", async () => {
      veredicto = { candidates: 2, released: 0, impeditive: 2, promotable: false };
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      // 🔴 GAP-117: com trabalho aplicado o teto do passe agora FECHA O PASSE (valida). O fim de laço
      // aqui é o caso em que o passe gastou as 12 rodadas sem escrever nada — validar mediria a mesma
      // spec e queimaria uma das 4 validações/h.
      run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: false }));
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).toContain("neste passe");
      expect(String(run!.last_error)).toContain("promovibilidade");
      expect(String(run!.last_error)).toContain("NÃO promovível");
      // O fato que sustenta a autoridade do juiz (GAP-82) vai declarado, não subentendido.
      expect(String(run!.last_error)).toContain("laço esgotou o orçamento sem fechar GAP");
      expect((run!.rounds as Array<Record<string, unknown>>).at(-1)).toMatchObject({
        verdictCandidates: 2, verdictImpeditive: 2, promotable: false,
      });
    });

    it("teto do LAÇO (30 arquivos) — o desfecho exato da run `10b1a4e1` — também julga", async () => {
      veredicto = { candidates: 1, released: 0, impeditive: 1, promotable: false };
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      run!.round = AUTONOMY_MAX_TOTAL_FILE_ROUNDS;
      run!.rounds = [];                                    // nada gasto NESTE passe: o teto é o do laço
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).toContain("neste laço atingido");
      expect(String(run!.last_error)).toContain("promovibilidade");
      // A mensagem de "rode de novo para continuar" continua lá: o parecer se soma, não substitui.
      expect(String(run!.last_error)).toContain("continuar de onde parou");
    });

    it("ZERO GAP importante no teto → nenhum veredicto (não há reincidente a julgar)", async () => {
      veredicto = { candidates: 2, released: 0, impeditive: 2, promotable: false };
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      findings = [];                                       // spec sem GAP importante
      run!.round = AUTONOMY_MAX_TOTAL_FILE_ROUNDS;
      run!.rounds = [];
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).not.toContain("promovibilidade");
    });

    it("veredicto desligado no teto → mensagem antiga, sem parecer (fail-CLOSED)", async () => {
      veredicto = null;
      const r = await start(3);
      await advanceAutonomyRun(db, r.id);
      run!.round = AUTONOMY_MAX_TOTAL_FILE_ROUNDS;
      run!.rounds = [];
      run!.status = "pending";
      run!.current_file = null;
      await advanceAutonomyRun(db, r.id);
      expect(run!.status).toBe("exhausted");
      expect(String(run!.last_error)).not.toContain("promovibilidade");
      expect(String(run!.last_error)).toContain("continuar de onde parou");
    });
  });
});

// ── 3.1 A5.3: o manifesto (README.md) — o GAP que nenhuma ação resolvia ───────

describe("A5.3 — criação do manifesto pelo laço", () => {
  const MANIFESTO = [
    "---",
    "kind: project",
    "archetype: backend-service",
    "stack: [nodejs]",
    "depends_on: []",
    "deploy_target: aws-ecs",
    "---",
    "",
    "# NVX LastMile",
    "",
    "Serviço de última milha. ".repeat(30),
    "",
    "## Índice da especificação",
    "- `00-indice.md` — visão e escopo",
  ].join("\n");

  /** O finding do Estágio A: aponta um arquivo que NÃO existe (`file` vazio, âncora `no_readme`). */
  function noReadme(): F & { anchor: string } {
    return { ...gap("", "warning", "Spec sem manifesto (README.md)"), anchor: "no_readme" };
  }

  beforeEach(() => {
    process.env.UPLOAD_DIR = root;                        // o laço cria o arquivo DE VERDADE
    unroutedFindings = [noReadme()];
    // Como em prod: o `no_readme` também está no estado de findings do projeto (é ele que sustenta a
    // rodada em `tallyGaps`); o que o escopo faz é deixá-lo em `unrouted`, porque `file` é vazio.
    findings = [noReadme(), gap("backend/01-api.md", "blocker", "sem authz")];
  });
  afterEach(() => { delete process.env.UPLOAD_DIR; });

  it("entra no FIM da fila e é pedido ao CTO com a árvore inteira como insumo", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    expect(lastFileCall().filePath).toBe("backend/01-api.md");   // conteúdo antes do índice
    await ctoReturns(r.id, `${onDisk("backend/01-api.md")}\n## 99. Authz\nagora tem.\n`);
    await advanceAutonomyRun(db, r.id);
    expect(run!.current_file).toBe("README.md");
    expect(dispatchManifestJob).toHaveBeenCalledTimes(1);
    const arg = (dispatchManifestJob.mock.calls[0] as unknown as unknown[])[0] as
      { files: string[]; primaryPath: string };
    expect(arg.files).toEqual(["00-indice.md", "backend/01-api.md", "frontend/01-web.md"]);
    expect(arg.primaryPath).toBe("00-indice.md");
  });

  it("aprovado pelo veto → o arquivo é CRIADO no disco e registrado na árvore", async () => {
    const r = await start();
    findings = [noReadme()];                               // só o manifesto pendente
    await advanceAutonomyRun(db, r.id);
    expect(run!.current_file).toBe("README.md");
    await ctoReturns(r.id, MANIFESTO);
    expect(readFileSync(join(root, PROJECT, "README.md"), "utf-8")).toContain("archetype: backend-service");
    expect(sqlLog.some((q) => q.sql.startsWith("INSERT INTO project_spec_files")
      && (q.params as unknown[])[1] === "README.md")).toBe(true);
    expect(run!.files_done).toContain("README.md");
    expect(run!.status).toBe("pending");
  });

  it("recusado pelo veto (sem frontmatter) → NÃO escreve e o motivo fica na rodada", async () => {
    const r = await start();
    findings = [noReadme()];
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `# NVX LastMile\n\n${"conteúdo. ".repeat(40)}`);
    expect(() => readFileSync(join(root, PROJECT, "README.md"), "utf-8")).toThrow();
    expect(String(JSON.stringify(run!.rounds))).toContain("NO_FRONTMATTER");
  });

  it("sem o GAP `no_readme` ativo, o laço NÃO cria manifesto nenhum", async () => {
    unroutedFindings = [];
    findings = [gap("backend/01-api.md", "blocker", "sem authz")];
    const r = await start();
    await advanceAutonomyRun(db, r.id);                     // arquivo de conteúdo
    await ctoReturns(r.id, `${onDisk("backend/01-api.md")}\n## 99. Authz\nagora tem.\n`);
    await advanceAutonomyRun(db, r.id);                     // fila vazia → valida o passe
    expect(dispatchManifestJob).not.toHaveBeenCalled();
    expect(run!.status).toBe("validating");
  });
});

/**
 * GAP-5 — medido em prod no run `75b3cf5d` (passe 2, rodada 11): log
 * `arquivo 11 (README.md, CRIAÇÃO)` e depois `last_error = "o manifesto passou a existir durante a
 * rodada — não sobrescrevi"`. O manifesto criado no passe 1 ganhou GAPs próprios e voltou à fila como
 * arquivo normal; como os DOIS caminhos chaveavam pelo NOME (`target === MANIFEST_PATH`), o laço
 * pagou uma rodada de CRIAÇÃO para o próprio guard recusá-la. Uma rodada de LLM jogada fora e o
 * arquivo nunca corrigido. Agora quem decide é a EXISTÊNCIA do arquivo.
 */
describe("GAP-5 — manifesto que JÁ existe é editado, não recriado", () => {
  beforeEach(() => {
    process.env.UPLOAD_DIR = root;
    makeTree([
      { path: "00-indice.md", content: INDEX, isPrimary: true },
      { path: "backend/01-api.md", content: API },
      { path: "README.md", content: body("Manifesto", 4) },
    ]);
    // Como em prod depois do passe 1: o manifesto existe na árvore E tem GAPs seus.
    findings = [
      gap("README.md", "blocker", "manifesto sem arquétipo declarado"),
      gap("README.md", "warning", "manifesto sem stack"),
    ];
    unroutedFindings = [];
  });
  afterEach(() => { delete process.env.UPLOAD_DIR; });

  it("vai ao CTO-editor com o conteúdo do arquivo (não ao gerador de manifesto)", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    expect(dispatchManifestJob).not.toHaveBeenCalled();
    expect(dispatchGapFileJob).toHaveBeenCalledTimes(1);
    expect(lastFileCall().filePath).toBe("README.md");
    expect(lastFileCall().fileContent).toBe(onDisk("README.md"));
    expect(lastFileCall().findings.map((f) => f.severity)).toEqual(["blocker", "warning"]);
    expect(String(JSON.stringify(run!.rounds))).not.toContain("manifestCreation");
  });

  it("a revisão é ESCRITA no arquivo — o guard de criação não pode recusá-la", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    const revised = `${onDisk("README.md")}\n## 99. Arquétipo\nbackend-service.\n`;
    await ctoReturns(r.id, revised);
    expect(onDisk("README.md")).toBe(revised);
    expect(run!.files_done).toContain("README.md");
    expect(run!.last_error).toBeNull();
  });

  /**
   * GAP-14 — medido em prod 2026-09-06 (run `c3757985`, rodada 2): o CTO reescreveu o `README.md`
   * (15.720 → 19.392 chars) trocando `archetype: backend-service` por `backend_api`, que não existe no
   * catálogo. O Estágio A virou BLOCKER estrutural, o adversarial não rodou e a validação seguinte
   * mediu 1 GAP em vez de 21 (é o produtor do GAP-13). O veto de manifesto só cobria a CRIAÇÃO.
   */
  describe("GAP-14 — a edição não pode ESTRAGAR um manifesto válido", () => {
    const VALIDO = [
      "---", "archetype: backend-service", "stack: [nodejs-20]", "depends_on: []", "---", "",
      "# Manifesto", "", "## 1. Escopo", "escopo ".repeat(60), "",
    ].join("\n");

    beforeEach(() => {
      makeTree([
        { path: "00-indice.md", content: INDEX, isPrimary: true },
        { path: "backend/01-api.md", content: API },
        { path: "README.md", content: VALIDO },
      ]);
      process.env.UPLOAD_DIR = root;
      findings = [gap("README.md", "warning", "manifesto sem seção de deploy")];
      unroutedFindings = [];
    });

    it("🔴 arquétipo FORA do catálogo → recusa, disco INTACTO e motivo registrado", async () => {
      const r = await start();
      await advanceAutonomyRun(db, r.id);
      const quebrado = `${VALIDO}\n## 2. Deploy\ndocker.\n`.replace("backend-service", "backend_api");
      await ctoReturns(r.id, quebrado);
      expect(onDisk("README.md")).toBe(VALIDO);
      const log = JSON.stringify(run!.rounds);
      expect(log).toContain("ARCHETYPE_UNKNOWN");
      // Sai da fila deste passe (como toda falha de arquivo), mas NÃO como rodada aplicada.
      expect(log).toContain("\"applied\":false");
    });

    it("🔴 frontmatter removido do manifesto válido → recusa (a fábrica não leria mais o projeto)", async () => {
      const r = await start();
      await advanceAutonomyRun(db, r.id);
      await ctoReturns(r.id, `# Manifesto\n\n## 1. Escopo\n${"escopo ".repeat(60)}\n## 2. Deploy\ndocker.\n`);
      expect(onDisk("README.md")).toBe(VALIDO);
      expect(JSON.stringify(run!.rounds)).toContain("NO_FRONTMATTER");
    });

    it("edição que PRESERVA o frontmatter é escrita normalmente", async () => {
      const r = await start();
      await advanceAutonomyRun(db, r.id);
      const bom = `${VALIDO}\n## 2. Deploy\ndocker compose em um nó.\n`;
      await ctoReturns(r.id, bom);
      expect(onDisk("README.md")).toBe(bom);
      expect(run!.files_done).toContain("README.md");
    });

    it("manifesto que JÁ era inválido continua editável (a regra é não-regressão, não perfeição)", async () => {
      makeTree([
        { path: "00-indice.md", content: INDEX, isPrimary: true },
        { path: "backend/01-api.md", content: API },
        { path: "README.md", content: body("Manifesto sem frontmatter", 4) },
      ]);
      process.env.UPLOAD_DIR = root;
      const r = await start();
      await advanceAutonomyRun(db, r.id);
      const revisado = `${onDisk("README.md")}\n## 99. Deploy\ndocker.\n`;
      await ctoReturns(r.id, revisado);
      expect(onDisk("README.md")).toBe(revisado);
      expect(run!.files_done).toContain("README.md");
    });
  });

  it("o manifesto AUSENTE continua indo pelo caminho de criação (marcado na rodada)", async () => {
    makeTree([
      { path: "00-indice.md", content: INDEX, isPrimary: true },
      { path: "backend/01-api.md", content: API },
    ]);
    process.env.UPLOAD_DIR = root;
    const semManifesto = { ...gap("", "warning", "Spec sem manifesto (README.md)"), anchor: "no_readme" };
    unroutedFindings = [semManifesto];
    findings = [semManifesto];
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    expect(dispatchManifestJob).toHaveBeenCalledTimes(1);
    expect(dispatchGapFileJob).not.toHaveBeenCalled();
    expect(String(JSON.stringify(run!.rounds))).toContain("\"manifestCreation\":true");
  });
});

// ── 4. falha de ARQUIVO ≠ falha do laço ──────────────────────────────────────

describe("falhas em nível de arquivo", () => {
  it("arquivo grande demais para o orçamento de saída → sai da fila, o laço segue", async () => {
    dispatchGapFileJob.mockResolvedValueOnce({
      ok: false, code: "FILE_TOO_LARGE", message: "backend/01-api.md tem 60000 caracteres (teto 48000)",
    } as never);
    const r = await start();
    await advanceAutonomyRun(db, r.id);                    // api recusado
    expect(run!.status).toBe("pending");
    expect(run!.files_done).toEqual(["backend/01-api.md"]);
    expect(run!.chat_job_id).toBeNull();
    expect(String(run!.last_error)).toContain("teto");
    await advanceAutonomyRun(db, r.id);                    // segue no próximo arquivo
    expect(lastFileCall().filePath).toBe("frontend/01-web.md");
  });

  it("🔴 revisão TRUNCADA de um arquivo → arquivo intacto, fila segue no próximo", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\ncortad`, { truncated: true });
    expect(onDisk("backend/01-api.md")).toBe(API);
    expect(run!.status).toBe("pending");
    expect(run!.file_failures).toBe(1);
    await advanceAutonomyRun(db, r.id);
    expect(lastFileCall().filePath).toBe("frontend/01-web.md");
    expect(run!.status).toBe("cto_running");
  });

  it("duas falhas de arquivo SEGUIDAS → stalled (o problema não é o arquivo) e disco intacto", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, null, { status: "error", error: "O CTO não conseguiu revisar (BLOCKED)." });
    expect(run!.status).toBe("pending");
    expect(run!.file_failures).toBe(1);
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, null, { status: "error", error: "429 do provedor" });
    expect(run!.status).toBe("stalled");
    expect(onDisk("backend/01-api.md")).toBe(API);
    expect(onDisk("frontend/01-web.md")).toBe(WEB);
    expect(startValidation).not.toHaveBeenCalled();
  });

  it("revisão de arquivo que ENCOLHE (<70%) → não escreve e conta como falha do arquivo", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, "# Backend API\n\nresumo curto");
    expect(onDisk("backend/01-api.md")).toBe(API);
    expect(run!.status).toBe("pending");
    expect(run!.file_failures).toBe(1);
  });

  it("aplicar um arquivo com sucesso ZERA a contagem de falhas", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\ncortad`, { truncated: true });
    expect(run!.file_failures).toBe(1);
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${WEB}\n## 5. Aceite\nCritérios objetivos.\n`);
    expect(run!.file_failures).toBe(0);
    expect(run!.files_done).toEqual(["backend/01-api.md", "frontend/01-web.md"]);
  });
});

// ── 5. falha de PROJETO para o laço na hora ──────────────────────────────────

describe("guardas de projeto (param o laço)", () => {
  it("🔴 arquivo editado por fora durante a rodada → NÃO sobrescreve (stalled)", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    const humano = `${API}\n## 6. Escrito pelo HUMANO no meio do laço.\n`;
    writeFileSync(tree.find((f) => f.path === "backend/01-api.md")!.filePath, humano, "utf-8");
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz do CTO.\n`);
    expect(run!.status).toBe("stalled");
    expect(onDisk("backend/01-api.md")).toBe(humano);
    expect(String(run!.last_error)).toContain("editado por fora");
  });

  it("spec travada (projeto em fábrica) no meio do laço → stalled sem escrever", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    projectStatus = "running";
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz.\n`);
    expect(run!.status).toBe("stalled");
    expect(onDisk("backend/01-api.md")).toBe(API);
  });

  it("GAP importante SEM arquivo definido e nada aplicado → stalled dizendo isso (não adivinha)", async () => {
    // O GAP existe (sustenta o laço) mas o `file` não casa com nenhum arquivo da árvore.
    const global = gap("", "blocker", "transversal sem arquivo");
    findings = [global];
    unroutedFindings = [global];
    const r = await start();
    expect(r.mode).toBe("per_file");
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("stalled");
    expect(dispatchGapFileJob).not.toHaveBeenCalled();
    expect(String(run!.last_error)).toContain("SEM arquivo definido");
    expect(startValidation).not.toHaveBeenCalled();
  });
});

// ── GAP-22: veto de consolidação (o arquivo que redeclara contrato de outro) ───

describe("GAP-22 — consolidar é ENCOLHER: crescimento não é correção", () => {
  /** `backend/01-api.md` redeclara o contrato cujo oráculo é o índice. */
  const decideOraculo = (): void => {
    oracleDecisions = [{
      contractKey: "paginacao", oraclePath: "00-indice.md",
      ruleSummary: "page/pageSize, 1-based", restatedIn: ["backend/01-api.md"],
    }];
  };

  it("pede a decisão de oráculos com o hash do conteúdo VALIDADO e os GAPs ativos", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    expect(ensureOracleDecisions).toHaveBeenCalled();
    const [, projectId, opts] = ensureOracleDecisions.mock.calls[0] as unknown as
      [unknown, string, { specHash: string; findings: F[] }];
    expect(projectId).toBe(PROJECT);
    expect(opts.specHash).toBe("hash-do-conteudo");
    // O laço entrega TODOS os ativos (roteados + sem rota); quem filtra por severidade é o próprio
    // `specOracles` (só 🔴/🟡 sustentam decisão de arquitetura) — filtrar aqui duplicaria a régua.
    expect(opts.findings.length).toBe(findings.length);
    expect(dispatchGapFileJob).toHaveBeenCalledTimes(1);
  });

  it("GAP-38 — a margem ANUNCIADA fica no log da rodada, igual à que foi ao agente", async () => {
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    // Sem o anunciado no log, "o agente sabia onde estava a linha" era indemonstrável: dava para ver a
    // recusa, não o pedido. Medir pedido × entrega é o que provou que 447 voltaram como +1.431.
    const round = (run!.rounds as { round: number; announcedBudget?: number }[]).at(-1)!;
    expect(round.announcedBudget).toBe(lastFileCall().growthBudget);
    expect(typeof round.announcedBudget).toBe("number");
  });

  it("arquivo que REDECLARA e cresceu além do orçamento → NÃO escreve e o laço segue", async () => {
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    expect(lastFileCall().filePath).toBe("backend/01-api.md");
    // Um parágrafo normativo a mais: +3.000 chars num arquivo que devia ENCOLHER.
    await ctoReturns(r.id, `${API}\n## 6. Fonte única de paginação\n${"esta seção é a fonte única. ".repeat(120)}\n`);
    expect(onDisk("backend/01-api.md")).toBe(API);            // disco INTACTO
    expect(String(run!.last_error)).toContain("consolidação recusada");
    expect(String(run!.last_error)).toContain("`paginacao` → `00-indice.md`");
    // GAP-37: a recusa é lida de volta pelo agente (`priorRejectionFactBlock`), então ela não pode
    // descrever o pedido errado. A rodada pediu resolver os GAPs do arquivo E consolidar — dizer que a
    // correção "era REMOVER a redeclaração" faria a próxima tentativa ABANDONAR os blockers p/ caber.
    expect(String(run!.last_error)).toContain("incluía REMOVER a redeclaração");
    expect(String(run!.last_error)).toContain("A rodada pediu DUAS coisas");
    expect(String(run!.last_error)).toContain("Nenhuma das duas foi abandonada pelo veto");
    expect(run!.status).toBe("pending");                      // não é falha do laço
    expect(run!.file_failures).toBe(0);                       // nem falha DO ARQUIVO
    expect(run!.files_done).toContain("backend/01-api.md");   // sai da fila deste passe
  });

  // ── 🔴 GAP-64: quase-conformidade é COBRADA, não descartada ──────────────────────────────────
  /** Conteúdo que CITA o oráculo (senão o veto recusa por "não consolidou") com delta EXATO. */
  const citacao = "\nver `00-indice.md` — fonte única deste contrato.\n";
  const cresceExatamente = (delta: number): string => `${API}${citacao}${"x".repeat(delta - citacao.length)}`;

  it("🔴 GAP-64 — passou da margem por POUCO (dentro da tolerância) → APLICA e declara o excesso", async () => {
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    // Margem 2.000, tolerância 100. Medido em prod (run `f4855b9a`): +3.906 contra 3.889 — 0,44% de
    // excesso descartava a rodada INTEIRA, com 🔴 3 + 🟡 3 resolvidos e uma chamada de Opus 5 paga.
    const quaseConforme = cresceExatamente(2_050);
    await ctoReturns(r.id, quaseConforme);
    expect(onDisk("backend/01-api.md")).toBe(quaseConforme);   // o trabalho bom NÃO é jogado fora
    expect(run!.last_error).toBeFalsy();
    const round = (run!.rounds as { applied?: boolean; deltaChars?: number; toleratedOverflow?: number; note?: string }[]).at(-1)!;
    expect(round.applied).toBe(true);
    expect(round.deltaChars).toBe(2_050);
    // o excesso é DECLARADO: foi decisão do laço pagar, e a margem seguinte já desconta os 2.050
    expect(round.toleratedOverflow).toBe(50);
    expect(round.note).toContain("PAGOU o excesso");
  });

  it("🔴 GAP-64 — excesso ACIMA da tolerância continua vetado, e a recusa diz qual era o limite", async () => {
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    // 2.101 = margem 2.000 + tolerância 100 + 1. A banda resgata quase-conformidade, não negociação:
    // os casos do GAP-38 (+1.431 contra 447, +2.827 contra 680) estão 2× a 6× acima e seguem recusados.
    await ctoReturns(r.id, cresceExatamente(2_101));
    expect(onDisk("backend/01-api.md")).toBe(API);             // disco INTACTO
    expect(String(run!.last_error)).toContain("consolidação recusada");
    expect(String(run!.last_error)).toContain("CRESCEU 2101 chars");
    expect(String(run!.last_error)).toContain("com a tolerância de 100, o limite desta rodada era 2100");
    const round = (run!.rounds as { applied?: boolean; toleratedOverflow?: number }[]).at(-1)!;
    expect(round.applied).toBe(false);
    expect(round.toleratedOverflow).toBeUndefined();
  });

  // ── 🔴 GAP-70: com margem 0 a tolerância do GAP-64 também é 0 → o penhasco volta ─────────────
  // MEDIDO em prod (run `f101303f`, passe 1, rodada 10): o `README.md` ia REMOVER 9 redeclarações de
  // contrato E fechar 4 GAPs; voltou +692 chars contra margem 0 e foi descartado INTEIRO. Perdeu-se a
  // REMOÇÃO — a única coisa que ataca o crescimento da spec (GAP-8).
  it("🔴 GAP-70 — estouro ACIMA da tolerância mas a rodada CONSOLIDOU → empresta do pool e escreve", async () => {
    gracaDeConsolidacao = 2_000;
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    // 2.792 = margem 2.000 + tolerância 100 + os 692 do caso real. Sem a graça, isto é o veto acima.
    const consolidou = cresceExatamente(2_792);
    await ctoReturns(r.id, consolidou);
    expect(onDisk("backend/01-api.md")).toBe(consolidou);       // a REMOÇÃO chega ao disco
    expect(run!.last_error).toBeFalsy();
    const round = (run!.rounds as { applied?: boolean; deltaChars?: number; toleratedOverflow?: number; consolidationGrace?: number; note?: string }[]).at(-1)!;
    expect(round.applied).toBe(true);
    expect(round.deltaChars).toBe(2_792);
    // O excesso TOTAL sobre a margem continua declarado (GAP-64)…
    expect(round.toleratedOverflow).toBe(792);
    // …e a parcela EMPRESTADA é contabilizada à parte, porque é ela que esgota o pool.
    expect(round.consolidationGrace).toBe(692);
    expect(round.note).toContain("EMPRESTADOS da graça de consolidação");
    expect(round.note).toContain("Restam 1308 chars");
  });

  it("🔴 GAP-70 — a graça NÃO se aplica a quem só engordou sem citar o oráculo", async () => {
    gracaDeConsolidacao = 2_000;
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    // +3.000 chars de seção normativa nova, SEM citar o oráculo: é o caso que a graça não pode salvar,
    // senão ela deixa de ser graça de consolidação e passa a ser um segundo orçamento.
    await ctoReturns(r.id, `${API}\n## 6. Fonte única de paginação\n${"esta seção é a fonte única. ".repeat(120)}\n`);
    expect(onDisk("backend/01-api.md")).toBe(API);              // disco INTACTO
    expect(String(run!.last_error)).toContain("consolidação recusada");
    expect(String(run!.last_error)).toContain("A graça de consolidação NÃO se aplica");
    expect(String(run!.last_error)).toContain("só vale quando o arquivo passa a CITAR o oráculo");
  });

  it("🔴 GAP-70 — consolidou mas estourou ATÉ a graça: a recusa diz quanto foi emprestado", async () => {
    gracaDeConsolidacao = 500;
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, cresceExatamente(2_601));            // 2.000 + 100 + 500 + 1
    expect(onDisk("backend/01-api.md")).toBe(API);              // disco INTACTO
    expect(String(run!.last_error)).toContain("EMPRESTOU 500 chars");
    expect(String(run!.last_error)).toContain("o limite desta rodada era 2600");
    // 🔴 GAP-70 (achado durante o próprio teste): `last_error` era cortado em 500 chars numa coluna
    // TEXT, e o corte comia a explicação do GAP-37 — a parte ACIONÁVEL, no único lugar onde o humano
    // lê por que a rodada paga foi jogada fora. As duas partes têm de caber juntas.
    expect(String(run!.last_error)).toContain("A rodada pediu DUAS coisas");
    expect(String(run!.last_error)).not.toMatch(/era 26$/);      // nada cortado no meio da frase
  });

  it("🔴 GAP-70 — com a graça DESLIGADA a recusa não inventa empréstimo nenhum", async () => {
    // Kill-switch: `SPEC_ORACLE_CONSOLIDATION_GRACE=0`. Com um número só em vez de `{pool,left}`, esta
    // recusa acusaria rodadas anteriores de ter gasto uma graça que nunca existiu.
    gracaDeConsolidacao = 0;
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, cresceExatamente(2_101));
    expect(String(run!.last_error)).toContain("consolidação recusada");
    expect(String(run!.last_error)).not.toContain("graça");
  });

  it("arquivo que REDECLARA, encolhe e cita o oráculo → aplica normalmente", async () => {
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    // A redeclaração sai e fica a citação: encolheu (dentro do teto de 30% do MIN_SHRINK_RATIO).
    const consolidado = `${API.slice(0, Math.round(API.length * 0.85))}\n## 6. Paginação\nver \`00-indice.md\` — fonte única deste contrato.\n`;
    await ctoReturns(r.id, consolidado);
    expect(onDisk("backend/01-api.md")).toBe(consolidado);
    expect(run!.status).toBe("pending");
  });

  it("crescimento PEQUENO passa (a mesma rodada resolve outros GAPs do arquivo)", async () => {
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    const pequeno = `${API}\n## 6. Paginação\nver \`00-indice.md\`.\n`;
    expect(pequeno.length - API.length).toBeLessThan(2000);
    await ctoReturns(r.id, pequeno);
    expect(onDisk("backend/01-api.md")).toBe(pequeno);
  });

  it("sem citar o oráculo e sem encolher → não houve consolidação (mesmo dentro do orçamento)", async () => {
    decideOraculo();
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz por escopo.\n`);
    expect(onDisk("backend/01-api.md")).toBe(API);
    expect(String(run!.last_error)).toContain("não cita o oráculo");
  });

  it("arquivo que É o oráculo (ou sem papel) segue sem veto — zero regressão", async () => {
    // O índice é o oráculo; o veto é só de quem redeclara.
    oracleDecisions = [{
      contractKey: "paginacao", oraclePath: "backend/01-api.md",
      ruleSummary: "page/pageSize", restatedIn: ["00-indice.md"],
    }];
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    const crescido = `${API}\n## 6. Paginação\n${"regra canônica. ".repeat(300)}\n`;
    await ctoReturns(r.id, crescido);
    expect(onDisk("backend/01-api.md")).toBe(crescido);
  });

  it("flag OFF → nenhum veto (kill-switch sem deploy)", async () => {
    decideOraculo();
    oracleRegistryOn = false;
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    const crescido = `${API}\n## 6. Fonte única\n${"texto normativo. ".repeat(300)}\n`;
    await ctoReturns(r.id, crescido);
    expect(onDisk("backend/01-api.md")).toBe(crescido);
  });
});

// ── 8. feature dos DESENHOS: a arquitetura fechada vira diagramas Mermaid ─────

/**
 * Feature pedida pelo Jean em 2026-09-08, verbatim: *"depois que fechar o modelo de arquitetura
 * devemos criar um arquivo md com no minimo 3 desenhos mermaid de arquiteturas, ex: modelo global,
 * APIs, infra; o objetivo é que usuario tenha desenhos que facilite o entendimento de como será na
 * pratica suas aplicacoes e infra."*
 *
 * O que estes casos travam:
 *   • QUANDO desenha: só nos dois instantes em que a arquitetura FECHA (zero GAP importante) — antes
 *     disso o desenho retrataria uma arquitetura que ainda mudava;
 *   • COM O QUE desenha: a spec INTEIRA montada pelo assembler da validação (é a lição do GAP-54:
 *     quem desenha a arquitetura tem de RECEBER a arquitetura);
 *   • o desfecho NUNCA piora o veredicto de uma spec que convergiu — veto, truncamento ou CTO calado
 *     terminam a run em `succeeded` com o motivo declarado, e não somam `file_failures` (que é o que
 *     transformaria uma spec fechada em `stalled` por causa de uma figura);
 *   • UMA tentativa por run; arquivo que já existe não é recriado (GAP-5).
 */
describe("feature dos DESENHOS — arquitetura fechada vira diagramas Mermaid", () => {
  const DIAGRAMAS = "arquitetura-diagramas.md";
  /** Três recortes diferentes, três tipos diferentes: o que o veto de `specDiagrams` aprova. */
  const DESENHOS = [
    "# Arquitetura do NVX LastMile — desenhos", "",
    "## Modelo global", "",
    "```mermaid", "flowchart LR", '  APP["App"] --> API["API"]', "```", "",
    "## APIs", "",
    "```mermaid", "sequenceDiagram", "  participant App", "  App->>API: POST /entregas", "```", "",
    "## Infraestrutura", "",
    "```mermaid", "graph TD", '  ALB["ALB"] --> ECS["ECS"]', "```", "",
  ].join("\n");
  /** Dois desenhos: cumpre a forma e não cumpre o mínimo que o Jean pediu. */
  const SO_DOIS = DESENHOS.split("## Infraestrutura")[0];

  function diagramsCall(): { specText: string; projectTitle: string; userMessage: string } {
    return (dispatchDiagramsJob.mock.calls[0] as unknown as unknown[])[0] as never;
  }
  function desenhosNoDisco(): string {
    return readFileSync(join(root, PROJECT, DIAGRAMAS), "utf-8");
  }

  beforeEach(() => {
    process.env.UPLOAD_DIR = root;             // o laço cria o arquivo DE VERDADE
    dispatchDiagramsJob.mockClear().mockResolvedValue({ ok: true as const });
    especLegivel = true;
  });
  afterEach(() => { delete process.env.UPLOAD_DIR; });

  /** Fecha a arquitetura pelo tick da FILA: um arquivo revisado e nenhum GAP importante sobrando. */
  async function fechaPelaFila(): Promise<{ id: string }> {
    const r = await start();
    await advanceAutonomyRun(db, r.id);                          // 1º arquivo da fila
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz por escopo.\n`);
    findings = [];                                              // o CTO fechou o que havia
    await advanceAutonomyRun(db, r.id);                         // tick da fila: 0 GAP importante
    return r;
  }
  /** Fecha pela VALIDAÇÃO — o caminho normal de chegada em prod (a fila esvazia e o passe valida). */
  async function fechaPelaValidacao(): Promise<{ id: string }> {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz.\n`);
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${WEB}\n## 5. Aceite\nCritérios objetivos.\n`);
    await advanceAutonomyRun(db, r.id);                         // fila vazia → valida o passe
    expect(run!.status).toBe("validating");
    findings = [];                                              // a validação não achou GAP importante
    latestRunId = "run-1";
    await advanceAutonomyRun(db, r.id);                         // colhe a validação
    return r;
  }

  it("a arquitetura fechou → pede os desenhos com a spec INTEIRA como insumo", async () => {
    const r = await fechaPelaFila();
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1);
    expect(run!.status).toBe("cto_running");
    expect(run!.current_file).toBe(DIAGRAMAS);
    const arg = diagramsCall();
    expect(arg.projectTitle).toBe(TITULO);
    // GAP-54: o inventário declara os 3 arquivos e o conteúdo vai integral — não um recorte silencioso.
    expect(arg.specText).toContain("[INVENTÁRIO DA SPEC — 3 arquivo(s)");
    expect(arg.specText).toContain("backend/01-api.md");
    expect(arg.specText).toContain("frontend/01-web.md");
    expect(arg.specText).toContain("Frontend Web conteúdo 1.");
    expect(arg.userMessage).toContain(DIAGRAMAS);
    const round = (run!.rounds as Record<string, unknown>[]).at(-1)!;
    expect(round.diagramsCreation).toBe(true);
    expect(round.filePath).toBe(DIAGRAMAS);
    expect(String(round.note)).toContain("Arquitetura fechada");
    expect(r.id).toBeTruthy();
  });

  it("o caminho NORMAL (fecha na validação do passe) também desenha", async () => {
    await fechaPelaValidacao();
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1);
    expect(run!.status).toBe("cto_running");
    expect(String(JSON.stringify(run!.rounds))).toContain("\"diagramsCreation\":true");
  });

  it("aprovado pelo veto → arquivo CRIADO, registrado na árvore e a run encerra em SUCESSO", async () => {
    const r = await fechaPelaFila();
    await ctoReturns(r.id, DESENHOS);
    expect(desenhosNoDisco()).toContain("```mermaid");
    expect(desenhosNoDisco().match(/```mermaid/g)).toHaveLength(3);
    expect(sqlLog.some((q) => q.sql.startsWith("INSERT INTO project_spec_files")
      && (q.params as unknown[])[1] === DIAGRAMAS)).toBe(true);
    expect(run!.status).toBe("succeeded");
    expect(String(run!.last_error)).toContain("arquitetura foi DESENHADA");
    expect(String(run!.last_error)).toContain("flowchart, sequenceDiagram, graph");
    const round = (run!.rounds as Record<string, unknown>[]).at(-1)!;
    expect(round.applied).toBe(true);
    expect(String(round.note)).toContain("CRIADO");
    // os arquivos da spec ficam byte a byte intactos: a rodada dos desenhos não edita spec.
    expect(onDisk("frontend/01-web.md")).toBe(WEB);
    expect(onDisk("00-indice.md")).toBe(INDEX);
  });

  it("🔴 veto (2 desenhos) → NÃO cria o arquivo, e a spec convergida continua SUCESSO", async () => {
    const r = await fechaPelaFila();
    await ctoReturns(r.id, SO_DOIS);
    expect(() => desenhosNoDisco()).toThrow();                  // nada escrito
    expect(run!.status).toBe("succeeded");                      // o veredicto da spec não piora
    expect(run!.file_failures).toBe(0);                         // e não é "falha de arquivo"
    expect(String(run!.last_error)).toContain("TOO_FEW");
    expect(String(run!.last_error)).toContain("A spec no disco está íntegra");
    expect(String(JSON.stringify(run!.rounds))).toContain("TOO_FEW");
  });

  it("🔴 documento truncado no teto de saída → recusa declarada, run em SUCESSO", async () => {
    const r = await fechaPelaFila();
    await ctoReturns(r.id, `${DESENHOS}\n## Quarto`, { truncated: true });
    expect(() => desenhosNoDisco()).toThrow();
    expect(run!.status).toBe("succeeded");
    expect(String(run!.last_error)).toContain("truncado");
  });

  it("🔴 o arquiteto não entregou (erro do job) → SUCESSO com o motivo, nunca `stalled`", async () => {
    const r = await fechaPelaFila();
    await ctoReturns(r.id, null, { status: "error", error: "429 do provedor" });
    expect(run!.status).toBe("succeeded");                      // não é falha de arquivo
    expect(run!.file_failures).toBe(0);
    expect(String(run!.last_error)).toContain("429 do provedor");
    expect(String(run!.last_error)).toContain("NÃO foram criados");
  });

  it("o arquivo de desenhos que JÁ existe não é recriado (GAP-5) — zero regressão", async () => {
    makeTree([
      { path: "00-indice.md", content: INDEX, isPrimary: true },
      { path: "backend/01-api.md", content: API },
      { path: DIAGRAMAS, content: DESENHOS },
    ]);
    process.env.UPLOAD_DIR = root;
    findings = [gap("backend/01-api.md", "blocker", "sem authz")];
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz.\n`);
    findings = [];
    await advanceAutonomyRun(db, r.id);
    expect(dispatchDiagramsJob).not.toHaveBeenCalled();
    expect(run!.status).toBe("succeeded");
    expect(String(run!.last_error)).toContain("Nenhum GAP vermelho ou amarelo ATIVO restante");
    expect(r.id).toBeTruthy();
  });

  it("UMA tentativa por run: se o PEDIDO falhar, o próximo tick encerra sem pedir de novo", async () => {
    dispatchDiagramsJob.mockRejectedValueOnce(new Error("agents fora do ar"));
    const r = await fechaPelaFila();
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1);
    expect(run!.status).toBe("pending");                        // voltou de onde saiu
    expect(String(JSON.stringify(run!.rounds))).toContain("não pedi os diagramas");
    await advanceAutonomyRun(db, r.id);                         // 2º tick com 0 GAP importante
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1);       // NÃO tenta de novo
    expect(run!.status).toBe("succeeded");
  });

  it("spec ilegível no disco → encerra como encerrava antes, sem desenhar", async () => {
    especLegivel = false;
    await fechaPelaFila();
    expect(dispatchDiagramsJob).not.toHaveBeenCalled();
    expect(run!.status).toBe("succeeded");
  });

  it("sem `API_AGENTS_URL` o laço não desenha (e não trava a run convergida)", async () => {
    const r = await start();
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz.\n`);
    findings = [];
    delete process.env.API_AGENTS_URL;
    await advanceAutonomyRun(db, r.id);
    expect(dispatchDiagramsJob).not.toHaveBeenCalled();
    expect(run!.status).toBe("succeeded");
    expect(r.id).toBeTruthy();
  });

  it("modo `whole` (spec de 1 arquivo) nunca desenha — a feature é do modo por arquivo", async () => {
    makeTree([{ path: "PRODUCT_SPEC.md", content: API, isPrimary: true }]);
    process.env.UPLOAD_DIR = root;
    findings = [gap("PRODUCT_SPEC.md", "blocker", "sem authz")];
    const r = await start();
    expect(r.mode).toBe("whole");
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz.\n`);
    findings = [];
    await advanceAutonomyRun(db, r.id);
    expect(dispatchDiagramsJob).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 GAP-116 — a arquitetura fecha por VEREDICTO, não por contagem zero.
 *
 * MEDIDO: a feature dos desenhos foi para produção em `f865bc6` e NUNCA disparou uma vez. O gatilho
 * único era `gaps.important === 0`, e a spec do NVX LastMile fecha com 44 GAPs importantes — nenhum
 * impeditivo. Ou seja: o desenho que o Jean pediu era inalcançável exatamente pelo motivo que o
 * GAP-115 já tinha corrigido para o veredicto, e por isso a correção é a mesma — quem diz que a
 * arquitetura fechou é o juiz declarando a spec promovível, nos TRÊS fins de laço.
 *
 * O que estes casos travam:
 *   • promovível nos três fins (teto de passes na validação, teto de arquivos do passe, teto do laço)
 *     → desenha, e a run segue viva em vez de encerrar;
 *   • NÃO promovível → não desenha nada e o desfecho é o de antes (a barra não caiu: quem decide é o
 *     juiz, não a ausência de GAP);
 *   • o log DECLARA qual dos dois fechamentos ocorreu — dizer "0 GAP importante" com 44 em aberto
 *     seria o fechamento fake que o Jean proibiu.
 */
describe("🔴 GAP-116 — arquitetura promovível pelo juiz também vira desenho", () => {
  const DIAGRAMAS = "arquitetura-diagramas.md";

  beforeEach(() => {
    process.env.UPLOAD_DIR = root;
    dispatchDiagramsJob.mockClear().mockResolvedValue({ ok: true as const });
    especLegivel = true;
    // O juiz declara PROMOVÍVEL com GAP importante em aberto: é o desfecho real da spec do NVX.
    veredicto = { candidates: 2, released: 1, impeditive: 0, promotable: true };
  });
  afterEach(() => { delete process.env.UPLOAD_DIR; });

  /** Roda o passe inteiro até a validação (cópia local do helper dos tetos). */
  async function drainPass(runId: string) {
    for (let i = 0; i < 12; i++) {
      await advanceAutonomyRun(db, runId);
      if (run!.status === "cto_running") {
        const target = String(run!.current_file);
        await ctoReturns(runId, `${onDisk(target)}\n## 99. Ajuste ${i}\nconteúdo novo do CTO.\n`);
      }
      if (run!.status === "validating" || isTerminalAutonomyStatus(run!.status as AutonomyStatus)) return;
    }
    throw new Error(`passe não terminou (status ${String(run!.status)})`);
  }

  /** Leva o laço ao teto de arquivos dentro de `startFileRound` (o fim de laço do GAP-115). */
  async function tetoDeArquivos(qual: "passe" | "laco") {
    const r = await start(3);
    await advanceAutonomyRun(db, r.id);
    if (qual === "passe") {
      // 🔴 GAP-117: `applied: false` é o que mantém este teto como FIM DE LAÇO (com trabalho aplicado
      // ele fecha o passe e valida) — é neste desfecho que a arquitetura pode fechar por veredicto.
      run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: false }));
    } else {
      run!.round = AUTONOMY_MAX_TOTAL_FILE_ROUNDS;
      run!.rounds = [];
    }
    run!.status = "pending";
    run!.current_file = null;
    await advanceAutonomyRun(db, r.id);
    return r;
  }

  it("teto de PASSES na validação + parecer promovível → desenha em vez de encerrar", async () => {
    const r = await start(1);
    await drainPass(r.id);
    expect(run!.status).toBe("validating");
    await advanceAutonomyRun(db, r.id);                       // mediu: GAPs em aberto, teto atingido
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1);
    expect(run!.status).toBe("cto_running");                  // a run NÃO encerrou: está desenhando
    expect(run!.current_file).toBe(DIAGRAMAS);
    expect(isTerminalAutonomyStatus(run!.status as AutonomyStatus)).toBe(false);
    expect(r.id).toBeTruthy();
  });

  it("🔴 mesmo teto, parecer NÃO promovível → não desenha e encerra como antes (a barra não caiu)", async () => {
    veredicto = { candidates: 2, released: 0, impeditive: 2, promotable: false };
    const r = await start(1);
    await drainPass(r.id);
    await advanceAutonomyRun(db, r.id);
    expect(dispatchDiagramsJob).not.toHaveBeenCalled();
    expect(run!.status).toBe("exhausted");
    expect(String(run!.last_error)).toContain("NÃO promovível");
    expect(r.id).toBeTruthy();
  });

  it("teto de ARQUIVOS do passe + parecer promovível → desenha", async () => {
    await tetoDeArquivos("passe");
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1);
    expect(run!.status).toBe("cto_running");
    expect(run!.current_file).toBe(DIAGRAMAS);
  });

  it("teto do LAÇO (o desfecho da run `10b1a4e1`) + parecer promovível → desenha", async () => {
    await tetoDeArquivos("laco");
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1);
    expect(run!.status).toBe("cto_running");
  });

  it("🔴 teto de arquivos com parecer NÃO promovível → encerra `exhausted`, sem desenho", async () => {
    veredicto = { candidates: 1, released: 0, impeditive: 1, promotable: false };
    await tetoDeArquivos("laco");
    expect(dispatchDiagramsJob).not.toHaveBeenCalled();
    expect(run!.status).toBe("exhausted");
  });

  it("🔴 o log declara QUAL fechamento ocorreu — nunca \"0 GAP importante\" com GAPs em aberto", async () => {
    await tetoDeArquivos("laco");
    const round = (run!.rounds as Record<string, unknown>[]).at(-1)!;
    expect(round.diagramsCreation).toBe(true);
    const nota = String(round.note);
    expect(nota).toContain("Arquitetura fechada");
    expect(nota).toContain("julgados NÃO-impeditivos pelo juiz");
    expect(nota).not.toContain("0 GAP importante");
    expect(Number(round.gapsBefore)).toBeGreaterThan(0);      // e a contagem real vai no log
  });

  it("veredicto desligado (fail-CLOSED) no teto → nada de desenho por contagem", async () => {
    veredicto = null;
    await tetoDeArquivos("laco");
    expect(dispatchDiagramsJob).not.toHaveBeenCalled();
    expect(run!.status).toBe("exhausted");
  });
});

/**
 * 🔴 GAP-125 — o DESENHO não muda o veredicto da run: nem o status, nem o texto.
 *
 * O GAP-116 abriu três gatilhos novos para a rodada de desenhos (juiz declarando promovível nos três
 * fins de laço), e todos chegam ao `applyDiagramsRound` com `gaps.important > 0` **por construção** —
 * o caminho de contagem zero já retornou antes. Mas o encerramento era fixo: `succeeded` com o texto
 * *"Nenhum GAP vermelho ou amarelo ATIVO restante"*. Ou seja, bastava a figura existir para uma run
 * `exhausted` com 44 GAPs abertos virar sucesso afirmando zero — e o parecer do juiz (`v.note`) e o
 * motivo do esgotamento eram descartados no caminho. O log mentiroso do GAP-45/46 em cima da feature
 * que o Jean pediu, e invisível até aqui porque o GAP-124 mantinha o gatilho inalcançável.
 *
 * A suíte do GAP-116 acima cobria o DESPACHO e não o ENCERRAMENTO: era o ponto cego que sustentou o
 * defeito. Estes casos travam o encerramento nos dois desfechos (desenho aprovado e recusado).
 */
describe("🔴 GAP-125 — o desenho não promove `exhausted` a `succeeded` nem afirma zero GAP", () => {
  const DIAGRAMAS = "arquitetura-diagramas.md";
  const ZERO_GAP = "Nenhum GAP vermelho ou amarelo ATIVO restante";
  const DESENHOS = [
    "# Arquitetura — desenhos", "",
    "## Modelo global", "", "```mermaid", "flowchart LR", '  A["App"] --> B["API"]', "```", "",
    "## APIs", "", "```mermaid", "sequenceDiagram", "  participant App", "  App->>API: POST /x", "```", "",
    "## Infraestrutura", "", "```mermaid", "graph TD", '  ALB["ALB"] --> ECS["ECS"]', "```", "",
  ].join("\n");
  /** Dois desenhos: o veto recusa por não cumprir o mínimo pedido pelo Jean. */
  const SO_DOIS = DESENHOS.split("## Infraestrutura")[0];

  beforeEach(() => {
    process.env.UPLOAD_DIR = root;
    dispatchDiagramsJob.mockClear().mockResolvedValue({ ok: true as const });
    especLegivel = true;
    veredicto = { candidates: 2, released: 1, impeditive: 0, promotable: true };
  });
  afterEach(() => { delete process.env.UPLOAD_DIR; });

  /** Teto TOTAL de arquivos com parecer promovível — o fim de laço da run `10b1a4e1`. */
  async function desenhaPeloTeto(): Promise<{ id: string }> {
    const r = await start(3);
    await advanceAutonomyRun(db, r.id);
    run!.round = AUTONOMY_MAX_TOTAL_FILE_ROUNDS;
    run!.rounds = [];
    run!.status = "pending";
    run!.current_file = null;
    await advanceAutonomyRun(db, r.id);
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1);
    expect(run!.current_file).toBe(DIAGRAMAS);
    return r;
  }

  it("o pedido carrega o DESFECHO da run (status + texto), não só o fato de estar desenhando", async () => {
    await desenhaPeloTeto();
    const round = (run!.rounds as Record<string, unknown>[]).at(-1)!;
    expect(round.diagramsEndStatus).toBe("exhausted");
    expect(String(round.diagramsClosing)).toContain("Teto de");
    expect(String(round.diagramsClosing)).toContain("PROMOVÍVEL");
    expect(String(round.diagramsClosing)).not.toContain(ZERO_GAP);
  });

  it("desenho APROVADO com GAPs em aberto → run `exhausted`, e o texto NÃO afirma zero GAP", async () => {
    const r = await desenhaPeloTeto();
    await ctoReturns(r.id, DESENHOS);
    expect(readFileSync(join(root, PROJECT, DIAGRAMAS), "utf-8")).toContain("```mermaid");
    // O desenho existe E o veredicto da run é o que era: nada de sucesso por figura.
    expect(run!.status).toBe("exhausted");
    expect(String(run!.last_error)).toContain("arquitetura foi DESENHADA");
    expect(String(run!.last_error)).toContain("Teto de");
    expect(String(run!.last_error)).toContain("PROMOVÍVEL");   // o parecer do juiz sobrevive
    expect(String(run!.last_error)).not.toContain(ZERO_GAP);
  });

  it("desenho RECUSADO pelo veto → mesmo status e mesmo texto de estado, com o motivo declarado", async () => {
    const r = await desenhaPeloTeto();
    await ctoReturns(r.id, SO_DOIS);
    expect(() => readFileSync(join(root, PROJECT, DIAGRAMAS), "utf-8")).toThrow();
    expect(run!.status).toBe("exhausted");
    expect(run!.file_failures).toBe(0);                        // recusa de figura não é falha de arquivo
    expect(String(run!.last_error)).toContain("TOO_FEW");
    expect(String(run!.last_error)).toContain("Teto de");
    expect(String(run!.last_error)).not.toContain(ZERO_GAP);
  });

  it("pedido SEM desfecho gravado (rodada anterior ao GAP-125) → o estado sai da MEDIÇÃO, não de texto fixo", async () => {
    const r = await desenhaPeloTeto();
    // Simula o log de uma run que já estava em voo quando o conserto subiu.
    const rounds = run!.rounds as Record<string, unknown>[];
    delete rounds.at(-1)!.diagramsClosing;
    delete rounds.at(-1)!.diagramsEndStatus;
    await ctoReturns(r.id, DESENHOS);
    expect(run!.status).toBe("exhausted");                     // GAPs medidos > 0 ⇒ nunca `succeeded`
    expect(String(run!.last_error)).toContain("seguem em aberto");
    expect(String(run!.last_error)).not.toContain(ZERO_GAP);
  });
});

/**
 * 🔴 C4 (D5) — "zero GAP" só pode ser dito sobre 100% da spec, em QUALQUER ponto de saída do laço.
 *
 * O tick `validating` aplica esta regra desde o GAP-19. Os ticks `pending` (fila por arquivo) e `whole`
 * NÃO aplicavam: eles declaravam `succeeded` no instante em que `gaps.important === 0`, sem olhar a
 * cobertura ACUMULADA — e o laço chega ao `pending` logo depois de uma validação que pode ter lido 2 de
 * 12 arquivos (medido em prod, run `b78d0c88`). "Zero" ali significava "zero no pedaço que alguém olhou",
 * que é o fechamento fake que o Jean proibiu.
 */
describe("C4 — nenhum desfecho de sucesso com cobertura acumulada incompleta", () => {
  /** As notas que o laço escreveu no chat da Bancada. */
  function notas(): string[] {
    return sqlLog
      .filter((q) => q.sql.startsWith("INSERT INTO spec_chat_messages"))
      .map((q) => String((q.params as unknown[])[2]));
  }
  beforeEach(() => {
    process.env.UPLOAD_DIR = root;
    // A feature dos DESENHOS é o desfecho normal de "arquitetura fechada": aqui ela é o TERMÔMETRO de
    // que o laço seguiu para o sucesso. Sem limpar o espião, as chamadas somam entre casos.
    dispatchDiagramsJob.mockClear().mockResolvedValue({ ok: true as const });
    especLegivel = true;
  });
  afterEach(() => { delete process.env.UPLOAD_DIR; });

  /** Leva o laço por arquivo até o tick `pending` com ZERO GAP importante. */
  async function zeroGapNoTickDaFila(): Promise<{ id: string }> {
    const r = await start();
    await advanceAutonomyRun(db, r.id);                       // 1º arquivo da fila
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz por escopo.\n`);
    findings = [];                                            // o CTO fechou o que havia
    await advanceAutonomyRun(db, r.id);                       // tick da fila: 0 GAP importante
    return r;
  }

  it("cobertura não rastreada (`null`) → comportamento LEGADO, sem freio nenhum", async () => {
    // `trackedCoverageState` devolve `null` quando não há run terminal com cobertura neste conteúdo
    // (regra do GAP-21: não invento cobertura que não medi). Aqui o laço segue como sempre seguiu.
    coberturaAcumulada = null;
    const r = await zeroGapNoTickDaFila();
    expect(startValidation).not.toHaveBeenCalled();
    expect(notas().some((n) => n.includes("Não declaro a spec validada"))).toBe(false);
    expect(r.id).toBeTruthy();
  });

  it("cobertura COMPLETA → segue para o desfecho de sucesso (nada muda para a spec coberta)", async () => {
    coberturaAcumulada = { unjudged: [], judged: 3, total: 3 };
    await zeroGapNoTickDaFila();
    expect(startValidation).not.toHaveBeenCalled();
    // O desfecho é o da feature dos desenhos (arquitetura fechada) — o freio não interfere nele.
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1);
  });

  it("🔴 arquivo NUNCA julgado por inteiro → NÃO declara sucesso: volta a validar o que falta", async () => {
    coberturaAcumulada = { unjudged: ["frontend/01-web.md"], judged: 2, total: 3 };
    await zeroGapNoTickDaFila();
    expect(run!.status).toBe("validating");
    expect(run!.passes).toBe(1);                       // gasta um passe: é o que garante terminação
    expect(startValidation).toHaveBeenCalledTimes(1);  // valida o que falta ANTES de qualquer desfecho
    expect(dispatchDiagramsJob).not.toHaveBeenCalled(); // nem desenha uma arquitetura não julgada
    const nota = notas().find((n) => n.includes("Não declaro a spec validada"));
    expect(nota).toBeTruthy();
    expect(nota).toContain("1 de 3 arquivo(s)");
    expect(nota).toContain("`frontend/01-web.md`");
  });

  it("🔴 o freio não pode ser laço infinito: cada passagem gasta um passe até o teto do Jean", async () => {
    // Com `maxRounds = 1` o passe seguinte cai no teto do próprio tick da fila, que encerra
    // `exhausted` — nunca `succeeded`. É assim que o freio termina sem prometer perfeição.
    coberturaAcumulada = { unjudged: ["frontend/01-web.md"], judged: 2, total: 3 };
    const r = await start(1);
    await advanceAutonomyRun(db, r.id);
    await ctoReturns(r.id, `${API}\n## 6. Segurança\nauthz.\n`);
    findings = [];
    await advanceAutonomyRun(db, r.id);               // freio: passes 0 → 1, status validating
    expect(run!.status).toBe("validating");
    expect(run!.passes).toBe(1);
    // A validação volta sem GAP e a cobertura SEGUE incompleta: o tick da fila agora está no teto.
    latestRunId = "run-1";
    await advanceAutonomyRun(db, r.id);               // colhe a validação → pending
    if (run!.status === "pending") await advanceAutonomyRun(db, r.id);
    expect(run!.status).not.toBe("succeeded");
    expect(isTerminalAutonomyStatus(run!.status as AutonomyStatus)).toBe(true);
  });

  it("🔴 o que falta é arquivo que não cabe nem sozinho → segue, mas o fato vai DECLARADO no chat", async () => {
    // `oversized` (GAP-19): rotação nenhuma cobre, e dividir o arquivo é decisão do humano. Encerrar em
    // silêncio aqui seria dizer "spec sem GAP" sobre um arquivo que juiz nenhum leu.
    coberturaAcumulada = { unjudged: ["backend/01-api.md"], judged: 2, total: 3 };
    coberturaDaUltimaRun = { full: ["00-indice.md"], outlineOnly: ["backend/01-api.md"], oversized: ["backend/01-api.md"] };
    await zeroGapNoTickDaFila();
    expect(startValidation).not.toHaveBeenCalled();     // revalidar não cobriria: é impossível por construção
    const nota = notas().find((n) => n.includes("não cabem numa janela de validação"));
    expect(nota).toBeTruthy();
    expect(nota).toContain("`backend/01-api.md`");
    expect(nota).toContain("Dividir");
    expect(dispatchDiagramsJob).toHaveBeenCalledTimes(1); // o laço não fica preso no que não pode cobrir
  });

  it("modo `whole` (spec de 1 arquivo) tem o MESMO freio — a regra é do desfecho, não do modo", async () => {
    run = null;
    makeTree([{ path: "PRODUCT_SPEC.md", content: API, isPrimary: true }]);
    findings = [gap("PRODUCT_SPEC.md", "blocker", "sem authz")];
    const r = await start();                           // o laço só começa com GAP importante em aberto
    findings = [];                                     // e o humano fechou o GAP antes do 1º tick
    coberturaAcumulada = { unjudged: ["PRODUCT_SPEC.md"], judged: 0, total: 1 };
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("validating");
    expect(run!.round).toBe(1);                        // no modo `whole` o contador é a RODADA
    expect(startValidation).toHaveBeenCalledTimes(1);
    expect(r.id).toBeTruthy();
  });

  it("falha ao medir a cobertura não derruba o laço (degrada para o comportamento legado)", async () => {
    // O freio é uma GUARDA, não a função do laço: se a medição quebrar, o desfecho volta a ser o de
    // antes do C4 — nunca um erro novo em cima de uma spec que convergiu.
    const { trackedCoverageState } = await import("./specValidation.js") as unknown as Record<string, unknown>;
    expect(typeof trackedCoverageState).toBe("function");
    coberturaAcumulada = null;
    await zeroGapNoTickDaFila();
    expect(run!.status).not.toBe("failed");
  });
});
