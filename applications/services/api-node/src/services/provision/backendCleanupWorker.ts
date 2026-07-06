/**
 * backendCleanupWorker.ts — G1-T22 (Fase D). Worker de limpeza do provisionamento backend.
 *
 * SEPARADO do s3CleanupWorker (que fica intacto: 20min/1h, AWS_S3_DEPLOY_*). Aqui:
 *
 *  1. Watchdog por FASE (15min): marca FAILED só deploys travados em fases MECÂNICAS
 *     (building/pushing/creating_service) por >45min. EXCLUI 'migrating' e
 *     'waiting_cert_dns' de propósito — migrate de RDS grande e emissão de cert DNS
 *     legitimamente demoram; matá-los seria regressão.
 *
 *  2. Sweep de teardown (10min): pega deploys 'failed'/'destroying' COM recursos vivos
 *     (backend_deployment_resources) e chama teardownDeployment — libera custo sem
 *     depender de ação manual.
 *
 * ANTI-REGRESSÃO: nunca toca ephemeral_deployments (S3). Query só em backend_deployments.
 */

import { pool } from "../../db/client.js";
import { listDeploymentsForTeardown, reapExpiredDemos } from "./backendState.js";
import { teardownDeployment } from "./teardown.js";

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;   // 5min
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;     // 10min
const MECHANICAL_TIMEOUT_MIN = 45;            // fases mecânicas: 45min

/** Fases mecânicas onde o travamento indica crash (NÃO inclui migrating/waiting_cert_dns). */
const MECHANICAL_PHASES = ["building", "pushing", "creating_service"];

/**
 * Watchdog: deploys presos numa fase mecânica há mais de 45min → FAILED.
 * MIGRATING e WAITING_CERT_DNS ficam de fora (demoram legitimamente).
 */
export async function runBackendWatchdogOnce(): Promise<{ marked_failed: number }> {
  const res = await pool.query<{ id: string }>(
    `UPDATE backend_deployments
        SET status='failed',
            error_msg=COALESCE(error_msg,'') || ' [backend-watchdog] fase mecânica travada (>' || $2 || 'min)',
            updated_at=now()
      WHERE status = ANY($1)
        AND updated_at < now() - ($2 || ' minutes')::interval
    RETURNING id`,
    [MECHANICAL_PHASES, MECHANICAL_TIMEOUT_MIN],
  );
  if (res.rowCount && res.rowCount > 0) {
    console.warn(`[backend-watchdog] ${res.rowCount} deploy(s) → failed (fase mecânica travada):`,
      res.rows.map((r) => r.id).join(", "));
  }
  return { marked_failed: res.rowCount ?? 0 };
}

/**
 * Sweep: deploys failed/destroying com recursos vivos → teardown (libera custo).
 */
export async function runBackendCleanupOnce(): Promise<{ swept: number; errors: number; reaped: number }> {
  // DM-T10: primeiro marca demos expiradas (TTL) como 'destroying' — o sweep as tear-downa.
  let reaped = 0;
  try { reaped = await reapExpiredDemos(); } catch { /* segue */ }
  if (reaped) console.info(`[backend-cleanup] ${reaped} demo(s) expirada(s) marcada(s) p/ destruição`);

  let rows;
  try { rows = await listDeploymentsForTeardown(); } catch { return { swept: 0, errors: 0, reaped }; }
  let swept = 0, errors = 0;
  for (const dep of rows.slice(0, 20)) {
    try {
      const r = await teardownDeployment(dep.id);
      if (r.ok) swept++; else errors++;
    } catch (err) {
      errors++;
      console.error(`[backend-cleanup] teardown ${dep.id} falhou:`, err instanceof Error ? err.message : String(err));
    }
  }
  if (swept || errors) console.info(`[backend-cleanup] round: swept=${swept} errors=${errors}`);
  return { swept, errors, reaped };
}

export function startBackendCleanupWorker(): void {
  if (watchdogTimer || sweepTimer) {
    console.warn("[backend-cleanup] workers já iniciados — ignorando start duplicado");
    return;
  }
  watchdogTimer = setInterval(() => {
    runBackendWatchdogOnce().catch((err) => console.error("[backend-watchdog] erro:", err));
  }, WATCHDOG_INTERVAL_MS);
  sweepTimer = setInterval(() => {
    runBackendCleanupOnce().catch((err) => console.error("[backend-cleanup] erro:", err));
  }, SWEEP_INTERVAL_MS);
  console.info(`[backend-cleanup] iniciado (watchdog=${MECHANICAL_TIMEOUT_MIN}min fases mecânicas; sweep=${SWEEP_INTERVAL_MS / 60000}min)`);
  // Backlog no boot.
  setTimeout(() => {
    runBackendWatchdogOnce().catch(() => null);
    runBackendCleanupOnce().catch(() => null);
  }, 45_000);
}

export function stopBackendCleanupWorker(): void {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
