/**
 * Plano de evolução v2, tarefa 1.4 — telemetria de desperdício. Cobre a flag WASTE_TELEMETRY em `recordCall`.
 * Com `off` o SQL e os parâmetros são byte-idênticos ao anterior (snapshot literal).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { recordCall, type Queryable } from "./llmGuard.js";
import { wasteTelemetryMode, normalizeCallReason, normalizeIdemKey } from "../lib/wasteTelemetry.js";

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
const KEY = `${PID}|T-1|DEV:implement_task|r0.p1`;

const savedW = process.env.WASTE_TELEMETRY;
const savedR = process.env.LLM_ROLES_MODE;
afterEach(() => {
  if (savedW === undefined) delete process.env.WASTE_TELEMETRY; else process.env.WASTE_TELEMETRY = savedW;
  if (savedR === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = savedR;
});

describe("WASTE_TELEMETRY", () => {
  it("padrão off; valor inválido ⇒ off; shadow/on reconhecidos", () => {
    expect(wasteTelemetryMode({})).toBe("off");
    expect(wasteTelemetryMode({ WASTE_TELEMETRY: "banana" } as never)).toBe("off");
    expect(wasteTelemetryMode({ WASTE_TELEMETRY: " SHADOW " } as never)).toBe("shadow");
    expect(wasteTelemetryMode({ WASTE_TELEMETRY: "on" } as never)).toBe("on");
  });
  it("normalizeCallReason: só os 6 motivos, resto ⇒ null", () => {
    for (const r of ["primary", "retry", "repair", "rework", "escalation", "support"]) expect(normalizeCallReason(r.toUpperCase())).toBe(r);
    expect(normalizeCallReason("x")).toBeNull();
    expect(normalizeCallReason(undefined)).toBeNull();
    expect(normalizeCallReason(3)).toBeNull();
  });
  it("normalizeIdemKey: exige o formato com separador, resto ⇒ null", () => {
    expect(normalizeIdemKey(KEY)).toBe(KEY);
    expect(normalizeIdemKey("semseparador")).toBeNull();
    expect(normalizeIdemKey("")).toBeNull();
    expect(normalizeIdemKey(null)).toBeNull();
  });
});

describe("recordCall — telemetria de desperdício", () => {
  it("off: SQL e parâmetros byte-idênticos ao legado, mesmo se o chamador mandar motivo e chave", async () => {
    delete process.env.WASTE_TELEMETRY; delete process.env.LLM_ROLES_MODE;
    const d = recDb();
    await recordCall(d, { ...BASE, callReason: "repair", callIdemKey: KEY });
    expect(d.inserts).toHaveLength(1);
    expect(d.inserts[0].sql).toBe(LEGACY_LEDGER_SQL);
    expect(d.inserts[0].params).toHaveLength(15);
  });

  it("shadow: grava call_reason e call_idem_key (17 parâmetros) sem tocar nos 15 anteriores", async () => {
    process.env.WASTE_TELEMETRY = "shadow"; delete process.env.LLM_ROLES_MODE;
    const d = recDb();
    await recordCall(d, { ...BASE, callReason: "repair", callIdemKey: KEY });
    const { sql, params } = d.inserts[0];
    expect(sql).toMatch(/call_reason, call_idem_key\)/);
    expect(sql).toMatch(/\$17\)/);
    expect(params).toHaveLength(17);
    expect(params.slice(15)).toEqual(["repair", KEY]);
    const legacy = recDb();
    delete process.env.WASTE_TELEMETRY;
    return recordCall(legacy, { ...BASE }).then(() => expect(params.slice(0, 15)).toEqual(legacy.inserts[0].params));
  });

  it("shadow com papéis ligados: 20 parâmetros, papel + motivo", async () => {
    process.env.WASTE_TELEMETRY = "on"; process.env.LLM_ROLES_MODE = "shadow";
    const d = recDb();
    await recordCall(d, { ...BASE, llmRole: "advisor", escalatedFrom: "orchestrator", callReason: "rework", callIdemKey: KEY });
    const { sql, params } = d.inserts[0];
    expect(sql).toMatch(/llm_role, effective_role, escalated_from,\s+call_reason, call_idem_key\)/);
    expect(params).toHaveLength(20);
    expect(params.slice(15)).toEqual(["advisor", "advisor", "orchestrator", "rework", KEY]);
  });

  it("motivo inválido ou ausente vira NULL sem quebrar; chave sem formato vira NULL", async () => {
    process.env.WASTE_TELEMETRY = "shadow"; delete process.env.LLM_ROLES_MODE;
    const d = recDb();
    await recordCall(d, { ...BASE, callReason: "banana", callIdemKey: "x" });
    await recordCall(d, { ...BASE });
    expect(d.inserts[0].params.slice(15)).toEqual([null, null]);
    expect(d.inserts[1].params.slice(15)).toEqual([null, null]);
  });

  it("retry de rede (mesma chave) NÃO descarta linha paga: duas linhas, mesma chave, custo preservado", async () => {
    process.env.WASTE_TELEMETRY = "shadow"; delete process.env.LLM_ROLES_MODE;
    const d = recDb();
    const a = await recordCall(d, { ...BASE, callReason: "primary", callIdemKey: KEY });
    const b = await recordCall(d, { ...BASE, callReason: "primary", callIdemKey: KEY });
    expect(d.inserts).toHaveLength(2);
    expect(d.inserts[0].params[16]).toBe(d.inserts[1].params[16]);
    expect(a.costUsd).toBe(b.costUsd);
    expect(a.costUsd).toBeGreaterThan(0);
  });

  it("custo calculado não depende da flag nem do motivo", async () => {
    delete process.env.WASTE_TELEMETRY;
    const off = await recordCall(recDb(), { ...BASE });
    process.env.WASTE_TELEMETRY = "on";
    const on = await recordCall(recDb(), { ...BASE, callReason: "retry", callIdemKey: KEY });
    expect(on.costUsd).toBe(off.costUsd);
  });
});

describe("migration 137", () => {
  const sql = readFileSync(new URL("../db/migrations/137_waste_telemetry_ledger.sql", import.meta.url), "utf8");
  it("aditiva: só ALTER ADD COLUMN IF NOT EXISTS e CREATE INDEX IF NOT EXISTS, sem DO/$$ nem ';' fora de comando", () => {
    expect(sql).not.toMatch(/\bDO\b\s*\$\$|\$\$/);
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE)\b/i);
    for (const line of sql.split("\n")) {
      if (line.includes(";")) expect(line).toMatch(/^(ALTER TABLE llm_call_ledger ADD COLUMN IF NOT EXISTS|CREATE INDEX IF NOT EXISTS) .*;$/);
    }
    expect(sql).toMatch(/call_reason TEXT/);
    expect(sql).toMatch(/call_idem_key TEXT/);
  });
});
