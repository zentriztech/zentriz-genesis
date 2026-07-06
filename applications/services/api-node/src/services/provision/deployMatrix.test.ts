/**
 * G1-T23: validação de matriz + allowlist de dispatch.
 */
import { describe, it, expect } from "vitest";
import { validateDeployMatrix, BACKEND_ALLOWLIST } from "./deployMatrix.js";

describe("validateDeployMatrix", () => {
  it("frontend → s3, sem erro, não backend", () => {
    const d = validateDeployMatrix("frontend_dashboard", null);
    expect(d).toMatchObject({ runtimeTarget: "s3", isBackend: false, isFullstack: false });
    expect(d.error).toBeUndefined();
  });

  it("backend_api → ecs_fargate default", () => {
    expect(validateDeployMatrix("backend_api", null)).toMatchObject({ runtimeTarget: "ecs_fargate", isBackend: true });
  });

  it("fullstack_saas → ecs_fargate, isFullstack true", () => {
    expect(validateDeployMatrix("fullstack_saas", null)).toMatchObject({
      runtimeTarget: "ecs_fargate", isBackend: true, isFullstack: true });
  });

  it("REJEITA app_runner + fullstack (não suporta multi-serviço)", () => {
    const d = validateDeployMatrix("fullstack_saas", "app_runner");
    expect(d.error).toBeTruthy();
    expect(d.error).toMatch(/fullstack/i);
  });

  it("app_runner + backend single-service é aceito", () => {
    const d = validateDeployMatrix("backend_api", "app_runner");
    expect(d.error).toBeUndefined();
    expect(d.runtimeTarget).toBe("app_runner");
  });

  it("REJEITA runtime_target=s3 para backend", () => {
    const d = validateDeployMatrix("backend_api", "s3");
    expect(d.error).toMatch(/s3.*inválido|inválido.*backend/i);
  });

  it("REJEITA tipo backend fora da allowlist", () => {
    const d = validateDeployMatrix("backend_exotic_thing", null);
    expect(d.error).toMatch(/não é suportado|allowlist|suportados/i);
  });

  it("REJEITA runtime_target inexistente (typo)", () => {
    const d = validateDeployMatrix("backend_api", "fargate_typo");
    expect(d.error).toMatch(/inválido/i);
  });

  it("REJEITA target de container para web", () => {
    const d = validateDeployMatrix("frontend_landing", "ecs_fargate");
    expect(d.error).toMatch(/web|estático|s3/i);
  });

  it("allowlist contém os tipos backend/fullstack esperados", () => {
    for (const t of ["backend_api", "backend_api_python", "fullstack_saas", "fullstack_ecommerce"]) {
      expect(BACKEND_ALLOWLIST.has(t)).toBe(true);
    }
  });

  it("tipo nulo/vazio → s3 não-backend (não desvia)", () => {
    expect(validateDeployMatrix(null, null)).toMatchObject({ runtimeTarget: "s3", isBackend: false });
    expect(validateDeployMatrix(null, null).error).toBeUndefined();
  });
});
