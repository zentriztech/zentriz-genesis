/**
 * attachmentConverters.ts — extração DETERMINÍSTICA de texto de pdf/docx/doc para Markdown (Tarefa 3.x / Q).
 *
 * Este módulo roda DENTRO de um processo filho com limites do SO (attachmentConversionChild.ts) — nunca no processo da api.
 * Sem LLM, sem visão, sem OCR: só a camada de texto que o próprio arquivo carrega. Um PDF escaneado (só imagem)
 * devolve resultado vazio com o aviso `NO_TEXT_LAYER`; nada de texto inventado.
 *
 * Bibliotecas (licença/manutenção verificadas no relatório Q): mammoth (BSD-2, docx), pdfjs-dist ~5.5.207 (Apache-2.0, pdf),
 * word-extractor (MIT, doc legado). Nenhuma executa macros/JS: mammoth só lê o XML do pacote, o pdf.js roda com
 * `isEvalSupported:false` e sem scripting (API de texto, sem viewer), word-extractor só lê streams OLE.
 *
 * Defesas deste módulo (além do que o processo filho/limites de memória e o timeout do chamador impõem):
 *   • docx = zip: teto de entradas, tamanho declarado por entrada/total, razão de compressão E verificação REAL por
 *     descompressão com `maxOutputLength` (tamanho declarado no zip pode mentir) — zip bomb ⇒ `ZIP_BOMB`;
 *   • macro/conteúdo ativo (M-16): reaproveita `activeContentProblem` do upload e recusa também `.doc` com projeto VBA;
 *   • saída limitada em páginas e caracteres, sempre UTF-8 bem formado e sem controles.
 */
import { inflateRawSync } from "zlib";
import { activeContentProblem, contentMismatch } from "./ticketAttachments.js";

export type ConversionErrorCode =
  | "INPUT_TOO_LARGE" | "UNSUPPORTED_TYPE" | "CORRUPT" | "ENCRYPTED" | "ACTIVE_CONTENT"
  | "ZIP_BOMB" | "TIMEOUT" | "RESOURCE_LIMIT" | "CONVERSION_FAILED";

export class ConversionError extends Error {
  constructor(public readonly code: ConversionErrorCode, message: string) { super(message); this.name = "ConversionError"; }
}

export type ConversionWarning = "NO_TEXT_LAYER" | "TRUNCATED_PAGES" | "TRUNCATED_CHARS" | "IMAGES_OMITTED" | "CONVERTER_MESSAGES" | "LINKS_SANITIZED";

export interface ConversionLimits {
  /** bytes do arquivo de entrada */
  maxInputBytes: number;
  /** pdf: páginas lidas */
  maxPages: number;
  /** caracteres do Markdown de saída (corpo, sem o cabeçalho) */
  maxOutputChars: number;
  /** docx: entradas no zip */
  maxZipEntries: number;
  /** docx: bytes descomprimidos por entrada */
  maxZipEntryBytes: number;
  /** docx: bytes descomprimidos somados */
  maxZipTotalBytes: number;
  /** docx: razão descomprimido/comprimido aceita (entradas acima de 1 MiB e o total) */
  maxZipRatio: number;
  /** tempo total da conversão (aplicado pelo chamador, que mata o processo filho com SIGKILL) */
  timeoutMs: number;
  /** teto de heap V8 do processo filho (`--max-old-space-size`, MiB) — NÃO cobre Buffer/ArrayBuffer */
  workerMaxOldGenMb: number;
  /** teto de RSS do processo filho (MiB), medido pelo pai; acima disso o filho leva SIGKILL (cobre memória externa) */
  procMaxRssMb: number;
  /** teto de espaço de endereçamento do filho (MiB, `ulimit -v`/RLIMIT_AS) — limite real do SO; 0 = desligado */
  procMaxAddressSpaceMb: number;
  /** bytes máximos lidos da saída (stdout) do filho; acima disso o filho leva SIGKILL */
  maxStdoutBytes: number;
  /** conversões simultâneas por instância da api (semáforo global; 1–4) */
  maxConcurrent: number;
}

