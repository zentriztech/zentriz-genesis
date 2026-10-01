/**
 * tickets.ts — RFC-0009: o PEDIDO de evolução como entidade, separado da EXECUÇÃO.
 *
 * Medido em prod (2026-09-11): 59 projetos, UMA única evolução na história — e ela travada em
 * `blocked_cyborg`. Como `EVOLUTION_IN_FLIGHT` (projects.ts) recusa qualquer filho vivo, uma
 * execução presa tranca o serviço por tempo indeterminado. O ticket existe para o pedido
 * sobreviver a isso; não para administrar uma fila que a medição ainda não sustenta.
 *
 * INVARIANTES (revisão adversarial do RFC-0009 — o ataque "dois lugares dizendo a verdade"):
 *   1. `body` é o texto CRU do humano. Nenhum agente escreve nele (A.3 do estudo: 5% das
 *      revisões de LLM inserem erro factual). Depois de promovido, nem o humano edita.
 *   2. `status` é o estado do PEDIDO (open/promoted/delivered/rejected) — NUNCA o da execução.
 *      O estado de execução se DERIVA por join em `projects` via `child_project_id`.
 *   3. Filho descartado ⇒ o ticket VOLTA para `open` (o pedido continua válido; quem morreu
 *      foi a execução).
 */
import type { PoolClient, Pool } from "pg";
import { sha256Hex } from "../lib/specTreeHash.js";

export type TicketChangeKind = "evolution" | "fix" | "feature";
export type TicketStatus = "open" | "promoted" | "delivered" | "rejected";

export const TICKET_CHANGE_KINDS: readonly TicketChangeKind[] = ["evolution", "fix", "feature"] as const;

/** Rótulo humano do tipo declarado — vai para o `request.md`, o cabeçalho da spec e o PR. */
export const TICKET_KIND_LABEL: Record<TicketChangeKind, string> = {
  evolution: "evolução",
  fix: "correção",
  feature: "recurso novo",
};

export function isTicketChangeKind(v: unknown): v is TicketChangeKind {
  return typeof v === "string" && (TICKET_CHANGE_KINDS as readonly string[]).includes(v);
}

/** `TK-0012` — identidade estável do pedido, por produto. Zero-padded a 4 para ordenar como texto. */
export function ticketCode(n: number): string {
  return `TK-${String(n).padStart(4, "0")}`;
}

