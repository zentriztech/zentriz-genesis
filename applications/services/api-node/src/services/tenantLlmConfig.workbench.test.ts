/**
 * tenantLlmConfig.workbench.test.ts — Bancada usa a MESMA config de LLM da fábrica (2026-09-04).
 * resolveWorkbenchLlm: projeto (autoridade do criador) > tenant; credenciais viajam no `llm_config`.
 *
 * ⚖️ LEI 2026-09-10 — não existe mais "default do env": sem slot UTILIZÁVEL a resolução lança
 * `LlmSlotNotConfiguredError`. E "utilizável" passou a exigir credencial PRÓPRIA do slot, salvo
 * tenant com `byoc_exempt` (autorizado, só por zentriz_admin, a rodar na conta da Zentriz).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let tenantRows: Record<string, unknown>[] = [];
let projectRows: Record<string, unknown>[] = [];
let zentrizRows: Record<string, unknown>[] = [];
const queryMock = vi.fn(async (sql: string, _params?: unknown[]) => {
  if (sql.includes("FROM tenant_llm_configs")) return { rows: tenantRows };
  if (sql.includes("FROM projects p JOIN users u")) return { rows: projectRows };
  if (sql.includes("FROM zentriz_llm_config")) return { rows: zentrizRows };
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({ pool: { query: (s: string, p?: unknown[]) => queryMock(s, p) } }));

import { resolveWorkbenchLlm, agentsLlmFields, LlmSlotNotConfiguredError, slotUsability } from "./tenantLlmConfig.js";

const TENANT_CFG = {
  provider: "bedrock", model_id: "us.anthropic.claude-opus-4-8", model_id_fallback: "us.anthropic.claude-opus-5",
  credentials: { aws_access_key_id: "AKIA_T", aws_secret_access_key: "SECRET_T", aws_region: "us-east-1" },
  max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, priority: 0,
  byoc_exempt: false,
};

beforeEach(() => { tenantRows = []; projectRows = []; zentrizRows = []; queryMock.mockClear(); });

describe("resolveWorkbenchLlm", () => {
  it("projeto de tenant → modelo, rework e credenciais do slot Padrão do tenant", async () => {
    projectRows = [{ tenant_id: TENANT, creator_role: "tenant_admin" }];
    tenantRows = [TENANT_CFG];
    const o = await resolveWorkbenchLlm({ projectId: PROJECT });
    expect(o.isDefault).toBe(false);
    expect(o.model_id).toBe("us.anthropic.claude-opus-4-8");
    expect(o.model_id_rework).toBe("us.anthropic.claude-opus-5");
    expect(o.llm_config).toEqual({
      provider: "bedrock", model: "us.anthropic.claude-opus-4-8",
      aws_access_key_id: "AKIA_T", aws_secret_access_key: "SECRET_T", aws_region: "us-east-1",
    });
    const f = agentsLlmFields(o);
    expect(f.model_id).toBe("us.anthropic.claude-opus-4-8");
    expect(f.llm_config).toBeTruthy();
  });

  // 🔴 Este era o VAZAMENTO medido em prod (2026-09-10): slot bedrock sem chave nenhuma passava como
  // válido e a chamada saía pela instance role da conta da Zentriz — com a tela dizendo "credenciais
  // configuradas". Agora o mesmo dado tem de FALHAR.
  it("bedrock sem credencial própria e tenant NÃO isento → lança em vez de rodar na conta da Zentriz", async () => {
    tenantRows = [{ ...TENANT_CFG, credentials: {} }];
    await expect(resolveWorkbenchLlm({ tenantId: TENANT })).rejects.toBeInstanceOf(LlmSlotNotConfiguredError);
  });

  it("bedrock sem credencial própria + byoc_exempt → roda (autorizado), e o slot se declara conta-Zentriz", async () => {
    tenantRows = [{ ...TENANT_CFG, credentials: {}, byoc_exempt: true }];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.model_id).toBe("us.anthropic.claude-opus-4-8");
    expect(o.llm_config).toEqual({ provider: "bedrock", model: "us.anthropic.claude-opus-4-8" });
    expect(slotUsability("bedrock", {}, true)).toEqual({
      usable: true, ownCredentials: false, usesZentrizAccount: true,
    });
  });

  it("projeto criado por zentriz_admin → slots da CONTA DE GESTÃO, com a credencial dela", async () => {
    projectRows = [{ tenant_id: TENANT, creator_role: "zentriz_admin" }];
    zentrizRows = [{ provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-6", priority: 0,
                     credentials: { aws_access_key_id: "AKIA_Z", aws_secret_access_key: "SECRET_Z" } }];
    const o = await resolveWorkbenchLlm({ projectId: PROJECT, tenantId: TENANT });
    expect(o.model_id).toBe("us.anthropic.claude-sonnet-4-6");
    expect(o.llm_config.aws_access_key_id).toBe("AKIA_Z");
  });

  /**
   * ⚖️ 2026-09-10 — a config da conta de gestão passou a exigir credencial PRÓPRIA, como a de
   * tenant. Antes, `credentials: {}` era aceito e a chamada saía pela identidade do container:
   * o mesmo default silencioso que a LEI matou do lado do tenant, sobrevivendo do lado de cá.
   */
  it("config da gestão SEM credencial própria não resolve — não há caminho para o env", async () => {
    projectRows = [{ tenant_id: TENANT, creator_role: "zentriz_admin" }];
    zentrizRows = [{ provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-6",
                     priority: 0, credentials: {} }];
    await expect(resolveWorkbenchLlm({ projectId: PROJECT, tenantId: TENANT }))
      .rejects.toBeInstanceOf(LlmSlotNotConfiguredError);
  });

  /**
   * A migration 126 abriu a fila 0..3 nesta tabela. O `LIMIT 1` sem `ORDER BY` que existia aqui
   * devolveria linha ARBITRÁRIA a partir da segunda — a contingência viraria principal por sorteio.
   */
  it("a fila da gestão é lida por prioridade, e a contingência vira candidata", async () => {
    projectRows = [{ tenant_id: TENANT, creator_role: "zentriz_admin" }];
    zentrizRows = [
      { provider: "foundry", model_id: "claude-opus-5", priority: 0,
        credentials: { foundry_api_key: "K0" } },
      { provider: "bedrock", model_id: "us.anthropic.claude-opus-4-6-v1", priority: 1,
        credentials: { aws_access_key_id: "AKIA_1", aws_secret_access_key: "S1" } },
    ];
    const o = await resolveWorkbenchLlm({ projectId: PROJECT, tenantId: TENANT });
    expect(o.model_id).toBe("claude-opus-5");
    expect(o.llm_candidates?.[1]).toMatchObject({ provider: "bedrock", aws_access_key_id: "AKIA_1" });
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("zentriz_llm_config") && s.includes("ORDER BY priority"))).toBe(true);
  });

  it("zentriz_admin dentro de um tenant COM slot → paga o tenant, não a Zentriz (ordem invertida em 2026-09-10)", async () => {
    projectRows = [{ tenant_id: TENANT, creator_role: "zentriz_admin" }];
    tenantRows  = [TENANT_CFG];
    zentrizRows = [{ provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-6", credentials: {} }];
    const o = await resolveWorkbenchLlm({ projectId: PROJECT, tenantId: TENANT });
    expect(o.model_id).toBe("us.anthropic.claude-opus-4-8"); // o do SLOT, não o global da Zentriz
  });

  it("sem projeto e sem tenant / sem slot → LANÇA (não existe mais default do env)", async () => {
    await expect(resolveWorkbenchLlm({})).rejects.toBeInstanceOf(LlmSlotNotConfiguredError);
    await expect(resolveWorkbenchLlm({ tenantId: TENANT })).rejects.toBeInstanceOf(LlmSlotNotConfiguredError);
  });

  // ── provider=foundry (2026-09-09): Claude servido pelo Azure AI Foundry ────────────────────
  it("foundry SEM credencial própria: a chave do container só serve o tenant ISENTO", async () => {
    process.env.ANTHROPIC_FOUNDRY_API_KEY = "chave-do-container";
    tenantRows = [{ ...TENANT_CFG, provider: "foundry", model_id: "claude-opus-5", credentials: {} }];
    // Sem isenção, herdar a chave do host é justamente pôr a fatura na Zentriz.
    await expect(resolveWorkbenchLlm({ tenantId: TENANT })).rejects.toBeInstanceOf(LlmSlotNotConfiguredError);

    tenantRows = [{ ...TENANT_CFG, provider: "foundry", model_id: "claude-opus-5", credentials: {}, byoc_exempt: true }];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.model_id).toBe("claude-opus-5");
    expect(o.llm_config).toEqual({ provider: "foundry", model: "claude-opus-5" });
    delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
  });

  it("foundry COM credencial própria (BYOC) → viaja com os nomes que _build_foundry_client procura", async () => {
    tenantRows = [{
      ...TENANT_CFG, provider: "foundry", model_id: "claude-opus-5",
      credentials: { foundry_api_key: "k-tenant", foundry_resource: "recurso-do-tenant" },
    }];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.llm_config).toEqual({
      provider: "foundry", model: "claude-opus-5",
      foundry_api_key: "k-tenant", foundry_resource: "recurso-do-tenant",
    });
  });

  it("slot Padrão sem credencial própria → é PULADO e a Contingência COM chave assume", async () => {
    delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
    tenantRows = [
      { ...TENANT_CFG, provider: "foundry", model_id: "claude-opus-5", credentials: {}, priority: 0 },
      { ...TENANT_CFG, provider: "bedrock", model_id: "us.anthropic.claude-sonnet-5", priority: 1 },
    ];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.model_id).toBe("us.anthropic.claude-sonnet-5");
    expect(o.llm_config.provider).toBe("bedrock");
  });

  it("slot sem model_id não é utilizável — não se chama um provider sem dizer o modelo", async () => {
    tenantRows = [
      { ...TENANT_CFG, model_id: "", priority: 0 },
      { ...TENANT_CFG, model_id: "us.anthropic.claude-sonnet-5", priority: 1 },
    ];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.model_id).toBe("us.anthropic.claude-sonnet-5");
  });

  it("provider não-bedrock com api_key → api_key no llm_config; falha de banco NÃO vira default silencioso", async () => {
    tenantRows = [{ ...TENANT_CFG, provider: "anthropic", model_id: "claude-opus-5", credentials: { api_key: "sk-x" } }];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.llm_config).toEqual({ provider: "anthropic", model: "claude-opus-5", api_key: "sk-x" });
    // Antes, banco fora do ar degradava para o env (conta da Zentriz). Agora propaga o erro.
    queryMock.mockRejectedValueOnce(new Error("db down"));
    await expect(resolveWorkbenchLlm({ projectId: PROJECT })).rejects.toThrow();
  });
});

