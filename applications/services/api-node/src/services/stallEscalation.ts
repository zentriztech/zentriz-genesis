/**
 * stallEscalation.ts — watchdog de projetos TRAVADOS (escalada operacional).
 *
 * Furo real (2026-08-31): o alerta de bloqueio (`opsNotify.maybeNotifyBlock`) é tiro único.
 * Um projeto que fica em `blocked_*`/`failed`/`pending_cyborg` por dias sem ninguém agir não
 * gera mais nada — prova: Cabral "Spec sem título" preso em `blocked_cyborg` por 2 dias sem
 * ninguém perceber. Aqui o watchdog re-alerta (e-mail ops) enquanto o projeto seguir parado.
 *
 * Regras:
 *  - Candidato = status de bloqueio/falha real (`isBlockStatus`) OU `pending_cyborg` (fila do
 *    Cyborg que não andou), parado há ≥ STALL_ESCALATION_HOURS (default 6h) — "parado" =
 *    `updated_at` antigo (qualquer transição/patch reinicia a contagem).
 *  - Repetição a cada STALL_ESCALATION_REPEAT_HOURS (default 24h), no máximo
 *    STALL_ESCALATION_MAX vezes (default 3) — depois silencia (evita spam infinito; o e-mail
 *    diz explicitamente que é a última escalada).
 *  - Estado em `projects.extra.stall_escalation = {count, first_at, last_at, status}`; se o
 *    status mudar entre escaladas o contador REINICIA (novo travamento).
 *  - Idempotência de envio: `ops_notifications (project_id, kind)` com kind `stall:<status>:<n>`.
 *  - Nunca lança; cap de STALL_ESCALATION_BATCH (default 5) projetos por ciclo.
 *  - Fail-safe: `STALL_ESCALATION=off` desliga tudo (no-op sem tocar o banco).
 */
import type { Pool } from "pg";
import { isBlockStatus, notifyFactoryStalled } from "./opsNotify.js";

export type StallConfig = {
  enabled: boolean;
  hours: number;
  repeatHours: number;
  max: number;
  batch: number;
};

function envNum(name: string, def: number, min: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : def;
}

export function stallConfig(): StallConfig {
  return {
    enabled: (process.env.STALL_ESCALATION ?? "on").toLowerCase() !== "off",
    hours: envNum("STALL_ESCALATION_HOURS", 6, 0.05),
    repeatHours: envNum("STALL_ESCALATION_REPEAT_HOURS", 24, 0.05),
    max: Math.floor(envNum("STALL_ESCALATION_MAX", 3, 1)),
    batch: Math.floor(envNum("STALL_ESCALATION_BATCH", 5, 1)),
  };
}

export type StallState = { count: number; first_at: string; last_at: string; status: string };

type Candidate = {
  id: string;
  status: string;
  updated_at: Date | string;
  stall: StallState | null;
};

/** Status candidatos além dos de bloqueio real: fila do Cyborg que não anda. */
export function isStallCandidateStatus(status: string): boolean {
  return isBlockStatus(status) || status === "pending_cyborg";
}

/**
 * Decide, de forma PURA, se um candidato deve ser escalado agora e qual será o novo estado.
 * Exportada para teste. `null` = não escalar neste ciclo.
 */
export function decideEscalation(
  c: Candidate,
  cfg: StallConfig,
  now: Date = new Date(),
): { next: StallState; kind: string; hoursStalled: number; isLast: boolean } | null {
  if (!isStallCandidateStatus(c.status)) return null;
  const updated = new Date(c.updated_at).getTime();
  if (!Number.isFinite(updated)) return null;
  const hoursStalled = (now.getTime() - updated) / 3_600_000;
  if (hoursStalled < cfg.hours) return null;

  // Estado anterior só vale se for do MESMO status (status novo = travamento novo).
  const prev = c.stall && c.stall.status === c.status ? c.stall : null;
  if (prev) {
    if (prev.count >= cfg.max) return null;
    const last = new Date(prev.last_at).getTime();
    if (Number.isFinite(last) && (now.getTime() - last) / 3_600_000 < cfg.repeatHours) return null;
  }
  const count = (prev?.count ?? 0) + 1;
  const iso = now.toISOString();
  const next: StallState = { count, first_at: prev?.first_at ?? iso, last_at: iso, status: c.status };
  return { next, kind: `stall:${c.status}:${count}`, hoursStalled, isLast: count >= cfg.max };
}

/**
 * Passo do watchdog: seleciona candidatos parados, escala (e-mail ops idempotente) e persiste
 * o estado em `extra.stall_escalation`. Devolve o nº de escaladas feitas (para log/teste).
 */
export async function escalateStalledProjects(pool: Pool, now: Date = new Date(), cfgOverride?: Partial<StallConfig>): Promise<number> {
  const cfg = { ...stallConfig(), ...cfgOverride };
  if (!cfg.enabled) return 0;

  const res = await pool.query(
    `SELECT id, status, updated_at, extra->'stall_escalation' AS stall
       FROM projects
      WHERE (status LIKE 'blocked%' OR status IN ('failed', 'spec_validation_failed', 'pending_cyborg'))
        AND status NOT IN ('blocked_awaiting_expo_confirm')
        AND updated_at < $1::timestamptz - ($2::text || ' hours')::interval
      ORDER BY updated_at ASC
      LIMIT $3`,
    [now.toISOString(), String(cfg.hours), cfg.batch * 4],
  );

  let done = 0;
  for (const row of res.rows as Candidate[]) {
    if (done >= cfg.batch) break;
    const decision = decideEscalation(row, cfg, now);
    if (!decision) continue;
    try {
      // Persiste ANTES de enviar: uma falha no envio não vira loop de e-mails no próximo tick;
      // o kind idempotente em ops_notifications ainda protege contra duplo envio.
      await pool.query(
        `UPDATE projects
            SET extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('stall_escalation', $2::jsonb)
          WHERE id = $1`,
        [row.id, JSON.stringify(decision.next)],
      );
      await notifyFactoryStalled(pool, row.id, decision.kind, {
        hoursStalled: decision.hoursStalled,
        count: decision.next.count,
        max: cfg.max,
        isLast: decision.isLast,
      });
      console.warn(
        `[Watchdog][stall] projeto ${row.id.slice(0, 8)} parado em ${row.status} há ${decision.hoursStalled.toFixed(1)}h — escalada ${decision.next.count}/${cfg.max}`,
      );
      done++;
    } catch (e) {
      console.error(`[Watchdog][stall] erro ao escalar ${row.id.slice(0, 8)}:`, e);
    }
  }
  return done;
}
