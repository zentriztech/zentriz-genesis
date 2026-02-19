import type { FastifyInstance, FastifyRequest } from "fastify";
import { readFile } from "fs/promises";
import path from "path";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

const VALID_PROJECT_STATUS = new Set([
  "draft", "spec_submitted", "pending_conversion", "cto_charter", "pm_backlog",
  "dev_qa", "devops", "completed", "failed", "running", "stopped", "accepted",
]);

async function checkProjectAccess(
  client: { query: (q: string, p?: string[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
  user: AuthUser
): Promise<boolean> {
  const result = await client.query("SELECT tenant_id, created_by FROM projects WHERE id = $1", [projectId]);
  const row = result.rows[0];
  if (!row) return false;
  if (user.role === "zentriz_admin") return true;
  if (user.tenantId && (row.tenant_id as string) === user.tenantId) return true;
  if (row.created_by === user.id) return true;
  return false;
}

export async function projectRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get("/api/projects", async (request, reply) => {
    const user = getUser(request);
    const client = await pool.connect();
    try {
      let result;
      if (user.role === "zentriz_admin") {
        result = await client.query(
          `SELECT p.*, u.email as created_by_email FROM projects p
           JOIN users u ON p.created_by = u.id
           ORDER BY p.updated_at DESC`
        );
      } else if (user.tenantId) {
        result = await client.query(
          `SELECT p.*, u.email as created_by_email FROM projects p
           JOIN users u ON p.created_by = u.id
           WHERE p.tenant_id = $1 ORDER BY p.updated_at DESC`,
          [user.tenantId]
        );
      } else {
        result = await client.query(
          `SELECT p.*, u.email as created_by_email FROM projects p
           JOIN users u ON p.created_by = u.id
           WHERE p.created_by = $1 ORDER BY p.updated_at DESC`,
          [user.id]
        );
      }
      const projects = result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        tenantId: row.tenant_id,
        createdBy: row.created_by,
        title: (row.title && String(row.title).trim()) || "Spec sem título",
        specRef: row.spec_ref,
        status: row.status,
        charterSummary: row.charter_summary,
        backlogSummary: row.backlog_summary ?? undefined,
        createdAt: (row.created_at as Date)?.toISOString(),
        updatedAt: (row.updated_at as Date)?.toISOString(),
        startedAt: (row.started_at as Date)?.toISOString() ?? undefined,
        completedAt: (row.completed_at as Date)?.toISOString() ?? undefined,
      }));
      return reply.send(projects);
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT * FROM projects WHERE id = $1",
        [id]
      );
      const row = result.rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      return reply.send({
        id: row.id,
        tenantId: row.tenant_id,
        createdBy: row.created_by,
        title: (row.title && String(row.title).trim()) || "Spec sem título",
        specRef: row.spec_ref,
        status: row.status,
        charterSummary: row.charter_summary,
        backlogSummary: (row as Record<string, unknown>).backlog_summary as string | undefined,
        createdAt: (row.created_at as Date).toISOString(),
        updatedAt: (row.updated_at as Date).toISOString(),
        startedAt: (row.started_at as Date)?.toISOString() ?? undefined,
        completedAt: (row.completed_at as Date)?.toISOString() ?? undefined,
      });
    } finally {
      client.release();
    }
  });

  app.patch<{ Params: { id: string }; Body: { status?: string; started_at?: string; completed_at?: string; charter_summary?: string; backlog_summary?: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const { status, started_at, completed_at, charter_summary, backlog_summary } = request.body ?? {};
      const client = await pool.connect();
      try {
        const check = await client.query("SELECT tenant_id, created_by FROM projects WHERE id = $1", [id]);
        const project = check.rows[0];
        if (!project) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && project.tenant_id !== user.tenantId) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }

        const updates: string[] = [];
        const values: unknown[] = [];
        let i = 1;
        if (status !== undefined) {
          if (!VALID_PROJECT_STATUS.has(status)) {
            return reply.status(400).send({ code: "BAD_REQUEST", message: `Status inválido: ${status}` });
          }
          updates.push(`status = $${i++}`);
          values.push(status);
        }
        if (started_at !== undefined) {
          updates.push(`started_at = $${i++}`);
          values.push(started_at);
        }
        if (completed_at !== undefined) {
          updates.push(`completed_at = $${i++}`);
          values.push(completed_at);
        }
        if (charter_summary !== undefined) {
          updates.push(`charter_summary = $${i++}`);
          values.push(charter_summary);
        }
        if (backlog_summary !== undefined) {
          updates.push(`backlog_summary = $${i++}`);
          values.push(backlog_summary);
        }
        if (updates.length === 0) return reply.send({ ok: true });

        updates.push(`updated_at = now()`);
        values.push(id);
        await client.query(
          `UPDATE projects SET ${updates.join(", ")} WHERE id = $${i}`,
          values
        );
        return reply.send({ ok: true });
      } finally {
        client.release();
      }
    }
  );

  // GET /api/projects/:id/tasks — lista tarefas do projeto (Monitor Loop)
  app.get<{ Params: { id: string } }>("/api/projects/:id/tasks", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, id, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const result = await client.query(
        "SELECT id, project_id, task_id, module, owner_role, requirements, status, artifacts_ref, evidence, created_at, updated_at FROM project_tasks WHERE project_id = $1 ORDER BY task_id",
        [id]
      );
      const tasks = result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        projectId: row.project_id,
        taskId: row.task_id,
        module: row.module,
        ownerRole: row.owner_role,
        requirements: row.requirements,
        status: row.status,
        artifactsRef: row.artifacts_ref,
        evidence: row.evidence,
        createdAt: (row.created_at as Date)?.toISOString(),
        updatedAt: (row.updated_at as Date)?.toISOString(),
      }));
      return reply.send(tasks);
    } finally {
      client.release();
    }
  });

  // POST /api/projects/:id/tasks — seed ou upsert tarefas (runner / Monitor Loop)
  app.post<{
    Params: { id: string };
    Body: { tasks: Array<{ task_id: string; module?: string; owner_role: string; requirements?: string; status?: string }> };
  }>("/api/projects/:id/tasks", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const { tasks } = request.body ?? {};
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Body deve conter tasks (array não vazio)" });
    }
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, id, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const created: unknown[] = [];
      for (const t of tasks) {
        const taskId = t.task_id ?? "";
        const module = t.module ?? "backend";
        const ownerRole = t.owner_role ?? "DEV_BACKEND";
        const requirements = t.requirements ?? null;
        const status = t.status ?? "ASSIGNED";
        await client.query(
          `INSERT INTO project_tasks (project_id, task_id, module, owner_role, requirements, status)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (project_id, task_id) DO UPDATE SET
             module = EXCLUDED.module,
             owner_role = EXCLUDED.owner_role,
             requirements = COALESCE(EXCLUDED.requirements, project_tasks.requirements),
             status = EXCLUDED.status,
             updated_at = now()`,
          [id, taskId, module, ownerRole, requirements, status]
        );
        created.push({ taskId, module, ownerRole, status });
      }
      return reply.status(201).send({ ok: true, tasks: created });
    } finally {
      client.release();
    }
  });

  // PATCH /api/projects/:id/tasks/:taskId — atualizar uma task (Monitor Loop após cada agente)
  app.patch<{
    Params: { id: string; taskId: string };
    Body: { status?: string; artifacts_ref?: string; evidence?: string };
  }>("/api/projects/:id/tasks/:taskId", async (request, reply) => {
    const user = getUser(request);
    const { id, taskId } = request.params;
    const { status, artifacts_ref, evidence } = request.body ?? {};
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, id, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const updates: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (status !== undefined) {
        updates.push(`status = $${i++}`);
        values.push(status);
      }
      if (artifacts_ref !== undefined) {
        updates.push(`artifacts_ref = $${i++}`);
        values.push(artifacts_ref);
      }
      if (evidence !== undefined) {
        updates.push(`evidence = $${i++}`);
        values.push(evidence);
      }
      if (updates.length === 0) return reply.send({ ok: true });
      updates.push("updated_at = now()");
      values.push(id, taskId);
      const result = await client.query(
        `UPDATE project_tasks SET ${updates.join(", ")} WHERE project_id = $${i++} AND task_id = $${i}`,
        values
      );
      if (result.rowCount === 0) return reply.status(404).send({ code: "NOT_FOUND", message: "Tarefa não encontrada" });
      return reply.send({ ok: true });
    } finally {
      client.release();
    }
  });

  // POST /api/projects/:id/accept — marca projeto como aceite pelo usuário (Monitor Loop para)
  app.post<{ Params: { id: string } }>("/api/projects/:id/accept", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, id, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const proj = await client.query("SELECT status FROM projects WHERE id = $1", [id]);
      const row = proj.rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const current = row.status as string;
      if (current === "accepted") return reply.send({ ok: true, status: "accepted", message: "Projeto já aceito" });
      if (!["running", "completed", "stopped"].includes(current)) {
        return reply.status(409).send({
          code: "CONFLICT",
          message: `Aceite só permitido quando status é running, completed ou stopped. Atual: ${current}`,
        });
      }
      await client.query("UPDATE projects SET status = $1, updated_at = now() WHERE id = $2", ["accepted", id]);
      const updated = await client.query(
        "SELECT id, status, updated_at FROM projects WHERE id = $1",
        [id]
      );
      const u = updated.rows[0] as Record<string, unknown>;
      return reply.send({
        ok: true,
        status: "accepted",
        updatedAt: (u.updated_at as Date)?.toISOString(),
      });
    } finally {
      client.release();
    }
  });

  // Lista documentos/artefatos do projeto (PROJECT_FILES_ROOT/<id>/docs/manifest.json)
  app.get<{ Params: { id: string } }>("/api/projects/:id/artifacts", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT id, tenant_id, created_by FROM projects WHERE id = $1",
        [id]
      );
      const row = result.rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }

      const root = process.env.PROJECT_FILES_ROOT?.trim();
      if (!root) {
        return reply.send({ docs: [], projectDocsRoot: null, projectArtifactsRoot: null });
      }
      const docsDir = path.join(root, id, "docs");
      const projectDir = path.join(root, id, "project");
      const manifestPath = path.join(docsDir, "manifest.json");
      let docs: Array<{ filename: string; creator: string; title?: string; created_at?: string }> = [];
      try {
        const raw = await readFile(manifestPath, "utf-8");
        const parsed = JSON.parse(raw);
        docs = Array.isArray(parsed) ? parsed : [];
      } catch {
        // manifest não existe ou inválido
      }
      return reply.send({
        docs,
        projectDocsRoot: docsDir,
        projectArtifactsRoot: projectDir,
      });
    } finally {
      client.release();
    }
  });
}
