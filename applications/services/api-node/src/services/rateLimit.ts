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

/**
 * IP do cliente respeitando X-Forwarded-For quando presente — usando o ÚLTIMO hop.
 *
 * Auditoria 2026-09-02 (fix 1.1): o primeiro hop do XFF é CONTROLADO PELO CLIENTE quando o
 * proxy usa append (`$proxy_add_x_forwarded_for`) — permitia bypass do limite trocando o
 * header a cada request e "incriminar" IP de terceiro. O último hop é o que o NOSSO nginx
 * anexou (o peer real dele); com proxy que sobrescreve, primeiro==último. Sem proxy (dev),
 * não há XFF e cai em request.ip.
 */
export function clientIp(request: FastifyRequest): string {
  const xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const parts = xff.split(",");
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
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

/**
 * Rastreador de FALHAS por chave (fix 1.1 — lockout do login por e-mail).
 *
 * Diferente do createRateLimiter (que conta toda request), aqui só falhas contam —
 * senão qualquer anônimo trancaria o login da vítima spammando o e-mail dela com
 * requisições que nem tentam senha. Janela fixa, em memória, mesmo trade-off
 * single-instance do limitador acima.
 */
export function createFailureTracker(opts: { windowMs: number; max: number }) {
  const buckets = new Map<string, Bucket>();

  function bucketFor(key: string, now: number): Bucket {
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      if (buckets.size > MAX_KEYS) {
        for (const [k, old] of buckets) if (old.resetAt <= now) buckets.delete(k);
      }
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    return b;
  }

  return {
    /** true se a chave estourou o teto de falhas na janela corrente. */
    isBlocked(key: string): boolean {
      const now = Date.now();
      const b = buckets.get(key);
      if (!b || b.resetAt <= now) return false;
      return b.count >= opts.max;
    },
    recordFailure(key: string): void {
      const now = Date.now();
      bucketFor(key, now).count += 1;
    },
    retryAfterMs(key: string): number {
      const b = buckets.get(key);
      return b ? Math.max(0, b.resetAt - Date.now()) : 0;
    },
  };
}
