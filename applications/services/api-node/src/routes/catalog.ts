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
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { createProjectFromSpec } from "../services/projectCreation.js";
import { InboxError } from "../services/inbox.js";
import { checkSpecContentReady } from "../services/specContentGate.js";

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

  // GET /api/catalog/:slug — item completo INCLUINDO o template_markdown, para o preview
  // "Ver/Ler" na Bancada. A listagem (GET /api/catalog) omite o markdown por volume; aqui
  // servimos o conteúdo integral de UM template para renderização (read-only, entre tenants).
  // Registrado ANTES de :slug/use e depois de /categories (rota estática vence a dinâmica).
  app.get<{ Params: { slug: string } }>("/api/catalog/:slug", async (request, reply) => {
    const slug = (request.params.slug ?? "").trim();
    const client = await pool.connect();
    try {
      const row = (await client.query(
        `SELECT slug, title, category, description, tags, template_markdown
           FROM spec_catalog WHERE slug = $1`,
        [slug],
      )).rows[0];
      if (!row) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Template não encontrado no catálogo" });
      }
      return reply.send(row);
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
      // RFC-0002 A.1: conta de gestão (zentriz_admin) não cria spec a partir do catálogo.
      if (denyCreationForManagement(user, reply)) return;
      if (!user.tenantId) {
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

        // RFC-0002 A.1 (M6): sem fallback para "primeiro tenant" — exige tenant do chamador.
        const tenantId = user.tenantId;
        if (!tenantId) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });
        }

        const title = (body.title ?? "").trim() || (tpl.title as string);
        const markdown = tpl.template_markdown as string;
        const filename = `${slug}.md`;

        // MED-4 (adversarial): mesmo criando um DRAFT, não deixamos um template AINDA em
        // branco (placeholders `[título]`, `DADO [...]`, produto TBD) virar spec — seria
        // barrado só lá na frente, no /run (specContentGate). Barramos custo-ZERO na porta.
        // Templates curados reais passam; só o esqueleto não preenchido é recusado.
        const contentReady = checkSpecContentReady(markdown);
        if (!contentReady.ok) {
          request.log.warn(
            { slug, signals: contentReady.block.signals },
            "[catalog] uso de template barrado: conteúdo ainda é placeholder/rascunho",
          );
          return reply.status(422).send(contentReady.block);
        }

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
      } catch (e) {
        // Funil de criação (§4.2): produto explícito inexistente/de outro tenant → 404.
        if (e instanceof InboxError) {
          return reply.status(e.code === "PRODUCT_NOT_FOUND" ? 404 : 409)
            .send({ code: e.code, message: e.message });
        }
        throw e;
      } finally {
        client.release();
      }
    },
  );
}
