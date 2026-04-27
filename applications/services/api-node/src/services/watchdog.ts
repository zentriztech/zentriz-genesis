/**
 * Watchdog — Auto-recovery de projetos interrompidos.
 *
 * Executa a cada WATCHDOG_INTERVAL_MS (padrão: 60s) e:
 * 1. Busca projetos com status 'running' no DB
 * 2. Consulta o runner service para ver quais têm processo ativo
 * 3. Projetos 'running' sem processo ativo → relança o pipeline
 * 4. Projetos rodando há mais de MAX_RUNTIME_HOURS → marca como timed_out
 * 5. Projetos que falharam > MAX_RESTART_ATTEMPTS → marca como failed
 *
 * Garante que o Genesis nunca fica com projetos órfãos após queda/restart.
 */

import { pool } from "../db/client.js";
import { signToken } from "../auth.js";

const WATCHDOG_INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS ?? "60000", 10);
const MAX_RESTART_ATTEMPTS  = parseInt(process.env.WATCHDOG_MAX_RESTARTS ?? "5", 10);
const MAX_RUNTIME_HOURS     = parseFloat(process.env.WATCHDOG_MAX_RUNTIME_HOURS ?? "8");
const MAX_PARALLEL_RESTARTS = parseInt(process.env.WATCHDOG_MAX_PARALLEL_RESTARTS ?? "1", 10);
const RUNNER_SERVICE_URL    = (process.env.RUNNER_SERVICE_URL ?? "").trim();
const API_BASE_URL          = (process.env.API_BASE_URL ?? "http://localhost:3000").trim();
const UPLOAD_DIR            = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
const RUNNER_UPLOAD_DIR     = (process.env.RUNNER_UPLOAD_DIR ?? "").trim();

let _watchdogTimer: ReturnType<typeof setInterval> | null = null;
let _isRunning = false; // impede execuções sobrepostas

// ── Tipos internos ─────────────────────────────────────────────────────────

interface RunnerStatus {
  active_count: number;
  projects: Record<string, number>; // projectId -> pid
}