// ── Slot Google (Vertex AI) — 2026-09-10 ─────────────────────────────────────
// O crédito do Google paga o Vertex; as credenciais do Vertex têm de CHEGAR ao envelope dos
// agentes, senão o slot resolve, a Bancada acha que está tudo certo e o run cai sem auth.
describe("resolveWorkbenchLlm — slot google", () => {
  const GOOGLE_CFG = {
    provider: "google", model_id: "gemini-2.5-pro", model_id_fallback: null,
    credentials: { google_api_key: "AIza-x" },
    max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, priority: 0,
  };
  const SA = '{"type":"service_account","project_id":"p"}';

  it("modo chave → google_api_key viaja no llm_config (e NÃO como api_key genérico)", async () => {
    tenantRows = [GOOGLE_CFG];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.llm_config).toEqual({
      provider: "google", model: "gemini-2.5-pro", google_api_key: "AIza-x",
    });
    expect((o.llm_config as Record<string, unknown>).api_key).toBeUndefined();
  });

  it("modo Vertex → projeto, região e service account chegam ao envelope", async () => {
    tenantRows = [{ ...GOOGLE_CFG, model_id: "claude-sonnet-4-5@20250929",
      credentials: { vertex_project_id: "meu-projeto", vertex_location: "us-east5", vertex_service_account_json: SA } }];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.model_id).toBe("claude-sonnet-4-5@20250929");
    expect(o.llm_config).toEqual({
      provider: "google", model: "claude-sonnet-4-5@20250929",
      vertex_project_id: "meu-projeto", vertex_location: "us-east5", vertex_service_account_json: SA,
    });
  });

  it("slot google sem credencial própria → é PULADO, cascateia para a contingência", async () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_VERTEX_PROJECT;
    tenantRows = [
      { ...GOOGLE_CFG, credentials: {} },
      { provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-6", priority: 1,
        credentials: { aws_access_key_id: "AKIA_T", aws_secret_access_key: "SECRET_T" } },
    ];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.model_id).toBe("us.anthropic.claude-sonnet-4-6");
  });

  // `vertex_project_id` sozinho não autentica nada — era aceito antes e resolvia um slot que
  // quebraria na primeira chamada.
  it("modo Vertex só com project_id (sem service account) → NÃO é utilizável", async () => {
    tenantRows = [{ ...GOOGLE_CFG, credentials: { vertex_project_id: "meu-projeto" } }];
    await expect(resolveWorkbenchLlm({ tenantId: TENANT })).rejects.toBeInstanceOf(LlmSlotNotConfiguredError);
  });
});

