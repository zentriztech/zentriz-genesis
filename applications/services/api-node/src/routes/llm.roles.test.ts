/**
 * llm.roles.test.ts — plano v2, 2A.3: dupla escrita dos papéis nas rotas de cadastro.
 *
 *  · LLM_ROLES_MODE=off  ⇒ SQL, parâmetros e payload BYTE-IDÊNTICOS aos anteriores (as colunas novas
 *    não são lidas nem escritas por caminho nenhum);
 *  · shadow/on           ⇒ model_orchestrator/advisor/staff acompanham model_id/model_id_fallback e as
 *    entradas inválidas FALHAM ALTO (400), sem corrigir em silêncio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => {
    (req as { user: unknown }).user = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
  },
}));
vi.mock("../services/llmSlotProbe.js", () => ({
  probeSlot: async (_p: string, model: string) => ({ ok: true, kind: "", message: "", latencyMs: 1, model }),
  recordProbe: async () => {},
  listModels: async () => null,
}));

const sqlLog: { sql: string; params: unknown[] }[] = [];
let prevRow: Record<string, unknown> | null = null;
const queryMock = vi.fn(async (sql: string, p?: unknown[]) => {
  sqlLog.push({ sql, params: p ?? [] });
  if (sql.includes("SELECT provider, credentials FROM tenant_llm_configs")) return { rows: prevRow ? [prevRow] : [] };
  if (sql.includes("FROM tenant_llm_configs WHERE tenant_id = $1 ORDER BY priority")) return { rows: slots };
  if (sql.includes("SELECT byoc_exempt")) return { rows: [{ byoc_exempt: false }] };
  return { rows: [] };
});
let slots: Record<string, unknown>[] = [];
vi.mock("../db/client.js", () => ({
  pool: {
    query: (s: string, p?: unknown[]) => queryMock(s, p),
    connect: async () => ({ query: (s: string, p?: unknown[]) => queryMock(s, p), release: () => {} }),
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { llmRoutes } from "./llm.js";

const OPUS48 = "us.anthropic.claude-opus-4-8";
const SONNET = "us.anthropic.claude-sonnet-4-6";
const HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const CREDS = { aws_access_key_id: "AKIA_T", aws_secret_access_key: "SECRET_T", aws_region: "us-east-1" };

/** SQL do upsert como era ANTES da 2A.3 (cópia literal do HEAD da Fase 1), normalizado em espaços. */
const SQL_ANTES = `INSERT INTO tenant_llm_configs
       (tenant_id, priority, provider, model_id, model_id_fallback, credentials,
        max_concurrent_projects, daily_token_quota, deadpool_token_reserve,
        cyborg_model_id, cyborg_model_id_fallback,
        is_active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,now())
     ON CONFLICT (tenant_id, priority) DO UPDATE SET
       provider=$3, model_id=$4, model_id_fallback=$5, credentials=$6,
       max_concurrent_projects=$7, daily_token_quota=$8,
       deadpool_token_reserve=$9,
       cyborg_model_id=$10, cyborg_model_id_fallback=$11,
       is_active=true, updated_at=now()`;
const SQL_GET_ANTES = `SELECT provider, model_id, model_id_fallback,
                cyborg_model_id, cyborg_model_id_fallback,
                credentials, max_concurrent_projects,
                daily_token_quota, deadpool_token_reserve, is_active, priority,
                verified_at, verify_status, verify_error, verify_model, verify_latency_ms
         FROM tenant_llm_configs WHERE tenant_id = $1 ORDER BY priority ASC`;

