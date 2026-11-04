/**
 * cardAttachments.ts — Fase 3 (3.5): listagem dos anexos do card com o ESTADO DA CONVERSÃO (tarefa Q: pdf/doc/docx → `.md`).
 *
 * Reaproveita `ticket_attachments` (originais + derivados `.md`) e `attachment_conversions` (fila durável). Nada é gravado aqui.
 * Estado da conversão, por anexo ORIGINAL:
 *   not_applicable — txt/md (já são texto da spec), derivados e tipos sem conversor;
 *   disabled       — pdf/doc/docx com `ATTACHMENT_CONVERSION` desligada (o original só fica guardado no card);
 *   queued         — conversão ligada e ainda sem linha na fila;
 *   pending | running | done | empty | failed — o estado da linha da fila (`done` traz o derivado; `empty` = sem camada de texto;
 *                    `failed` traz o erro claro e o original segue guardado).
 */
import type { Pool } from "pg";
import { attachmentExt, attachmentsStrictEnabled, classifyAttachment } from "./ticketAttachments.js";
import { attachmentConversionEnabled } from "./attachmentConversionQueue.js";

export type ConversionState = "not_applicable" | "disabled" | "queued" | "pending" | "running" | "done" | "empty" | "failed";

export interface CardAttachmentItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** `spec_text` (txt/md: entra na pasta do card da spec) · `card_only` (pdf/doc/docx: só guardado no card). `null` sem ATTACHMENTS_STRICT. */
  kind: string | null;
  origin: string | null;
  derivedFromAttachmentId: string | null;
  contentSha256: string | null;
  downloadUrl: string;
  createdAt: Date;
  conversion: {
    state: ConversionState;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    warnings: unknown[];
    derivedAttachmentId: string | null;
    updatedAt: Date | null;
  };
}

const CONVERTIBLE = new Set([".pdf", ".doc", ".docx"]);

export async function listCardAttachments(pool: Pool, card: { id: string; tenant_id: string | null }): Promise<{
  items: CardAttachmentItem[]; strict: boolean; conversionEnabled: boolean; summary: Record<string, number>;
}> {
  const strict = await attachmentsStrictEnabled(pool, card.tenant_id);
  const conversionEnabled = await attachmentConversionEnabled(pool, card.tenant_id).catch(() => false);
  const cols = strict
    ? "a.id, a.filename, a.mime_type, a.size_bytes, a.content_sha256, a.kind, a.origin, a.derived_from_attachment_id, a.created_at"
    : "a.id, a.filename, a.mime_type, a.size_bytes, a.content_sha256, NULL::text AS kind, NULL::text AS origin, NULL::uuid AS derived_from_attachment_id, a.created_at";
  const rows = (await pool.query(`SELECT ${cols} FROM ticket_attachments a WHERE a.ticket_id = $1 ORDER BY a.created_at ASC, a.filename ASC`, [card.id])).rows;
  const conv = new Map<string, Record<string, unknown>>();
  if (rows.length > 0) {
    const cr = (await pool.query(
      `SELECT DISTINCT ON (attachment_id) attachment_id, status, attempts, error_code, error_message, warnings, derived_attachment_id, updated_at
         FROM attachment_conversions WHERE attachment_id = ANY($1::uuid[]) ORDER BY attachment_id, created_at DESC`,
      [rows.map((r) => r.id)],
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows;
    for (const c of cr) conv.set(String(c.attachment_id), c);
  }
  const summary: Record<string, number> = {};
  const items: CardAttachmentItem[] = rows.map((a) => {
    const filename = String(a.filename);
    const derived = a.derived_from_attachment_id ? String(a.derived_from_attachment_id) : null;
    const ext = attachmentExt(filename);
    const convertible = !derived && CONVERTIBLE.has(ext) && (strict ? classifyAttachment(filename) === "card_only" : true);
    const row = conv.get(String(a.id));
    let state: ConversionState = "not_applicable";
    if (convertible) {
      if (row) state = String(row.status) as ConversionState;
      else state = conversionEnabled ? "queued" : "disabled";
    }
    summary[state] = (summary[state] ?? 0) + 1;
    return {
      id: String(a.id), filename, mimeType: String(a.mime_type ?? "application/octet-stream"), sizeBytes: Number(a.size_bytes ?? 0),
      kind: a.kind ? String(a.kind) : null, origin: a.origin ? String(a.origin) : null, derivedFromAttachmentId: derived,
      contentSha256: a.content_sha256 ? String(a.content_sha256) : null,
      downloadUrl: `/api/cards/${card.id}/attachments/${a.id}`, createdAt: a.created_at as Date,
      conversion: {
        state, attempts: Number(row?.attempts ?? 0), errorCode: (row?.error_code as string | null) ?? null,
        errorMessage: (row?.error_message as string | null) ?? null,
        warnings: Array.isArray(row?.warnings) ? (row!.warnings as unknown[]) : [],
        derivedAttachmentId: (row?.derived_attachment_id as string | null) ?? null, updatedAt: (row?.updated_at as Date | null) ?? null,
      },
    };
  });
  return { items, strict, conversionEnabled, summary };
}

// ── Y-07: o conjunto de anexos (com o estado da conversão) faz parte do carimbo "pronto" ───────────────────

/** Estados em que uma conversão pdf/doc/docx → .md ainda pode produzir um derivado. */
export const CONVERSION_OPEN_STATES: readonly ConversionState[] = ["queued", "pending", "running"];

export interface CardAttachmentsSnapshot {
  /** sha256 do conjunto ordenado `(id, sha256 do conteúdo, estado da conversão, derivado)`: muda se um anexo entra/sai ou a conversão avança. */
  hash: string;
  /** Anexos cuja conversão ainda não terminou (bloqueiam o `ready`). */
  open: Array<{ id: string; filename: string; state: ConversionState }>;
}

export async function cardAttachmentsSnapshot(pool: Pool, card: { id: string; tenant_id: string | null }): Promise<CardAttachmentsSnapshot> {
  const { items } = await listCardAttachments(pool, card);
  const norm = items
    .map((a) => ({ id: a.id, sha: a.contentSha256, state: a.conversion.state, derived: a.conversion.derivedAttachmentId, from: a.derivedFromAttachmentId }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const { sha256Hex } = await import("../lib/specTreeHash.js");
  return {
    hash: sha256Hex(Buffer.from(JSON.stringify(norm), "utf-8")),
    open: items.filter((a) => (CONVERSION_OPEN_STATES as readonly string[]).includes(a.conversion.state))
      .map((a) => ({ id: a.id, filename: a.filename, state: a.conversion.state })),
  };
}
