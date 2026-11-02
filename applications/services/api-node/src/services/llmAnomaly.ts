/**
 * llmAnomaly.ts — alerta estatístico de anomalia de custo/uso de LLM (plano de evolução v2, tarefa 1.6).
 *
 * Roda AO LADO do LLM Guard, nunca no lugar dele. Este módulo NÃO importa o Guard, o Guard NÃO importa
 * este módulo, e nenhum alerta pausa, nega ou libera chamada: só calcula, registra em `llm_anomaly_alerts`
 * e (modo `on`) notifica. Falha aqui nunca propaga: o pior caso é um alerta a menos.
 *
 * Flag `ANOMALY_ALERTS`: off (padrão) ⇒ nada é lido, calculado nem escrito; shadow ⇒ grava com mode=shadow,
 * sem notificar; on ⇒ grava com mode=on e notifica pelo canal de operações (e-mail SES de `opsNotify`) se existir.
 * Sem PII: os alertas guardam só hashes de id (ver `hashId`). Puro cálculo, zero LLM.
 */
import { anomalyMode, resolveAnomalyParams, type AnomalyMode, type AnomalyParams } from "../lib/anomalyAlerts.js";
import { analyze, HOUR_MS, type Anomaly, type CallRow, type ProgressRow } from "./anomalyDetectors.js";
import type { Queryable } from "./llmGuard.js";
import { isSesConfigured, sendEmail } from "./emailSender.js";

const MAX_ROWS = 500_000;

/** Lê o histórico [startMs, endMs) do ledger (somente SELECT) e os eventos de progresso. */
export async function loadAnomalyInputs(db: Queryable, startMs: number, endMs: number, p: AnomalyParams): Promise<{ calls: CallRow[]; progress: ProgressRow[] }> {
  const c = await db.query(
    `SELECT (extract(epoch FROM l.created_at) * 1000)::float8 AS ts_ms,
            COALESCE(l.tenant_id, pr.tenant_id)::text AS tenant_id,
            COALESCE(l.project_id, l.budget_project_id)::text AS project_id,
            l.cost_usd::float8 AS cost_usd,
            (l.input_tokens + l.output_tokens)::float8 AS tokens,
            l.prompt_hash
       FROM llm_call_ledger l
       LEFT JOIN projects pr ON pr.id = COALESCE(l.project_id, l.budget_project_id)
      WHERE l.created_at >= to_timestamp($1 / 1000.0) AND l.created_at < to_timestamp($2 / 1000.0)
      ORDER BY l.created_at ASC
      LIMIT ${MAX_ROWS}`,
    [startMs, endMs],
  );
  const calls: CallRow[] = c.rows.map((r) => ({
    tsMs: Number(r.ts_ms), tenantId: (r.tenant_id as string | null) ?? null, projectId: (r.project_id as string | null) ?? null,
    costUsd: Number(r.cost_usd), tokens: Number(r.tokens), promptHash: (r.prompt_hash as string | null) ?? null,
  }));
  const m = await db.query(
    `SELECT (extract(epoch FROM created_at) * 1000)::float8 AS ts_ms, project_id::text AS project_id
       FROM project_agent_metrics
      WHERE created_at >= to_timestamp($1 / 1000.0) AND created_at < to_timestamp($2 / 1000.0)
        AND status = ANY($3::text[])`,
    [startMs, endMs, p.progressStatuses],
  );
  const progress: ProgressRow[] = m.rows.map((r) => ({ tsMs: Number(r.ts_ms), projectId: String(r.project_id) }));
  return { calls, progress };
}

export function dedupeKey(a: Anomaly, p: AnomalyParams): string {
  const bucket = Math.floor(a.tsMs / (Math.max(1, p.cooldownHours) * HOUR_MS));
  return `${a.detector}:${a.metric}:${a.scope}:${a.scopeHash}:${bucket}`;
}

export interface AnomalyRunResult { mode: AnomalyMode; considered: number; inserted: number; notified: number }

/**
 * Uma passada. Com `off` retorna sem tocar no banco. Avalia a janela [now-baseline-lag-report, hora fechada);
 * só grava alertas das últimas `reportWindowHours` horas (o resto é histórico para a linha de base).
 * Idempotente: `dedupe_key` único (ON CONFLICT DO NOTHING). Nunca lança.
 */
