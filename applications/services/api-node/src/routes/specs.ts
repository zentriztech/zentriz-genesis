import type { FastifyInstance, FastifyRequest } from "fastify";
import path from "path";
import fs from "fs/promises";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");
const ALLOWED_EXT = new Set([".md", ".txt", ".doc", ".docx", ".pdf"]);

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

function isAllowed(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXT.has(ext);
}

// ── Message envelope builder — spec from free description (leigo → spec completa) ──
function buildCTOMessage(freeText: string, title?: string): Record<string, unknown> {
  const requestId = `spec-preview-${Date.now()}`;

  // Enriched task instruction: explain that the input is free text from a non-technical user
  // and the CTO must act as a senior product consultant — inferring, completing, and enriching
  const taskInstruction = `
Você está recebendo a DESCRIÇÃO LIVRE de um produto feita por uma pessoa leiga, não-técnica.
Seu papel neste modo é diferente do spec_intake_and_normalize normal:

OBJETIVO: Gerar uma spec COMPLETA e RICA baseada na intenção do usuário, como um CTO sênior
e consultor de produto experiente faria após uma conversa de discovery.

REGRAS PARA ESTE MODO:
1. INFIRA tudo que não foi dito mas é necessário para o produto funcionar.
   Ex: se pediram "sistema de agendamento", inclua: autenticação, perfis, notificações, conflito de horários.
2. USE seu conhecimento de domínio para enriquecer — não invente features novas, mas COMPLETE as implícitas.
3. ESCOLHA a stack tecnológica mais adequada baseada no que foi descrito (mobile? web? backend? ambos?).
4. ESCREVA cada FR com critérios de aceite detalhados (DADO/QUANDO/ENTÃO).
5. INCLUA personas reais com jornadas de uso.
6. DEFINA o modelo de dados com tabelas e campos principais.
7. SEJA CONCRETO — sem "TBD" ou "UNKNOWN" em itens que você pode inferir do contexto.
8. A spec deve ser rica o suficiente para que um engenheiro possa implementar sem perguntas adicionais.

Descrição do usuário: "${freeText.replace(/"/g, '\\"')}"
`.trim();

  return {
    project_id: "spec_preview",
    agent: "CTO",
    variant: "generic",
    mode: "spec_intake_and_normalize",
    request_id: requestId,
    task_id: null,
    task: taskInstruction,
    inputs: {
      spec_raw: freeText,
      product_spec: freeText,
      title: title ?? "Produto descrito pelo usuário",
      // "enrich-from-context" tells CTO to use domain knowledge to fill gaps
      constraints: ["enrich-from-context", "use-domain-knowledge", "complete-implicit-requirements"],
      // Extra context: signal that this is a free-text input from a non-technical user
      input_type: "free_description",
      user_is_non_technical: true,
    },
    existing_artifacts: [],
    limits: { max_rounds: 1, timeout_sec: 120 },
  };
}

// ── In-memory job store for spec-preview (no DB needed — jobs are transient) ──
type JobStatus = "pending" | "running" | "done" | "error";
interface SpecJob {
  id: string;
  status: JobStatus;
  specMarkdown?: string;
  summary?: string;
  error?: string;
  createdAt: number;
}
const _specJobs = new Map<string, SpecJob>();

// Clean up jobs older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of _specJobs) {
    if (job.createdAt < cutoff) _specJobs.delete(id);
  }
}, 5 * 60_000);

function extractSpecMarkdown(data: Record<string, unknown>): string {
  const artifacts = (data.artifacts as Array<Record<string, unknown>>) ?? [];
  const artifact = artifacts.find((a) =>
    typeof a.path === "string" && (a.path.endsWith(".md") || a.path.includes("PRODUCT_SPEC") || a.path.includes("spec"))
  );
  return (artifact?.content as string | undefined)
    ?? (data.summary as string | undefined)
    ?? "# Spec gerada\n\nO CTO não retornou conteúdo válido. Tente novamente.";
}

/**
 * HTTP POST using Node.js built-in http/https modules.
 * Avoids the AbortController/AbortSignal bug in Node.js 20 where long-lived
 * fetch() connections inside Docker get aborted prematurely even with large timeouts.
 * This function has a plain socket-level timeout (600s) with no AbortController.
 */
