/**
 * mobileEasRenderer.test.ts — Cenário B / F3 (mobile source_only).
 * Verifica que o kit EAS source_only é determinístico, sem segredos, e coerente.
 */
import { describe, it, expect } from "vitest";
import { renderMobileEasBundle, toSlug } from "./mobileEasRenderer.js";

describe("toSlug", () => {
  it("kebab-case sem acento", () => {
    expect(toSlug("Zentriz Voices")).toBe("zentriz-voices");
    expect(toSlug("App de Inglês!")).toBe("app-de-ingles");
  });
  it("fallback para 'app' em vazio", () => {
    expect(toSlug("")).toBe("app");
    expect(toSlug("   ")).toBe("app");
  });
});

describe("renderMobileEasBundle (source_only)", () => {
  const base = { appName: "Zentriz Voices", apiUrl: "https://api.zvoices.com.br" };

  it("gera os 4 arquivos do kit", () => {
    const { files } = renderMobileEasBundle(base);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      ".github/workflows/eas-build.yml",
      "MOBILE-DEPLOY.md",
      "app.config.ts",
      "eas.json",
    ]);
  });

  it("eas.json é JSON válido com perfis development/preview/production", () => {
    const { files } = renderMobileEasBundle(base);
    const eas = JSON.parse(files.find((f) => f.path === "eas.json")!.content);
    expect(eas.build.development).toBeDefined();
    expect(eas.build.preview).toBeDefined();
    expect(eas.build.production).toBeDefined();
    expect(eas.submit.production).toBeDefined();
  });

  it("app.config.ts usa slug/bundleId derivados e a apiUrl fornecida", () => {
    const cfg = renderMobileEasBundle(base).files.find((f) => f.path === "app.config.ts")!.content;
    expect(cfg).toContain('slug: "zentriz-voices"');
    expect(cfg).toContain('bundleIdentifier: "br.com.zentriz.zentrizvoices"');
    expect(cfg).toContain("https://api.zvoices.com.br");
    expect(cfg).toContain("EXPO_PUBLIC_API_URL");
  });

  it("NÃO embute segredo — token vem de secrets do GitHub", () => {
    const { files } = renderMobileEasBundle(base);
    for (const f of files) {
      // não deve haver token literal; só referência a secrets.EXPO_TOKEN
      expect(f.content).not.toMatch(/EXPO_TOKEN\s*[:=]\s*["'][A-Za-z0-9_-]{10,}/);
    }
    const wf = files.find((f) => f.path === ".github/workflows/eas-build.yml")!.content;
    expect(wf).toContain("secrets.EXPO_TOKEN");
    expect(wf).toContain("exit 1"); // guard: falha claro sem token
  });

  it("delivery preview_build/store_submit gera aviso mas ainda entrega source_only", () => {
    const r = renderMobileEasBundle({ ...base, delivery: "store_submit" });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/source_only/);
    expect(r.files.map((f) => f.path)).toContain("eas.json");
  });

  it("source_only não gera aviso", () => {
    expect(renderMobileEasBundle({ ...base, delivery: "source_only" }).warnings).toHaveLength(0);
  });

  it("é determinístico (mesma entrada → mesmo output)", () => {
    const a = renderMobileEasBundle(base).files;
    const b = renderMobileEasBundle(base).files;
    expect(a).toEqual(b);
  });

  it("respeita slug/bundleId explícitos", () => {
    const cfg = renderMobileEasBundle({ ...base, slug: "meu-app", bundleId: "com.acme.app" })
      .files.find((f) => f.path === "app.config.ts")!.content;
    expect(cfg).toContain('slug: "meu-app"');
    expect(cfg).toContain('bundleIdentifier: "com.acme.app"');
  });
});
