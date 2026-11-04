import { describe, it, expect } from "vitest";
import { journeyFromVerdict } from "./factoryJourney";
import { promoteNextAction, type PromotionVerdict } from "./factoryActions";

const v = (o: Partial<PromotionVerdict>): PromotionVerdict => ({ canPromote: false, reason: null, message: null, normalized: null, ...o });

describe("jornada — veredito histórico (sem 'evolution') permanece igual", () => {
  it("NOT_NORMALIZED ⇒ etapa Normalizar, 4 etapas", () => {
    const j = journeyFromVerdict(v({ reason: "NOT_NORMALIZED", normalized: false }));
    expect(j.steps.map((s) => s.key)).toEqual(["normalize", "validate", "review", "promote"]);
    expect(j.current).toBe("normalize");
    expect(j.action).toBe("normalize");
  });
});

describe("jornada do filho de EVOLUÇÃO (EVOLUTION_PROMOTE_BANCADA=on)", () => {
  const keys = (j: ReturnType<typeof journeyFromVerdict>) => j.steps.map((s) => s.key);
  it("não mostra a etapa Normalizar: RFC → Validar → Revisar GAPs → Promover", () => {
    const j = journeyFromVerdict(v({ evolution: true, canPromote: true }));
    expect(keys(j)).toEqual(["rfc", "validate", "review", "promote"]);
    expect(j.phase).toBe("ready");
    expect(j.action).toBe("promote");
  });
  it("RFC ausente ⇒ etapa RFC atual, sem ação de Normalizar", () => {
    const j = journeyFromVerdict(v({ evolution: true, reason: "EVOLUTION_RFC", code: "EVOLUTION_RFC_REQUIRED" }));
    expect(j.current).toBe("rfc");
    expect(j.action).toBeNull();
    expect(j.headline).toMatch(/RFC/);
    expect(j.steps[0].state).toBe("current");
  });
  it("RFC inválido ⇒ 'RFC da evolução incompleto'", () => {
    expect(journeyFromVerdict(v({ evolution: true, reason: "EVOLUTION_RFC", code: "EVOLUTION_RFC_INVALID" })).headline).toMatch(/incompleto/);
  });
  it("GAP crítico ⇒ etapa Revisar GAPs, com as etapas da evolução", () => {
    const j = journeyFromVerdict(v({ evolution: true, reason: "NOT_VALIDATED", code: "SPEC_VALIDATION_BLOCKED" }));
    expect(j.current).toBe("review");
    expect(j.action).toBe("gaps");
    expect(keys(j)).toEqual(["rfc", "validate", "review", "promote"]);
  });
  it("connect.yaml ausente ⇒ sem ação Normalizar (não se aplica)", () => {
    const j = journeyFromVerdict(v({ evolution: true, reason: "CONNECT_MISSING", code: "CONNECT_DECLARATION_MISSING" }));
    expect(j.action).toBeNull();
    expect(j.headline).toMatch(/connect\.yaml/);
  });
  it("orçamento ⇒ bloqueado/erro, sem ação", () => {
    const j = journeyFromVerdict(v({ evolution: true, reason: "BUDGET_BLOCKED", code: "BUDGET_MISSING" }));
    expect(j.phase).toBe("blocked");
    expect(j.severity).toBe("error");
    expect(j.action).toBeNull();
  });
  it("já promovido ⇒ in_factory", () => {
    expect(journeyFromVerdict(v({ evolution: true, reason: "NOT_ON_WORKBENCH" })).phase).toBe("in_factory");
  });
  it("promoteNextAction: evolução nunca sugere Normalizar", () => {
    expect(promoteNextAction(v({ evolution: true, reason: "CONNECT_MISSING" }))).toBeNull();
    expect(promoteNextAction(v({ evolution: true, reason: "EVOLUTION_RFC" }))).toBeNull();
    expect(promoteNextAction(v({ evolution: true, reason: "NOT_VALIDATED", code: "SPEC_VALIDATION_BLOCKED" }))).toBe("gaps");
    expect(promoteNextAction(v({ reason: "CONNECT_MISSING" }))).toBe("normalize"); // histórico intacto
  });
});
