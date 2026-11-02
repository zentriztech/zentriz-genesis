/**
 * llmRoleSlots.test.ts — plano v2, 2A.3: mapeamento de backfill, validação de papéis e derivação
 * dos três papéis a partir do payload (dupla escrita). Funções puras, sem banco.
 */
import { describe, it, expect } from "vitest";
import { backfillRolesFromLegacy, validateRoleModels, deriveRolesForSave, rolesFromRow } from "./llmRoleSlots.js";

const OPUS48 = "us.anthropic.claude-opus-4-8";
const OPUS47 = "us.anthropic.claude-opus-4-7";
const SONNET = "us.anthropic.claude-sonnet-4-6";
const HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0";

describe("backfillRolesFromLegacy (espelha a migration 139)", () => {
  it("model_id → Orchestrator; fallback diferente → Advisor; Staff sempre NULL", () => {
    const r = backfillRolesFromLegacy({ modelId: SONNET, modelIdFallback: OPUS48 });
    expect(r).toMatchObject({ orchestrator: SONNET, advisor: OPUS48, staff: null, origin: "fallback" });
  });
  it("fallback == principal ⇒ Advisor NULL (sem escalada, D1b), mesmo com cyborg_model_id preenchido", () => {
    const r = backfillRolesFromLegacy({ modelId: OPUS48, modelIdFallback: OPUS48, cyborgModelId: OPUS47 });
    expect(r.advisor).toBeNull();
    expect(r.origin).toBe("none");
  });
  it("fallback NULL ⇒ Advisor NULL; cyborg_model_id diferente preenche (D3) e é sinalizado", () => {
    const r = backfillRolesFromLegacy({ modelId: SONNET, modelIdFallback: null, cyborgModelId: OPUS48 });
    expect(r).toMatchObject({ advisor: OPUS48, origin: "cyborg" });
    expect(r.notes.join(" ")).toMatch(/030/);
  });
  it("cyborg_model_id igual ao principal não vira Advisor; conta de gestão não usa o passo cyborg", () => {
    expect(backfillRolesFromLegacy({ modelId: OPUS48, cyborgModelId: OPUS48 }).advisor).toBeNull();
    expect(backfillRolesFromLegacy({ modelId: SONNET, cyborgModelId: OPUS48 }, { includeCyborg: false }).advisor).toBeNull();
  });
  it("fallback tem precedência sobre cyborg; espaços são aparados; vazio = NULL", () => {
    expect(backfillRolesFromLegacy({ modelId: " m1 ", modelIdFallback: " m2 ", cyborgModelId: "m3" }))
      .toMatchObject({ orchestrator: "m1", advisor: "m2" });
    expect(backfillRolesFromLegacy({ modelId: "m1", modelIdFallback: "  " }).advisor).toBeNull();
  });
  it("família não-Claude é mapeada igual (o mapeamento não depende do nome)", () => {
    expect(backfillRolesFromLegacy({ modelId: "gemini-3-flash", modelIdFallback: "gemini-3-pro" }))
      .toMatchObject({ orchestrator: "gemini-3-flash", advisor: "gemini-3-pro" });
  });
});

describe("validateRoleModels — falha alto, id desconhecido só avisa", () => {
  it("Staff de classe opus é recusado", () => {
    const v = validateRoleModels("bedrock", { orchestrator: SONNET, advisor: null, staff: OPUS48 });
    expect(v.errors.join(" ")).toMatch(/staff.*topo/);
  });
  it("Advisor de porte pequeno (haiku) é recusado", () => {
    const v = validateRoleModels("bedrock", { orchestrator: SONNET, advisor: HAIKU, staff: null });
    expect(v.errors.join(" ")).toMatch(/advisor.*porte pequeno/);
  });
  it("provider anthropic não serve modelo de outra família ⇒ erro", () => {
    const v = validateRoleModels("anthropic", { orchestrator: "gemini-3-pro", advisor: null, staff: null });
    expect(v.errors.join(" ")).toMatch(/orchestrator.*não serve/);
  });
  it("configuração boa não tem erro nem aviso (Sonnet + Opus + Haiku)", () => {
    expect(validateRoleModels("bedrock", { orchestrator: SONNET, advisor: OPUS48, staff: HAIKU }))
      .toEqual({ errors: [], warnings: [] });
  });
  it("id desconhecido é ACEITO com aviso (não bloqueia)", () => {
    const v = validateRoleModels("openai", { orchestrator: "meu-modelo-x", advisor: "outro-modelo-y", staff: "modelo-z" });
    expect(v.errors).toEqual([]);
    expect(v.warnings.length).toBe(2); // advisor e staff; orchestrator não tem restrição de classe
  });
  it("advisor igual ao orchestrator é aceito com aviso (não corrige em silêncio)", () => {
    const v = validateRoleModels("bedrock", { orchestrator: OPUS48, advisor: OPUS48, staff: null });
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(" ")).toMatch(/igual/);
  });
});

describe("deriveRolesForSave", () => {
  it("só legado: Advisor segue a regra do backfill e o legado é preservado como veio", () => {
    const d = deriveRolesForSave({ model_id: SONNET, model_id_fallback: OPUS48 }, SONNET);
    expect(d).toEqual({ ok: true, roles: { orchestrator: SONNET, advisor: OPUS48, staff: undefined, legacyFallback: OPUS48 } });
    const same = deriveRolesForSave({ model_id: OPUS48, model_id_fallback: OPUS48 }, OPUS48);
    expect(same).toMatchObject({ ok: true, roles: { advisor: null, legacyFallback: OPUS48 } });
  });
  it("campos novos: espelha o Advisor no model_id_fallback legado; Staff só entra se enviado", () => {
    const d = deriveRolesForSave({ model_orchestrator: SONNET, model_advisor: OPUS48, model_staff: HAIKU }, SONNET);
    expect(d).toEqual({ ok: true, roles: { orchestrator: SONNET, advisor: OPUS48, staff: HAIKU, legacyFallback: OPUS48 } });
    const limpa = deriveRolesForSave({ model_id: SONNET, model_advisor: "" }, SONNET);
    expect(limpa).toMatchObject({ ok: true, roles: { advisor: null, legacyFallback: null } });
  });
  it("novo × legado divergentes ⇒ erro (nunca escolhe um em silêncio)", () => {
    expect(deriveRolesForSave({ model_id: SONNET, model_orchestrator: OPUS48 }, SONNET).ok).toBe(false);
    expect(deriveRolesForSave({ model_id: SONNET, model_advisor: OPUS48, model_id_fallback: OPUS47 }, SONNET).ok).toBe(false);
  });
});

describe("rolesFromRow — legado autoritativo na transição", () => {
  it("deriva do legado, Staff da coluna nova; sinaliza divergência das colunas novas", () => {
    const ok = rolesFromRow({ model_id: SONNET, model_id_fallback: OPUS48, model_orchestrator: SONNET, model_advisor: OPUS48, model_staff: HAIKU });
    expect(ok).toEqual({ models: { orchestrator: SONNET, advisor: OPUS48, staff: HAIKU }, diverges: false });
    const stale = rolesFromRow({ model_id: SONNET, model_id_fallback: OPUS48, model_orchestrator: null, model_advisor: null });
    expect(stale.models.advisor).toBe(OPUS48);
    expect(stale.diverges).toBe(true);
  });
});