/** Padrões CONSERVADORES e NÃO CALIBRADOS (calibrado=falso): não há medição de anexos reais. */
export const CONVERSION_LIMIT_DEFAULTS: ConversionLimits = {
  maxInputBytes: 10 * 1024 * 1024,
  maxPages: 300,
  maxOutputChars: 400_000,
  maxZipEntries: 1000,
  maxZipEntryBytes: 20 * 1024 * 1024,
  maxZipTotalBytes: 50 * 1024 * 1024,
  maxZipRatio: 100,
  timeoutMs: 30_000,
  workerMaxOldGenMb: 512,
  procMaxRssMb: 1024,
  procMaxAddressSpaceMb: 4096,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxConcurrent: 2,
};

export interface ConvertMeta { attachmentId: string; filename: string; sha256: string; now: Date }
export interface ConvertOutput {
  /** Markdown FINAL (cabeçalho de origem + corpo). Vazio ("") quando não há texto (NO_TEXT_LAYER). */
  markdown: string;
  warnings: ConversionWarning[];
  stats: { pages?: number; chars: number; entries?: number };
}

// ── helpers de texto ─────────────────────────────────────────────────────────────────────────

/** Troca surrogates solitários por U+FFFD (round-trip UTF-8). */
const wellFormed = (s: string): string => Buffer.from(s, "utf8").toString("utf8");

