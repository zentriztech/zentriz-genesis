import { describe, it, expect } from "vitest";
import type { FastifyReply } from "fastify";
import type { AuthUser } from "./auth.js";
import { denyCreationForManagement, MANAGEMENT_READONLY_CREATE } from "./managementGuard.js";

/** Reply falso que captura status/body. */
function fakeReply() {
  const state: { status: number; body: unknown; sent: boolean } = { status: 200, body: undefined, sent: false };
  const reply = {
    status(code: number) {
      state.status = code;
      return reply;
    },
    send(payload: unknown) {
      state.body = payload;
      state.sent = true;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, state };
}

function user(role: AuthUser["role"], tenantId: string | null = "11111111-1111-1111-1111-111111111111"): AuthUser {
  return { id: "u1", email: "x@y.z", role, tenantId } as AuthUser;
}

describe("denyCreationForManagement (RFC-0002 A.1)", () => {
  it("bloqueia zentriz_admin com 403 e código MANAGEMENT_ACCOUNT_READONLY_CREATE", () => {
    const { reply, state } = fakeReply();
    const blocked = denyCreationForManagement(user("zentriz_admin", null), reply);
    expect(blocked).toBe(true);
    expect(state.sent).toBe(true);
    expect(state.status).toBe(403);
    expect(state.body).toEqual(MANAGEMENT_READONLY_CREATE);
  });

  it("bloqueia zentriz_admin mesmo quando um tenant está selecionado (não autora nunca)", () => {
    const { reply, state } = fakeReply();
    const blocked = denyCreationForManagement(user("zentriz_admin", "22222222-2222-2222-2222-222222222222"), reply);
    expect(blocked).toBe(true);
    expect(state.status).toBe(403);
  });

  it("NÃO bloqueia tenant_admin (segue o fluxo normal, reply intacto)", () => {
    const { reply, state } = fakeReply();
    const blocked = denyCreationForManagement(user("tenant_admin"), reply);
    expect(blocked).toBe(false);
    expect(state.sent).toBe(false);
    expect(state.status).toBe(200);
  });

  it("NÃO bloqueia user comum", () => {
    const { reply, state } = fakeReply();
    const blocked = denyCreationForManagement(user("user"), reply);
    expect(blocked).toBe(false);
    expect(state.sent).toBe(false);
  });
});
