/**
 * valueEvents.ts — Value meter MVP INTERNO do Genesis.
 *
 * Spec de referência: ../docs/06-recommendations/2026-08-20-value-meter-spec.md
 * (unidade de valor do Genesis = sistema entregue / deploy publicado / run concluído).
 * Persiste em `value_events` (migration 068), tabela APPEND-ONLY: nenhum código faz
 * UPDATE/DELETE nela — todo número derivado de evento real, nunca estimado por adjetivo.
 *
 * GOVERNANÇA: o contrato versionado `value-event.v1.json` no Connect fica para
 * FOLLOW-UP COM ADR — a ADR-002 proíbe ampliar o Connect sem ADR. Este MVP é
 * interno ao Genesis (tabela local, sem publicação no barramento/Connect); quando o
 * ADR sair, o enum de event_type daqui migra para o schema do Connect.
 *
 * Toda emissão é BEST-EFFORT: emitValueEvent NUNCA lança (medição de valor não pode
 * quebrar o fluxo de negócio que a origina — accept, deploy, PATCH do runner).
 */

import { getTenantMonthSpendUsd, type Queryable } from "./tenantCostCap.js";

export interface ValueEventInput {
  tenantId?: string | null;
  projectId?: string | null;
  /** Ex.: 'project_delivered' | 'deploy_completed' | 'pipeline_run_completed' | 'spec_promoted'. */
  eventType: string;
  quantity?: number;
  unit?: string;
  metadata?: Record<string, unknown>;
  source?: string;
}

/** Emite um evento de valor. Best-effort: erro vira console.warn, nunca propaga. */
export async function emitValueEvent(db: Queryable, input: ValueEventInput): Promise<void> {
  try {
    await db.query(
      `INSERT INTO value_events (tenant_id, project_id, event_type, source, quantity, unit, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.tenantId ?? null,
        input.projectId ?? null,
        input.eventType,
        input.source ?? "genesis",
        input.quantity ?? 1,
        input.unit ?? "count",
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (err) {
    console.warn(`[valueEvents] falha ao emitir '${input.eventType}' (best-effort, ignorado):`, err);
  }
}

export interface ValueReport {
  month: string; // YYYY-MM efetivo
  tenantId: string;
  /** Por event_type: nº de eventos e soma de quantity no mês. */
  events: Record<string, { count: number; quantity: number }>;
  /** Custo LLM do tenant no mês (mesma fonte dual do cost cap — tenantCostCap.ts). */
  llmCostUsd: number;
  /** llmCostUsd / quantity de project_delivered no mês; null se nenhuma entrega. */
  costPerDelivery: number | null;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Relatório de valor do tenant no mês (default: mês corrente, UTC). */
export async function getValueReport(
  db: Queryable,
  tenantId: string,
  month?: string,
): Promise<ValueReport> {
  const now = new Date();
  const effectiveMonth = month && MONTH_RE.test(month)
    ? month
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const start = `${effectiveMonth}-01`;

  const res = await db.query(
    `SELECT event_type,
            COUNT(*)::int AS event_count,
            COALESCE(SUM(quantity), 0) AS total_quantity
       FROM value_events
      WHERE tenant_id = $1
        AND created_at >= $2::date
        AND created_at <  ($2::date + interval '1 month')
      GROUP BY event_type
      ORDER BY event_type`,
    [tenantId, start],
  );

  const events: Record<string, { count: number; quantity: number }> = {};
  for (const r of res.rows) {
    events[String(r.event_type)] = {
      count: Number(r.event_count ?? 0) || 0,
      quantity: Number(r.total_quantity ?? 0) || 0,
    };
  }

  const llmCostUsd = await getTenantMonthSpendUsd(db, tenantId, effectiveMonth);
  const delivered = events["project_delivered"]?.quantity ?? 0;
  const costPerDelivery = delivered > 0
    ? parseFloat((llmCostUsd / delivered).toFixed(4))
    : null;

  return {
    month: effectiveMonth,
    tenantId,
    events,
    llmCostUsd: parseFloat(llmCostUsd.toFixed(4)),
    costPerDelivery,
  };
}
