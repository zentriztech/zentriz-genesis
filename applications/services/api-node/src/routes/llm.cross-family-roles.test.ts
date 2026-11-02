/**
 * llm.cross-family-roles.test.ts — 2A.8: `families` / `cross_family_available` sobre PAPÉIS elegíveis.
 * `off`/`shadow` mantêm o cálculo de sempre (um modelo por slot); `on` considera Orchestrator e Advisor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const currentUser = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = currentUser; },
}));

let slotRows: Record<string, unknown>[] = [];
const queryMock = vi.fn(async (sql: string) => {
  if (sql.includes("FROM tenant_llm_configs")) return { rows: slotRows };
  if (sql.includes("FROM tenants")) return { rows: [{ byoc_exempt: false }] };
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({
  pool: {
    query: (s: string) => queryMock(s),
    connect: async () => ({ query: (s: string) => queryMock(s), release: () => {} }),
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { llmRoutes } from "./llm.js";

const AWS = { aws_access_key_id: "AKIA_FAKE", aws_secret_access_key: "SECRET_FAKE", aws_region: "us-east-1" };
const row = (over: Record<string, unknown>) => ({
  provider: "bedrock", priority: 0, model_id: "us.anthropic.claude-sonnet-5-5", model_id_fallback: null,
  credentials: AWS, max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, is_active: true,
  model_orchestrator: "us.anthropic.claude-sonnet-5-5", model_advisor: null, model_staff: null,
  verify_orchestrator_status: null, verify_advisor_status: null, ...over,
});

const saved = process.env.LLM_ROLES_MODE;
let app: FastifyInstance;
beforeEach(async () => { slotRows = []; app = Fastify(); await app.register(llmRoutes); await app.ready(); });
afterEach(() => { if (saved === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = saved; });

const get = async () => (await app.inject({ method: "GET", url: "/api/tenant/llm-config" })).json();

describe("families sobre papéis elegíveis", () => {
  // Um único slot Bedrock/Claude cujo Advisor é de outra família (id do Google no slot — só para o cálculo).
  const mixed = () => [row({ model_id_fallback: "gemini-3-pro", model_advisor: "gemini-3-pro" })];

  it("off: só o modelo principal do slot conta (uma família, sem cross-family)", async () => {
    process.env.LLM_ROLES_MODE = "off";
    slotRows = mixed();
    const r = await get();
    expect(r.families).toEqual(["anthropic"]);
    expect(r.cross_family_available).toBe(false);
    expect(r.cross_family_warnings).toBeUndefined();
  });
  it("shadow == off", async () => {
    process.env.LLM_ROLES_MODE = "shadow";
    slotRows = mixed();
    const r = await get();
    expect(r.families).toEqual(["anthropic"]);
    expect(r.cross_family_available).toBe(false);
  });
  it("on: o Advisor de outra família conta; papel sem verificação gera aviso", async () => {
    process.env.LLM_ROLES_MODE = "on";
    slotRows = mixed();
    const r = await get();
    expect([...r.families].sort()).toEqual(["anthropic", "google"]);
    expect(r.cross_family_available).toBe(true);
    expect(r.cross_family_warnings.length).toBe(2);
  });
  it("on: Advisor reprovado no probe não conta; verificado não gera aviso", async () => {
    process.env.LLM_ROLES_MODE = "on";
    slotRows = [row({ model_id_fallback: "gemini-3-pro", model_advisor: "gemini-3-pro",
                      verify_orchestrator_status: "ok", verify_advisor_status: "denied" })];
    const r = await get();
    expect(r.families).toEqual(["anthropic"]);
    expect(r.cross_family_available).toBe(false);
    expect(r.cross_family_warnings).toEqual([]);
  });
  it("on: Staff de outra família não conta", async () => {
    process.env.LLM_ROLES_MODE = "on";
    slotRows = [row({ model_staff: "command-r" })];
    expect((await get()).families).toEqual(["anthropic"]);
  });
});
