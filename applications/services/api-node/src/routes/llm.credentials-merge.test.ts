/**
 * llm.credentials-merge.test.ts — PUT /api/tenant/llm-config NÃO apaga credenciais gravadas quando o
 * portal reenvia o formulário sem elas (bug real: 2026-09-04 19:47Z as chaves AWS do tenant ZFactory
 * foram zeradas ao trocar só o modelo). Regras: ausente/mascarado preserva; valor novo substitui;
 * troca de provider zera.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
let currentUser: Record<string, unknown> = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = currentUser; },
}));

let existing: Record<string, unknown> | null = null;
const upserts: unknown[][] = [];
const queryMock = vi.fn(async (sql: string, p?: unknown[]) => {
  if (sql.includes("SELECT provider, credentials FROM tenant_llm_configs")) return { rows: existing ? [existing] : [] };
  if (sql.includes("INSERT INTO tenant_llm_configs")) { upserts.push(p ?? []); return { rows: [] }; }
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({ pool: { query: (s: string, p?: unknown[]) => queryMock(s, p) } }));

import Fastify, { type FastifyInstance } from "fastify";
import { llmRoutes } from "./llm.js";

let app: FastifyInstance;
beforeEach(async () => {
  upserts.length = 0; existing = null;
  currentUser = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
  app = Fastify(); await app.register(llmRoutes); await app.ready();
});

const savedCreds = () => JSON.parse(String(upserts[0][5])) as Record<string, string>;
const PREV = { aws_access_key_id: "AKIA_OLD", aws_secret_access_key: "SECRET_OLD", aws_region: "us-east-1" };

describe("PUT /api/tenant/llm-config/:priority — merge de credenciais", () => {
  it("formulário sem credenciais → PRESERVA as gravadas (só o modelo muda)", async () => {
    existing = { provider: "bedrock", credentials: PREV };
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/0",
      payload: { provider: "bedrock", model_id: "us.anthropic.claude-opus-4-8", model_id_fallback: "us.anthropic.claude-opus-5", credentials: {} } });
    expect(res.statusCode).toBe(200);
    expect(savedCreds()).toEqual(PREV);
    expect(upserts[0][3]).toBe("us.anthropic.claude-opus-4-8");
  });

  it("valor mascarado (\"****\") preserva; valor novo substitui só aquela chave", async () => {
    existing = { provider: "bedrock", credentials: PREV };
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/0",
      payload: { provider: "bedrock", model_id: "us.anthropic.claude-opus-4-8",
        credentials: { aws_access_key_id: "AKIA****_OLD", aws_secret_access_key: "SECRET_NEW" } } });
    expect(res.statusCode).toBe(200);
    expect(savedCreds()).toEqual({ ...PREV, aws_secret_access_key: "SECRET_NEW" });
  });

  it("troca de provider → credenciais do provider antigo NÃO são herdadas", async () => {
    existing = { provider: "bedrock", credentials: PREV };
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/0",
      payload: { provider: "anthropic", model_id: "claude-opus-5", credentials: { api_key: "sk-new" } } });
    expect(res.statusCode).toBe(200);
    expect(savedCreds()).toEqual({ api_key: "sk-new" });
  });

  it("sem linha anterior → grava o que veio (primeiro cadastro)", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config",
      payload: { provider: "bedrock", model_id: "us.anthropic.claude-opus-4-8", credentials: PREV } });
    expect(res.statusCode).toBe(200);
    expect(savedCreds()).toEqual(PREV);
  });
});
