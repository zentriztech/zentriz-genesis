/**
 * rateLimit.ts — limitador de taxa em memória, sem dependência externa.
 *
 * Janela fixa por chave (fixed-window). Projetado para endpoints PÚBLICOS
 * (signup/request-code, consulta de CNPJ) num processo único — o container de
 * produção do Genesis é single-instance. Se um dia houver múltiplas réplicas por
 * trás de um balanceador, migrar para um store compartilhado (ex.: @fastify/rate-limit
 * + Redis); um limitador em memória por processo passa a ser só best-effort.
 *
 * Hermético em teste: por padrão vira no-op quando NODE_ENV==="test" (para não
 * flakar specs de integração que disparam muitas requisições). Testes do próprio
 * limitador passam `enableInTest: true` para exercitar a lógica.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

type Bucket = { count: number; resetAt: number };

export type RateLimitOptions = {
  /** Tamanho da janela em ms. */
  windowMs: number;
  /** Máximo de requisições permitidas por chave dentro da janela. */
  max: number;
  /** Deriva a chave da requisição. Default: IP do cliente. */
  keyFn?: (request: FastifyRequest) => string;
  /** Rótulo para diagnóstico. */
  name?: string;
  /** Exercita o limitador mesmo em NODE_ENV==="test" (só para testes do limitador). */
  enableInTest?: boolean;
};

/** IP do cliente respeitando X-Forwarded-For (primeiro hop) quando presente. */
export function clientIp(request: FastifyRequest): string {
  const xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.ip || "unknown";
}

const MAX_KEYS = 20_000; // teto de segurança contra crescimento ilimitado do Map

/**
 * Cria um preHandler Fastify que aplica rate limiting por chave. Retorna 429 com
 * envelope { code, message, retryAfterMs } e header Retry-After ao exceder.
 */
export function createRateLimiter(opts: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  function prune(now: number): void {
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }

  return async function rateLimitPreHandler(request: FastifyRequest, reply: FastifyReply) {
    if (process.env.NODE_ENV === "test" && !opts.enableInTest) return; // hermético em teste

    const now = Date.now();
    const key = (opts.keyFn ? opts.keyFn(request) : clientIp(request)) || "unknown";

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      // Varre expirados só quando o Map cresce — barato no caminho comum.
      if (buckets.size > MAX_KEYS) prune(now);
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > opts.max) {
      const retryAfterMs = Math.max(0, bucket.resetAt - now);
      reply.header("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      return reply.status(429).send({
        code: "TOO_MANY_REQUESTS",
        message: "Muitas requisições. Aguarde alguns instantes e tente novamente.",
        retryAfterMs,
      });
    }
  };
}
