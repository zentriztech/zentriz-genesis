/**
 * tenantLlmConfig.strongest.test.ts — ⚖️ Jean, 2026-09-10:
 * *"cyborg usa sempre o melhor modelo entre os cadastrados nos slots"*.
 *
 * O que estes testes travam:
 *  · `strategy: "strongest"` NÃO obedece à ordem do tenant quando há dominância medida;
 *  · mas NÃO inventa ordem entre marcas — aí quem desempata é a prioridade do tenant;
 *  · a credencial que viaja é a DO SLOT VENCEDOR (trocar de slot troca de fatura — se o envelope
 *    continuasse sendo o do slot 0, o Cyborg pediria um id de outra família ao provider errado,
 *    que é o defeito do "Grupo C" um nível acima);
 *  · sem slot utilizável continua lançando — a estratégia muda o CRITÉRIO, nunca a FONTE.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let tenantRows: Record<string, unknown>[] = [];
let projectRows: Record<string, unknown>[] = [];
const queryMock = vi.fn(async (sql: string) => {
  if (sql.includes("FROM tenant_llm_configs")) return { rows: tenantRows };
  if (sql.includes("FROM projects p JOIN users u")) return { rows: projectRows };
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({ pool: { query: (s: string) => queryMock(s) } }));

import { resolveProjectLlmConfig, LlmSlotNotConfiguredError } from "./tenantLlmConfig.js";
import { strongestByDomination } from "./reviewerModel.js";

const foundry = (model: string, priority: number) => ({
  provider: "foundry", model_id: model, model_id_fallback: null,
  credentials: { foundry_api_key: `KEY-FOUNDRY-P${priority}` },
  max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0,
  priority, byoc_exempt: false,
});
const google = (model: string, priority: number) => ({
  provider: "google", model_id: model, model_id_fallback: null,
  credentials: { google_api_key: `KEY-GOOGLE-P${priority}` },
  max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0,
  priority, byoc_exempt: false,
});

beforeEach(() => {
  tenantRows = []; projectRows = [{ tenant_id: TENANT, creator_role: "tenant_admin" }];
  queryMock.mockClear();
});

describe("strongestByDomination — só a relação MEDIDA elimina", () => {
  it("dentro da família, a faixa menor cai", () => {
    const r = strongestByDomination(["claude-haiku-4-5", "claude-opus-5"]);
    expect(r.winners).toEqual(["claude-opus-5"]);
    expect(r.eliminados[0]).toContain("claude-haiku-4-5");
  });

  it("entre marcas, a variante PEQUENA cai contra uma não-pequena", () => {
    expect(strongestByDomination(["gemini-2.5-flash", "claude-opus-5"]).winners).toEqual(["claude-opus-5"]);
  });

  it("entre marcas sem sinal de porte NÃO há ordem — os dois sobrevivem", () => {
    // Afirmar "opus-5 > gemini-3-pro" (ou o contrário) seria inventar precisão: nenhum dado ordena.
    expect(strongestByDomination(["claude-opus-5", "gemini-3-pro"]).winners)
      .toEqual(["claude-opus-5", "gemini-3-pro"]);
  });

  it("id que não sabemos ranquear sobrevive — 'não sei' nunca vira 'é fraco'", () => {
    expect(strongestByDomination(["modelo-interno-xyz", "claude-opus-5"]).winners)
      .toEqual(["modelo-interno-xyz", "claude-opus-5"]);
  });
});

describe("resolveProjectLlmConfig — strategy strongest (o Cyborg)", () => {
  it("haiku na prioridade 0 e opus na 1 → o Cyborg sobe para o opus", async () => {
    tenantRows = [foundry("claude-haiku-4-5", 0), foundry("claude-opus-5", 1)];

    const padrao = await resolveProjectLlmConfig(PROJECT);
    expect(padrao.modelId).toBe("claude-haiku-4-5");   // Bancada/Fábrica seguem a ORDEM do tenant
    expect(padrao.selection).toBeUndefined();

    const cyborg = await resolveProjectLlmConfig(PROJECT, { strategy: "strongest" });
    expect(cyborg.modelId).toBe("claude-opus-5");
    expect(cyborg.selection?.strategy).toBe("strongest");
    expect(cyborg.selection?.slotModels).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    expect(cyborg.selection?.why).toContain("claude-opus-5");
  });

  it("a CREDENCIAL que viaja é a do slot vencedor, não a do slot 0", async () => {
    // O ponto financeiro da LEI: trocar de slot troca de fatura. Levar o modelo de um slot com a
    // chave de outro seria 400 (provider errado) ou, pior, consumo na credencial errada.
    tenantRows = [foundry("claude-haiku-4-5", 0), google("gemini-3-pro", 1)];
    const cyborg = await resolveProjectLlmConfig(PROJECT, { strategy: "strongest" });
    expect(cyborg.modelId).toBe("gemini-3-pro");
    expect(cyborg.provider).toBe("google");
    expect(cyborg.googleApiKey).toBe("KEY-GOOGLE-P1");
    expect(cyborg.foundryApiKey).toBeUndefined();
  });

  it("empate sem ordem conhecida → vence a prioridade do TENANT (não uma nota nossa)", async () => {
    tenantRows = [google("gemini-3-pro", 0), foundry("claude-opus-5", 1)];
    const c = await resolveProjectLlmConfig(PROJECT, { strategy: "strongest" });
    expect(c.modelId).toBe("gemini-3-pro");
    expect(c.selection?.why).toContain("desempatou pela ordem do tenant");

    // Reordenar na tela muda a escolha na hora, sem deploy — é a "reflexão dinâmica" pedida.
    tenantRows = [foundry("claude-opus-5", 0), google("gemini-3-pro", 1)];
    expect((await resolveProjectLlmConfig(PROJECT, { strategy: "strongest" })).modelId).toBe("claude-opus-5");
  });

  it("slot mais forte SEM credencial própria não é candidato (a LEI vem antes da força)", async () => {
    // Um opus que só roda na conta da Zentriz não é "o melhor": é o que a lei proíbe.
    tenantRows = [
      google("gemini-3-pro", 0),
      { ...foundry("claude-opus-5", 1), credentials: {} },
    ];
    const c = await resolveProjectLlmConfig(PROJECT, { strategy: "strongest" });
    expect(c.modelId).toBe("gemini-3-pro");
    expect(c.selection?.slotModels).toEqual(["gemini-3-pro"]);
  });

  it("sem slot utilizável, `strongest` falha alto igual ao padrão", async () => {
    tenantRows = [];
    await expect(resolveProjectLlmConfig(PROJECT, { strategy: "strongest" }))
      .rejects.toBeInstanceOf(LlmSlotNotConfiguredError);
  });
});
