/**
 * specTextExtract.ts — extratores de texto de anexos de spec (Onda 4 do épico Spec/Bancada).
 *
 * Estes extratores eram PRIVADOS de routes/specs.ts; foram movidos para cá para que o
 * `POST /api/projects/:id/decompose` (products.ts) possa montar o documento a partir de
 * `.md/.txt/.yaml` puro, `.docx` (OOXML) e `.pdf` (best-effort) — antes o decompose lia só
 * `.md`. `specs.ts` reexporta/importa daqui, então o comportamento do upload NÃO muda.
 *
 * Endurecimentos de upload (OWASP File Upload) adicionados nesta onda:
 *   • sniffKind() — valida a ASSINATURA (magic bytes) contra a extensão declarada (allowlist
 *     por extensão sozinha é falsificável) e rejeita texto binário disfarçado.
 *   • ZIP_MAX_UNCOMPRESSED_BYTES / assertZipUncompressedCap() — teto de descompressão (defesa
 *     contra zip bomb): a allowlist não limitava o tamanho pós-descompressão.
 */
import path from "path";
import AdmZip from "adm-zip";

export type ExtractedFile = { filename: string; buffer: Buffer; mimeType: string };

/** Extensões cujo conteúdo é texto legível direto — alimentam o gate semântico e o decompose. */
export const GATE_TEXT_EXT = new Set([".md", ".txt", ".yaml", ".yml", ".json", ".csv", ".xml", ".html"]);

// Extensões legíveis extraídas de ZIPs — código é incluído como EXEMPLO DE REFERÊNCIA.
export const ZIP_TEXT_EXTS = new Set([".md", ".txt", ".yaml", ".yml", ".json"]);
export const ZIP_CODE_EXTS = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".sql", ".sh"]);
// Palavras no nome/path do arquivo que indicam "é referência/exemplo, não spec".
export const REFERENCE_HINTS = ["example", "sample", "reference", "schema", "structure", "template", "demo"];
export const ZIP_BINARY_SKIP = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
                                        ".zip", ".tar", ".gz", ".exe", ".bin", ".lock"]);

/** Teto de bytes descomprimidos aceito de um ZIP (defesa contra zip bomb). */
export const ZIP_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024; // 20 MiB

/** Erro tipado da extração de ZIP — carrega um `code` para o handler mapear o status HTTP. */
export class ZipExtractError extends Error {
  constructor(message: string, public code: "BAD_REQUEST" | "ZIP_TOO_LARGE" = "BAD_REQUEST") {
    super(message);
    this.name = "ZipExtractError";
  }
}

/**
 * Barra ZIPs cujo tamanho descomprimido DECLARADO excede o teto — checa antes de qualquer
 * `getData()` (que descomprime). Um zip bomb declara o tamanho real no diretório central,
 * então a soma de `entry.header.size` já denuncia o abuso sem materializar os bytes.
 */
export function assertZipUncompressedCap(zip: AdmZip): void {
  let total = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    total += (e.header?.size as number | undefined) ?? 0;
    if (total > ZIP_MAX_UNCOMPRESSED_BYTES) {
      throw new ZipExtractError(
        `O ZIP excede o teto de ${Math.round(ZIP_MAX_UNCOMPRESSED_BYTES / 1024 / 1024)} MiB descomprimido. ` +
        "Reduza o conteúdo e tente novamente.",
        "ZIP_TOO_LARGE",
      );
    }
  }
}

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const ZIP_PK = [0x50, 0x4b]; // "PK" — prefixo de todo container ZIP/OOXML (docx)

/**
 * Confere a ASSINATURA (magic bytes) do arquivo contra a extensão declarada. A allowlist por
 * extensão sozinha é falsificável (um `.docx` pode carregar um executável). Retorna `{ ok:true }`
 * quando a assinatura bate (ou quando não há assinatura a checar, ex.: `.doc` OLE legado);
 * `{ ok:false, code }` quando diverge:
 *   • FILE_SIGNATURE_MISMATCH — `.pdf` sem `%PDF-`, `.docx/.zip` sem `PK`.
 *   • BINARY_DISGUISED — `.md/.txt` com > 5 % de bytes NUL/controle (binário disfarçado de texto).
 */
