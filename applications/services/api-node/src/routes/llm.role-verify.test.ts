/** llm.role-verify.test.ts — 2A.9: rota de salvar/re-testar/GET com a verificação por papel. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => {
    (req as { user: unknown }).user = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
  },
}));
const probe = vi.hoisted(() => ({ models: [] as string[], deny: new Set<string>() }));
vi.mock("../services/llmSlotProbe.js", () => ({
  probeSlot: async (_p: string, model: string) => {
    probe.models.push(model);
    return probe.deny.has(model)
      ? { ok: false, kind: "auth", message: "AccessDeniedException", latencyMs: 1, model }
      : { ok: true, kind: "", message: "", latencyMs: 1, model };
  },
  recordProbe: async () => {},
  listModels: async () => null,
}));

const sqlLog: { sql: string; params: unknown[] }[] = [];
let stored: Record<string, unknown> = {};
let slots: Record<string, unknown>[] = [];
const queryMock = vi.fn(async (sql: string, p?: unknown[]) => {
  sqlLog.push({ sql, params: p ?? [] });
  if (sql.includes("SELECT provider, credentials FROM")) return { rows: [] };
  if (sql.includes("SELECT model_id, model_id_fallback, model_orchestrator")) return { rows: [stored] };
  if (sql.includes("SELECT provider, model_id, credentials FROM")) return { rows: [stored] };
  if (sql.includes("ORDER BY priority")) return { rows: slots };
  if (sql.includes("SELECT byoc_exempt")) return { rows: [{ byoc_exempt: false }] };
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

const OPUS = "us.anthropic.claude-opus-4-8";
const SONNET = "us.anthropic.claude-sonnet-4-6";
const HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const CREDS = { aws_access_key_id: "AKIA_T", aws_secret_access_key: "SECRET_T", aws_region: "us-east-1" };
let app: FastifyInstance;
async function boot(mode?: string) {
  if (mode === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = mode;
  app = Fastify(); await app.register(llmRoutes); await app.ready();
}
beforeEach(() => { sqlLog.length = 0; probe.models.length = 0; probe.deny.clear(); slots = [];
  stored = { model_id: OPUS, model_id_fallback: SONNET, model_orchestrator: OPUS, model_advisor: SONNET, model_staff: HAIKU }; });
afterEach(() => { delete process.env.LLM_ROLES_MODE; });
const roleUpdates = () => sqlLog.filter((c) => /UPDATE tenant_llm_configs SET verify_(orchestrator|advisor|staff)_/.test(c.sql));

describe("PUT com LLM_ROLES_MODE=off — idêntico ao atual", () => {
  it("1 probe (model_id), nenhuma consulta/UPDATE de papel, sem verify_roles", async () => {
    await boot("off");
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/0",
      payload: { provider: "bedrock", model_id: OPUS, model_id_fallback: SONNET, credentials: CREDS } });
    expect(res.statusCode).toBe(200);
    expect(probe.models).toEqual([OPUS]);
    expect(roleUpdates()).toHaveLength(0);
    expect(sqlLog.some((c) => c.sql.includes("model_orchestrator, model_advisor, model_staff FROM"))).toBe(false);
    expect(res.json()).not.toHaveProperty("verify_roles");
  });
});

describe("PUT com LLM_ROLES_MODE=on", () => {
  it("verifica advisor e staff (orchestrator reaproveita model_id) e grava por papel", async () => {
    await boot("on");
    probe.deny.add(SONNET);
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/0",
      payload: { provider: "bedrock", model_id: OPUS, model_id_fallback: SONNET, model_staff: HAIKU, credentials: CREDS } });
    expect(res.statusCode).toBe(200);
    expect(probe.models.sort()).toEqual([OPUS, SONNET, HAIKU].sort());
    const vr = res.json().verify_roles;
    expect(vr.orchestrator.status).toBe("ok");
    expect(vr.advisor.status).toBe("denied");
    expect(vr.staff.status).toBe("ok");
    const up = roleUpdates();
    expect(up).toHaveLength(1);
    expect(up[0].sql).toMatch(/verify_advisor_status = \$/);
    expect(up[0].params).toContain("denied");
  });

  it("re-teste (POST /test) devolve verify_roles e grava por papel", async () => {
    await boot("shadow");
    stored = { ...stored, provider: "bedrock", credentials: CREDS };
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/0/test", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().verify_roles.staff.status).toBe("ok");
    expect(roleUpdates()).toHaveLength(1);
  });

  it("GET inclui verify por papel só com a flag ligada", async () => {
    slots = [{ priority: 0, provider: "bedrock", model_id: OPUS, credentials: CREDS, is_active: true,
               model_orchestrator: OPUS, model_advisor: null, model_staff: null,
               verify_orchestrator_status: "ok", verify_advisor_status: null }];
    await boot("on");
    let res = await app.inject({ method: "GET", url: "/api/tenant/llm-config" });
    const s0 = res.json().slots[0];
    expect(s0.verify_roles.orchestrator.status).toBe("ok");
    expect(s0.verify_roles.advisor.status).toBeNull();
    await boot("off");
    res = await app.inject({ method: "GET", url: "/api/tenant/llm-config" });
    expect(res.json().slots[0]).not.toHaveProperty("verify_roles");
  });
});
