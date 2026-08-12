/**
 * githubPush.test.ts — #82 (D-2): injeção de CI de build mobile no accept.
 *
 * getMobileBuildWorkflow é puro (reusa deployMatrix + os renderers mobile). Verifica:
 *  - mobile_crossplatform → workflow rncli (mobile-build.yml, gradlew assembleRelease);
 *  - mobile_expo → workflow eas (eas-build.yml);
 *  - tipos não-mobile (backend/web) → null (não altera o caminho web/backend);
 *  - política no-Expo: crossplatform NUNCA emite artefato/workflow Expo.
 */
import { describe, it, expect } from "vitest";
import { getMobileBuildWorkflow } from "./githubPush.js";

describe("getMobileBuildWorkflow (#82 / D-2)", () => {
  it("mobile_crossplatform → workflow RN CLI (mobile-build.yml, sem Expo)", () => {
    const wf = getMobileBuildWorkflow({
      projectType: "mobile_crossplatform",
      appName: "Zentriz Voices",
      apiUrl: "https://api.zvoices.com.br",
    });
    expect(wf).not.toBeNull();
    expect(wf!.path).toBe(".github/workflows/mobile-build.yml");
    // caminho RN CLI real: gradlew assembleRelease (APK como artefato de CI).
    expect(wf!.content).toContain("gradlew assembleRelease");
    expect(wf!.content).toContain("upload-artifact");
    // política no-Expo: nada de EAS/Expo no workflow do canal rncli.
    expect(wf!.content).not.toMatch(/eas build|eas submit|expo-github-action/i);
  });

  it("mobile_expo → workflow EAS (eas-build.yml)", () => {
    const wf = getMobileBuildWorkflow({
      projectType: "mobile_expo",
      appName: "Zentriz Voices",
    });
    expect(wf).not.toBeNull();
    expect(wf!.path).toBe(".github/workflows/eas-build.yml");
  });

  it("tipos não-mobile → null (não injeta CI mobile em web/backend)", () => {
    for (const t of ["backend_api_nestjs", "fullstack_saas", "frontend_spa", "static_site", null, undefined]) {
      expect(getMobileBuildWorkflow({ projectType: t as string | null, appName: "X" })).toBeNull();
    }
  });

  it("é determinístico (mesma entrada → mesmo workflow)", () => {
    const a = getMobileBuildWorkflow({ projectType: "mobile_crossplatform", appName: "App" });
    const b = getMobileBuildWorkflow({ projectType: "mobile_crossplatform", appName: "App" });
    expect(a).toEqual(b);
  });
});
