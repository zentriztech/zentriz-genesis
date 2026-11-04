/**
 * cardService.ts — tarefa 2.6 da Fase 2 (plano EVOLUIR-PROJETO-BANCADA v2; desenho H §4/§5/§6): regras da API de cards.
 *
 * O card é um `tickets` com `card_state` não nulo. Este módulo concentra o que a rota `routes/cards.ts` e o PATCH/DELETE
 * legados de ticket compartilham:
 *   • `resolveCardTarget`   — serviço (linhagem) alvo e HEAD corrente (um serviço por card);
 *   • `createCard`          — ticket `draft` + rascunho `card_draft` (A') numa transação; SEM versão, SEM cópia de árvore, SEM clone;
 *   • `applyCardTextEdit`   — edição de texto (título, corpo, tipo) com `request.md` do rascunho regravado;
 *   • `deleteCard`          — exclusão só em `draft`, com CAS no banco;
 *   • `markCardReady`       — "Validar": gate de RFC invariante + exigências do tipo + orçamento + base registrada;
 *   • `revalidateCard`      — confere o card contra o HEAD corrente (ok | stale | conflict, com motivos) e rebaseia quando cabe;
 *   • `loadBaseSpec`        — spec da versão corrente em modo SOMENTE LEITURA.
 * Toda mudança de `card_state` passa por `transitionCard` (cardState.ts): nenhuma escrita direta aqui.
 *
 * Rascunho (`projects.status = 'card_draft'`): `parent_project_id = NULL`, `version_number = 0` (CHECK da migration 148),
 * `budget_owner_project_id` = dono TERMINAL do orçamento do HEAD (orçamento compartilhado, H §6) e `extra`:
 *   { card: true, evolution: true, card_ticket_id, card_ticket_number, card_ticket_kind, evolution_parent_id: <HEAD>,
 *     card_target_root_id, card_base: {head_project_id, head_version}, card_ready?: {...} }.
 * DESVIO DE H §5.1: o vínculo usa `card_ticket_id` e NÃO `extra.ticket_id`, porque o índice único `uq_projects_ticket_live`
 * (evolutionUniqueness.ts) rejeita dois projetos vivos com o mesmo `extra->>'ticket_id'` — o rascunho impediria a promoção do filho.
 * O vínculo ticket ↔ rascunho oficial é `tickets.draft_project_id`.
 */
import type { Pool, PoolClient } from "pg";
import { join } from "path";
import type { AuthUser } from "../middleware/auth.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { sha256Hex } from "../lib/specTreeHash.js";
import { isCanonicalUuid, toCanonicalUuid } from "../lib/uuid.js";
import { readRuntimeNumber, type RuntimeConfigDb } from "./runtimeTunables.js";
import { resolveLineageHead, resolveLineageRoot, type LineageHead } from "./lineage.js";
import {
  allocTicketNumber, materializeTicketIntoSpecTree, ticketCode, ticketUploadDir, TICKET_CHANGE_KINDS,
  type TicketRow, type TicketChangeKind,
} from "./tickets.js";
import { attachmentsStrictEnabled, classifyAttachment } from "./ticketAttachments.js";
import { computeCurrentSpecHash } from "./specValidation.js";
import { cardAttachmentsSnapshot } from "./cardAttachments.js";
import { findBaseCollisions, loadCardDraftInfo } from "./cardSpecGuard.js";
import { evaluateCardKindGate, parseRfcMarkdown, RFC_DIR, RFC_FILENAME_RE, type CardKind, type CardKindGateResult } from "./evolutionGate.js";
import {
  evaluateRevalidation, listRepoTree, listSpecSnapshot, type GlobCheck, type RevalidateOutcome, type RevalidateReason, type RevalidateVerdict,
} from "./cardRevalidate.js";
import { budgetPreflight, resolveBudgetAnchor } from "./evolveClaim.js";
import { FACTORY_GATE_KEYS, factoryHealthOf } from "./factoryHealth.js";
import {
  CARD_CONTRACT_VERSION, recordCardEvent, transitionCard, type CardState, type CardTransitionResult,
} from "./cardState.js";

type Json = Record<string, unknown>;
type Db = Pool | PoolClient;

export const CARD_KINDS: readonly CardKind[] = TICKET_CHANGE_KINDS;
export const MAX_CARD_BODY = 20_000;
export const MAX_CARD_TITLE = 300;

/** Linha de `tickets` com as colunas de card (migration 148). */
export interface CardRow extends TicketRow {
  card_state: CardState | null;
  blocked_reason: string | null;
  origin: string;
  external_ref: string | null;
  draft_project_id: string | null;
  card_contract_version: number | null;
}

export async function loadCard(db: Db, id: string): Promise<CardRow | undefined> {
  if (!isCanonicalUuid(id)) return undefined;
  return (await db.query("SELECT * FROM tickets WHERE id = $1", [id])).rows[0] as CardRow | undefined;
}

export function isCardKind(v: unknown): v is CardKind {
  return typeof v === "string" && (CARD_KINDS as readonly string[]).includes(v);
}

// ── Paginação (limites vêm de genesis_runtime_config; os números do código são só o piso quando a chave não existe) ──
export const CARDS_PAGE_DEFAULT_KEY = "CARDS_LIST_PAGE_DEFAULT";
export const CARDS_PAGE_MAX_KEY = "CARDS_LIST_PAGE_MAX";
export const CARD_BASE_SPEC_MAX_BYTES_KEY = "CARD_BASE_SPEC_MAX_BYTES";
export const CARD_LIMIT_FALLBACKS = { pageDefault: 20, pageMax: 100, baseSpecMaxBytes: 1_000_000 } as const; // calibrado=falso

export async function loadCardsPage(db: RuntimeConfigDb, tenantId: string | null, q: { limit?: unknown; offset?: unknown }): Promise<{ limit: number; offset: number }> {
  const [def, max] = await Promise.all([
    readRuntimeNumber(db, CARDS_PAGE_DEFAULT_KEY, tenantId, { min: 1, max: 1000 }),
    readRuntimeNumber(db, CARDS_PAGE_MAX_KEY, tenantId, { min: 1, max: 1000 }),
  ]);
  const cap = max ?? CARD_LIMIT_FALLBACKS.pageMax;
  const asInt = (v: unknown) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
  const lim = asInt(q.limit);
  const off = asInt(q.offset);
  return {
    limit: Number.isFinite(lim) && lim >= 1 ? Math.min(lim, cap) : Math.min(def ?? CARD_LIMIT_FALLBACKS.pageDefault, cap),
    offset: Number.isFinite(off) && off >= 0 ? off : 0,
  };
}

// ── Serviço alvo ───────────────────────────────────────────────────────────────────────────────
export type CardTarget =
  | { ok: true; rootId: string; head: LineageHead }
  | { ok: false; status: number; code: string; message: string; services?: Array<{ projectId: string; title: string | null; versionNumber: number }> };

