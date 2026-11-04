/**
 * cards.ts — tarefa 2.6 da Fase 2 (EVOLUIR-PROJETO-BANCADA v2): API de CARDS da Bancada.
 *
 *  POST   /api/products/:productId/cards              cria card (json | multipart: kind, title, body, projectId + anexos)
 *  GET    /api/products/:productId/cards              lista (?state=&kind=&origin=&limit=&offset=)
 *  GET    /api/products/:productId/cards/capabilities { cardsBancada } — SEMPRE 200 (o portal decide se mostra o quadro)
 *  GET    /api/cards/:id                              detalhe (+ anexos, eventos, base, ações disponíveis)
 *  PATCH  /api/cards/:id                              texto (title, body, kind) enquanto draft|refining
 *  POST   /api/cards/:id/refine | ready | reject | resume | revalidate | promote
 *  DELETE /api/cards/:id                              só em draft (CAS no banco)
 *  GET    /api/cards/:id/base-spec                    spec da versão CORRENTE, somente leitura
 *  GET    /api/cards/:id/attachments/:attachmentId    download (mesma regra de /api/tickets/...)
 *
 * Tudo exige `CARDS_BANCADA` ligada para o tenant do recurso (flag off ⇒ 404 "Recurso indisponível", como M-19) e a autorização
 * por tenant/produto dos tickets (a autorização vem PRIMEIRO: outro tenant recebe o mesmo 404 de sempre). Toda mudança de
 * `card_state` passa por `transitionCard` (cardState.ts). Mutações: conta de gestão (zentriz_admin) e token de serviço são recusados
 * (a autoria do card é do tenant).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { ticketCode } from "../services/tickets.js";
import { kickTicketConversions } from "../services/attachmentConversionQueue.js";
import {
  attachmentsStrictEnabled, attachmentContentDisposition, downloadContentType, loadAttachmentLimits, validateAttachments,
  MULTIPART_MAX_FILES, MULTIPART_MAX_FILE_BYTES, type AttachmentError,
} from "../services/ticketAttachments.js";
import { allowedCardTargets, cardsBancadaEnabled, isCardState, transitionCard, CARD_STATES, type CardState, type CardTransitionResult } from "../services/cardState.js";
import {
  applyCardTextEdit, createCard, deleteCard, isCardKind, loadBaseSpec, loadCard, loadCardsPage, markCardReady, reopenCard, resolveCardTarget,
  revalidateCard, summarizeCards, MAX_CARD_BODY, MAX_CARD_TITLE, type CardRow, type IncomingFile,
} from "../services/cardService.js";
import { promoteCard, resumeCard, syncCardWithChild } from "../services/cardPromote.js";
import { withCardUserMessage } from "../services/cardErrors.js";
import { buildCardJourney } from "../services/cardJourney.js";
import { listCardAttachments } from "../services/cardAttachments.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

type Part = { type?: "file" | "field"; fieldname: string; filename: string; mimetype: string; value?: unknown; toBuffer(): Promise<Buffer> };

function safeFilename(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "").trim();
  return clean.slice(0, 180) || `anexo-${Date.now()}`;
}

const NOT_AVAILABLE = { code: "NOT_FOUND", message: "Recurso indisponível" } as const;

/** Autoria: conta de gestão e token de serviço não mutam cards. `true` = já respondeu. */
function denyMutation(user: AuthUser, reply: FastifyReply): boolean {
  if (denyCreationForManagement(user, reply)) return true;
  if (user.svc === "runner") {
    reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não opera cards (autoria humana)." });
    return true;
  }
  return false;
}

function transitionFailure(reply: FastifyReply, card: CardRow, to: CardState, r: CardTransitionResult) {
  switch (r.kind) {
    case "invalid":
      return reply.status(409).send({ code: "CARD_INVALID_TRANSITION", from: r.from, to: r.to, allowed: r.allowed, message: `${ticketCode(card.number)}: transição ${r.from} → ${r.to} não é permitida.` });
    case "diverged":
      return reply.status(409).send({ code: "CARD_DIVERGED", cardState: r.cardState, status: r.status, message: `${ticketCode(card.number)}: o status legado (${r.status}) diverge do estado do card (${r.cardState}); corrija antes de transitar.` });
    case "not_found":
    case "not_a_card":
      return reply.status(404).send({ code: "NOT_FOUND", message: "Card não encontrado" });
    default:
      return reply.status(409).send({ code: "CARD_INVALID_TRANSITION", from: card.card_state, to, message: `${ticketCode(card.number)}: transição para ${to} não aplicada (${r.kind}).` });
  }
}

