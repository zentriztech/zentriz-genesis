import type { FastifyInstance, FastifyRequest } from "fastify";
import { spawn } from "child_process";
import path from "path";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { signToken } from "../auth.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

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
        "1h"
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
          "UPDATE projects SET status = $1, started_at = now(), updated_at = now() WHERE id = $2",
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
          const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId,
              specPath: specFilePath,
              apiBaseUrl,
              token,
            }),
          });
          if (res.status >= 200 && res.status < 300) {
            await client.query(
              "UPDATE projects SET status = $1, started_at = now(), updated_at = now() WHERE id = $2",
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
              "UPDATE projects SET status = $1, updated_at = now() WHERE id = $2",
              ["stopped", projectId]
            );
            return reply.send({ ok: true, message: "Pipeline encerrado" });
          }
        } catch (err) {
          request.log.error(err, "Falha ao chamar runner service stop");
        }
      }
      await client.query(
        "UPDATE projects SET status = $1, updated_at = now() WHERE id = $2",
        ["stopped", projectId]
      );
      return reply.send({ ok: true, message: "Pipeline marcado como encerrado" });
    } finally {
      client.release();
    }
  });
}
