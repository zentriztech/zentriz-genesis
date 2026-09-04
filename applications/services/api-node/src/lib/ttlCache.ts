/**
 * ttlCache.ts — cache genérico em memória (por processo) com TTL curto e evicção LRU.
 *
 * Molde do `services/tenantStatusCache.ts` (mesmo padrão de cache local sem Redis na API),
 * porém genérico e sem LISTEN/NOTIFY: serve para agregações caras de LEITURA cujo dado pode
 * ficar levemente defasado (ex.: KPIs do dashboard, TTL 15s) — nunca para dados de segurança.
 *
 * Regras de segurança embutidas (auditoria adversarial do épico Spec/Bancada — GAP G3):
 *  • a CHAVE deve incluir o ESCOPO (tenant/global) — quem chama monta `kpis:<scope>:<tenantId|global>`;
 *    uma chave sem tenant vazaria KPIs de um tenant para outro;
 *  • NUNCA cachear resposta de erro (o chamador só faz `set` no caminho de sucesso);
 *  • teto de chaves (`maxKeys`, default 2000) com evicção LRU simples — mesma defesa do rateLimit.ts
 *    contra crescimento ilimitado do Map (denial-of-memory).
 *
 * Semântica: `get` devolve `undefined` para chave ausente OU expirada (o chamador recomputa e faz `set`).
 */

export interface TtlCacheOptions {
  /** Time-to-live de cada entrada em ms (default 15_000). */
  ttlMs?: number;
  /** Teto de chaves antes de evictar a menos usada recentemente (default 2000). */
  maxKeys?: number;
}

type Entry<T> = { value: T; expiresAt: number };

export class TtlCache<T> {
  private readonly ttlMs: number;
  private readonly maxKeys: number;
  // Map preserva ordem de inserção → usamos isso para LRU: no `get` reinserimos a chave
  // (vira a mais recente); no `set` além do teto, removemos a primeira (a menos recente).
  private readonly map = new Map<string, Entry<T>>();

  constructor(opts: TtlCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 15_000;
    this.maxKeys = opts.maxKeys ?? 2_000;
  }

  /** Valor cacheado se presente e não expirado; senão `undefined`. */
  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch: reinsere para marcar como recém-usada.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  /** Grava (apenas no caminho de sucesso — NUNCA cachear erro). Evicta LRU se estourar o teto. */
  set(key: string, value: T): void {
    // Se já existe, remove antes para reordenar (fica como mais recente).
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.maxKeys) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Apenas para testes/observabilidade. */
  get size(): number {
    return this.map.size;
  }
}