async function httpPost(urlStr: string, body: string, timeoutMs = 600_000): Promise<string> {
  const url = new URL(urlStr);
  const { request } = url.protocol === "https:"
    ? await import("https")
    : await import("http");
  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) resolve(text);
        else reject(new Error(`HTTP ${code}: ${text.slice(0, 200)}`));
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`HTTP request timed out after ${timeoutMs / 1000}s`)); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function runSpecJob(jobId: string, message: Record<string, unknown>, agentsUrl: string): Promise<void> {
  const job = _specJobs.get(jobId);
  if (!job) return;
  job.status = "running";

  try {
    const url = `${agentsUrl.replace(/\/$/, "")}/invoke/cto`;
    const body = JSON.stringify(message);
    // Use native http module — avoids Node 20 AbortController bug with long-lived Docker connections
    const text = await httpPost(url, body, 600_000); // 10 min hard limit
    const data = JSON.parse(text) as Record<string, unknown>;
    job.specMarkdown = extractSpecMarkdown(data);
    job.summary = (data.summary as string | undefined) ?? "";
    job.status = "done";
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
  }
}

export async function specRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // POST /api/spec-preview — enqueue CTO job, return jobId immediately
  app.post<{ Body: { freeText: string; title?: string } }>(
    "/api/spec-preview",
    async (request, reply) => {
      const body = request.body ?? {} as { freeText?: string; title?: string };
      const freeText = (body.freeText ?? "").trim();
      if (!freeText || freeText.length < 20) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Descreva o produto com pelo menos 20 caracteres" });
      }

      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) {
        return reply.status(503).send({ code: "SERVICE_UNAVAILABLE", message: "Serviço de agentes não configurado" });
      }

      const jobId = `spj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const job: SpecJob = { id: jobId, status: "pending", createdAt: Date.now() };
      _specJobs.set(jobId, job);

      const message = buildCTOMessage(freeText, body.title);

      // Fire and forget — do NOT await; return jobId immediately
      runSpecJob(jobId, message, agentsUrl).catch(console.error);

      return reply.status(202).send({ jobId, status: "pending" });
    }
  );

  // GET /api/spec-preview/:jobId — poll for job result
  app.get<{ Params: { jobId: string } }>(
    "/api/spec-preview/:jobId",
    async (request, reply) => {
      const { jobId } = request.params;
      const job = _specJobs.get(jobId);
      if (!job) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado ou expirado" });
      }

      if (job.status === "done") {
        return reply.send({
          jobId, status: "done",
          specMarkdown: job.specMarkdown,
          summary: job.summary,
        });
      }
      if (job.status === "error") {
        return reply.send({ jobId, status: "error", error: job.error });
      }
      // still pending or running
      const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
      return reply.send({ jobId, status: job.status, elapsed });
    }
  );

  app.post("/api/specs", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório para enviar spec" });
    }

    let title = "Spec sem título";
    let parentProjectId: string | null = null;
    let freeDescription: string | null = null;
    const files: { filename: string; buffer: Buffer; mimeType: string }[] = [];
    // Em @fastify/multipart v8, req.file() retorna apenas partes do tipo FILE; campos como "title"
    // vêm em part.fields (objeto acumulado pelo busboy). Cada part retornado é MultipartFile com .fields.
    type Part = {
      fieldname: string;
      filename: string;
      mimetype: string;
      toBuffer(): Promise<Buffer>;
      fields?: Record<string, { value?: unknown } | { value?: unknown }[]>;
    };
    const req = request as unknown as { file: () => Promise<Part | undefined> };
    let part: Part | undefined;
    while ((part = await req.file()) !== undefined) {
      if (part.fields?.title !== undefined) {
        const titleField = part.fields.title;
        const v = Array.isArray(titleField) ? titleField[0] : titleField;
        const raw = v && typeof (v as { value?: string }).value === "string"
          ? (v as { value: string }).value.trim()
          : "";
        if (raw) title = raw;
      }
      if (part.fields?.parentProjectId !== undefined) {
        const ppField = part.fields.parentProjectId;
        const v = Array.isArray(ppField) ? ppField[0] : ppField;
        const raw = v && typeof (v as { value?: string }).value === "string"
          ? (v as { value: string }).value.trim()
          : "";
        if (raw) parentProjectId = raw;
      }
      if (part.fields?.freeDescription !== undefined) {
        const fdField = part.fields.freeDescription;
        const v = Array.isArray(fdField) ? fdField[0] : fdField;
        const raw = v && typeof (v as { value?: string }).value === "string"
          ? (v as { value: string }).value.trim()
          : "";
        if (raw) freeDescription = raw;
      }
      if (part.filename) {
        if (!isAllowed(part.filename)) {
          return reply.status(400).send({
            code: "BAD_REQUEST",
            message: "Formatos aceitos: .md, .txt, .doc, .docx, .pdf",
          });
        }
        const buffer = await part.toBuffer();
        files.push({ filename: part.filename, buffer, mimeType: part.mimetype });
      }
    }

    if (files.length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Envie pelo menos um arquivo" });
    }

    const client = await pool.connect();
    let projectId: string;
    try {
      const tenantId =
        user.tenantId ?? (await client.query("SELECT id FROM tenants LIMIT 1")).rows[0]?.id;
      if (!tenantId) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Nenhum tenant disponível" });
      }

      // Compute version_number: find the root project and count existing versions
      let versionNumber = 1;
      let rootParentId: string | null = parentProjectId;
      if (parentProjectId) {
        // Walk up to root if parent is itself a child
        const parentRow = await client.query(
          "SELECT parent_project_id, version_number FROM projects WHERE id = $1",
          [parentProjectId]
        );
        const parent = parentRow.rows[0];
        if (parent?.parent_project_id) {
          rootParentId = parent.parent_project_id as string;
        }
        // Count existing versions in this lineage (root + all children)
        const countRes = await client.query(
          `SELECT COUNT(*) FROM projects
           WHERE id = $1 OR parent_project_id = $1 OR
                 parent_project_id IN (SELECT id FROM projects WHERE parent_project_id = $1)`,
          [rootParentId ?? parentProjectId]
        );
        versionNumber = parseInt(countRes.rows[0].count as string, 10) + 1;
      }

      const extraJson = JSON.stringify({
        ...(freeDescription ? { free_description: freeDescription } : {}),
      });
      const projectResult = await client.query(
        `INSERT INTO projects (tenant_id, created_by, title, spec_ref, status, parent_project_id, version_number, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
        [tenantId, user.id, title, files[0].filename, "spec_submitted", rootParentId, versionNumber, extraJson]
      );
      projectId = projectResult.rows[0].id;
    } finally {
      client.release();
    }

    const projectDir = path.join(UPLOAD_DIR, projectId);
    await fs.mkdir(projectDir, { recursive: true });

    const saved: { filename: string; filePath: string; mimeType: string }[] = [];
    for (const f of files) {
      const safeName = `${Date.now()}-${path.basename(f.filename)}`;
      const filePath = path.join(projectDir, safeName);
      await fs.writeFile(filePath, f.buffer);
      saved.push({ filename: f.filename, filePath, mimeType: f.mimeType });
    }

    const client2 = await pool.connect();
    try {
      for (const f of saved) {
        await client2.query(
          `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type) VALUES ($1, $2, $3, $4)`,
          [projectId, f.filename, f.filePath, f.mimeType]
        );
      }
      const hasNonMd = saved.some((f) => path.extname(f.filename).toLowerCase() !== ".md");
      if (hasNonMd) {
        await client2.query("UPDATE projects SET status = $1, updated_at = now() WHERE id = $2", [
          "pending_conversion",
          projectId,
        ]);
      }
    } finally {
      client2.release();
    }

    return reply.send({
      projectId,
      status: saved.some((f) => path.extname(f.filename).toLowerCase() !== ".md")
        ? "pending_conversion"
        : "spec_submitted",
      message: "Spec(s) recebida(s). O fluxo será iniciado em seguida.",
    });
  });
}
