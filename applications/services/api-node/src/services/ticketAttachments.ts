/**
 * ticketAttachments.ts — Tarefa 1.5 (EVOLUIR-PROJETO-BANCADA, Fase 1'): validação e classificação dos anexos do card.
 *
 * Tudo atrás de `ATTACHMENTS_STRICT` (`off|on`, padrão `off`). Com `off` nada daqui é chamado e o comportamento
 * é byte-idêntico ao anterior (qualquer arquivo entra no card e é copiado para a árvore da spec).
 *
 * Decisão do Jean: permitidos pdf, txt, md, doc, docx. `txt/md` entram na pasta de texto da spec ("spec_text");
 * `pdf/doc/docx` ficam guardados no card ("card_only"), NUNCA em `project_spec_files`.
 *
 * A allowlist é por extensão E por conteúdo (magic bytes) coerentes: `.pdf` com cara de zip é recusado, e um
 * `.txt` que é na verdade PDF/zip/OLE ou tem NUL/UTF-8 inválido também.
 */
import path from "path";
import { readRuntimeNumber, type RuntimeConfigDb } from "./runtimeTunables.js";

export type AttachmentKind = "spec_text" | "card_only";

export function attachmentsStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ATTACHMENTS_STRICT ?? "off").trim().toLowerCase() === "on";
}

export const ALLOWED_ATTACHMENT_EXTS = [".pdf", ".txt", ".md", ".doc", ".docx"] as const;
const KIND_BY_EXT: Record<string, AttachmentKind> = {
  ".txt": "spec_text", ".md": "spec_text",
  ".pdf": "card_only", ".doc": "card_only", ".docx": "card_only",
};

export function attachmentExt(filename: string): string {
  return path.extname(filename).toLowerCase();
}

/** Classificação por extensão. `null` = fora da allowlist (ex.: png, xlsx, ou linha legada). */
export function classifyAttachment(filename: string): AttachmentKind | null {
  return KIND_BY_EXT[attachmentExt(filename)] ?? null;
}

/** Padrões CONSERVADORES, calibrado=falso. O valor vivo vem de `genesis_runtime_config` (migration 141). */
export const ATTACHMENT_LIMIT_DEFAULTS = {
  maxFiles: 10,
  maxTotalBytes: 20 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
} as const;

export interface AttachmentLimits { maxFiles: number; maxTotalBytes: number; maxFileBytes: number }

export async function loadAttachmentLimits(db: RuntimeConfigDb, tenantId: string | null): Promise<AttachmentLimits> {
  const [f, t, b] = await Promise.all([
    readRuntimeNumber(db, "ATTACHMENT_MAX_FILES", tenantId, { min: 1, max: 50 }),
    readRuntimeNumber(db, "ATTACHMENT_MAX_TOTAL_BYTES", tenantId, { min: 1024, max: 209_715_200 }),
    readRuntimeNumber(db, "ATTACHMENT_MAX_FILE_BYTES", tenantId, { min: 1024, max: 52_428_800 }),
  ]);
  return {
    maxFiles: f ?? ATTACHMENT_LIMIT_DEFAULTS.maxFiles,
    maxTotalBytes: t ?? ATTACHMENT_LIMIT_DEFAULTS.maxTotalBytes,
    maxFileBytes: b ?? ATTACHMENT_LIMIT_DEFAULTS.maxFileBytes,
  };
}

export type AttachmentErrorCode =
  | "ATTACHMENT_TYPE_NOT_ALLOWED" | "ATTACHMENT_CONTENT_MISMATCH" | "ATTACHMENT_NOT_UTF8"
  | "ATTACHMENT_EMPTY" | "ATTACHMENT_TOO_MANY" | "ATTACHMENT_TOO_LARGE" | "ATTACHMENT_TOTAL_TOO_LARGE";

export interface AttachmentError { code: AttachmentErrorCode; filename: string; message: string }

