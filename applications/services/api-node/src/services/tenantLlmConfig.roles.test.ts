/**
 * tenantLlmConfig.roles.test.ts — plano v2, 2A.3: `ResolvedLlmConfig.models` só existe com
 * LLM_ROLES_MODE != off. Com `off` o objeto resolvido, o SQL de leitura e o payload para
 * agents/runner são idênticos aos de antes (snapshot literal).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPUS48 = "us.anthropic.claude-opus-4-8";
const SONNET = "us.anthropic.claude-sonnet-4-6";
const HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0";

const sqls: string[] = [];
let tenantRows: Record<string, unknown>[] = [];
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string) => {
      sqls.push(sql);
      if (sql.includes("FROM tenant_llm_configs")) return { rows: tenantRows };
      if (sql.includes("FROM projects p JOIN users u")) return { rows: [{ tenant_id: TENANT, creator_role: "tenant_admin" }] };
      return { rows: [] };
    },
  },
}));

import { resolveProjectLlmCandidates, resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";

const ROW = {
  provider: "bedrock", model_id: SONNET, model_id_fallback: OPUS48,
  credentials: { aws_access_key_id: "AKIA_T", aws_secret_access_key: "SECRET_T", aws_region: "us-east-1" },
  max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, priority: 0, byoc_exempt: false,
};
const WITH_ROLES = { ...ROW, model_orchestrator: SONNET, model_advisor: OPUS48, model_staff: HAIKU };

/** Resolvido como era ANTES da 2A.3 — lista LITERAL de chaves e valores. */
const RESOLVIDO_ANTES = {
  provider: "bedrock", modelId: SONNET, fallbackModelId: OPUS48, apiKey: "",
  awsRegion: "us-east-1", awsAccessKeyId: "AKIA_T", awsSecretAccessKey: "SECRET_T",
  foundryApiKey: undefined, foundryResource: undefined, foundryBaseUrl: undefined,
  googleApiKey: undefined, googleBaseUrl: undefined, vertexProjectId: undefined, vertexLocation: undefined,
  vertexServiceAccountJson: undefined, azureEndpoint: undefined, azureDeployment: undefined, azureApiVersion: undefined,
  isDefault: false, priority: 0,
};

beforeEach(() => { sqls.length = 0; tenantRows = [ROW]; });
afterEach(() => { delete process.env.LLM_ROLES_MODE; });

describe("LLM_ROLES_MODE=off — objeto resolvido e payload byte-idênticos", () => {
  for (const mode of [undefined, "off"]) {
    it(`mode=${String(mode)}: resolução sem a chave 'models' e SQL de leitura sem colunas novas`, async () => {
      if (mode === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = mode;
      tenantRows = [WITH_ROLES]; // mesmo que o banco tenha as colunas, a flag off as ignora
      const [cfg] = await resolveProjectLlmCandidates(PROJECT);
      expect(cfg).toStrictEqual(RESOLVIDO_ANTES);
      expect(Object.keys(cfg)).not.toContain("models");
      expect(sqls.some((s) => /model_orchestrator|model_advisor|model_staff/.test(s))).toBe(false);
      const payload = agentsLlmFields(await resolveWorkbenchLlm({ projectId: PROJECT }));
      expect(payload).toStrictEqual({
        guard_project_id: PROJECT, model_id: SONNET, model_id_rework: OPUS48,
        llm_config: { provider: "bedrock", model: SONNET, aws_access_key_id: "AKIA_T",
                      aws_secret_access_key: "SECRET_T", aws_region: "us-east-1" },
      });
    });
  }
});

describe("LLM_ROLES_MODE=shadow|on — models presente, payload dos agents inalterado", () => {
  for (const mode of ["shadow", "on"]) {
    it(`${mode}: models = {orchestrator, advisor, staff}; envelope para agents continua o mesmo`, async () => {
      process.env.LLM_ROLES_MODE = mode;
      tenantRows = [WITH_ROLES];
      const [cfg] = await resolveProjectLlmCandidates(PROJECT);
      expect(cfg.models).toEqual({ orchestrator: SONNET, advisor: OPUS48, staff: HAIKU });
      expect({ ...cfg, models: undefined }).toStrictEqual({ ...RESOLVIDO_ANTES, models: undefined });
      expect(sqls.some((s) => /model_staff/.test(s))).toBe(true);
      const payload = agentsLlmFields(await resolveWorkbenchLlm({ projectId: PROJECT }));
      expect(JSON.stringify(payload)).not.toMatch(/models|advisor|staff/);
    });
  }

  it("fallback == principal ⇒ Advisor null; colunas novas vazias não quebram (legado autoritativo)", async () => {
    process.env.LLM_ROLES_MODE = "on";
    tenantRows = [{ ...ROW, model_id: OPUS48, model_id_fallback: OPUS48 }];
    const [cfg] = await resolveProjectLlmCandidates(PROJECT);
    expect(cfg.models).toEqual({ orchestrator: OPUS48, advisor: null, staff: null });
  });
});
