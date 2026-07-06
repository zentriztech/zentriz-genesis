/**
 * G1-T23: validação de matriz + allowlist de dispatch.
 */
import { describe, it, expect } from "vitest";
import { validateDeployMatrix, BACKEND_ALLOWLIST, resolveDeliveryMode, DEFAULT_BACKEND_DELIVERY_MODE } from "./deployMatrix.js";

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

describe("DM-T1: delivery_mode", () => {
  it("default do backend = source_only (sem escolha explícita)", () => {
    expect(DEFAULT_BACKEND_DELIVERY_MODE).toBe("source_only");
    expect(validateDeployMatrix("backend_api", null).deliveryMode).toBe("source_only");
    expect(validateDeployMatrix("fullstack_saas", null).deliveryMode).toBe("source_only");
  });

  it("modo explícito production/demo é respeitado", () => {
    expect(validateDeployMatrix("backend_api", null, "production").deliveryMode).toBe("production");
    expect(validateDeployMatrix("backend_api", null, "demo").deliveryMode).toBe("demo");
  });

  it("modo inválido → erro", () => {
    const d = validateDeployMatrix("backend_api", null, "staging_typo");
    expect(d.error).toMatch(/delivery_mode.*inválido/i);
  });

  it("web/estático → deliveryMode neutro (production), sem erro", () => {
    expect(validateDeployMatrix("frontend_dashboard", null).deliveryMode).toBe("production");
    expect(validateDeployMatrix("frontend_dashboard", null).error).toBeUndefined();
  });

  it("resolveDeliveryMode: backend sem modo → source_only; com modo → o modo", () => {
    expect(resolveDeliveryMode(true, null).deliveryMode).toBe("source_only");
    expect(resolveDeliveryMode(true, "production").deliveryMode).toBe("production");
    expect(resolveDeliveryMode(false, null).deliveryMode).toBe("production"); // web neutro
    expect(resolveDeliveryMode(true, "xpto").error).toBeTruthy();
  });

  it("combinação válida com modo: fullstack_saas + production + ecs_fargate", () => {
    const d = validateDeployMatrix("fullstack_saas", "ecs_fargate", "production");
    expect(d.error).toBeUndefined();
    expect(d).toMatchObject({ runtimeTarget: "ecs_fargate", isFullstack: true, deliveryMode: "production" });
  });
});
