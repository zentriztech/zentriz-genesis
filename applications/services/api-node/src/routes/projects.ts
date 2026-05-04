import type { FastifyInstance, FastifyRequest } from "fastify";
import { readFile, writeFile, readdir, stat } from "fs/promises";
import path from "path";
import { pushProjectToGitHub } from "../services/githubPush.js";
import { deployEphemeral, destroyDeployment } from "../services/ephemeralDeploy.js";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

const VALID_PROJECT_STATUS = new Set([
  "draft", "spec_submitted", "pending_conversion", "cto_charter", "pm_backlog",
  "dev_qa", "devops", "completed", "failed", "running", "stopped", "accepted", "archived",
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
      // Ordena: projetos agrupados por produto seguem ordem topológica (depth no grafo de triggers).
      // Projetos sem produto ficam no topo ordenados por updated_at (mais recentes primeiro).
      const baseSelect = `
        WITH RECURSIVE topo AS (
          SELECT p2.id, 0 AS depth
          FROM projects p2
          WHERE p2.product_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM project_triggers pt2
              WHERE pt2.project_id = p2.id
                AND pt2.trigger_project_id IN (
                  SELECT id FROM projects WHERE product_id = p2.product_id
                )
            )
          UNION ALL
          SELECT p2.id, t.depth + 1
          FROM projects p2
          JOIN project_triggers pt2 ON pt2.project_id = p2.id
          JOIN topo t ON t.id = pt2.trigger_project_id
          WHERE p2.product_id IS NOT NULL
        ),
        depths AS (SELECT id, MAX(depth) AS depth FROM topo GROUP BY id),
        task_counts AS (
          SELECT project_id,
                 COUNT(*) FILTER (WHERE task_id NOT IN ('TSK-DEVOPS-001','TSK-FULL-TEST'))            AS total,
                 COUNT(*) FILTER (WHERE status IN ('DONE','QA_PASS')
                                    AND task_id NOT IN ('TSK-DEVOPS-001','TSK-FULL-TEST'))             AS done
          FROM project_tasks GROUP BY project_id
        )`;

      let result;
      if (user.role === "zentriz_admin") {
        result = await client.query(
          `${baseSelect}
           SELECT p.*, u.email as created_by_email,
                  COALESCE(d.depth, 0) AS execution_order,
                  COALESCE(tc.total, 0)::int AS task_count,
                  COALESCE(tc.done, 0)::int  AS task_done_count
           FROM projects p
           JOIN users u ON p.created_by = u.id
           LEFT JOIN depths d ON d.id = p.id
           LEFT JOIN task_counts tc ON tc.project_id = p.id
           ORDER BY
             CASE WHEN p.product_id IS NULL THEN 0 ELSE 1 END ASC,
             p.product_id NULLS FIRST,
             COALESCE(d.depth, 0) ASC,
             p.created_at ASC`
        );
      } else if (user.tenantId) {
        result = await client.query(
          `${baseSelect}
           SELECT p.*, u.email as created_by_email, COALESCE(d.depth, 0) AS execution_order
           FROM projects p
           JOIN users u ON p.created_by = u.id
           LEFT JOIN depths d ON d.id = p.id
           WHERE p.tenant_id = $1
           ORDER BY
             CASE WHEN p.product_id IS NULL THEN 0 ELSE 1 END ASC,
             p.product_id NULLS FIRST,
             COALESCE(d.depth, 0) ASC,
             p.created_at ASC`,
          [user.tenantId]
        );
      } else {
        result = await client.query(
          `${baseSelect}
           SELECT p.*, u.email as created_by_email, COALESCE(d.depth, 0) AS execution_order
           FROM projects p
           JOIN users u ON p.created_by = u.id
           LEFT JOIN depths d ON d.id = p.id
           WHERE p.created_by = $1
           ORDER BY
             CASE WHEN p.product_id IS NULL THEN 0 ELSE 1 END ASC,
             p.product_id NULLS FIRST,
             COALESCE(d.depth, 0) ASC,
             p.created_at ASC`,
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
        parentProjectId: (row.parent_project_id as string | null) ?? null,
        versionNumber: (row.version_number as number | null) ?? 1,
        freeDescription: ((row.extra as Record<string, unknown> | null)?.free_description as string | undefined) ?? null,
        projectType:    ((row.extra as Record<string, unknown> | null)?.project_type    as string | undefined) ?? null,
        productId:       (row.product_id as string | null) ?? null,
        complexityHint:  (row.complexity_hint as string | null) ?? null,
        executionOrder:  (row.execution_order as number | null) ?? 0,
        taskCount:       (row.task_count as number | null) ?? null,
        taskDoneCount:   (row.task_done_count as number | null) ?? null,
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
        parentProjectId: (row as Record<string, unknown>).parent_project_id as string | null ?? null,
        versionNumber: (row as Record<string, unknown>).version_number as number ?? 1,
        freeDescription: ((row as Record<string, unknown>).extra as Record<string, unknown> | null)?.free_description as string | undefined ?? null,
        projectType:    ((row as Record<string, unknown>).extra as Record<string, unknown> | null)?.project_type    as string | undefined ?? null,
        productId:      (row as Record<string, unknown>).product_id as string | null ?? null,
        complexityHint: (row as Record<string, unknown>).complexity_hint as string | null ?? null,
        extra:          (row as Record<string, unknown>).extra as Record<string, unknown> | null ?? null,
      });
    } finally {
      client.release();
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      status?: string;
      started_at?: string;
      completed_at?: string;
      finished_at?: string;
      charter_summary?: string;
      backlog_summary?: string;
      complexity_hint?: string;
    };
  }>(
    "/api/projects/:id",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const { status, started_at, completed_at, finished_at, charter_summary, backlog_summary, complexity_hint } = request.body ?? {};
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
        if (finished_at !== undefined) {
          updates.push(`finished_at = $${i++}`);
          values.push(finished_at);
        }
        if (charter_summary !== undefined) {
          updates.push(`charter_summary = $${i++}`);
          values.push(charter_summary);
        }
        if (backlog_summary !== undefined) {
          updates.push(`backlog_summary = $${i++}`);
          values.push(backlog_summary);
        }
        if (complexity_hint !== undefined) {
          const validHints = new Set(["trivial", "low", "medium", "high"]);
          if (!validHints.has(complexity_hint)) {
            return reply.status(400).send({ code: "BAD_REQUEST", message: `complexity_hint inválido: ${complexity_hint}` });
          }
          updates.push(`complexity_hint = $${i++}`);
          values.push(complexity_hint);
        }
        if (updates.length === 0) return reply.send({ ok: true });

        updates.push(`updated_at = now()`);
        values.push(id);
        await client.query(
          `UPDATE projects SET ${updates.join(", ")} WHERE id = $${i}`,
          values
        );

        // Disparar gatilhos se status mudou para completed
        if (status === "completed") {
          setImmediate(async () => {
            try {
              const triggers = await pool.query(
                `SELECT pt.project_id FROM project_triggers pt
                 WHERE pt.trigger_project_id = $1 AND pt.trigger_status = 'completed'`,
                [id]
              );
              for (const t of triggers.rows) {
                const target = await pool.query("SELECT id, status FROM projects WHERE id=$1", [t.project_id]);
                const tp = target.rows[0] as Record<string, unknown>;
                if (tp && ["draft","spec_submitted","stopped","failed"].includes(tp.status as string)) {
                  const { spawn } = await import("child_process");
                  const runnerPath = process.env.RUNNER_PATH ?? "/app/runner/runner.py";
                  const python = process.env.PYTHON_BIN ?? "python3";
                  spawn(python, [runnerPath, String(t.project_id)], { detached: true, stdio: "ignore" }).unref();
                  await pool.query("UPDATE projects SET status='running', updated_at=NOW() WHERE id=$1", [t.project_id]);
                  console.info(`[TRIGGER] Projeto ${t.project_id} iniciado por gatilho completed ${id}`);
                }
              }
            } catch (e) { console.error("[TRIGGER] Falha ao disparar gatilhos:", e); }
          });
        }

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
        `SELECT id, project_id, task_id, module, owner_role, requirements, status, artifacts_ref, evidence, created_at, updated_at,
                monitor_attempted
         FROM project_tasks WHERE project_id = $1
         ORDER BY
           CASE WHEN task_id IN ('TSK-DEVOPS-001','TSK-FULL-TEST') THEN 1 ELSE 0 END ASC,
           -- Extrai número do sufixo numérico do task_id (TSK-BE-001 → 1, TSK-WEB-012 → 12)
           -- Garante ordem 001 < 002 < ... < 012 independente do created_at
           COALESCE(
             NULLIF(regexp_replace(task_id, '^.*?-0*([0-9]+)$', '\\1', 'g'), task_id)::int,
             0
           ) ASC,
           created_at ASC`,
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
        artifactsRef:     row.artifacts_ref,
        evidence:         row.evidence,
        monitorAttempted: row.monitor_attempted ?? false,
        createdAt:  (row.created_at as Date)?.toISOString(),
        updatedAt:  (row.updated_at as Date)?.toISOString(),
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
        // Aceita snake_case (task_id, owner_role) e camelCase (taskId, ownerRole) — runner pode enviar qualquer um
        const taskId = (t as Record<string, unknown>).taskId as string ?? t.task_id ?? "";
        const module = (t as Record<string, unknown>).module as string ?? "backend";
        const ownerRole = (t as Record<string, unknown>).ownerRole as string ?? t.owner_role ?? "DEV_BACKEND";
        const requirements = t.requirements ?? null;
        const status = t.status ?? "ASSIGNED";
        await client.query(
          `INSERT INTO project_tasks (project_id, task_id, module, owner_role, requirements, status)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (project_id, task_id) DO UPDATE SET
             module = EXCLUDED.module,
             owner_role = EXCLUDED.owner_role,
             requirements = COALESCE(EXCLUDED.requirements, project_tasks.requirements),
             -- IDEMPOTENCY: preserve terminal statuses; reset IN_PROGRESS/WAITING_REVIEW to ASSIGNED on restart
             status = CASE
               WHEN project_tasks.status IN ('DONE','QA_PASS','QA_FAIL','BLOCKED') THEN project_tasks.status
               WHEN project_tasks.status IN ('IN_PROGRESS','WAITING_REVIEW') THEN 'ASSIGNED'
               ELSE EXCLUDED.status
             END,
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

  // POST /api/projects/:id/accept — marca projeto como aceito (usuário humano ou Zentriz Cyborg)
  // Body opcional: { accepted_by?: "zentriz-cyborg" | string, evidence?: string }
  app.post<{ Params: { id: string }; Body?: { accepted_by?: string; evidence?: string } }>(
    "/api/projects/:id/accept",
    async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const acceptedBy: string = (request.body as Record<string, string> | undefined)?.accepted_by ?? user.id;
    const evidence:   string = (request.body as Record<string, string> | undefined)?.evidence   ?? "";
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
      // Gravar accepted_by e evidence no campo extra (jsonb merge)
      await client.query(
        `UPDATE projects
         SET status = $1,
             extra = COALESCE(extra, '{}') || $2::jsonb,
             updated_at = now()
         WHERE id = $3`,
        ["accepted", JSON.stringify({ accepted_by: acceptedBy, ...(evidence ? { accepted_evidence: evidence } : {}) }), id]
      );
      const updated = await client.query(
        "SELECT id, status, updated_at, product_id, title FROM projects WHERE id = $1",
        [id]
      );
      const u = updated.rows[0] as Record<string, unknown>;

      // I-2: copiar api_contract.md para <product_id>/contracts/ quando projeto é aceito
      setImmediate(async () => {
        try {
          const productId = u.product_id as string | null;
          const title = u.title as string ?? "";
          if (productId) {
            const { readFileSync, existsSync, mkdirSync, copyFileSync } = await import("fs");
            const { join } = await import("path");
            const filesRoot = (process.env.PROJECT_FILES_ROOT ?? process.env.HOST_PROJECT_FILES_ROOT ?? "").trim();
            if (filesRoot) {
              // Tentar path com product_id (nova estrutura) ou standalone (compat)
              const contractPaths = [
                join(filesRoot, productId, id, "project", "api_contract.md"),
                join(filesRoot, id, "project", "api_contract.md"),
              ];
              for (const src of contractPaths) {
                if (existsSync(src)) {
                  const contractsDir = join(filesRoot, productId, "contracts");
                  mkdirSync(contractsDir, { recursive: true });
                  const slug = title.toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-").slice(0, 40);
                  const dest = join(contractsDir, `${slug}.api_contract.md`);
                  copyFileSync(src, dest);
                  console.info(`[I-2] Contrato copiado: ${dest}`);
                  break;
                }
              }
            }
          }
        } catch (err) {
          console.debug("[I-2] Falha ao copiar contrato:", err);
        }
      });

      // Fire-and-forget: push to GitHub if tenant has GitHub App installed
      // Never awaited — must not delay the accept response
      setImmediate(() => pushProjectToGitHub(id).catch(console.error));

      // Disparar gatilhos de pipeline: projetos que esperam este projeto aceito
      setImmediate(async () => {
        try {
          const triggers = await pool.query(
            `SELECT pt.project_id FROM project_triggers pt
             WHERE pt.trigger_project_id = $1 AND pt.trigger_status = 'accepted'`,
            [id]
          );
          const runnerServiceUrl = (process.env.RUNNER_SERVICE_URL ?? "").trim();
          const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:3000").trim();
          for (const t of triggers.rows) {
            const target = await pool.query("SELECT id, status, created_by, tenant_id FROM projects WHERE id=$1", [t.project_id]);
            const tp = target.rows[0] as Record<string, unknown>;
            if (!tp || !["draft","spec_submitted","stopped","failed"].includes(tp.status as string)) continue;
            // Chamar runner_server via HTTP — o container api não tem Python
            if (runnerServiceUrl) {
              try {
                const specRes = await pool.query(
                  `SELECT file_path FROM project_spec_files WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
                  [t.project_id]
                );
                const specPath = specRes.rows[0]?.file_path as string | undefined;
                if (!specPath) {
                  console.warn(`[TRIGGER] Spec não encontrada para ${t.project_id} — abortando trigger`);
                  continue;
                }
                const { signToken } = await import("../auth.js");
                const userRes = await pool.query(
                  `SELECT u.id, u.email, u.role FROM users u WHERE u.id = $1`, [tp.created_by]
                );
                const u = userRes.rows[0] as Record<string, unknown> | undefined;
                if (!u) { console.warn(`[TRIGGER] Usuário não encontrado para ${t.project_id}`); continue; }
                const token = signToken({ sub: u.id as string, email: u.email as string, role: u.role as string, tenantId: tp.tenant_id as string | null }, "24h");
                const uploadDir = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
                const runnerUploadDir = (process.env.RUNNER_UPLOAD_DIR ?? "").trim();
                let runBody: Record<string, string>;
                if (runnerUploadDir && (specPath as string).startsWith(uploadDir)) {
                  const relative = (specPath as string).slice(uploadDir.length);
                  runBody = { projectId: t.project_id, specPath: `${runnerUploadDir}${relative}`, apiBaseUrl, token };
                } else {
                  const { readFileSync } = await import("fs");
                  const specB64 = readFileSync(specPath as string).toString("base64");
                  runBody = { projectId: t.project_id, specContent: specB64, apiBaseUrl, token };
                }
                const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/run`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(runBody),
                  signal: AbortSignal.timeout(15000),
                });
                if (res.ok || res.status === 409) {
                  console.info(`[TRIGGER] Projeto ${t.project_id} iniciado via runner_server (status=${res.status}) — gatilho de ${id}`);
                } else {
                  const txt = await res.text();
                  console.error(`[TRIGGER] runner_server retornou ${res.status} para ${t.project_id}: ${txt.slice(0, 200)}`);
                }
              } catch (trigErr) {
                console.error(`[TRIGGER] Erro ao disparar ${t.project_id} via runner_server:`, trigErr);
              }
            } else {
              console.warn(`[TRIGGER] RUNNER_SERVICE_URL não definido — não foi possível disparar ${t.project_id}`);
            }
          }
        } catch (e) {
          console.error("[TRIGGER] Falha ao disparar gatilhos:", e);
        }
      });

      // G44 — Emit project.shipped event for Deadpool handoff
      // Persisted in DB as a dialogue entry so Deadpool can poll or webhook
      setImmediate(async () => {
        try {
          const projDetails = await pool.query(
            "SELECT title, tenant_id, created_by FROM projects WHERE id = $1", [id]
          );
          const p = projDetails.rows[0] as Record<string, unknown>;
          await pool.query(
            `INSERT INTO dialogue_entries (id, project_id, from_agent, to_agent, event_type, summary_human, created_at)
             VALUES (gen_random_uuid(), $1, 'genesis', 'deadpool', 'project.shipped',
               $2, now())
             ON CONFLICT DO NOTHING`,
            [id, JSON.stringify({
              event: "project.shipped",
              project_id: id,
              title: p?.title,
              tenant_id: p?.tenant_id,
              shipped_at: new Date().toISOString(),
              github_push_triggered: true,
            })]
          );
        } catch (e) {
          console.error("[G44] project.shipped event failed:", e);
        }
      });

      // Postar no diálogo quem aceitou
      const isCyborg = acceptedBy === "zentriz-cyborg";
      setImmediate(async () => {
        try {
          await pool.query(
            `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
             VALUES ($1, 'system', 'system', 'step', $2)`,
            [id, isCyborg
              ? `🤖 Zentriz Cyborg validou e aceitou este projeto automaticamente. Evidências: ${evidence || "PLAYBOOK UNIVERSAL — todos os checks passaram."}`
              : `✅ Projeto aceito pelo usuário.`]
          );
        } catch { /* não crítico */ }
      });

      return reply.send({
        ok: true,
        status: "accepted",
        acceptedBy,
        updatedAt: (u.updated_at as Date)?.toISOString(),
        githubPushTriggered: true,
        event: "project.shipped",
      });
    } finally {
      client.release();
    }
  });

  // POST /api/projects/:id/reject — rejeita projeto (Zentriz Cyborg ou humano)
  // Body: { rejected_by?: string, reason: string }
  app.post<{ Params: { id: string }; Body: { rejected_by?: string; reason: string } }>(
    "/api/projects/:id/reject",
    async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const rejectedBy: string = request.body?.rejected_by ?? user.id;
    const reason:     string = request.body?.reason ?? "Rejeitado sem motivo especificado.";
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, id, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const proj = await client.query("SELECT status FROM projects WHERE id = $1", [id]);
      const row = proj.rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const current = row.status as string;
      if (!["running", "completed", "stopped"].includes(current)) {
        return reply.status(409).send({
          code: "CONFLICT",
          message: `Rejeição só permitida quando status é running, completed ou stopped. Atual: ${current}`,
        });
      }
      await client.query(
        `UPDATE projects
         SET status = 'failed',
             extra  = COALESCE(extra, '{}') || $1::jsonb,
             updated_at = now()
         WHERE id = $2`,
        [JSON.stringify({ rejected_by: rejectedBy, rejected_reason: reason, rejected_at: new Date().toISOString() }), id]
      );
      // Registrar no diálogo
      const isCyborg = rejectedBy === "zentriz-cyborg";
      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
         VALUES ($1, 'system', 'system', 'step', $2)`,
        [id, isCyborg
          ? `❌ Zentriz Cyborg rejeitou este projeto após ${2} tentativas de validação. Motivo: ${reason}`
          : `❌ Projeto rejeitado. Motivo: ${reason}`]
      );
      return reply.send({ ok: true, status: "failed", rejectedBy, reason });
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

  // GET /api/projects/:id/versions — retorna toda a linhagem de versões do produto
  app.get<{ Params: { id: string } }>("/api/projects/:id/versions", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const row = (await client.query("SELECT id, tenant_id, created_by, parent_project_id FROM projects WHERE id=$1", [id])).rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }

      // Find root of this lineage
      let rootId = id;
      if (row.parent_project_id) {
        const parentRow = (await client.query("SELECT id, parent_project_id FROM projects WHERE id=$1", [row.parent_project_id])).rows[0];
        rootId = parentRow?.parent_project_id ? (parentRow.parent_project_id as string) : (row.parent_project_id as string);
      }

      // Get all versions: root + all descendants
      const versionsRes = await client.query(
        `WITH RECURSIVE lineage AS (
           SELECT id, title, status, version_number, parent_project_id, created_at, updated_at, started_at, completed_at
           FROM projects WHERE id = $1
           UNION ALL
           SELECT p.id, p.title, p.status, p.version_number, p.parent_project_id, p.created_at, p.updated_at, p.started_at, p.completed_at
           FROM projects p JOIN lineage l ON p.parent_project_id = l.id
         )
         SELECT * FROM lineage ORDER BY version_number ASC`,
        [rootId],
      );

      const versions = versionsRes.rows.map((v) => ({
        id: v.id,
        title: v.title,
        status: v.status,
        versionNumber: v.version_number,
        parentProjectId: v.parent_project_id,
        createdAt: (v.created_at as Date).toISOString(),
        updatedAt: (v.updated_at as Date).toISOString(),
        startedAt: (v.started_at as Date)?.toISOString() ?? null,
        completedAt: (v.completed_at as Date)?.toISOString() ?? null,
        isCurrent: v.id === id,
      }));

      return reply.send({ versions, rootId, currentId: id });
    } finally {
      client.release();
    }
  });

  // GET /api/projects/:id/github-repo — retorna info do repositório GitHub criado no aceite
  // GET /api/projects/:id/triggers/predecessors — predecessores deste projeto (pré-requisitos)
  // Usado pelo runner para carregar contratos dos projetos que já foram concluídos.
  app.get<{ Params: { id: string } }>("/api/projects/:id/triggers/predecessors", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const hasAccess = await checkProjectAccess(client, id, user);
      if (!hasAccess) return reply.status(403).send({ code: "FORBIDDEN" });
      const res = await client.query(
        `SELECT p.id, p.title, p.status, p.project_type AS "projectType", pt.trigger_status AS "triggerStatus"
         FROM project_triggers pt
         JOIN projects p ON p.id = pt.trigger_project_id
         WHERE pt.project_id = $1
         ORDER BY p.created_at ASC`,
        [id]
      );
      return reply.send(res.rows);
    } finally { client.release(); }
  });

  // GET /api/projects/:id/triggers/dependents — projetos que dependem deste
  app.get<{ Params: { id: string } }>("/api/projects/:id/triggers/dependents", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const hasAccess = await checkProjectAccess(client, id, user);
      if (!hasAccess) return reply.status(403).send({ code: "FORBIDDEN" });
      const res = await client.query(
        `SELECT p.id, p.title, p.status, p.project_type AS "projectType", pt.trigger_status AS "triggerStatus"
         FROM project_triggers pt
         JOIN projects p ON p.id = pt.project_id
         WHERE pt.trigger_project_id = $1
         ORDER BY p.created_at ASC`,
        [id]
      );
      return reply.send(res.rows);
    } finally { client.release(); }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/github-repo", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const row = (await client.query("SELECT id, tenant_id, created_by FROM projects WHERE id = $1", [id])).rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      const repoRow = (await client.query(
        "SELECT repo_name, repo_full_name, repo_url, clone_url, pushed_at, sha_dev FROM project_github_repos WHERE project_id = $1",
        [id],
      )).rows[0];
      if (!repoRow) return reply.send({ repo: null });
      return reply.send({
        repo: {
          name: repoRow.repo_name,
          fullName: repoRow.repo_full_name,
          url: repoRow.repo_url,
          cloneUrl: repoRow.clone_url,
          branchUrls: {
            dev:     `${repoRow.repo_url}/tree/dev`,
            staging: `${repoRow.repo_url}/tree/staging`,
            main:    `${repoRow.repo_url}/tree/main`,
          },
          pushedAt: (repoRow.pushed_at as Date)?.toISOString() ?? null,
          shaDev: repoRow.sha_dev,
        },
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

  // GET /api/projects/:id/agent-metrics/qa-fail-counts — conta QA_FAILs por task para restaurar qa_fail_count no runner
  app.get<{ Params: { id: string } }>("/api/projects/:id/agent-metrics/qa-fail-counts", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const proj = await client.query("SELECT id, tenant_id, created_by FROM projects WHERE id = $1", [id]);
      const row = proj.rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      const res = await client.query(
        `SELECT task_id, COUNT(*)::int AS fail_count
         FROM project_agent_metrics
         WHERE project_id = $1 AND agent = 'qa' AND status = 'QA_FAIL' AND task_id IS NOT NULL
         GROUP BY task_id`,
        [id]
      );
      const result: Record<string, number> = {};
      for (const r of res.rows) result[r.task_id as string] = r.fail_count as number;
      return reply.send(result);
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

  // GET /api/projects/:id/task-metrics — custo, tokens e tempo por task
  app.get<{ Params: { id: string } }>("/api/projects/:id/task-metrics", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const row = (await client.query("SELECT id, tenant_id, created_by FROM projects WHERE id=$1", [id])).rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      // Buscar linhas individuais para calcular custo por modelo corretamente
      const res = await client.query(
        `SELECT
           COALESCE(task_id, '(planejamento)') AS task_id,
           input_tokens,
           output_tokens,
           model,
           duration_ms,
           agent,
           created_at
         FROM project_agent_metrics
         WHERE project_id = $1
         ORDER BY created_at`,
        [id]
      );
      const PRICE_INPUT_SONNET  = 3;    // USD/MTok Sonnet 4.6
      const PRICE_OUTPUT_SONNET = 15;
      const PRICE_INPUT_OPUS    = 15;   // USD/MTok Opus 4.7
      const PRICE_OUTPUT_OPUS   = 75;
      // Agregar por task_id
      const byTask = new Map<string, { calls: number; inputTokens: number; outputTokens: number; durationMs: number; costUsd: number; agents: Set<string>; models: Set<string>; lastCallAt: Date | null }>();
      for (const r of res.rows) {
        const tid = r.task_id as string;
        const inp = Number(r.input_tokens ?? 0);
        const out = Number(r.output_tokens ?? 0);
        const isOpus = String(r.model ?? "").includes("opus");
        const pi = isOpus ? PRICE_INPUT_OPUS : PRICE_INPUT_SONNET;
        const po = isOpus ? PRICE_OUTPUT_OPUS : PRICE_OUTPUT_SONNET;
        const cost = (inp / 1_000_000) * pi + (out / 1_000_000) * po;
        const existing = byTask.get(tid);
        if (existing) {
          existing.calls++;
          existing.inputTokens += inp;
          existing.outputTokens += out;
          existing.durationMs += Number(r.duration_ms ?? 0);
          existing.costUsd += cost;
          if (r.agent) existing.agents.add(r.agent as string);
          if (r.model) existing.models.add(r.model as string);
          if (r.created_at) existing.lastCallAt = r.created_at as Date;
        } else {
          byTask.set(tid, {
            calls: 1, inputTokens: inp, outputTokens: out,
            durationMs: Number(r.duration_ms ?? 0), costUsd: cost,
            agents: new Set(r.agent ? [r.agent as string] : []),
            models: new Set(r.model ? [r.model as string] : []),
            lastCallAt: r.created_at as Date | null,
          });
        }
      }
      const rows = Array.from(byTask.entries()).map(([tid, v]) => ({
        taskId:           tid,
        calls:            v.calls,
        inputTokens:      v.inputTokens,
        outputTokens:     v.outputTokens,
        totalTokens:      v.inputTokens + v.outputTokens,
        durationMs:       v.durationMs,
        agents:           Array.from(v.agents),
        models:           Array.from(v.models),
        estimatedCostUsd: parseFloat(v.costUsd.toFixed(4)),
        lastCallAt:       v.lastCallAt?.toISOString() ?? null,
      }));
      return reply.send(rows);
    } finally {
      client.release();
    }
  });

  // GET /api/projects/:id/task-metrics/detail — log completo por chamada (task + round + modelo + tokens + custo)
  app.get<{ Params: { id: string } }>("/api/projects/:id/task-metrics/detail", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const row = (await client.query("SELECT id, tenant_id, created_by FROM projects WHERE id=$1", [id])).rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      const res = await client.query(
        `SELECT
           id,
           agent,
           COALESCE(task_id, '(planejamento)') AS task_id,
           round,
           input_tokens,
           output_tokens,
           (input_tokens + output_tokens)       AS total_tokens,
           model,
           duration_ms,
           status,
           created_at
         FROM project_agent_metrics
         WHERE project_id = $1
         ORDER BY created_at`,
        [id]
      );
      const PRICE_INPUT  = 3;   // USD/MTok Sonnet 4.6
      const PRICE_OUTPUT = 15;  // USD/MTok
      const PRICE_INPUT_OPUS  = 15;  // USD/MTok Opus 4.7
      const PRICE_OUTPUT_OPUS = 75;  // USD/MTok
      const rows = res.rows.map((r) => {
        const inp = Number(r.input_tokens ?? 0);
        const out = Number(r.output_tokens ?? 0);
        const isOpus = String(r.model ?? "").includes("opus");
        const pi = isOpus ? PRICE_INPUT_OPUS  : PRICE_INPUT;
        const po = isOpus ? PRICE_OUTPUT_OPUS : PRICE_OUTPUT;
        const cost = (inp / 1_000_000) * pi + (out / 1_000_000) * po;
        return {
          id:               r.id as string,
          agent:            r.agent as string,
          taskId:           r.task_id as string,
          round:            Number(r.round ?? 1),
          inputTokens:      inp,
          outputTokens:     out,
          totalTokens:      inp + out,
          model:            r.model as string | null,
          isOpus:           isOpus,
          durationMs:       Number(r.duration_ms ?? 0),
          durationSec:      Math.round(Number(r.duration_ms ?? 0) / 1000),
          status:           r.status as string | null,
          estimatedCostUsd: parseFloat(cost.toFixed(5)),
          createdAt:        (r.created_at as Date)?.toISOString(),
        };
      });
      // Totais cumulativos
      const cumulative = rows.reduce((acc, r) => ({
        totalCalls:    acc.totalCalls + 1,
        totalTokens:   acc.totalTokens + r.totalTokens,
        totalCostUsd:  acc.totalCostUsd + r.estimatedCostUsd,
        totalDurationMs: acc.totalDurationMs + r.durationMs,
      }), { totalCalls: 0, totalTokens: 0, totalCostUsd: 0, totalDurationMs: 0 });
      return reply.send({
        rows,
        totals: {
          calls:       cumulative.totalCalls,
          tokens:      cumulative.totalTokens,
          costUsd:     parseFloat(cumulative.totalCostUsd.toFixed(4)),
          durationSec: Math.round(cumulative.totalDurationMs / 1000),
        },
      });
    } finally {
      client.release();
    }
  });

  // GET /api/projects/:id/knowledge — lista knowledge entries extraídas pelo G46
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/knowledge",
    async (request, reply) => {
      const { id } = request.params;
      const root = process.env.PROJECT_FILES_ROOT?.trim();
      if (!root) return reply.send({ patterns: [], status: "no_root" });
      const entryPath = path.join(root, id, "docs", "knowledge_entry.json");
      try {
        const content = await readFile(entryPath, "utf-8");
        return reply.send(JSON.parse(content));
      } catch {
        // Also check dialogue entries for knowledge.extracted events
        const client = await pool.connect();
        try {
          const res = await client.query(
            `SELECT summary_human, created_at FROM dialogue_entries
             WHERE project_id = $1 AND event_type = 'knowledge.extracted'
             ORDER BY created_at DESC LIMIT 1`,
            [id]
          );
          if (res.rows.length > 0) {
            return reply.send({ status: "pending_review", summary: res.rows[0].summary_human, extracted_at: res.rows[0].created_at });
          }
          return reply.send({ patterns: [], status: "none" });
        } finally { client.release(); }
      }
    }
  );

  // GET /api/projects/:id/doc-content?path=docs/pm/backend/BACKLOG.md — conteúdo de doc gerado por agente
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/projects/:id/doc-content",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const filePath = (request.query as { path?: string }).path?.trim();
      if (!filePath) return reply.status(400).send({ code: "BAD_REQUEST", message: "path obrigatório" });
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
        // Serve from project root (docs/, project/) — NOT restricted to apps/
        const fullPath = path.join(root, id, filePath);
        const projectBase = path.join(root, id);
        if (!fullPath.startsWith(projectBase)) {
          return reply.status(400).send({ code: "BAD_REQUEST", message: "Path fora do diretório do projeto" });
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

  // POST /api/projects/:id/deploy/ephemeral — lança ambiente efêmero de 30min
  app.post<{ Params: { id: string }; Body: { ttlMinutes?: number } }>(
    "/api/projects/:id/deploy/ephemeral",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const ttlMinutes = Math.min((request.body as { ttlMinutes?: number })?.ttlMinutes ?? 30, 60);

      const client = await pool.connect();
      try {
        const row = (await client.query("SELECT id, tenant_id, created_by, status FROM projects WHERE id=$1", [id])).rows[0];
        if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        if (!["completed", "accepted"].includes(row.status as string)) {
          return reply.status(409).send({ code: "CONFLICT", message: "Deploy efêmero só disponível para projetos concluídos ou aceitos" });
        }
      } finally {
        client.release();
      }

      try {
        const result = await deployEphemeral(id, ttlMinutes);
        return reply.status(202).send(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ code: "DEPLOY_ERROR", message: msg });
      }
    }
  );

  // POST /api/projects/:id/deploy/ephemeral/:deploymentId/destroy
  app.post<{ Params: { id: string; deploymentId: string } }>(
    "/api/projects/:id/deploy/ephemeral/:deploymentId/destroy",
    async (request, reply) => {
      const user = getUser(request);
      const { id, deploymentId } = request.params;
      const client = await pool.connect();
      try {
        const row = (await client.query("SELECT tenant_id, created_by FROM projects WHERE id=$1", [id])).rows[0];
        if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }
      } finally {
        client.release();
      }
      await destroyDeployment(deploymentId);
      return reply.send({ ok: true });
    }
  );

  // GET /api/projects/:id/deploy/ephemeral/active
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/deploy/ephemeral/active",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const client = await pool.connect();
      try {
        const row = (await client.query("SELECT tenant_id, created_by FROM projects WHERE id=$1", [id])).rows[0];
        if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        const dep = (await client.query(
          `SELECT id, provider, app_url, status, expires_at, ttl_minutes, created_at
           FROM ephemeral_deployments
           WHERE project_id=$1 AND status IN ('provisioning','running')
           ORDER BY created_at DESC LIMIT 1`,
          [id],
        )).rows[0];
        return reply.send({ deployment: dep ?? null });
      } finally {
        client.release();
      }
    }
  );

  // POST /api/projects/:id/runs — runner registra início/fim de execução do pipeline
  app.post<{
    Params: { id: string };
    Body: {
      run_id: string;
      request_id?: string;
      trigger?: string;
      action: "start" | "stop";
      stop_reason?: string;
      duration_sec?: number;
      input_tokens?: number;
      output_tokens?: number;
      estimated_cost_usd?: number;
    };
  }>("/api/projects/:id/runs", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const body = request.body ?? {} as Record<string, unknown>;
    const client = await pool.connect();
    try {
      const hasAccess = await checkProjectAccess(client, id, user);
      if (!hasAccess) return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });

      if (body.action === "start") {
        await client.query(
          `INSERT INTO pipeline_runs (project_id, run_id, request_id, trigger, started_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (project_id, run_id) DO NOTHING`,
          [id, String(body.run_id), body.request_id ?? null, body.trigger ?? "api"]
        );
        // Incrementa run_count no projeto
        await client.query(
          `UPDATE projects SET run_count = run_count + 1, updated_at = now() WHERE id = $1`,
          [id]
        );
        return reply.status(201).send({ ok: true, action: "start", run_id: body.run_id });
      }

      if (body.action === "stop") {
        // Se o runner não enviou tokens, buscar o total acumulado em project_agent_metrics
        let inputTokens = Number(body.input_tokens ?? 0);
        let outputTokens = Number(body.output_tokens ?? 0);
        if (inputTokens === 0 && outputTokens === 0) {
          const metricsRow = await client.query(
            `SELECT COALESCE(SUM(input_tokens),0)::int AS total_input,
                    COALESCE(SUM(output_tokens),0)::int AS total_output
             FROM project_agent_metrics WHERE project_id = $1`,
            [id]
          );
          inputTokens  = metricsRow.rows[0]?.total_input  ?? 0;
          outputTokens = metricsRow.rows[0]?.total_output ?? 0;
        }
        const costUsd = body.estimated_cost_usd != null
          ? Number(body.estimated_cost_usd)
          : parseFloat(((inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15).toFixed(6));

        await client.query(
          `UPDATE pipeline_runs
           SET finished_at = now(),
               stop_reason = $1,
               duration_sec = $2,
               input_tokens = $3,
               output_tokens = $4,
               estimated_cost_usd = $5
           WHERE project_id = $6 AND run_id = $7`,
          [body.stop_reason ?? "completed", body.duration_sec ?? null, inputTokens, outputTokens, costUsd, id, String(body.run_id)]
        );
        // Acumula duração total e marca finished_at no projeto
        await client.query(
          `UPDATE projects
           SET total_duration_sec = total_duration_sec + COALESCE($1, 0),
               finished_at = now(),
               updated_at = now()
           WHERE id = $2`,
          [body.duration_sec ?? 0, id]
        );
        return reply.send({ ok: true, action: "stop", run_id: body.run_id });
      }

      return reply.status(400).send({ code: "BAD_REQUEST", message: "action deve ser 'start' ou 'stop'" });
    } finally {
      client.release();
    }
  });

  // GET /api/projects/:id/runs — histórico de execuções do pipeline
  app.get<{ Params: { id: string } }>("/api/projects/:id/runs", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const hasAccess = await checkProjectAccess(client, id, user);
      if (!hasAccess) return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });

      const runs = await client.query(
        `SELECT run_id, request_id, trigger, started_at, finished_at, duration_sec,
                stop_reason, input_tokens, output_tokens, estimated_cost_usd, created_at
         FROM pipeline_runs
         WHERE project_id = $1
         ORDER BY started_at ASC`,
        [id]
      );

      const proj = await client.query(
        `SELECT run_count, total_duration_sec, complexity_hint, started_at, finished_at
         FROM projects WHERE id = $1`,
        [id]
      );
      const p = proj.rows[0] as Record<string, unknown> | undefined;

      return reply.send({
        runs: runs.rows,
        summary: {
          run_count: p?.run_count ?? 0,
          total_duration_sec: p?.total_duration_sec ?? 0,
          complexity_hint: p?.complexity_hint ?? null,
          project_started_at: p?.started_at ?? null,
          project_finished_at: p?.finished_at ?? null,
        },
      });
    } finally {
      client.release();
    }
  });

  // DELETE /api/projects/:id?keepFiles=true — exclui projeto do banco (keepFiles=true mantém disco)
  // keepFiles=false (default): remove banco + arquivos do disco
  app.delete<{ Params: { id: string }; Querystring: { keepFiles?: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const keepFiles = (request.query as { keepFiles?: string }).keepFiles === "true";
      const client = await pool.connect();
      try {
        const proj = await client.query(
          "SELECT id, tenant_id, created_by, status, title FROM projects WHERE id = $1", [id]
        );
        const row = proj.rows[0];
        if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        // Permitir excluir qualquer projeto que não está em execução ativa
        if (row.status === "running") {
          return reply.status(409).send({
            code: "CONFLICT",
            message: "Pare o pipeline antes de excluir. Use Interromper Imediatamente no menu Ações.",
          });
        }
        // Deletar do banco (ON DELETE CASCADE cuida das tabelas filhas)
        await client.query("DELETE FROM projects WHERE id = $1", [id]);
        // Deletar arquivos do disco se keepFiles=false
        if (!keepFiles) {
          const root = process.env.PROJECT_FILES_ROOT?.trim();
          if (root) {
            try {
              const { rm } = await import("fs/promises");
              await rm(`${root}/${id}`, { recursive: true, force: true });
            } catch (fsErr) {
              request.log.warn({ fsErr }, "Falha ao remover arquivos do disco para projeto " + id);
            }
          }
        }
        return reply.send({
          ok: true,
          projectId: id,
          filesDeleted: !keepFiles,
          message: keepFiles
            ? "Projeto removido do banco. Arquivos em disco mantidos."
            : "Projeto e arquivos removidos completamente.",
        });
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

  // GET /api/projects/:id/spec-content — retorna markdown da spec atual do projeto
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/spec-content",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const client = await pool.connect();
      try {
        const row = (await client.query(
          "SELECT p.id, p.tenant_id, p.created_by, p.title FROM projects p WHERE p.id = $1",
          [id]
        )).rows[0];
        if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        const specRow = (await client.query(
          "SELECT file_path, filename FROM project_spec_files WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
          [id]
        )).rows[0];
        if (!specRow?.file_path) {
          return reply.status(404).send({ code: "NOT_FOUND", message: "Spec não encontrada para este projeto" });
        }
        try {
          const content = await readFile(specRow.file_path, "utf-8");
          return reply.send({ specMarkdown: content, filename: specRow.filename, projectId: id, title: row.title });
        } catch {
          return reply.status(404).send({ code: "NOT_FOUND", message: "Arquivo de spec não encontrado no disco" });
        }
      } finally {
        client.release();
      }
    }
  );

  // PATCH /api/projects/:id/spec-content — atualiza spec existente (sem criar novo projeto)
  app.patch<{ Params: { id: string }; Body: { specMarkdown: string; title?: string; startNow?: boolean } }>(
    "/api/projects/:id/spec-content",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const { specMarkdown, title, startNow } = request.body ?? {};
      if (!specMarkdown || typeof specMarkdown !== "string" || !specMarkdown.trim()) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "specMarkdown obrigatório" });
      }
      const client = await pool.connect();
      try {
        const row = (await client.query(
          "SELECT p.id, p.tenant_id, p.created_by, p.status FROM projects p WHERE p.id = $1",
          [id]
        )).rows[0];
        if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        const specRow = (await client.query(
          "SELECT file_path, filename FROM project_spec_files WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
          [id]
        )).rows[0];
        if (!specRow?.file_path) {
          return reply.status(404).send({ code: "NOT_FOUND", message: "Spec não encontrada para este projeto" });
        }
        await writeFile(specRow.file_path, specMarkdown, "utf-8");
        if (title?.trim()) {
          await client.query("UPDATE projects SET title = $1, updated_at = NOW() WHERE id = $2", [title.trim(), id]);
        }
        if (startNow) {
          // Dispara runner via spawn (fire-and-forget) — mesmo padrão do POST /run
          const { spawn } = await import("child_process");
          const runnerPath = process.env.RUNNER_PATH ?? "/app/runner/runner.py";
          const python = process.env.PYTHON_BIN ?? "python3";
          const child = spawn(python, [runnerPath, id], { detached: true, stdio: "ignore" });
          child.unref();
          await client.query("UPDATE projects SET status = 'running', updated_at = NOW() WHERE id = $1", [id]);
        }
        return reply.send({ ok: true, projectId: id });
      } finally {
        client.release();
      }
    }
  );

  // POST /api/projects/:id/evolve — cria projeto filho de evolução a partir de projeto aceito
  // Body: { request: string (texto livre) | undefined, workMode: "copy" | "branch" }
  // O arquivo de spec pode ser enviado separadamente via multipart (projeto filho terá spec_ref próprio)
  app.post<{
    Params: { id: string };
    Body: { request?: string; workMode?: "copy" | "branch" };
  }>("/api/projects/:id/evolve", async (request, reply) => {
    const user = getUser(request);
    const { id: parentId } = request.params;
    const evolutionRequest = request.body?.request?.trim() ?? "";
    const workMode: "copy" | "branch" = request.body?.workMode === "branch" ? "branch" : "copy";

    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, parentId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

      const parentRow = (await client.query(
        "SELECT id, title, status, product_id, tenant_id, created_by, version_number, complexity_hint FROM projects WHERE id = $1",
        [parentId]
      )).rows[0] as Record<string, unknown> | undefined;

      if (!parentRow) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto pai não encontrado" });
      if (parentRow.status !== "accepted") {
        return reply.status(409).send({
          code: "CONFLICT",
          message: `Evolução só permitida em projetos aceitos. Status atual: ${parentRow.status}`,
        });
      }
      if (!evolutionRequest) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Campo 'request' é obrigatório (descreva o que evoluir)." });
      }

      const nextVersion = ((parentRow.version_number as number) ?? 1) + 1;
      const childTitle  = `${parentRow.title} — Evolução v${nextVersion}`;

      // Criar projeto filho
      const childRes = await client.query(
        `INSERT INTO projects
           (tenant_id, created_by, title, status, product_id, parent_project_id, version_number,
            extra, complexity_hint, updated_at)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7::jsonb, $8, now())
         RETURNING id`,
        [
          parentRow.tenant_id,
          user.id,
          childTitle,
          parentRow.product_id ?? null,
          parentId,
          nextVersion,
          JSON.stringify({
            evolution: true,
            evolution_request: evolutionRequest,
            evolution_work_mode: workMode,
            evolution_parent_id: parentId,
          }),
          parentRow.complexity_hint ?? null,
        ]
      );
      const childId = childRes.rows[0]?.id as string;

      // Copiar spec original do pai como ponto de partida do filho
      const parentSpecRow = (await client.query(
        "SELECT file_path, filename FROM project_spec_files WHERE project_id = $1 ORDER BY created_at ASC LIMIT 1",
        [parentId]
      )).rows[0] as Record<string, unknown> | undefined;

      if (parentSpecRow?.file_path) {
        try {
          const { readFileSync, existsSync } = await import("fs");
          const { join, dirname } = await import("path");
          const { mkdirSync, writeFileSync } = await import("fs");
          const uploadDir  = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
          const parentSpec = String(parentSpecRow.file_path);
          if (existsSync(parentSpec)) {
            const originalContent = readFileSync(parentSpec, "utf-8");
            // Prefixar spec com instrução de evolução
            const evolutionHeader = `# EVOLUTION REQUEST — v${nextVersion}\n\n> ${evolutionRequest}\n\n---\n\n`;
            const evolvedContent  = evolutionHeader + originalContent;
            const childSpecDir    = join(uploadDir, childId);
            mkdirSync(childSpecDir, { recursive: true });
            const childSpecPath   = join(childSpecDir, `spec-evolution-v${nextVersion}.md`);
            writeFileSync(childSpecPath, evolvedContent, "utf-8");
            await client.query(
              `INSERT INTO project_spec_files (project_id, filename, file_path)
               VALUES ($1, $2, $3)`,
              [childId, `spec-evolution-v${nextVersion}.md`, childSpecPath]
            );
            await client.query(
              "UPDATE projects SET status = 'spec_submitted', updated_at = now() WHERE id = $1",
              [childId]
            );
          }
        } catch (err) {
          request.log.warn({ err, childId }, "[evolve] Falha ao copiar spec do pai — filho permanece em draft");
        }
      }

      // Postar no diálogo do filho
      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
         VALUES ($1, 'system', 'system', 'step', $2)`,
        [childId, `🔄 Evolução v${nextVersion} criada a partir de "${parentRow.title}". Modo: ${workMode}. Pedido: "${evolutionRequest}"`]
      );

      request.log.info({ parentId, childId, version: nextVersion, workMode }, "[evolve] Projeto filho criado");

      return reply.status(201).send({
        ok: true,
        childProjectId: childId,
        parentProjectId: parentId,
        versionNumber: nextVersion,
        workMode,
        title: childTitle,
        message: "Projeto de evolução criado. Envie ao pipeline via POST /run quando estiver pronto.",
      });
    } finally {
      client.release();
    }
  });
}
