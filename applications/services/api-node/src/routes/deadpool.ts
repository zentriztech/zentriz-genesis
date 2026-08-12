/**
 * deadpool.ts — GATEWAY server-side para a API do Deadpool.
 *
 * Expõe /api/deadpool/* no backend Genesis, fazendo proxy autenticado para a API HTTP
 * do Deadpool. Mantém as credenciais do Deadpool no servidor (services/deadpoolClient.ts)
 * e aplica o RBAC do Genesis. O portal web só chama o Genesis, nunca o Deadpool direto.
 *
 * Auth/RBAC: mesmo padrão dos módulos admin (ver routes/llm.ts) —
 *   app.addHook("preHandler", authMiddleware) + checagem tenant_admin | zentriz_admin.
 *
 * Rotas (todas GET, JSON):
 *   GET /api/deadpool/status          → Deadpool GET /health + GET /ready
 *   GET /api/deadpool/projects        → Deadpool GET /projects
 *   GET /api/deadpool/incidents       → Deadpool GET /incidents?view=summary
 *   GET /api/deadpool/incidents/:id   → Deadpool GET /incidents/{id}
 *   GET /api/deadpool/knowledge       → Deadpool GET /knowledge
 *
 * Degradação graciosa: se DEADPOOL_BASE_URL não estiver setada OU a chamada
 * falhar/estourar timeout, responde HTTP 200 com payload vazio (available:false).
 * Nunca 500 por Deadpool ausente. O Deadpool responde em snake_case — repassamos como veio.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { deadpoolGet, isDeadpoolConfigured } from "../services/deadpoolClient.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

/** Exige tenant_admin ou zentriz_admin (mesmo pattern de routes/llm.ts). Retorna false se já respondeu 403. */
function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const user = getUser(request);
  if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
    reply.status(403).send({ code: "FORBIDDEN" });
    return false;
  }
  return true;
}

/** Motivo curto e seguro (sem vazar credenciais) para o payload degradado + log warn. */
function degradeReason(err: unknown): string {
  if (!isDeadpoolConfigured()) return "not_configured";
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  return "unreachable";
}

export async function deadpoolRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/deadpool/status ─────────────────────────────────────────────────
  app.get("/api/deadpool/status", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!isDeadpoolConfigured()) {
      return reply.send({ available: false, reason: "not_configured" });
    }
    try {
      const [health, ready] = await Promise.all([
        deadpoolGet("/health"),
        deadpoolGet("/ready"),
      ]);
      return reply.send({ available: true, health, ready });
    } catch (err) {
      const reason = degradeReason(err);
      app.log.warn({ route: "deadpool/status", reason }, "Deadpool status indisponível (degradado)");
      return reply.send({ available: false, reason });
    }
  });

  // ── GET /api/deadpool/projects ───────────────────────────────────────────────
  app.get("/api/deadpool/projects", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const data = await deadpoolGet<{ projects?: unknown[] }>("/projects");
      return reply.send({ available: true, projects: data?.projects ?? [] });
    } catch (err) {
      app.log.warn({ route: "deadpool/projects", reason: degradeReason(err) }, "Deadpool projects indisponível (degradado)");
      return reply.send({ available: false, projects: [] });
    }
  });

  // ── GET /api/deadpool/incidents ──────────────────────────────────────────────
  app.get("/api/deadpool/incidents", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const data = await deadpoolGet<{ incidents?: unknown[] }>("/incidents?view=summary");
      return reply.send({ available: true, incidents: data?.incidents ?? [] });
    } catch (err) {
      app.log.warn({ route: "deadpool/incidents", reason: degradeReason(err) }, "Deadpool incidents indisponível (degradado)");
      return reply.send({ available: false, incidents: [] });
    }
  });

  // ── GET /api/deadpool/incidents/:id ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/deadpool/incidents/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const id = encodeURIComponent(request.params.id);
    try {
      const data = await deadpoolGet(`/incidents/${id}`);
      return reply.send(data);
    } catch (err) {
      app.log.warn({ route: "deadpool/incidents/:id", reason: degradeReason(err) }, "Deadpool incident indisponível (degradado)");
      return reply.send({ available: false, incident: null });
    }
  });

  // ── GET /api/deadpool/knowledge ──────────────────────────────────────────────
  app.get("/api/deadpool/knowledge", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const data = await deadpoolGet<{ entries?: unknown[] }>("/knowledge");
      return reply.send({ available: true, entries: data?.entries ?? [] });
    } catch (err) {
      app.log.warn({ route: "deadpool/knowledge", reason: degradeReason(err) }, "Deadpool knowledge indisponível (degradado)");
      return reply.send({ available: false, entries: [] });
    }
  });
}
