import type { FastifyInstance } from "fastify";
import { lookupCnpj, isValidCnpj, normalizeCnpjDigits } from "../services/cnpjLookup.js";
import { createRateLimiter } from "../services/rateLimit.js";

// Endpoint público/anônimo: limita por IP (defesa em profundidade junto do cache do
// serviço, que já absorve consultas repetidas ao mesmo CNPJ).
const cnpjIpLimiter = createRateLimiter({ name: "cnpj-ip", windowMs: 60_000, max: 30 });

/**
 * Rota pública de consulta de CNPJ (usada no signup e no cadastro de tenant).
 * GET /api/cnpj/:cnpj → dados cadastrais normalizados (razão social, endereço…).
 *
 * Pública porque o formulário de signup é anônimo. Degrada com clareza: CNPJ inválido
 * → 400; provider indisponível / não encontrado → 502 com mensagem amigável (o front
 * apenas mantém os campos manuais, sem quebrar o fluxo).
 */
export async function cnpjRoutes(app: FastifyInstance) {
  app.get<{ Params: { cnpj: string } }>("/api/cnpj/:cnpj", { preHandler: cnpjIpLimiter }, async (request, reply) => {
    const raw = request.params.cnpj ?? "";
    const digits = normalizeCnpjDigits(raw);
    if (!isValidCnpj(digits)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "CNPJ inválido" });
    }
    try {
      const data = await lookupCnpj(digits);
      return reply.send(data);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Falha ao consultar CNPJ";
      return reply.status(502).send({ code: "CNPJ_LOOKUP_FAILED", message });
    }
  });
}
