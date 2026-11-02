/**
 * Plano de evolução v2, tarefa 1.6 — serviço de alertas (flag ANOMALY_ALERTS) e independência do LLM Guard.
 * Banco fake em memória; e-mail mockado. Determinístico, sem rede e sem LLM.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmailMock = vi.fn(async () => ({ delivered: true }));
let sesConfigured = true;
vi.mock("./emailSender.js", () => ({ isSesConfigured: () => sesConfigured, sendEmail: (...a: unknown[]) => (sendEmailMock as (...x: unknown[]) => unknown)(...a) }));

import { listAnomalyAlerts, runAnomalyPass, startAnomalyWorker, stopAnomalyWorker, dedupeKey } from "./llmAnomaly.js";
import { preflight, type Queryable } from "./llmGuard.js";
import { DEFAULT_ANOMALY_PARAMS as P } from "../lib/anomalyAlerts.js";
import { hashId, HOUR_MS } from "./anomalyDetectors.js";
import { buildScenarios } from "./anomalyScenarios.js";

const SRC = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const loop = buildScenarios().find((s) => s.name === "loop_mesmo_hash")!;
const NOW = loop.onsetMs! + 2 * HOUR_MS + 17 * 60_000; // 2h17 depois do início do laço

function fakeDb() {
  const log: Array<{ sql: string; params: unknown[] }> = [];
  const keys = new Set<string>();
  const inserts: unknown[][] = [];
  const db: Queryable & { log: typeof log; inserts: typeof inserts } = {
    log, inserts,
    async query(sql: string, params: unknown[] = []) {
      log.push({ sql, params });
      if (/FROM llm_call_ledger/.test(sql)) {
        const [from, to] = params as number[];
        return { rows: loop.calls.filter((c) => c.tsMs >= from && c.tsMs < to).map((c) => ({
          ts_ms: c.tsMs, tenant_id: c.tenantId, project_id: c.projectId, cost_usd: c.costUsd, tokens: c.tokens, prompt_hash: c.promptHash })) };
      }
      if (/FROM project_agent_metrics/.test(sql)) {
        const [from, to] = params as number[];
        return { rows: loop.progress.filter((r) => r.tsMs >= from && r.tsMs < to).map((r) => ({ ts_ms: r.tsMs, project_id: r.projectId })) };
      }
      if (/INSERT INTO llm_anomaly_alerts/.test(sql)) {
        const key = String(params[12]);
        if (keys.has(key)) return { rows: [] };
        keys.add(key); inserts.push(params);
        return { rows: [{ id: inserts.length }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

beforeEach(() => { sendEmailMock.mockClear(); sesConfigured = true; });
afterEach(() => { stopAnomalyWorker(); vi.useRealTimers(); });

describe("ANOMALY_ALERTS=off (padrão): nada roda, nada é escrito", () => {
  it("passada não faz NENHUMA consulta nem e-mail", async () => {
    for (const env of [{}, { ANOMALY_ALERTS: "off" }, { ANOMALY_ALERTS: "lixo" }]) {
      const db = fakeDb();
      const r = await runAnomalyPass(db, NOW, env as never);
      expect(r).toEqual({ mode: "off", considered: 0, inserted: 0, notified: 0 });
      expect(db.log).toEqual([]);
    }
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
  it("worker off não agenda timer", () => {
    vi.useFakeTimers();
    const saved = process.env.ANOMALY_ALERTS;
    delete process.env.ANOMALY_ALERTS;
    try {
      startAnomalyWorker(() => fakeDb());
      expect(vi.getTimerCount()).toBe(0);
    } finally { if (saved !== undefined) process.env.ANOMALY_ALERTS = saved; }
  });
  it("llmGuard.ts não referencia o módulo de anomalia (o corte não muda)", () => {
    const guard = SRC("./llmGuard.ts");
    expect(guard).not.toMatch(/llmAnomaly|anomalyDetectors|anomalyAlerts|llm_anomaly_alerts/);
    expect(SRC("../routes/llmGuard.ts")).not.toMatch(/llmAnomaly|anomalyDetectors|llm_anomaly_alerts/);
  });
});

describe("shadow e on", () => {
  it("shadow grava alertas com mode=shadow e NÃO notifica", async () => {
    const db = fakeDb();
    const r = await runAnomalyPass(db, NOW, { ANOMALY_ALERTS: "shadow" } as never);
    expect(r.inserted).toBeGreaterThan(0);
    expect(r.notified).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(db.inserts.every((p) => p[1] === "shadow")).toBe(true);
    expect(db.inserts.some((p) => p[2] === "repeat_payload")).toBe(true);
    expect(db.log.some((l) => /UPDATE llm_anomaly_alerts/.test(l.sql))).toBe(false);
  });
  it("on grava com mode=on e notifica quando o canal existe", async () => {
    const db = fakeDb();
    const r = await runAnomalyPass(db, NOW, { ANOMALY_ALERTS: "on" } as never);
    expect(r.inserted).toBeGreaterThan(0);
    expect(r.notified).toBe(r.inserted);
    expect(sendEmailMock).toHaveBeenCalledTimes(r.inserted);
    expect(db.inserts.every((p) => p[1] === "on")).toBe(true);
  });
  it("on sem canal de operações só registra", async () => {
    sesConfigured = false;
    const r = await runAnomalyPass(fakeDb(), NOW, { ANOMALY_ALERTS: "on" } as never);
    expect(r.inserted).toBeGreaterThan(0);
    expect(r.notified).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
  it("idempotente: segunda passada com os mesmos dados não duplica", async () => {
    const db = fakeDb();
    const a = await runAnomalyPass(db, NOW, { ANOMALY_ALERTS: "shadow" } as never);
    const b = await runAnomalyPass(db, NOW, { ANOMALY_ALERTS: "shadow" } as never);
    expect(a.inserted).toBeGreaterThan(0);
    expect(b.inserted).toBe(0);
  });
  it("sem PII: nenhum parâmetro gravado contém id de tenant/projeto em claro", async () => {
    const db = fakeDb();
    await runAnomalyPass(db, NOW, { ANOMALY_ALERTS: "shadow" } as never);
    const blob = JSON.stringify(db.inserts);
    expect(blob).not.toMatch(/proj-b1|tenant-b/);
    expect(blob).toContain(hashId("proj-b1"));
  });
  it("só grava alertas da janela recente (histórico serve apenas de base)", async () => {
    const db = fakeDb();
    await runAnomalyPass(db, NOW, { ANOMALY_ALERTS: "shadow" } as never);
    const from = Math.floor(NOW / HOUR_MS) * HOUR_MS - P.reportWindowHours * HOUR_MS;
    expect(db.inserts.every((p) => Number(p[0]) >= from)).toBe(true);
  });
  it("falha no banco nunca propaga (o Guard não depende disto)", async () => {
    const bad: Queryable = { query: async () => { throw new Error("db down"); } };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runAnomalyPass(bad, NOW, { ANOMALY_ALERTS: "on" } as never)).resolves.toMatchObject({ inserted: 0 });
    err.mockRestore();
  });
  it("dedupe_key muda a cada janela de cooldown", () => {
    const a = { detector: "mad", metric: "usd_per_hour", scope: "project", scopeHash: "h", tsMs: 0 } as never;
    const b = { detector: "mad", metric: "usd_per_hour", scope: "project", scopeHash: "h", tsMs: P.cooldownHours * HOUR_MS } as never;
    expect(dedupeKey(a, P)).not.toBe(dedupeKey(b, P));
  });
});

describe("consulta de alertas", () => {
  it("lista com filtros parametrizados e limite saneado", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: Queryable = { query: async (sql, params = []) => { calls.push({ sql, params }); return { rows: [{ id: 1 }] }; } };
    const rows = await listAnomalyAlerts(db, { scopeHash: "abc", detector: "mad", since: "2026-01-01T00:00:00Z", limit: 99999 });
    expect(rows).toEqual([{ id: 1 }]);
    expect(calls[0].sql).toMatch(/scope_hash = \$1 AND detector = \$2 AND detected_at >= \$3/);
    expect(calls[0].params).toEqual(["abc", "mad", "2026-01-01T00:00:00Z", 500]);
    expect(calls[0].sql).not.toMatch(/abc/);
  });
});

describe("LLM Guard permanece soberano e fail-closed, com qualquer valor da flag", () => {
  const saved = process.env.ANOMALY_ALERTS;
  afterEach(() => { if (saved === undefined) delete process.env.ANOMALY_ALERTS; else process.env.ANOMALY_ALERTS = saved; });

  const guardDb = (killSwitch: string, opts: { failAll?: boolean } = {}): Queryable & { anomalyTouched: boolean } => {
    const o = {
      anomalyTouched: false,
      async query(sql: string) {
        if (/llm_anomaly_alerts/.test(sql)) o.anomalyTouched = true;
        if (opts.failAll) throw new Error("db down");
        if (/FROM llm_guard_settings/.test(sql)) return { rows: [{ key: "kill_switch", value: killSwitch }] };
        return { rows: [], rowCount: 0 };
      },
    };
    return o;
  };

  for (const mode of ["off", "shadow", "on"]) {
    it(`ANOMALY_ALERTS=${mode}: chave geral ligada ⇒ NEGA`, async () => {
      process.env.ANOMALY_ALERTS = mode;
      const db = guardDb("on");
      const d = await preflight(db, { projectId: "00000000-0000-0000-0000-0000000000aa", purpose: "x" });
      expect(d.allow).toBe(false);
      expect(d.allow === false && d.code).toBe("KILL_SWITCH");
      expect(db.anomalyTouched).toBe(false);
    });
    it(`ANOMALY_ALERTS=${mode}: banco fora ⇒ NEGA (fail-closed)`, async () => {
      process.env.ANOMALY_ALERTS = mode;
      const db = guardDb("off", { failAll: true });
      const d = await preflight(db, { projectId: "00000000-0000-0000-0000-0000000000aa", purpose: "x" });
      expect(d.allow).toBe(false);
      expect(d.allow === false && d.code).toBe("GUARD_ERROR");
      expect(db.anomalyTouched).toBe(false);
    });
  }
  it("alertas críticos existentes na tabela não liberam nem bloqueiam nada: o Guard nem lê a tabela", async () => {
    process.env.ANOMALY_ALERTS = "on";
    const db = guardDb("off"); // chave geral liberada, sem orçamento/projeto ⇒ decisão é do Guard
    const d = await preflight(db, { projectId: "00000000-0000-0000-0000-0000000000aa", purpose: "x" });
    expect(db.anomalyTouched).toBe(false);
    expect(d.allow).toBe(false); // sem projeto/orçamento conhecido o Guard nega, como antes
  });
});
