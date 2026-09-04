/**
 * stallEscalation.test.ts — watchdog de projetos TRAVADOS: decisão pura + passo do watchdog.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const notifyMock = vi.fn(async () => true);
vi.mock("./opsNotify.js", () => ({
  isBlockStatus: (s: string) =>
    s !== "blocked_awaiting_expo_confirm" && s !== "needs_spec_input" && (s.startsWith("blocked") || s === "failed" || s === "spec_validation_failed"),
  notifyFactoryStalled: (...a: unknown[]) => notifyMock(...(a as [])),
}));

import { decideEscalation, escalateStalledProjects, isStallCandidateStatus, stallConfig, type StallConfig } from "./stallEscalation.js";

const NOW = new Date("2026-09-04T12:00:00Z");
const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
const CFG: StallConfig = { enabled: true, hours: 6, repeatHours: 24, max: 3, batch: 5 };

beforeEach(() => { notifyMock.mockClear(); });

describe("isStallCandidateStatus", () => {
  it("bloqueios reais + pending_cyborg sim; esperas humanas e estados normais não", () => {
    for (const s of ["blocked_cyborg", "blocked_structural_gate", "failed", "spec_validation_failed", "pending_cyborg"]) expect(isStallCandidateStatus(s)).toBe(true);
    for (const s of ["running", "accepted", "needs_spec_input", "blocked_awaiting_expo_confirm", "queued"]) expect(isStallCandidateStatus(s)).toBe(false);
  });
});

describe("decideEscalation (pura)", () => {
  it("abaixo do limiar → null; acima → escalada 1 com first_at=last_at=now", () => {
    expect(decideEscalation({ id: "p", status: "blocked_cyborg", updated_at: h(5.9), stall: null }, CFG, NOW)).toBeNull();
    const d = decideEscalation({ id: "p", status: "blocked_cyborg", updated_at: h(48), stall: null }, CFG, NOW);
    expect(d).not.toBeNull();
    expect(d!.next).toEqual({ count: 1, first_at: NOW.toISOString(), last_at: NOW.toISOString(), status: "blocked_cyborg" });
    expect(d!.kind).toBe("stall:blocked_cyborg:1");
    expect(Math.round(d!.hoursStalled)).toBe(48);
    expect(d!.isLast).toBe(false);
  });
  it("repetição respeita repeatHours; máximo silencia; isLast na última", () => {
    const first = { count: 1, first_at: h(30).toISOString(), last_at: h(23).toISOString(), status: "failed" };
    expect(decideEscalation({ id: "p", status: "failed", updated_at: h(60), stall: first }, CFG, NOW)).toBeNull(); // 23h < 24h
    const d2 = decideEscalation({ id: "p", status: "failed", updated_at: h(60), stall: { ...first, last_at: h(25).toISOString() } }, CFG, NOW);
    expect(d2!.next.count).toBe(2); expect(d2!.next.first_at).toBe(first.first_at); expect(d2!.isLast).toBe(false);
    const d3 = decideEscalation({ id: "p", status: "failed", updated_at: h(90), stall: { ...first, count: 2, last_at: h(25).toISOString() } }, CFG, NOW);
    expect(d3!.next.count).toBe(3); expect(d3!.isLast).toBe(true); expect(d3!.kind).toBe("stall:failed:3");
    expect(decideEscalation({ id: "p", status: "failed", updated_at: h(200), stall: { ...first, count: 3, last_at: h(100).toISOString() } }, CFG, NOW)).toBeNull();
  });
  it("status mudou desde a última escalada → contador reinicia (travamento novo)", () => {
    const prev = { count: 3, first_at: h(80).toISOString(), last_at: h(1).toISOString(), status: "blocked_cyborg" };
    const d = decideEscalation({ id: "p", status: "failed", updated_at: h(7), stall: prev }, CFG, NOW);
    expect(d!.next.count).toBe(1); expect(d!.kind).toBe("stall:failed:1");
  });
  it("status não candidato ou updated_at inválido → null", () => {
    expect(decideEscalation({ id: "p", status: "running", updated_at: h(100), stall: null }, CFG, NOW)).toBeNull();
    expect(decideEscalation({ id: "p", status: "failed", updated_at: "nope", stall: null }, CFG, NOW)).toBeNull();
  });
});

function fakePool(rows: Array<{ id: string; status: string; updated_at: Date; stall: unknown }>) {
  const updates: Array<{ id: string; state: unknown }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM projects") && sql.includes("stall_escalation")) return { rowCount: rows.length, rows };
    if (sql.includes("UPDATE projects")) { updates.push({ id: params![0] as string, state: JSON.parse(params![1] as string) }); return { rowCount: 1, rows: [] }; }
    return { rowCount: 0, rows: [] };
  });
  return { pool: { query } as never, query, updates };
}

describe("escalateStalledProjects (passo do watchdog)", () => {
  it("desligado (STALL_ESCALATION=off) → 0 sem tocar o banco", async () => {
    const { pool, query } = fakePool([]);
    expect(await escalateStalledProjects(pool, NOW, { enabled: false })).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
  it("persiste extra.stall_escalation ANTES de notificar, com kind idempotente; respeita batch; ignora quem não deve escalar", async () => {
    const rows = [
      { id: "a", status: "blocked_cyborg", updated_at: h(50), stall: null },
      { id: "b", status: "failed", updated_at: h(10), stall: { count: 1, first_at: h(9).toISOString(), last_at: h(2).toISOString(), status: "failed" } }, // repetiu há 2h → não
      { id: "c", status: "pending_cyborg", updated_at: h(30), stall: null },
      { id: "d", status: "blocked_structural_gate", updated_at: h(7), stall: null },
    ];
    const { pool, updates } = fakePool(rows);
    const n = await escalateStalledProjects(pool, NOW, { ...CFG, batch: 2 });
    expect(n).toBe(2);
    expect(updates.map((u) => u.id)).toEqual(["a", "c"]);
    expect((updates[0].state as { count: number; status: string })).toMatchObject({ count: 1, status: "blocked_cyborg" });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const call = notifyMock.mock.calls[0] as unknown as [unknown, string, string, { count: number; max: number; isLast: boolean }];
    expect(call[1]).toBe("a");                        // projectId
    expect(call[2]).toBe("stall:blocked_cyborg:1");   // kind idempotente
    expect(call[3]).toMatchObject({ count: 1, max: 3, isLast: false });
  });
  it("falha no envio não derruba o ciclo (conta como tentativa persistida)", async () => {
    notifyMock.mockRejectedValueOnce(new Error("ses down"));
    const { pool, updates } = fakePool([{ id: "a", status: "failed", updated_at: h(50), stall: null }]);
    const n = await escalateStalledProjects(pool, NOW, CFG);
    expect(n).toBe(0);
    expect(updates.length).toBe(1); // estado gravado antes do envio → sem loop de spam
  });
  it("stallConfig lê env com defaults seguros", () => {
    const c = stallConfig();
    expect(c.enabled).toBe(true); expect(c.hours).toBe(6); expect(c.repeatHours).toBe(24); expect(c.max).toBe(3); expect(c.batch).toBe(5);
  });
});
