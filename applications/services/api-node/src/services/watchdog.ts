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

// ── Ciclo principal do Watchdog ────────────────────────────────────────────

async function runWatchdogCycle(): Promise<void> {
  if (_isRunning) return; // evitar sobreposição
  _isRunning = true;

  try {
    if (!RUNNER_SERVICE_URL) return; // runner não configurado

    // 1. Buscar status do runner
    const runnerStatus = await getRunnerStatus();
    const activeIds = new Set(runnerStatus ? Object.keys(runnerStatus.projects) : []);

    // 2. Buscar projetos running sem processo ativo
    const orphans = await getOrphanProjects(activeIds);
    if (!orphans.length) return;

    console.log(`[Watchdog] ${orphans.length} projeto(s) órfão(s) detectado(s)`);

    // 3. Verificar se o runner está ocupado com outro projeto
    const runnerHasActiveProject = (runnerStatus?.active_count ?? 0) > 0;

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
        continue;
      }

      // Proteção contra loop de falhas: muitos restarts
      if (project.restart_count >= MAX_RESTART_ATTEMPTS) {
        console.warn(
          `[Watchdog] Projeto ${project.id} atingiu limite de ${MAX_RESTART_ATTEMPTS} restarts. Marcando como failed.`,
        );
        await markProject(project.id, "failed", { extra: { watchdog_gave_up: true } });
        continue;
      }

      // Se runner já está ocupado, relançar apenas o mais antigo e aguardar próximo ciclo
      if (runnerHasActiveProject) {
        console.log(`[Watchdog] Runner ocupado. Aguardando próximo ciclo para projeto ${project.id}`);
        break; // projetos restantes serão tentados no próximo ciclo
      }

      // Tentar relangar
      const launched = await relaunchPipeline(project);
      if (launched) {
        await markProject(project.id, "running", {
          restartCount: project.restart_count + 1,
          extra: { last_watchdog_restart: new Date().toISOString() },
        });
        // Após relangar, runner está ocupado — aguardar próximo ciclo
        break;
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
    console.log(`[Watchdog] Iniciado — ciclo a cada ${WATCHDOG_INTERVAL_MS / 1000}s, max_restarts=${MAX_RESTART_ATTEMPTS}, max_runtime=${MAX_RUNTIME_HOURS}h`);
  }, 10000);
}

export function stopWatchdog(): void {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
    console.log("[Watchdog] Parado");
  }
}
