import type { FastifyInstance, FastifyRequest } from "fastify";
import { spawn } from "child_process";
import path from "path";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { signToken } from "../auth.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

// Simple in-memory sliding-window rate limiter for /run (per tenant or per user)
// Limit: MAX_RUN_CALLS_PER_WINDOW calls within WINDOW_MS
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RUN_RATE_LIMIT_WINDOW_MS ?? "60000", 10); // 60s
const RATE_LIMIT_MAX_CALLS = parseInt(process.env.RUN_RATE_LIMIT_MAX_CALLS ?? "5", 10); // 5 calls/min
const _runCallTimestamps = new Map<string, number[]>(); // key: tenantId or userId → timestamps

function checkRunRateLimit(key: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const calls = (_runCallTimestamps.get(key) ?? []).filter((t) => t > windowStart);
  if (calls.length >= RATE_LIMIT_MAX_CALLS) {
    const oldest = calls[0];
    return { allowed: false, retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - oldest) };
  }
  calls.push(now);
  _runCallTimestamps.set(key, calls);
  return { allowed: true, retryAfterMs: 0 };
}

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

async function checkProjectAccess(
  client: { query: (q: string, p?: string[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
  user: AuthUser
): Promise<boolean> {
  const result = await client.query("SELECT tenant_id, created_by FROM projects WHERE id = $1", [projectId]);
  const row = result.rows[0];
  if (!row) return false;
  if (user.role === "zentriz_admin") return true;
  if (user.tenantId && row.tenant_id === user.tenantId) return true;
  if (row.created_by === user.id) return true;
  return false;
}

const ALLOWED_STATUS_FOR_RUN = new Set([
  "draft",
  "spec_submitted",
  "pending_conversion",
  "cto_charter",
  "pm_backlog",
  "stopped",
  "failed",
]);

/**
 * Retorna o file_path do primeiro arquivo .md do projeto (para uso pelo runner).
 * Se não houver .md, retorna null.
 */
async function getProjectSpecFilePath(
  client: { query: (q: string, p?: string[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string
): Promise<string | null> {
  const result = await client.query(
    `SELECT file_path FROM project_spec_files
     WHERE project_id = $1 AND LOWER(filename) LIKE '%.md'
     ORDER BY created_at ASC LIMIT 1`,
    [projectId]
  );
  const row = result.rows[0];
  if (row && typeof row.file_path === "string") return row.file_path;
  return null;
}

export async function pipelineRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { id: string } }>("/api/projects/:id/run", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    request.log.info({ projectId, userId: user.id }, "[Pipeline] POST /run recebido");
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) {
        request.log.warn({ projectId }, "[Pipeline] Acesso negado (projeto não encontrado ou sem permissão)");
        return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      }

      // Rate limit: 5 /run calls per minute per tenant (or per user if no tenant)
      const rateLimitKey = user.tenantId ?? user.id;
      const rl = checkRunRateLimit(rateLimitKey);
      if (!rl.allowed) {
        request.log.warn({ projectId, rateLimitKey }, "[Pipeline] Rate limit atingido no /run");
        return reply.status(429).send({
          code: "RATE_LIMITED",
          message: `Muitas tentativas de iniciar pipeline. Aguarde ${Math.ceil(rl.retryAfterMs / 1000)}s antes de tentar novamente.`,
        });
      }

      const projectRow = await client.query(
        "SELECT status FROM projects WHERE id = $1",
        [projectId]
      );
      const project = projectRow.rows[0];
      if (!project) {
        request.log.warn({ projectId }, "[Pipeline] Projeto não existe");
        return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      }
      const status = project.status as string;
      if (!ALLOWED_STATUS_FOR_RUN.has(status)) {
        request.log.warn({ projectId, status }, "[Pipeline] Status não permite run");
        return reply.status(409).send({
          code: "CONFLICT",
          message: `Pipeline não pode ser iniciado com status "${status}". Use um projeto com spec enviada (draft, spec_submitted, pending_conversion, cto_charter ou pm_backlog).`,
        });
      }

      const specFilePath = await getProjectSpecFilePath(client, projectId);
      if (!specFilePath) {
        request.log.warn({ projectId }, "[Pipeline] Sem arquivo .md no projeto (project_spec_files vazio ou sem .md)");
        return reply.status(400).send({
          code: "BAD_REQUEST",
          message: "Adicione uma spec em Markdown ao projeto para iniciar o pipeline.",
        });
      }
      request.log.info({ projectId, specPath: specFilePath.slice(0, 120) }, "[Pipeline] Spec encontrada, disparando runner");

      const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
      const token = signToken(
        {
          sub: user.id,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId,
        },
        "24h"
      );

      const runEnv = {
        ...process.env,
        API_BASE_URL: apiBaseUrl,
        PROJECT_ID: projectId,
        GENESIS_API_TOKEN: token,
        CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ?? "",
        API_AGENTS_URL: process.env.API_AGENTS_URL ?? "",
      };

      const runnerCommand = process.env.RUNNER_COMMAND?.trim();
      if (runnerCommand) {
        const parts = runnerCommand.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          return reply.status(500).send({
            code: "RUNNER_ERROR",
            message: "RUNNER_COMMAND está vazio ou inválido.",
          });
        }
        const executable = parts[0];
        const args = [...parts.slice(1), "--spec-file", specFilePath];
        const child = spawn(executable, args, {
          env: runEnv,
          detached: true,
          stdio: "ignore",
          cwd: process.env.REPO_ROOT ?? process.cwd(),
        });
        child.unref();
        await client.query(
          "UPDATE projects SET status = $1, started_at = now(), updated_at = now(), stopped_by = NULL WHERE id = $2",
          ["running", projectId]
        );
        return reply.status(202).send({
          ok: true,
          message: "Pipeline iniciado. O diálogo será atualizado em breve.",
          status: "running",
        });
      }

      const runnerServiceUrl = process.env.RUNNER_SERVICE_URL?.trim();
      if (runnerServiceUrl) {
        try {
          request.log.info({ projectId, runnerUrl: runnerServiceUrl }, "[Pipeline] Chamando runner service");
          // When RUNNER_UPLOAD_DIR is set, the runner is in Docker and uses a
          // different path than the host. Translate specPath to the runner's path,
          // or fall back to specContent (base64) so the runner writes a temp file.
          const runnerUploadDir = process.env.RUNNER_UPLOAD_DIR?.trim();
          let runBody: Record<string, string>;
          if (runnerUploadDir && specFilePath.startsWith(UPLOAD_DIR)) {
            const relative = specFilePath.slice(UPLOAD_DIR.length);
            runBody = { projectId, specPath: `${runnerUploadDir}${relative}`, apiBaseUrl, token };
          } else {
            // Encode spec as base64 — works regardless of path differences
            const { readFileSync } = await import("fs");
            const specB64 = readFileSync(specFilePath).toString("base64");
            runBody = { projectId, specContent: specB64, apiBaseUrl, token };
          }
          const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(runBody),
          });
          if (res.status >= 200 && res.status < 300) {
            await client.query(
              "UPDATE projects SET status = $1, started_at = now(), updated_at = now(), stopped_by = NULL WHERE id = $2",
              ["running", projectId]
            );
            request.log.info({ projectId }, "[Pipeline] Runner iniciado com sucesso (202)");
            return reply.status(202).send({
              ok: true,
              message: "Pipeline iniciado. O diálogo será atualizado em breve.",
              status: "running",
            });
          }
          const text = await res.text();
          request.log.error({ projectId, runnerStatus: res.status, body: text.slice(0, 300) }, "[Pipeline] Runner retornou erro");
          return reply.status(500).send({
            code: "RUNNER_ERROR",
            message: text || `Serviço runner retornou ${res.status}`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          request.log.error({ err, projectId }, "[Pipeline] Falha ao chamar runner");
          return reply.status(500).send({
            code: "RUNNER_ERROR",
            message: `Falha ao chamar serviço runner: ${message}`,
          });
        }
      }

      request.log.warn("[Pipeline] Nenhum runner configurado (RUNNER_COMMAND e RUNNER_SERVICE_URL vazios)");
      return reply.status(503).send({
        code: "SERVICE_UNAVAILABLE",
        message: "Nenhum runner configurado. Defina RUNNER_COMMAND ou RUNNER_SERVICE_URL.",
      });
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/stop", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

      const runnerServiceUrl = process.env.RUNNER_SERVICE_URL?.trim();
      if (runnerServiceUrl) {
        try {
          const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId }),
          });
          if (res.status >= 200 && res.status < 300) {
            await client.query(
              "UPDATE projects SET status = $1, stopped_by = 'user', updated_at = now() WHERE id = $2",
              ["stopped", projectId]
            );
            return reply.send({ ok: true, message: "Pipeline encerrado" });
          }
        } catch (err) {
          request.log.error(err, "Falha ao chamar runner service stop");
        }
      }
      await client.query(
        "UPDATE projects SET status = $1, stopped_by = 'user', updated_at = now() WHERE id = $2",
        ["stopped", projectId]
      );
      return reply.send({ ok: true, message: "Pipeline marcado como encerrado" });
    } finally {
      client.release();
    }
  });

  // GET /api/admin/dlq — dead letter queue entries (projects that failed permanently)
  app.get("/api/admin/dlq", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas administradores Zentriz" });
    }
    const client = await pool.connect();
    try {
      const rows = await client.query(
        `SELECT e.id, e.project_id, p.title AS project_title, e.error_type, e.agent, e.task_id, e.reason, e.extra, e.created_at
         FROM project_errors e
         LEFT JOIN projects p ON p.id = e.project_id
         ORDER BY e.created_at DESC LIMIT 100`
      );
      return reply.send({ entries: rows.rows, total: rows.rowCount });
    } catch {
      // Table may not exist yet
      return reply.send({ entries: [], total: 0 });
    } finally {
      client.release();
    }
  });

  // GET /api/watchdog/status — estado atual do Watchdog + projetos órfãos no DB
  app.get("/api/watchdog/status", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas administradores Zentriz" });
    }

    const runnerServiceUrl = process.env.RUNNER_SERVICE_URL?.trim();
    interface RunnerStatusPayload { active_count?: number; projects?: Record<string, number> }
    let runnerStatus: RunnerStatusPayload | null = null;
    if (runnerServiceUrl) {
      try {
        const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/status`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) runnerStatus = await res.json() as RunnerStatusPayload;
      } catch {
        // runner unreachable
      }
    }

    const client = await pool.connect();
    try {
      const orphans = await client.query(
        `SELECT id, title, status, started_at, restart_count,
                COALESCE(restart_count, 0) AS restart_count,
                stopped_by, created_at
         FROM projects
         WHERE status = 'running'
           AND (stopped_by IS NULL OR stopped_by != 'user')
         ORDER BY started_at ASC NULLS LAST
         LIMIT 20`
      );

      const activeRunnerIds = new Set(Object.keys(runnerStatus?.projects ?? {}));
      const rows = orphans.rows as Array<{
        id: string; title: string; status: string;
        started_at: string | null; restart_count: number; stopped_by: string | null;
      }>;

      return reply.send({
        watchdog: {
          enabled: Boolean(process.env.RUNNER_SERVICE_URL),
          interval_ms: parseInt(process.env.WATCHDOG_INTERVAL_MS ?? "60000", 10),
          max_restarts: parseInt(process.env.WATCHDOG_MAX_RESTARTS ?? "5", 10),
          max_runtime_hours: parseFloat(process.env.WATCHDOG_MAX_RUNTIME_HOURS ?? "8"),
        },
        runner: runnerStatus
          ? { reachable: true, active_count: runnerStatus.active_count ?? 0, active_project_ids: Object.keys(runnerStatus.projects ?? {}) }
          : { reachable: false },
        orphan_candidates: rows.map((r) => ({
          id: r.id,
          title: r.title,
          started_at: r.started_at,
          restart_count: r.restart_count,
          has_active_process: activeRunnerIds.has(r.id),
          runtime_hours: r.started_at
            ? ((Date.now() - new Date(r.started_at).getTime()) / 3600000).toFixed(1)
            : null,
        })),
        checked_at: new Date().toISOString(),
      });
    } finally {
      client.release();
    }
  });
}