interface OrphanProject {
  id: string;
  status: string;
  spec_ref: string;
  started_at: string | null;
  restart_count: number; // coluna direta na tabela projects
  stopped_by: string | null; // 'user' = parado intencionalmente, null = queda/falha
  created_by: string;
  tenant_id: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function getRunnerStatus(): Promise<RunnerStatus | null> {
  if (!RUNNER_SERVICE_URL) return null;
  try {
    const res = await fetch(`${RUNNER_SERVICE_URL.replace(/\/$/, "")}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as RunnerStatus;
  } catch {
    return null;
  }
}

async function getOrphanProjects(runnerActiveIds: Set<string>): Promise<OrphanProject[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<OrphanProject>(
      `SELECT id, status, spec_ref, started_at,
              COALESCE(restart_count, 0) AS restart_count,
              stopped_by,
              created_by, tenant_id
       FROM projects
       WHERE status = 'running'
         AND (stopped_by IS NULL OR stopped_by != 'user')
       ORDER BY started_at ASC NULLS LAST`,
    );
    // Filtra apenas os que não têm processo ativo no runner
    return result.rows.filter((p) => !runnerActiveIds.has(p.id));
  } finally {
    client.release();
  }
}

async function markProject(
  id: string,
  status: string,
  opts?: { restartCount?: number; extra?: Record<string, unknown> },
): Promise<void> {
  const client = await pool.connect();
  try {
    if (opts?.restartCount !== undefined || opts?.extra) {
      await client.query(
        `UPDATE projects
         SET status = $1,
             updated_at = now(),
             restart_count = COALESCE($2, restart_count),
             extra = COALESCE(extra, '{}') || $3::jsonb
         WHERE id = $4`,
        [status, opts.restartCount ?? null, JSON.stringify(opts.extra ?? {}), id],
      );
    } else {
      await client.query(
        `UPDATE projects SET status = $1, updated_at = now() WHERE id = $2`,
        [status, id],
      );
    }
  } finally {
    client.release();
  }
}

async function writeDlqEntry(
  projectId: string,
  errorType: "watchdog_gave_up" | "timeout" | "other",
  reason: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO project_errors (project_id, error_type, reason, extra)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT DO NOTHING`,
      [projectId, errorType, reason, JSON.stringify(extra ?? {})],
    );
  } catch {
    // DLQ table may not exist yet (migration pending) — ignore silently
  } finally {
    client.release();
  }
}

async function checkCostAlerts(): Promise<void> {
  const client = await pool.connect();
  try {
    // Find tenants that have spent more than their daily alert threshold today
    const rows = await client.query<{ tenant_id: string; daily_spend: number; daily_alert_usd: number }>(
      `SELECT m.tenant_id, SUM(m.input_tokens * 3.0 / 1000000 + m.output_tokens * 15.0 / 1000000)::float AS daily_spend,
              COALESCE(c.daily_alert_usd, 50.0) AS daily_alert_usd
       FROM project_agent_metrics m
       JOIN projects p ON p.id = m.project_id
       LEFT JOIN cost_alert_config c ON c.tenant_id = p.tenant_id
       WHERE m.created_at >= date_trunc('day', now())
         AND p.tenant_id IS NOT NULL
       GROUP BY m.tenant_id, c.daily_alert_usd
       HAVING SUM(m.input_tokens * 3.0 / 1000000 + m.output_tokens * 15.0 / 1000000) > COALESCE(c.daily_alert_usd, 50.0)`,
    );
    for (const row of rows.rows) {
      // Check if alert was already sent today for this tenant
      const existing = await client.query(
        `SELECT id FROM notifications
         WHERE tenant_id = $1 AND type = 'alert'
           AND created_at >= date_trunc('day', now())
           AND title LIKE 'Alerta de custo%'
         LIMIT 1`,
        [row.tenant_id],
      );
      if (existing.rows.length > 0) continue;
      await client.query(
        `INSERT INTO notifications (tenant_id, type, title, body)
         VALUES ($1, 'alert', $2, $3)`,
        [
          row.tenant_id,
          "Alerta de custo — limite diário atingido",
          `Gasto hoje: ~$${row.daily_spend.toFixed(2)} USD (limite: $${row.daily_alert_usd} USD). Revise projetos em execução.`,
        ],
      );
      console.warn(`[Watchdog] Alerta de custo emitido para tenant ${row.tenant_id}: $${row.daily_spend.toFixed(2)} hoje`);
    }
  } catch {
    // project_agent_metrics or cost_alert_config may not exist yet — ignore
  } finally {
    client.release();
  }
}

async function getSpecFilePath(projectId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT file_path FROM project_spec_files WHERE project_id = $1 AND LOWER(filename) LIKE '%.md' ORDER BY created_at ASC LIMIT 1`,
      [projectId],
    );
    return (res.rows[0]?.file_path as string | undefined) ?? null;
  } finally {
    client.release();
  }
}

async function getProjectUser(projectId: string): Promise<{ userId: string; email: string; role: string; tenantId: string | null } | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT u.id, u.email, u.role, p.tenant_id
       FROM projects p JOIN users u ON u.id = p.created_by
       WHERE p.id = $1 LIMIT 1`,
      [projectId],
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    return { userId: row.id as string, email: row.email as string, role: row.role as string, tenantId: row.tenant_id as string | null };
  } finally {
    client.release();
  }
}

