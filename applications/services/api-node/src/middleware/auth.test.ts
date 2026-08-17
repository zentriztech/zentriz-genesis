/**
 * auth.test.ts — RFC-0002 Parte B (F2 / H3): recheck de suspensão no meio da sessão.
 *
 * Verifica que o authMiddleware, com um token JÁ válido, bloqueia (403 TENANT_INACTIVE)
 * um usuário de tenant cujo tenant está não-ativo, e ISENTA corretamente:
 *   • master (zentriz_admin, tenantId null);
 *   • token de máquina do runner (svc:"runner") — RFC H1, callbacks nunca bloqueiam;
 *   • token de deploy-callback;
 *   • falha de lookup (fail-open, status null).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let statusToReturn: string | null = "active";
const getTenantStatus = vi.fn(async (_tenantId: string) => statusToReturn);
vi.mock("../services/tenantStatusCache.js", () => ({
  getTenantStatus: (id: string) => getTenantStatus(id),
}));

import { authMiddleware, type AuthUser } from "./auth.js";
import { signToken, signDeployCallbackToken } from "../auth.js";

type Sent = { code?: number; body?: { code?: string } };

function fakeReqReply(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` } } as Record<string, unknown>;
  const sent: Sent = {};
  const reply = {
    status(c: number) {
      sent.code = c;
      return { send(b: { code?: string }) { sent.body = b; return reply; } };
    },
  };
  return { req, reply: reply as never, sent };
}

beforeEach(() => {
  statusToReturn = "active";
  getTenantStatus.mockClear();
});

describe("authMiddleware — H3 recheck de suspensão", () => {
  it("tenant ativo → passa e injeta request.user", async () => {
    const token = signToken({ sub: "u1", email: "a@x.com", role: "tenant_admin", tenantId: "t1" });
    const { req, reply, sent } = fakeReqReply(token);
    await authMiddleware(req as never, reply);
    expect(sent.code).toBeUndefined();
    expect((req as { user: AuthUser }).user.tenantId).toBe("t1");
    expect(getTenantStatus).toHaveBeenCalledWith("t1");
  });

  it("tenant suspenso → 403 TENANT_INACTIVE", async () => {
    statusToReturn = "suspended";
    const token = signToken({ sub: "u1", email: "a@x.com", role: "tenant_admin", tenantId: "t1" });
    const { req, reply, sent } = fakeReqReply(token);
    await authMiddleware(req as never, reply);
    expect(sent.code).toBe(403);
    expect(sent.body?.code).toBe("TENANT_INACTIVE");
  });

  it("tenant inativo → 403", async () => {
    statusToReturn = "inactive";
    const token = signToken({ sub: "u1", email: "a@x.com", role: "user", tenantId: "t1" });
    const { req, reply, sent } = fakeReqReply(token);
    await authMiddleware(req as never, reply);
    expect(sent.code).toBe(403);
  });

  it("tenant inexistente (__missing__) → 403", async () => {
    statusToReturn = "__missing__";
    const token = signToken({ sub: "u1", email: "a@x.com", role: "user", tenantId: "t1" });
    const { req, reply, sent } = fakeReqReply(token);
    await authMiddleware(req as never, reply);
    expect(sent.code).toBe(403);
  });

  it("falha de lookup (status null) → fail-open, passa", async () => {
    statusToReturn = null;
    const token = signToken({ sub: "u1", email: "a@x.com", role: "tenant_admin", tenantId: "t1" });
    const { req, reply, sent } = fakeReqReply(token);
    await authMiddleware(req as never, reply);
    expect(sent.code).toBeUndefined();
  });

  it("master (zentriz_admin, tenantId null) → passa SEM consultar status", async () => {
    statusToReturn = "suspended";
    const token = signToken({ sub: "m1", email: "master@zentriz.com.br", role: "zentriz_admin", tenantId: null });
    const { req, reply, sent } = fakeReqReply(token);
    await authMiddleware(req as never, reply);
    expect(sent.code).toBeUndefined();
    expect(getTenantStatus).not.toHaveBeenCalled();
  });

  it("token de máquina do runner (svc:runner) tenant suspenso → passa SEM consultar status (H1)", async () => {
    statusToReturn = "suspended";
    const token = signToken({ sub: "u1", email: "a@x.com", role: "tenant_admin", tenantId: "t1", svc: "runner" });
    const { req, reply, sent } = fakeReqReply(token);
    await authMiddleware(req as never, reply);
    expect(sent.code).toBeUndefined();
    expect(getTenantStatus).not.toHaveBeenCalled();
  });

  it("token deploy-callback → passa (powerless), sem consultar status", async () => {
    statusToReturn = "suspended";
    const token = signDeployCallbackToken("dep1", "proj1");
    const { req, reply, sent } = fakeReqReply(token);
    await authMiddleware(req as never, reply);
    expect(sent.code).toBeUndefined();
    expect((req as { user: AuthUser }).user.role).toBe("deploy-callback");
    expect(getTenantStatus).not.toHaveBeenCalled();
  });

  it("sem header Authorization → 401", async () => {
    const sent: Sent = {};
    const reply = { status(c: number) { sent.code = c; return { send() { return reply; } }; } };
    await authMiddleware({ headers: {} } as never, reply as never);
    expect(sent.code).toBe(401);
  });
});
