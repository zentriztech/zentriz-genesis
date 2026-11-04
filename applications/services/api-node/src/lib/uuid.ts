/**
 * uuid.ts — identificadores de recurso em forma CANÔNICA (Y-04/Y-16 da revisão adversarial da Fase 3).
 *
 * O Postgres aceita UUID em formas que o texto da requisição não normaliza: sem hífens, entre chaves, com hífens em outras
 * posições. Um guarda que compara o TEXTO CRU com um regex canônico (`^[0-9a-f-]{36}$`) responde "não é rascunho" para essas
 * formas, enquanto a consulta `WHERE id = $1` as resolve para a mesma linha. Regra: a forma canônica é decidida UMA vez, no
 * começo; depois disso só o id lido do banco (`row.id`) circula.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CANONICAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID na forma canônica 8-4-4-4-12 (maiúsculas ou minúsculas). */
export function isCanonicalUuid(v: unknown): v is string {
  return typeof v === "string" && CANONICAL_RE.test(v);
}

/**
 * Forma canônica minúscula de qualquer variante que o Postgres aceitaria como UUID (32 hex com hífens opcionais, com ou sem chaves);
 * `null` para o que não é UUID. Não confia no texto de entrada: devolve sempre uma string reconstruída.
 */
export function toCanonicalUuid(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1);
  if (!/^[0-9a-f-]+$/i.test(s)) return null;
  const hex = s.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** É um UUID em forma NÃO canônica (sem hífens, entre chaves, hífens deslocados)? É o formato que contornava as guardas. */
export function isNonCanonicalUuid(v: unknown): boolean {
  return typeof v === "string" && !isCanonicalUuid(v) && toCanonicalUuid(v) !== null;
}

export const INVALID_ID_BODY = {
  code: "INVALID_ID",
  message: "Identificador inválido: use o UUID na forma canônica (8-4-4-4-12, com hífens e sem chaves).",
} as const;

/**
 * Hook `preHandler` (registre DEPOIS do `authMiddleware`: o 401 vem antes do 400): recusa com 400 `INVALID_ID` um id de PROJETO em forma não canônica — `:id` das rotas `/api/projects/:id/...`,
 * `projectId` do corpo e da query. Texto que nem parece UUID segue intacto (cada rota responde 400/404 do seu jeito).
 */
export function canonicalProjectIdHook() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const path = String(request.url ?? "").split("?")[0];
    const candidates: unknown[] = [];
    if (path.startsWith("/api/projects/")) candidates.push(params.id);
    const body = request.body;
    if (body && typeof body === "object" && !Array.isArray(body)) candidates.push((body as Record<string, unknown>).projectId);
    const query = (request.query ?? {}) as Record<string, unknown>;
    candidates.push(query.projectId);
    if (candidates.some(isNonCanonicalUuid)) {
      await reply.status(400).send(INVALID_ID_BODY);
    }
  };
}

/** Registra o hook acima num plugin Fastify. */
export function useCanonicalProjectIds(app: FastifyInstance): void {
  app.addHook("preHandler", canonicalProjectIdHook());
}