async function relaunchPipeline(project: OrphanProject): Promise<boolean> {
  if (!RUNNER_SERVICE_URL) return false;

  const specFilePath = await getSpecFilePath(project.id);
  if (!specFilePath) {
    console.warn(`[Watchdog] Spec não encontrada para projeto ${project.id} — não é possível relangar`);
    return false;
  }

  const userInfo = await getProjectUser(project.id);
  if (!userInfo) {
    console.warn(`[Watchdog] Usuário não encontrado para projeto ${project.id}`);
    return false;
  }

  const token = signToken(
    { sub: userInfo.userId, email: userInfo.email, role: userInfo.role, tenantId: userInfo.tenantId },
    "24h",
  );

  let runBody: Record<string, string>;
  if (RUNNER_UPLOAD_DIR && specFilePath.startsWith(UPLOAD_DIR)) {
    const relative = specFilePath.slice(UPLOAD_DIR.length);
    runBody = { projectId: project.id, specPath: `${RUNNER_UPLOAD_DIR}${relative}`, apiBaseUrl: API_BASE_URL, token };
  } else {
    const { readFileSync } = await import("fs");
    try {
      const specB64 = readFileSync(specFilePath).toString("base64");
      runBody = { projectId: project.id, specContent: specB64, apiBaseUrl: API_BASE_URL, token };
    } catch {
      console.warn(`[Watchdog] Não foi possível ler spec em ${specFilePath}`);
      return false;
    }
  }

  try {
    const res = await fetch(`${RUNNER_SERVICE_URL.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runBody),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 409) {
      // Já está rodando — runner e DB estão sincronizados
      console.log(`[Watchdog] Projeto ${project.id} já está rodando no runner (409)`);
      return true;
    }
    if (!res.ok) {
      const text = await res.text();
      console.error(`[Watchdog] Runner retornou ${res.status} para ${project.id}: ${text.slice(0, 200)}`);
      return false;
    }
    console.log(`[Watchdog] Projeto ${project.id} relançado com sucesso (restart #${project.restart_count + 1})`);
    return true;
  } catch (err) {
    console.error(`[Watchdog] Erro ao relangar ${project.id}:`, err);
    return false;
  }
}

// ── Cleanup de deployments efêmeros expirados ─────────────────────────────────

async function checkExpiredDeployments(): Promise<void> {
  const client = await pool.connect();
  try {
    const expired = await client.query<{
      id: string; provider: string; machine_id: string | null; app_name: string | null;
    }>(
      `SELECT id, provider, machine_id, app_name
       FROM ephemeral_deployments
       WHERE status = 'running' AND expires_at < now() AND destroyed_at IS NULL
       LIMIT 20`,
    );
    if (!expired.rows.length) return;

    for (const dep of expired.rows) {
      try {
        if (dep.provider === "fly" && dep.machine_id && dep.app_name) {
          const { destroyMachine: flyDestroy } = await import("./fly.js");
          await flyDestroy(dep.app_name, dep.machine_id).catch((e: unknown) =>
            console.warn(`[Watchdog] Fly destroy failed ${dep.id}:`, e),
          );
        } else if (dep.provider === "ecs" && dep.machine_id) {
          const { stopECSTask } = await import("./ecs.js");
          await stopECSTask(dep.machine_id).catch((e: unknown) =>
            console.warn(`[Watchdog] ECS stop failed ${dep.id}:`, e),
          );
        }
        await client.query(
          "UPDATE ephemeral_deployments SET status='destroyed', destroyed_at=now(), updated_at=now() WHERE id=$1",
          [dep.id],
        );
        console.log(`[Watchdog] Ephemeral deployment ${dep.id} destroyed (TTL expired)`);
      } catch (e) {
        console.error(`[Watchdog] Failed to destroy ephemeral deployment ${dep.id}:`, e);
      }
    }
  } catch {
    // Table may not exist yet — ignore
  } finally {
    client.release();
  }
}

// ── Ciclo principal do Watchdog ────────────────────────────────────────────

async function runWatchdogCycle(): Promise<void> {
  if (_isRunning) return; // evitar sobreposição
  _isRunning = true;

  try {
    if (!RUNNER_SERVICE_URL) return; // runner não configurado

    // 0a. Verificar alertas de custo (uma vez por ciclo)
    await checkCostAlerts().catch((e) => console.error("[Watchdog] Erro em checkCostAlerts:", e));

    // 0b. Destruir deployments efêmeros expirados
    await checkExpiredDeployments().catch((e) => console.error("[Watchdog] Erro em checkExpiredDeployments:", e));

    // 1. Buscar status do runner
    const runnerStatus = await getRunnerStatus();
    const activeIds = new Set(runnerStatus ? Object.keys(runnerStatus.projects) : []);

    // G39: Promover projetos da fila quando há slot disponível
    try {
      const { hasConcurrencySlot } = await import("./tenantLlmConfig.js");
      const queuedProjects = await pool.query<{ id: string; tenant_id: string; spec_ref: string }>(
        `SELECT id, tenant_id, spec_ref FROM projects
         WHERE status = 'queued'
         ORDER BY queued_at ASC
         LIMIT 10`
      );
      for (const qp of queuedProjects.rows) {
        const hasSlot = await hasConcurrencySlot(qp.tenant_id ?? "");
        if (!hasSlot) continue;
        // Promover de queued → running via /run interno
        try {
          const { signToken } = await import("../auth.js");
          const svcToken = signToken({ sub: "watchdog", email: "watchdog@internal", role: "zentriz_admin", tenantId: null }, "1h");
          const apiBase = process.env.API_BASE_URL ?? "http://localhost:3000";
          const res = await fetch(`${apiBase}/api/projects/${qp.id}/run`, {
            method: "POST",
            headers: { Authorization: `Bearer ${svcToken}` },
          });
          if (res.ok) {
            console.log(`[Watchdog][G39] Projeto ${qp.id} promovido da fila → running`);
          }
        } catch (e) {
          console.error(`[Watchdog][G39] Erro ao promover ${qp.id}:`, e);
        }
      }
    } catch (e) {
      console.error("[Watchdog][G39] Erro na promoção da fila:", e);
    }

    // 2. Buscar projetos running sem processo ativo
    const orphans = await getOrphanProjects(activeIds);
    if (!orphans.length) return;

    console.log(`[Watchdog] ${orphans.length} projeto(s) órfão(s) detectado(s)`);

    // 3. Count how many projects can be relaunched this cycle
    // WATCHDOG_MAX_PARALLEL_RESTARTS=1 (default) = single project at a time (safe for cost-constrained envs)
    // Set higher for parallel execution (runner_server supports N concurrent processes)
    const currentlyActive = runnerStatus?.active_count ?? 0;
    const availableSlots = Math.max(0, MAX_PARALLEL_RESTARTS - currentlyActive);

    let relaunched = 0;

    for (const project of orphans) {
      const runtimeMs = project.started_at
        ? Date.now() - new Date(project.started_at).getTime()
        : 0;
      const runtimeHours = runtimeMs / 3600000;

      // Proteção de custo: projeto rodando há muito tempo
      if (runtimeHours > MAX_RUNTIME_HOURS) {
        console.warn(
          `[Watchdog] Projeto ${project.id} excedeu ${MAX_RUNTIME_HOURS}h de execução (${runtimeHours.toFixed(1)}h). Marcando como timed_out.`,
        );
        await markProject(project.id, "failed", { extra: { timed_out: true, runtime_hours: runtimeHours.toFixed(1) } });
        await writeDlqEntry(project.id, "timeout", `Pipeline excedeu ${MAX_RUNTIME_HOURS}h de execução (real: ${runtimeHours.toFixed(1)}h)`);
        continue;
      }

      // Proteção contra loop de falhas: muitos restarts
      if (project.restart_count >= MAX_RESTART_ATTEMPTS) {
        console.warn(
          `[Watchdog] Projeto ${project.id} atingiu limite de ${MAX_RESTART_ATTEMPTS} restarts. Marcando como failed.`,
        );
        await markProject(project.id, "failed", { extra: { watchdog_gave_up: true } });
        await writeDlqEntry(project.id, "watchdog_gave_up", `Watchdog desistiu após ${MAX_RESTART_ATTEMPTS} restarts`);
        continue;
      }

      // Verificar slots disponíveis
      if (relaunched >= availableSlots) {
        console.log(`[Watchdog] Slots paralelos esgotados (${MAX_PARALLEL_RESTARTS}). Projeto ${project.id} será tentado no próximo ciclo.`);
        break;
      }

      // Tentar relangar
      const launched = await relaunchPipeline(project);
      if (launched) {
        await markProject(project.id, "running", {
          restartCount: project.restart_count + 1,
          extra: { last_watchdog_restart: new Date().toISOString() },
        });
        relaunched++;
      } else {
        await markProject(project.id, "running", {
          restartCount: project.restart_count + 1,
          extra: { last_watchdog_error: new Date().toISOString() },
        });
      }
    }
  } catch (err) {
    console.error("[Watchdog] Erro no ciclo:", err);
  } finally {
    _isRunning = false;
  }
}

// ── API pública ────────────────────────────────────────────────────────────

export function startWatchdog(): void {
  if (_watchdogTimer) return; // já iniciado

  if (!RUNNER_SERVICE_URL) {
    console.log("[Watchdog] RUNNER_SERVICE_URL não definido — watchdog desativado");
    return;
  }

  // Primeiro ciclo após 10s (dar tempo para o sistema inicializar)
  setTimeout(() => {
    runWatchdogCycle().catch(console.error);
    _watchdogTimer = setInterval(() => {
      runWatchdogCycle().catch(console.error);
    }, WATCHDOG_INTERVAL_MS);
    console.log(`[Watchdog] Iniciado — ciclo a cada ${WATCHDOG_INTERVAL_MS / 1000}s, max_restarts=${MAX_RESTART_ATTEMPTS}, max_runtime=${MAX_RUNTIME_HOURS}h, max_parallel_restarts=${MAX_PARALLEL_RESTARTS}`);
  }, 10000);
}

export function stopWatchdog(): void {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
    console.log("[Watchdog] Parado");
  }
}