export function sniffKind(
  filename: string,
  buffer: Buffer,
): { ok: true } | { ok: false; code: "FILE_SIGNATURE_MISMATCH" | "BINARY_DISGUISED"; message: string } {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") {
    if (buffer.length < 5 || !buffer.subarray(0, 5).equals(PDF_MAGIC)) {
      return { ok: false, code: "FILE_SIGNATURE_MISMATCH", message: "O arquivo .pdf não tem uma assinatura PDF válida (%PDF-)." };
    }
  } else if (ext === ".docx" || ext === ".zip") {
    if (buffer.length < 2 || buffer[0] !== ZIP_PK[0] || buffer[1] !== ZIP_PK[1]) {
      return { ok: false, code: "FILE_SIGNATURE_MISMATCH", message: `O arquivo ${ext} não tem uma assinatura de container válida (PK).` };
    }
  } else if (ext === ".md" || ext === ".txt") {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    let bad = 0;
    for (const b of sample) {
      // Aceita tab (9), LF (10), VT (11), FF (12), CR (13); rejeita NUL e demais controles.
      if (b === 0 || b < 9 || (b > 13 && b < 32)) bad += 1;
    }
    if (sample.length > 0 && bad / sample.length > 0.05) {
      return { ok: false, code: "BINARY_DISGUISED", message: "O arquivo de texto contém bytes binários — envie um .md/.txt de texto real." };
    }
  }
  // .doc (OLE legado) e demais extensões da allowlist: sem assinatura verificável aqui.
  return { ok: true };
}

/** Decodifica as entidades XML básicas de um texto extraído de docx. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Extrai texto de um .docx (que é um zip OOXML): lê word/document.xml e derivados,
 * insere quebras onde há <w:p>/<w:br>, remove as tags e decodifica entidades.
 * Retorna "" se não parecer um docx válido.
 */
export function extractDocxText(buffer: Buffer): string {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter(
      (e) => !e.isDirectory && /^word\/(document|header\d*|footer\d*)\.xml$/.test(e.entryName),
    );
    if (entries.length === 0) return "";
    let out = "";
    for (const e of entries) {
      const xml = e.getData().toString("utf-8");
      out += " " + xml
        .replace(/<w:(p|br|tab)\b[^>]*\/?>/g, " ")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]+>/g, "");
    }
    return decodeXmlEntities(out).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

/**
 * Extração BEST-EFFORT de texto de PDF sem dependência nova: pega tokens de texto
 * mostrados por operadores Tj/TJ (strings entre parênteses) em streams NÃO comprimidos.
 * PDFs de texto simples rendem conteúdo; PDFs em branco/lixo/comprimidos rendem ~nada
 * (e então o gate trata como "sem conteúdo legível"). Não pretende ser um parser completo.
 */
