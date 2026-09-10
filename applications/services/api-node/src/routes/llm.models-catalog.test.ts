/**
 * llm.models-catalog.test.ts — ⚖️ Jean, 2026-09-10:
 * *"a lista de modelos disponíveis deve ser obtida de forma dinâmica baseado no provider e
 *   credenciais informadas, daí carrega a lista de modelos disponíveis nos selects"*.
 *
 * A rota existe porque a lista estava CRAVADA no front (`PROVIDER_META`) e oferecia
 * `us.anthropic.claude-opus-5` no Bedrock — id que a conta de prod recusa com 403 pelos três
 * caminhos medidos. Escolher ali criava um slot que nascia morto.
 *
 * Os três comportamentos abaixo são os que impedem a tela de mentir ou de travar:
 * 1. a credencial DIGITADA vence (o operador pode estar trocando a chave e quer a lista DELA);
 * 2. sem credencial digitada, cai na GRAVADA — a tela abre com os campos vazios por desenho;
 * 3. agents fora do ar devolve `unavailable`, nunca 500: o front mantém a lista que já tinha.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
let currentUser: Record<string, unknown> = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = currentUser; },
}));

const cat = vi.hoisted(() => ({
  chamadas: [] as { provider: string; creds: Record<string, string>; refresh: boolean }[],
  resposta: null as unknown,
}));
vi.mock("../services/llmSlotProbe.js", () => ({
  probeSlot: async () => ({ ok: true, kind: "", message: "", latencyMs: 1, model: "m" }),
  recordProbe: async () => {},
  listModels: async (provider: string, creds: Record<string, string>, refresh: boolean) => {
    cat.chamadas.push({ provider, creds, refresh });
    return cat.resposta;
  },
}));

let slotRows: Record<string, unknown>[] = [];
const queryMock = vi.fn(async (sql: string, p?: unknown[]) => {
  if (sql.includes("SELECT credentials FROM tenant_llm_configs")) {
    const pr = Number((p ?? [])[1]);
    return { rows: slotRows.filter((r) => Number(r.priority) === pr) };
  }
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

const CATALOGO = {
  provider: "bedrock", source: "provider" as const, warning: "",
  models: [{ id: "us.anthropic.claude-opus-4-6-v1", ok: true, kind: "", message: "", latencyMs: 700 },
           { id: "amazon.nova-pro-v1:0", ok: false, kind: "auth", message: "AccessDenied", latencyMs: 90 }],
  usable: 1, total: 2, cached: false,
};

let app: FastifyInstance;
beforeEach(async () => {
  cat.chamadas.length = 0; cat.resposta = CATALOGO; slotRows = [];
  currentUser = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
  app = Fastify(); await app.register(llmRoutes); await app.ready();
});

describe("POST /api/tenant/llm-config/models — catálogo dinâmico e verificado", () => {
  it("usa a credencial DIGITADA e devolve o catálogo com a origem da lista", async () => {
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/models",
      payload: { provider: "bedrock", priority: 1,
                 credentials: { aws_access_key_id: "AKIA_NOVA", aws_secret_access_key: "s", aws_region: "us-east-1" } } });
    expect(res.statusCode).toBe(200);
    expect(cat.chamadas[0].creds.aws_access_key_id).toBe("AKIA_NOVA");
    const j = res.json();
    expect(j).toMatchObject({ ok: true, source: "provider", usable: 1, total: 2 });
    // O reprovado NÃO some da resposta: a tela mostra por que ele não serve.
    expect(j.models.map((m: { id: string }) => m.id)).toContain("amazon.nova-pro-v1:0");
  });

  it("sem credencial digitada, lista com a GRAVADA no slot (a tela abre com os campos vazios)", async () => {
    slotRows = [{ priority: 2, credentials: { aws_access_key_id: "AKIA_SALVA", aws_region: "us-east-1" } }];
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/models",
      payload: { provider: "bedrock", priority: 2, credentials: {} } });
    expect(res.statusCode).toBe(200);
    expect(cat.chamadas[0].creds.aws_access_key_id).toBe("AKIA_SALVA");
  });

  it("credencial fora da whitelist do provider é descartada antes de sair daqui", async () => {
    await app.inject({ method: "POST", url: "/api/tenant/llm-config/models",
      payload: { provider: "anthropic", credentials: { api_key: "sk-ant-x", aws_secret_access_key: "vazando" } } });
    expect(cat.chamadas[0].creds).toEqual({ api_key: "sk-ant-x" });
  });

  it("agents indisponível → `unavailable`, não 500: o front mantém a lista que já tinha", async () => {
    cat.resposta = null;
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/models",
      payload: { provider: "foundry", credentials: {} } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, unavailable: true, provider: "foundry" });
  });

  it("provider inválido é recusado antes de virar chamada ao agents", async () => {
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/models",
      payload: { provider: "gpt-do-vizinho", credentials: {} } });
    expect(res.statusCode).toBe(400);
    expect(cat.chamadas).toHaveLength(0);
  });

  it("papel sem permissão não lista modelos de tenant nenhum", async () => {
    currentUser = { id: "u2", email: "b@x", role: "developer", tenantId: TENANT };
    const res = await app.inject({ method: "POST", url: "/api/tenant/llm-config/models",
      payload: { provider: "bedrock", credentials: {} } });
    expect(res.statusCode).toBe(403);
    expect(cat.chamadas).toHaveLength(0);
  });
});