export interface TicketRow {
  id: string;
  tenant_id: string | null;
  product_id: string;
  project_id: string | null;
  number: number;
  title: string;
  body: string;
  change_kind: string;
  status: string;
  child_project_id: string | null;
  created_by: string | null;
  promoted_at: Date | null;
  delivered_at: Date | null;
  extra: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface TicketAttachmentRow {
  id: string;
  ticket_id: string;
  filename: string;
  file_path: string;
  mime_type: string | null;
  size_bytes: string | number;
  content_sha256: string | null;
}

type Db = Pool | PoolClient;

/**
 * Aloca o próximo número do produto — MESMO padrão de `products.next_rfc_seq`
 * (`evolutionPlanner.ts:318`), para não inventar um segundo mecanismo de numeração.
 *
 * `UPDATE .. RETURNING` trava a linha do produto até o commit da transação, então dois pedidos
 * simultâneos recebem números distintos sem advisory lock. `max(number)+1` seria condição de
 * corrida: duas transações leriam o mesmo máximo e a segunda quebraria no índice único.
 */
export async function allocTicketNumber(db: Db, productId: string): Promise<number> {
  const r = await db.query(
    "UPDATE products SET next_ticket_seq = next_ticket_seq + 1 WHERE id = $1 RETURNING next_ticket_seq - 1 AS allocated",
    [productId],
  );
  const n = Number(r.rows[0]?.allocated);
  if (!Number.isFinite(n) || n < 1) throw new Error(`produto ${productId} sem contador de ticket`);
  return n;
}

/** Diretório físico dos anexos do ticket (fora da árvore de spec até a promoção). */
export function ticketUploadDir(ticketId: string): string {
  const base = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
  return `${base}/tickets/${ticketId}`;
}

export async function loadTicket(db: Db, id: string): Promise<TicketRow | undefined> {
  return (await db.query("SELECT * FROM tickets WHERE id = $1", [id])).rows[0] as TicketRow | undefined;
}

export async function loadTicketAttachments(db: Db, ticketId: string): Promise<TicketAttachmentRow[]> {
  return (await db.query(
    "SELECT id, ticket_id, filename, file_path, mime_type, size_bytes, content_sha256 FROM ticket_attachments WHERE ticket_id = $1 ORDER BY created_at ASC",
    [ticketId],
  )).rows as TicketAttachmentRow[];
}

/**
 * O `request.md` que vai para `tickets/TK-NNNN/` na árvore da spec.
 *
 * Frontmatter para a máquina (a Fábrica lê o tipo DECLARADO em vez de inferi-lo do RFC) e
 * corpo CRU para o humano. O texto do pedido é copiado **sem nenhuma transformação**: é a
 * única cópia legível do que foi pedido, já que o `evolution_request` do projeto é
 * sobrescrito pelo sintetizado (evolutionGate.ts:214) e só sobrevive numa coluna JSON.
 */
export function renderTicketRequestMd(args: {
  ticket: Pick<TicketRow, "number" | "title" | "body" | "change_kind" | "created_at">;
  attachments: Array<{ filename: string }>;
  authorEmail?: string | null;
  projectTitle?: string | null;
  versionLabel?: string | null;
}): string {
  const code = ticketCode(args.ticket.number);
  const kind = isTicketChangeKind(args.ticket.change_kind) ? args.ticket.change_kind : "evolution";
  const created = args.ticket.created_at instanceof Date
    ? args.ticket.created_at.toISOString().slice(0, 10)
    : String(args.ticket.created_at ?? "").slice(0, 10);
  const lines: string[] = [
    "---",
    `ticket: ${code}`,
    `tipo: ${kind}`,
    `tipo_label: ${TICKET_KIND_LABEL[kind]}`,
    `titulo: ${JSON.stringify(args.ticket.title ?? "")}`,
    `aberto_em: ${created}`,
    `autor: ${args.authorEmail ?? "desconhecido"}`,
    args.projectTitle ? `servico: ${JSON.stringify(args.projectTitle)}` : "",
    args.versionLabel ? `versao_alvo: ${args.versionLabel}` : "",
    "imutavel: true",
    "---",
    "",
    `# ${code} — ${args.ticket.title || "Pedido de evolução"}`,
    "",
    `> **Tipo declarado:** ${TICKET_KIND_LABEL[kind]}. Este arquivo é o pedido ORIGINAL do humano,`,
    "> gravado cru e sem revisão. Não edite: a maturação acontece na spec, não aqui.",
    "",
    "## O que foi pedido",
    "",
    args.ticket.body,
    "",
  ];
  if (args.attachments.length > 0) {
    lines.push("## Anexos", "");
    for (const a of args.attachments) lines.push(`- [\`${a.filename}\`](anexos/${encodeURIComponent(a.filename)})`);
    lines.push("");
  }
  return lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/**
 * Materializa `tickets/TK-NNNN/request.md` (+ `anexos/`) na árvore de spec do projeto FILHO,
 * usando a coluna `rel_dir` de `project_spec_files` (migration 071) — o mecanismo de pastas
 * nativas da Bancada. Nada de estrutura nova.
 *
 * Best-effort por desenho: uma falha aqui NÃO pode abortar a evolução (o pedido já está no
 * banco e no `extra` do filho). Devolve o que conseguiu gravar para o chamador registrar.
 */
export async function materializeTicketIntoSpecTree(
  db: Db,
  args: { ticket: TicketRow; childProjectId: string; authorEmail?: string | null; projectTitle?: string | null; versionLabel?: string | null },
): Promise<{ ok: boolean; relDir: string; files: string[]; error?: string }> {
  const code = ticketCode(args.ticket.number);
  const relDir = `tickets/${code}`;
  const written: string[] = [];
  try {
    const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import("fs");
    const { join } = await import("path");
    const uploadDir = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
    const childDir = join(uploadDir, args.childProjectId, relDir);
    mkdirSync(childDir, { recursive: true });

    const attachments = await loadTicketAttachments(db, args.ticket.id);
    const md = renderTicketRequestMd({
      ticket: args.ticket,
      attachments,
      authorEmail: args.authorEmail,
      projectTitle: args.projectTitle,
      versionLabel: args.versionLabel,
    });
    const mdPath = join(childDir, "request.md");
    writeFileSync(mdPath, md, "utf-8");
    await db.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
       VALUES ($1, $2, $3, 'text/markdown', $4, false, $5)
       ON CONFLICT (project_id, rel_dir, filename) DO UPDATE SET file_path = EXCLUDED.file_path, content_sha256 = EXCLUDED.content_sha256`,
      [args.childProjectId, "request.md", mdPath, relDir, sha256Hex(Buffer.from(md, "utf-8"))],
    );
    written.push(`${relDir}/request.md`);

    if (attachments.length > 0) {
      const anexosRel = `${relDir}/anexos`;
      const anexosDir = join(uploadDir, args.childProjectId, anexosRel);
      mkdirSync(anexosDir, { recursive: true });
      for (const a of attachments) {
        if (!a.file_path || !existsSync(a.file_path)) continue;
        const buf = readFileSync(a.file_path);
        const dest = join(anexosDir, a.filename);
        writeFileSync(dest, buf);
        await db.query(
          `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
           VALUES ($1, $2, $3, $4, $5, false, $6)
           ON CONFLICT (project_id, rel_dir, filename) DO UPDATE SET file_path = EXCLUDED.file_path, content_sha256 = EXCLUDED.content_sha256`,
          [args.childProjectId, a.filename, dest, a.mime_type ?? "application/octet-stream", anexosRel, a.content_sha256 ?? sha256Hex(buf)],
        );
        written.push(`${anexosRel}/${a.filename}`);
      }
    }
    return { ok: true, relDir, files: written };
  } catch (err) {
    return { ok: false, relDir, files: written, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cabeçalho do arquivo primário da evolução. Sem ticket, o texto de hoje (retrocompatível);
 * com ticket, o código e o tipo DECLARADO ficam na primeira linha que o arquiteto da Bancada
 * e o CTO da Fábrica leem.
 */
export function evolutionRequestHeader(version: number, ticket?: { number: number; change_kind: string } | null): string {
  if (!ticket) return `# EVOLUTION REQUEST — v${version}`;
  const kind = isTicketChangeKind(ticket.change_kind) ? ticket.change_kind : "evolution";
  return `# EVOLUTION REQUEST — v${version} (${ticketCode(ticket.number)} · ${TICKET_KIND_LABEL[kind]})`;
}

/**
 * Invariante 3 do RFC-0009: a execução morreu, o pedido não. Quando o projeto filho é
 * descartado (arquivado ou apagado), todo ticket que apontava para ele volta para `open` e
 * perde o vínculo — senão o ticket ficaria `promoted` para sempre, apontando para um projeto
 * que não existe mais. Devolve quantos pedidos voltaram à fila.
 */
export async function reopenTicketsOfChild(db: Db, childProjectId: string): Promise<number> {
  const r = await db.query(
    `UPDATE tickets SET status = 'open', child_project_id = NULL, promoted_at = NULL, delivered_at = NULL, updated_at = now()
      WHERE child_project_id = $1 AND status <> 'rejected'`,
    [childProjectId],
  );
  return r.rowCount ?? 0;
}

/** Carimbo curto para commit/PR. `null` quando não há ticket — nada muda no caminho antigo. */
export function ticketStamp(extra: Record<string, unknown> | null | undefined): string | null {
  const n = extra?.ticket_number;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return ticketCode(n);
}
