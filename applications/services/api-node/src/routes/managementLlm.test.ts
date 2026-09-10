/**
 * managementLlm.test.ts — os slots de LLM da CONTA DE GESTÃO.
 *
 * ⚖️ Jean, 2026-09-10: *"é na conta de gerenciamento que deve ter uma config de LLM para os agentes
 * internos, que serão custeados pela Zentriz, não pelos tenants"*.
 *
 * O que precisa ficar travado, e por quê:
 *  · a porta é só do `zentriz_admin` — quem entra aqui vê a credencial que a Zentriz paga;
 *  · **estes slots nunca são fallback de tenant** (a LEI proíbe o default silencioso; o que ela
 *    permite é um pagador DECLARADO);
 *  · salvar sem `model_id` é recusado — nem a plataforma escolhe modelo por omissão;
 *  · reenviar o formulário com a credencial mascarada NÃO apaga a chave gravada (defeito medido em
 *    2026-09-04 nos slots de tenant: trocar só o modelo zerava as chaves AWS).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let currentUser: Record<string, unknown> = { id: "u1", email: "adm@zentriz.com.br", role: "zentriz_admin" };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = currentUser; },
}));

const probe = vi.hoisted(() => ({
  chamadas: [] as { provider: string; model: string; creds: Record<string, string> }[],
  catalogo: null as unknown,
  catalogoChamadas: [] as { provider: string; creds: Record<string, string> }[],
}));
vi.mock("../services/llmSlotProbe.js", () => ({
  probeSlot: async (provider: string, model: string, creds: Record<string, string>) => {
    probe.chamadas.push({ provider, model, creds });
    return { ok: true, kind: "", message: "", latencyMs: 700, model };
  },
  recordProbe: async () => {},
  listModels: async (provider: string, creds: Record<string, string>) => {
    probe.catalogoChamadas.push({ provider, creds });
    return probe.catalogo;
  },
}));

const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  escritas: [] as { sql: string; params: unknown[] }[],
}));
const queryMock = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes("SELECT id, priority, provider")) return { rows: db.rows };
  if (sql.includes("SELECT provider, credentials FROM zentriz_llm_config")) {
    const p = Number((params ?? [])[0]);
    return { rows: db.rows.filter((r) => Number(r.priority) === p) };
  }
  if (/INSERT|UPDATE|DELETE/.test(sql)) { db.escritas.push({ sql, params: params ?? [] }); return { rows: [] }; }
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({
  pool: {
    query: (s: string, p?: unknown[]) => queryMock(s, p),
    connect: async () => ({ query: (s: string, p?: unknown[]) => queryMock(s, p), release: () => {} }),
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { managementLlmRoutes } from "./managementLlm.js";

let app: FastifyInstance;
beforeEach(async () => {
  currentUser = { id: "u1", email: "adm@zentriz.com.br", role: "zentriz_admin" };
  db.rows = []; db.escritas = [];
  probe.chamadas = []; probe.catalogoChamadas = []; probe.catalogo = null;
  app = Fastify(); await app.register(managementLlmRoutes); await app.ready();
});

describe("porta da conta de gestão", () => {
  it.each(["tenant_admin", "user", "developer"])("papel %s não enxerga a config da Zentriz", async (role) => {
    currentUser = { id: "u9", email: "cliente@x.com", role, tenantId: "t1" };
    for (const url of ["/api/management/llm-config"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(403);
    }
    const put = await app.inject({ method: "PUT", url: "/api/management/llm-config/0",
      payload: { provider: "foundry", model_id: "claude-opus-5" } });
    expect(put.statusCode).toBe(403);
    expect(db.escritas).toHaveLength(0);
  });
});

describe("GET /api/management/llm-config", () => {
  it("mostra os 4 lugares mesmo vazios e DIZ quem paga", async () => {
    const res = await app.inject({ method: "GET", url: "/api/management/llm-config" });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.slots).toHaveLength(4);
    expect(j.has_usable_slot).toBe(false);
    expect(j.payer).toContain("Zentriz");
  });

  it("slot sem credencial própria não é utilizável — nem na conta que paga", async () => {
    // A conta de gestão é a pagadora, mas continua proibida de rodar no `.env` do container:
    // é a LEI dos slots. Sem credencial GRAVADA o slot não serve.
    db.rows = [{ id: "s0", priority: 0, provider: "foundry", model_id: "claude-opus-5",
                 credentials: {}, is_active: true }];
    const j = (await app.inject({ method: "GET", url: "/api/management/llm-config" })).json();
    expect(j.slots[0].usable).toBe(false);
    expect(j.slots[0].own_credentials).toBe(false);
  });

  it("nunca devolve a credencial em claro", async () => {
    db.rows = [{ id: "s0", priority: 0, provider: "foundry", model_id: "claude-opus-5",
                 credentials: { foundry_api_key: "CHAVE_SUPER_SECRETA_123" }, is_active: true }];
    const body = (await app.inject({ method: "GET", url: "/api/management/llm-config" })).body;
    expect(body).not.toContain("CHAVE_SUPER_SECRETA_123");
    expect(body).toContain("****");
  });
});

describe("PUT /api/management/llm-config/:priority", () => {
  it("recusa salvar sem model_id — nem a plataforma escolhe modelo por omissão", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/management/llm-config/0",
      payload: { provider: "foundry" } });
    expect(res.statusCode).toBe(400);
    expect(db.escritas).toHaveLength(0);
  });

  it("recusa provider fora da lista", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/management/llm-config/0",
      payload: { provider: "llm-do-vizinho", model_id: "x" } });
    expect(res.statusCode).toBe(400);
  });

  it("recusa priority fora de 0..3 (o CHECK do banco recusaria calado)", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/management/llm-config/9",
      payload: { provider: "foundry", model_id: "claude-opus-5" } });
    expect(res.statusCode).toBe(400);
  });

  it("grava, testa por invocação REAL e devolve o veredicto", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/management/llm-config/0",
      payload: { provider: "foundry", model_id: "claude-opus-5",
                 credentials: { foundry_api_key: "CHAVE" }, label: "principal" } });
    expect(res.statusCode).toBe(200);
    expect(probe.chamadas[0]).toMatchObject({ provider: "foundry", model: "claude-opus-5" });
    expect(res.json().verify).toMatchObject({ ok: true, status: "ok" });
  });

  it("credencial MASCARADA não apaga a chave já gravada", async () => {
    db.rows = [{ id: "s0", priority: 0, provider: "foundry", model_id: "claude-opus-5",
                 credentials: { foundry_api_key: "CHAVE_REAL" }, is_active: true }];
    await app.inject({ method: "PUT", url: "/api/management/llm-config/0",
      payload: { provider: "foundry", model_id: "claude-sonnet-5",
                 credentials: { foundry_api_key: "CHAV****REAL" } } });
    expect(probe.chamadas[0].creds.foundry_api_key).toBe("CHAVE_REAL");
  });

  it("descarta credencial fora da whitelist do provider", async () => {
    await app.inject({ method: "PUT", url: "/api/management/llm-config/1",
      payload: { provider: "anthropic", model_id: "claude-opus-5",
                 credentials: { api_key: "sk-ant", aws_secret_access_key: "vazando" } } });
    expect(probe.chamadas[0].creds).toEqual({ api_key: "sk-ant" });
  });
});

describe("POST /api/management/llm-config/models — catálogo dinâmico na conta da gestão", () => {
  it("sem credencial digitada usa a GRAVADA no slot", async () => {
    db.rows = [{ id: "s0", priority: 0, provider: "foundry", model_id: "claude-opus-5",
                 credentials: { foundry_api_key: "CHAVE_SALVA" }, is_active: true }];
    probe.catalogo = { provider: "foundry", source: "catalog", warning: "", models: [], usable: 0, total: 0, cached: false };
    const res = await app.inject({ method: "POST", url: "/api/management/llm-config/models",
      payload: { provider: "foundry", priority: 0, credentials: {} } });
    expect(res.statusCode).toBe(200);
    expect(probe.catalogoChamadas[0].creds.foundry_api_key).toBe("CHAVE_SALVA");
  });

  it("agents fora do ar devolve `unavailable`, não 500", async () => {
    probe.catalogo = null;
    const res = await app.inject({ method: "POST", url: "/api/management/llm-config/models",
      payload: { provider: "foundry", credentials: {} } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, unavailable: true });
  });
});
