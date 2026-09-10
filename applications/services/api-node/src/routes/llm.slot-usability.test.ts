/**
 * llm.slot-usability.test.ts — o que a TELA de LLM afirma sobre cada slot (LEI de 2026-09-10).
 *
 * O defeito que estes testes guardam foi medido em prod: `routes/llm.ts` tinha uma cópia própria da
 * regra de credencial, na qual `bedrock` era `true` incondicional e `foundry`/`google` contavam a
 * chave do CONTAINER. Resultado: o portal exibia "✅ Credenciais configuradas" sobre os 4 slots dos
 * 3 tenants — e nenhum deles tinha credencial nenhuma; quem pagava era a Zentriz.
 *
 * Agora a tela consome `slotUsability`, a MESMA função que decide o que roda, e responde três
 * perguntas separadas: roda? é do tenant? está na nossa conta?
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const currentUser = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = currentUser; },
}));

let slotRows: Record<string, unknown>[] = [];
let byocExempt = false;
const queryMock = vi.fn(async (sql: string) => {
  if (sql.includes("FROM tenant_llm_configs")) return { rows: slotRows };
  if (sql.includes("FROM tenants"))            return { rows: [{ byoc_exempt: byocExempt }] };
  if (sql.includes("FROM zentriz_llm_config")) return { rows: [] };
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

let app: FastifyInstance;
beforeEach(async () => {
  slotRows = []; byocExempt = false;
  delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_VERTEX_PROJECT;
  app = Fastify(); await app.register(llmRoutes); await app.ready();
});

const get = async () => {
  const res = await app.inject({ method: "GET", url: "/api/tenant/llm-config" });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const slot = (over: Record<string, unknown>) => ({
  provider: "bedrock", model_id: "us.anthropic.claude-opus-5", model_id_fallback: null,
  cyborg_model_id: null, cyborg_model_id_fallback: null, credentials: {},
  max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0,
  is_active: true, priority: 0, ...over,
});

describe("GET /api/tenant/llm-config — o que a tela afirma sobre o slot", () => {
  // 🔴 Este é o estado REAL de Cabral Org e Salif Org medido em 2026-09-10.
  it("bedrock sem chave, tenant não isento → NÃO utilizável (era o 'verde' mentiroso)", async () => {
    slotRows = [slot({})];
    const body = await get();
    expect(body.slots[0].usable).toBe(false);
    expect(body.slots[0].own_credentials).toBe(false);
    expect(body.slots[0].uses_zentriz_account).toBe(false);
    expect(body.has_usable_slot).toBe(false);
  });

  it("bedrock sem chave + byoc_exempt → roda, e a tela DIZ que é a conta da Zentriz", async () => {
    slotRows = [slot({})]; byocExempt = true;
    const body = await get();
    expect(body.slots[0].usable).toBe(true);
    expect(body.slots[0].own_credentials).toBe(false);
    expect(body.slots[0].uses_zentriz_account).toBe(true);
    expect(body.byoc_exempt).toBe(true);
  });

  it("chave própria → fatura do tenant, sem menção à conta da Zentriz", async () => {
    slotRows = [slot({ credentials: { aws_access_key_id: "AKIA", aws_secret_access_key: "s" } })];
    const body = await get();
    expect(body.slots[0].own_credentials).toBe(true);
    expect(body.slots[0].uses_zentriz_account).toBe(false);
  });

  // A chave do container é a identidade da Zentriz: sem isenção ela não pode validar slot nenhum.
  it("foundry: a chave do container não conta para tenant não isento", async () => {
    process.env.ANTHROPIC_FOUNDRY_API_KEY = "chave-do-host";
    slotRows = [slot({ provider: "foundry", model_id: "claude-opus-5" })];
    expect((await get()).slots[0].usable).toBe(false);
  });

  it("os 4 slots aparecem sempre; os não cadastrados vêm como não utilizáveis", async () => {
    slotRows = [slot({ credentials: { aws_access_key_id: "AKIA", aws_secret_access_key: "s" } })];
    const body = await get();
    expect(body.slots).toHaveLength(4);
    expect(body.slots.slice(1).every((s: { configured: boolean; usable: boolean }) => !s.configured && !s.usable)).toBe(true);
  });

  // A recomendação do Jean ("pelo menos 2 slots de famílias diferentes") precisa de um NÚMERO na
  // resposta — a tela não pode inferir família a partir do provider (foundry e bedrock servem Claude).
  it("dois slots Claude em providers diferentes ainda são UMA família — sem cross-family", async () => {
    const creds = { aws_access_key_id: "AKIA", aws_secret_access_key: "s" };
    slotRows = [
      slot({ provider: "foundry", model_id: "claude-opus-5", credentials: { foundry_api_key: "k" }, priority: 0 }),
      slot({ provider: "bedrock", model_id: "us.anthropic.claude-sonnet-5", credentials: creds, priority: 1 }),
    ];
    const body = await get();
    expect(body.families).toEqual(["anthropic"]);
    expect(body.cross_family_available).toBe(false);
  });

  it("um slot Claude + um Gemini destravam o revisor cross-family", async () => {
    slotRows = [
      slot({ provider: "foundry", model_id: "claude-opus-5", credentials: { foundry_api_key: "k" }, priority: 0 }),
      slot({ provider: "google", model_id: "gemini-3-pro", credentials: { google_api_key: "AIza" }, priority: 1 }),
    ];
    const body = await get();
    expect(body.families.sort()).toEqual(["anthropic", "google"]);
    expect(body.cross_family_available).toBe(true);
  });

  // Slot inutilizável não conta família: prometeria um revisor que nunca vai rodar.
  it("família de slot NÃO utilizável não entra na conta", async () => {
    slotRows = [
      slot({ provider: "foundry", model_id: "claude-opus-5", credentials: { foundry_api_key: "k" }, priority: 0 }),
      slot({ provider: "google", model_id: "gemini-3-pro", credentials: {}, priority: 1 }),
    ];
    const body = await get();
    expect(body.families).toEqual(["anthropic"]);
    expect(body.cross_family_available).toBe(false);
  });

  it("a tela NÃO expõe mais o env como padrão do sistema", async () => {
    process.env.GENESIS_LLM_PROVIDER = "foundry";
    process.env.CLAUDE_MODEL = "claude-opus-5";
    const body = await get();
    expect(body.system_default.provider).toBeNull();
    expect(body.system_default.model_id).toBeNull();
    delete process.env.GENESIS_LLM_PROVIDER;
    delete process.env.CLAUDE_MODEL;
  });
});
