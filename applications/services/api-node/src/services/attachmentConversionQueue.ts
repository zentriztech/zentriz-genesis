/**
 * attachmentConversionQueue.ts — fila DURÁVEL e idempotente da conversão automática pdf/doc/docx → .md (Tarefa Q).
 *
 * Tudo atrás de `ATTACHMENT_CONVERSION` (`off|on`, padrão `off`; por tenant, ver featureFlags.ts). A conversão só vale com
 * `ATTACHMENTS_STRICT` também ligada (é ela que classifica o anexo como `card_only` e protege a árvore da spec).
 * Com `off` NADA daqui grava: não há enfileiramento, o worker só faz uma leitura barata e retorna.
 *
 * Garantias:
 *   • IDEMPOTENTE — chave `(attachment_id, content_sha256)` (UNIQUE); o derivado é único por `(original, nome)` (índice parcial);
 *     2 execuções ou 2 workers concorrentes ⇒ 1 derivado. O claim é um UPDATE atômico (sem lock de aplicação).
 *   • RETOMÁVEL — `running` com `locked_until` vencido (reinício no meio) volta a ser elegível; erro inesperado reagenda com
 *     recuo (60 s, 5 min) até 3 tentativas; erro DETERMINÍSTICO (corrompido, bomba, macro, timeout…) é terminal e não repete.
 *   • NÃO BLOQUEIA O CARD — toda falha é registrada em `attachment_conversions` (código + mensagem) e o anexo original segue
 *     guardado sem derivado. Nenhuma função daqui lança para o chamador de upload/materialização.
 *   • SEM LLM — extração determinística; interpretação semântica por visão/LLM está fora de escopo.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "fs";
import path from "path";
import { sha256Hex } from "../lib/specTreeHash.js";
import { flagEnabled } from "./featureFlags.js";
import {
  attachmentExt, attachmentsStrictEnabled, classifyAttachment, loadAttachmentLimits, utf8Problem, ATTACHMENT_LIMIT_DEFAULTS,
} from "./ticketAttachments.js";
import { conversionOrigin } from "./attachmentConversion.js";
import { runConversionIsolated, conversionLimitsFromEnv } from "./attachmentConversionRunner.js";
import { ConversionError, type ConversionWarning } from "./attachmentConverters.js";

/** Identificador estável gravado em `origin = converted:<id>` e no cabeçalho de origem. */
export const BUILTIN_CONVERTER_ID = "builtin-text-v1";
export const MAX_CONVERSION_ATTEMPTS = 3;
const LOCK_SECONDS = 120;

export interface QueueDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

/** `ATTACHMENT_CONVERSION` efetivo para um tenant: a flag própria E o modo estrito dos anexos. Nunca lança. */
export async function attachmentConversionEnabled(db: QueueDb, tenantId: string | null | undefined): Promise<boolean> {
  try {
    return (await flagEnabled(db, "ATTACHMENT_CONVERSION", tenantId ?? null)) && (await attachmentsStrictEnabled(db, tenantId ?? null));
  } catch { return false; }
}

const CONVERTIBLE = new Set([".pdf", ".docx", ".doc"]);

