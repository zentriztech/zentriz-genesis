/**
 * Testes de lógica pura da UI de papéis (2A.10). O portal não tem runner de componente; rode com o
 * vitest do api-node:  cd applications/services/api-node && npx vitest run --root ../../apps/genesis-web
 */
import { describe, it, expect } from "vitest";
import {
  initialRoles, legacyFallbackValue, normalizeWarnings, parseRoleErrors, parseRolesMode,
  roleBlocksUse, roleStatusView, rolesPayloadFields, rolesUiEnabled, summarizeRoleVerify,
} from "./rolesLogic";

const R = { orchestrator: "us.anthropic.claude-sonnet-5-5", advisor: "us.anthropic.claude-opus-5-5", staff: "" };

describe("parseRolesMode", () => {
  it.each([[undefined, "off"], [null, "off"], ["", "off"], ["lixo", "off"], [1, "off"],
           ["off", "off"], ["shadow", "shadow"], ["ON", "on"], [" on ", "on"]])("%s -> %s", (i, o) => {
    expect(parseRolesMode(i)).toBe(o);
  });
  it("só `on` liga a UI (decisão do Jean, 2026-11-03)", () => {
    expect(rolesUiEnabled("off")).toBe(false);
    expect(rolesUiEnabled("shadow")).toBe(false);
    expect(rolesUiEnabled("on")).toBe(true);
  });
});

describe("payload (dupla escrita)", () => {
  it("off: nenhum campo novo (payload idêntico ao atual)", () => {
    expect(rolesPayloadFields("off", R)).toEqual({});
    expect(legacyFallbackValue("off", R, "legacy-fb")).toBe("legacy-fb");
    expect(legacyFallbackValue("off", R, "")).toBeNull();
  });
  it("shadow: UI antiga ⇒ nenhum campo novo (decisão do Jean, 2026-11-03)", () => {
    expect(rolesPayloadFields("shadow", R)).toEqual({});
  });
  it("on: envia os 3 papéis; vazio vira null explícito", () => {
    expect(rolesPayloadFields("on", R)).toEqual({
      model_orchestrator: R.orchestrator, model_advisor: R.advisor, model_staff: null,
    });
  });
  it("legado espelha o Advisor (o backend recusa divergência)", () => {
    expect(legacyFallbackValue("on", R, "ignorado")).toBe(R.advisor);
    expect(legacyFallbackValue("on", { ...R, advisor: "" }, "")).toBeNull();
  });
});

describe("initialRoles", () => {
  it("sem slot: tudo vazio", () => {
    expect(initialRoles(null)).toEqual({ orchestrator: "", advisor: "", staff: "" });
  });
  it("usa `models` do servidor quando presente", () => {
    expect(initialRoles({ model_id: "a", model_id_fallback: "b", models: { orchestrator: "a", advisor: null, staff: "h" } }))
      .toEqual({ orchestrator: "a", advisor: "", staff: "h" });
  });
  it("sem `models`: deriva do legado; fallback igual ao principal = sem escalada", () => {
    expect(initialRoles({ model_id: "a", model_id_fallback: "b" })).toEqual({ orchestrator: "a", advisor: "b", staff: "" });
    expect(initialRoles({ model_id: "a", model_id_fallback: "a" })).toEqual({ orchestrator: "a", advisor: "", staff: "" });
  });
});

describe("roleStatusView — sempre com texto", () => {
  it("papel vazio explica a semântica", () => {
    expect(roleStatusView("advisor", false, null).detail).toMatch(/não há escalada/i);
    expect(roleStatusView("staff", false, null).detail).toMatch(/Orchestrator/);
    expect(roleStatusView("staff", false, null).kind).toBe("empty");
  });
  it.each([
    ["ok", "ok", "success"], ["denied", "denied", "error"], ["error", "error", "error"],
    ["timeout", "timeout", "warning"],
  ] as const)("status %s", (st, kind, tone) => {
    const v = roleStatusView("orchestrator", true, { status: st });
    expect(v.kind).toBe(kind);
    expect(v.tone).toBe(tone);
    expect(v.label.length).toBeGreaterThan(3);
  });
  it("null/ausente/desconhecido = não testado (neutro), nunca reprovado", () => {
    for (const v of [null, undefined, { status: null }, { status: "zzz" }, { status: null, tested: false, note: "não testado agora (agents indisponível)" }]) {
      const r = roleStatusView("staff", true, v as never);
      expect(r.kind).toBe("untested");
      expect(roleBlocksUse(r)).toBe(false);
    }
  });
  it("denied/error/timeout bloqueiam o uso; ok não", () => {
    expect(roleBlocksUse(roleStatusView("advisor", true, { status: "denied" }))).toBe(true);
    expect(roleBlocksUse(roleStatusView("advisor", true, { status: "ok" }))).toBe(false);
  });
  it("detalhe traz o erro do backend", () => {
    expect(roleStatusView("advisor", true, { status: "denied", error: "AccessDenied x" }).detail).toBe("AccessDenied x");
  });
});

describe("parseRoleErrors (400 do backend)", () => {
  it("vazio", () => expect(parseRoleErrors("")).toEqual({ byRole: {}, general: "" }));
  it("um papel", () => {
    const r = parseRoleErrors("advisor: 'x' é modelo de porte pequeno; o Advisor precisa ser igual ou mais capaz que o Orchestrator.");
    expect(Object.keys(r.byRole)).toEqual(["advisor"]);
    expect(r.byRole.advisor).toMatch(/porte pequeno/);
    expect(r.general).toBe("");
  });
  it("vários papéis juntos", () => {
    const r = parseRoleErrors("orchestrator: o provider 'google' não serve o modelo 'm'. staff: 'o' é de classe topo de linha (opus-like); o Staff é o papel barato.");
    expect(r.byRole.orchestrator).toMatch(/não serve/);
    expect(r.byRole.staff).toMatch(/topo de linha/);
  });
  it("divergência model_advisor vs legado vai para o campo", () => {
    const r = parseRoleErrors("model_advisor ('a') diverge de model_id_fallback ('b'); envie o mesmo valor ou apenas um dos campos.");
    expect(r.byRole.advisor).toMatch(/diverge/);
  });
  it("erro não relacionado a papel fica geral", () => {
    const r = parseRoleErrors("Provider inválido: x");
    expect(r.byRole).toEqual({});
    expect(r.general).toBe("Provider inválido: x");
  });
});

describe("avisos e resumo", () => {
  it("normalizeWarnings tolera lixo", () => {
    expect(normalizeWarnings(undefined)).toEqual([]);
    expect(normalizeWarnings("x")).toEqual([]);
    expect(normalizeWarnings(["a", "", 3, " ", "b"])).toEqual(["a", "b"]);
  });
  it("summarizeRoleVerify lista só papéis preenchidos", () => {
    const s = summarizeRoleVerify({ orchestrator: { status: "ok" }, advisor: { status: "denied" } }, R);
    expect(s).toEqual(["Orchestrator: Testado e funcionando", "Advisor: Acesso negado ao modelo"]);
  });
});
