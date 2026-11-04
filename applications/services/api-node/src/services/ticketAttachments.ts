/**
 * ticketAttachments.ts — Tarefa 1.5 (EVOLUIR-PROJETO-BANCADA, Fase 1'): validação e classificação dos anexos do card.
 *
 * Tudo atrás de `ATTACHMENTS_STRICT` (`off|on`, padrão `off`; por tenant, ver featureFlags.ts). Com `off` nada daqui é chamado e o comportamento
 * é byte-idêntico ao anterior (qualquer arquivo entra no card e é copiado para a árvore da spec).
 *
 * Decisão do Jean: permitidos pdf, txt, md, doc, docx. `txt/md` entram na pasta de texto da spec ("spec_text");
 * `pdf/doc/docx` ficam guardados no card ("card_only"), NUNCA em `project_spec_files`.
 *
 * A allowlist é por extensão E por conteúdo (magic bytes) coerentes: `.pdf` com cara de zip é recusado, e um
 * `.txt` que é na verdade PDF/zip/OLE ou tem NUL/UTF-8 inválido também.
 */
import path from "path";
import { inflateRawSync } from "zlib";
import { readRuntimeNumber, type RuntimeConfigDb } from "./runtimeTunables.js";
import { flagEnabled, parseEnvFlag } from "./featureFlags.js";

export type AttachmentKind = "spec_text" | "card_only";

/** Default de PLATAFORMA vindo do ambiente. Não sobrepõe o tenant (M-03). */
export function attachmentsStrictEnvDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.ATTACHMENTS_STRICT, "bool") === 1;
}

/**
 * `ATTACHMENTS_STRICT` EFETIVO para um tenant (M-03): tenant explícito > padrão global em `genesis_runtime_config` > env > `off`.
 * O runner recebe este MESMO valor por `GET /api/projects/:id/effective-flags` — api e runner nunca divergem.
 */
