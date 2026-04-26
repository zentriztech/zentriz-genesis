import type { FastifyInstance, FastifyRequest } from "fastify";
import { readFile, readdir, stat } from "fs/promises";
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

  // GET /api/projects/:id/run-info — retorna run_command e app_url do DevOps (para pós-aceite)
  app.get<{ Params: { id: string } }>("/api/projects/:id/run-info", async (request, reply) => {
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
      const hostRoot = process.env.HOST_PROJECT_FILES_ROOT?.trim() ?? root;
      if (!root || !hostRoot) return reply.send({ runCommand: null, appUrl: null, startShPath: null, projectType: null });

      const startShPath    = path.join(root, id, "project", "start.sh");
      const hostStartShPath = path.join(hostRoot, id, "project", "start.sh");
      const appsDir        = path.join(root, id, "apps");
      const hostAppsDir    = path.join(hostRoot, id, "apps");

      // Detect project type: backend if docker-compose.yml exists in apps/
      let projectType: "backend" | "frontend" | "unknown" = "unknown";
      let dockerComposeExists = false;
      try {
        await stat(path.join(appsDir, "docker-compose.yml"));
        dockerComposeExists = true;
        projectType = "backend";
      } catch {
        // Check for next.config to detect frontend
        try { await stat(path.join(appsDir, "next.config.mjs")); projectType = "frontend"; } catch { /* */ }
        try { await stat(path.join(appsDir, "next.config.js")); projectType = "frontend"; } catch { /* */ }
      }

      let appUrl: string | null = null;
      let startShExists = false;
      try {
        const content = await readFile(startShPath, "utf-8");
        startShExists = true;
        const match = content.match(/https?:\/\/localhost:\d+/);
        if (match) appUrl = match[0];
      } catch { /* */ }

      // For backends: prefer docker compose command over start.sh
      let runCommand: string | null = null;
      let setupSteps: string[] | null = null;
      if (dockerComposeExists) {
        runCommand = `cd ${hostAppsDir} && cp .env.example .env && docker compose up -d --build`;
        appUrl = appUrl ?? "http://localhost:7001/docs";
        setupSteps = [
          `cd ${hostAppsDir}`,
          "cp .env.example .env  # editar DATABASE_URL e segredos",
          "docker compose up -d --build",
          "# API: http://localhost:7001",
          "# Swagger: http://localhost:7001/docs",
        ];
      } else if (startShExists) {
        runCommand = `bash ${hostStartShPath}`;
      }

      return reply.send({
        runCommand,
        appUrl,
        startShPath: startShExists ? hostStartShPath : null,
        projectType,
        dockerComposeExists,
        setupSteps,
      });
    } finally {
      client.release();
    }
  });

  // GET /api/projects/:id/code-files — lista arquivos gerados em apps/ (código do produto)
  app.get<{ Params: { id: string } }>("/api/projects/:id/code-files", async (request, reply) => {
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
      if (!root) return reply.send({ files: [], appsRoot: null, totalFiles: 0 });

      const appsDir = path.join(root, id, "apps");
      const files: Array<{ path: string; sizeBytes: number; ext: string }> = [];

      async function walk(dir: string): Promise<void> {
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry === "node_modules" || entry === ".next" || entry === "dist" || entry === ".git") continue;
          const full = path.join(dir, entry);
          let s: Awaited<ReturnType<typeof stat>>;
          try { s = await stat(full); } catch { continue; }
          if (s.isDirectory()) {
            await walk(full);
          } else {
            const rel = path.relative(appsDir, full);
            files.push({ path: rel, sizeBytes: s.size, ext: path.extname(entry).slice(1) });
          }
        }
      }

      await walk(appsDir).catch(() => {});

      files.sort((a, b) => a.path.localeCompare(b.path));

      const hostRoot = process.env.HOST_PROJECT_FILES_ROOT?.trim() ?? root;
      return reply.send({
        files,
        appsRoot: path.join(hostRoot, id, "apps"),
        totalFiles: files.length,
      });
    } finally {
      client.release();
    }
  });

  // POST /api/projects/:id/agent-metrics — registra métricas de tokens/custo por chamada de agente
  app.post<{
    Params: { id: string };
    Body: { agent: string; taskId?: string; round?: number; inputTokens: number; outputTokens: number; model?: string; durationMs?: number; status?: string };
  }>("/api/projects/:id/agent-metrics", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const body = request.body ?? {} as Record<string, unknown>;
    const client = await pool.connect();
    try {
      const row = await client.query("SELECT id, tenant_id, created_by FROM projects WHERE id = $1", [id]);
      const proj = row.rows[0];
      if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      // Accept from runner (via GENESIS_API_TOKEN) or admin/owner
      if (user.role !== "zentriz_admin" && proj.tenant_id !== user.tenantId && proj.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      await client.query(
        `INSERT INTO project_agent_metrics
           (project_id, agent, task_id, round, input_tokens, output_tokens, model, duration_ms, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          String(body.agent ?? "unknown"),
          body.taskId ? String(body.taskId) : null,
          Number(body.round ?? 1),
          Number(body.inputTokens ?? 0),
          Number(body.outputTokens ?? 0),
          body.model ? String(body.model) : null,
          body.durationMs ? Number(body.durationMs) : null,
          body.status ? String(body.status) : null,
        ]
      );
      return reply.status(201).send({ ok: true });
    } finally {
      client.release();
    }
  });

  // GET /api/projects/:id/metrics — totais de tokens e custo estimado do projeto
  app.get<{ Params: { id: string } }>("/api/projects/:id/metrics", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const proj = await client.query("SELECT id, tenant_id, created_by FROM projects WHERE id = $1", [id]);
      const row = proj.rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }

      const totals = await client.query(
        `SELECT
           agent,
           COUNT(*)::int AS calls,
           SUM(input_tokens)::int AS input_tokens,
           SUM(output_tokens)::int AS output_tokens,
           SUM(duration_ms)::int AS duration_ms
         FROM project_agent_metrics
         WHERE project_id = $1
         GROUP BY agent
         ORDER BY agent`,
        [id]
      );

      const grand = await client.query(
        `SELECT
           SUM(input_tokens)::int AS total_input,
           SUM(output_tokens)::int AS total_output,
           COUNT(*)::int AS total_calls
         FROM project_agent_metrics
         WHERE project_id = $1`,
        [id]
      );

      const g = grand.rows[0] as { total_input: number; total_output: number; total_calls: number } | undefined;
      const totalInput = g?.total_input ?? 0;
      const totalOutput = g?.total_output ?? 0;

      // Estimated cost: Claude Sonnet 4 pricing (approximate)
      const costInput = (totalInput / 1_000_000) * 3;   // $3/MTok input
      const costOutput = (totalOutput / 1_000_000) * 15; // $15/MTok output

      return reply.send({
        by_agent: totals.rows,
        totals: {
          calls: g?.total_calls ?? 0,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          estimated_cost_usd: parseFloat((costInput + costOutput).toFixed(4)),
        },
      });
    } finally {
      client.release();
    }
  });

  // GET /api/projects/:id/file-content?path=src/main.ts — conteúdo de um arquivo do projeto
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/projects/:id/file-content",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const filePath = (request.query as { path?: string }).path?.trim();
      if (!filePath) return reply.status(400).send({ code: "BAD_REQUEST", message: "path obrigatório" });
      // Security: prevent path traversal
      if (filePath.includes("..") || filePath.startsWith("/")) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Path inválido" });
      }
      const client = await pool.connect();
      try {
        const row = (await client.query("SELECT id, tenant_id, created_by FROM projects WHERE id = $1", [id])).rows[0];
        if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        const root = process.env.PROJECT_FILES_ROOT?.trim();
        if (!root) return reply.status(503).send({ code: "SERVICE_UNAVAILABLE", message: "PROJECT_FILES_ROOT não configurado" });
        const fullPath = path.join(root, id, "apps", filePath);
        // Ensure the resolved path is still within the project's apps directory
        const appsBase = path.join(root, id, "apps");
        if (!fullPath.startsWith(appsBase)) {
          return reply.status(400).send({ code: "BAD_REQUEST", message: "Path fora do diretório permitido" });
        }
        try {
          const content = await readFile(fullPath, "utf-8");
          return reply.send({ content, path: filePath });
        } catch {
          return reply.status(404).send({ code: "NOT_FOUND", message: "Arquivo não encontrado" });
        }
      } finally {
        client.release();
      }
    }
  );

  // POST /api/admin/projects/cleanup — arquiva projetos antigos (TTL configurável via env)
  // Admin only. Marks old draft/failed/stopped projects as 'archived'.
  // CLEANUP_TTL_DAYS_DRAFT (default 30): draft projects older than N days
  // CLEANUP_TTL_DAYS_TERMINAL (default 90): completed/accepted/failed/stopped projects older than N days
  app.post("/api/admin/projects/cleanup", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas administradores Zentriz" });
    }

    const draftTtlDays = parseInt(process.env.CLEANUP_TTL_DAYS_DRAFT ?? "30", 10);
    const terminalTtlDays = parseInt(process.env.CLEANUP_TTL_DAYS_TERMINAL ?? "90", 10);
    const dryRun = (request.query as Record<string, string>).dry_run === "true";

    const client = await pool.connect();
    try {
      // Ensure 'archived' status is accepted by DB constraint — handled via migration 004 if not present
      const draftResult = await client.query(
        `SELECT id, title, status, updated_at FROM projects
         WHERE status IN ('draft')
           AND updated_at < now() - ($1 || ' days')::interval
         ORDER BY updated_at ASC LIMIT 100`,
        [String(draftTtlDays)]
      );
      const terminalResult = await client.query(
        `SELECT id, title, status, updated_at FROM projects
         WHERE status IN ('completed', 'accepted', 'failed', 'stopped')
           AND updated_at < now() - ($1 || ' days')::interval
         ORDER BY updated_at ASC LIMIT 100`,
        [String(terminalTtlDays)]
      );

      const candidates = [...draftResult.rows, ...terminalResult.rows] as Array<{ id: string; title: string; status: string; updated_at: string }>;

      if (!dryRun && candidates.length > 0) {
        const ids = candidates.map((r) => r.id);
        await client.query(
          `UPDATE projects SET status = 'archived', updated_at = now()
           WHERE id = ANY($1::uuid[])`,
          [ids]
        );
      }

      return reply.send({
        dry_run: dryRun,
        archived_count: dryRun ? 0 : candidates.length,
        candidates: candidates.map((r) => ({ id: r.id, title: r.title, status: r.status, updated_at: r.updated_at })),
        policy: { draft_ttl_days: draftTtlDays, terminal_ttl_days: terminalTtlDays },
      });
    } finally {
      client.release();
    }
  });

  // POST /api/projects/:id/escalate — registra evento de escalação humana
  // Called by the runner when circuit-breaker or rework limits are hit.
  app.post<{ Params: { id: string }; Body: { task_id?: string; reason?: string } }>(
    "/api/projects/:id/escalate",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const body = request.body ?? {};
      const client = await pool.connect();
      try {
        const hasAccess = await checkProjectAccess(client, id, user);
        if (!hasAccess) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        const reason = typeof body.reason === "string" ? body.reason : "Intervenção humana necessária";
        const taskId = typeof body.task_id === "string" ? body.task_id : null;
        // Record as project dialogue so it appears in the portal log
        await client.query(
          `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
           VALUES ($1, 'system', 'human', 'escalation', $2)`,
          [id, taskId ? `[${taskId}] ${reason}` : reason]
        );
        // Also create a notification for project members
        await client.query(
          `INSERT INTO notifications (project_id, type, title, body)
           SELECT $1, 'blocked', $2, $3
           FROM projects WHERE id = $1`,
          [id, "Intervenção necessária", reason]
        );
        return reply.status(201).send({ ok: true, projectId: id, taskId, reason });
      } finally {
        client.release();
      }
    }
  );
}
