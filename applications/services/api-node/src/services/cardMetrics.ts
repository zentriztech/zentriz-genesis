/**
 * cardMetrics.ts — F5 (5.2): consultas VERSIONADAS de leitura sobre os cards de um produto (somente SELECT).
 *
 * Contrato `CARD_METRICS_VERSION = 1` (campos só são ADICIONADOS; remover/renomear exige nova versão):
 *   byState        cards por `tickets.card_state` (todos os estados presentes na máquina, zero incluído);
 *   timeInState    tempo (s) por estado, a partir de `ticket_card_events`: o intervalo de um estado vai do evento que entrou nele ao
 *                  evento seguinte do MESMO card; o estado atual segue contando até `now()` (`open=true` no cálculo, não exposto por card);
 *   cost           custo por card = soma do `llm_call_ledger.cost_usd` dos projetos do card (rascunho de refino + filho promovido);
 *   blocked        taxa de `blocked` = cards que já passaram por `blocked` ÷ cards já promovidos (só se bloqueia depois de promover),
 *                  motivos (`blocked_reason` do evento; prefixo `budget:` = Guard de custo) e quantos estão bloqueados agora.
 * Isolamento: SEMPRE por `product_id` + `tenant_id` do produto (a rota já autorizou o produto). Nunca mistura tenants.
 * Sem estimativa: o que não há no ledger/eventos é zero ou `null`, nunca inventado.
 */
import type { Pool } from "pg";
import { CARD_STATES } from "./cardState.js";

export const CARD_METRICS_VERSION = 1;

export interface CardMetrics {
  version: number;
  productId: string;
  generatedAt: string;
  since: string | null;
  totalCards: number;
  byState: Record<string, number>;
  timeInState: Record<string, { cards: number; totalSeconds: number; avgSeconds: number | null }>;
  cost: {
    totalUsd: number; avgUsdPerCard: number | null; cardsWithCost: number;
    items: Array<{ ticketId: string; number: number; title: string; state: string | null; costUsd: number; calls: number }>;
  };
  blocked: {
    promotedCards: number; everBlockedCards: number; currentlyBlocked: number; rate: number | null;
    reasons: Array<{ reason: string; cards: number; kind: "budget" | "other" }>;
  };
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export async function loadCardMetrics(
  pool: Pick<Pool, "query">, product: { id: string; tenant_id: string | null },
  opts: { since?: string | null; limit?: number } = {},
): Promise<CardMetrics> {
  const since = opts.since ?? null;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Escopo: cards do produto, do tenant do produto, criados desde `since` (se houver).
  const scope = `t.product_id = $1 AND t.card_state IS NOT NULL AND t.tenant_id IS NOT DISTINCT FROM $2::uuid AND ($3::timestamptz IS NULL OR t.created_at >= $3::timestamptz)`;
  const base = [product.id, product.tenant_id, since];

  const states = (await pool.query(`SELECT t.card_state AS s, count(*)::int AS c FROM tickets t WHERE ${scope} GROUP BY 1`, base)).rows;
  const byState: Record<string, number> = Object.fromEntries(CARD_STATES.map((s) => [s, 0]));
  let totalCards = 0;
  for (const r of states) { byState[String(r.s)] = n(r.c); totalCards += n(r.c); }

  const tis = (await pool.query(
    `WITH ev AS (
       SELECT e.ticket_id, e.to_state AS s, e.created_at AS at,
              LEAD(e.created_at) OVER (PARTITION BY e.ticket_id ORDER BY e.created_at, e.id) AS next_at
         FROM ticket_card_events e JOIN tickets t ON t.id = e.ticket_id WHERE ${scope}
     )
     SELECT s, count(DISTINCT ticket_id)::int AS cards,
            COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(next_at, now()) - at))), 0) AS secs
       FROM ev GROUP BY s`, base)).rows;
  const timeInState: CardMetrics["timeInState"] = {};
  for (const s of CARD_STATES) timeInState[s] = { cards: 0, totalSeconds: 0, avgSeconds: null };
  for (const r of tis) {
    const cards = n(r.cards); const secs = round(n(r.secs), 1);
    timeInState[String(r.s)] = { cards, totalSeconds: secs, avgSeconds: cards > 0 ? round(secs / cards, 1) : null };
  }

  const cost = (await pool.query(
    `SELECT t.id, t.number, t.title, t.card_state,
            COALESCE(SUM(l.cost_usd), 0) AS cost, count(l.id)::int AS calls
       FROM tickets t
       LEFT JOIN llm_call_ledger l ON l.project_id IN (t.draft_project_id, t.child_project_id)
      WHERE ${scope}
      GROUP BY t.id, t.number, t.title, t.card_state`, base)).rows;
  const totalUsd = cost.reduce((a, r) => a + n(r.cost), 0);
  const withCost = cost.filter((r) => n(r.cost) > 0);
  const items = cost.sort((a, b) => n(b.cost) - n(a.cost) || n(b.number) - n(a.number)).slice(0, limit).map((r) => ({
    ticketId: String(r.id), number: n(r.number), title: String(r.title ?? ""), state: r.card_state ? String(r.card_state) : null,
    costUsd: round(n(r.cost), 6), calls: n(r.calls),
  }));

  const bl = (await pool.query(
    `SELECT (SELECT count(DISTINCT e.ticket_id)::int FROM ticket_card_events e JOIN tickets t ON t.id = e.ticket_id WHERE ${scope} AND e.to_state = 'promoted') AS promoted,
            (SELECT count(DISTINCT e.ticket_id)::int FROM ticket_card_events e JOIN tickets t ON t.id = e.ticket_id WHERE ${scope} AND e.to_state = 'blocked') AS blocked`, base)).rows[0];
  const reasons = (await pool.query(
    `SELECT COALESCE(e.reason, '(sem motivo)') AS reason, count(DISTINCT e.ticket_id)::int AS cards
       FROM ticket_card_events e JOIN tickets t ON t.id = e.ticket_id
      WHERE ${scope} AND e.to_state = 'blocked' GROUP BY 1 ORDER BY 2 DESC, 1`, base)).rows;
  const promotedCards = n(bl?.promoted); const everBlocked = n(bl?.blocked);

  return {
    version: CARD_METRICS_VERSION, productId: product.id, generatedAt: new Date().toISOString(), since, totalCards, byState, timeInState,
    cost: { totalUsd: round(totalUsd, 6), avgUsdPerCard: totalCards > 0 ? round(totalUsd / totalCards, 6) : null, cardsWithCost: withCost.length, items },
    blocked: {
      promotedCards, everBlockedCards: everBlocked, currentlyBlocked: byState.blocked ?? 0,
      rate: promotedCards > 0 ? round(everBlocked / promotedCards, 4) : null,
      reasons: reasons.map((r) => ({ reason: String(r.reason), cards: n(r.cards), kind: String(r.reason).startsWith("budget:") ? "budget" as const : "other" as const })),
    },
  };
}