/**
 * Um serviço por card. Com `projectId` (qualquer versão da linhagem) resolve a raiz e o HEAD; sem ele, o produto precisa ter
 * exatamente UM serviço com versão aceita (senão 400 SERVICE_REQUIRED com a lista).
 */
export async function resolveCardTarget(db: Db, user: AuthUser, productId: string, projectId: string | null): Promise<CardTarget> {
  if (projectId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return { ok: false, status: 400, code: "BAD_REQUEST", message: "Projeto-alvo inválido para este produto." };
    }
    const proj = (await db.query("SELECT id, tenant_id, created_by, product_id FROM projects WHERE id = $1", [projectId])).rows[0] as
      { id: string; tenant_id: string | null; created_by: string | null; product_id: string | null } | undefined;
    if (!proj || !canAccessProjectRow(user, proj) || proj.product_id !== productId) {
      return { ok: false, status: 400, code: "BAD_REQUEST", message: "Projeto-alvo inválido para este produto." };
    }
    const root = await resolveLineageRoot(db, projectId);
    const head = root ? await resolveLineageHead(db, root.id) : null;
    if (!root || !head) return { ok: false, status: 409, code: "NO_ACCEPTED_HEAD", message: "A linhagem do projeto-alvo não tem versão aceita para evoluir." };
    return { ok: true, rootId: root.id, head };
  }
  const accepted = (await db.query("SELECT id FROM projects WHERE product_id = $1 AND status = 'accepted'", [productId])).rows as Array<{ id: string }>;
  const heads = new Map<string, { rootId: string; head: LineageHead }>();
  for (const a of accepted) {
    const root = await resolveLineageRoot(db, a.id);
    if (!root || heads.has(root.id)) continue;
    const head = await resolveLineageHead(db, root.id);
    if (head) heads.set(root.id, { rootId: root.id, head });
  }
  const list = [...heads.values()];
  if (list.length === 0) return { ok: false, status: 409, code: "NO_ACCEPTED_HEAD", message: "O produto não tem serviço com versão aceita para evoluir." };
  if (list.length > 1) {
    return {
      ok: false, status: 400, code: "SERVICE_REQUIRED",
      message: "O produto tem mais de um serviço: informe 'projectId' (um serviço por card).",
      services: list.map((h) => ({ projectId: h.head.id, title: h.head.title, versionNumber: h.head.version_number })),
    };
  }
  return { ok: true, rootId: list[0].rootId, head: list[0].head };
}

// ── Anexos ────────────────────────────────────────────────────────────────────────────────────
export interface IncomingFile { filename: string; buffer: Buffer; mimeType: string }

