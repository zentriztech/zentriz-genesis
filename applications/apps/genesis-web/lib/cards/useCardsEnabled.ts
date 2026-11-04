"use client";
import { useCallback, useEffect, useState } from "react";
import { capabilitiesKey, loadCardsCapabilities, resetCardsCapabilitiesCache } from "./capabilitiesCache";
import type { CardCapabilities } from "./types";

export { loadCardsCapabilities, resetCardsCapabilitiesCache };

// Indicador da flag `CARDS_BANCADA` do tenant: `GET /api/products/:id/cards/capabilities` → `{cardsBancada}`.
// Três estados explícitos (Y-10): carregando, resposta (flag ligada/desligada) e ERRO (com `retry`). Quem decide o destino de um
// clique (cards × diálogo legado) precisa distinguir "ainda não sei" de "desligada".
export interface CardsCapabilitiesState { loading: boolean; caps: CardCapabilities | null; error: boolean; retry: () => void }

export function useCardsCapabilities(productId: string | null | undefined, opts: { tenantKey?: string | null } = {}): CardsCapabilitiesState {
  const key = capabilitiesKey({ productId, tenantKey: opts.tenantKey });
  const [state, setState] = useState<{ loading: boolean; caps: CardCapabilities | null; error: boolean }>({ loading: !!productId && !!key, caps: null, error: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!productId || !key) { setState({ loading: false, caps: null, error: false }); return; }
    let alive = true;
    setState({ loading: true, caps: null, error: false });
    loadCardsCapabilities(productId, key)
      .then((caps) => { if (alive) setState({ loading: false, caps, error: false }); })
      .catch(() => { if (alive) setState({ loading: false, caps: null, error: true }); });
    return () => { alive = false; };
  }, [productId, key, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/** Só `true` com `cardsBancada === true`; carregando, erro e flag desligada dão `false` (use `useCardsCapabilities` para distingui-los). */
export function useCardsEnabled(productId: string | null | undefined, opts: { tenantKey?: string | null } = {}): boolean {
  return useCardsCapabilities(productId, opts).caps?.cardsBancada === true;
}
