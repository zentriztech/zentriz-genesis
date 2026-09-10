/**
 * llm.probe-reorder.test.ts — ⚖️ Jean, 2026-09-10:
 * *"sempre testando se funciona […] o ideal é testar no momento que é adicionado"*.
 *
 * Dois comportamentos, os dois nascidos de defeitos concretos:
 *
 * 1. **Probe no salvar.** O slot é testado com a credencial EFETIVA (a mesclada, não a mascarada
 *    que a tela reenvia) e um teste reprovado NÃO impede o salvamento — senão uma cota estourada
 *    hoje travaria a configuração do tenant para sempre.
 * 2. **Reorder transacional.** Reordenar/remover slot era "DELETE tudo + re-PUT com credentials {}":
 *    como o DELETE vinha primeiro, a preservação de credencial do upsert não achava a linha anterior
 *    e o reorder APAGAVA as chaves de todos os slots. Agora a linha inteira é movida.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
let currentUser: Record<string, unknown> = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = currentUser; },
}));

const probe = vi.hoisted(() => ({
  chamadas: [] as { provider: string; model: string; creds: Record<string, string> }[],
  resultado: { ok: true, kind: "", message: "", latencyMs: 42, model: "" },
  gravacoes: [] as unknown[],
}));
vi.mock("../services/llmSlotProbe.js", () => ({
  probeSlot: async (provider: string, model: string, creds: Record<string, string>) => {
    probe.chamadas.push({ provider, model, creds });
    return { ...probe.resultado, model: probe.resultado.model || model };
  },
  recordProbe: async (...args: unknown[]) => { probe.gravacoes.push(args); },
}));

let existing: Record<string, unknown> | null = null;
let slotRows: Record<string, unknown>[] = [];
const sqlLog: { sql: string; params?: unknown[] }[] = [];
const queryMock = vi.fn(async (sql: string, p?: unknown[]) => {
  sqlLog.push({ sql, params: p });
  if (sql.includes("SELECT provider, credentials FROM tenant_llm_configs")) return { rows: existing ? [existing] : [] };
  if (sql.includes("SELECT provider, model_id, credentials FROM tenant_llm_configs")) {
    const pr = Number((p ?? [])[1]);
    return { rows: slotRows.filter((r) => Number(r.priority) === pr) };
  }
  if (sql.includes("SELECT * FROM tenant_llm_configs")) return { rows: slotRows };
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({
  pool: {
    query: (s: string, p?: unknown[]) => queryMock(s, p),
    connect: async () => ({ query: (s: string, p?: unknown[]) => queryMock(s, p), release: () => {} }),
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { llmRoutes } from "./llm.js";

let app: FastifyInstance;
beforeEach(async () => {
  existing = null; slotRows = []; sqlLog.length = 0;
  probe.chamadas.length = 0; probe.gravacoes.length = 0;
  probe.resultado = { ok: true, kind: "", message: "", latencyMs: 42, model: "" };
  currentUser = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
  app = Fastify(); await app.register(llmRoutes); await app.ready();
});

const PREV = { aws_access_key_id: "AKIA_OLD", aws_secret_access_key: "SECRET_OLD", aws_region: "us-east-1" };

describe("PUT /api/tenant/llm-config/:priority — testa o slot no ato do cadastro", () => {
  it("testa com a credencial EFETIVA (mesclada), não com a mascarada que a tela reenvia", async () => {
    existing = { provider: "bedrock", credentials: PREV };
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/0",
      payload: { provider: "bedrock", model_id: "us.anthropic.claude-opus-5", credentials: {} } });
    expect(res.statusCode).toBe(200);
    expect(probe.chamadas).toHaveLength(1);
    // Testar a mascarada reprovaria um slot bom — o teste tem de usar a chave que vai rodar.
    expect(probe.chamadas[0]).toMatchObject({ provider: "bedrock", model: "us.anthropic.claude-opus-5", creds: PREV });
    expect(res.json().verify).toMatchObject({ ok: true, status: "ok", latency_ms: 42 });
    expect(probe.gravacoes).toHaveLength(1);
  });

  it("teste REPROVADO não impede o salvamento — o veredicto é informação, não bloqueio", async () => {
    probe.resultado = { ok: false, kind: "auth", message: "401 invalid_api_key", latencyMs: 90, model: "" };
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/1",
      payload: { provider: "anthropic", model_id: "claude-opus-5", credentials: { api_key: "sk-x" } } });
    expect(res.statusCode).toBe(200);
    expect(sqlLog.some((c) => c.sql.includes("INSERT INTO tenant_llm_configs"))).toBe(true);
    expect(res.json().verify).toMatchObject({ ok: false, status: "auth" });
  });
});

describe("POST /api/tenant/llm-config/:priority/test — re-teste sob demanda", () => {
  it("usa a credencial GRAVADA e devolve o veredicto", async () => {
    slotRows = [{ priority: 1, provider: "bedrock", model_id: "us.anthropic.claude-sonnet-5", credentials: PREV }];
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/1/test", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(probe.chamadas[0]).toMatchObject({ model: "us.anthropic.claude-sonnet-5", creds: PREV });
    expect(res.json().verify.ok).toBe(true);
  });

  it("slot não configurado → 404 (não inventa um teste sobre nada)", async () => {
    slotRows = [];
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/2/test", payload: {} });
    expect(res.statusCode).toBe(404);
    expect(probe.chamadas).toHaveLength(0);
  });
});

describe("POST /api/tenant/llm-config/reorder — permutar sem perder credencial", () => {
  const ROW = (priority: number, model: string, creds: Record<string, string>) => ({
    priority, provider: "bedrock", model_id: model, model_id_fallback: null, credentials: creds,
    max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0,
    cyborg_model_id: null, cyborg_model_id_fallback: null, is_active: true,
    verified_at: "2026-09-10T00:00:00Z", verify_status: "ok", verify_error: null,
    verify_model: model, verify_latency_ms: 120,
  });

  it("move a LINHA inteira: credencial e veredicto do teste seguem o slot", async () => {
    slotRows = [ROW(0, "m0", { aws_access_key_id: "A0" }), ROW(1, "m1", { aws_access_key_id: "A1" })];
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/reorder",
      payload: { order: [1, 0] } });
    expect(res.statusCode).toBe(200);
    const inserts = sqlLog.filter((c) => c.sql.includes("INSERT INTO tenant_llm_configs"));
    expect(inserts).toHaveLength(2);
    // Posição 0 passa a ser o antigo slot 1 — com a chave DELE, não com credenciais vazias.
    expect(inserts[0].params?.[1]).toBe(0);
    expect(inserts[0].params?.[3]).toBe("m1");
    expect(JSON.parse(String(inserts[0].params?.[5]))).toEqual({ aws_access_key_id: "A1" });
    // O veredicto do último teste viaja junto: reordenar não é reconfigurar.
    expect(inserts[0].params?.[13]).toBe("ok");   // verify_status
    expect(inserts[1].params?.[3]).toBe("m0");
  });

  it("tudo dentro de uma transação — nenhum instante com o tenant sem slot", async () => {
    slotRows = [ROW(0, "m0", { aws_access_key_id: "A0" })];
    await app.inject({ method: "POST", url: "/api/tenant/llm-config/reorder", payload: { order: [0] } });
    const seq = sqlLog.map((c) => c.sql.trim().split(/\s+/).slice(0, 2).join(" "));
    expect(seq[0]).toBe("BEGIN");
    expect(seq[seq.length - 1]).toBe("COMMIT");
    expect(seq.indexOf("DELETE FROM")).toBeGreaterThan(0);
  });

  it("order com prioridade inexistente → 400 e ROLLBACK (não apaga nada)", async () => {
    slotRows = [ROW(0, "m0", { aws_access_key_id: "A0" })];
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/reorder",
      payload: { order: [0, 2] } });
    expect(res.statusCode).toBe(400);
    expect(sqlLog.some((c) => c.sql.startsWith("DELETE"))).toBe(false);
    expect(sqlLog.some((c) => c.sql === "ROLLBACK")).toBe(true);
  });

  it("order duplicada ou fora de 0-3 → 400 antes de tocar o banco", async () => {
    for (const order of [[0, 0], [0, 7], ["x"], []]) {
      const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/reorder", payload: { order } });
      expect(res.statusCode).toBe(400);
    }
    expect(sqlLog).toHaveLength(0);
  });

  it("usuário sem papel de admin → 403", async () => {
    currentUser = { id: "u2", email: "b@x", role: "user", tenantId: TENANT };
    app = Fastify(); await app.register(llmRoutes); await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/reorder", payload: { order: [0] } });
    expect(res.statusCode).toBe(403);
  });
});
