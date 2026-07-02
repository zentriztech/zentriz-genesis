/**
 * s3CleanupWorker.ts — FT-17
 *
 * Dois jobs cron:
 *   1. Watchdog (5min): status='provisioning' AND created_at < now() - 20min → failed
 *      Fecha crash silencioso do full-test-server (builder morre mid-build).
 *   2. TTL cleanup (1h): status='running'|'running_degraded' AND expires_at < now()
 *      → destroy bucket S3 + mark destroyed.
 *
 * Roda automaticamente na inicialização do api-node (setInterval).
 */
import { pool } from "../db/client.js";
import { destroyBucket } from "./s3.js";

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let ttlTimer: ReturnType<typeof setInterval> | null = null;

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;      // 5min
const TTL_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;  // 1h
const PROVISIONING_TIMEOUT_MIN = 20;             // watchdog threshold

// ─── Watchdog: mata provisioning stuck ────────────────────────────────────
export async function runWatchdogOnce(): Promise<{ marked_failed: number }> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ id: string; project_id: string }>(
      `UPDATE ephemeral_deployments
          SET status='failed',
              error_msg=COALESCE(error_msg,'') || ' [watchdog] provisioning timeout (>' || $1 || 'min)',
              updated_at=now()
        WHERE status='provisioning'
          AND created_at < now() - ($1 || ' minutes')::interval
      RETURNING id, project_id`,
      [PROVISIONING_TIMEOUT_MIN],
    );
    if (res.rowCount && res.rowCount > 0) {
      console.warn(
        `[s3-watchdog] marked ${res.rowCount} deployment(s) as failed (provisioning timeout):`,
        res.rows.map((r) => r.id).join(", "),
      );
    }
    return { marked_failed: res.rowCount ?? 0 };
  } finally {
    client.release();
  }
}

// ─── TTL cleanup: destroi buckets expirados ───────────────────────────────
export async function runTtlCleanupOnce(): Promise<{ destroyed: number; errors: number }> {
  const client = await pool.connect();
  const toDestroy: Array<{ id: string; bucket_name: string | null; project_id: string }> = [];
  try {
    const res = await client.query<{ id: string; bucket_name: string | null; project_id: string }>(
      `SELECT id, bucket_name, project_id
         FROM ephemeral_deployments
        WHERE provider='s3-static'
          AND status IN ('running','running_degraded')
          AND expires_at < now()
        LIMIT 50`,
    );
    toDestroy.push(...res.rows);
  } finally {
    client.release();
  }

  let destroyed = 0;
  let errors = 0;
  for (const row of toDestroy) {
    if (!row.bucket_name) {
      console.warn(`[s3-cleanup] deployment ${row.id} sem bucket_name — marcando destroyed`);
      await markDestroyed(row.id);
      continue;
    }
    try {
      console.info(`[s3-cleanup] destroying bucket ${row.bucket_name} (deployment ${row.id})`);
      await destroyBucket(row.bucket_name);
      await markDestroyed(row.id);
      destroyed++;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[s3-cleanup] falha ao destruir ${row.bucket_name}: ${msg}`);
      // Não marca destroyed — próxima iteração tenta de novo
    }
  }
  if (destroyed || errors) {
    console.info(`[s3-cleanup] round complete: destroyed=${destroyed} errors=${errors}`);
  }
  return { destroyed, errors };
}

async function markDestroyed(deploymentId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE ephemeral_deployments
          SET status='destroyed', destroyed_at=now(), updated_at=now()
        WHERE id=$1`,
      [deploymentId],
    );
  } finally {
    client.release();
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────
export function startS3CleanupWorker(): void {
  if (watchdogTimer || ttlTimer) {
    console.warn("[s3-cleanup] workers já iniciados — ignorando start duplicado");
    return;
  }

  // Watchdog
  watchdogTimer = setInterval(() => {
    runWatchdogOnce().catch((err) => console.error("[s3-watchdog] erro:", err));
  }, WATCHDOG_INTERVAL_MS);
  console.info(`[s3-watchdog] iniciado (intervalo=${WATCHDOG_INTERVAL_MS / 1000}s, timeout=${PROVISIONING_TIMEOUT_MIN}min)`);

  // TTL cleanup
  ttlTimer = setInterval(() => {
    runTtlCleanupOnce().catch((err) => console.error("[s3-cleanup] erro:", err));
  }, TTL_CLEANUP_INTERVAL_MS);
  console.info(`[s3-cleanup] iniciado (intervalo=${TTL_CLEANUP_INTERVAL_MS / 1000 / 60}min)`);

  // Roda uma vez no boot (pega backlog imediato)
  setTimeout(() => {
    runWatchdogOnce().catch(() => null);
    runTtlCleanupOnce().catch(() => null);
  }, 30_000);
}

export function stopS3CleanupWorker(): void {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (ttlTimer) { clearInterval(ttlTimer); ttlTimer = null; }
}