const startsWith = (b: Buffer, sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

function looksLikeKnownBinary(b: Buffer): boolean {
  return startsWith(b, OLE2) || startsWith(b, ZIP) || startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
    || startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || startsWith(b, [0xff, 0xd8, 0xff]) || startsWith(b, [0x47, 0x49, 0x46, 0x38]);
}

/** UTF-8 estrito (sem substituição): `null` = válido, senão o motivo. */
export function utf8Problem(b: Buffer): string | null {
  if (b.subarray(0, 8192).includes(0)) return "contém bytes NUL (é binário)";
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return null; }
  catch { return "não é UTF-8 válido"; }
}

/** Confere a assinatura do conteúdo contra a extensão declarada. `null` = coerente. */
export function contentMismatch(ext: string, b: Buffer): string | null {
  switch (ext) {
    case ".pdf":
      // a especificação aceita o cabeçalho %PDF- nos primeiros 1024 bytes
      return b.subarray(0, 1024).includes(Buffer.from("%PDF-")) ? null : "o conteúdo não começa com a assinatura %PDF-";
    case ".doc":
      return startsWith(b, OLE2) ? null : "o conteúdo não tem a assinatura OLE2 de um .doc";
    case ".docx":
      // zip (nomes de entrada ficam em claro nos cabeçalhos locais) com [Content_Types].xml e word/
      return startsWith(b, ZIP) && b.includes(Buffer.from("[Content_Types].xml")) && b.includes(Buffer.from("word/"))
        ? null : "o conteúdo não é um pacote OOXML de documento (.docx)";
    case ".txt":
    case ".md":
      if (looksLikeKnownBinary(b)) return "o conteúdo é um formato binário, não texto";
      return utf8Problem(b);
    default:
      return "extensão fora da allowlist";
  }
}

export interface IncomingAttachment { filename: string; buffer: Buffer }

/** Valida o lote inteiro e devolve TODOS os problemas (não só o primeiro), para a UI mostrar de uma vez. */
export function validateAttachments(files: IncomingAttachment[], limits: AttachmentLimits): AttachmentError[] {
  const errors: AttachmentError[] = [];
  if (files.length > limits.maxFiles) {
    errors.push({ code: "ATTACHMENT_TOO_MANY", filename: "", message: `Máximo de ${limits.maxFiles} arquivo(s) por card (enviados: ${files.length}).` });
  }
  let total = 0;
  for (const f of files) {
    total += f.buffer.length;
    const ext = attachmentExt(f.filename);
    if (!classifyAttachment(f.filename)) {
      errors.push({ code: "ATTACHMENT_TYPE_NOT_ALLOWED", filename: f.filename, message: `Tipo "${ext || "(sem extensão)"}" não permitido. Aceitos: ${ALLOWED_ATTACHMENT_EXTS.join(", ")}.` });
      continue;
    }
    if (f.buffer.length === 0) {
      errors.push({ code: "ATTACHMENT_EMPTY", filename: f.filename, message: "Arquivo vazio." });
      continue;
    }
    if (f.buffer.length > limits.maxFileBytes) {
      errors.push({ code: "ATTACHMENT_TOO_LARGE", filename: f.filename, message: `Arquivo maior que ${limits.maxFileBytes} bytes.` });
      continue;
    }
    const why = contentMismatch(ext, f.buffer);
    if (why) {
      const code: AttachmentErrorCode = (ext === ".txt" || ext === ".md") && why.includes("UTF-8") ? "ATTACHMENT_NOT_UTF8" : "ATTACHMENT_CONTENT_MISMATCH";
      errors.push({ code, filename: f.filename, message: `${f.filename}: ${why}.` });
    }
  }
  if (total > limits.maxTotalBytes) {
    errors.push({ code: "ATTACHMENT_TOTAL_TOO_LARGE", filename: "", message: `Soma dos anexos (${total} bytes) maior que o teto de ${limits.maxTotalBytes} bytes por card.` });
  }
  return errors;
}

/** Erro explícito de leitura de anexo de texto na materialização (nunca devolver vazio em silêncio). */
export class AttachmentUnreadableError extends Error {
  constructor(public readonly filename: string, reason: string) {
    super(`ATTACHMENT_UNREADABLE: ${filename}: ${reason}`);
  }
}
