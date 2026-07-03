/**
 * T-05: typePolicyNormalizer — testa normalização via type_aliases
 * do policies.json (gerado no prebuild a partir do YAML canônico).
 */
import { describe, it, expect } from "vitest";
import { normalizeProjectType, isKnownProjectType } from "./typePolicyNormalizer.js";

describe("normalizeProjectType", () => {
  it("mantém canônico inalterado", () => {
    expect(normalizeProjectType("backend_api")).toBe("backend_api");
    expect(normalizeProjectType("frontend_dashboard")).toBe("frontend_dashboard");
    expect(normalizeProjectType("frontend_landing")).toBe("frontend_landing");
    expect(normalizeProjectType("mobile_crossplatform")).toBe("mobile_crossplatform");
    expect(normalizeProjectType("other")).toBe("other");
  });

  it("resolve aliases do Telegram para canônico", () => {
    expect(normalizeProjectType("mobile_app")).toBe("mobile_crossplatform");
    expect(normalizeProjectType("static_site")).toBe("frontend_landing");
    expect(normalizeProjectType("frontend_webapp")).toBe("frontend_dashboard");
  });

  it("resolve aliases legados do portal para canônico", () => {
    expect(normalizeProjectType("mobile_ios")).toBe("mobile_crossplatform");
    expect(normalizeProjectType("mobile_android")).toBe("mobile_crossplatform");
    expect(normalizeProjectType("web_app")).toBe("frontend_dashboard");
    expect(normalizeProjectType("landing_page")).toBe("frontend_landing");
    expect(normalizeProjectType("frontend_web")).toBe("frontend_dashboard");
    expect(normalizeProjectType("backend_api_node")).toBe("backend_api");
  });

  it("mantém tipo desconhecido inalterado (Python side resolve para _default)", () => {
    expect(normalizeProjectType("qualquer_coisa_xyz")).toBe("qualquer_coisa_xyz");
    expect(normalizeProjectType("backend_graphql")).toBe("backend_graphql"); // Wave 0 não cobre
  });

  it("trata null/vazio/whitespace", () => {
    expect(normalizeProjectType(null)).toBeNull();
    expect(normalizeProjectType(undefined)).toBeNull();
    expect(normalizeProjectType("")).toBeNull();
    expect(normalizeProjectType("   ")).toBeNull();
  });

  it("backend_api_python NÃO é alias para backend_api (stacks incompatíveis)", () => {
    // Deve retornar como está, NÃO backend_api
    expect(normalizeProjectType("backend_api_python")).toBe("backend_api_python");
  });
});

describe("isKnownProjectType", () => {
  it("true para canônicos", () => {
    expect(isKnownProjectType("backend_api")).toBe(true);
    expect(isKnownProjectType("frontend_dashboard")).toBe(true);
    expect(isKnownProjectType("other")).toBe(true);
  });

  it("true para aliases", () => {
    expect(isKnownProjectType("mobile_app")).toBe(true);
    expect(isKnownProjectType("static_site")).toBe(true);
  });

  it("false para desconhecidos e vazios", () => {
    expect(isKnownProjectType("xyz_unknown")).toBe(false);
    expect(isKnownProjectType(null)).toBe(false);
    expect(isKnownProjectType("")).toBe(false);
  });
});
