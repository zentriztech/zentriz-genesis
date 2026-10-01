/**
 * tickets.ts — RFC-0009: rotas do PEDIDO de evolução (Ticket).
 *
 *  POST   /api/products/:productId/tickets           (multipart: title, body, changeKind, projectId + anexos)
 *  GET    /api/products/:productId/tickets           lista os pedidos do produto (?status=)
 *  GET    /api/tickets/:id                           detalhe + anexos + estado DERIVADO da execução
 *  PATCH  /api/tickets/:id                           edita enquanto 'open'; recusa/entrega o pedido
 *  DELETE /api/tickets/:id                           só enquanto 'open'
 *  GET    /api/tickets/:id/attachments/:attachmentId  download
 *
 * NÃO existe rota de promoção aqui — promover é o `POST /api/projects/:id/evolve` que já existe,
 * com `ticketId` no body. Uma segunda porta seria o erro clássico do Genesis (fluxo paralelo).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { sha256Hex } from "../lib/specTreeHash.js";
import {
  allocTicketNumber, isTicketChangeKind, loadTicket, loadTicketAttachments,
  ticketCode, ticketUploadDir, type TicketRow,
} from "../services/tickets.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

const MAX_BODY = 20_000;
const MAX_TITLE = 300;

/** Parte de multipart no @fastify/multipart v8 (`req.parts()`): arquivo OU campo. */
type Part = {
  type?: "file" | "field";
  fieldname: string;
  filename: string;
  mimetype: string;
  value?: unknown;
  toBuffer(): Promise<Buffer>;
};

/** Nome de arquivo seguro: sem caminho, sem `..`, sem separador. */
function safeFilename(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "").trim();
  return clean.slice(0, 180) || `anexo-${Date.now()}`;
}

/**
 * Estado de EXECUÇÃO derivado do projeto filho — nunca copiado para `tickets.status`.
 * O ataque adversarial "dois lugares dizendo a verdade sobre a mesma coisa" é evitado aqui:
 * o ticket guarda o estado do PEDIDO; a execução se lê de `projects` por join.
 */
type TicketOut = TicketRow & { code: string; execution_status: string | null; execution_title: string | null; attachments_count: number };

async function hydrate(rows: TicketRow[]): Promise<TicketOut[]> {
  const childIds = rows.map((r) => r.child_project_id).filter((v): v is string => !!v);
  const execByChild = new Map<string, { status: string; title: string }>();
  if (childIds.length > 0) {
    const res = await pool.query("SELECT id, status, title FROM projects WHERE id = ANY($1::uuid[])", [childIds]);
    for (const r of res.rows as Array<{ id: string; status: string; title: string }>) execByChild.set(r.id, { status: r.status, title: r.title });
  }
  const counts = new Map<string, number>();
  if (rows.length > 0) {
    const res = await pool.query(
      "SELECT ticket_id, count(*)::int AS n FROM ticket_attachments WHERE ticket_id = ANY($1::uuid[]) GROUP BY ticket_id",
      [rows.map((r) => r.id)],
    );
    for (const r of res.rows as Array<{ ticket_id: string; n: number }>) counts.set(r.ticket_id, r.n);
  }
  return rows.map((r) => {
    const exec = r.child_project_id ? execByChild.get(r.child_project_id) : undefined;
    return {
      ...r,
      code: ticketCode(r.number),
      execution_status: exec?.status ?? null,
      execution_title: exec?.title ?? null,
      attachments_count: counts.get(r.id) ?? 0,
    };
  });
}