export async function runAnomalyPass(db: Queryable, nowMs: number, env: NodeJS.ProcessEnv = process.env): Promise<AnomalyRunResult> {
  const mode = anomalyMode(env);
  if (mode === "off") return { mode, considered: 0, inserted: 0, notified: 0 };
  const p = resolveAnomalyParams(env);
  try {
    const endMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const startMs = endMs - (p.baselineHours + p.baselineLagHours + p.reportWindowHours) * HOUR_MS;
    const { calls, progress } = await loadAnomalyInputs(db, startMs, endMs, p);
    const reportFrom = endMs - p.reportWindowHours * HOUR_MS;
    const fresh = analyze({ calls, progress, endMs }, p).filter((a) => a.tsMs >= reportFrom);
    let inserted = 0;
    let notified = 0;
    for (const a of fresh) {
      const ins = await db.query(
        `INSERT INTO llm_anomaly_alerts (detected_at, mode, detector, metric, scope, scope_hash, severity, value, baseline, threshold, score, detail, dedupe_key)
         VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [a.tsMs, mode, a.detector, a.metric, a.scope, a.scopeHash, a.severity, a.value, a.baseline, a.threshold, a.score, JSON.stringify(a.detail), dedupeKey(a, p)],
      );
      if (!ins.rows.length) continue;
      inserted++;
      if (mode === "on" && (await notifyOps(a))) {
        notified++;
        await db.query("UPDATE llm_anomaly_alerts SET notified = true WHERE id = $1", [ins.rows[0].id]);
      }
    }
    return { mode, considered: fresh.length, inserted, notified };
  } catch (e) {
    console.error("[llm-anomaly] passada falhou (ignorado, o Guard não depende disto):", e instanceof Error ? e.message : String(e));
    return { mode, considered: 0, inserted: 0, notified: 0 };
  }
}

function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/** Notifica pelo canal de operações já existente (e-mail SES, destinatário `OPS_NOTIFY_EMAIL`). Sem canal ⇒ false. */
export async function notifyOps(a: Anomaly): Promise<boolean> {
  try {
    const to = (process.env.OPS_NOTIFY_EMAIL ?? "jean@zentriz.com.br").trim();
    if (!to || !isSesConfigured()) return false;
    const accent = a.severity === "critical" ? "#ef4444" : "#f59e0b";
    const line = `${a.detector} · ${a.metric} · ${a.scope}:${a.scopeHash} · valor ${a.value.toFixed(2)} (base ${a.baseline.toFixed(2)}, limiar ${a.threshold.toFixed(2)})`;
    const html = `<table width="100%" cellpadding="0" cellspacing="0" style="background:#0b1220"><tr><td style="padding:24px;font-family:Arial,sans-serif;color:#e5e7eb">`
      + `<div style="border-left:4px solid ${accent};padding-left:12px"><h2 style="margin:0 0 8px;color:#f9fafb">Anomalia de custo/uso de LLM (${esc(a.severity)})</h2>`
      + `<p style="margin:0;color:#e5e7eb">${esc(line)}</p></div>`
      + `<p style="color:#9ca3af">Alerta apenas informativo: não altera o LLM Guard, que segue soberano e fail-closed.</p></td></tr></table>`;
    const r = await sendEmail({ to, subject: `[Genesis] Anomalia de LLM (${a.severity}) — ${a.detector}`, html, text: line });
    return r.delivered === true;
  } catch {
    return false;
  }
}

export interface AlertFilter { scopeHash?: string; detector?: string; since?: string; limit?: number }

/** Lista alertas (mais recentes primeiro). Só leitura; funciona em qualquer modo. */
export async function listAnomalyAlerts(db: Queryable, f: AlertFilter = {}): Promise<Record<string, unknown>[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.scopeHash) { params.push(f.scopeHash); where.push(`scope_hash = $${params.length}`); }
  if (f.detector) { params.push(f.detector); where.push(`detector = $${params.length}`); }
  if (f.since) { params.push(f.since); where.push(`detected_at >= $${params.length}::timestamptz`); }
  const limit = Math.min(500, Math.max(1, Math.floor(f.limit ?? 100)));
  params.push(limit);
  const r = await db.query(
    `SELECT id, created_at, detected_at, mode, detector, metric, scope, scope_hash, severity, value, baseline, threshold, score, detail, notified
       FROM llm_anomaly_alerts ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY detected_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

// --- worker (padrão creditReconciliationWorker): com off nem agenda timer ---
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
const INTERVAL_MS = Number(process.env.ANOMALY_INTERVAL_MS ?? 15 * 60 * 1000);

export function startAnomalyWorker(getDb: () => Queryable): void {
  if (anomalyMode() === "off") return; // byte-idêntico: nenhum timer, nenhuma consulta
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runAnomalyPass(getDb(), Date.now()); } finally { running = false; }
  };
  timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  console.info(`[llm-anomaly] iniciado (modo=${anomalyMode()}, intervalo=${INTERVAL_MS / 60000}min)`);
  setTimeout(() => { void tick(); }, 60_000);
}

export function stopAnomalyWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
