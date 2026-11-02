/**
 * Plano de evolução v2, tarefa 1.3 — ledger por papel. Cobre a flag LLM_ROLES_MODE em `recordCall`
 * e a normalização do papel. Com `off` o SQL e os parâmetros são byte-idênticos ao anterior.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { preflight, recordCall, type Queryable } from "./llmGuard.js";
import { llmRolesMode, normalizeLlmRole } from "../lib/llmRoles.js";

const PID = "00000000-0000-0000-0000-0000000000aa";

/** SQL do INSERT do ledger ANTES da tarefa 1.3 (cópia literal, é o snapshot). */
const LEGACY_LEDGER_SQL = `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, prompt_hash, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;

function recDb() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const q: Queryable & { inserts: typeof inserts } = {
    inserts,
    async query(sql: string, params?: unknown[]) {
      if (/INSERT INTO llm_call_ledger/.test(sql)) { inserts.push({ sql, params: params ?? [] }); return { rows: [], rowCount: 1 }; }
      if (/FROM llm_guard_settings/.test(sql) && /SELECT key, value/.test(sql)) return { rows: [{ key: "kill_switch", value: "off" }] };
      if (/SELECT value FROM llm_guard_settings/.test(sql)) return { rows: [{ value: "off" }] };
      if (/AS unattributed_day/.test(sql)) return { rows: [{ hour: 0, day: 0, unattributed_day: 0 }] };
      if (/JOIN projects o ON o.id = COALESCE/.test(sql)) {
        return { rows: [{ id: PID, title: "P", tenant_id: null, created_by: null, status: "draft", budget_usd: null,
          budget_alert_step_pct: null, budget_paused_at: null, budget_paused_reason: null }] };
      }
      if (/SELECT status, tenant_id FROM projects/.test(sql)) return { rows: [{ status: "draft", tenant_id: null }] };
      return { rows: [], rowCount: 0 };
    },
  };
  return q;
}

const BASE = { projectId: PID, purpose: "DEV:implement_task", source: "agents", model: "claude-sonnet-4-6",
  provider: "bedrock", inputTokens: 1000, outputTokens: 200, promptHash: "h1", durationMs: 50 };

const saved = process.env.LLM_ROLES_MODE;
afterEach(() => { if (saved === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = saved; });

describe("LLM_ROLES_MODE", () => {
  it("padrão off; valor inválido ⇒ off; shadow/on reconhecidos", () => {
    expect(llmRolesMode({})).toBe("off");
    expect(llmRolesMode({ LLM_ROLES_MODE: "banana" } as never)).toBe("off");
    expect(llmRolesMode({ LLM_ROLES_MODE: " SHADOW " } as never)).toBe("shadow");
    expect(llmRolesMode({ LLM_ROLES_MODE: "on" } as never)).toBe("on");
  });
  it("normalizeLlmRole: só orchestrator|advisor|staff, resto ⇒ null", () => {
    expect(normalizeLlmRole("Advisor")).toBe("advisor");
    expect(normalizeLlmRole("x")).toBeNull();
    expect(normalizeLlmRole(undefined)).toBeNull();
    expect(normalizeLlmRole(7)).toBeNull();
  });
});

describe("recordCall — ledger por papel", () => {
  it("off: SQL e parâmetros byte-idênticos ao legado, mesmo se o chamador mandar papel", async () => {
    delete process.env.LLM_ROLES_MODE;
    const d = recDb();
    await recordCall(d, { ...BASE, llmRole: "advisor", effectiveRole: "advisor", escalatedFrom: "orchestrator" });
    expect(d.inserts).toHaveLength(1);
    expect(d.inserts[0].sql).toBe(LEGACY_LEDGER_SQL);
    expect(d.inserts[0].params).toHaveLength(15);
    const p = d.inserts[0].params;
    expect([p[0], p[1], p[2], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11], p[13], p[14]])
      .toEqual([PID, PID, null, "agents", "DEV:implement_task", "bedrock", "claude-sonnet-4-6", 1000, 200, 0, 0, "h1", 50]);
  });

  it("shadow: grava llm_role, effective_role e escalated_from", async () => {
    process.env.LLM_ROLES_MODE = "shadow";
    const d = recDb();
    await recordCall(d, { ...BASE, llmRole: "advisor", effectiveRole: "advisor", escalatedFrom: "orchestrator" });
    const { sql, params } = d.inserts[0];
    expect(sql).toMatch(/llm_role, effective_role, escalated_from\)/);
    expect(params).toHaveLength(18);
    expect(params.slice(15)).toEqual(["advisor", "advisor", "orchestrator"]);
    expect(params.slice(0, 15)).toHaveLength(15);
  });

  it("shadow: effective_role cai no llm_role e escalated_from fica NULL numa chamada comum", async () => {
    process.env.LLM_ROLES_MODE = "shadow";
    const d = recDb();
    await recordCall(d, { ...BASE, llmRole: "orchestrator" });
    expect(d.inserts[0].params.slice(15)).toEqual(["orchestrator", "orchestrator", null]);
  });

  it("shadow: ausência do papel não quebra (tudo NULL) e papel desconhecido vira NULL", async () => {
    process.env.LLM_ROLES_MODE = "shadow";
    const d = recDb();
    const r1 = await recordCall(d, { ...BASE });
    const r2 = await recordCall(d, { ...BASE, llmRole: "ceo", escalatedFrom: 3 as never });
    expect(r1.costUsd).toBeGreaterThan(0);
    expect(r2.costUsd).toBeGreaterThan(0);
    expect(d.inserts).toHaveLength(2);
    expect(d.inserts[0].params.slice(15)).toEqual([null, null, null]);
    expect(d.inserts[1].params.slice(15)).toEqual([null, null, null]);
  });

  it("papel não altera o custo", async () => {
    const d = recDb();
    delete process.env.LLM_ROLES_MODE;
    const off = await recordCall(d, { ...BASE });
    process.env.LLM_ROLES_MODE = "shadow";
    const sh = await recordCall(d, { ...BASE, llmRole: "advisor" });
    expect(sh.costUsd).toBe(off.costUsd);
  });
});

describe("preflight — Guard-deny não muda papel nem modelo", () => {
  it("negativa idêntica em off e shadow, independente do papel informado, e sem gravar ledger", async () => {
    const mk = () => {
      const d = recDb();
      const orig = d.query.bind(d);
      d.query = async (sql: string, p?: unknown[]) => (/FROM llm_guard_settings/.test(sql) && /SELECT key, value/.test(sql)
        ? { rows: [{ key: "kill_switch", value: "on" }] } : orig(sql, p));
      return d;
    };
    delete process.env.LLM_ROLES_MODE;
    const a = await preflight(mk(), { projectId: PID, model: "claude-opus-5" });
    process.env.LLM_ROLES_MODE = "shadow";
    const dd = mk();
    const b = await preflight(dd, { projectId: PID, model: "claude-opus-5", ...( { llmRole: "advisor" } as object) } as never);
    expect(b).toEqual(a);
    expect(b).toMatchObject({ allow: false, code: "KILL_SWITCH" });
    expect(dd.inserts).toHaveLength(0);
  });
});

describe("POST /agent-metrics (projects.ts) — SQL legado preservado no ramo off", () => {
  it("o INSERT sem llm_role continua literalmente no código, e o ramo shadow é o único que cita llm_role", () => {
    const src = readFileSync(new URL("../routes/projects.ts", import.meta.url), "utf8");
    const legacy = `INSERT INTO project_agent_metrics
           (project_id, agent, task_id, round, input_tokens, output_tokens, model, duration_ms, status,
            cache_read_tokens, cache_write_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;
    expect(src).toContain(legacy);
    expect(src.match(/cache_write_tokens, llm_role\)/g)).toHaveLength(1);
  });
});
