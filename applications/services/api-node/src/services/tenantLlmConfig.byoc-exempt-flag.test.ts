/**
 * tenantLlmConfig.byoc-exempt-flag.test.ts — T1 (executor × LEI dos slots).
 *
 * `resolveProjectLlmCandidates` precisa carregar `tenants.byoc_exempt` (a MESMA fonte de
 * `slotUsability`) até o `ResolvedLlmConfig` que a rota interna entrega ao runner/executor.
 * Sem isto o executor não tem como distinguir "tenant isento" de "tenant sem chave".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "33333333-3333-4333-8333-333333333333";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let tenantRows: Record<string, unknown>[] = [];
const queryMock = vi.fn(async (sql: string) => {
  if (sql.includes("FROM tenant_llm_configs")) return { rows: tenantRows };
  if (sql.includes("FROM projects p JOIN users u")) return { rows: [{ tenant_id: TENANT, creator_role: "tenant_admin" }] };
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({ pool: { query: (s: string) => queryMock(s) } }));

import { resolveProjectLlmCandidates, LlmSlotNotConfiguredError } from "./tenantLlmConfig.js";

const bedrockSemChave = (byoc: boolean) => ({
  provider: "bedrock", model_id: "us.anthropic.claude-opus-5-5", model_id_fallback: null, credentials: {},
  max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, priority: 0, byoc_exempt: byoc,
});
const bedrockComChave = (byoc: boolean) => ({
  ...bedrockSemChave(byoc),
  credentials: { aws_access_key_id: "AKIA_X", aws_secret_access_key: "SEC_X", aws_region: "us-west-2" },
});

beforeEach(() => { tenantRows = []; queryMock.mockClear(); });

describe("byocExempt chega ao slot resolvido", () => {
  it("tenant isento + Bedrock sem chave ⇒ slot utilizável com byocExempt=true", async () => {
    tenantRows = [bedrockSemChave(true)];
    const [cfg] = await resolveProjectLlmCandidates(PROJECT);
    expect(cfg.byocExempt).toBe(true);
    expect(cfg.awsAccessKeyId).toBeUndefined();
  });

  it("tenant NÃO isento + Bedrock sem chave ⇒ continua lançando (fail-closed, nenhuma porta da Zentriz)", async () => {
    tenantRows = [bedrockSemChave(false)];
    await expect(resolveProjectLlmCandidates(PROJECT)).rejects.toBeInstanceOf(LlmSlotNotConfiguredError);
  });

  it("tenant não isento com chave própria ⇒ sem byocExempt e chaves do slot preservadas", async () => {
    tenantRows = [bedrockComChave(false)];
    const [cfg] = await resolveProjectLlmCandidates(PROJECT);
    expect(cfg.byocExempt).toBeFalsy();
    expect(cfg.awsAccessKeyId).toBe("AKIA_X");
  });
});
