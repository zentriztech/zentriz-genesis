"use client";
import { useCallback, useRef, useState } from "react";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorCode, cardErrorMessage } from "@/lib/cards/cardErrors";
import type { CardDetail, RevalidateResponse } from "@/lib/cards/types";

export type RunKey = "refine" | "ready" | "reopen" | "revalidate" | "promote" | "resume" | "reject" | "delete";

export interface CardRunner {
  busy: RunKey | null;
  error: { code?: string; message: string } | null;
  notice: string | null;
  /** Último resultado de "Revalidar" (ok | stale | conflict, com os motivos do servidor). */
  revalidation: RevalidateResponse | null;
  /** Resultado da última promoção (inclui `replayed`: nada foi duplicado). */
  promoted: { childProjectId: string; versionNumber: number; replayed: boolean } | null;
  /** Retomada que deixou o filho parado (`childRestartRequired`): mensagem do servidor + projeto a religar. */
  restart: { message: string; childProjectId: string | null } | null;
  run: (key: RunKey) => Promise<void>;
  dismiss: () => void;
}

const OK_NOTICE: Partial<Record<RunKey, string>> = {
  ready: "Especificação validada: o card está pronto para promover.",
};

/**
 * Executa as ações de estado do card num ÚNICO ponto (trava de clique duplo compartilhada entre a barra de ações, o painel de
 * promoção e a ação sugerida da jornada). Sempre recarrega o card depois, com sucesso ou erro: o servidor é quem manda no estado.
 */
export function useCardRunner(card: CardDetail, onChanged: () => void | Promise<void>, onDeleted: () => void): CardRunner {
  const [busy, setBusy] = useState<RunKey | null>(null);
  const [error, setError] = useState<CardRunner["error"]>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revalidation, setRevalidation] = useState<RevalidateResponse | null>(null);
  const [promoted, setPromoted] = useState<CardRunner["promoted"]>(null);
  const [restart, setRestart] = useState<CardRunner["restart"]>(null);
  const inFlight = useRef(false);
  const id = card.id;

  const run = useCallback(async (key: RunKey) => {
    if (inFlight.current) return;                 // clique duplo: o segundo é descartado (o servidor também é idempotente)
    inFlight.current = true; setBusy(key); setError(null); setNotice(null); setRestart(null);
    if (key !== "revalidate") setRevalidation(null);
    try {
      if (key === "refine") await cardsApi.refine(id);
      else if (key === "ready") await cardsApi.ready(id);
      else if (key === "reject") await cardsApi.reject(id);
      else if (key === "reopen") { const r = await cardsApi.reopen(id); setNotice(r.message ?? "Card reaberto: a spec voltou a aceitar edição. Valide de novo antes de promover."); }
      else if (key === "revalidate") setRevalidation(await cardsApi.revalidate(id));
      else if (key === "promote") {
        const r = await cardsApi.promote(id);
        setPromoted({ childProjectId: r.childProjectId, versionNumber: r.versionNumber, replayed: !!(r.replayed || r.resumed) });
      } else if (key === "resume") {
        const r = await cardsApi.resume(id);
        if (r.childRestartRequired) setRestart({ message: r.message ?? "A execução continua parada: reinicie-a.", childProjectId: card.childProjectId });
        else if (r.message) setNotice(r.message);
      } else if (key === "delete") { await cardsApi.remove(id); onDeleted(); return; }
      const ok = OK_NOTICE[key];
      if (ok) setNotice(ok);
      await onChanged();
    } catch (e) {
      setError({ code: cardErrorCode(e), message: cardErrorMessage(e) });
      await onChanged();
    } finally { inFlight.current = false; setBusy(null); }
  }, [id, card.childProjectId, onChanged, onDeleted]);

  const dismiss = useCallback(() => { setError(null); setNotice(null); setRestart(null); }, []);
  return { busy, error, notice, revalidation, promoted, restart, run, dismiss };
}
