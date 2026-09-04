/**
 * specTextExtract.test.ts — Onda 4 (PR-1): extratores + endurecimentos de upload.
 *
 * Cobre sniffKind (assinatura × extensão, binário disfarçado), o teto de descompressão de ZIP
 * (zip bomb), a extração de .docx (OOXML) e o best-effort de .pdf, e a extração de ZIP → spec.md.
 */
import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import {
  GATE_TEXT_EXT,
  ZIP_MAX_UNCOMPRESSED_BYTES,
  ZipExtractError,
  assertZipUncompressedCap,
  sniffKind,
  extractDocxText,
  extractPdfTextBestEffort,
  extractZip,
} from "./specTextExtract.js";

/** Monta um .docx mínimo (zip OOXML) com o parágrafo dado em word/document.xml. */
function fakeDocx(paragraph: string): Buffer {
  const zip = new AdmZip();
  const xml =
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>` +
    `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`;
  zip.addFile("word/document.xml", Buffer.from(xml, "utf-8"));
  return zip.toBuffer();
}

describe("sniffKind — assinatura × extensão", () => {
  it(".pdf com %PDF- → ok", () => {
    expect(sniffKind("x.pdf", Buffer.from("%PDF-1.7\n...", "latin1"))).toEqual({ ok: true });
  });
  it(".pdf sem magic → FILE_SIGNATURE_MISMATCH", () => {
    const r = sniffKind("x.pdf", Buffer.from("not a pdf", "latin1"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FILE_SIGNATURE_MISMATCH");
  });
  it(".docx com PK → ok; sem PK → mismatch", () => {
    expect(sniffKind("x.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toEqual({ ok: true });
    const r = sniffKind("x.docx", Buffer.from("MZ..."));
    expect(r.ok).toBe(false);
  });
  it(".md de texto real → ok; .md com bytes NUL → BINARY_DISGUISED", () => {
    expect(sniffKind("a.md", Buffer.from("# título\n\ntexto normal", "utf-8"))).toEqual({ ok: true });
    const bin = Buffer.from(Array.from({ length: 100 }, (_v, i) => (i % 3 === 0 ? 0 : 65)));
    const r = sniffKind("a.md", bin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BINARY_DISGUISED");
  });
  it(".doc (OLE legado) e outras extensões → ok (sem assinatura verificável)", () => {
    expect(sniffKind("a.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toEqual({ ok: true });
    expect(sniffKind("a.yaml", Buffer.from("k: v"))).toEqual({ ok: true });
  });
});

describe("assertZipUncompressedCap — zip bomb", () => {
  it("ZIP pequeno passa", () => {
    const zip = new AdmZip();
    zip.addFile("a.txt", Buffer.from("pequeno"));
    expect(() => assertZipUncompressedCap(zip)).not.toThrow();
  });
  it("ZIP cujo tamanho descomprimido declarado excede o teto → ZipExtractError ZIP_TOO_LARGE", () => {
    const zip = new AdmZip();
    // Um único arquivo grande de verdade: o header.size passa a exceder o teto.
    zip.addFile("big.txt", Buffer.alloc(ZIP_MAX_UNCOMPRESSED_BYTES + 1024, 0x41));
    try {
      assertZipUncompressedCap(zip);
      throw new Error("deveria ter lançado");
    } catch (e) {
      expect(e).toBeInstanceOf(ZipExtractError);
      expect((e as ZipExtractError).code).toBe("ZIP_TOO_LARGE");
    }
  });
});

describe("extractDocxText", () => {
  it("extrai o texto do parágrafo e decodifica entidades", () => {
    const buf = fakeDocx("Olá &amp; mundo &lt;spec&gt;");
    expect(extractDocxText(buf)).toBe("Olá & mundo <spec>");
  });
  it("buffer que não é docx → string vazia (best-effort)", () => {
    expect(extractDocxText(Buffer.from("lixo"))).toBe("");
  });
});

describe("extractPdfTextBestEffort", () => {
  it("captura strings de operadores Tj/TJ", () => {
    const pdf = "%PDF-1.4\nBT (Olá mundo) Tj (segunda linha) Tj ET";
    const out = extractPdfTextBestEffort(Buffer.from(pdf, "latin1"));
    expect(out).toContain("Olá mundo");
    expect(out).toContain("segunda linha");
  });
  it("PDF sem texto (só imagem/comprimido) → string vazia", () => {
    expect(extractPdfTextBestEffort(Buffer.from("%PDF-1.4\nbinário sem operadores de texto"))).toBe("");
  });
});

describe("extractZip → spec.md único", () => {
  it("concatena docs e marca código como referência", () => {
    const zip = new AdmZip();
    zip.addFile("docs/spec.md", Buffer.from("# Spec\n\nConteúdo da spec."));
    zip.addFile("src/index.ts", Buffer.from("export const x = 1;"));
    zip.addFile("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])); // binário ignorado
    const out = extractZip(zip.toBuffer(), "produto.zip");
    expect(out).toHaveLength(1);
    expect(out[0].filename).toBe("produto-spec.md");
    const md = out[0].buffer.toString("utf-8");
    expect(md).toContain("Conteúdo da spec.");
    expect(md).toContain("EXEMPLO DE REFERÊNCIA");
    expect(md).toContain("index.ts");
    expect(md).not.toContain("logo.png");
  });
  it("ZIP sem arquivos legíveis → ZipExtractError BAD_REQUEST", () => {
    const zip = new AdmZip();
    zip.addFile("foto.png", Buffer.from([0x89, 0x50]));
    try {
      extractZip(zip.toBuffer(), "vazio.zip");
      throw new Error("deveria ter lançado");
    } catch (e) {
      expect(e).toBeInstanceOf(ZipExtractError);
      expect((e as ZipExtractError).code).toBe("BAD_REQUEST");
    }
  });
});

describe("GATE_TEXT_EXT", () => {
  it("inclui os formatos de texto legível esperados", () => {
    for (const ext of [".md", ".txt", ".yaml", ".yml", ".json", ".csv", ".xml", ".html"]) {
      expect(GATE_TEXT_EXT.has(ext)).toBe(true);
    }
    expect(GATE_TEXT_EXT.has(".docx")).toBe(false);
    expect(GATE_TEXT_EXT.has(".pdf")).toBe(false);
  });
});