export async function cardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);
  // Fase 3 (3.5): `userMessage` — mensagem curta PT-BR da tabela única `cardErrors.ts` — em TODA resposta de erro dos cards.
  // O `message` técnico de sempre continua no corpo (contrato da Fase 2 intacto). A recusa da flag off (404 "Recurso indisponível") NÃO leva
  // `userMessage`: com `CARDS_BANCADA` desligada a resposta é byte a byte a de antes.
  app.addHook("preSerialization", async (_request, reply, payload) => (payload === NOT_AVAILABLE ? payload : withCardUserMessage(reply.statusCode, payload)));

  /** Produto acessível + flag do tenant. `null` ⇒ já respondeu 404. */
  async function productGuard(request: FastifyRequest, reply: FastifyReply, productId: string, opts: { capabilities?: boolean } = {}) {
    const user = getUser(request);
    const product = (await pool.query("SELECT id, tenant_id, created_by, name, status FROM products WHERE id = $1", [productId])).rows[0] as
      { id: string; tenant_id: string | null; created_by: string | null; name: string; status: string } | undefined;
    if (!product || !canAccessProjectRow(user, product)) {
      reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
      return null;
    }
    const enabled = await cardsBancadaEnabled(pool, product.tenant_id ?? user.tenantId ?? null);
    if (!enabled && !opts.capabilities) {
      reply.status(404).send(NOT_AVAILABLE);
      return null;
    }
    return { product, enabled };
  }

  /** Card acessível + flag do tenant. Ticket legado (sem `card_state`) não é card ⇒ 404. */
  async function cardGuard(request: FastifyRequest, reply: FastifyReply, id: string): Promise<CardRow | null> {
    const user = getUser(request);
    const card = await loadCard(pool, id);
    if (!card || !canAccessProjectRow(user, card)) {
      reply.status(404).send({ code: "NOT_FOUND", message: "Card não encontrado" });
      return null;
    }
    if (!(await cardsBancadaEnabled(pool, card.tenant_id ?? user.tenantId ?? null))) {
      reply.status(404).send(NOT_AVAILABLE);
      return null;
    }
    if (!card.card_state) {
      reply.status(404).send({ code: "NOT_FOUND", message: "Card não encontrado" });
      return null;
    }
    return card;
  }

  const fresh = async (id: string) => (await summarizeCards(pool, [(await loadCard(pool, id))!]))[0];

  // ── Capacidades (sempre 200, autorizado) ────────────────────────────────────────────────────
  app.get<{ Params: { productId: string } }>("/api/products/:productId/cards/capabilities", async (request, reply) => {
    const g = await productGuard(request, reply, request.params.productId, { capabilities: true });
    if (!g) return;
    return reply.send({ cardsBancada: g.enabled });
  });

  // ── Criar ───────────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { productId: string } }>("/api/products/:productId/cards", async (request, reply) => {
    const user = getUser(request);
    const g = await productGuard(request, reply, request.params.productId);
    if (!g) return;
    if (denyMutation(user, reply)) return;
    const { product } = g;
    if (product.status === "archived") {
      return reply.status(409).send({ code: "PRODUCT_ARCHIVED", message: "Produto arquivado não recebe novos cards." });
    }

    let title = "", body = "", kind = "evolution", projectId: string | null = null;
    const files: IncomingFile[] = [];
    const isMultipart = typeof (request as unknown as { isMultipart?: () => boolean }).isMultipart === "function"
      && (request as unknown as { isMultipart: () => boolean }).isMultipart();
    if (isMultipart) {
      const req = request as unknown as { parts: () => AsyncIterableIterator<Part> };
      try {
        for await (const part of req.parts()) {
          if (part.type === "file" || part.filename) {
            files.push({ filename: safeFilename(part.filename), buffer: await part.toBuffer(), mimeType: part.mimetype || "application/octet-stream" });
            continue;
          }
          const v = typeof part.value === "string" ? part.value.trim() : "";
          if (part.fieldname === "title") title = v;
          else if (part.fieldname === "body") body = v;
          else if ((part.fieldname === "kind" || part.fieldname === "changeKind") && v) kind = v;
          else if (part.fieldname === "projectId") projectId = v || null;
        }
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const limits = await loadAttachmentLimits(pool, product.tenant_id);
        let e: AttachmentError | null = null;
        if (code === "FST_REQ_FILE_TOO_LARGE") e = { code: "ATTACHMENT_TOO_LARGE", filename: "", message: `Um dos arquivos é maior que ${Math.min(limits.maxFileBytes, MULTIPART_MAX_FILE_BYTES)} bytes.` };
        else if (code === "FST_FILES_LIMIT") e = { code: "ATTACHMENT_TOO_MANY", filename: "", message: `Máximo de ${Math.min(limits.maxFiles, MULTIPART_MAX_FILES)} arquivo(s) por card.` };
        if (e) return reply.status(400).send({ code: "ATTACHMENT_INVALID", message: e.message, errors: [e] });
        throw err;
      }
    } else {
      const b = (request.body ?? {}) as { title?: string; body?: string; kind?: string; changeKind?: string; projectId?: string };
      title = (b.title ?? "").trim();
      body = (b.body ?? "").trim();
      kind = (b.kind ?? b.changeKind ?? "evolution").trim();
      projectId = (b.projectId ?? "").trim() || null;
    }
    body = body.trim().slice(0, MAX_CARD_BODY);
    title = title.trim().slice(0, MAX_CARD_TITLE);
    if (!body) return reply.status(400).send({ code: "BAD_REQUEST", message: "Descreva o que o card pede (campo 'body')." });
    if (!isCardKind(kind)) return reply.status(400).send({ code: "BAD_REQUEST", message: "kind deve ser 'evolution', 'fix' ou 'feature'." });
    if (!title) title = body.split("\n")[0].slice(0, 120);

    // Anexos: pdf/txt/md/doc/docx (allowlist + magic bytes + tetos). Dependem de ATTACHMENTS_STRICT (é ela que mantém pdf/doc/docx
    // FORA da árvore de texto da spec): sem a flag o card aceita só texto, nunca arquivo (liga-se CARDS_BANCADA e ATTACHMENTS_STRICT juntas).
    if (files.length > 0) {
      if (!(await attachmentsStrictEnabled(pool, product.tenant_id))) {
        return reply.status(409).send({ code: "ATTACHMENTS_UNAVAILABLE", message: "Anexos de card exigem ATTACHMENTS_STRICT ligada para o tenant." });
      }
      const limits = await loadAttachmentLimits(pool, product.tenant_id);
      const problems = validateAttachments(files, limits);
      if (problems.length > 0) return reply.status(400).send({ code: "ATTACHMENT_INVALID", message: problems.map((p) => p.message).join(" "), errors: problems });
    }

    const target = await resolveCardTarget(pool, user, product.id, projectId);
    if (!target.ok) return reply.status(target.status).send({ code: target.code, message: target.message, ...(target.services ? { services: target.services } : {}) });

    try {
      const res = await createCard(pool, { user, product, target, kind, title, body, files });
      if (res.kind === "budget_missing") {
        return reply.status(402).send({
          code: "BUDGET_MISSING", projectId: res.headProjectId,
          message: `A versão corrente (v${res.versionNumber}) não tem orçamento de LLM e nenhuma versão anterior tem. Defina o orçamento em US$ na versão corrente antes de abrir cards.`,
        });
      }
      if (res.kind === "attachment_unreadable") return reply.status(400).send({ code: "ATTACHMENT_UNREADABLE", message: res.message });
      if (res.strictAttachments && files.length > 0) void kickTicketConversions(pool, product.tenant_id, res.card.id);
      const summary = await fresh(res.card.id);
      return reply.status(201).send({ ...summary, body: res.card.body });
    } catch (err) {
      request.log.error({ err, productId: product.id }, "[cards] falha ao criar card");
      return reply.status(500).send({ code: "INTERNAL", message: "Falha ao criar o card." });
    }
  });

  // ── Listar ──────────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { productId: string }; Querystring: { state?: string; kind?: string; origin?: string; limit?: string; offset?: string } }>(
    "/api/products/:productId/cards",
    async (request, reply) => {
      const g = await productGuard(request, reply, request.params.productId);
      if (!g) return;
      const q = request.query ?? {};
      const states = (q.state ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (states.some((s) => !isCardState(s))) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: `state inválido. Aceitos: ${CARD_STATES.join(", ")}.` });
      }
      const kind = (q.kind ?? "").trim();
      if (kind && !isCardKind(kind)) return reply.status(400).send({ code: "BAD_REQUEST", message: "kind deve ser 'evolution', 'fix' ou 'feature'." });
      const origin = (q.origin ?? "").trim();
      if (origin && !["manual", "import"].includes(origin)) return reply.status(400).send({ code: "BAD_REQUEST", message: "origin deve ser 'manual' ou 'import'." });
      const page = await loadCardsPage(pool, g.product.tenant_id, q);

      const where = ["product_id = $1", "card_state IS NOT NULL"];
      const params: unknown[] = [g.product.id];
      if (states.length > 0) { params.push(states); where.push(`card_state = ANY($${params.length}::text[])`); }
      if (kind) { params.push(kind); where.push(`change_kind = $${params.length}`); }
      if (origin) { params.push(origin); where.push(`origin = $${params.length}`); }
      const total = Number((await pool.query(`SELECT count(*)::int AS n FROM tickets WHERE ${where.join(" AND ")}`, params)).rows[0]?.n ?? 0);
      const rows = (await pool.query(
        `SELECT * FROM tickets WHERE ${where.join(" AND ")} ORDER BY number DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, page.limit, page.offset],
      )).rows as CardRow[];
      return reply.send({ items: await summarizeCards(pool, rows), total, limit: page.limit, offset: page.offset });
    },
  );

  // ── Detalhe ─────────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/cards/:id", async (request, reply) => {
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    const [summary] = await summarizeCards(pool, [card]);
    const strict = await attachmentsStrictEnabled(pool, card.tenant_id);
    const cols = strict
      ? "id, filename, mime_type, size_bytes, content_sha256, kind, origin, derived_from_attachment_id"
      : "id, filename, mime_type, size_bytes, content_sha256";
    const attachments = (await pool.query(`SELECT ${cols} FROM ticket_attachments WHERE ticket_id = $1 ORDER BY created_at ASC`, [card.id])).rows
      .map((a: Record<string, unknown>) => ({
        id: a.id, filename: a.filename, mimeType: a.mime_type, sizeBytes: Number(a.size_bytes),
        ...(strict ? { kind: a.kind, contentSha256: a.content_sha256, origin: a.origin, derivedFromAttachmentId: a.derived_from_attachment_id ?? null } : {}),
        downloadUrl: `/api/cards/${card.id}/attachments/${a.id}`,
      }));
    const events = (await pool.query(
      `SELECT from_state, to_state, actor_kind, reason, child_project_id, created_at FROM ticket_card_events WHERE ticket_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
      [card.id],
    )).rows.map((e: Record<string, unknown>) => ({ from: e.from_state, to: e.to_state, actor: e.actor_kind, reason: e.reason, childProjectId: e.child_project_id, at: e.created_at }));
    let base: Record<string, unknown> | null = null;
    if (card.draft_project_id) {
      const d = (await pool.query("SELECT extra FROM projects WHERE id = $1", [card.draft_project_id])).rows[0] as { extra: Record<string, unknown> | null } | undefined;
      const x = d?.extra ?? {};
      const ready = (x.card_ready ?? null) as Record<string, unknown> | null;
      base = {
        headProjectId: (x.card_base as Record<string, unknown> | undefined)?.head_project_id ?? null,
        headVersion: (x.card_base as Record<string, unknown> | undefined)?.head_version ?? null,
        validatedAt: ready?.at ?? null,
      };
    }
    const st = card.card_state as CardState;
    const actions = {
      edit: st === "draft" || st === "refining",
      refine: allowedCardTargets(st, "user").includes("refining"),
      ready: st === "draft" || st === "refining",
      promote: st === "ready",
      revalidate: st === "draft" || st === "refining" || st === "ready",
      reopen: st === "ready",
      reject: allowedCardTargets(st, "user").includes("rejected"),
      resume: st === "blocked",
      delete: st === "draft",
    };
    return reply.send({ ...summary, body: card.body, attachments, events, base, actions });
  });

  // ── Atualizar texto ─────────────────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: { title?: string; body?: string; kind?: string; changeKind?: string } }>("/api/cards/:id", async (request, reply) => {
    const user = getUser(request);
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    if (denyMutation(user, reply)) return;
    const b = request.body ?? {};
    const kindRaw = b.kind ?? b.changeKind;
    if (b.title === undefined && b.body === undefined && kindRaw === undefined) return reply.status(400).send({ code: "BAD_REQUEST", message: "Nada a alterar." });
    if (kindRaw !== undefined && !isCardKind(kindRaw)) return reply.status(400).send({ code: "BAD_REQUEST", message: "kind deve ser 'evolution', 'fix' ou 'feature'." });
    const r = await applyCardTextEdit(pool, card.id, {
      ...(b.title !== undefined ? { title: String(b.title) } : {}),
      ...(b.body !== undefined ? { body: String(b.body) } : {}),
      ...(kindRaw !== undefined ? { kind: kindRaw as "evolution" | "fix" | "feature" } : {}),
    }, { actorId: user.id, actorEmail: user.email });
    switch (r.kind) {
      case "updated": return reply.send(await fresh(r.card.id));
      case "empty_body": return reply.status(400).send({ code: "BAD_REQUEST", message: "O card não pode ficar sem texto." });
      case "spec_locked":
        return reply.status(409).send({ code: "CARD_SPEC_LOCKED", state: r.state, canReopen: true, cardId: card.id, reopen: `POST /api/cards/${card.id}/reopen`, message: `${ticketCode(card.number)} está pronto (ready): a spec está travada. Reabra o card (POST /api/cards/${card.id}/reopen) para voltar a editar.` });
      case "not_editable":
        return reply.status(409).send({ code: "CARD_NOT_EDITABLE", state: r.state, message: `${ticketCode(card.number)} está em '${r.state}': só se edita o texto em draft ou refining.` });
      case "attachment_unreadable": return reply.status(400).send({ code: "ATTACHMENT_UNREADABLE", message: r.message });
      case "transition_failed": return transitionFailure(reply, card, "refining", r.result);
      default: return reply.status(404).send({ code: "NOT_FOUND", message: "Card não encontrado" });
    }
  });

  // ── Transições simples (refine, reject) — somente pela máquina ──────────────────────────────
  const simple = (path: "refine" | "reject", to: CardState, reason: string) =>
    app.post<{ Params: { id: string } }>(`/api/cards/:id/${path}`, async (request, reply) => {
      const user = getUser(request);
      const card = await cardGuard(request, reply, request.params.id);
      if (!card) return;
      if (denyMutation(user, reply)) return;
      const r = await transitionCard(pool, { ticketId: card.id, to, actorKind: "user", actorId: user.id, reason });
      if (r.kind === "applied" || r.kind === "noop") {
        return reply.send({ ok: true, replayed: r.kind === "noop", card: await fresh(card.id) });
      }
      return transitionFailure(reply, card, to, r);
    });
  simple("refine", "refining", "user_refine");
  simple("reject", "rejected", "user_reject");

  // ── Validar: gate invariante + tipo + orçamento + base ──────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/cards/:id/ready", async (request, reply) => {
    const user = getUser(request);
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    if (denyMutation(user, reply)) return;
    if (card.card_state !== "draft" && card.card_state !== "refining" && card.card_state !== "ready") {
      return reply.status(409).send({ code: "CARD_INVALID_TRANSITION", from: card.card_state, to: "ready", allowed: allowedCardTargets(card.card_state as CardState, "system"), message: `${ticketCode(card.number)}: só se valida um card em draft, refining ou ready.` });
    }
    const r = await markCardReady(pool, card, user);
    switch (r.kind) {
      case "ready": return reply.send({ ok: true, replayed: r.replayed, card: await fresh(card.id), ...(r.gate ? { gate: { rfcs: r.gate.rfcs, scope: r.gate.scope, compat: r.gate.compat, kind: r.gate.kind } } : {}) });
      case "gate_failed": {
        const status = 409;
        return reply.status(status).send({ code: r.gate.code, message: r.gate.message, ...(r.gate.details !== undefined ? { details: r.gate.details } : {}) });
      }
      case "budget": return reply.status(r.status).send(r.body);
      case "no_head": return reply.status(409).send({ code: "NO_ACCEPTED_HEAD", message: "A linhagem do card não tem versão aceita para evoluir." });
      case "draft_unreadable": return reply.status(409).send({ code: "CARD_DRAFT_UNREADABLE", message: "O rascunho do card não tem spec legível no disco." });
      default: return transitionFailure(reply, card, "ready", r.result);
    }
  });

  // ── Revalidar (rebase para o HEAD corrente) ─────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/cards/:id/revalidate", async (request, reply) => {
    const user = getUser(request);
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    if (denyMutation(user, reply)) return;
    const r = await revalidateCard(pool, card, user);
    switch (r.kind) {
      case "revalidated": {
        const message = r.verdict === "ok"
          ? "O card está alinhado com a versão corrente."
          : r.verdict === "stale"
            ? "A versão corrente mudou: o card foi rebaseado e precisa ser validado de novo."
            : "O card conflita com a versão corrente: ajuste o RFC (veja os motivos) e revalide.";
        return reply.send({
          ok: r.verdict !== "conflict", result: r.verdict, reasons: r.reasons, rebased: r.rebased, reopened: r.reopened,
          card: await fresh(card.id),
          base: { headProjectId: r.headProjectId, headVersion: r.headVersion, previousHeadProjectId: r.previousBase },
          checks: { globs: r.globs, repo: r.repo, specDiff: r.specDiff },
          next: r.verdict === "ok" ? null : r.verdict === "stale" ? `POST /api/cards/${card.id}/ready` : `PATCH/Chat IA no RFC do card, depois POST /api/cards/${card.id}/revalidate`,
          message,
        });
      }
      case "not_revalidable": return reply.status(409).send({ code: "CARD_INVALID_TRANSITION", from: r.state, message: `${ticketCode(card.number)} está em '${r.state}': não há base a revalidar.` });
      case "no_head": return reply.status(409).send({ code: "NO_ACCEPTED_HEAD", message: "A linhagem do card não tem versão aceita." });
      case "draft_unreadable": return reply.status(409).send({ code: "CARD_DRAFT_UNREADABLE", message: "O rascunho do card não existe mais." });
      default: return transitionFailure(reply, card, "refining", r.result);
    }
  });

  // ── Reabrir (ready → refining): destrava a spec do rascunho ────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/cards/:id/reopen", async (request, reply) => {
    const user = getUser(request);
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    if (denyMutation(user, reply)) return;
    const r = await reopenCard(pool, card, user);
    switch (r.kind) {
      case "reopened": return reply.send({ ok: true, replayed: r.replayed, card: await fresh(card.id), message: "Card reaberto: a spec voltou a aceitar edição. Valide de novo antes de promover." });
      case "not_reopenable":
        return reply.status(409).send({ code: "CARD_INVALID_TRANSITION", from: r.state, to: "refining", message: `${ticketCode(card.number)} está em '${r.state}': só se reabre um card pronto (ready).` });
      default: return transitionFailure(reply, card, "refining", r.result);
    }
  });

  // ── Jornada (etapas, bloqueios da próxima etapa e ação sugerida) ───────────────────────────
  app.get<{ Params: { id: string } }>("/api/cards/:id/journey", async (request, reply) => {
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    // Alinha o card ao estado real do filho antes de contar a história (idempotente; leva a `blocked` o card cujo filho o Guard parou).
    await syncCardWithChild(pool, card.id).catch(() => undefined);
    const current = (await loadCard(pool, card.id)) ?? card;
    return reply.send(await buildCardJourney(pool, current));
  });

  // ── Anexos com o estado da conversão (pdf/doc/docx → md) ───────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/cards/:id/attachments", async (request, reply) => {
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    return reply.send(await listCardAttachments(pool, card));
  });

  // ── Promover ────────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/cards/:id/promote", async (request, reply) => {
    const user = getUser(request);
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    if (denyMutation(user, reply)) return;
    const r = await promoteCard(pool, card, user, request.log);
    for (const [h, v] of Object.entries(r.headers ?? {})) reply.header(h, v);
    return reply.status(r.status).send(r.body);
  });

  // ── Retomar um card bloqueado ───────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/cards/:id/resume", async (request, reply) => {
    const user = getUser(request);
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    if (denyMutation(user, reply)) return;
    // Antes de decidir, alinha o card ao estado real do filho (idempotente).
    await syncCardWithChild(pool, card.id).catch(() => undefined);
    const current = (await loadCard(pool, card.id)) ?? card;
    if (current.card_state === "in_factory") {
      // O alinhamento acima pode ter acabado de liberar um bloqueio de orçamento (saldo voltou): o card volta a `in_factory`, mas o
      // filho segue `stopped` (liberar a pausa não religa a execução) — a resposta diz como religá-lo.
      const cs = current.child_project_id ? (await pool.query("SELECT status FROM projects WHERE id = $1", [current.child_project_id])).rows[0] as { status: string } | undefined : undefined;
      const restart = cs?.status === "stopped" && !!current.child_project_id;
      return reply.send({
        ok: true, replayed: card.card_state !== "blocked", card: await fresh(card.id),
        ...(restart ? { childRestartRequired: true, next: `POST /api/projects/${current.child_project_id}/run`, message: "O orçamento voltou, mas a execução continua parada: reinicie-a para a fábrica seguir." } : {}),
      });
    }
    const r = await resumeCard(pool, current, user);
    switch (r.kind) {
      case "resumed_in_factory":
        return reply.send({
          ok: true, card: await fresh(card.id),
          ...(r.childRestartRequired && r.childProjectId
            ? { childRestartRequired: true, next: `POST /api/projects/${r.childProjectId}/run`, message: "O orçamento voltou, mas a execução continua parada: reinicie-a para a fábrica seguir." }
            : {}),
        });
      case "budget_still_blocked":
        return reply.status(402).send({ code: "CARD_BUDGET_BLOCKED", guardCode: r.guardCode, message: `Sem saldo para retomar: ${r.guardMessage}`, cardState: "blocked" });
      case "back_to_ready": return reply.send({ ok: true, card: await fresh(card.id), message: "O filho não existe mais: o card voltou a 'ready'. Promova de novo (a base é conferida contra o HEAD).", next: `POST /api/cards/${card.id}/promote` });
      case "not_blocked": return reply.status(409).send({ code: "CARD_INVALID_TRANSITION", from: r.state, to: "in_factory", message: `${ticketCode(card.number)}: só se retoma um card bloqueado.` });
      case "child_not_in_factory": return reply.status(409).send({ code: "CARD_CHILD_NOT_IN_FACTORY", childStatus: r.childStatus, message: "O filho ainda não voltou à fábrica (status " + r.childStatus + "). Reinicie-o (POST /api/projects/:id/run) e retome o card." });
      default: return transitionFailure(reply, card, "in_factory", r.result);
    }
  });

  // ── Excluir (draft) ─────────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/cards/:id", async (request, reply) => {
    const user = getUser(request);
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    if (denyMutation(user, reply)) return;
    const r = await deleteCard(pool, card.id);
    if (r.kind === "deleted") return reply.status(204).send();
    if (r.kind === "not_found") return reply.status(404).send({ code: "NOT_FOUND", message: "Card não encontrado" });
    return reply.status(409).send({ code: "CARD_NOT_DELETABLE", state: r.state, message: `${ticketCode(card.number)} está em '${r.state}': só se exclui um card em draft (recuse-o em vez de apagar o histórico).` });
  });

  // ── Spec da versão corrente (somente leitura) ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/cards/:id/base-spec", async (request, reply) => {
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    const spec = await loadBaseSpec(pool as unknown as Parameters<typeof loadBaseSpec>[0], card);
    if (!spec) return reply.status(409).send({ code: "NO_ACCEPTED_HEAD", message: "A linhagem do card não tem versão aceita." });
    return reply.send(spec);
  });

  // ── Download de anexo (mesma regra do /api/tickets/...) ─────────────────────────────────────
  app.get<{ Params: { id: string; attachmentId: string } }>("/api/cards/:id/attachments/:attachmentId", async (request, reply) => {
    const card = await cardGuard(request, reply, request.params.id);
    if (!card) return;
    const att = (await pool.query("SELECT id, filename, file_path FROM ticket_attachments WHERE id = $1 AND ticket_id = $2", [request.params.attachmentId, card.id]))
      .rows[0] as { id: string; filename: string; file_path: string } | undefined;
    if (!att) return reply.status(404).send({ code: "NOT_FOUND", message: "Anexo não encontrado" });
    const { readFile } = await import("fs/promises");
    const buf = await readFile(att.file_path).catch(() => null);
    if (!buf) return reply.status(410).send({ code: "GONE", message: "Arquivo do anexo não está mais no disco." });
    return reply
      .header("Content-Type", downloadContentType(att.filename))
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", attachmentContentDisposition(att.filename))
      .send(buf);
  });
}
