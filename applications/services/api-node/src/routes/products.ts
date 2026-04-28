/**
 * products.ts — CRUD de Produtos (grupos de projetos) + links entre projetos.
 *
 * GET    /api/products                           — listar produtos do tenant
 * POST   /api/products                           — criar produto
 * GET    /api/products/:id                       — detalhe + projetos do produto
 * PATCH  /api/products/:id                       — atualizar nome/descrição
 * DELETE /api/products/:id                       — arquivar produto
 *
 * POST   /api/products/:id/projects/:projectId   — adicionar projeto ao produto
 * DELETE /api/products/:id/projects/:projectId   — remover projeto do produto
 *
 * GET    /api/projects/:id/links                 — listar links de um projeto
 * POST   /api/projects/:id/links                 — criar link entre projetos
 * DELETE /api/projects/:id/links/:linkId         — remover link
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(r: FastifyRequest): AuthUser {
  return (r as unknown as { user: AuthUser }).user;
}

const RELATION_TYPES = ["uses_backend","shares_auth","shares_db","depends_on","related","part_of"] as const;
type RelationType = typeof RELATION_TYPES[number];

const RELATION_LABELS: Record<RelationType, string> = {
  uses_backend: "Consome backend",
  shares_auth:  "Compartilha autenticação",
  shares_db:    "Compartilha banco de dados",
  depends_on:   "Depende de",
  related:      "Relacionado",
  part_of:      "Componente de",
};

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/products ────────────────────────────────────────────────────────
  app.get("/api/products", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.send([]);
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT p.id, p.name, p.description, p.status, p.created_at,
                COUNT(proj.id)::int AS project_count
         FROM products p
         LEFT JOIN projects proj ON proj.product_id = p.id
         WHERE p.tenant_id = $1 AND p.status = 'active'
         GROUP BY p.id ORDER BY p.created_at DESC`,
        [user.tenantId]
      );
      return reply.send(res.rows);
    } finally { client.release(); }
  });

  // ── POST /api/products ───────────────────────────────────────────────────────
  app.post("/api/products", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN" });
    const { name, description } = request.body as Record<string, string>;
    if (!name?.trim()) return reply.status(400).send({ code: "BAD_REQUEST", message: "name obrigatório" });
    const client = await pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO products (tenant_id, created_by, name, description)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [user.tenantId, user.id, name.trim(), description?.trim() ?? null]
      );
      return reply.status(201).send(res.rows[0]);
    } finally { client.release(); }
  });

  // ── GET /api/products/:id ────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/products/:id", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const prod = await client.query(
        "SELECT * FROM products WHERE id = $1 AND tenant_id = $2",
        [id, user.tenantId ?? ""]
      );
      if (!prod.rows[0]) return reply.status(404).send({ code: "NOT_FOUND" });

      const projects = await client.query(
        `SELECT id, title, status, version_number, extra->>'project_type' AS project_type,
                started_at, completed_at, updated_at
         FROM projects WHERE product_id = $1 ORDER BY created_at ASC`,
        [id]
      );
      return reply.send({ ...prod.rows[0], projects: projects.rows });
    } finally { client.release(); }
  });

  // ── PATCH /api/products/:id ──────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>("/api/products/:id", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const { name, description, status } = request.body as Record<string, string>;
    const client = await pool.connect();
    try {
      const res = await client.query(
        `UPDATE products SET
           name        = COALESCE($1, name),
           description = COALESCE($2, description),
           status      = COALESCE($3, status),
           updated_at  = NOW()
         WHERE id = $4 AND tenant_id = $5 RETURNING *`,
        [name?.trim() ?? null, description?.trim() ?? null, status ?? null, id, user.tenantId ?? ""]
      );
      if (!res.rows[0]) return reply.status(404).send({ code: "NOT_FOUND" });
      return reply.send(res.rows[0]);
    } finally { client.release(); }
  });

  // ── POST /api/products/:id/projects/:projectId ───────────────────────────────
  app.post<{ Params: { id: string; projectId: string } }>(
    "/api/products/:id/projects/:projectId",
    async (request, reply) => {
      const user = getUser(request);
      const { id: productId, projectId } = request.params;
      const client = await pool.connect();
      try {
        // verify product belongs to tenant
        const prod = await client.query("SELECT id FROM products WHERE id=$1 AND tenant_id=$2", [productId, user.tenantId ?? ""]);
        if (!prod.rows[0]) return reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
        await client.query(
          "UPDATE projects SET product_id=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3",
          [productId, projectId, user.tenantId ?? ""]
        );
        return reply.send({ ok: true });
      } finally { client.release(); }
    }
  );

  // ── DELETE /api/products/:id/projects/:projectId ─────────────────────────────
  app.delete<{ Params: { id: string; projectId: string } }>(
    "/api/products/:id/projects/:projectId",
    async (request, reply) => {
      const user = getUser(request);
      const { projectId } = request.params;
      const client = await pool.connect();
      try {
        await client.query(
          "UPDATE projects SET product_id=NULL, updated_at=NOW() WHERE id=$1 AND tenant_id=$2",
          [projectId, user.tenantId ?? ""]
        );
        return reply.send({ ok: true });
      } finally { client.release(); }
    }
  );

  // ── GET /api/projects/:id/links ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/projects/:id/links", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT pl.id, pl.relation_type, pl.note, pl.created_at,
                pl.from_project_id, pl.to_project_id,
                pf.title AS from_title, pf.status AS from_status,
                pf.extra->>'project_type' AS from_project_type,
                pt.title AS to_title,   pt.status AS to_status,
                pt.extra->>'project_type' AS to_project_type
         FROM project_links pl
         JOIN projects pf ON pf.id = pl.from_project_id
         JOIN projects pt ON pt.id = pl.to_project_id
         WHERE (pl.from_project_id = $1 OR pl.to_project_id = $1)
           AND (pf.tenant_id = $2 OR pt.tenant_id = $2)
         ORDER BY pl.created_at DESC`,
        [id, user.tenantId ?? ""]
      );
      return reply.send(res.rows.map(r => ({
        ...r,
        relation_label: RELATION_LABELS[r.relation_type as RelationType] ?? r.relation_type,
        direction: r.from_project_id === id ? "outgoing" : "incoming",
      })));
    } finally { client.release(); }
  });

  // ── POST /api/projects/:id/links ──────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/projects/:id/links", async (request, reply) => {
    const user = getUser(request);
    const { id: fromId } = request.params;
    const { to_project_id, relation_type = "related", note } = request.body as Record<string, string>;
    if (!to_project_id) return reply.status(400).send({ code: "BAD_REQUEST", message: "to_project_id obrigatório" });
    if (!RELATION_TYPES.includes(relation_type as RelationType)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: `relation_type inválido. Permitidos: ${RELATION_TYPES.join(", ")}` });
    }
    const client = await pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO project_links (from_project_id, to_project_id, relation_type, note)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (from_project_id, to_project_id) DO UPDATE
           SET relation_type=$3, note=$4
         RETURNING *`,
        [fromId, to_project_id, relation_type, note?.trim() ?? null]
      );
      return reply.status(201).send(res.rows[0]);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("project_links_no_self")) return reply.status(400).send({ code: "BAD_REQUEST", message: "Não é possível linkar um projeto a si mesmo" });
      throw e;
    } finally { client.release(); }
  });

  // ── DELETE /api/projects/:id/links/:linkId ────────────────────────────────────
  app.delete<{ Params: { id: string; linkId: string } }>(
    "/api/projects/:id/links/:linkId",
    async (request, reply) => {
      const { linkId } = request.params;
      const client = await pool.connect();
      try {
        await client.query("DELETE FROM project_links WHERE id=$1", [linkId]);
        return reply.send({ ok: true });
      } finally { client.release(); }
    }
  );
}
