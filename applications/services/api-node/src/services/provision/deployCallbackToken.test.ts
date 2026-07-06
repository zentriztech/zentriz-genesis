/**
 * G1-T19: token de callback escopado por deployment.
 * Deployment A não pode fazer callback do deployment B; expirado é rejeitado;
 * TokenPayload de usuário admin NÃO é aceito como deploy-callback.
 */
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import {
  signDeployCallbackToken, verifyDeployCallbackToken, decodeDeployCallbackToken, signToken,
} from "../../auth.js";

const SECRET = process.env.JWT_SECRET ?? "zentriz-genesis-dev-secret";

describe("signDeployCallbackToken / verifyDeployCallbackToken", () => {
  it("token do deployment A valida para A", () => {
    const t = signDeployCallbackToken("dep-A", "proj-1");
    const ok = verifyDeployCallbackToken(t, { deploymentId: "dep-A", projectId: "proj-1" });
    expect(ok).not.toBeNull();
    expect(ok!.scope).toBe("deploy-callback");
  });

  it("token do deployment A é REJEITADO para deployment B (403)", () => {
    const t = signDeployCallbackToken("dep-A", "proj-1");
    expect(verifyDeployCallbackToken(t, { deploymentId: "dep-B", projectId: "proj-1" })).toBeNull();
  });

  it("token com projeto diferente é rejeitado", () => {
    const t = signDeployCallbackToken("dep-A", "proj-1");
    expect(verifyDeployCallbackToken(t, { deploymentId: "dep-A", projectId: "proj-999" })).toBeNull();
  });

  it("token expirado é rejeitado", () => {
    const t = signDeployCallbackToken("dep-A", "proj-1", "-1s"); // já expirado
    expect(verifyDeployCallbackToken(t, { deploymentId: "dep-A", projectId: "proj-1" })).toBeNull();
  });

  it("TokenPayload de usuário (admin) NÃO é aceito como deploy-callback", () => {
    const adminToken = signToken({ sub: "u1", email: "a@b.c", role: "zentriz_admin", tenantId: null });
    expect(decodeDeployCallbackToken(adminToken)).toBeNull();
    expect(verifyDeployCallbackToken(adminToken, { deploymentId: "dep-A", projectId: "proj-1" })).toBeNull();
  });

  it("token com scope errado é rejeitado", () => {
    const bad = jwt.sign({ scope: "other", deploymentId: "dep-A", projectId: "proj-1" }, SECRET);
    expect(decodeDeployCallbackToken(bad)).toBeNull();
  });

  it("decodeDeployCallbackToken aceita scope válido sem checar binding", () => {
    const t = signDeployCallbackToken("dep-A", "proj-1");
    const d = decodeDeployCallbackToken(t);
    expect(d?.deploymentId).toBe("dep-A");
  });
});