// ── Cascata de slots — ⚖️ Jean, 2026-09-10 ───────────────────────────────────
// *"sempre testando se funciona e em caso de nao funcionar testa o proximo"*.
// A fila viaja no MESMO envelope que já ia para os agentes (`llm_candidates`), porque o ponto de
// falha que interessa não é resolver o slot — é a CHAMADA. E como cada slot tem credencial
// própria, a contingência precisa ir inteira: trocar de modelo sem trocar de chave chamaria o
// modelo do slot 2 na conta do slot 1.
describe("resolveWorkbenchLlm — fila de contingências (llm_candidates)", () => {
  it("um único slot utilizável → NÃO emite `llm_candidates` (uma tentativa, como sempre foi)", async () => {
    tenantRows = [TENANT_CFG];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.llm_candidates).toBeUndefined();
    expect(agentsLlmFields(o).llm_candidates).toBeUndefined();
  });

  it("dois slots utilizáveis → fila na ORDEM das prioridades, cada um com sua credencial", async () => {
    tenantRows = [
      TENANT_CFG,
      { ...TENANT_CFG, provider: "foundry", model_id: "claude-opus-5", model_id_fallback: null,
        credentials: { foundry_api_key: "k-tenant", foundry_resource: "r" }, priority: 1 },
    ];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    // O escolhido continua no topo: nenhum consumidor de `model_id`/`llm_config` muda.
    expect(o.model_id).toBe("us.anthropic.claude-opus-4-8");
    expect(o.llm_candidates).toHaveLength(2);
    expect(o.llm_candidates![0]).toMatchObject({
      provider: "bedrock", model: "us.anthropic.claude-opus-4-8",
      aws_access_key_id: "AKIA_T", model_rework: "us.anthropic.claude-opus-5",
    });
    expect(o.llm_candidates![1]).toMatchObject({
      provider: "foundry", model: "claude-opus-5", foundry_api_key: "k-tenant",
    });
    // A credencial do slot 1 NÃO pode vazar para o candidato 2 (seria fatura no lugar errado).
    expect(o.llm_candidates![1].aws_access_key_id).toBeUndefined();
    expect(agentsLlmFields(o).llm_candidates).toHaveLength(2);
  });

  it("slot sem credencial não entra na fila — contingência inutilizável não é contingência", async () => {
    delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
    tenantRows = [
      TENANT_CFG,
      { ...TENANT_CFG, provider: "foundry", model_id: "claude-opus-5", credentials: {}, priority: 1 },
    ];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.llm_candidates).toBeUndefined();
  });
});

// ── Slot Azure OpenAI — 2026-09-10 ───────────────────────────────────────────
// No Azure a chamada é endereçada por endpoint + deployment + api-version. Se esses campos não
// chegam ao envelope, o agente cai no ramo genérico e chama a API pública da Anthropic.
describe("resolveWorkbenchLlm — slot azure_openai", () => {
  it("endpoint, deployment e api-version do slot chegam ao llm_config", async () => {
    tenantRows = [{
      provider: "azure_openai", model_id: "gpt-4o", model_id_fallback: null,
      credentials: { api_key: "az-key", endpoint: "https://x.openai.azure.com",
                     deployment_name: "meu-gpt4o", api_version: "2024-02-01" },
      max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, priority: 0,
    }];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.llm_config).toEqual({
      provider: "azure_openai", model: "gpt-4o", api_key: "az-key",
      azure_endpoint: "https://x.openai.azure.com",
      azure_deployment: "meu-gpt4o", azure_api_version: "2024-02-01",
    });
  });
});
