import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (mesmo padrão de deadpool.test.ts): auth injeta request.user; db expõe pool.connect ---
let authRole = "zentriz_admin";
let authUser: Record<string, unknown> = { id: "u1", role: "zentriz_admin", tenantId: "t1" };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: Record<string, unknown>) => {
    (request as { user: unknown }).user = { ...authUser, role: authRole };
  },
}));

// pool.connect() devolve um client com .query controlável e .release() no-op.
const clientQuery = vi.fn(async (_q: string, _p?: unknown[]) => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("../db/client.js", () => ({
  pool: {
    connect: vi.fn(async () => ({ query: clientQuery, release: () => {} })),
  },
}));

import Fastify from "fastify";
import { dialogueRoutes, createDialogueTail, mapDialogueRow } from "./dialogue.js";

type FakeRow = Record<string, unknown>;
function fakeClient(rows: FakeRow[]) {
  return { query: vi.fn(async () => ({ rows })) };
}

beforeEach(() => {
  authRole = "zentriz_admin";
  authUser = { id: "u1", role: "zentriz_admin", tenantId: "t1" };
  clientQuery.mockReset();
  clientQuery.mockResolvedValue({ rows: [] });
});

describe("mapDialogueRow", () => {
  it("converte snake_case → camelCase e serializa created_at", () => {
    const item = mapDialogueRow({
      id: "abc",
      from_agent: "pm",
      to_agent: "engineer",
      event_type: "step",
      summary_human: "olá",
      request_id: "r1",
      created_at: new Date("2026-08-14T12:00:00.000Z"),
    });
    expect(item).toEqual({
      id: "abc",
      fromAgent: "pm",
      toAgent: "engineer",
      eventType: "step",
      summaryHuman: "olá",
      requestId: "r1",
      createdAt: "2026-08-14T12:00:00.000Z",
    });
  });

  it("tolera created_at ausente (createdAt = undefined)", () => {
    const item = mapDialogueRow({ id: "x", from_agent: "a", to_agent: "b", summary_human: "s" });
    expect(item.createdAt).toBeUndefined();
  });
});

describe("createDialogueTail", () => {
  const T0 = "2026-08-14T10:00:00.000Z";
  const T1 = "2026-08-14T10:00:01.000Z";
  const T2 = "2026-08-14T10:00:02.000Z";

  it("emite todas as linhas da primeira passada e avança o cursor até a última", async () => {
    const tail = createDialogueTail("p1", T0);
    const rows = [
      { id: "1", from_agent: "pm", to_agent: "eng", event_type: "step", summary_human: "a", request_id: null, created_at: new Date(T1) },
      { id: "2", from_agent: "eng", to_agent: "qa", event_type: "step", summary_human: "b", request_id: null, created_at: new Date(T2) },
    ];
    const out = await tail.poll(fakeClient(rows));
    expect(out.map((i) => i.id)).toEqual(["1", "2"]);
    expect(tail.cursor).toBe(T2);
  });

  it("deduplica por id — empates de timestamp reaparecem na query mas não são re-emitidos", async () => {
    const tail = createDialogueTail("p1", T0);
    const r1 = { id: "1", from_agent: "pm", to_agent: "eng", summary_human: "a", created_at: new Date(T1) };
    const r2 = { id: "2", from_agent: "eng", to_agent: "qa", summary_human: "b", created_at: new Date(T1) };

    const first = await tail.poll(fakeClient([r1, r2]));
    expect(first.map((i) => i.id)).toEqual(["1", "2"]);
    // Cursor ficou em T1 (>= T1 na próxima query traz r1/r2 de volta); dedupe deve filtrá-los.
    const second = await tail.poll(fakeClient([r1, r2]));
    expect(second).toEqual([]);
    expect(tail.cursor).toBe(T1);
  });

  it("emite apenas o que é novo entre passadas", async () => {
    const tail = createDialogueTail("p1", T0);
    const r1 = { id: "1", from_agent: "pm", to_agent: "eng", summary_human: "a", created_at: new Date(T1) };
    const r2 = { id: "2", from_agent: "eng", to_agent: "qa", summary_human: "b", created_at: new Date(T2) };
    await tail.poll(fakeClient([r1]));
    const out = await tail.poll(fakeClient([r1, r2]));
    expect(out.map((i) => i.id)).toEqual(["2"]);
    expect(tail.cursor).toBe(T2);
  });

  it("linha sem created_at não avança o cursor", async () => {
    const tail = createDialogueTail("p1", T0, { nowISO: T0 });
    const out = await tail.poll(fakeClient([{ id: "1", from_agent: "a", to_agent: "b", summary_human: "s" }]));
    expect(out).toHaveLength(1);
    expect(tail.cursor).toBe(T0);
  });

  it("usa nowISO como cursor default quando não há ?since válido", () => {
    expect(createDialogueTail("p1", undefined, { nowISO: T0 }).cursor).toBe(T0);
    expect(createDialogueTail("p1", "não-é-data", { nowISO: T0 }).cursor).toBe(T0);
  });

  it("respeita ?since válido no cursor inicial", () => {
    expect(createDialogueTail("p1", T1).cursor).toBe(T1);
  });

  it("zera o set de dedupe ao estourar o teto (não re-emite passado, cursor já avançou)", async () => {
    const tail = createDialogueTail("p1", T0, { seenCap: 1 });
    const r1 = { id: "1", from_agent: "a", to_agent: "b", summary_human: "s", created_at: new Date(T1) };
    const r2 = { id: "2", from_agent: "a", to_agent: "b", summary_human: "s", created_at: new Date(T2) };
    await tail.poll(fakeClient([r1, r2])); // seen={1,2} > cap → clear
    // Query seguinte (>= T2) traz só r2; como o set foi zerado, r2 seria re-emitido — aceitável,
    // mas r1 (< cursor) nunca reaparece na query real. Garantimos que r1 não volta:
    const out = await tail.poll(fakeClient([r2]));
    expect(out.map((i) => i.id)).toEqual(["2"]);
    expect(tail.cursor).toBe(T2);
  });
});

describe("GET /api/projects/:id/dialogue/stream (auth gate)", () => {
  it("responde 404 quando o projeto não é acessível (antes de assumir o socket)", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] }); // checkProjectAccess: projeto inexistente
    const app = Fastify();
    await app.register(dialogueRoutes);
    const res = await app.inject({ method: "GET", url: "/api/projects/p-x/dialogue/stream" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    await app.close();
  });

  it("responde 404 para tenant que não é dono nem admin", async () => {
    authRole = "tenant_admin";
    authUser = { id: "u2", role: "tenant_admin", tenantId: "outro" };
    clientQuery.mockResolvedValueOnce({ rows: [{ tenant_id: "dono", created_by: "u1" }] });
    const app = Fastify();
    await app.register(dialogueRoutes);
    const res = await app.inject({ method: "GET", url: "/api/projects/p-1/dialogue/stream" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
