/**
 * reviewerRoles.2a8.test.ts — plano v2, 2A.8: revisor cross-family por papel e Cyborg (lado api-node).
 *
 * Trava:
 *  · candidatos do revisor = [Orchestrator, Advisor], nessa ordem; TODOS os Orchestrators antes de
 *    qualquer Advisor (o Advisor nunca é o revisor padrão);
 *  · Staff nunca revisa — nem id sem marcador de porte (`command-r`, `mistral-small`);
 *  · mesma família barrada (Advisor-Opus não revisa executor Claude); modelo EFETIVO do executor;
 *  · `off` e `shadow` escolhem exatamente como antes (um candidato por slot, `modelId`);
 *  · `pickStrongestSlot` só compara Advisors quando o Cyborg de fato usa o Advisor (hoje: não);
 *  · nada aumenta chamadas por padrão.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TENANT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let tenantRows: Record<string, unknown>[] = [];
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string) => {
      if (sql.includes("FROM tenant_llm_configs")) return { rows: tenantRows };
      if (sql.includes("FROM projects p JOIN users u")) return { rows: [{ tenant_id: TENANT, creator_role: "tenant_admin" }] };
      if (sql.includes("FROM projects")) return { rows: [{ tenant_id: TENANT }] };
      return { rows: [] };
    },
  },
}));

import { pickReviewerModel } from "./reviewerModel.js";
import {
  rankReviewerSlots, resolveReviewerLlm, reviewerRoleCandidates, reviewerFamilies,
  pickStrongestSlot, CYBORG_STARTS_ON_ADVISOR, resolveProjectLlmCandidates, type TenantLlmConfig,
} from "./tenantLlmConfig.js";
import { effectiveExecutor } from "./crossFamilyAudit.js";

const OPUS = "us.anthropic.claude-opus-5-5";
const SONNET = "us.anthropic.claude-sonnet-5-5";
const AWS = { aws_access_key_id: "AKIA_FAKE", aws_secret_access_key: "SECRET_FAKE", aws_region: "us-east-1" };
const baseRow = { max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, byoc_exempt: false };
const bedrock = (priority: number, orch: string, advisor: string | null, verify: Record<string, string | null> = {}) => ({
  ...baseRow, provider: "bedrock", priority, model_id: orch, model_id_fallback: advisor, credentials: AWS,
  model_orchestrator: orch, model_advisor: advisor, model_staff: null,
  verify_orchestrator_status: verify.orchestrator ?? null, verify_advisor_status: verify.advisor ?? null,
});
const google = (priority: number, orch: string, advisor: string | null, verify: Record<string, string | null> = {}) => ({
  ...baseRow, provider: "google", priority, model_id: orch, model_id_fallback: advisor,
  credentials: { google_api_key: "KEY_FAKE" },
  model_orchestrator: orch, model_advisor: advisor, model_staff: null,
  verify_orchestrator_status: verify.orchestrator ?? null, verify_advisor_status: verify.advisor ?? null,
});

const saved = process.env.LLM_ROLES_MODE;
beforeEach(() => { tenantRows = []; });
afterEach(() => { if (saved === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = saved; });

describe("pickReviewerModel — Staff nunca revisa", () => {
  const ids = ["command-r", "mistral-small", "gemini-3-pro", "gpt-5"];
  it("sem papel (comportamento anterior) um id sem porte, de outra família, PASSARIA", () => {
    const r = pickReviewerModel({ executorModel: OPUS, candidates: ["command-r"] });
    expect(r.ok).toBe(true);
  });
  it.each(ids)("papel staff recusa %s", (id) => {
    const r = pickReviewerModel({ executorModel: OPUS, candidates: [id], candidateRoles: ["staff"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.recusados.join(" ")).toMatch(/Staff nunca revisa/);
  });
  it("id desconhecido como Staff não é elegível; como Orchestrator segue a régua de sempre", () => {
    expect(pickReviewerModel({ executorModel: OPUS, candidates: ["modelo-xyz"], candidateRoles: ["staff"] }).ok).toBe(false);
    expect(pickReviewerModel({ executorModel: OPUS, candidates: ["modelo-xyz"], candidateRoles: ["orchestrator"] }).ok).toBe(false); // família desconhecida
  });
  it("mesma família barrada mesmo no papel Advisor (Advisor-Opus não revisa executor Claude)", () => {
    const r = pickReviewerModel({ executorModel: SONNET, candidates: [OPUS], candidateRoles: ["advisor"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.recusados[0]).toMatch(/MESMA família/);
  });
});

describe("reviewerRoleCandidates — [Orchestrator, Advisor], Staff fora, elegibilidade do probe", () => {
  it("ordem e Advisor vazio/igual ao Orchestrator", () => {
    expect(reviewerRoleCandidates({ modelId: SONNET, models: { orchestrator: SONNET, advisor: OPUS, staff: "command-r" } })
      .map((c) => c.role)).toEqual(["orchestrator", "advisor"]);
    expect(reviewerRoleCandidates({ modelId: SONNET, models: { orchestrator: SONNET, advisor: null, staff: null } })).toHaveLength(1);
    expect(reviewerRoleCandidates({ modelId: SONNET, models: { orchestrator: SONNET, advisor: SONNET, staff: null } })).toHaveLength(1);
  });
  it("Staff nunca é candidato, mesmo preenchido", () => {
    const c = reviewerRoleCandidates({ modelId: SONNET, models: { orchestrator: SONNET, advisor: null, staff: "mistral-small" } });
    expect(c.map((x) => x.model)).toEqual([SONNET]);
  });
  it("sem verificação ⇒ elegível com aviso; status != ok ⇒ inelegível; ok ⇒ elegível", () => {
    const models = { orchestrator: SONNET, advisor: OPUS, staff: null };
    expect(reviewerRoleCandidates({ modelId: SONNET, models, verify: {} }).map((c) => c.unverified)).toEqual([true, true]);
    expect(reviewerRoleCandidates({ modelId: SONNET, models, verify: { orchestrator: "ok", advisor: "denied" } }))
      .toEqual([{ role: "orchestrator", model: SONNET, unverified: false }]);
    expect(reviewerRoleCandidates({ modelId: SONNET, models, verify: { orchestrator: "timeout", advisor: "ok" } })
      .map((c) => c.role)).toEqual(["advisor"]);
  });
});

describe("rankReviewerSlots sob LLM_ROLES_MODE=on", () => {
  beforeEach(() => { process.env.LLM_ROLES_MODE = "on"; vi.spyOn(console, "warn").mockImplementation(() => {}); });

  it("sem outra família: alerta, nenhum revisor (baseline de produção preservado) — Advisor-Opus não revisa executor Claude", async () => {
    tenantRows = [bedrock(0, SONNET, OPUS)];
    const r = await resolveReviewerLlm({ tenantId: TENANT, executorModel: SONNET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alert).toMatch(/MESMA família/);
  });

  it("Orchestrators de TODOS os slots vêm antes de qualquer Advisor; o Advisor nunca é o revisor padrão", async () => {
    // slot0 (google) tem Orchestrator E Advisor elegíveis; slot1 (bedrock) tem só Orchestrator.
    tenantRows = [google(0, "gemini-3-pro", "gemini-3-ultra"), bedrock(1, OPUS, null)];
    const { picks } = await rankReviewerSlots({ tenantId: TENANT, executorModel: "gpt-5" });
    expect(picks.map((p) => [p.model, p.role])).toEqual([
      ["gemini-3-pro", "orchestrator"], [OPUS, "orchestrator"], ["gemini-3-ultra", "advisor"],
    ]);
    const r = await resolveReviewerLlm({ tenantId: TENANT, executorModel: "gpt-5" });
    expect(r.ok && r.role).toBe("orchestrator");
  });

  it("Advisor só entra quando nenhum Orchestrator passa, com envelope do Advisor e sem contrato de papéis", async () => {
    // Orchestrator do slot google é pequeno (flash) e o executor não ⇒ recusado; o Advisor (pro) passa.
    tenantRows = [google(0, "gemini-3-flash", "gemini-3-pro")];
    const r = await resolveReviewerLlm({ tenantId: TENANT, executorModel: OPUS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role).toBe("advisor");
      expect(r.model).toBe("gemini-3-pro");
      expect(r.llm.model_id).toBe("gemini-3-pro");
      expect(r.llm.llm_config.model).toBe("gemini-3-pro");
      expect(r.llm.models).toBeUndefined();
      expect(r.llm.model_id_rework).toBeUndefined();
    }
  });

  it("probe por papel: Orchestrator 'denied' e Advisor 'ok' ⇒ só o Advisor; papel não verificado conta com aviso", async () => {
    tenantRows = [google(0, "gemini-3-pro", "gemini-3-ultra", { orchestrator: "denied", advisor: "ok" })];
    const a = await rankReviewerSlots({ tenantId: TENANT, executorModel: OPUS });
    expect(a.picks.map((p) => p.model)).toEqual(["gemini-3-ultra"]);
    tenantRows = [google(0, "gemini-3-pro", null)]; // nunca verificado
    const b = await rankReviewerSlots({ tenantId: TENANT, executorModel: OPUS });
    expect(b.picks).toHaveLength(1);
    expect(b.picks[0].unverified).toBe(true);
    expect(b.picks[0].why).toMatch(/NÃO verificado/);
  });

  it("Staff preenchido nunca vira revisor (id sem marcador de porte)", async () => {
    tenantRows = [{ ...bedrock(0, OPUS, null), model_staff: "command-r" }];
    const r = await resolveReviewerLlm({ tenantId: TENANT, executorModel: OPUS });
    expect(r.ok).toBe(false);
  });

  it("usa o modelo EFETIVO do executor: executor no Advisor-Opus (mais forte) barra Gemini flash", async () => {
    tenantRows = [google(0, "gemini-3-flash", null)];
    expect((await resolveReviewerLlm({ tenantId: TENANT, executorModel: SONNET })).ok).toBe(false); // flash < sonnet não-pequeno
  });
});

describe("off e shadow escolhem EXATAMENTE como antes (equivalência)", () => {
  const rows = () => [google(0, "gemini-3-flash", "gemini-3-pro"), bedrock(1, OPUS, null)];
  const summarize = async () => {
    const { picks, alert } = await rankReviewerSlots({ tenantId: TENANT, executorModel: "gpt-5" });
    return { picks: picks.map((p) => [p.model, p.priority, "role" in p, "unverified" in p]), alert };
  };
  it("off == shadow, um candidato por slot (modelId), sem campos novos", async () => {
    tenantRows = rows();
    process.env.LLM_ROLES_MODE = "off";
    const off = await summarize();
    process.env.LLM_ROLES_MODE = "shadow";
    const shadow = await summarize();
    expect(shadow).toEqual(off);
    // o Advisor (gemini-3-pro) NÃO é considerado; flash é recusado contra gpt-5; sobra o Opus do slot 1.
    expect(off.picks).toEqual([[OPUS, 1, false, false]]);
  });
  it("off não consulta colunas de verificação (SQL byte-idêntico ao anterior)", async () => {
    process.env.LLM_ROLES_MODE = "off";
    const sqls: string[] = [];
    const mod = await import("../db/client.js");
    const orig = (mod.pool as unknown as { query: (s: string) => Promise<unknown> }).query;
    (mod.pool as unknown as { query: (s: string) => Promise<unknown> }).query = async (s: string) => { sqls.push(s); return orig(s); };
    tenantRows = rows();
    await rankReviewerSlots({ tenantId: TENANT, executorModel: "gpt-5" });
    (mod.pool as unknown as { query: unknown }).query = orig;
    expect(sqls.join("\n")).not.toMatch(/verify_|model_advisor/);
  });
});

describe("effectiveExecutor — o auditor recebe o modelo efetivo, não o principal do slot", () => {
  const llm = { model_id: SONNET, models: { orchestrator: SONNET, advisor: OPUS, staff: null }, roles_contract_version: 1 };
  it("explícito vence tudo", () => {
    expect(effectiveExecutor(llm, { model: OPUS, role: "advisor" })).toEqual({ model: OPUS, role: "advisor" });
  });
  it("off: model_id; on: modelo do papel", () => {
    delete process.env.LLM_ROLES_MODE;
    expect(effectiveExecutor(llm)).toEqual({ model: SONNET });
    process.env.LLM_ROLES_MODE = "on";
    expect(effectiveExecutor(llm)).toEqual({ model: SONNET, role: "orchestrator" });
    expect(effectiveExecutor(llm, { model: "", role: "advisor" })).toEqual({ model: OPUS, role: "advisor" });
    expect(effectiveExecutor({ model_id: SONNET, models: { orchestrator: SONNET, advisor: null, staff: null } }, { model: "", role: "advisor" }))
      .toEqual({ model: SONNET, role: "orchestrator" }); // Advisor vazio ⇒ efetivo é o Orchestrator
    expect(effectiveExecutor(null)).toEqual({ model: "" });
  });
});

describe("reviewerFamilies — famílias sobre os papéis elegíveis", () => {
  it("Advisor de outra família conta; Staff não; papel reprovado não", () => {
    const s = (models: Record<string, string | null>, verify = {}) => ({ modelId: String(models.orchestrator), models: models as never, verify });
    expect(reviewerFamilies([s({ orchestrator: SONNET, advisor: "gemini-3-pro", staff: null })]).sort()).toEqual(["anthropic", "google"]);
    expect(reviewerFamilies([s({ orchestrator: SONNET, advisor: null, staff: "command-r" })])).toEqual(["anthropic"]);
    expect(reviewerFamilies([s({ orchestrator: SONNET, advisor: "gemini-3-pro", staff: null }, { advisor: "denied" })])).toEqual(["anthropic"]);
  });
});

describe("Cyborg: pickStrongestSlot e a condição do Advisor", () => {
  const slot = (priority: number, orch: string, advisor: string | null): TenantLlmConfig => ({
    provider: "bedrock", modelId: orch, modelIdFallback: advisor, credentials: AWS, maxConcurrentProjects: 3,
    dailyTokenQuota: null, deadpoolTokenReserve: 0, isDefault: false, priority, byocExempt: false,
    roleModels: { orchestrator: orch, advisor, staff: null },
  });
  const A = slot(0, SONNET, OPUS);   // Orchestrator sonnet, Advisor opus
  const B = slot(1, OPUS, null);     // Orchestrator opus, sem Advisor

  it("a condição está desligada: o Cyborg continua começando no principal do slot", () => {
    expect(CYBORG_STARTS_ON_ADVISOR).toBe(false);
  });
  it("sem comparar Advisors (padrão): compara Orchestrators ⇒ vence B (opus)", () => {
    expect(pickStrongestSlot([A, B]).slot?.priority).toBe(1);
    expect(pickStrongestSlot([A, B]).slotModels).toEqual([SONNET, OPUS]);
  });
  it("comparando Advisors: A compara pelo opus (empate ⇒ ordem do tenant); B, sem Advisor, compara o Orchestrator", () => {
    const r = pickStrongestSlot([A, B], { compareAdvisors: true });
    expect(r.slotModels).toEqual([OPUS, OPUS]);
    expect(r.slot?.priority).toBe(0);
  });
  it("sob on, com a condição desligada, resolveProjectLlmCandidates('strongest') ainda escolhe pelo Orchestrator", async () => {
    process.env.LLM_ROLES_MODE = "on";
    tenantRows = [bedrock(0, SONNET, OPUS), bedrock(1, OPUS, null)];
    const [first] = await resolveProjectLlmCandidates(PROJECT, { strategy: "strongest" });
    expect(first.modelId).toBe(OPUS);
  });
});

describe("custo — nada aumenta chamadas por padrão", () => {
  it("revisor padrão NÃO é o Advisor, mesmo com o Advisor elegível e no slot de maior prioridade", async () => {
    process.env.LLM_ROLES_MODE = "on";
    tenantRows = [google(0, "gemini-3-pro", "gemini-3-ultra"), bedrock(1, OPUS, null)];
    const r = await resolveReviewerLlm({ tenantId: TENANT, executorModel: "gpt-5" });
    expect(r.ok && r.role).toBe("orchestrator");
  });
  it("com um tenant de UMA família, on == off: nenhum revisor novo surge (alerta, zero chamada)", async () => {
    tenantRows = [bedrock(0, SONNET, OPUS)];
    process.env.LLM_ROLES_MODE = "off";
    const off = await rankReviewerSlots({ tenantId: TENANT, executorModel: SONNET });
    process.env.LLM_ROLES_MODE = "on";
    const on = await rankReviewerSlots({ tenantId: TENANT, executorModel: SONNET });
    expect(off.picks).toHaveLength(0);
    expect(on.picks).toHaveLength(0);
  });
});
