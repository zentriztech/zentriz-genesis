/**
 * tenantCostCap.test.ts — cost cap mensal de LLM por tenant (migration 068).
 * Cobre: precedência tenant > plano > env; sem cap = ok; fail-open em erro de
 * infra; gasto dual-source = MAX(ledger 027, estimativa project_agent_metrics).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  checkTenantBudget,
  getTenantMonthSpendUsd,
  resolveTenantMonthlyBudgetUsd,
  budgetExceededMessage,
  type Queryable,
} from "./tenantCostCap.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

/** Pool falso roteado por SQL (mesmo padrão de dependencyGate.test.ts). */
function makeDb(opts: {
  tenantBudget?: string | null;
  planBudget?: string | null;
  ledgerUsd?: string;
  metricsUsd?: string;
  tenantRowMissing?: boolean;
}): Queryable {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM tenants t")) {
        if (opts.tenantRowMissing) return { rows: [] };
        return { rows: [{ tenant_budget: opts.tenantBudget ?? null, plan_budget: opts.planBudget ?? null }] };
      }
      if (sql.includes("pipeline_cost_ledger")) return { rows: [{ usd: opts.ledgerUsd ?? "0" }] };
      if (sql.includes("project_agent_metrics")) return { rows: [{ usd: opts.metricsUsd ?? "0" }] };
      return { rows: [] };
    },
  };
}

const savedEnv = process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT;
  else process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT = savedEnv;
  vi.restoreAllMocks();
});

describe("resolveTenantMonthlyBudgetUsd — precedência tenant > plano > env", () => {
  it("teto do tenant vence o do plano", async () => {
    const budget = await resolveTenantMonthlyBudgetUsd(makeDb({ tenantBudget: "10.00", planBudget: "50.00" }), TENANT);
    expect(budget).toBe(10);
  });

  it("tenant NULL herda o teto do plano", async () => {
    const budget = await resolveTenantMonthlyBudgetUsd(makeDb({ tenantBudget: null, planBudget: "50.00" }), TENANT);
    expect(budget).toBe(50);
  });

  it("tenant e plano NULL herdam o default do env", async () => {
    process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT = "25";
    const budget = await resolveTenantMonthlyBudgetUsd(makeDb({}), TENANT);
    expect(budget).toBe(25);
  });

  it("env unset/0 = sem cap (null)", async () => {
    delete process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT;
    expect(await resolveTenantMonthlyBudgetUsd(makeDb({}), TENANT)).toBeNull();
    process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT = "0";
    expect(await resolveTenantMonthlyBudgetUsd(makeDb({}), TENANT)).toBeNull();
  });

  it("tenant inexistente = sem cap (null)", async () => {
    process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT = "25";
    expect(await resolveTenantMonthlyBudgetUsd(makeDb({ tenantRowMissing: true }), TENANT)).toBeNull();
  });
});

describe("getTenantMonthSpendUsd — fonte única project_agent_metrics (RFC-0004 D4)", () => {
  it("usa a estimativa de project_agent_metrics", async () => {
    const spend = await getTenantMonthSpendUsd(makeDb({ metricsUsd: "12.5" }), TENANT);
    expect(spend).toBe(12.5);
  });

  it("ledger dropado (073): valor do antigo ledger é irrelevante", async () => {
    // makeDb ainda responde à query do ledger por compat do fake, mas a função não a emite.
    const spend = await getTenantMonthSpendUsd(makeDb({ ledgerUsd: "20", metricsUsd: "12.5" }), TENANT);
    expect(spend).toBe(12.5);
  });
});

describe("checkTenantBudget", () => {
  it("sem cap configurado → ok (fail-safe: comportamento atual)", async () => {
    delete process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT;
    const r = await checkTenantBudget(makeDb({ metricsUsd: "999" }), TENANT);
    expect(r.ok).toBe(true);
  });

  it("gasto >= teto do tenant → bloqueia com spentUsd/budgetUsd", async () => {
    const r = await checkTenantBudget(makeDb({ tenantBudget: "10.00", metricsUsd: "12.5" }), TENANT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.spentUsd).toBe(12.5);
      expect(r.budgetUsd).toBe(10);
    }
  });

  it("gasto abaixo do teto → ok", async () => {
    const r = await checkTenantBudget(makeDb({ tenantBudget: "50.00", metricsUsd: "12.5" }), TENANT);
    expect(r.ok).toBe(true);
  });

  it("teto do plano é aplicado quando o tenant não tem override", async () => {
    const r = await checkTenantBudget(makeDb({ planBudget: "5.00", metricsUsd: "12.5" }), TENANT);
    expect(r.ok).toBe(false);
  });

  it("erro de infra → FAIL-OPEN (ok:true), nunca lança", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: Queryable = { query: async () => { throw new Error("connection refused"); } };
    const r = await checkTenantBudget(broken, TENANT);
    expect(r.ok).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("budgetExceededMessage", () => {
  it("mensagem acionável em PT-BR com gasto e teto", () => {
    const msg = budgetExceededMessage(12.5, 10);
    expect(msg).toContain("US$ 12.50");
    expect(msg).toContain("US$ 10.00");
    expect(msg).toContain("monthly_llm_budget_usd");
  });
});
