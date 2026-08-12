/**
 * catalog.ts — Catálogo de tipos de projeto / SPECs pré-prontas (Feature #65, parte 1).
 *
 *   GET  /api/catalog                 — lista o catálogo (filtro opcional ?category=)
 *   GET  /api/catalog/categories      — lista as categorias distintas (para abas/filtros)
 *   POST /api/catalog/:slug/use       — cria uma SPEC (projeto draft) a partir do template
 *
 * A criação reusa a função pura createProjectFromSpec (projectCreation.ts) — NÃO duplica o
 * INSERT. O seed inicial (migração 043) é um STARTER SET honesto e categorizado, extensível
 * rumo a ~1000 tipos apenas inserindo novas linhas em spec_catalog (sem mudança de schema).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { createProjectFromSpec } from "../services/projectCreation.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // GET /api/catalog?category=... — lista itens do catálogo (público entre tenants: é template)
  app.get<{ Querystring: { category?: string } }>("/api/catalog", async (request, reply) => {
    const category = (request.query?.category ?? "").trim();
    const client = await pool.connect();
    try {
      const rows = category
        ? (await client.query(
            `SELECT slug, title, category, description, tags FROM spec_catalog
              WHERE category = $1 ORDER BY title`,
            [category],
          )).rows
        : (await client.query(
            `SELECT slug, title, category, description, tags FROM spec_catalog
              ORDER BY category, title`,
          )).rows;
      return reply.send(rows);
    } finally {
      client.release();
    }
  });

  // GET /api/catalog/categories — categorias distintas com contagem
  app.get("/api/catalog/categories", async (_request, reply) => {
    const client = await pool.connect();
    try {
      const rows = (await client.query(
        `SELECT category, COUNT(*)::int AS count FROM spec_catalog
          GROUP BY category ORDER BY category`,
      )).rows;
      return reply.send(rows);
    } finally {
      client.release();
    }
  });

  // POST /api/catalog/:slug/use — cria uma SPEC (projeto draft) a partir do template
  app.post<{ Params: { slug: string }; Body: { title?: string; productId?: string } }>(
    "/api/catalog/:slug/use",
    async (request, reply) => {
      const user = getUser(request);
      if (!user.tenantId && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });
      }
      const { slug } = request.params;
      const body = request.body ?? {};

      const client = await pool.connect();
      try {
        const tpl = (await client.query(
          "SELECT slug, title, template_markdown FROM spec_catalog WHERE slug = $1",
          [slug],
        )).rows[0];
        if (!tpl) {
          return reply.status(404).send({ code: "NOT_FOUND", message: "Template não encontrado no catálogo" });
        }

        const tenantId =
          user.tenantId ?? (await client.query("SELECT id FROM tenants LIMIT 1")).rows[0]?.id;
        if (!tenantId) {
          return reply.status(400).send({ code: "BAD_REQUEST", message: "Nenhum tenant disponível" });
        }

        const title = (body.title ?? "").trim() || (tpl.title as string);
        const markdown = tpl.template_markdown as string;
        const filename = `${slug}.md`;

        // Nasce como SPEC (rascunho) — aparece na seção SPECs, o usuário inicia quando quiser.
        const result = await createProjectFromSpec(client, {
          tenantId,
          createdBy: user.id,
          approverEmail: user.email ?? null,
          title,
          files: [{ filename, buffer: Buffer.from(markdown, "utf-8"), mimeType: "text/markdown" }],
          productId: (body.productId ?? "").trim() || null,
          isDraft: true,
        });

        return reply.status(201).send({ projectId: result.projectId, status: result.status, slug });
      } finally {
        client.release();
      }
    },
  );
}
