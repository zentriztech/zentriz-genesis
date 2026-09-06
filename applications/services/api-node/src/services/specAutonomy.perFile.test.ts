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
type F = { file: string; severity: string; title: string; fingerprint: string };
let findings: F[] = [];
let latestRunId: string | null = "run-0";
vi.mock("./findingTriage.js", () => ({
  projectFindingsState: vi.fn(async () => ({ latestRunId, findings, resolved: [], counts: {} })),
}));

// `specGapScope` real alcança `routes/specs.js` → `db/client.js` (pool de verdade). Aqui ele é
// dublado: o que este arquivo testa é a FILA do laço, não o roteador (que tem suíte própria).
let unroutedFindings: F[] = [];
vi.mock("./specGapScope.js", () => ({
  loadSpecFiles: vi.fn(async () => tree),
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

const startValidation = vi.fn(async () => ({ ok: true as const, runId: "vr-1", reused: false }));
// GAP-19: a pendência de cobertura é ACUMULADA (`stage_b_full_sha` × sha atual) e vem daqui —
// `coberturaAcumulada = null` reproduz "não foi possível medir" (comportamento legado).
let coberturaAcumulada: { unjudged: string[]; judged: number; total: number } | null = null;
vi.mock("./specValidation.js", () => ({
  startValidation: (...a: unknown[]) => startValidation(...(a as [])),
  unjudgedSpecFiles: async () => coberturaAcumulada,
}));

let job: { status: string; specMarkdown: string | null; error: string | null; truncated?: boolean } | null = null;
vi.mock("./specChatJobs.js", () => ({ getSpecChatJob: vi.fn(async () => job) }));

const dispatchResolveGapsJob = vi.fn(async () => ({ ok: true as const, gaps: 3 }));
const dispatchGapFileJob = vi.fn(async () => ({ ok: true as const, gaps: 2 }) as unknown);
const dispatchManifestJob = vi.fn(async () => ({ ok: true as const }));
vi.mock("../routes/specChat.js", () => ({
  dispatchResolveGapsJob: (...a: unknown[]) => dispatchResolveGapsJob(...(a as [])),
  dispatchGapFileJob: (...a: unknown[]) => dispatchGapFileJob(...(a as [])),
  dispatchManifestJob: (...a: unknown[]) => dispatchManifestJob(...(a as [])),
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
    if (s.startsWith("UPDATE project_spec_files") || s.startsWith("UPDATE projects")) return { rows: [], rowCount: 1 };
    if (s.startsWith("INSERT INTO spec_chat_messages")) return { rows: [], rowCount: 1 };
    if (s.startsWith("SELECT status, stage_b_ran, stage_b_coverage FROM spec_validation_runs")) {
      // GAP-13 (migração 099): `true` = validação COMPLETA — é o caso destes testes.
      // GAP-18 (migração 101): cobertura NULL = run legada → gate de cobertura não interfere.
      return { rows: [{ status: validationStatus, stage_b_ran: true, stage_b_coverage: null }], rowCount: 1 };
    }
    if (s.startsWith("SELECT stage_b_coverage FROM spec_validation_runs")) return { rows: [], rowCount: 0 };

    if (s.startsWith("INSERT INTO spec_autonomy_runs")) {
      run = {
        id: values[0], project_id: values[1], tenant_id: values[2], owner_user_id: values[3],
        status: "pending", round: 0, max_rounds: values[4], chat_job_id: null, validation_run_id: null,
        base_spec_sha: null, gaps_initial: values[5], gaps_current: values[5], no_progress_streak: 0,
        rounds: [], last_error: null, deadline_at: new Date(Date.now() + 3.6e6).toISOString(),
        created_at: nowIso(), updated_at: nowIso(), finished_at: null,
        // migração 095
        mode: values[7], passes: 0, current_file: null, files_done: [], file_failures: 0,
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
      if (/files_done = '\[\]'::jsonb/.test(s)) run.files_done = [];
      const mDone = s.match(/files_done = files_done \|\| \$(\d+)::jsonb/);
      if (mDone) {
        run.files_done = [...(run.files_done as unknown[]), ...JSON.parse(values[Number(mDone[1]) - 1] as string)];
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

const INDEX = body("Índice", 2);
const API = body("Backend API", 5);
const WEB = body("Frontend Web", 4);

function gap(file: string, severity: string, title: string): F {
  return { file, severity, title, fingerprint: `${file}:${severity}:${title}` };
}

beforeEach(() => {
  run = null;
  job = null;
  projectStatus = "draft";
  latestRunId = "run-0";
  validationStatus = "passed";
  coberturaAcumulada = null;
  snapshotFails = false;
  sqlLog.length = 0;
  unroutedFindings = [];
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
function fileCalls(): Array<{ filePath: string; findings: F[]; fileContent: string; userMessage: string }> {
  return dispatchGapFileJob.mock.calls.map((c) => (c as unknown as unknown[])[0] as never);
}
function lastFileCall(): { filePath: string; findings: F[]; fileContent: string; userMessage: string } {
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
    // 12 rodadas já gastas NESTE passe → a próxima não sai, e a mensagem diz "neste passe".
    run!.rounds = Array.from({ length: AUTONOMY_MAX_FILE_ROUNDS }, (_, i) => ({ round: i + 1, pass: 0, applied: true }));
    run!.status = "pending";
    run!.current_file = null;
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("exhausted");
    expect(String(run!.last_error)).toContain("neste passe");
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