export async function ticketRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ── Criar pedido ──────────────────────────────────────────────────────────────
  app.post<{ Params: { productId: string } }>("/api/products/:productId/tickets", async (request, reply) => {
    const user = getUser(request);
    // Conta de gestão não cria pedido de evolução (autoria é do tenant) — mesma regra do /evolve.
    if (denyCreationForManagement(user, reply)) return;
    if (user.svc === "runner") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não abre pedido de evolução (autoria humana)." });
    }
    const { productId } = request.params;

    const product = (await pool.query(
      "SELECT id, tenant_id, created_by, name, status FROM products WHERE id = $1", [productId],
    )).rows[0] as { id: string; tenant_id: string | null; created_by: string | null; name: string; status: string } | undefined;
    if (!product || !canAccessProjectRow(user, product)) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
    }
    if (product.status === "archived") {
      return reply.status(409).send({ code: "PRODUCT_ARCHIVED", message: "Produto arquivado não recebe novos pedidos." });
    }

    let title = "";
    let body = "";
    let changeKind = "evolution";
    let projectId: string | null = null;
    const files: Array<{ filename: string; buffer: Buffer; mimeType: string }> = [];

    const isMultipart = typeof (request as unknown as { isMultipart?: () => boolean }).isMultipart === "function"
      && (request as unknown as { isMultipart: () => boolean }).isMultipart();
    if (isMultipart) {
      // `parts()` e não `files()`: anexo é OPCIONAL e o diálogo manda FormData sempre. Com
      // `files()`, um envio sem nenhum arquivo não emite NADA — os campos se perdiam e todo
      // pedido sem anexo virava 400. (`file()` teria o outro defeito: só a 1ª parte de arquivo.)
      const req = request as unknown as { parts: () => AsyncIterableIterator<Part> };
      for await (const part of req.parts()) {
        if (part.type === "file" || part.filename) {
          files.push({ filename: safeFilename(part.filename), buffer: await part.toBuffer(), mimeType: part.mimetype || "application/octet-stream" });
          continue;
        }
        const v = typeof part.value === "string" ? part.value.trim() : "";
        if (part.fieldname === "title") title = v;
        else if (part.fieldname === "body") body = v;
        else if (part.fieldname === "changeKind" && v) changeKind = v;
        else if (part.fieldname === "projectId") projectId = v || null;
      }
    } else {
      const b = (request.body ?? {}) as { title?: string; body?: string; changeKind?: string; projectId?: string };
      title = (b.title ?? "").trim();
      body = (b.body ?? "").trim();
      changeKind = (b.changeKind ?? "evolution").trim();
      projectId = (b.projectId ?? "").trim() || null;
    }

    body = body.trim().slice(0, MAX_BODY);
    title = title.trim().slice(0, MAX_TITLE);
    if (!body) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Descreva o que você quer evoluir (campo 'body')." });
    }
    if (!isTicketChangeKind(changeKind)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "changeKind deve ser 'evolution', 'fix' ou 'feature'." });
    }
    if (!title) title = body.split("\n")[0].slice(0, 120);

    // Projeto-alvo: a versão corrente do serviço. Conferido contra o produto para não aceitar
    // um projeto de outro produto/tenant vindo do cliente.
    if (projectId) {
      const proj = (await pool.query(
        "SELECT id, tenant_id, created_by, product_id FROM projects WHERE id = $1", [projectId],
      )).rows[0] as { id: string; tenant_id: string | null; created_by: string | null; product_id: string | null } | undefined;
      if (!proj || !canAccessProjectRow(user, proj) || proj.product_id !== productId) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Projeto-alvo inválido para este produto." });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const number = await allocTicketNumber(client, productId);
      const ins = await client.query(
        `INSERT INTO tickets (tenant_id, product_id, project_id, number, title, body, change_kind, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8) RETURNING *`,
        [product.tenant_id, productId, projectId, number, title, body, changeKind, user.id],
      );
      const ticket = ins.rows[0] as TicketRow;

      if (files.length > 0) {
        const { mkdirSync, writeFileSync } = await import("fs");
        const { join } = await import("path");
        const dir = ticketUploadDir(ticket.id);
        mkdirSync(dir, { recursive: true });
        for (const f of files) {
          const dest = join(dir, f.filename);
          writeFileSync(dest, f.buffer);
          await client.query(
            `INSERT INTO ticket_attachments (ticket_id, filename, file_path, mime_type, size_bytes, content_sha256)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [ticket.id, f.filename, dest, f.mimeType, f.buffer.length, sha256Hex(f.buffer)],
          );
        }
      }
      await client.query("COMMIT");
      const [out] = await hydrate([ticket]);
      return reply.status(201).send(out);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      request.log.error({ err, productId }, "[tickets] falha ao criar pedido");
      return reply.status(500).send({ code: "INTERNAL", message: "Falha ao abrir o pedido." });
    } finally {
      client.release();
    }
  });

  // ── Listar a fila do produto ──────────────────────────────────────────────────
  app.get<{ Params: { productId: string }; Querystring: { status?: string } }>(
    "/api/products/:productId/tickets",
    async (request, reply) => {
      const user = getUser(request);
      const { productId } = request.params;
      const product = (await pool.query("SELECT id, tenant_id, created_by FROM products WHERE id = $1", [productId])).rows[0] as
        { id: string; tenant_id: string | null; created_by: string | null } | undefined;
      if (!product || !canAccessProjectRow(user, product)) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
      }
      const status = (request.query?.status ?? "").trim();
      const rows = (await pool.query(
        status
          ? "SELECT * FROM tickets WHERE product_id = $1 AND status = $2 ORDER BY number DESC"
          : "SELECT * FROM tickets WHERE product_id = $1 ORDER BY number DESC",
        status ? [productId, status] : [productId],
      )).rows as TicketRow[];
      return reply.send(await hydrate(rows));
    },
  );

  // ── Detalhe ───────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/tickets/:id", async (request, reply) => {
    const user = getUser(request);
    const ticket = await loadTicket(pool, request.params.id);
    if (!ticket || !canAccessProjectRow(user, ticket)) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Pedido não encontrado" });
    }
    const [out] = await hydrate([ticket]);
    const attachments = (await loadTicketAttachments(pool, ticket.id)).map((a) => ({
      id: a.id, filename: a.filename, mimeType: a.mime_type, sizeBytes: Number(a.size_bytes),
    }));
    return reply.send({ ...out, attachments });
  });

  // ── Editar / recusar / marcar entregue ────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: { title?: string; body?: string; changeKind?: string; status?: string } }>(
    "/api/tickets/:id",
    async (request, reply) => {
      const user = getUser(request);
      const ticket = await loadTicket(pool, request.params.id);
      if (!ticket || !canAccessProjectRow(user, ticket)) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Pedido não encontrado" });
      }
      const b = request.body ?? {};
      const patch: string[] = [];
      const vals: unknown[] = [ticket.id];

      const wantsContentEdit = b.title !== undefined || b.body !== undefined || b.changeKind !== undefined;
      if (wantsContentEdit && ticket.status !== "open") {
        // Invariante 1: depois de promovido o pedido é histórico. `request.md` já foi materializado
        // na árvore da spec e o filho já carrega o texto — editar aqui criaria duas verdades.
        return reply.status(409).send({
          code: "TICKET_IMMUTABLE",
          message: `${ticketCode(ticket.number)} já foi promovido — o pedido original é imutável. Abra um novo pedido para pedir outra coisa.`,
        });
      }
      if (b.title !== undefined) { vals.push(String(b.title).trim().slice(0, MAX_TITLE)); patch.push(`title = $${vals.length}`); }
      if (b.body !== undefined) {
        const nb = String(b.body).trim().slice(0, MAX_BODY);
        if (!nb) return reply.status(400).send({ code: "BAD_REQUEST", message: "O pedido não pode ficar vazio." });
        vals.push(nb); patch.push(`body = $${vals.length}`);
      }
      if (b.changeKind !== undefined) {
        if (!isTicketChangeKind(b.changeKind)) return reply.status(400).send({ code: "BAD_REQUEST", message: "changeKind inválido." });
        vals.push(b.changeKind); patch.push(`change_kind = $${vals.length}`);
      }
      if (b.status !== undefined) {
        // Só transições MANUAIS do pedido. 'promoted' é escrito pelo /evolve, nunca pelo cliente.
        if (!["open", "rejected", "delivered"].includes(b.status)) {
          return reply.status(400).send({ code: "BAD_REQUEST", message: "status deve ser 'open', 'rejected' ou 'delivered'." });
        }
        if (b.status === "delivered" && !ticket.child_project_id) {
          return reply.status(409).send({ code: "NOT_PROMOTED", message: "Pedido ainda não foi promovido — não há entrega a marcar." });
        }
        vals.push(b.status); patch.push(`status = $${vals.length}`);
        patch.push(b.status === "delivered" ? "delivered_at = now()" : "delivered_at = NULL");
      }
      if (patch.length === 0) return reply.status(400).send({ code: "BAD_REQUEST", message: "Nada a alterar." });

      const upd = await pool.query(`UPDATE tickets SET ${patch.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
      const [out] = await hydrate([upd.rows[0] as TicketRow]);
      return reply.send(out);
    },
  );

  // ── Excluir (só pedido ainda não promovido) ───────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/tickets/:id", async (request, reply) => {
    const user = getUser(request);
    const ticket = await loadTicket(pool, request.params.id);
    if (!ticket || !canAccessProjectRow(user, ticket)) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Pedido não encontrado" });
    }
    if (ticket.status !== "open") {
      return reply.status(409).send({
        code: "TICKET_PROMOTED",
        message: `${ticketCode(ticket.number)} já foi promovido — recuse (status 'rejected') em vez de apagar o histórico.`,
      });
    }
    await pool.query("DELETE FROM tickets WHERE id = $1", [ticket.id]);
    return reply.status(204).send();
  });

  // ── Download de anexo ─────────────────────────────────────────────────────────
  app.get<{ Params: { id: string; attachmentId: string } }>(
    "/api/tickets/:id/attachments/:attachmentId",
    async (request, reply) => {
      const user = getUser(request);
      const ticket = await loadTicket(pool, request.params.id);
      if (!ticket || !canAccessProjectRow(user, ticket)) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Pedido não encontrado" });
      }
      const att = (await pool.query(
        "SELECT id, filename, file_path, mime_type FROM ticket_attachments WHERE id = $1 AND ticket_id = $2",
        [request.params.attachmentId, ticket.id],
      )).rows[0] as { id: string; filename: string; file_path: string; mime_type: string | null } | undefined;
      if (!att) return reply.status(404).send({ code: "NOT_FOUND", message: "Anexo não encontrado" });
      const { readFile } = await import("fs/promises");
      const buf = await readFile(att.file_path).catch(() => null);
      if (!buf) return reply.status(410).send({ code: "GONE", message: "Arquivo do anexo não está mais no disco." });
      return reply
        .header("Content-Type", att.mime_type ?? "application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${att.filename.replace(/"/g, "")}"`)
        .send(buf);
    },
  );
}
