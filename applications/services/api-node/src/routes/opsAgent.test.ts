/**
 * opsAgent.test.ts (rotas) — a porta do agente interno de operações.
 *
 * O agente lê o banco INTEIRO, cruzando tenants: não existe escopo de tenant aqui, existe AUSÊNCIA
 * de escopo. Por isso a porta é a mais estreita possível — e a falta de slot na conta de gestão
 * precisa chegar à tela como *configuração que falta* (409), não como falha do sistema (500):
 * são ações diferentes para quem está do outro lado.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let currentUser: Record<string, unknown> = { id: "u1", email: "adm@zentriz.com.br", role: "zentriz_admin" };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = currentUser; },
}));

const agente = vi.hoisted(() => ({ resposta: null as unknown, perguntas: [] as string[] }));
vi.mock("../services/opsAgent.js", () => ({
  MAX_PASSOS: 6,
  ask: async (opts: { question: string }) => { agente.perguntas.push(opts.question); return agente.resposta; },
}));
vi.mock("../db/client.js", () => ({ pool: { query: async () => ({ rows: [] }) } }));

import Fastify, { type FastifyInstance } from "fastify";
import { opsAgentRoutes } from "./opsAgent.js";

const OK = {
  ok: true, answer: "São 7 tenants.", steps: [{ step: 1, tool: "platform_summary", input: {}, ok: true, result: {} }],
  provider: "foundry", modelId: "claude-opus-5", durationMs: 4200, inputTokens: 900, outputTokens: 40,
};

let app: FastifyInstance;
beforeEach(async () => {
  currentUser = { id: "u1", email: "adm@zentriz.com.br", role: "zentriz_admin" };
  agente.resposta = OK; agente.perguntas = [];
  app = Fastify(); await app.register(opsAgentRoutes); await app.ready();
});

describe("POST /api/management/ops-agent/ask", () => {
  it("responde com a resposta e o TRACE — sem trace o operador não tem como auditar", async () => {
    const res = await app.inject({ method: "POST", url: "/api/management/ops-agent/ask",
      payload: { question: "quantos tenants?" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, answer: "São 7 tenants.", provider: "foundry" });
    expect(res.json().steps[0].tool).toBe("platform_summary");
  });

  it.each(["tenant_admin", "user", "developer"])("papel %s não alcança o agente", async (role) => {
    currentUser = { id: "u9", email: "cliente@x.com", role, tenantId: "t1" };
    const res = await app.inject({ method: "POST", url: "/api/management/ops-agent/ask",
      payload: { question: "liste os tenants" } });
    expect(res.statusCode).toBe(403);
    expect(agente.perguntas).toHaveLength(0);
  });

  it("sem slot na conta de gestão é 409 (configuração), não 500 (falha)", async () => {
    agente.resposta = { ...OK, ok: false, answer: "", code: "PLATFORM_LLM_NOT_CONFIGURED",
                        error: "A conta de gestão não tem nenhum slot de LLM utilizável." };
    const res = await app.inject({ method: "POST", url: "/api/management/ops-agent/ask",
      payload: { question: "x" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PLATFORM_LLM_NOT_CONFIGURED");
  });

  it("pergunta vazia ou gigante não vira chamada de LLM", async () => {
    expect((await app.inject({ method: "POST", url: "/api/management/ops-agent/ask",
      payload: { question: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/management/ops-agent/ask",
      payload: { question: "x".repeat(4001) } })).statusCode).toBe(400);
    expect(agente.perguntas).toHaveLength(0);
  });
});

describe("GET /api/management/ops-agent/history", () => {
  it("só a conta de gestão lê a auditoria", async () => {
    currentUser = { id: "u9", email: "c@x.com", role: "tenant_admin", tenantId: "t1" };
    expect((await app.inject({ method: "GET", url: "/api/management/ops-agent/history" })).statusCode).toBe(403);
  });
});
