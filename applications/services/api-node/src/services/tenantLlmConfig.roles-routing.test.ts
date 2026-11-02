/**
 * tenantLlmConfig.roles-routing.test.ts — plano v2, 2A.4/2A.5 (lado api-node).
 *
 * Contrato de transporte por papel, ADITIVO e VERSIONADO (`roles_contract_version`):
 *  - `off` e `shadow`: envelope byte-idêntico ao legado (fixture `llm_roles_envelope_legacy.json`);
 *  - `on`: legado + campos novos (fixture `llm_roles_envelope_v1.json`); retirados os campos novos,
 *    sobra EXATAMENTE o legado — por isso um consumidor antigo continua funcionando;
 *  - os 3 papéis compartilham a credencial do slot (nenhuma credencial replicada por papel).
 * As MESMAS fixtures são lidas pelos testes de contrato do Python (`tests/test_llm_roles_contract.py`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPUS48 = "us.anthropic.claude-opus-4-8";
const SONNET = "us.anthropic.claude-sonnet-4-6";
const HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0";

let tenantRows: Record<string, unknown>[] = [];
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string) => {
      if (sql.includes("FROM tenant_llm_configs")) return { rows: tenantRows };
      if (sql.includes("FROM projects p JOIN users u")) return { rows: [{ tenant_id: TENANT, creator_role: "tenant_admin" }] };
      return { rows: [] };
    },
  },
}));

import { resolveProjectLlmCandidates, resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";
import { requiredRoleFor, resolveRoleModel, rolesRoutingOn } from "../lib/llmRoleSlots.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../orchestrator/tests/fixtures");
const CREDS = (n: string) => ({ aws_access_key_id: `AKIA_FAKE_${n}`, aws_secret_access_key: `SECRET_FAKE_${n}`, aws_region: "us-east-1" });
const base = { provider: "bedrock", max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, byoc_exempt: false };
const SLOT0 = { ...base, priority: 0, model_id: SONNET, model_id_fallback: OPUS48, credentials: CREDS("0"),
  model_orchestrator: SONNET, model_advisor: OPUS48, model_staff: HAIKU };
const SONNET45 = "us.anthropic.claude-sonnet-4-5";
const SLOT1 = { ...base, priority: 1, model_id: SONNET45, model_id_fallback: null, credentials: CREDS("1"),
  model_orchestrator: SONNET45, model_advisor: null, model_staff: null };

const ROLE_KEYS = ["roles_contract_version", "models"];
function stripRoles(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  for (const k of ROLE_KEYS) delete out[k];
  if (Array.isArray(out.llm_candidates)) {
    out.llm_candidates = (out.llm_candidates as Record<string, unknown>[]).map((c) => {
      const { models: _m, ...rest } = c; return rest;
    });
  }
  return out;
}
const fixture = (n: string) => JSON.parse(readFileSync(`${FIX}/${n}`, "utf8"));
const wire = (o: unknown) => JSON.parse(JSON.stringify(o)); // o que realmente vai no JSON do HTTP

async function envelope() {
  return wire(agentsLlmFields(await resolveWorkbenchLlm({ projectId: PROJECT })));
}

beforeEach(() => { tenantRows = [SLOT0, SLOT1]; });
afterEach(() => { delete process.env.LLM_ROLES_MODE; });

describe("2A.5 — envelope api → agents", () => {
  it("off e shadow: IDÊNTICO ao legado (sem roles_contract_version, sem models)", async () => {
    for (const mode of ["off", undefined, "shadow"]) {
      if (mode === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = mode;
      const env = await envelope();
      if (process.env.UPDATE_FIXTURES === "1" && mode === "off") {
        writeFileSync(`${FIX}/llm_roles_envelope_legacy.json`, JSON.stringify(env, null, 2) + "\n");
      }
      expect(env).toStrictEqual(fixture("llm_roles_envelope_legacy.json"));
      expect(JSON.stringify(env)).not.toMatch(/roles_contract_version|"models"|"staff"|"advisor"/);
    }
  });

  it("on: envelope = fixture v1; sem os campos novos sobra EXATAMENTE o legado", async () => {
    process.env.LLM_ROLES_MODE = "on";
    const env = await envelope();
    if (process.env.UPDATE_FIXTURES === "1") {
      writeFileSync(`${FIX}/llm_roles_envelope_v1.json`, JSON.stringify(env, null, 2) + "\n");
    }
    expect(env).toStrictEqual(fixture("llm_roles_envelope_v1.json"));
    expect(env.roles_contract_version).toBe(1);
    expect(env.models).toEqual({ orchestrator: SONNET, advisor: OPUS48, staff: HAIKU });
    expect(stripRoles(env)).toStrictEqual(fixture("llm_roles_envelope_legacy.json"));
    // o par legado continua presente (agents antigos leem `model_id_rework`)
    expect(env.model_id_rework).toBe(OPUS48);
  });

  it("on: contingência carrega os modelos do PRÓPRIO slot (Advisor vazio ⇒ null) e nada de credencial por papel", async () => {
    process.env.LLM_ROLES_MODE = "on";
    const env = await envelope();
    expect(env.llm_candidates).toHaveLength(2);
    expect(env.llm_candidates[1].models).toEqual({ orchestrator: SONNET45, advisor: null, staff: null });
    const modelsJson = JSON.stringify([env.models, ...env.llm_candidates.map((c: { models: unknown }) => c.models)]);
    expect(modelsJson).not.toMatch(/AKIA|SECRET|api_key|aws_|credential/i);
    // uma credencial por slot: o envelope de cada candidato tem as chaves AWS UMA vez, sem sufixo de papel
    for (const c of env.llm_candidates) {
      expect(Object.keys(c).filter((k) => /advisor|staff|orchestrator/i.test(k))).toEqual([]);
    }
  });

  it("on com slot SEM colunas de papel (legado autoritativo): models derivado do legado; Staff null", async () => {
    process.env.LLM_ROLES_MODE = "on";
    tenantRows = [{ ...SLOT0, model_orchestrator: null, model_advisor: null, model_staff: null }, SLOT1];
    const env = await envelope();
    expect(env.models).toEqual({ orchestrator: SONNET, advisor: OPUS48, staff: null });
  });
});

describe("2A.5 — /api/internal/project-llm-config (runner)", () => {
  it("on: resposta traz roles_contract_version + models; shadow: models sem versão; off: nenhum", async () => {
    process.env.LLM_ROLES_MODE = "on";
    let [cfg] = await resolveProjectLlmCandidates(PROJECT);
    expect(wire(cfg).roles_contract_version).toBe(1);
    expect(wire(cfg).models).toEqual({ orchestrator: SONNET, advisor: OPUS48, staff: HAIKU });
    process.env.LLM_ROLES_MODE = "shadow";
    [cfg] = await resolveProjectLlmCandidates(PROJECT);
    expect(wire(cfg).roles_contract_version).toBeUndefined();
    expect(wire(cfg).models).toBeDefined();
    process.env.LLM_ROLES_MODE = "off";
    [cfg] = await resolveProjectLlmCandidates(PROJECT);
    expect(Object.keys(wire(cfg))).not.toContain("models");
    expect(Object.keys(wire(cfg))).not.toContain("roles_contract_version");
  });
});

describe("2A.4 — papel exigido e resolução dentro do slot", () => {
  const full = { orchestrator: SONNET, advisor: OPUS48, staff: HAIKU };
  it("rolesRoutingOn só com on", () => {
    expect([undefined, "off", "shadow", "banana", "on"].map((m) => rolesRoutingOn({ LLM_ROLES_MODE: m } as never)))
      .toEqual([false, false, false, false, true]);
  });
  it("papel exigido: só fato duro (rework >= 1 em Dev/QA); CTO/PM nunca Advisor", () => {
    expect(requiredRoleFor("DEV", 0)).toBe("orchestrator");
    expect(requiredRoleFor("DEV", 1)).toBe("advisor");
    expect(requiredRoleFor("qa", 2)).toBe("advisor");
    expect(requiredRoleFor("CTO", 3)).toBe("orchestrator");
    expect(requiredRoleFor("PM", 1)).toBe("orchestrator");
  });
  it("matriz papel × slot (completo, Staff vazio, Advisor vazio, Advisor == Orchestrator)", () => {
    expect(resolveRoleModel(full, "orchestrator")).toMatchObject({ model: SONNET, effective_role: "orchestrator", escalated: false });
    expect(resolveRoleModel(full, "advisor")).toMatchObject({ model: OPUS48, effective_role: "advisor", escalated: true });
    expect(resolveRoleModel(full, "staff")).toMatchObject({ model: HAIKU, effective_role: "staff" });
    // D1: Staff vazio ⇒ Orchestrator, declarado
    expect(resolveRoleModel({ ...full, staff: null }, "staff")).toMatchObject({
      llm_role: "staff", effective_role: "orchestrator", model: SONNET, note: "staff_empty_uses_orchestrator" });
    // D1b: Advisor vazio ⇒ sem escalada, registrado
    expect(resolveRoleModel({ ...full, advisor: null }, "advisor")).toMatchObject({
      llm_role: "advisor", effective_role: "orchestrator", model: SONNET, escalated: false, note: "advisor_empty_no_escalation" });
    expect(resolveRoleModel({ ...full, advisor: SONNET }, "advisor")).toMatchObject({ escalated: false, effective_role: "orchestrator" });
  });
  it("LEI dos slots: sem Orchestrator no slot ⇒ falha alta (nenhum modelo de env/literal)", () => {
    process.env.CLAUDE_MODEL = "claude-sonnet-4-6";
    expect(() => resolveRoleModel({ orchestrator: "", advisor: OPUS48, staff: null }, "advisor")).toThrow(/Orchestrator/);
    delete process.env.CLAUDE_MODEL;
  });
  it("o papel exigido não muda ao trocar de slot: cada slot resolve o MESMO papel nos seus modelos", () => {
    const slot0 = { orchestrator: SONNET, advisor: OPUS48, staff: null };
    const slot1 = { orchestrator: "us.anthropic.claude-sonnet-4-5", advisor: null, staff: null };
    const papel = requiredRoleFor("DEV", 1);
    expect(resolveRoleModel(slot0, papel)).toMatchObject({ llm_role: "advisor", effective_role: "advisor" });
    // slot de contingência sem Advisor: o papel exigido continua Advisor; só o efetivo é declarado
    expect(resolveRoleModel(slot1, papel)).toMatchObject({ llm_role: "advisor", effective_role: "orchestrator", note: "advisor_empty_no_escalation" });
  });
});
