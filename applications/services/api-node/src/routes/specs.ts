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

// ── Message envelope builder for CTO spec_intake_and_normalize ───────────────
function buildCTOMessage(freeText: string, title?: string): Record<string, unknown> {
  const requestId = `spec-preview-${Date.now()}`;
  return {
    project_id: "spec_preview",
    agent: "CTO",
    variant: "generic",
    mode: "spec_intake_and_normalize",
    request_id: requestId,
    task_id: null,
    task: "Converter texto livre em PRODUCT_SPEC.md padronizado.",
    inputs: {
      spec_raw: freeText,
      product_spec: freeText,
      title: title ?? "Spec sem título",
      constraints: ["spec-driven", "no-invent"],
    },
    existing_artifacts: [],
    limits: { max_rounds: 1, timeout_sec: 120 },
  };
}

export async function specRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // POST /api/spec-preview — CTO generates a standardized spec from free text (no project created)
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

      const message = buildCTOMessage(freeText, body.title);

      try {
        const res = await fetch(`${agentsUrl.replace(/\/$/, "")}/invoke/cto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(130_000), // 130s (CTO pode demorar)
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          return reply.status(502).send({ code: "AGENT_ERROR", message: `Agente CTO retornou ${res.status}: ${txt.slice(0, 200)}` });
        }

        const data = await res.json() as Record<string, unknown>;
        const status = data.status as string ?? "?";

        // Extract spec markdown from artifacts
        const artifacts = (data.artifacts as Array<Record<string, unknown>>) ?? [];
        const specArtifact = artifacts.find((a) =>
          typeof a.path === "string" && (a.path.endsWith(".md") || a.path.includes("PRODUCT_SPEC"))
        );
        const specMarkdown: string = (specArtifact?.content as string | undefined)
          ?? (data.summary as string | undefined)
          ?? "# Spec gerada\n\nO CTO não retornou conteúdo válido. Tente novamente.";

        return reply.send({
          specMarkdown,
          summary: data.summary ?? "",
          status,
          requestId: data.request_id ?? message.request_id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timeout") || msg.includes("abort")) {
          return reply.status(504).send({ code: "TIMEOUT", message: "O CTO demorou demais para responder. Tente novamente." });
        }
        return reply.status(502).send({ code: "AGENT_ERROR", message: msg.slice(0, 300) });
      }
    }
  );

  app.post("/api/specs", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório para enviar spec" });
    }

    let title = "Spec sem título";
    let parentProjectId: string | null = null;
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

      const projectResult = await client.query(
        `INSERT INTO projects (tenant_id, created_by, title, spec_ref, status, parent_project_id, version_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [tenantId, user.id, title, files[0].filename, "spec_submitted", rootParentId, versionNumber]
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