export function extractPdfTextBestEffort(buffer: Buffer): string {
  try {
    const raw = buffer.toString("latin1");
    const chunks: string[] = [];
    // strings de texto entre parênteses (operadores Tj/TJ). Escapes \( \) \\ tolerados.
    const re = /\(((?:\\.|[^()\\])*)\)\s*T[jJ]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const s = m[1]
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\\t/g, " ");
      if (s.trim()) chunks.push(s);
    }
    return chunks.join(" ").replace(/[ \t]+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * Monta o texto a ser julgado pelo gate semântico. Prefere a descrição em texto livre
 * (o que o usuário realmente digitou); na ausência dela (modo anexos), extrai o texto
 * dos arquivos: .md/.txt/.yaml/… direto, .docx via OOXML, .pdf best-effort. Binários
 * ilegíveis (imagens, PDF só-imagem, docx corrompido) rendem "" para aquele arquivo.
 */
export function buildGateContent(
  freeDescription: string | null,
  files: { filename: string; buffer: Buffer }[],
): string {
  const fd = (freeDescription ?? "").trim();
  if (fd.length > 0) return fd;
  const parts: string[] = [];
  for (const f of files) {
    const ext = path.extname(f.filename).toLowerCase();
    try {
      if (GATE_TEXT_EXT.has(ext)) {
        parts.push(f.buffer.toString("utf-8"));
      } else if (ext === ".docx" || ext === ".doc") {
        const t = extractDocxText(f.buffer);
        if (t) parts.push(t);
      } else if (ext === ".pdf") {
        const t = extractPdfTextBestEffort(f.buffer);
        if (t) parts.push(t);
      }
    } catch {
      /* ignora arquivo ilegível */
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Extrai um ZIP e produz UM ÚNICO arquivo spec.md concatenando todo o conteúdo.
 * - Arquivos de spec/docs/contrato (.md, .txt, .yaml, .json): incluídos diretamente.
 * - Arquivos de código (.ts, .js, .py, .sql, etc.): incluídos com cabeçalho
 *   "EXEMPLO DE REFERÊNCIA — não copiar literalmente".
 * - Binários e arquivos ocultos: ignorados.
 * - Não depende de paths ou estrutura de diretórios do ZIP.
 */
export function extractZip(zipBuffer: Buffer, originalName: string): ExtractedFile[] {
  const zip = new AdmZip(zipBuffer);
  assertZipUncompressedCap(zip); // teto de descompressão (zip bomb) antes de qualquer getData()
  const entries = zip.getEntries().filter((e) => {
    if (e.isDirectory) return false;
    const name = e.entryName;
    // Ignorar ocultos e MACOSX
    if (path.basename(name).startsWith(".")) return false;
    if (name.includes("__MACOSX") || name.includes(".DS_Store")) return false;
    const ext = path.extname(name).toLowerCase();
    // Ignorar binários explícitos
    if (ZIP_BINARY_SKIP.has(ext)) return false;
    // Aceitar texto + código
    return ZIP_TEXT_EXTS.has(ext) || ZIP_CODE_EXTS.has(ext);
  });

  if (entries.length === 0) {
    throw new ZipExtractError(
      `O ZIP "${originalName}" não contém arquivos de texto legíveis (.md, .yaml, .ts, etc.). ` +
      "Verifique o conteúdo e tente novamente.",
    );
  }

  // Ordenar: docs primeiro (md/txt/yaml/json), código depois
  entries.sort((a, b) => {
    const extA = path.extname(a.entryName).toLowerCase();
    const extB = path.extname(b.entryName).toLowerCase();
    const isCodeA = ZIP_CODE_EXTS.has(extA) ? 1 : 0;
    const isCodeB = ZIP_CODE_EXTS.has(extB) ? 1 : 0;
    if (isCodeA !== isCodeB) return isCodeA - isCodeB;
    return a.entryName.localeCompare(b.entryName);
  });

  // Concatenar tudo em um único spec.md
  const sections: string[] = [];
  for (const entry of entries) {
    const basename    = path.basename(entry.entryName);
    const ext         = path.extname(basename).toLowerCase();
    const entryLower  = entry.entryName.toLowerCase();
    const isCode      = ZIP_CODE_EXTS.has(ext) ||
                        REFERENCE_HINTS.some((h) => entryLower.includes(h));

    let text: string;
    try {
      text = entry.getData().toString("utf-8").trim();
    } catch {
      continue; // pular arquivos que não decodificam como UTF-8
    }
    if (!text) continue;

    if (isCode) {
      // Código/infra é contexto/exemplo — nunca instrução literal
      const lang = ext.replace(".", "") || "text";
      sections.push(
        `---\n## [EXEMPLO DE REFERÊNCIA: ${entry.entryName}]\n` +
        `> ATENÇÃO: Este arquivo é apenas uma referência de estrutura. ` +
        `NÃO copiar literalmente. Adaptar à arquitetura definida nas specs deste produto.\n\n` +
        `\`\`\`${lang}\n${text}\n\`\`\``
      );
    } else {
      sections.push(`---\n## [${entry.entryName}]\n\n${text}`);
    }
  }

  const combined = sections.join("\n\n");
  const zipBase  = path.basename(originalName, ".zip");
  return [{
    filename: `${zipBase}-spec.md`,
    buffer:   Buffer.from(combined, "utf-8"),
    mimeType: "text/markdown",
  }];
}
