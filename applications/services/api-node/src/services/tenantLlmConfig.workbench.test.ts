/**
 * tenantLlmConfig.workbench.test.ts — Bancada usa a MESMA config de LLM da fábrica (2026-09-04).
 * resolveWorkbenchLlm: projeto (autoridade do criador) > tenant > default do env; credenciais viajam
 * no `llm_config`; default do env = campos omitidos (agents seguem no próprio env).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let tenantRows: Record<string, unknown>[] = [];
let projectRows: Record<string, unknown>[] = [];
let zentrizRows: Record<string, unknown>[] = [];
const queryMock = vi.fn(async (sql: string) => {
  if (sql.includes("FROM tenant_llm_configs")) return { rows: tenantRows };
  if (sql.includes("FROM projects p JOIN users u")) return { rows: projectRows };
  if (sql.includes("FROM zentriz_llm_config")) return { rows: zentrizRows };
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({ pool: { query: (s: string, p?: unknown[]) => queryMock(s, p) } }));

import { resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";

const TENANT_CFG = {
  provider: "bedrock", model_id: "us.anthropic.claude-opus-4-8", model_id_fallback: "us.anthropic.claude-opus-5",
  credentials: { aws_access_key_id: "AKIA_T", aws_secret_access_key: "SECRET_T", aws_region: "us-east-1" },
  max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, priority: 0,
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

  it("tenant sem credenciais próprias (bedrock) → modelo do tenant, SEM chaves no llm_config (identidade do host)", async () => {
    tenantRows = [{ ...TENANT_CFG, credentials: {} }];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.model_id).toBe("us.anthropic.claude-opus-4-8");
    expect(o.llm_config).toEqual({ provider: "bedrock", model: "us.anthropic.claude-opus-4-8" });
  });

  it("projeto criado por zentriz_admin → config global da Zentriz", async () => {
    projectRows = [{ tenant_id: TENANT, creator_role: "zentriz_admin" }];
    zentrizRows = [{ provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-6", credentials: {} }];
    const o = await resolveWorkbenchLlm({ projectId: PROJECT, tenantId: TENANT });
    expect(o.model_id).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("sem projeto e sem tenant / sem config → default do env: campos OMITIDOS", async () => {
    const o = await resolveWorkbenchLlm({});
    expect(o.isDefault).toBe(true);
    expect(agentsLlmFields(o)).toEqual({});
    const o2 = await resolveWorkbenchLlm({ tenantId: TENANT }); // sem linhas → SYSTEM_DEFAULT
    expect(o2.isDefault).toBe(true);
  });

  it("provider não-bedrock com api_key → api_key no llm_config; nunca lança em erro de banco", async () => {
    tenantRows = [{ ...TENANT_CFG, provider: "anthropic", model_id: "claude-opus-5", credentials: { api_key: "sk-x" } }];
    const o = await resolveWorkbenchLlm({ tenantId: TENANT });
    expect(o.llm_config).toEqual({ provider: "anthropic", model: "claude-opus-5", api_key: "sk-x" });
    queryMock.mockRejectedValueOnce(new Error("db down"));
    const o2 = await resolveWorkbenchLlm({ projectId: PROJECT });
    expect(o2.isDefault).toBe(true);
  });
});
