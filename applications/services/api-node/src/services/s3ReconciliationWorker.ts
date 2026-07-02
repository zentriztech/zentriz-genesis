/**
 * s3ReconciliationWorker.ts — FT-17
 *
 * Job semanal (domingo 03:00) que reconcilia estado AWS ↔ DB:
 *   - Órfãos AWS-sem-DB (bucket com tag zentriz:product=genesis mas sem row) → destroy
 *   - Órfãos DB-sem-AWS (row status='running' mas bucket não existe) → mark destroyed
 *
 * Reporta via console (integrar com Slack/email em v2).
 */
import { pool } from "../db/client.js";
import { listGenesisBucketsByTag, destroyBucket } from "./s3.js";

let reconciliationTimer: ReturnType<typeof setInterval> | null = null;
const RECONCILIATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // semanal

export interface ReconciliationReport {
  aws_orphans_destroyed: number;
  db_orphans_marked: number;
  errors: number;
  aws_bucket_count: number;
  db_active_count: number;
}

export async function runReconciliationOnce(): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    aws_orphans_destroyed: 0,
    db_orphans_marked: 0,
    errors: 0,
    aws_bucket_count: 0,
    db_active_count: 0,
  };

  // 1. Lista buckets AWS com tag zentriz:product=genesis
  let awsBuckets: Array<{ bucketName: string; deploymentId?: string; ttlExpiresAt?: string }> = [];
  try {
    awsBuckets = await listGenesisBucketsByTag();
    report.aws_bucket_count = awsBuckets.length;
  } catch (err) {
    console.error("[s3-reconciliation] listGenesisBucketsByTag falhou:", err);
    report.errors++;
    return report;
  }

  // 2. Lista deployments ativos no DB
  const client = await pool.connect();
  const dbBuckets = new Map<string, { id: string; status: string; expires_at: Date }>();
  try {
    const res = await client.query<{
      id: string;
      bucket_name: string | null;
      status: string;
      expires_at: Date;
    }>(
      `SELECT id, bucket_name, status, expires_at
         FROM ephemeral_deployments
        WHERE provider='s3-static'
          AND status IN ('provisioning','running','running_degraded')`,
    );
    for (const row of res.rows) {
      if (row.bucket_name) {
        dbBuckets.set(row.bucket_name, {
          id: row.id,
          status: row.status,
          expires_at: row.expires_at,
        });
      }
    }
    report.db_active_count = res.rowCount ?? 0;
  } finally {
    client.release();
  }

  // 3. Órfãos AWS-sem-DB (bucket existe mas nenhum deployment ativo o referencia)
  for (const b of awsBuckets) {
    if (dbBuckets.has(b.bucketName)) continue;

    // Bucket com tag genesis mas sem row DB → verificar se está de fato órfão
    // Query pelo deployment_id (mesmo já destroyed) para confirmar procedência
    const cli = await pool.connect();
    try {
      const q = await cli.query(
        `SELECT id, status FROM ephemeral_deployments WHERE bucket_name=$1 LIMIT 1`,
        [b.bucketName],
      );
      if (q.rowCount === 0 || q.rows[0].status === "destroyed") {
        // Verdadeiro órfão — destruir
        console.warn(`[s3-reconciliation] AWS orphan: ${b.bucketName} — destroying`);
        try {
          await destroyBucket(b.bucketName);
          report.aws_orphans_destroyed++;
        } catch (err) {
          report.errors++;
          console.error(`[s3-reconciliation] falha ao destruir órfão ${b.bucketName}:`, err);
        }
      }
    } finally {
      cli.release();
    }
  }

  // 4. Órfãos DB-sem-AWS (row diz running, mas bucket não está na AWS)
  const awsBucketNames = new Set(awsBuckets.map((b) => b.bucketName));
  for (const [bucketName, info] of dbBuckets.entries()) {
    if (awsBucketNames.has(bucketName)) continue;
    // provisioning é OK ficar sem bucket (ainda não criou)
    if (info.status === "provisioning") continue;
    console.warn(`[s3-reconciliation] DB orphan: deployment ${info.id} (bucket ${bucketName} não existe na AWS) — marking destroyed`);
    const cli = await pool.connect();
    try {
      await cli.query(
        `UPDATE ephemeral_deployments
            SET status='destroyed', destroyed_at=now(),
                error_msg=COALESCE(error_msg,'') || ' [reconciliation] bucket ausente na AWS',
                updated_at=now()
          WHERE id=$1`,
        [info.id],
      );
      report.db_orphans_marked++;
    } catch (err) {
      report.errors++;
      console.error(`[s3-reconciliation] falha ao marcar órfão DB ${info.id}:`, err);
    } finally {
      cli.release();
    }
  }

  console.info(`[s3-reconciliation] report:`, report);
  return report;
}

export function startS3ReconciliationWorker(): void {
  if (reconciliationTimer) return;
  reconciliationTimer = setInterval(() => {
    runReconciliationOnce().catch((err) => console.error("[s3-reconciliation]", err));
  }, RECONCILIATION_INTERVAL_MS);
  console.info(`[s3-reconciliation] iniciado (intervalo=${RECONCILIATION_INTERVAL_MS / 3600000}h)`);

  // Boot: roda 5min após start (evita concorrer com startup DB init)
  setTimeout(() => {
    runReconciliationOnce().catch(() => null);
  }, 5 * 60 * 1000);
}

export function stopS3ReconciliationWorker(): void {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
  }
}
