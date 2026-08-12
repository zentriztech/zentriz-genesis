/**
 * mobileRncliRenderer.test.ts — Cenário B (mobile source_only, React Native CLI PURO, no-Expo).
 * Verifica que o kit RN CLI é determinístico, sem segredos, sem NENHUM artefato Expo.
 */
import { describe, it, expect } from "vitest";
import { renderMobileRncliBundle } from "./mobileRncliRenderer.js";

describe("renderMobileRncliBundle (source_only, RN CLI)", () => {
  const base = { appName: "Zentriz Voices", apiUrl: "https://api.zvoices.com.br" };

  it("gera os 6 arquivos do kit RN CLI", () => {
    const { files } = renderMobileRncliBundle(base);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      ".env.example",
      ".github/workflows/mobile-build.yml",
      "Gemfile",
      "MOBILE-DEPLOY.md",
      "fastlane/Appfile",
      "fastlane/Fastfile",
    ]);
  });

  it("NÃO contém NENHUM artefato Expo (config/CLI/deps proibidos pela policy)", () => {
    // Barra USO de Expo (arquivos e comandos), não a prosa que explica a ausência ("sem Expo").
    const FORBIDDEN = /eas\.json|app\.config\.ts|eas-cli|@expo\/|expo-router|EXPO_PUBLIC|eas build|eas submit|expo install|expo-github-action/i;
    const { files } = renderMobileRncliBundle(base);
    for (const f of files) {
      expect(f.path).not.toBe("eas.json");
      expect(f.path).not.toBe("app.config.ts");
      expect(f.content).not.toMatch(FORBIDDEN);
    }
  });

  it("usa react-native-config (API_URL no .env) — o substituto do EXPO_PUBLIC_*", () => {
    const env = renderMobileRncliBundle(base).files.find((f) => f.path === ".env.example")!.content;
    expect(env).toContain("API_URL=https://api.zvoices.com.br");
    expect(env).toContain("react-native-config");
  });

  it("CI builda Android via gradlew e compila iOS no simulador", () => {
    const wf = renderMobileRncliBundle(base).files.find((f) => f.path === ".github/workflows/mobile-build.yml")!.content;
    expect(wf).toContain("gradlew assembleRelease");
    expect(wf).toContain("xcodebuild");
    expect(wf).toContain("iphonesimulator");
  });

  it("Fastfile tem lanes de build e submit por plataforma", () => {
    const ff = renderMobileRncliBundle(base).files.find((f) => f.path === "fastlane/Fastfile")!.content;
    expect(ff).toContain("platform :android");
    expect(ff).toContain("platform :ios");
    expect(ff).toContain("upload_to_play_store");
    expect(ff).toContain("upload_to_testflight");
  });

  it("Appfile deriva o package_name/app_identifier do bundleId", () => {
    const af = renderMobileRncliBundle(base).files.find((f) => f.path === "fastlane/Appfile")!.content;
    expect(af).toContain("br.com.zentriz.zentrizvoices");
  });

  it("NÃO embute segredo de assinatura — vem de secrets do CI", () => {
    const { files } = renderMobileRncliBundle(base);
    for (const f of files) {
      expect(f.content).not.toMatch(/KEYSTORE_PASSWORD\s*[:=]\s*["'][A-Za-z0-9_-]{6,}/);
    }
    const wf = files.find((f) => f.path === ".github/workflows/mobile-build.yml")!.content;
    expect(wf).toContain("secrets.ANDROID_KEYSTORE_BASE64");
  });

  it("delivery preview_build/store_submit gera aviso mas ainda entrega source_only", () => {
    const r = renderMobileRncliBundle({ ...base, delivery: "store_submit" });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/source_only/);
    expect(r.files.map((f) => f.path)).toContain("fastlane/Fastfile");
  });

  it("source_only não gera aviso", () => {
    expect(renderMobileRncliBundle({ ...base, delivery: "source_only" }).warnings).toHaveLength(0);
  });

  it("é determinístico (mesma entrada → mesmo output)", () => {
    expect(renderMobileRncliBundle(base).files).toEqual(renderMobileRncliBundle(base).files);
  });

  it("respeita slug/bundleId explícitos", () => {
    const af = renderMobileRncliBundle({ ...base, slug: "meu-app", bundleId: "com.acme.app" })
      .files.find((f) => f.path === "fastlane/Appfile")!.content;
    expect(af).toContain("com.acme.app");
  });
});