/** UTF-8 bem formado, sem NUL/controles (exceto \n e \t), \r normalizado. */
export function sanitizeText(s: string): string {
  return wellFormed(s)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Cabeçalho de origem exigido: marca clara de que o arquivo é derivado e pode ter perdas. */
export function originHeader(meta: ConvertMeta): string {
  const safeName = meta.filename.replace(/[\r\n`]/g, " ").slice(0, 200);
  const date = meta.now.toISOString().slice(0, 10);
  return `> Convertido automaticamente de ${safeName} (anexo ${meta.attachmentId}, sha256 ${meta.sha256.slice(0, 8)}) em ${date}; pode conter perdas de formatação\n`;
}

function clip(body: string, max: number, warnings: ConversionWarning[]): string {
  if (body.length <= max) return body;
  warnings.push("TRUNCATED_CHARS");
  const cut = body.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return wellFormed(cut.slice(0, nl > max * 0.8 ? nl : max));
}

function finalize(body: string, meta: ConvertMeta, warnings: ConversionWarning[], limits: ConversionLimits, stats: Omit<ConvertOutput["stats"], "chars">): ConvertOutput {
  let text = sanitizeText(body).trim();
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return { markdown: "", warnings: [...new Set([...warnings, "NO_TEXT_LAYER" as const])], stats: { ...stats, chars: 0 } };
  }
  text = clip(text, limits.maxOutputChars, warnings);
  const notes: string[] = [];
  if (warnings.includes("TRUNCATED_PAGES")) notes.push(`> Aviso: só as primeiras ${limits.maxPages} páginas foram convertidas.`);
  if (warnings.includes("TRUNCATED_CHARS")) notes.push(`> Aviso: o texto foi truncado em ${limits.maxOutputChars} caracteres.`);
  if (warnings.includes("IMAGES_OMITTED")) notes.push("> Aviso: imagens do documento foram omitidas (sem interpretação visual).");
  const md = `${originHeader(meta)}${notes.length ? notes.join("\n") + "\n" : ""}\n${text}\n`;
  return { markdown: md, warnings: [...new Set(warnings)], stats: { ...stats, chars: text.length } };
}

// ── zip (docx) ───────────────────────────────────────────────────────────────────────────────

interface ZipEntryInfo { name: string; flags: number; method: number; compSize: number; size: number; localOffset: number }

function readCentralDirectory(b: Buffer, limits: ConversionLimits): ZipEntryInfo[] {
  const min = Math.max(0, b.length - 65_557);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ConversionError("CORRUPT", "zip sem diretório central (arquivo truncado ou corrompido)");
  const total = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  if (total === 0xffff || off === 0xffffffff) throw new ConversionError("ZIP_BOMB", "zip64 não suportado para documentos deste tamanho");
  if (total > limits.maxZipEntries) throw new ConversionError("ZIP_BOMB", `zip com ${total} entradas (máximo ${limits.maxZipEntries})`);
  const out: ZipEntryInfo[] = [];
  for (let n = 0; n < total; n++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) throw new ConversionError("CORRUPT", "diretório central do zip inválido");
    const nameLen = b.readUInt16LE(off + 28), extraLen = b.readUInt16LE(off + 30), commLen = b.readUInt16LE(off + 32);
    if (off + 46 + nameLen > b.length) throw new ConversionError("CORRUPT", "diretório central do zip inválido");
    out.push({
      name: b.toString("utf8", off + 46, off + 46 + nameLen), flags: b.readUInt16LE(off + 8), method: b.readUInt16LE(off + 10),
      compSize: b.readUInt32LE(off + 20), size: b.readUInt32LE(off + 24), localOffset: b.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + commLen;
  }
  return out;
}

/**
 * Pré-voo do docx: limites declarados + verificação REAL de descompressão. Lança `ZIP_BOMB`/`ENCRYPTED`/`CORRUPT`.
 * Devolve nº de entradas. Entradas de mídia (`word/media/`) só contam pelo tamanho declarado — a conversão nunca as lê.
 */
export function inspectDocxZip(b: Buffer, limits: ConversionLimits): number {
  const entries = readCentralDirectory(b, limits);
  let declaredTotal = 0;
  for (const e of entries) {
    if (e.flags & 1) throw new ConversionError("ENCRYPTED", "o documento tem entradas criptografadas");
    if (e.size === 0xffffffff || e.compSize === 0xffffffff) throw new ConversionError("ZIP_BOMB", "zip64 não suportado para documentos deste tamanho");
    if (e.size > limits.maxZipEntryBytes) throw new ConversionError("ZIP_BOMB", `entrada ${JSON.stringify(e.name)} descomprime para ${e.size} bytes (máximo ${limits.maxZipEntryBytes})`);
    if (e.size > 1024 * 1024 && e.size / Math.max(1, e.compSize) > limits.maxZipRatio) {
      throw new ConversionError("ZIP_BOMB", `entrada ${JSON.stringify(e.name)} com razão de compressão ${(e.size / Math.max(1, e.compSize)).toFixed(0)}:1 (máximo ${limits.maxZipRatio}:1)`);
    }
    declaredTotal += e.size;
    if (declaredTotal > limits.maxZipTotalBytes) throw new ConversionError("ZIP_BOMB", `o pacote descomprime para mais de ${limits.maxZipTotalBytes} bytes`);
  }
  if (declaredTotal / Math.max(1, b.length) > limits.maxZipRatio && declaredTotal > 1024 * 1024) {
    throw new ConversionError("ZIP_BOMB", `razão de compressão total ${(declaredTotal / b.length).toFixed(0)}:1 (máximo ${limits.maxZipRatio}:1)`);
  }
  // Verificação real: o tamanho declarado pode mentir. Descomprime (com teto) tudo que a conversão pode ler.
  let actualTotal = 0;
  for (const e of entries) {
    if (e.name.startsWith("word/media/") || e.name.endsWith("/")) continue;
    const o = e.localOffset;
    if (o + 30 > b.length || b.readUInt32LE(o) !== 0x04034b50) throw new ConversionError("CORRUPT", `cabeçalho local inválido em ${JSON.stringify(e.name)}`);
    const start = o + 30 + b.readUInt16LE(o + 26) + b.readUInt16LE(o + 28);
    const data = b.subarray(start, start + e.compSize);
    let n: number;
    if (e.method === 0) n = data.length;
    else if (e.method === 8) {
      try { n = inflateRawSync(data, { maxOutputLength: Math.min(limits.maxZipEntryBytes, limits.maxZipTotalBytes - actualTotal) }).length; }
      catch (err) {
        if ((err as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") throw new ConversionError("ZIP_BOMB", `entrada ${JSON.stringify(e.name)} descomprime acima do teto`);
        throw new ConversionError("CORRUPT", `entrada ${JSON.stringify(e.name)} com dados de compressão inválidos`);
      }
    } else throw new ConversionError("CORRUPT", `método de compressão ${e.method} não suportado em ${JSON.stringify(e.name)}`);
    actualTotal += n;
    if (actualTotal > limits.maxZipTotalBytes) throw new ConversionError("ZIP_BOMB", "o pacote descomprime acima do teto total");
  }
  return entries.length;
}

// ── docx ─────────────────────────────────────────────────────────────────────────────────────

async function convertDocx(buf: Buffer, meta: ConvertMeta, limits: ConversionLimits): Promise<ConvertOutput> {
  const entries = inspectDocxZip(buf, limits);
  // `convertToMarkdown` existe (deprecated nos tipos, mas suportado e documentado pelo mammoth); tipagem local mínima
  const mammoth = (await import("mammoth")).default as unknown as {
    convertToMarkdown(input: { buffer: Buffer }, opts: unknown): Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
    images: { imgElement(fn: () => Promise<{ src: string }>): unknown };
  };
  let res: { value: string; messages: Array<{ type: string; message: string }> };
  try {
    res = await mammoth.convertToMarkdown({ buffer: buf }, {
      // imagens NUNCA são lidas nem embutidas: `src` vazio, depois substituído por um marcador textual
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
    });
  } catch (e) {
    throw new ConversionError("CORRUPT", `docx ilegível: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
  }
  const warnings: ConversionWarning[] = [];
  let md = res.value;
  if (/!\[[^\]]*\]\([^)]*\)/.test(md)) { warnings.push("IMAGES_OMITTED"); md = md.replace(/!\[[^\]]*\]\([^)]*\)/g, "[imagem omitida]"); }
  // links: só http(s), mailto e âncoras; o resto (javascript:, data:, file:…) vira só o texto
  md = md.replace(/(?<!!)\[([^\]]*)\]\(([^)]*)\)/g, (_m, text: string, href: string) => {
    if (/^\s*(https?:|mailto:|#)/i.test(href)) return `[${text}](${href.trim()})`;
    warnings.push("LINKS_SANITIZED");
    return text;
  });
  if (res.messages.length > 0) warnings.push("CONVERTER_MESSAGES");
  return finalize(md, meta, warnings, limits, { entries });
}

