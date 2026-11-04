"use client";
import { useEffect, useState } from "react";
import { cardsApi } from "./cardsApi";
import type { CardCapabilities } from "./types";

// Indicador da flag `CARDS_BANCADA` do tenant: `GET /api/products/:id/cards/capabilities` → `{cardsBancada}`
// (relatório R §2). Cache por produto na sessão da aba. Falha/404/flag off ⇒ false (portal idêntico ao atual).
const cache = new Map<string, Promise<CardCapabilities | null>>();

export function resetCardsCapabilitiesCache() { cache.clear(); }

export function loadCardsCapabilities(productId: string): Promise<CardCapabilities | null> {
  let p = cache.get(productId);
  if (!p) {
    p = cardsApi.capabilities(productId).catch(() => null);
    cache.set(productId, p);
  }
  return p;
}

export function useCardsCapabilities(productId: string | null | undefined): { loading: boolean; caps: CardCapabilities | null } {
  const [state, setState] = useState<{ loading: boolean; caps: CardCapabilities | null }>({ loading: !!productId, caps: null });
  useEffect(() => {
    if (!productId) { setState({ loading: false, caps: null }); return; }
    let alive = true;
    setState({ loading: true, caps: null });
    void loadCardsCapabilities(productId).then((caps) => { if (alive) setState({ loading: false, caps }); });
    return () => { alive = false; };
  }, [productId]);
  return state;
}

export function useCardsEnabled(productId: string | null | undefined): boolean {
  return useCardsCapabilities(productId).caps?.cardsBancada === true;
}
