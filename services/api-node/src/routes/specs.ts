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

export async function specRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post("/api/specs", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório para enviar spec" });
    }

    let title = "Spec sem título";
    const files: { filename: string; buffer: Buffer; mimeType: string }[] = [];
    let part: { filename?: string; fieldname?: string; mimetype: string; toBuffer(): Promise<Buffer>; value?: string } | undefined;
    const req = request as unknown as { file: () => Promise<typeof part> };
    while ((part = await req.file()) !== undefined) {
      if (part.filename) {
        if (!isAllowed(part.filename)) {
          return reply.status(400).send({
            code: "BAD_REQUEST",
            message: "Formatos aceitos: .md, .txt, .doc, .docx, .pdf",
          });
        }
        const buffer = await part.toBuffer();
        files.push({ filename: part.filename, buffer, mimeType: part.mimetype });
      } else {
        const raw = (part as unknown as { value?: string }).value;
        if (typeof raw === "string" && part.fieldname === "title") title = raw.trim() || title;
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

      const projectResult = await client.query(
        `INSERT INTO projects (tenant_id, created_by, title, spec_ref, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, user.id, title, files[0].filename, "spec_submitted"]
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