// ── pdf ──────────────────────────────────────────────────────────────────────────────────────

interface PdfTextItem { str: string; hasEOL?: boolean; transform?: number[]; height?: number }

async function convertPdf(buf: Buffer, meta: ConvertMeta, limits: ConversionLimits): Promise<ConvertOutput> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const warnings: ConversionWarning[] = [];
  let doc;
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false, // sem new Function para fontes
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      useWorkerFetch: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    doc = await task.promise;
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name === "PasswordException") throw new ConversionError("ENCRYPTED", "PDF protegido por senha");
    throw new ConversionError("CORRUPT", `PDF ilegível: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
  }
  try {
    const total = doc.numPages;
    const pages = Math.min(total, limits.maxPages);
    if (total > limits.maxPages) warnings.push("TRUNCATED_PAGES");
    const out: string[] = [];
    let chars = 0;
    for (let p = 1; p <= pages; p++) {
      let page;
      try { page = await doc.getPage(p); }
      catch (e) { throw new ConversionError("CORRUPT", `página ${p} ilegível: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)); }
      const content = await page.getTextContent();
      let line = "";
      let lastY: number | null = null;
      const lines: string[] = [];
      for (const raw of content.items as unknown[]) {
        const it = raw as PdfTextItem;
        if (typeof it.str !== "string") continue;
        const y = it.transform?.[5] ?? null;
        const h = Math.abs(it.height ?? it.transform?.[3] ?? 10) || 10;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > h * 0.6 && line) { lines.push(line); line = ""; }
        line += it.str;
        if (y !== null) lastY = y;
        if (it.hasEOL) { lines.push(line); line = ""; }
      }
      if (line) lines.push(line);
      page.cleanup();
      const text = lines.map((l) => l.replace(/\s+$/, "").replace(/^(\s*)([#>])/, "$1\\$2")).join("\n").trim();
      if (text) { out.push(`<!-- página ${p} -->\n\n${text}`); chars += text.length; }
      if (chars > limits.maxOutputChars) { warnings.push("TRUNCATED_CHARS"); break; }
    }
    return finalize(out.join("\n\n"), meta, warnings, limits, { pages: total });
  } finally {
    await doc.destroy().catch(() => {});
  }
}

// ── doc (OLE2 legado) ────────────────────────────────────────────────────────────────────────

const VBA_MARKER = Buffer.from("_VBA_PROJECT", "utf16le");

async function convertDoc(buf: Buffer, meta: ConvertMeta, limits: ConversionLimits): Promise<ConvertOutput> {
  // OLE2: setor de 512 (shift 9) ou 4096 (shift 12); qualquer outra coisa é cabeçalho forjado/corrompido
  const shift = buf.length >= 32 ? buf.readUInt16LE(30) : 0;
  if (shift !== 9 && shift !== 12) throw new ConversionError("CORRUPT", "cabeçalho OLE2 inválido");
  if (buf.includes(VBA_MARKER)) throw new ConversionError("ACTIVE_CONTENT", "o documento .doc contém projeto de macros (VBA); salve sem macros");
  const WordExtractor = (await import("word-extractor")).default as unknown as new () => { extract(b: Buffer): Promise<{ getBody(): string }> };
  let body: string;
  try { body = (await new WordExtractor().extract(buf)).getBody(); }
  catch (e) { throw new ConversionError("CORRUPT", `doc ilegível: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)); }
  // parágrafos separados por linha em branco (o .doc usa \n como fim de parágrafo)
  const md = body.split(/\n/).map((l) => l.replace(/^(\s*)([#>])/, "$1\\$2")).join("\n\n");
  return finalize(md, meta, [], limits, {});
}

// ── entrada única ────────────────────────────────────────────────────────────────────────────

/** Converte (síncrono do ponto de vista do chamador; deve rodar no processo filho). Lança `ConversionError`. */
export async function convertBuffer(ext: string, buf: Buffer, meta: ConvertMeta, limits: ConversionLimits = CONVERSION_LIMIT_DEFAULTS): Promise<ConvertOutput> {
  if (![".pdf", ".docx", ".doc"].includes(ext)) throw new ConversionError("UNSUPPORTED_TYPE", `extensão ${ext} não é convertível`);
  if (buf.length === 0) throw new ConversionError("CORRUPT", "arquivo vazio");
  if (buf.length > limits.maxInputBytes) throw new ConversionError("INPUT_TOO_LARGE", `arquivo com ${buf.length} bytes (máximo ${limits.maxInputBytes})`);
  const mismatch = contentMismatch(ext, buf);
  if (mismatch) throw new ConversionError("CORRUPT", mismatch);
  if (ext !== ".doc") {
    const active = activeContentProblem(ext, buf);
    if (active) throw new ConversionError("ACTIVE_CONTENT", active);
  }
  if (ext === ".pdf") return convertPdf(buf, meta, limits);
  if (ext === ".docx") return convertDocx(buf, meta, limits);
  return convertDoc(buf, meta, limits);
}
