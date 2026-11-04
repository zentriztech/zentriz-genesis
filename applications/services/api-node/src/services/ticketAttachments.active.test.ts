/**
 * M-14 / M-16 — conteúdo ativo (docx com macro, PDF com JavaScript) e cabeçalhos de download.
 */
import { describe, it, expect } from "vitest";
import { activeContentProblem, validateAttachments, downloadContentType, attachmentContentDisposition, ATTACHMENT_LIMIT_DEFAULTS } from "./ticketAttachments.js";
import { cleanDocx, macroDocx, buildZip } from "../testing/zipFixture.js";

const pdf = (body: string) => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, "latin1");

describe("M-16 — docx", () => {
  it("docx limpo passa", () => { expect(activeContentProblem(".docx", cleanDocx())).toBeNull(); });
  it("vbaProject.bin recusado", () => { expect(activeContentProblem(".docx", macroDocx())).toMatch(/vbaProject\.bin/); });
  it("macroEnabled só no Content_Types (comprimido, sem .bin) também é recusado", () => {
    expect(activeContentProblem(".docx", macroDocx({ withBin: false }))).toMatch(/macroEnabled/);
  });
  it("Content_Types sem compressão também é lido; docx sem diretório central cai na busca bruta", () => {
    const z = buildZip([{ name: "[Content_Types].xml", content: "<x macroEnabled/>", deflate: false }, { name: "word/document.xml", content: "<d/>" }]);
    expect(activeContentProblem(".docx", z)).toMatch(/macroEnabled/);
    expect(activeContentProblem(".docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("..[Content_Types].xml..word/..vbaProject.bin")]))).toMatch(/vbaProject/);
  });
  it("saída da descompressão é limitada (sem zip bomb): entrada gigante é recusada sem estourar memória", () => {
    const bomb = buildZip([{ name: "[Content_Types].xml", content: Buffer.alloc(50 * 1024 * 1024, 0x20) }, { name: "word/document.xml", content: "<d/>" }]);
    expect(activeContentProblem(".docx", bomb)).toMatch(/anormalmente grande/);
  });
});

describe("M-16 — pdf", () => {
  it("PDF limpo e com /OpenAction simples (ir para a página) passam", () => {
    expect(activeContentProblem(".pdf", pdf("1 0 obj<</Type/Catalog>>endobj"))).toBeNull();
    expect(activeContentProblem(".pdf", pdf("1 0 obj<</Type/Catalog/OpenAction[3 0 R /Fit]>>endobj"))).toBeNull();
  });
  it("/JavaScript, /JS e /Launch são recusados, inclusive com nome escapado (#xx)", () => {
    expect(activeContentProblem(".pdf", pdf("<</S/JavaScript/JS(app.alert(1))>>"))).toMatch(/JavaScript/);
    expect(activeContentProblem(".pdf", pdf("<</S /JS /JS (x)>>"))).toMatch(/JS/);
    expect(activeContentProblem(".pdf", pdf("<</S/Launch/F(cmd.exe)>>"))).toMatch(/Launch/);
    expect(activeContentProblem(".pdf", pdf("<</S/J#61vaScript>>"))).toMatch(/JavaScript/);
  });
  it("bytes dentro de stream comprimido não geram falso positivo", () => {
    expect(activeContentProblem(".pdf", pdf("5 0 obj<</Length 12>>\nstream\n/JavaScript /JS /Launch\nendstream\nendobj"))).toBeNull();
    // ...mas o dicionário FORA do stream continua sendo visto (o 'stream' de 'endstream' não engole o resto)
    expect(activeContentProblem(".pdf", pdf("5 0 obj<<>>\nstream\nabc\nendstream\nendobj\n6 0 obj<</S/JavaScript>>endobj"))).toMatch(/JavaScript/);
  });
  it("validateAttachments devolve ATTACHMENT_ACTIVE_CONTENT", () => {
    const errs = validateAttachments([{ filename: "a.docx", buffer: macroDocx() }, { filename: "b.pdf", buffer: pdf("<</S/JavaScript>>") }, { filename: "ok.docx", buffer: cleanDocx() }],
      { ...ATTACHMENT_LIMIT_DEFAULTS });
    expect(errs.map((e) => `${e.filename}:${e.code}`)).toEqual(["a.docx:ATTACHMENT_ACTIVE_CONTENT", "b.pdf:ATTACHMENT_ACTIVE_CONTENT"]);
  });
});

describe("M-14 — download", () => {
  it("Content-Type vem da extensão, nunca do cliente; desconhecida ⇒ octet-stream", () => {
    expect(downloadContentType("a.PDF")).toBe("application/pdf");
    expect(downloadContentType("a.doc")).toBe("application/msword");
    expect(downloadContentType("a.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(downloadContentType("a.txt")).toBe("text/plain; charset=utf-8");
    expect(downloadContentType("a.md")).toBe("text/markdown; charset=utf-8");
    expect(downloadContentType("a.html")).toBe("application/octet-stream");
    expect(downloadContentType("semext")).toBe("application/octet-stream");
  });
  it("Content-Disposition seguro para nome fora de Latin-1 (emoji/CJK), aspas e CRLF", () => {
    const h = attachmentContentDisposition('relatório 😀 "final";\r\n.txt');
    expect(h).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain("%F0%9F%98%80");
    expect(h).toContain("relat%C3%B3rio");
    expect(attachmentContentDisposition("日本語.md")).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.md");
    expect(() => { const x = attachmentContentDisposition("日本語.md"); Buffer.from(x, "latin1"); }).not.toThrow();
  });
});
