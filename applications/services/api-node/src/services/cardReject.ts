/**
 * cardReject.ts — recusa HUMANA do card, inclusive o card pendurado em `promoted|in_factory` (saída humana, rodada 4.5c/BD).
 *
 * Problema: o filho foi aceito, mas o PR foi FECHADO sem merge (ou ficou quebrado) — o card não pode ser entregue e a máquina não
 * oferecia saída (`PATCH {status:"rejected"}` ⇒ 409). Agora `promoted|in_factory|blocked → rejected` (ator `user`) é uma aresta da
 * máquina (`cardState.ts`); este módulo só colhe a PROVA de merge FORA do lock (a rede nunca entra na transação) e traduz o resultado.
 *
 * Garantias (todas na transação de `transitionCard`):
 *   • filho vivo e parado é ARQUIVADO por CAS com a marca `extra.card_rejected`; se mudar no meio, TUDO é desfeito (ticket incluído);
 *   • filho em execução ⇒ `child_active` (pare/descarte antes);
 *   • filho ACEITO com PR mergeado ⇒ `child_deliverable` (409 `CARD_ALREADY_DELIVERABLE`): entrega real nunca é recusada;
 *     prova inconclusiva (GitHub fora, sem instalação) ⇒ `merge_unverified` (409 `CARD_MERGE_UNVERIFIED`): fail-closed;
 *   • card já `delivered` não recusa (aresta inexistente); repetir é `noop`; corrida com a entrega é serializada pelo `FOR UPDATE`;
 *   • auditoria em `ticket_card_events` com motivo (default `manual_reject_in_factory` para promoted|in_factory).
 * O PR aberto/fechado no GitHub NÃO é tocado: fechar/descartar o PR é do humano (runbook CARDS-BANCADA-RUNBOOK).
 */
import type { Pool } from "pg";
import { transitionCard, isSupersededChild, type CardState, type CardTransitionArgs, type CardTransitionResult } from "./cardState.js";
import { verifyChildPrMerged, type DeliveryDeps } from "./cardDelivery.js";
import { ticketCode } from "./tickets.js";

export const DEFAULT_REJECT_IN_FACTORY_REASON = "manual_reject_in_factory";

/** `detail` de `verifyChildPrMerged` que PROVAM "não mergeado" (PR consultado e aberto/fechado, ou nenhum PR existe). */
const PROVEN_NOT_MERGED = new Set(["pr_not_merged", "no_pr", "push_pending", "pr_closed_successor_not_merged"]);

export async function collectRejectProof(pool: Pick<Pool, "query">, childId: string, deps: DeliveryDeps = {}): Promise<NonNullable<CardTransitionArgs["rejectProof"]>> {
  const proof = await verifyChildPrMerged(pool, childId, deps);
  if (proof.merged) return { childProjectId: childId, verified: true, merged: true, detail: proof.source };
  return { childProjectId: childId, verified: PROVEN_NOT_MERGED.has(proof.detail), merged: false, detail: proof.detail };
}

/**
 * Recusa humana de um card. `reason`: código do sistema (sem PII); ausente ⇒ default por estado. Nunca lança por regra de negócio.
 */
export async function rejectCardByUser(
  pool: Pool, cardId: string, user: { id: string }, opts: { reason?: string; deps?: DeliveryDeps } = {},
): Promise<CardTransitionResult> {
  const cur = (await pool.query(
    `SELECT t.card_state, t.child_project_id, p.status AS child_status, p.extra AS child_extra
       FROM tickets t LEFT JOIN projects p ON p.id = t.child_project_id WHERE t.id = $1`, [cardId])).rows[0] as
    { card_state: CardState | null; child_project_id: string | null; child_status: string | null; child_extra: unknown } | undefined;
  let rejectProof: CardTransitionArgs["rejectProof"];
  const fromFactory = cur?.card_state === "promoted" || cur?.card_state === "in_factory";
  if (cur && (fromFactory || cur.card_state === "blocked") && cur.child_project_id
      && (cur.child_status === "accepted" || isSupersededChild(cur.child_status, cur.child_extra))) {
    rejectProof = await collectRejectProof(pool, cur.child_project_id, opts.deps ?? {});
  }
  const reason = (opts.reason ?? "").trim() || (fromFactory ? DEFAULT_REJECT_IN_FACTORY_REASON : "user_reject");
  return transitionCard(pool, { ticketId: cardId, to: "rejected", actorKind: "user", actorId: user.id, reason, ...(rejectProof ? { rejectProof } : {}) });
}

export type RejectFailure = { status: number; body: Record<string, unknown> };

/** Traduz um resultado NÃO aplicado da recusa em resposta HTTP (`null` = aplicado/noop). Cobre as pré-condições novas. */
export function rejectFailureOf(card: { number: number; id: string }, r: CardTransitionResult): RejectFailure | null {
  const code = ticketCode(card.number);
  switch (r.kind) {
    case "applied": case "noop": return null;
    case "invalid":
      return { status: 409, body: { code: "CARD_INVALID_TRANSITION", from: r.from, to: r.to, allowed: r.allowed, message: `${code}: transição ${r.from} → ${r.to} não é permitida.` } };
    case "diverged":
      return { status: 409, body: { code: "CARD_DIVERGED", cardState: r.cardState, status: r.status, message: `${code}: o status legado (${r.status}) diverge do estado do card (${r.cardState}); corrija antes de transitar.` } };
    case "not_found": case "not_a_card":
      return { status: 404, body: { code: "NOT_FOUND", message: "Card não encontrado" } };
    case "precondition_failed":
      switch (r.code) {
        case "child_deliverable":
          return { status: 409, body: { code: "CARD_ALREADY_DELIVERABLE", message: `${code}: o PR do filho JÁ foi mergeado — é uma entrega real e não pode ser recusada. Aguarde o reconciliador marcar o card como entregue (ou rode a passada) em vez de recusar.`, action: "Não recuse. O card será marcado como entregue pelo sistema." } };
        case "merge_unverified":
          return { status: 409, body: { code: "CARD_MERGE_UNVERIFIED", message: `${code}: não foi possível PROVAR que o PR do filho não foi mergeado (GitHub indisponível, instalação ausente ou PR não consultável). Por segurança a recusa foi negada; tente de novo.`, action: "Repita a recusa quando o GitHub estiver acessível." } };
        case "child_active":
          return { status: 409, body: { code: "CARD_CHILD_ACTIVE", message: `${code}: o filho ainda está em execução. Pare ou descarte a execução antes de recusar o card.` } };
        case "child_changed":
          return { status: 409, body: { code: "CARD_CHILD_CHANGED", message: `${code}: o filho mudou de estado durante a recusa. Nada foi alterado; tente de novo.` } };
        default:
          return { status: 409, body: { code: "CARD_INVALID_TRANSITION", to: "rejected", message: `${code}: recusa não aplicada (${r.code}).` } };
      }
    default:
      return { status: 409, body: { code: "CARD_INVALID_TRANSITION", to: "rejected", message: `${code}: recusa não aplicada (${r.kind}).` } };
  }
}
