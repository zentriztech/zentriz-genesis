import { ApiError } from "@/lib/api";
import { cardsApi } from "./cardsApi";
import type { CardCapabilities } from "./types";

// Cache das capacidades (`CARDS_BANCADA`) por chave: produto (`p:<id>`) ou tenant (`t:<id>`). Fica FORA do React para o logout poder
// zerá-lo (Y-19). Só resultados DETERMINÍSTICOS entram no cache: a resposta do servidor (flag ligada ou desligada) e o 404 (produto
// inexistente ou de outro tenant). Falha de rede, 401, 5xx etc. NÃO são cacheadas (Y-10): a próxima consulta tenta de novo.
const cache = new Map<string, Promise<CardCapabilities | null>>();
let epoch = 0;

/** Zera o cache (logout, troca de tenant, testes). Consultas em voo antes do reset não repovoam o cache. */
export function resetCardsCapabilitiesCache(): void { cache.clear(); epoch++; }

export function capabilitiesKey(o: { productId?: string | null; tenantKey?: string | null }): string | null {
  if (o.tenantKey) return `t:${o.tenantKey}`;
  return o.productId ? `p:${o.productId}` : null;
}

/** `null` = flag desligada/produto inexistente (404). Rejeita nos demais erros (sem cache). */
export function loadCardsCapabilities(productId: string, key: string = `p:${productId}`): Promise<CardCapabilities | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  const mine = epoch;
  const p = cardsApi.capabilities(productId).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return null;
    if (cache.get(key) === p) cache.delete(key);
    throw e;
  });
  if (mine === epoch) cache.set(key, p);
  return p;
}
