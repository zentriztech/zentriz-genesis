/**
 * learning.ts — Partilha de aprendizado LOCAL→PROD do Genesis (feature #3).
 *
 * Exporta/importa o aprendizado portátil do Genesis (skills, lições globais, catálogo de specs)
 * como um bundle JSON determinístico. Fluxo típico: exportar do enxame LOCAL/dev → importar em
 * PRODUÇÃO. A importação é idempotente (UPSERT por slug, preservando métricas de uso do destino).
 *
 * Auth/RBAC: authMiddleware + zentriz_admin apenas — transportar aprendizado entre instâncias é
 * operação de plataforma da Zentriz, não de tenant.
 *
 *   GET  /api/learning/bundle   → exporta o bundle (skills + lessons globais + specs + manifest)
 *   POST /api/learning/bundle   → importa um bundle (body = envelope JSON) → contadores de merge
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import {
  exportLearningBundle,
  importLearningBundle,
  LearningBundleError,
} from "../services/learningBundle.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

/** Partilha de aprendizado entre instâncias é operação de plataforma → só zentriz_admin. */
function requireZentrizAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const user = getUser(request);
  if (user.role !== "zentriz_admin") {
    reply.status(403).send({ code: "FORBIDDEN" });
    return false;
  }
  return true;
}

export async function learningRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/learning/bundle ─────────────────────────────────────────────────
  app.get("/api/learning/bundle", async (request, reply) => {
    if (!requireZentrizAdmin(request, reply)) return;
    const bundle = await exportLearningBundle();
    return reply.send(bundle);
  });

  // ── POST /api/learning/bundle ────────────────────────────────────────────────
  app.post("/api/learning/bundle", async (request, reply) => {
    if (!requireZentrizAdmin(request, reply)) return;
    try {
      const counts = await importLearningBundle(request.body);
      return reply.send({ ok: true, ...counts });
    } catch (err) {
      if (err instanceof LearningBundleError) {
        return reply.status(400).send({ code: "INVALID_BUNDLE", error: err.message });
      }
      throw err;
    }
  });
}
