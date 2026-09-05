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
vi.mock("./findingTriage.js", () => ({
  projectFindingsState: vi.fn(async () => ({ latestRunId, findings, resolved: [], counts: {} })),
}));

const startValidation = vi.fn(async () => ({ ok: true as const, runId: "vr-1", reused: false }));
vi.mock("./specValidation.js", () => ({ startValidation: (...a: unknown[]) => startValidation(...(a as [])) }));

// `truncated` (T1) chega do runtime via `spec_chat_jobs.truncated` — é o sinal que o laço consulta.
let job: { status: string; specMarkdown: string | null; error: string | null; truncated?: boolean } | null = null;
vi.mock("./specChatJobs.js", () => ({ getSpecChatJob: vi.fn(async () => job) }));

const dispatchResolveGapsJob = vi.fn(async () => ({ ok: true as const, gaps: 3 }));
vi.mock("../routes/specChat.js", () => ({ dispatchResolveGapsJob: (...a: unknown[]) => dispatchResolveGapsJob(...(a as [])) }));

vi.mock("./tenantLlmConfig.js", () => ({
  resolveWorkbenchLlm: vi.fn(async () => ({})),
  agentsLlmFields: vi.fn(() => ({})),
}));

vi.mock("./projectStatus.js", () => ({ SPEC_EDITABLE_STATUSES: new Set(["draft", "spec_submitted"]) }));

import {
  tallyGaps, autonomyEnabled, AUTONOMY_MAX_ROUNDS, startAutonomyRun, advanceAutonomyRun,
  isTerminalAutonomyStatus, assessRevisionIntegrity, type AutonomyStatus,
} from "./specAutonomy.js";

// ── banco falso: uma linha de spec_autonomy_runs em memória ───────────────────
interface FakeRow { [k: string]: unknown }
let run: FakeRow | null = null;
let projectStatus = "draft";
let specPath = "";
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
    if (s.startsWith("SELECT status FROM projects")) return { rows: [{ status: projectStatus }], rowCount: 1 };
    if (s.startsWith("UPDATE project_spec_files") || s.startsWith("UPDATE projects")) return { rows: [], rowCount: 1 };
    if (s.startsWith("INSERT INTO spec_chat_messages")) return { rows: [], rowCount: 1 };

    if (s.startsWith("SELECT status FROM spec_validation_runs")) {
      return { rows: [{ status: validationStatus }], rowCount: 1 };
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

function writeSpec(content: string): void {
  const dir = mkdtempSync(join(tmpdir(), "spec-autonomy-"));
  specPath = join(dir, "PRODUCT_SPEC.md");
  writeFileSync(specPath, content, "utf-8");
}

const BASE_SPEC = "# Spec\n\n" + "conteúdo relevante da spec do produto. ".repeat(200);

beforeEach(() => {
  run = null;
  job = null;
  projectStatus = "draft";
  latestRunId = "run-0";
  validationStatus = "passed";
  insertFails23505 = false;
  snapshotFails = false;
  sqlLog.length = 0;
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

  it("validação em 'superseded' não conta como progresso e o laço reporta", async () => {
    const r = await reachValidating(5);
    validationStatus = "superseded";
    await advanceAutonomyRun(db, r.id);
    expect(run!.status).toBe("pending");
    expect(run!.no_progress_streak).toBe(1);
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
