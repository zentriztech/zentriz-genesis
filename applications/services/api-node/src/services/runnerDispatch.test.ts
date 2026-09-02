/**
 * runnerDispatch.test.ts — dispatch endurecido (RFC-0003, Task 3):
 * gate de dependência + claim atômico de slot + revert em falha.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Gate e claim são isolados por mock — aqui validamos a ORQUESTRAÇÃO do dispatch.
const gateResult = { current: { ok: true } as { ok: boolean; block?: { code: string; message: string } } };
vi.mock("./dependencyGate.js", () => ({
  checkDependencyGate: async () => gateResult.current,
}));

const claimResult = { current: { outcome: "started", previousStatus: "draft" } as { outcome: string; previousStatus: string | null } };
const revertSpy = vi.fn(async (_projectId: string, _previousStatus: string | null) => {});
const claimSpy = vi.fn(async (_projectId: string, _tenantId: string) => claimResult.current);
vi.mock("./tenantLlmConfig.js", () => ({
  claimSlotOrQueue: (projectId: string, tenantId: string) => claimSpy(projectId, tenantId),
  revertSlotClaim: (projectId: string, previousStatus: string | null) => revertSpy(projectId, previousStatus),
}));

vi.mock("../auth.js", () => ({ signToken: () => "fake.jwt.token" }));

// Cost cap por tenant (migration 068): controlável por teste; default = sem cap (ok).
const budgetResult = {
  current: { ok: true } as { ok: boolean; spentUsd?: number; budgetUsd?: number },
};
vi.mock("./tenantCostCap.js", () => ({
  checkTenantBudget: async () => budgetResult.current,
  budgetExceededMessage: (spent: number, budget: number) =>
    `gasto US$ ${spent.toFixed(2)} / teto US$ ${budget.toFixed(2)}`,
}));

// pool falso: roteia por SQL.
function makePool(target: Record<string, unknown> | undefined) {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM projects WHERE id")) return { rows: target ? [target] : [] };
      if (sql.includes("FROM project_spec_files")) return { rows: [{ file_path: "/shared/uploads/p1/spec.md" }] };
      if (sql.includes("FROM users WHERE id")) return { rows: [{ id: "u1", email: "a@b.c", role: "user" }] };
      return { rows: [] };
    },
  } as unknown as import("pg").Pool;
}

let dispatchProjectRun: typeof import("./runnerDispatch.js").dispatchProjectRun;

beforeEach(async () => {
  process.env.RUNNER_SERVICE_URL = "http://runner.local";
  process.env.RUNNER_UPLOAD_DIR = "/runner/uploads";
  process.env.UPLOAD_DIR = "/shared/uploads";
  gateResult.current = { ok: true };
  budgetResult.current = { ok: true };
  claimResult.current = { outcome: "started", previousStatus: "draft" };
  revertSpy.mockClear();
  claimSpy.mockClear();
  ({ dispatchProjectRun } = await import("./runnerDispatch.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TENANT = "11111111-1111-4111-8111-111111111111";

describe("dispatchProjectRun — Task 3", () => {
  it("gate bloqueado → não dispara, não reserva slot", async () => {
    gateResult.current = { ok: false, block: { code: "DEPENDENCY_NOT_READY", message: "aguardando" } };
    vi.stubGlobal("fetch", vi.fn());
    const pool = makePool({ id: "p1", status: "draft", created_by: "u1", tenant_id: TENANT });
    const r = await dispatchProjectRun(pool, "p1");
    expect(r.dispatched).toBe(false);
    expect(r.reason).toContain("DEPENDENCY_NOT_READY");
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("tenant acima do orçamento mensal de LLM → bloqueia sem reservar slot nem chamar runner", async () => {
    budgetResult.current = { ok: false, spentUsd: 12.5, budgetUsd: 10 };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const pool = makePool({ id: "p1", status: "draft", created_by: "u1", tenant_id: TENANT });
    const r = await dispatchProjectRun(pool, "p1");
    expect(r.dispatched).toBe(false);
    expect(r.reason).toContain("TENANT_LLM_BUDGET_EXCEEDED");
    expect(claimSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("projeto sem tenant não passa pelo gate de orçamento (mesmo com cap estourado)", async () => {
    budgetResult.current = { ok: false, spentUsd: 12.5, budgetUsd: 10 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const pool = makePool({ id: "p1", status: "draft", created_by: "u1", tenant_id: null });
    const r = await dispatchProjectRun(pool, "p1");
    expect(r.dispatched).toBe(true);
  });

  it("sem slot (claim=queued) → não dispara e reporta enfileirado", async () => {
    claimResult.current = { outcome: "queued", previousStatus: "draft" };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const pool = makePool({ id: "p1", status: "draft", created_by: "u1", tenant_id: TENANT });
    const r = await dispatchProjectRun(pool, "p1");
    expect(r.dispatched).toBe(false);
    expect(r.reason).toContain("enfileirado");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("happy path: gate ok + claim started + runner 200 → dispatched, claim chamado com tenant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const pool = makePool({ id: "p1", status: "draft", created_by: "u1", tenant_id: TENANT });
    const r = await dispatchProjectRun(pool, "p1");
    expect(r.dispatched).toBe(true);
    expect(claimSpy).toHaveBeenCalledWith("p1", TENANT);
    expect(revertSpy).not.toHaveBeenCalled();
  });

  it("runner falha (500) → reverte o claim e reporta não-disparado", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const pool = makePool({ id: "p1", status: "draft", created_by: "u1", tenant_id: TENANT });
    const r = await dispatchProjectRun(pool, "p1");
    expect(r.dispatched).toBe(false);
    expect(revertSpy).toHaveBeenCalledWith("p1", "draft");
  });

  it("exceção de rede → reverte o claim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const pool = makePool({ id: "p1", status: "draft", created_by: "u1", tenant_id: TENANT });
    const r = await dispatchProjectRun(pool, "p1");
    expect(r.dispatched).toBe(false);
    expect(revertSpy).toHaveBeenCalledWith("p1", "draft");
  });

  it("projeto sem tenant (solto) → dispara sem reservar slot por tenant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const pool = makePool({ id: "p1", status: "draft", created_by: "u1", tenant_id: null });
    const r = await dispatchProjectRun(pool, "p1");
    expect(r.dispatched).toBe(true);
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("status não elegível → não dispara", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const pool = makePool({ id: "p1", status: "running", created_by: "u1", tenant_id: TENANT });
    const r = await dispatchProjectRun(pool, "p1");
    expect(r.dispatched).toBe(false);
    expect(r.reason).toContain("não elegível");
  });
});
