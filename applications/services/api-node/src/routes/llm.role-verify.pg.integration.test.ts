/**
 * Integração em Postgres REAL (efêmero) — 2A.9: verificação por papel grava `verify_<papel>_*` e
 * `isRoleEligible` lê o que foi gravado. Provedor mockado (nenhuma chamada real).
 * Só roda com PG_TEST_URL (localhost:55432, migrado 1→139); ver llm.reorder.pg.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";

const URL = process.env.PG_TEST_URL;
const holder = vi.hoisted(() => ({ pool: null as unknown as pg.Pool }));
vi.mock("../db/client.js", () => ({ get pool() { return holder.pool; } }));
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => {
    (req as { user: unknown }).user = { id: "u1", email: "a@x", role: "zentriz_admin", tenantId: null };
  },
}));
const OPUS = "us.anthropic.claude-opus-4-8";
const SONNET = "us.anthropic.claude-sonnet-4-6";
const HAIKU_US = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
vi.mock("../services/llmSlotProbe.js", () => ({
  probeSlot: async (_p: string, model: string) => model.startsWith("us.anthropic.claude-haiku")
    ? { ok: false, kind: "model", message: "ValidationException: invalid model", latencyMs: 1, model }
    : { ok: true, kind: "", message: "", latencyMs: 1, model },
  recordProbe: async () => {},
  listModels: async () => null,
}));

import Fastify from "fastify";
import { llmRoutes } from "./llm.js";
import { isRoleEligible } from "../services/llmRoleProbe.js";

const d = URL ? describe : describe.skip;

d("verificação por papel — Postgres real (efêmero)", () => {
  let pool: pg.Pool;
  let tenantId: string;
  beforeAll(async () => {
    if (!/@(localhost|127\.0\.0\.1):55432\//.test(URL!)) throw new Error("PG_TEST_URL deve apontar para localhost:55432");
    process.env.LLM_ROLES_MODE = "on";
    pool = new pg.Pool({ connectionString: URL, max: 4 });
    holder.pool = pool;
    const t = await pool.query(`INSERT INTO tenants (name, plan_id) VALUES ('t-rv-'||$1, 'plan_prata') RETURNING id`, [Date.now().toString(36)]);
    tenantId = t.rows[0].id;
  });
  afterAll(async () => { delete process.env.LLM_ROLES_MODE; await pool?.end(); });

  it("PUT grava status por papel; denied não é elegível; GET expõe verify_roles", async () => {
    const app = Fastify(); await app.register(llmRoutes); await app.ready();
    const res = await app.inject({ method: "PUT", url: `/api/tenant/llm-config/0?tenantId=${tenantId}`,
      payload: { provider: "bedrock", tenantId, model_id: OPUS, model_id_fallback: SONNET, model_staff: HAIKU_US,
                 credentials: { aws_access_key_id: "AKIATESTTESTTEST1234", aws_secret_access_key: "segredo-de-teste-1", aws_region: "us-east-1" } } });
    expect(res.statusCode).toBe(200);
    const row = (await pool.query("SELECT * FROM tenant_llm_configs WHERE tenant_id=$1 AND priority=0", [tenantId])).rows[0];
    expect(row.verify_orchestrator_status).toBe("ok");
    expect(row.verify_advisor_status).toBe("ok");
    expect(row.verify_staff_status).toBe("denied");
    expect(row.verify_staff_at).not.toBeNull();
    expect(row.verify_staff_error).toContain("sugestão: use o prefixo global.");
    expect(row.verify_staff_error).not.toContain("segredo-de-teste-1");
    expect(row.model_staff).toBe(HAIKU_US); // id não foi trocado
    expect(isRoleEligible(row, "orchestrator")).toBe(true);
    expect(isRoleEligible(row, "advisor")).toBe(true);
    expect(isRoleEligible(row, "staff")).toBe(false);

    const g = await app.inject({ method: "GET", url: `/api/tenant/llm-config?tenantId=${tenantId}` });
    expect(g.json().slots[0].verify_roles.staff.status).toBe("denied");
  });
});