async function storeAttachments(client: PoolClient, ticketId: string, files: IncomingFile[], strict: boolean): Promise<void> {
  if (files.length === 0) return;
  const { mkdirSync, writeFileSync } = await import("fs");
  const dir = ticketUploadDir(ticketId);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const dest = join(dir, f.filename);
    writeFileSync(dest, f.buffer);
    if (strict) {
      await client.query(
        `INSERT INTO ticket_attachments (ticket_id, filename, file_path, mime_type, size_bytes, content_sha256, kind, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'upload')`,
        [ticketId, f.filename, dest, f.mimeType, f.buffer.length, sha256Hex(f.buffer), classifyAttachment(f.filename) ?? "card_only"],
      );
    } else {
      await client.query(
        `INSERT INTO ticket_attachments (ticket_id, filename, file_path, mime_type, size_bytes, content_sha256)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ticketId, f.filename, dest, f.mimeType, f.buffer.length, sha256Hex(f.buffer)],
      );
    }
  }
}

// ── Criação ───────────────────────────────────────────────────────────────────────────────────
export type CreateCardResult =
  | { kind: "created"; card: CardRow; draftProjectId: string; strictAttachments: boolean }
  | { kind: "budget_missing"; headProjectId: string; versionNumber: number }
  | { kind: "attachment_unreadable"; message: string };

export async function createCard(pool: Pool, a: {
  user: AuthUser; product: { id: string; tenant_id: string | null }; target: { rootId: string; head: LineageHead };
  kind: CardKind; title: string; body: string; files: IncomingFile[];
}): Promise<CreateCardResult> {
  const client = await pool.connect();
  const strict = await attachmentsStrictEnabled(pool, a.product.tenant_id);
  try {
    await client.query("BEGIN");
    // Orçamento COMPARTILHADO com o dono da versão corrente (H §6): o rascunho grava o dono TERMINAL; sem dono na cadeia, fail-closed.
    const anchor = await resolveBudgetAnchor(client, a.target.head.id);
    if (!anchor) {
      await client.query("ROLLBACK");
      return { kind: "budget_missing", headProjectId: a.target.head.id, versionNumber: a.target.head.version_number };
    }
    const number = await allocTicketNumber(client, a.product.id);
    const ins = await client.query(
      `INSERT INTO tickets (tenant_id, product_id, project_id, number, title, body, change_kind, status, created_by,
                            card_state, origin, card_contract_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, 'draft', 'manual', $9) RETURNING *`,
      [a.product.tenant_id, a.product.id, a.target.head.id, number, a.title, a.body, a.kind, a.user.id, CARD_CONTRACT_VERSION],
    );
    const ticket = ins.rows[0] as CardRow;
    await storeAttachments(client, ticket.id, a.files, strict);

    const code = ticketCode(number);
    const draftExtra: Json = {
      card: true, evolution: true,
      card_ticket_id: ticket.id, card_ticket_number: number, card_ticket_kind: a.kind,
      evolution_parent_id: a.target.head.id, card_target_root_id: a.target.rootId,
      card_base: { head_project_id: a.target.head.id, head_version: a.target.head.version_number },
    };
    const d = await client.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id, extra, updated_at)
       VALUES ($1, $2, $3, 'card_draft', $4, NULL, 0, $5, $6::jsonb, now()) RETURNING id`,
      [a.product.tenant_id, a.user.id, `${code} — ${a.title}`.slice(0, 300), a.product.id, anchor.ownerId, JSON.stringify(draftExtra)],
    );
    const draftId = String(d.rows[0].id);
    await client.query("UPDATE tickets SET draft_project_id = $2 WHERE id = $1", [ticket.id, draftId]);
    await recordCardEvent(client, { ticketId: ticket.id, from: null, to: "draft", actorKind: "user", actorId: a.user.id, dedupeKey: "create" });

    // Só a pasta do card na árvore do rascunho (request.md + anexos de texto). Nada do HEAD, nada de apps/, nenhum clone.
    const mat = await materializeTicketIntoSpecTree(client, {
      ticket, childProjectId: draftId, authorEmail: a.user.email, projectTitle: String(a.target.head.title ?? ""), versionLabel: null,
    });
    if (!mat.ok) {
      await client.query("ROLLBACK");
      if (mat.errorKind === "permanent") return { kind: "attachment_unreadable", message: mat.error ?? "anexo ilegível" };
      throw new Error(`materialização do rascunho falhou: ${mat.error ?? "erro desconhecido"}`);
    }
    await client.query("UPDATE project_spec_files SET spec_origin = $2 WHERE project_id = $1 AND spec_origin IS NULL", [draftId, `card:${code}`]);
    await client.query("COMMIT");
    return { kind: "created", card: ticket, draftProjectId: draftId, strictAttachments: strict };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// ── Edição de texto ───────────────────────────────────────────────────────────────────────────
export type CardEditResult =
  | { kind: "updated"; card: CardRow }
  | { kind: "not_found" }
  | { kind: "not_a_card" }
  | { kind: "not_editable"; state: CardState }
  /** Fase 3 (3.3): card `ready` — a spec do rascunho está TRAVADA até o `reopen` explícito (409 CARD_SPEC_LOCKED). */
  | { kind: "spec_locked"; state: CardState }
  | { kind: "empty_body" }
  | { kind: "attachment_unreadable"; message: string }
  | { kind: "transition_failed"; result: CardTransitionResult };

/**
 * Atualiza título/corpo/tipo enquanto `draft|refining`. Reescreve o `request.md` do rascunho (a spec do card é a verdade que a
 * promoção copia). `draft → refining` na 1ª escrita. Fase 3 (3.3): com o card `ready` a spec está TRAVADA (`spec_locked`, 409
 * CARD_SPEC_LOCKED) até o `reopen` explícito — a edição de texto deixou de reabrir o card sozinha (antes: `autoRefine`, H §4.4).
 */
export async function applyCardTextEdit(pool: Pool, ticketId: string, patch: { title?: string; body?: string; kind?: CardKind }, o: { actorId: string; actorEmail?: string | null }): Promise<CardEditResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = (await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [ticketId])).rows[0] as CardRow | undefined;
    if (!cur) { await client.query("ROLLBACK"); return { kind: "not_found" }; }
    if (!cur.card_state) { await client.query("ROLLBACK"); return { kind: "not_a_card" }; }
    if (cur.card_state === "ready") { await client.query("ROLLBACK"); return { kind: "spec_locked", state: cur.card_state }; }
    const editable = cur.card_state === "draft" || cur.card_state === "refining";
    if (!editable) { await client.query("ROLLBACK"); return { kind: "not_editable", state: cur.card_state }; }
    const title = patch.title !== undefined ? patch.title.trim().slice(0, MAX_CARD_TITLE) : cur.title;
    const body = patch.body !== undefined ? patch.body.trim().slice(0, MAX_CARD_BODY) : cur.body;
    if (!body) { await client.query("ROLLBACK"); return { kind: "empty_body" }; }
    const kind = patch.kind ?? (cur.change_kind as CardKind);
    const up = await client.query(
      `UPDATE tickets SET title = $2, body = $3, change_kind = $4, updated_at = now() WHERE id = $1 AND card_state = $5 RETURNING *`,
      [cur.id, title || cur.title, body, kind, cur.card_state],
    );
    const row = up.rows[0] as CardRow | undefined;
    if (!row) { await client.query("ROLLBACK"); return { kind: "not_editable", state: cur.card_state }; }
    // 1ª escrita na spec do rascunho: draft → refining. (`ready` já saiu acima: travado até o `reopen`.)
    if (cur.card_state === "draft") {
      const t = await transitionCard(client, { ticketId: cur.id, to: "refining", actorKind: "user", actorId: o.actorId });
      if (t.kind !== "applied" && t.kind !== "noop") { await client.query("ROLLBACK"); return { kind: "transition_failed", result: t }; }
    }
    if (row.draft_project_id) {
      const head = row.project_id ? (await client.query("SELECT title FROM projects WHERE id = $1", [row.project_id])).rows[0] as { title?: string } | undefined : undefined;
      const mat = await materializeTicketIntoSpecTree(client, {
        ticket: row, childProjectId: row.draft_project_id, authorEmail: o.actorEmail ?? null, projectTitle: String(head?.title ?? ""), versionLabel: null,
      });
      if (!mat.ok) {
        await client.query("ROLLBACK");
        if (mat.errorKind === "permanent") return { kind: "attachment_unreadable", message: mat.error ?? "anexo ilegível" };
        throw new Error(`materialização do rascunho falhou: ${mat.error ?? "erro desconhecido"}`);
      }
      await client.query("UPDATE project_spec_files SET spec_origin = $2 WHERE project_id = $1 AND spec_origin IS NULL", [row.draft_project_id, `card:${ticketCode(row.number)}`]);
      await client.query(
        `UPDATE projects SET title = $2, extra = COALESCE(extra, '{}'::jsonb) || $3::jsonb, updated_at = now() WHERE id = $1 AND status = 'card_draft'`,
        [row.draft_project_id, `${ticketCode(row.number)} — ${title || row.title}`.slice(0, 300), JSON.stringify({ card_ticket_kind: kind })],
      );
    }
    await client.query("COMMIT");
    const fresh = (await pool.query("SELECT * FROM tickets WHERE id = $1", [cur.id])).rows[0] as CardRow;
    return { kind: "updated", card: fresh };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// ── Exclusão ──────────────────────────────────────────────────────────────────────────────────
export type CardDeleteResult = { kind: "deleted" } | { kind: "not_found" } | { kind: "not_deletable"; state: string };

/** Só `draft`. CAS NO BANCO (`WHERE card_state = 'draft'`): em corrida com refine/ready/promote só um vence. */
export async function deleteCard(pool: Pool, ticketId: string): Promise<CardDeleteResult> {
  const cur = await loadCard(pool, ticketId);
  if (!cur) return { kind: "not_found" };
  if (cur.card_state !== "draft") return { kind: "not_deletable", state: String(cur.card_state ?? cur.status) };
  const client = await pool.connect();
  let draftId: string | null = null;
  try {
    await client.query("BEGIN");
    const del = await client.query("DELETE FROM tickets WHERE id = $1 AND card_state = 'draft' AND status = 'open' RETURNING draft_project_id", [ticketId]);
    if ((del.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      const now = await loadCard(pool, ticketId);
      return now ? { kind: "not_deletable", state: String(now.card_state ?? now.status) } : { kind: "not_found" };
    }
    draftId = (del.rows[0].draft_project_id as string | null) ?? null;
    if (draftId) await client.query("DELETE FROM projects WHERE id = $1 AND status = 'card_draft'", [draftId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  if (draftId) {
    const { rm } = await import("fs/promises");
    await rm(join((process.env.UPLOAD_DIR ?? "/shared/uploads").trim(), draftId), { recursive: true, force: true }).catch(() => undefined);
  }
  return { kind: "deleted" };
}

// ── Validar ("ready") ─────────────────────────────────────────────────────────────────────────
export type CardReadyResult =
  | { kind: "ready"; replayed: boolean; gate: Extract<CardKindGateResult, { ok: true }> | null }
  | { kind: "gate_failed"; gate: Extract<CardKindGateResult, { ok: false }> }
  | { kind: "budget"; status: number; body: Json }
  | { kind: "no_head" }
  | { kind: "draft_unreadable" }
  /** Y-07: há conversão de anexo (pdf/doc/docx → .md) ainda em andamento. */
  | { kind: "conversion_pending"; open: Array<{ id: string; filename: string; state: string }> }
  /** Y-02: o rascunho tem arquivo cujo caminho já existe na versão corrente. */
  | { kind: "base_collision"; paths: string[] }
  /** Y-01: a spec (ou os anexos) mudou entre a leitura e o carimbo; nada foi gravado. */
  | { kind: "spec_changed" }
  | { kind: "transition_failed"; result: CardTransitionResult };

async function draftOf(db: Db, card: CardRow): Promise<{ id: string; extra: Json } | null> {
  if (!card.draft_project_id) return null;
  const r = (await db.query("SELECT id, extra FROM projects WHERE id = $1 AND status = 'card_draft'", [card.draft_project_id])).rows[0] as { id: string; extra: Json | null } | undefined;
  return r ? { id: r.id, extra: r.extra ?? {} } : null;
}

/** Ganchos SÓ para teste: reproduzem de forma determinística a janela da sonda P4 (a escrita concorrente exatamente entre duas etapas do `ready`). */
export const cardReadyTestHooks: { afterSnapshot?: () => Promise<void>; afterCommit?: () => Promise<void> } = {};

export interface CardReadySnapshot {
  draft_spec_hash: string; base_head_project_id: string; base_head_version: number; base_spec_hash: string | null; at: string;
  /** Y-07: hash do conjunto de anexos com o estado da conversão (ausente em carimbos anteriores à correção). */
  attachments_hash?: string;
}

/** Hash da spec corrente de um projeto (disco é a verdade) ou `null` (sem arquivos / arquivo sumiu). */
export async function specHashOf(db: Db, projectId: string): Promise<string | null> {
  const h = await computeCurrentSpecHash(db as unknown as Parameters<typeof computeCurrentSpecHash>[0], projectId).catch(() => null);
  return h?.specHash ?? null;
}

/**
 * "Validar": gate de RFC invariante + exigências do tipo + orçamento (Guard + saldo livre mínimo) + base registrada (HEAD e hash da spec do
 * HEAD). OK ⇒ `draft|refining → ready` (ator `system`, o usuário vai em `actor_id`).
 *
 * Y-01 (BLOQUEANTE na revisão adversarial da Fase 3): antes, o gate lia o rascunho, depois o hash lia de novo, sem transação — um
 * `DELETE` do RFC entre as duas leituras ficava COBERTO pelo carimbo (`ready` sem RFC, promoção criando filho sem RFC). Agora:
 *   1. a spec do rascunho é lida UMA vez (`computeCurrentSpecHash` devolve o conteúdo); o hash do carimbo e o gate são calculados
 *      sobre ESSE mesmo conteúdo;
 *   2. carimbo + transição `→ ready` + parada dos laços autônomos do rascunho (Y-23) ocorrem na MESMA transação, sob `FOR UPDATE` do
 *      ticket, que antes de gravar RELÊ a spec e os anexos e desiste (`spec_changed`) se o hash diferir;
 *   3. depois do COMMIT a spec é relida uma vez mais: escrita que passou pela guarda antes do `ready` e terminou depois derruba o card
 *      de volta a `refining` (`spec_changed`). Os escritores também chamam `noteCardSpecWrite`, que faz o mesmo caminho inverso.
 * A promoção ainda confere hash e gate dentro do lock (evolveClaim).
 */
export async function markCardReady(pool: Pool, card: CardRow, user: AuthUser): Promise<CardReadyResult> {
  if (card.card_state === "ready") return { kind: "ready", replayed: true, gate: null };
  const draft = await draftOf(pool, card);
  if (!draft) return { kind: "draft_unreadable" };
  const kind = (isCardKind(card.change_kind) ? card.change_kind : "evolution") as CardKind;

  // Y-07: conversão de anexo em andamento ainda pode gerar texto que nenhum validador viu.
  let att0 = await cardAttachmentsSnapshot(pool, card);
  // AB-06: anexo `queued` = convertível, conversão ligada e SEM linha na fila (enviado com a conversão desligada, ou o `kick` do upload
  // falhou). Nada mais o enfileiraria: "Validar" enfileira e dispara a conversão agora, para a espera terminar sozinha.
  if (att0.open.some((o) => o.state === "queued")) {
    const { kickTicketConversions } = await import("./attachmentConversionQueue.js");
    await kickTicketConversions(pool as never, card.tenant_id, card.id);
    att0 = await cardAttachmentsSnapshot(pool, card);
  }
  if (att0.open.length > 0) return { kind: "conversion_pending", open: att0.open };

  // (1) leitura única: conteúdo + hash
  const snap = await computeCurrentSpecHash(pool, draft.id).catch(() => null);
  if (!snap) return { kind: "draft_unreadable" };
  const gate = await evaluateCardKindGate(pool, draft.id, draft.extra, kind, {
    files: snap.files.map((f) => ({ filename: f.filename, rel_dir: f.rel_dir ?? null, content: f.content, contentSha256: f.contentSha256 })),
  });
  if (!gate.ok) return { kind: "gate_failed", gate };
  await cardReadyTestHooks.afterSnapshot?.();

  // Y-02: nenhum arquivo do rascunho pode reescrever o que a versão corrente já tem.
  const info = await loadCardDraftInfo(pool as never, draft.id);
  if (info) {
    const clash = await findBaseCollisions(pool as never, info, snap.files.map((f) => ({ rel_dir: f.rel_dir ?? null, filename: f.filename })));
    if (clash.length > 0) return { kind: "base_collision", paths: clash };
  }

  const rootId = String(draft.extra.card_target_root_id ?? "");
  const head = rootId ? await resolveLineageHead(pool, rootId) : null;
  if (!head) return { kind: "no_head" };
  const denied = await budgetPreflight(pool, head.id, card.tenant_id, head.version_number);
  if (denied) return { kind: "budget", status: denied.status, body: denied.body };

  const baseSpecHash = await specHashOf(pool, head.id);
  const snapshot: CardReadySnapshot = {
    draft_spec_hash: snap.specHash, base_head_project_id: head.id, base_head_version: head.version_number,
    base_spec_hash: baseSpecHash, at: new Date().toISOString(), attachments_hash: att0.hash,
  };

  // (2) carimbo + transição + parada dos laços autônomos: UMA transação, ticket travado.
  const client = await pool.connect();
  let out: CardReadyResult;
  try {
    await client.query("BEGIN");
    const locked = (await client.query("SELECT card_state FROM tickets WHERE id = $1 FOR UPDATE", [card.id])).rows[0] as { card_state: string | null } | undefined;
    if (!locked) { await client.query("ROLLBACK"); return { kind: "transition_failed", result: { kind: "not_found" } }; }
    const again = await computeCurrentSpecHash(client, draft.id).catch(() => null);
    const attAgain = await cardAttachmentsSnapshot(client as never, card);
    if (!again || again.specHash !== snap.specHash || attAgain.hash !== att0.hash) {
      await client.query("ROLLBACK");
      return { kind: "spec_changed" };
    }
    await client.query(
      `UPDATE projects SET extra = COALESCE(extra, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1 AND status = 'card_draft'`,
      [draft.id, JSON.stringify({ card_ready: snapshot, evolution_parent_id: head.id, card_base: { head_project_id: head.id, head_version: head.version_number } })],
    );
    const t = await transitionCard(client, { ticketId: card.id, to: "ready", actorKind: "system", actorId: user.id, reason: "validated" });
    if (t.kind !== "applied" && t.kind !== "noop") {
      await client.query("ROLLBACK");
      return { kind: "transition_failed", result: t };
    }
    // Y-23: o card está pronto — rodada do modo autônomo ainda ativa neste rascunho não pode mais escrever por cima do carimbo.
    await client.query(
      `UPDATE spec_autonomy_runs
          SET status = 'stalled', last_error = $2, finished_at = now(), updated_at = now()
        WHERE project_id = $1 AND status IN ('pending','cto_running','applying','validating')`,
      [draft.id, "Card validado (ready): o modo autônomo foi encerrado para não alterar a spec depois do carimbo. Reabra o card para voltar a editar."],
    );
    // AB-01: gerador de RFC (planner) ainda em voo neste rascunho não pode mais gravar depois do carimbo. O job é encerrado aqui; o
    // próprio planner também reconfere a trava (sob o lock do ticket) antes de cada gravação.
    await client.query(
      `UPDATE evolution_plan_jobs
          SET status = 'interrupted', error = $2, finished_at = now(), updated_at = now()
        WHERE project_id = $1 AND status IN ('pending','running')`,
      [draft.id, "Card validado (ready): a geração de RFC em andamento foi encerrada para não alterar a spec depois do carimbo. Reabra o card para gerar de novo."],
    );
    await client.query("COMMIT");
    out = { kind: "ready", replayed: t.kind === "noop", gate };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  await cardReadyTestHooks.afterCommit?.();
  // (3) conferência pós-commit: escrita concorrente que terminou depois do carimbo ⇒ o carimbo não vale; volta a `refining`.
  const post = await computeCurrentSpecHash(pool, draft.id).catch(() => null);
  const attPost = await cardAttachmentsSnapshot(pool, card);
  if (!post || post.specHash !== snap.specHash || attPost.hash !== att0.hash) {
    const t = await transitionCard(pool, { ticketId: card.id, to: "refining", actorKind: "system", actorId: user.id, reason: "spec_changed_during_validate" });
    if (t.kind === "applied") {
      await pool.query(
        `UPDATE projects SET extra = COALESCE(extra, '{}'::jsonb) - 'card_ready', updated_at = now() WHERE id = $1 AND status = 'card_draft'`,
        [draft.id],
      );
    }
    return { kind: "spec_changed" };
  }
  return out;
}

/**
 * Y-07: uma conversão pdf/doc/docx → .md terminou DEPOIS da criação do card. O derivado vive em `ticket_attachments`; ele só entra na
 * árvore do rascunho quando a pasta do ticket é rematerializada.
 *   • `draft|refining` ⇒ rematerializa `tickets/TK-NNNN/` no rascunho (o texto novo passa a existir para Chat, GAPs e validador);
 *   • `ready` ⇒ o carimbo não viu esse texto: `ready → refining` (ator `system`, motivo `attachment_converted`), carimbo descartado e
 *     pasta rematerializada — "Validar" de novo;
 *   • demais estados ⇒ nada (o rascunho é histórico; o filho já pegou o texto pelo passo `ticket` da promoção).
 */
export async function syncCardAfterConversion(pool: Pool, ticketId: string): Promise<"none" | "rematerialized" | "reopened"> {
  const card = await loadCard(pool, ticketId);
  if (!card?.card_state || !card.draft_project_id) return "none";
  const st = card.card_state;
  if (st !== "draft" && st !== "refining" && st !== "ready") return "none";
  let reopened = false;
  if (st === "ready") {
    const t = await transitionCard(pool, { ticketId: card.id, to: "refining", actorKind: "system", reason: "attachment_converted" });
    if (t.kind !== "applied") return "none";
    reopened = true;
    await pool.query(`UPDATE projects SET extra = COALESCE(extra, '{}'::jsonb) - 'card_ready', updated_at = now() WHERE id = $1 AND status = 'card_draft'`, [card.draft_project_id]);
  }
  const head = card.project_id ? (await pool.query("SELECT title FROM projects WHERE id = $1", [card.project_id])).rows[0] as { title?: string } | undefined : undefined;
  const author = card.created_by ? (await pool.query("SELECT email FROM users WHERE id = $1", [card.created_by]).catch(() => ({ rows: [] as Array<{ email?: string }> }))).rows[0] as { email?: string } | undefined : undefined;
  const mat = await materializeTicketIntoSpecTree(pool, {
    ticket: card, childProjectId: card.draft_project_id, authorEmail: author?.email ?? null, projectTitle: String(head?.title ?? ""), versionLabel: null,
  });
  if (mat.ok) await pool.query("UPDATE project_spec_files SET spec_origin = $2 WHERE project_id = $1 AND spec_origin IS NULL", [card.draft_project_id, `card:${ticketCode(card.number)}`]);
  return reopened ? "reopened" : mat.ok ? "rematerialized" : "none";
}

// ── Revalidar (rebase + conferência contra o HEAD novo) ──────────────────────────────────────
export type CardRevalidateResult =
  | {
      kind: "revalidated"; verdict: RevalidateVerdict; reasons: RevalidateReason[]; globs: GlobCheck[]; repo: RevalidateOutcome["repo"];
      specDiff: RevalidateOutcome["specDiff"]; headProjectId: string; headVersion: number; previousBase: string | null;
      /** O ponteiro de base do card foi movido para o HEAD corrente (só em `stale`). */
      rebased: boolean;
      /** O card voltou de `ready` a `refining` (carimbo "pronto" invalidado). */
      reopened: boolean;
    }
  | { kind: "not_revalidable"; state: CardState }
  | { kind: "no_head" }
  | { kind: "draft_unreadable" }
  | { kind: "transition_failed"; result: CardTransitionResult };

/** Globs `files_allowed` + texto dos RFCs do rascunho (`docs/rfc/RFC-NNNN-*.md`). */
async function draftRfcsForRevalidation(db: Db, draftId: string): Promise<Array<{ path: string; filesAllowed: string[]; text: string }>> {
  const rows = (await db.query(
    "SELECT filename, file_path, rel_dir FROM project_spec_files WHERE project_id = $1 ORDER BY filename ASC", [draftId],
  )).rows as Array<{ filename: string; file_path: string; rel_dir: string | null }>;
  const { readFile } = await import("fs/promises");
  const out: Array<{ path: string; filesAllowed: string[]; text: string }> = [];
  for (const r of rows) {
    const rel = (r.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
    if (rel.toLowerCase() !== RFC_DIR || !RFC_FILENAME_RE.test(r.filename)) continue;
    const text = await readFile(r.file_path, "utf-8").catch(() => null);
    if (text === null) continue;
    const path = `${rel}/${r.filename}`;
    out.push({ path, filesAllowed: parseRfcMarkdown(path, text).filesAllowed, text });
  }
  return out;
}

/**
 * "Revalidar card" (H §5.4, 3.5): confere o card contra o HEAD CORRENTE e devolve `ok | stale | conflict` com motivos
 * (`cardRevalidate.ts`). Efeitos (todos pela máquina de estados / UPDATE guardado por `status = 'card_draft'`):
 *   • `ok`       — nada muda (a base já era o HEAD): o card continua onde está, `ready` inclusive;
 *   • `stale`    — rebaseia (`card_base`, `evolution_parent_id`, dono do orçamento compartilhado), invalida o carimbo `card_ready` e
 *                  devolve `ready → refining`: a validação (gate de RFC + tipo + orçamento) precisa ser refeita contra a base nova;
 *   • `conflict` — NÃO rebaseia (o RFC precisa ser ajustado antes), invalida o carimbo e devolve `ready → refining`.
 * Nada do RFC é reescrito automaticamente.
 */
export async function revalidateCard(pool: Pool, card: CardRow, user: AuthUser): Promise<CardRevalidateResult> {
  const state = card.card_state;
  if (state !== "draft" && state !== "refining" && state !== "ready") return { kind: "not_revalidable", state: state as CardState };
  const draft = await draftOf(pool, card);
  if (!draft) return { kind: "draft_unreadable" };
  const rootId = String(draft.extra.card_target_root_id ?? "");
  const head = rootId ? await resolveLineageHead(pool, rootId) : null;
  if (!head) return { kind: "no_head" };
  const previousBase = ((draft.extra.card_base ?? {}) as Json).head_project_id as string | undefined ?? null;
  const ready = (draft.extra.card_ready ?? null) as CardReadySnapshot | null;
  const baseMoved = !!previousBase && previousBase !== head.id;

  const headSpecHash = await specHashOf(pool, head.id);
  const headSpecHashChanged = !baseMoved && !!ready?.base_spec_hash && ready.base_head_project_id === head.id && headSpecHash !== ready.base_spec_hash;
  // Y-13: a árvore lida é a do COMMIT aceito (`evolution_head_sha` da versão), não a cópia de trabalho do disco.
  const acceptedSha = async (projectId: string): Promise<string | null> => {
    const r = (await pool.query("SELECT extra->>'evolution_head_sha' AS sha FROM projects WHERE id = $1", [projectId])).rows[0] as { sha: string | null } | undefined;
    return r?.sha ?? null;
  };
  const [headSha, prevSha] = await Promise.all([acceptedSha(head.id), baseMoved ? acceptedSha(previousBase!) : Promise.resolve(null)]);
  const [rfcs, treeNow, treeBefore, specNow, specBefore] = await Promise.all([
    draftRfcsForRevalidation(pool, draft.id),
    listRepoTree(head.id, head.product_id, process.env, { ref: headSha }),
    baseMoved ? listRepoTree(previousBase!, head.product_id, process.env, { ref: prevSha }) : Promise.resolve(null),
    listSpecSnapshot(pool, head.id),
    baseMoved ? listSpecSnapshot(pool, previousBase!) : Promise.resolve(null),
  ]);
  const out = evaluateRevalidation({
    rfcs, requestText: `${card.title}\n${card.body}`, previousBase, head: { id: head.id, version: head.version_number },
    productId: head.product_id, specNow, specBefore: specBefore && specBefore.length > 0 ? specBefore : null, treeNow, treeBefore,
    headSpecHashChanged,
  });

  const rebase = out.verdict === "stale";
  const invalidate = out.verdict !== "ok";
  if (rebase || invalidate) {
    const patch: Json = {};
    // Y-13: a jornada mostra o bloqueador "globs não conferidos" enquanto o veredito `stale` veio sem conferência dos globs.
    if (out.globsUnverified) patch.card_revalidation = { globs_unverified: true, head_project_id: head.id, at: new Date().toISOString() };
    if (rebase) {
      patch.evolution_parent_id = head.id;
      patch.card_base = { head_project_id: head.id, head_version: head.version_number };
    }
    // Orçamento compartilhado com o dono da versão corrente: acompanha a base quando ela é movida.
    if (rebase) {
      const anchor = await resolveBudgetAnchor(pool, head.id).catch(() => null);
      if (anchor) await pool.query("UPDATE projects SET budget_owner_project_id = $2 WHERE id = $1 AND status = 'card_draft'", [draft.id, anchor.ownerId]);
    }
    await pool.query(
      `UPDATE projects SET extra = (COALESCE(extra, '{}'::jsonb) - 'card_ready' - 'card_revalidation') || $2::jsonb, updated_at = now() WHERE id = $1 AND status = 'card_draft'`,
      [draft.id, JSON.stringify(patch)],
    );
  } else if ((draft.extra.card_revalidation ?? null) !== null) {
    // veredito `ok` (a base já é o HEAD): a conferência humana pedida pelo `stale` anterior foi feita.
    await pool.query("UPDATE projects SET extra = COALESCE(extra, '{}'::jsonb) - 'card_revalidation', updated_at = now() WHERE id = $1 AND status = 'card_draft'", [draft.id]);
  }
  let reopened = false;
  if (invalidate && state === "ready") {
    const t = await transitionCard(pool, { ticketId: card.id, to: "refining", actorKind: "system", actorId: user.id, reason: "revalidate_base" });
    if (t.kind !== "applied" && t.kind !== "noop") return { kind: "transition_failed", result: t };
    reopened = t.kind === "applied";
  }
  return {
    kind: "revalidated", verdict: out.verdict, reasons: out.reasons, globs: out.globs, repo: out.repo, specDiff: out.specDiff,
    headProjectId: head.id, headVersion: head.version_number, previousBase, rebased: rebase, reopened,
  };
}

// ── Reabrir (ready → refining) ───────────────────────────────────────────────────────────────
export type CardReopenResult =
  | { kind: "reopened"; replayed: boolean }
  | { kind: "not_reopenable"; state: CardState | null }
  | { kind: "transition_failed"; result: CardTransitionResult };

/**
 * `reopen` (Fase 3, 3.3): a transição EXPLÍCITA `ready → refining` que destrava a spec do rascunho (`CARD_SPEC_LOCKED` até aqui).
 * Pela máquina de estados (ator `user`, motivo `user_reopen`, evento em `ticket_card_events`) e invalida o carimbo `card_ready`
 * do rascunho: a promoção volta a exigir "Validar". Já em `refining` ⇒ repetição segura (`replayed`). Outros estados ⇒ `not_reopenable`.
 */
export async function reopenCard(pool: Pool, card: CardRow, user: AuthUser): Promise<CardReopenResult> {
  if (card.card_state === "refining") return { kind: "reopened", replayed: true };
  if (card.card_state !== "ready") return { kind: "not_reopenable", state: card.card_state };
  const t = await transitionCard(pool, { ticketId: card.id, to: "refining", actorKind: "user", actorId: user.id, reason: "user_reopen" });
  if (t.kind !== "applied" && t.kind !== "noop") return { kind: "transition_failed", result: t };
  if (card.draft_project_id) {
    await pool.query(
      `UPDATE projects SET extra = COALESCE(extra, '{}'::jsonb) - 'card_ready', updated_at = now() WHERE id = $1 AND status = 'card_draft'`,
      [card.draft_project_id],
    );
  }
  return { kind: "reopened", replayed: t.kind === "noop" };
}

// ── Spec base (somente leitura) ───────────────────────────────────────────────────────────────
export interface BaseSpecFile { path: string; relDir: string; filename: string; isPrimary: boolean; sizeBytes: number; contentSha256: string; content: string | null; truncated: boolean }
export interface BaseSpec {
  readOnly: true; headProjectId: string; headVersion: number; title: string | null; specHash: string | null;
  baseHeadProjectId: string | null; stale: boolean; files: BaseSpecFile[];
}

/** Spec da versão CORRENTE da linhagem (HEAD) — nunca editável por aqui. `stale` compara com a base registrada no card. */
export async function loadBaseSpec(db: Db & RuntimeConfigDb, card: CardRow): Promise<BaseSpec | null> {
  const draft = await draftOf(db, card);
  if (!draft) return null;
  const rootId = String(draft.extra.card_target_root_id ?? "");
  const head = rootId ? await resolveLineageHead(db, rootId) : null;
  if (!head) return null;
  const rows = (await db.query(
    "SELECT filename, file_path, rel_dir, is_primary FROM project_spec_files WHERE project_id = $1 ORDER BY is_primary DESC, rel_dir, filename",
    [head.id],
  )).rows as Array<{ filename: string; file_path: string; rel_dir: string | null; is_primary: boolean }>;
  const cap = (await readRuntimeNumber(db, CARD_BASE_SPEC_MAX_BYTES_KEY, card.tenant_id, { min: 1024, max: 50_000_000 })) ?? CARD_LIMIT_FALLBACKS.baseSpecMaxBytes;
  const { readFile } = await import("fs/promises");
  let used = 0;
  const files: BaseSpecFile[] = [];
  for (const r of rows) {
    const buf = await readFile(r.file_path).catch(() => null);
    if (!buf) continue;
    const rel = (r.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
    const fits = used + buf.length <= cap;
    if (fits) used += buf.length;
    files.push({
      path: rel ? `${rel}/${r.filename}` : r.filename, relDir: rel, filename: r.filename, isPrimary: r.is_primary,
      sizeBytes: buf.length, contentSha256: sha256Hex(buf), content: fits ? buf.toString("utf-8") : null, truncated: !fits,
    });
  }
  const baseHead = ((draft.extra.card_base ?? {}) as Json).head_project_id as string | undefined ?? null;
  return {
    readOnly: true, headProjectId: head.id, headVersion: head.version_number, title: head.title, specHash: await specHashOf(db, head.id),
    baseHeadProjectId: baseHead, stale: baseHead !== null && baseHead !== head.id, files,
  };
}

/** Mesma leitura de `loadBaseSpec`, a partir do id do RASCUNHO (Chat IA / GAPs / planner / validador só conhecem o `projectId`). */
export async function loadBaseSpecForDraft(db: Db & RuntimeConfigDb, draftProjectId: string): Promise<BaseSpec | null> {
  const canonical = toCanonicalUuid(draftProjectId);
  if (!canonical) return null;
  const card = (await db.query("SELECT * FROM tickets WHERE draft_project_id = $1::uuid AND card_state IS NOT NULL", [canonical])).rows[0] as CardRow | undefined;
  return card ? loadBaseSpec(db, card) : null;
}

// ── Saída ─────────────────────────────────────────────────────────────────────────────────────
export function cardKindOf(row: Pick<CardRow, "change_kind">): TicketChangeKind {
  return (CARD_KINDS as readonly string[]).includes(row.change_kind) ? (row.change_kind as TicketChangeKind) : "evolution";
}

export interface CardSummary {
  id: string; code: string; number: number; productId: string; projectId: string | null; kind: TicketChangeKind; title: string;
  state: CardState | null; status: string; origin: string; externalRef: string | null; blockedReason: string | null;
  draftProjectId: string | null; childProjectId: string | null; executionStatus: string | null; executionTitle: string | null;
  prUrl: string | null; attachmentsCount: number; createdAt: Date; updatedAt: Date; promotedAt: Date | null; deliveredAt: Date | null;
  /** 4.5c: saúde da Fábrica derivada dos 5 gates reais do aceite (`null` = filho ainda não aceito/sem gates registrados). */
  factoryHealth: "ok" | "attention" | "failed" | null;
  factoryGates: Record<"scope" | "symbols" | "qa" | "fullTest" | "baseline", { status: "passed" | "failed" | "not_run"; detail: string }> | null;
  /** 4.5c (D-4): o código-base do filho veio do DISCO e não do repositório (pode conter código não mergeado). */
  codeBaseWarning: string | null;
}

/** Resumo de cards (lista/detalhe): junta o estado de EXECUÇÃO do filho (derivado, nunca copiado) e a contagem de anexos. */
export async function summarizeCards(db: Db, rows: CardRow[]): Promise<CardSummary[]> {
  const childIds = rows.map((r) => r.child_project_id).filter((v): v is string => !!v);
  type Gates = NonNullable<CardSummary["factoryGates"]>;
  const exec = new Map<string, { status: string; title: string; pr: string | null; gates: Gates | null; warn: string | null }>();
  if (childIds.length > 0) {
    for (const r of (await db.query("SELECT id, status, title, extra->>'evolution_pr_url' AS pr, extra->'evolution_factory_gates' AS gates, extra->>'evolution_code_base_warning' AS warn FROM projects WHERE id = ANY($1::uuid[])", [childIds])).rows as Array<{ id: string; status: string; title: string; pr: string | null; gates: Record<string, { status?: string; detail?: string }> | null; warn: string | null }>) {
      const g = r.gates && typeof r.gates === "object" ? r.gates : null;
      const clean = g ? Object.fromEntries(FACTORY_GATE_KEYS.map((k) => [k, { status: g[k]?.status ?? "not_run", detail: String(g[k]?.detail ?? "") }])) as Gates : null;
      exec.set(r.id, { status: r.status, title: r.title, pr: r.pr, gates: clean, warn: r.warn });
    }
  }
  const counts = new Map<string, number>();
  if (rows.length > 0) {
    for (const r of (await db.query("SELECT ticket_id, count(*)::int AS n FROM ticket_attachments WHERE ticket_id = ANY($1::uuid[]) GROUP BY ticket_id", [rows.map((r) => r.id)])).rows as Array<{ ticket_id: string; n: number }>) {
      counts.set(r.ticket_id, r.n);
    }
  }
  return rows.map((r) => {
    const e = r.child_project_id ? exec.get(r.child_project_id) : undefined;
    return {
      id: r.id, code: ticketCode(r.number), number: r.number, productId: r.product_id, projectId: r.project_id, kind: cardKindOf(r),
      title: r.title, state: r.card_state, status: r.status, origin: r.origin, externalRef: r.external_ref, blockedReason: r.blocked_reason,
      draftProjectId: r.draft_project_id, childProjectId: r.child_project_id, executionStatus: e?.status ?? null, executionTitle: e?.title ?? null,
      prUrl: e?.pr ?? null, attachmentsCount: counts.get(r.id) ?? 0, createdAt: r.created_at, updatedAt: r.updated_at,
      promotedAt: r.promoted_at, deliveredAt: r.delivered_at,
      factoryHealth: factoryHealthOf(e?.gates ?? null), factoryGates: e?.gates ?? null, codeBaseWarning: e?.warn ?? null,
    };
  });
}

// ── Roteamento dos escritores LEGADOS de ticket pela máquina (2.6 d) ─────────────────────────────
export type LegacyPatchResult =
  | { kind: "ok"; row: CardRow }
  | { kind: "error"; status: number; body: Json };

/**
 * `PATCH /api/tickets/:id` sobre um ticket que JÁ É card (`card_state` não nulo): o contrato de resposta do ticket é mantido
 * (a rota devolve a linha hidratada), mas as escritas passam por `applyCardTextEdit`/`transitionCard` — nunca por `UPDATE status`.
 *   • texto (title/body/changeKind): draft|refining; `ready` ⇒ 409 CARD_SPEC_LOCKED (Fase 3: reabrir é explícito); depois disso 409 TICKET_IMMUTABLE como antes;
 *   • status `rejected` ⇒ transição `→ rejected` (humano); `delivered` ⇒ 409 CARD_DELIVERY_IS_AUTOMATIC (a 4.3 marca);
 *     `open` ⇒ no-op se o card ainda está em draft|refining|ready, senão 409 (só o descarte do filho reabre).
 */
export async function legacyPatchCard(pool: Pool, card: CardRow, b: { title?: string; body?: string; changeKind?: string; status?: string }, user: AuthUser): Promise<LegacyPatchResult> {
  const code = ticketCode(card.number);
  const wantsContent = b.title !== undefined || b.body !== undefined || b.changeKind !== undefined;
  if (b.changeKind !== undefined && !isCardKind(b.changeKind)) return { kind: "error", status: 400, body: { code: "BAD_REQUEST", message: "changeKind inválido." } };
  if (b.body !== undefined && !String(b.body).trim()) return { kind: "error", status: 400, body: { code: "BAD_REQUEST", message: "O pedido não pode ficar vazio." } };
  if (b.status !== undefined && !["open", "rejected", "delivered"].includes(b.status)) {
    return { kind: "error", status: 400, body: { code: "BAD_REQUEST", message: "status deve ser 'open', 'rejected' ou 'delivered'." } };
  }
  if (b.status === "delivered") {
    if (!card.child_project_id) return { kind: "error", status: 409, body: { code: "NOT_PROMOTED", message: "Pedido ainda não foi promovido — não há entrega a marcar." } };
    return { kind: "error", status: 409, body: { code: "CARD_DELIVERY_IS_AUTOMATIC", message: `${code} é um card: a entrega é marcada pelo sistema quando o filho é aceito e o PR é mergeado.` } };
  }
  if (!wantsContent && b.status === undefined) return { kind: "error", status: 400, body: { code: "BAD_REQUEST", message: "Nada a alterar." } };

  let row: CardRow = card;
  if (wantsContent) {
    const r = await applyCardTextEdit(pool, card.id, {
      ...(b.title !== undefined ? { title: String(b.title) } : {}),
      ...(b.body !== undefined ? { body: String(b.body) } : {}),
      ...(b.changeKind !== undefined ? { kind: b.changeKind as CardKind } : {}),
    }, { actorId: user.id, actorEmail: user.email });
    if (r.kind === "spec_locked") {
      return { kind: "error", status: 409, body: { code: "CARD_SPEC_LOCKED", state: r.state, canReopen: true, cardId: card.id, reopen: `POST /api/cards/${card.id}/reopen`, message: `${code} está pronto (ready): a spec está travada. Reabra o card (POST /api/cards/${card.id}/reopen) para voltar a editar.` } };
    }
    if (r.kind === "not_editable") {
      return { kind: "error", status: 409, body: { code: "TICKET_IMMUTABLE", message: `${code} já foi promovido — o pedido original é imutável. Abra um novo pedido para pedir outra coisa.` } };
    }
    if (r.kind === "transition_failed") return { kind: "error", status: 409, body: { code: "CARD_INVALID_TRANSITION", message: `${code}: a edição não pôde mover o card para 'refining'.` } };
    if (r.kind === "attachment_unreadable") return { kind: "error", status: 400, body: { code: "ATTACHMENT_UNREADABLE", message: r.message } };
    if (r.kind !== "updated") return { kind: "error", status: 404, body: { code: "NOT_FOUND", message: "Pedido não encontrado" } };
    row = r.card;
  }
  if (b.status === "rejected") {
    const t = await transitionCard(pool, { ticketId: card.id, to: "rejected", actorKind: "user", actorId: user.id, reason: "manual_patch" });
    if (t.kind === "invalid") return { kind: "error", status: 409, body: { code: "TICKET_INVALID_TRANSITION", from: t.from, to: t.to, allowed: t.allowed, message: `${code}: transição ${t.from} → ${t.to} não é permitida.` } };
    if (t.kind === "diverged") return { kind: "error", status: 409, body: { code: "CARD_DIVERGED", cardState: t.cardState, status: t.status, message: `${code}: o status legado diverge do estado do card.` } };
    if (t.kind !== "applied" && t.kind !== "noop") return { kind: "error", status: 404, body: { code: "NOT_FOUND", message: "Pedido não encontrado" } };
    row = (await loadCard(pool, card.id)) ?? row;
  } else if (b.status === "open") {
    const cur = (await loadCard(pool, card.id)) ?? row;
    if (cur.card_state !== "draft" && cur.card_state !== "refining" && cur.card_state !== "ready") {
      return { kind: "error", status: 409, body: { code: "CARD_INVALID_TRANSITION", from: cur.card_state, to: "open", message: `${code} está em '${cur.card_state}': o pedido só volta a 'open' quando o filho é descartado.` } };
    }
    row = cur;
  }
  return { kind: "ok", row };
}