let app: FastifyInstance;
async function boot(mode?: string) {
  if (mode === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = mode;
  app = Fastify(); await app.register(llmRoutes); await app.ready();
}
beforeEach(() => { sqlLog.length = 0; prevRow = null; slots = []; });
afterEach(() => { delete process.env.LLM_ROLES_MODE; });

const upsert = () => sqlLog.find((c) => c.sql.includes("INSERT INTO tenant_llm_configs"))!;
const put = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/api/tenant/llm-config/0", payload: { provider: "bedrock", credentials: CREDS, ...payload } });

describe("LLM_ROLES_MODE=off (padrão) — byte-idêntico", () => {
  for (const mode of [undefined, "off", "lixo"]) {
    it(`mode=${String(mode)}: SQL do upsert idêntico, 11 parâmetros, campos novos IGNORADOS, resposta sem models`, async () => {
      await boot(mode);
      const res = await put({ model_id: SONNET, model_id_fallback: OPUS48,
        model_orchestrator: "x-ignorado", model_advisor: "y-ignorado", model_staff: OPUS48 });
      expect(res.statusCode).toBe(200);
      const u = upsert();
      expect(u.sql.replace(/\s+/g, " ")).toBe(SQL_ANTES.replace(/\s+/g, " "));
      expect(u.params).toHaveLength(11);
      expect(u.params[3]).toBe(SONNET);
      expect(u.params[4]).toBe(OPUS48);
      const body = res.json();
      expect(body.models).toBeUndefined();
      expect(body.warnings).toBeUndefined();
      expect(sqlLog.some((c) => /model_orchestrator|model_advisor|model_staff/.test(c.sql))).toBe(false);
    });
  }

  it("off: GET usa o SELECT antigo e o slot não ganha `models`", async () => {
    await boot("off");
    slots = [{ provider: "bedrock", model_id: SONNET, model_id_fallback: OPUS48, credentials: CREDS, priority: 0, is_active: true,
               max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0 }];
    const res = await app.inject({ method: "GET", url: "/api/tenant/llm-config" });
    expect(res.statusCode).toBe(200);
    const get = sqlLog.find((c) => c.sql.includes("FROM tenant_llm_configs WHERE tenant_id = $1 ORDER BY priority"))!;
    expect(get.sql.replace(/\s+/g, " ")).toBe(SQL_GET_ANTES.replace(/\s+/g, " "));
    expect(res.json().slots[0].models).toBeUndefined();
  });

  it("off: model_orchestrator sozinho NÃO substitui model_id (continua 400)", async () => {
    await boot("off");
    const res = await put({ model_orchestrator: SONNET });
    expect(res.statusCode).toBe(400);
  });
});

describe("LLM_ROLES_MODE=shadow|on — dupla escrita", () => {
  for (const mode of ["shadow", "on"]) {
    it(`${mode}: payload legado grava papéis coerentes (Advisor = fallback, Staff preservado)`, async () => {
      await boot(mode);
      const res = await put({ model_id: SONNET, model_id_fallback: OPUS48 });
      expect(res.statusCode).toBe(200);
      const u = upsert();
      expect(u.params).toHaveLength(14);
      expect(u.params.slice(11)).toEqual([SONNET, OPUS48, null]);
      expect(u.sql).toContain("model_staff=tenant_llm_configs.model_staff"); // Staff ausente ⇒ preserva
      expect(res.json().models).toMatchObject({ orchestrator: SONNET, advisor: OPUS48 });
    });
  }

  it("legado com fallback == principal ⇒ Advisor NULL (D1b), legado gravado como veio", async () => {
    await boot("on");
    await put({ model_id: OPUS48, model_id_fallback: OPUS48 });
    const u = upsert();
    expect(u.params[4]).toBe(OPUS48);
    expect(u.params.slice(11)).toEqual([OPUS48, null, null]);
  });

  it("payload novo (3 papéis, sem model_id) ⇒ model_id/model_id_fallback espelham Orchestrator/Advisor", async () => {
    await boot("on");
    const res = await put({ model_orchestrator: SONNET, model_advisor: OPUS48, model_staff: HAIKU });
    expect(res.statusCode).toBe(200);
    const u = upsert();
    expect(u.params[3]).toBe(SONNET);
    expect(u.params[4]).toBe(OPUS48);
    expect(u.params.slice(11)).toEqual([SONNET, OPUS48, HAIKU]);
    expect(u.sql).toContain("model_staff=$14");
    expect(res.json().models).toEqual({ orchestrator: SONNET, advisor: OPUS48, staff: HAIKU });
  });

  it("Staff de classe opus ⇒ 400 e NADA é gravado", async () => {
    await boot("on");
    const res = await put({ model_orchestrator: SONNET, model_staff: OPUS48 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/staff/);
    expect(sqlLog.some((c) => c.sql.includes("INSERT INTO tenant_llm_configs"))).toBe(false);
  });

  it("Advisor haiku ⇒ 400; provider incompatível ⇒ 400; campo novo × legado divergente ⇒ 400", async () => {
    await boot("on");
    expect((await put({ model_orchestrator: SONNET, model_advisor: HAIKU })).statusCode).toBe(400);
    const anth = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/0",
      payload: { provider: "anthropic", credentials: { api_key: "sk-x" }, model_orchestrator: "gemini-3-pro" } });
    expect(anth.statusCode).toBe(400);
    expect((await put({ model_id: SONNET, model_orchestrator: OPUS48 })).statusCode).toBe(400);
    expect(sqlLog.some((c) => c.sql.includes("INSERT INTO tenant_llm_configs"))).toBe(false);
  });

  it("id desconhecido é aceito com aviso na resposta (não bloqueia)", async () => {
    await boot("on");
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/1",
      payload: { provider: "openai", credentials: { api_key: "sk-x" },
                 model_orchestrator: "modelo-novo-x", model_advisor: "modelo-novo-y", model_staff: "modelo-novo-z" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.length).toBeGreaterThan(0);
  });

  it("GET inclui os papéis do slot (legado autoritativo) e a resposta nunca traz credencial em claro", async () => {
    await boot("on");
    slots = [{ provider: "bedrock", model_id: SONNET, model_id_fallback: OPUS48, credentials: CREDS, priority: 0, is_active: true,
               max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0,
               model_orchestrator: SONNET, model_advisor: OPUS48, model_staff: HAIKU }];
    const res = await app.inject({ method: "GET", url: "/api/tenant/llm-config" });
    expect(res.json().slots[0].models).toEqual({ orchestrator: SONNET, advisor: OPUS48, staff: HAIKU });
    expect(res.body).not.toContain("SECRET_T");
  });
});
