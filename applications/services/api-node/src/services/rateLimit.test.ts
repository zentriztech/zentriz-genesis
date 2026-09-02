import { describe, it, expect } from "vitest";
import { createRateLimiter, clientIp } from "./rateLimit.js";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Reply falso que captura status/body/headers. */
function fakeReply() {
  const state: { status: number; body: unknown; headers: Record<string, string>; sent: boolean } = {
    status: 200,
    body: undefined,
    headers: {},
    sent: false,
  };
  const reply = {
    status(code: number) {
      state.status = code;
      return reply;
    },
    header(k: string, v: string) {
      state.headers[k] = v;
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

function reqWithIp(ip: string, headers: Record<string, string> = {}): FastifyRequest {
  return { ip, headers } as unknown as FastifyRequest;
}

describe("rateLimit — janela fixa por chave (enableInTest)", () => {
  it("permite até max e bloqueia com 429 + Retry-After ao exceder", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3, enableInTest: true });
    const req = reqWithIp("1.1.1.1");

    for (let i = 0; i < 3; i++) {
      const { reply, state } = fakeReply();
      await limiter(req, reply);
      expect(state.sent).toBe(false); // dentro do limite → não responde (segue o handler)
    }
    const { reply, state } = fakeReply();
    await limiter(req, reply);
    expect(state.sent).toBe(true);
    expect(state.status).toBe(429);
    expect((state.body as { code: string }).code).toBe("TOO_MANY_REQUESTS");
    expect(state.headers["Retry-After"]).toBeDefined();
  });

  it("isola por chave — IPs diferentes têm baldes independentes", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, enableInTest: true });
    const a = fakeReply();
    await limiter(reqWithIp("2.2.2.2"), a.reply);
    expect(a.state.sent).toBe(false);

    const b = fakeReply();
    await limiter(reqWithIp("3.3.3.3"), b.reply);
    expect(b.state.sent).toBe(false); // outro IP não é afetado

    const a2 = fakeReply();
    await limiter(reqWithIp("2.2.2.2"), a2.reply);
    expect(a2.state.status).toBe(429); // segundo hit do mesmo IP estoura
  });

  it("keyFn customizada agrupa por e-mail", async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      enableInTest: true,
      keyFn: (r) => `email:${(r as unknown as { body?: { email?: string } }).body?.email ?? ""}`,
    });
    const mk = (email: string) => ({ ip: "9.9.9.9", headers: {}, body: { email } } as unknown as FastifyRequest);
    const first = fakeReply();
    await limiter(mk("x@y.com"), first.reply);
    expect(first.state.sent).toBe(false);
    const second = fakeReply();
    await limiter(mk("x@y.com"), second.reply); // mesmo e-mail, IP igual → estoura
    expect(second.state.status).toBe(429);
  });

  it("é no-op em teste sem enableInTest (hermético para specs de integração)", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    for (let i = 0; i < 5; i++) {
      const { reply, state } = fakeReply();
      await limiter(reqWithIp("4.4.4.4"), reply);
      expect(state.sent).toBe(false);
    }
  });

  it("clientIp usa o ÚLTIMO hop de X-Forwarded-For (o que o nosso proxy anexou — fix 1.1)", () => {
    // Primeiro hop é forjável pelo cliente sob append; o último é o peer real do nginx.
    expect(clientIp(reqWithIp("10.0.0.1", { "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(reqWithIp("10.0.0.1", { "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(reqWithIp("10.0.0.1"))).toBe("10.0.0.1");
  });

  it("createFailureTracker só bloqueia após max FALHAS e destrava ao expirar a janela", async () => {
    const { createFailureTracker } = await import("./rateLimit.js");
    const t = createFailureTracker({ windowMs: 50, max: 3 });
    expect(t.isBlocked("a@b.c")).toBe(false);
    t.recordFailure("a@b.c");
    t.recordFailure("a@b.c");
    expect(t.isBlocked("a@b.c")).toBe(false); // 2 < 3
    t.recordFailure("a@b.c");
    expect(t.isBlocked("a@b.c")).toBe(true); // 3 >= 3
    expect(t.isBlocked("outro@b.c")).toBe(false); // isolado por chave
    expect(t.retryAfterMs("a@b.c")).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.isBlocked("a@b.c")).toBe(false); // janela expirou
  });
});