export async function attachmentsStrictEnabled(db: RuntimeConfigDb, tenantId: string | null | undefined): Promise<boolean> {
  return flagEnabled(db, "ATTACHMENTS_STRICT", tenantId ?? null);
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

/**
 * Teto do multipart do Fastify (app.ts) — M-17. Valores de configuração acima disso nunca teriam efeito (o multipart corta
 * antes da validação), então as faixas de `ATTACHMENT_MAX_*` (runtimeConfig.ts e `loadAttachmentLimits`) param aqui.
 */
export const MULTIPART_MAX_FILES = 10;
export const MULTIPART_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MULTIPART_MAX_TOTAL_BYTES = MULTIPART_MAX_FILES * MULTIPART_MAX_FILE_BYTES;

/** Padrões CONSERVADORES, calibrado=falso. O valor vivo vem de `genesis_runtime_config` (migration 143). */
export const ATTACHMENT_LIMIT_DEFAULTS = {
  maxFiles: 10,
  maxTotalBytes: 20 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
} as const;

export interface AttachmentLimits { maxFiles: number; maxTotalBytes: number; maxFileBytes: number }

export async function loadAttachmentLimits(db: RuntimeConfigDb, tenantId: string | null): Promise<AttachmentLimits> {
  const [f, t, b] = await Promise.all([
    readRuntimeNumber(db, "ATTACHMENT_MAX_FILES", tenantId, { min: 1, max: MULTIPART_MAX_FILES }),
    readRuntimeNumber(db, "ATTACHMENT_MAX_TOTAL_BYTES", tenantId, { min: 1024, max: MULTIPART_MAX_TOTAL_BYTES }),
    readRuntimeNumber(db, "ATTACHMENT_MAX_FILE_BYTES", tenantId, { min: 1024, max: MULTIPART_MAX_FILE_BYTES }),
  ]);
  return {
    maxFiles: f ?? ATTACHMENT_LIMIT_DEFAULTS.maxFiles,
    maxTotalBytes: t ?? ATTACHMENT_LIMIT_DEFAULTS.maxTotalBytes,
    maxFileBytes: b ?? ATTACHMENT_LIMIT_DEFAULTS.maxFileBytes,
  };
}

export type AttachmentErrorCode =
  | "ATTACHMENT_TYPE_NOT_ALLOWED" | "ATTACHMENT_CONTENT_MISMATCH" | "ATTACHMENT_NOT_UTF8"
  | "ATTACHMENT_ACTIVE_CONTENT" | "ATTACHMENT_EMPTY" | "ATTACHMENT_TOO_MANY" | "ATTACHMENT_TOO_LARGE" | "ATTACHMENT_TOTAL_TOO_LARGE";

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

/**
 * M-16 — conteúdo ATIVO. Decisão: RECUSAR (não só marcar), porque hoje nada converte nem abre o arquivo no servidor e
 * não existe coluna para a marca; o risco é de quem baixa/abre e do conversor futuro.
 *   • `.docx`: qualquer entrada `vbaProject.bin` no zip, ou `macroEnabled`/`vbaProject` em `[Content_Types].xml` (um `.docm`
 *     renomeado). Só lê a lista de entradas e UMA entrada pequena (teto de saída 1 MiB): sem zip bomb.
 *   • `.pdf`: `/JavaScript`, `/JS` ou `/Launch` fora de streams (nomes com escape `#xx` normalizados). `/OpenAction` sozinho
 *     (ir para a página/zoom) é comum e benigno e é ACEITO. Best-effort: ações dentro de object streams comprimidos não
 *     são vistas sem descompressão — o conversor futuro precisa de sandbox.
 * `null` = nada ativo encontrado.
 */
export function activeContentProblem(ext: string, b: Buffer): string | null {
  if (ext === ".pdf") {
    const raw = b.toString("latin1").replace(/(?<!end)stream\r?\n[\s\S]*?endstream/g, "stream endstream");
    const txt = raw.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    const m = /\/(JavaScript|JS|Launch)(?![A-Za-z])/.exec(txt);
    return m ? `o PDF contém conteúdo ativo (/${m[1]}); exporte uma versão sem scripts` : null;
  }
  if (ext === ".docx") {
    // Os nomes das entradas ficam em claro nos cabeçalhos do zip: a busca bruta pega até um pacote sem diretório central legível.
    if (b.includes(Buffer.from("vbaProject.bin"))) return "o documento contém macros (vbaProject.bin); salve como .docx sem macros";
    const entries = zipEntries(b) ?? [];
    const ct = entries.find((e) => e.name === "[Content_Types].xml");
    if (ct) {
      const xml = readZipEntry(b, ct, 1024 * 1024);
      if (xml === "too_big") return "o [Content_Types].xml do pacote é anormalmente grande (possível zip bomb ou ocultação de macros)";
      if (xml && /macroEnabled|vbaProject/i.test(xml.toString("utf8"))) return "o documento declara macros (macroEnabled); salve como .docx sem macros";
    }
  }
  return null;
}

interface ZipEntry { name: string; method: number; compSize: number; localOffset: number }

/** Lê o diretório central do zip (teto de 5000 entradas). `null` = não é um zip legível. */
function zipEntries(b: Buffer): ZipEntry[] | null {
  const min = Math.max(0, b.length - 65_557);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const total = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  if (total > 5000) return null;
  const out: ZipEntry[] = [];
  for (let n = 0; n < total; n++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) return null;
    const nameLen = b.readUInt16LE(off + 28), extraLen = b.readUInt16LE(off + 30), commLen = b.readUInt16LE(off + 32);
    if (off + 46 + nameLen > b.length) return null;
    out.push({
      name: b.toString("utf8", off + 46, off + 46 + nameLen), method: b.readUInt16LE(off + 10),
      compSize: b.readUInt32LE(off + 20), localOffset: b.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + commLen;
  }
  return out;
}

/** `"too_big"` = a entrada descomprime acima do teto (zip bomb ou preenchimento para esconder o marcador). */
function readZipEntry(b: Buffer, e: ZipEntry, maxOut: number): Buffer | "too_big" | null {
  try {
    const o = e.localOffset;
    if (o + 30 > b.length || b.readUInt32LE(o) !== 0x04034b50) return null;
    const start = o + 30 + b.readUInt16LE(o + 26) + b.readUInt16LE(o + 28);
    const data = b.subarray(start, start + e.compSize);
    if (e.method === 0) return data.subarray(0, maxOut);
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: maxOut });
    return null;
  } catch (err) { return (err as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE" ? "too_big" : null; }
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
      continue;
    }
    const active = activeContentProblem(ext, f.buffer);
    if (active) errors.push({ code: "ATTACHMENT_ACTIVE_CONTENT", filename: f.filename, message: `${f.filename}: ${active}.` });
  }
  if (total > limits.maxTotalBytes) {
    errors.push({ code: "ATTACHMENT_TOTAL_TOO_LARGE", filename: "", message: `Soma dos anexos (${total} bytes) maior que o teto de ${limits.maxTotalBytes} bytes por card.` });
  }
  return errors;
}

const DOWNLOAD_MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** M-14: Content-Type do download derivado da extensão validada — NUNCA do `mimetype` declarado pelo cliente no upload. */
export function downloadContentType(filename: string): string {
  return DOWNLOAD_MIME_BY_EXT[attachmentExt(filename)] ?? "application/octet-stream";
}

/** M-14: `Content-Disposition: attachment` seguro para qualquer nome (Latin-1 ou não): fallback ASCII + `filename*=UTF-8''…` (RFC 6266/5987). */
export function attachmentContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%;]/g, "_").slice(0, 150) || "anexo";
  const star = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** Erro explícito de leitura de anexo de texto na materialização (nunca devolver vazio em silêncio). */
export class AttachmentUnreadableError extends Error {
  constructor(public readonly filename: string, reason: string) {
    super(`ATTACHMENT_UNREADABLE: ${filename}: ${reason}`);
  }
}