/** Enfileira (idempotente) os anexos convertíveis do pedido. Devolve quantas linhas NOVAS entraram. */
export async function enqueueTicketConversions(db: QueueDb, ticketId: string): Promise<number> {
  const rows = (await db.query(
    `SELECT id, filename, content_sha256 FROM ticket_attachments
      WHERE ticket_id = $1 AND derived_from_attachment_id IS NULL AND origin = 'upload' AND content_sha256 IS NOT NULL`,
    [ticketId],
  )).rows as Array<{ id: string; filename: string; content_sha256: string }>;
  let n = 0;
  for (const a of rows) {
    if (classifyAttachment(a.filename) !== "card_only" || !CONVERTIBLE.has(attachmentExt(a.filename))) continue;
    const r = await db.query(
      `INSERT INTO attachment_conversions (attachment_id, content_sha256) VALUES ($1, $2)
       ON CONFLICT (attachment_id, content_sha256) DO NOTHING`,
      [a.id, a.content_sha256],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

interface ConversionRow {
  id: string; attachment_id: string; content_sha256: string; attempts: number;
}

async function finish(db: QueueDb, id: string, status: "done" | "empty" | "failed" | "pending", extra: {
  code?: string | null; message?: string | null; warnings?: ConversionWarning[]; derivedId?: string | null; retryInSeconds?: number;
} = {}): Promise<void> {
  await db.query(
    `UPDATE attachment_conversions
        SET status = $2, error_code = $3, error_message = $4, warnings = $5::jsonb, derived_attachment_id = $6,
            locked_until = NULL, next_attempt_at = now() + ($7 || ' seconds')::interval, updated_at = now()
      WHERE id = $1`,
    [id, status, extra.code ?? null, extra.message ? extra.message.slice(0, 500) : null, JSON.stringify(extra.warnings ?? []),
      extra.derivedId ?? null, String(extra.retryInSeconds ?? 0)],
  );
}

/** Nome do derivado: `<original>.md`; se colidir com outro anexo do pedido, `<original>.<id8>.md`. */
async function derivedName(db: QueueDb, ticketId: string, original: { id: string; filename: string }): Promise<string> {
  const base = `${original.filename}.md`.slice(-200);
  const clash = (await db.query(
    `SELECT 1 FROM ticket_attachments WHERE ticket_id = $1 AND filename = $2 AND derived_from_attachment_id IS DISTINCT FROM $3 LIMIT 1`,
    [ticketId, base, original.id],
  )).rows.length > 0;
  return clash ? `${original.filename}.${original.id.slice(0, 8)}.md`.slice(-200) : base;
}

async function processClaimed(db: QueueDb, c: ConversionRow): Promise<"done" | "empty" | "failed" | "retry"> {
  const a = (await db.query(
    `SELECT a.id, a.ticket_id, a.filename, a.file_path, a.size_bytes FROM ticket_attachments a WHERE a.id = $1`, [c.attachment_id],
  )).rows[0] as { id: string; ticket_id: string; filename: string; file_path: string } | undefined;
  if (!a) { await finish(db, c.id, "failed", { code: "ATTACHMENT_GONE", message: "anexo original não existe mais" }); return "failed"; }
  if (c.attempts > MAX_CONVERSION_ATTEMPTS) {
    await finish(db, c.id, "failed", { code: "MAX_ATTEMPTS", message: `${MAX_CONVERSION_ATTEMPTS} tentativas esgotadas` }); return "failed";
  }
  let buf: Buffer;
  try { buf = readFileSync(a.file_path); }
  catch { await finish(db, c.id, "failed", { code: "FILE_MISSING", message: "arquivo do anexo não encontrado no disco" }); return "failed"; }
  if (sha256Hex(buf) !== c.content_sha256) {
    await finish(db, c.id, "failed", { code: "FILE_CHANGED", message: "o conteúdo em disco não confere com o sha256 registrado" }); return "failed";
  }
  try {
    const ext = attachmentExt(a.filename);
    const out = await runConversionIsolated(ext, buf, { attachmentId: a.id, filename: a.filename, sha256: c.content_sha256, now: new Date() }, conversionLimitsFromEnv());
    if (out.markdown === "") {
      await finish(db, c.id, "empty", { code: "NO_TEXT_LAYER", message: "sem camada de texto extraível (documento escaneado?); nenhum derivado criado", warnings: out.warnings });
      return "empty";
    }
    // O derivado respeita a MESMA allowlist/teto dos txt/md: `.md`, UTF-8 estrito, <= teto por arquivo.
    const bytes = Buffer.from(out.markdown, "utf-8");
    const name = await derivedName(db, a.ticket_id, a);
    const tenantRow = (await db.query("SELECT tenant_id FROM tickets WHERE id = $1", [a.ticket_id])).rows[0] as { tenant_id: string | null } | undefined;
    const limits = await loadAttachmentLimits(db, tenantRow?.tenant_id ?? null).catch(() => ATTACHMENT_LIMIT_DEFAULTS);
    if (classifyAttachment(name) !== "spec_text") throw new ConversionError("CONVERSION_FAILED", "nome do derivado fora da allowlist");
    if (bytes.length > limits.maxFileBytes) throw new ConversionError("INPUT_TOO_LARGE", `derivado com ${bytes.length} bytes excede ${limits.maxFileBytes}`);
    const bad = utf8Problem(bytes);
    if (bad) throw new ConversionError("CONVERSION_FAILED", `derivado inválido: ${bad}`);

    const dest = path.join(path.dirname(a.file_path), name);
    const tmp = `${dest}.${process.pid}.${c.id.slice(0, 8)}.tmp`;
    try { writeFileSync(tmp, bytes); renameSync(tmp, dest); } finally { if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* best-effort */ } } }

    await db.query(
      `INSERT INTO ticket_attachments (ticket_id, filename, file_path, mime_type, size_bytes, content_sha256, kind, origin, derived_from_attachment_id)
       VALUES ($1, $2, $3, 'text/markdown', $4, $5, 'spec_text', $6, $7)
       ON CONFLICT (derived_from_attachment_id, filename) WHERE derived_from_attachment_id IS NOT NULL DO NOTHING`,
      [a.ticket_id, name, dest, bytes.length, sha256Hex(bytes), conversionOrigin(BUILTIN_CONVERTER_ID), a.id],
    );
    const derived = (await db.query(
      `SELECT id FROM ticket_attachments WHERE derived_from_attachment_id = $1 AND filename = $2`, [a.id, name],
    )).rows[0] as { id: string } | undefined;
    await finish(db, c.id, "done", { derivedId: derived?.id ?? null, warnings: out.warnings });
    return "done";
  } catch (e) {
    if (e instanceof ConversionError) {
      // determinístico: o mesmo arquivo dará o mesmo resultado ⇒ terminal, sem repetir
      await finish(db, c.id, "failed", { code: e.code, message: e.message });
      return "failed";
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (c.attempts >= MAX_CONVERSION_ATTEMPTS) { await finish(db, c.id, "failed", { code: "MAX_ATTEMPTS", message: msg }); return "failed"; }
    await finish(db, c.id, "pending", { code: "TRANSIENT", message: msg, retryInSeconds: c.attempts === 1 ? 60 : 300 });
    return "retry";
  }
}

export interface TickResult { claimed: number; done: number; empty: number; failed: number; retry: number; skippedFlagOff: number }

/**
 * Uma passada: processa até `limit` conversões elegíveis (opcionalmente só de um pedido). `ignoreBackoff` (drenagem inline na
 * materialização) ignora `next_attempt_at`, mas continua respeitando o lock de quem já está convertendo. Nunca lança.
 */
export async function runConversionTick(db: QueueDb, opts: { ticketId?: string; limit?: number; ignoreBackoff?: boolean; budgetMs?: number } = {}): Promise<TickResult> {
  const startedAt = Date.now();
  const res: TickResult = { claimed: 0, done: 0, empty: 0, failed: 0, retry: 0, skippedFlagOff: 0 };
  try {
    const cands = (await db.query(
      `SELECT c.id, t.tenant_id
         FROM attachment_conversions c
         JOIN ticket_attachments a ON a.id = c.attachment_id
         JOIN tickets t ON t.id = a.ticket_id
        WHERE ((c.status = 'pending' ${opts.ignoreBackoff ? "" : "AND c.next_attempt_at <= now()"}) OR (c.status = 'running' AND c.locked_until < now()))
          AND ($1::uuid IS NULL OR a.ticket_id = $1::uuid)
        ORDER BY c.created_at ASC LIMIT $2`,
      [opts.ticketId ?? null, opts.limit ?? 5],
    )).rows as Array<{ id: string; tenant_id: string | null }>;
    const flagByTenant = new Map<string, boolean>();
    for (const cand of cands) {
      // orçamento de tempo (drenagem inline): não INICIA outra conversão depois de estourado; o resto segue `pending` para o worker
      if (opts.budgetMs !== undefined && Date.now() - startedAt >= opts.budgetMs) break;
      const key = cand.tenant_id ?? "";
      if (!flagByTenant.has(key)) flagByTenant.set(key, await attachmentConversionEnabled(db, cand.tenant_id));
      if (!flagByTenant.get(key)) { res.skippedFlagOff++; continue; }
      // claim ATÔMICO: só um worker vence; o outro recebe 0 linhas e segue
      const claimed = (await db.query(
        `UPDATE attachment_conversions
            SET status = 'running', attempts = attempts + 1, locked_until = now() + ($2 || ' seconds')::interval, updated_at = now()
          WHERE id = $1
            AND ((status = 'pending' ${opts.ignoreBackoff ? "" : "AND next_attempt_at <= now()"}) OR (status = 'running' AND locked_until < now()))
        RETURNING id, attachment_id, content_sha256, attempts`,
        [cand.id, String(LOCK_SECONDS)],
      )).rows[0] as unknown as ConversionRow | undefined;
      if (!claimed) continue;
      res.claimed++;
      try { res[await processClaimed(db, claimed)]++; }
      catch (e) {
        // falha ao gravar o estado final: o lock vence e a linha é retomada depois
        console.warn(`[attachmentConversion] falha ao concluir ${claimed.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    console.warn(`[attachmentConversion] passada falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
  return res;
}

/** Hook do upload (DEPOIS do commit): com a flag ligada enfileira e dispara a conversão em segundo plano. Nunca lança. */
export async function kickTicketConversions(db: QueueDb, tenantId: string | null | undefined, ticketId: string): Promise<void> {
  try {
    if (!(await attachmentConversionEnabled(db, tenantId))) return;
    if ((await enqueueTicketConversions(db, ticketId)) === 0) return;
    setImmediate(() => { void runConversionTick(db, { ticketId }); });
  } catch (e) {
    console.warn(`[attachmentConversion] enfileirar ${ticketId} falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Limites da drenagem inline (S-10), padrões conservadores NÃO calibrados (calibrado=falso), override por variável. */
export const INLINE_DRAIN_DEFAULTS = { maxConversions: 2, budgetMs: 20_000 } as const;
export function inlineDrainLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): { maxConversions: number; budgetMs: number } {
  const num = (k: string, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
  return {
    maxConversions: Math.min(num("ATTACHMENT_CONVERSION_INLINE_MAX", INLINE_DRAIN_DEFAULTS.maxConversions), 20),
    budgetMs: num("ATTACHMENT_CONVERSION_INLINE_BUDGET_MS", INLINE_DRAIN_DEFAULTS.budgetMs),
  };
}

/**
 * Drenagem inline (materialização da spec): converte JÁ o que couber em `maxConversions` (padrão 2) e `budgetMs` (padrão 20 s,
 * checado antes de iniciar cada conversão; teto de espera ≈ orçamento + `timeoutMs` de uma conversão). O restante continua
 * `pending` e é convertido pelo worker periódico; a spec ganha o derivado na próxima materialização/reconciliação (S-10). Nunca lança.
 */
export async function drainTicketConversions(db: QueueDb, ticketId: string): Promise<void> {
  try {
    const lim = inlineDrainLimitsFromEnv();
    await enqueueTicketConversions(db, ticketId);
    await runConversionTick(db, { ticketId, limit: lim.maxConversions, ignoreBackoff: true, budgetMs: lim.budgetMs });
  } catch (e) {
    console.warn(`[attachmentConversion] drenagem ${ticketId} falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── worker periódico (retoma o que ficou pendente após reinício) ───────────────────────────────────
let timer: NodeJS.Timeout | null = null;
let stopped = true;
let ticking = false;
const TICK_MS = 30_000;

export function startAttachmentConversionWorker(getDb: () => QueueDb): void {
  if (!stopped) return;
  stopped = false;
  const loop = async () => {
    if (stopped) return;
    if (!ticking) {
      ticking = true;
      try {
        // barato com tudo desligado: uma leitura; sem linhas abertas não há flag a resolver
        const open = (await getDb().query("SELECT 1 FROM attachment_conversions WHERE status IN ('pending', 'running') LIMIT 1")).rows.length > 0;
        if (open) await runConversionTick(getDb());
      } catch { /* tabela ausente (migração pendente) etc.: tenta na próxima */ }
      finally { ticking = false; }
    }
    if (!stopped) timer = setTimeout(() => { void loop(); }, TICK_MS);
  };
  timer = setTimeout(() => { void loop(); }, 20_000);
}

export function stopAttachmentConversionWorker(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}
