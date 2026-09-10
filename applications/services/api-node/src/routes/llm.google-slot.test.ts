/**
 * llm.google-slot.test.ts — o slot `google` existe e carrega as credenciais do **Vertex AI**,
 * não só a chave da Gemini API. O crédito do Google paga o Vertex, cujo Model Garden revende
 * Claude/Llama/Mistral — então o slot precisa aceitar essas famílias, e não apenas Gemini.
 *
 * Guarda três coisas que já quebraram em outros providers:
 *  1. provider novo aceito pela allow-list (senão o PUT devolve 400 e a tela não salva);
 *  2. campos de credencial na whitelist do `sanitizeCredentials` (fora dela são DESCARTADOS
 *     em silêncio — a tela salva "ok" e o run não acha a service account);
 *  3. `has_credentials` reconhece o modo Vertex (só projeto, sem `google_api_key`), senão o
 *     slot seria pulado como "sem credencial" e cairia na contingência sem ninguém pedir.
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
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_VERTEX_PROJECT;
  currentUser = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT };
  app = Fastify(); await app.register(llmRoutes); await app.ready();
});

const savedCreds = () => JSON.parse(String(upserts[0][5])) as Record<string, string>;

const SA_JSON = '{"type":"service_account","project_id":"p"}';

describe("slot google — provider e credenciais do Vertex AI", () => {
  it("aceita provider google e persiste as credenciais do modo Vertex", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/1",
      payload: { provider: "google", model_id: "gemini-2.5-pro",
        credentials: { vertex_project_id: "meu-projeto", vertex_location: "us-east5",
                       vertex_service_account_json: SA_JSON } } });
    expect(res.statusCode).toBe(200);
    expect(savedCreds()).toEqual({
      vertex_project_id: "meu-projeto", vertex_location: "us-east5", vertex_service_account_json: SA_JSON,
    });
    expect(res.json().has_credentials).toBe(true);
  });

  it("modo chave simples (Gemini API) também vale como credencial", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/1",
      payload: { provider: "google", model_id: "gemini-2.5-flash", credentials: { google_api_key: "AIza-x" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().has_credentials).toBe(true);
  });

  // ⚖️ LEI 2026-09-10: a resposta do PUT fala do SLOT, não do host. Herdar a credencial do
  // container é justamente rodar na conta da Zentriz — não pode ser reportado como "configurado".
  it("slot google VAZIO NÃO vira 'configurado' por causa da credencial do container", async () => {
    process.env.GOOGLE_VERTEX_PROJECT = "projeto-do-host";
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/2",
      payload: { provider: "google", model_id: "gemini-2.5-pro", credentials: {} } });
    expect(res.statusCode).toBe(200);
    expect(res.json().own_credentials).toBe(false);
    expect(res.json().has_credentials).toBe(false);
  });

  // `vertex_project_id` sozinho não autentica: o modo Vertex exige o par projeto + service account.
  it("só o project_id do Vertex, sem service account → não é credencial própria", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/2",
      payload: { provider: "google", model_id: "gemini-2.5-pro",
        credentials: { vertex_project_id: "meu-projeto" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().own_credentials).toBe(false);
  });

  it("sem credencial nenhuma (nem no slot, nem no host) → has_credentials false", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/2",
      payload: { provider: "google", model_id: "gemini-2.5-pro", credentials: {} } });
    expect(res.statusCode).toBe(200);
    expect(res.json().has_credentials).toBe(false);
  });

  it("aceita modelo do Model Garden (família de terceiros paga pelo crédito Google)", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/1",
      payload: { provider: "google", model_id: "claude-sonnet-4-5@20250929",
        credentials: { vertex_project_id: "p", vertex_service_account_json: SA_JSON } } });
    expect(res.statusCode).toBe(200);
    expect(upserts[0][3]).toBe("claude-sonnet-4-5@20250929");
  });

  it("credencial de OUTRO provider é descartada no slot google", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/1",
      payload: { provider: "google", model_id: "gemini-2.5-pro",
        credentials: { google_api_key: "AIza-x", aws_secret_access_key: "SECRET", foundry_api_key: "fk" } } });
    expect(res.statusCode).toBe(200);
    expect(savedCreds()).toEqual({ google_api_key: "AIza-x" });
  });

  // ⚖️ LEI 2026-09-10 — este teste travava o comportamento CONTRÁRIO ("model_id omitido → default
  // do provider google" gravava `gemini-2.5-pro`). Um modelo escolhido pela Zentriz e cobrado do
  // tenant: entre haiku-class e opus-class há uma ordem de grandeza de custo. Agora falha alto.
  it("model_id omitido → 400, sem gravar modelo escolhido pela plataforma", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/1",
      payload: { provider: "google", credentials: { google_api_key: "AIza-x" } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/model_id/);
    expect(upserts).toHaveLength(0);
  });

  it("provider omitido → 400 (o `?? \"bedrock\"` decidia a nuvem do cliente por omissão)", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/tenant/llm-config/1",
      payload: { model_id: "gemini-2.5-pro", credentials: { google_api_key: "AIza-x" } } });
    expect(res.statusCode).toBe(400);
    expect(upserts).toHaveLength(0);
  });
});
