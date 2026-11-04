/**
 * Tarefa 1.5 — allowlist por extensão + magic bytes + tetos (unitário, sem banco).
 */
import { describe, it, expect } from "vitest";
import {
  attachmentsStrictEnvDefault, classifyAttachment, contentMismatch, validateAttachments, loadAttachmentLimits,
  ATTACHMENT_LIMIT_DEFAULTS, type AttachmentLimits,
} from "./ticketAttachments.js";
import {
  getAttachmentConverter, registerAttachmentConverter, resetAttachmentConverters, nullConverter, conversionOrigin,
} from "./attachmentConversion.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\n%%EOF\n", "latin1");
const DOC = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 0x80)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....word/document.xml....")]);
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....xl/workbook.xml....")]);
const L: AttachmentLimits = { maxFiles: 3, maxTotalBytes: 1000, maxFileBytes: 600 };

describe("ATTACHMENTS_STRICT", () => {
  it("default de plataforma do env: padrão off; 'on'/'1'/'true' ligam (a decisão por tenant está em featureFlags)", () => {
    expect(attachmentsStrictEnvDefault({} as NodeJS.ProcessEnv)).toBe(false);
    expect(attachmentsStrictEnvDefault({ ATTACHMENTS_STRICT: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(attachmentsStrictEnvDefault({ ATTACHMENTS_STRICT: "talvez" } as NodeJS.ProcessEnv)).toBe(false);
    expect(attachmentsStrictEnvDefault({ ATTACHMENTS_STRICT: " ON " } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("classificação e conteúdo", () => {
  it("txt/md = spec_text; pdf/doc/docx = card_only; o resto = fora", () => {
    expect(classifyAttachment("a.TXT")).toBe("spec_text");
    expect(classifyAttachment("a.md")).toBe("spec_text");
    for (const n of ["a.pdf", "a.doc", "a.docx"]) expect(classifyAttachment(n)).toBe("card_only");
    for (const n of ["a.png", "a.xlsx", "a.zip", "a", "a.exe"]) expect(classifyAttachment(n)).toBeNull();
  });
  it("magic bytes coerentes com a extensão", () => {
    expect(contentMismatch(".pdf", PDF)).toBeNull();
    expect(contentMismatch(".doc", DOC)).toBeNull();
    expect(contentMismatch(".docx", DOCX)).toBeNull();
    expect(contentMismatch(".txt", Buffer.from("olá, ação\n", "utf-8"))).toBeNull();
    expect(contentMismatch(".md", Buffer.from("# título\n"))).toBeNull();
  });
  it("extensão mente: cada tipo é recusado com conteúdo de outro", () => {
    expect(contentMismatch(".pdf", DOCX)).not.toBeNull();
    expect(contentMismatch(".docx", XLSX)).not.toBeNull();   // zip, mas não é documento Word
    expect(contentMismatch(".docx", PDF)).not.toBeNull();
    expect(contentMismatch(".doc", DOCX)).not.toBeNull();
    expect(contentMismatch(".txt", PDF)).toMatch(/binário/);
    expect(contentMismatch(".md", PNG)).toMatch(/binário/);
    expect(contentMismatch(".txt", Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x80]))).toMatch(/UTF-8/);
    expect(contentMismatch(".txt", Buffer.from([0x68, 0x00, 0x69]))).toMatch(/NUL/);
  });
});

describe("validateAttachments", () => {
  const ok = [{ filename: "a.md", buffer: Buffer.from("# x") }, { filename: "b.pdf", buffer: PDF }];
  it("lote válido ⇒ sem erros", () => expect(validateAttachments(ok, L)).toEqual([]));
  it("png/xlsx recusados por tipo, com código estável", () => {
    const e = validateAttachments([{ filename: "p.png", buffer: PNG }, { filename: "p.xlsx", buffer: XLSX }], L);
    expect(e.map((x) => x.code)).toEqual(["ATTACHMENT_TYPE_NOT_ALLOWED", "ATTACHMENT_TYPE_NOT_ALLOWED"]);
  });
  it("conteúdo incoerente e UTF-8 inválido têm códigos distintos", () => {
    const e = validateAttachments([{ filename: "f.pdf", buffer: DOCX }, { filename: "t.txt", buffer: Buffer.from([0xff, 0xfe, 0x68]) }], L);
    expect(e.map((x) => x.code)).toEqual(["ATTACHMENT_CONTENT_MISMATCH", "ATTACHMENT_NOT_UTF8"]);
  });
  it("teto de arquivos, por arquivo e somado", () => {
    const f = (n: string, b: number) => ({ filename: n, buffer: Buffer.alloc(b, 0x61) });
    expect(validateAttachments([f("1.txt", 10), f("2.txt", 10), f("3.txt", 10), f("4.txt", 10)], L).map((x) => x.code)).toContain("ATTACHMENT_TOO_MANY");
    expect(validateAttachments([f("1.txt", 601)], L).map((x) => x.code)).toEqual(["ATTACHMENT_TOO_LARGE"]);
    expect(validateAttachments([f("1.txt", 500), f("2.txt", 500), f("3.txt", 100)], L).map((x) => x.code)).toEqual(["ATTACHMENT_TOTAL_TOO_LARGE"]);
    expect(validateAttachments([{ filename: "v.txt", buffer: Buffer.alloc(0) }], L).map((x) => x.code)).toEqual(["ATTACHMENT_EMPTY"]);
  });
});

describe("limites vêm de genesis_runtime_config (não de constantes)", () => {
  const dbWith = (rows: Record<string, string>) => ({
    query: async (_s: string, p?: unknown[]) => ({ rows: rows[String(p?.[0])] !== undefined ? [{ value: rows[String(p?.[0])] }] : [] }),
  });
  it("padrões conservadores quando a tabela não tem a chave", async () => {
    expect(await loadAttachmentLimits(dbWith({}), null)).toEqual(ATTACHMENT_LIMIT_DEFAULTS);
  });
  it("valor da tabela vence; fora da faixa é ignorado", async () => {
    const l = await loadAttachmentLimits(dbWith({ ATTACHMENT_MAX_FILES: "3", ATTACHMENT_MAX_TOTAL_BYTES: "5", ATTACHMENT_MAX_FILE_BYTES: "2048" }), null);
    expect(l.maxFiles).toBe(3);
    expect(l.maxTotalBytes).toBe(ATTACHMENT_LIMIT_DEFAULTS.maxTotalBytes); // 5 < 1024 ⇒ ignorado
    expect(l.maxFileBytes).toBe(2048);
  });
});

describe("ponto de extensão attachmentConversion", () => {
  it("só o conversor NULO vem registrado e não converte nada", async () => {
    resetAttachmentConverters();
    const c = getAttachmentConverter(".pdf");
    expect(c).toBe(nullConverter);
    expect(await c.convert({ attachmentId: "x", filename: "a.pdf", ext: ".pdf", buffer: PDF })).toBeNull();
  });
  it("conversor registrado tem precedência; origem marcada como converted:<id>", async () => {
    resetAttachmentConverters();
    registerAttachmentConverter({ id: "fake", accepts: (e) => e === ".pdf", convert: async () => ({ filename: "a.md", markdown: "# a" }) });
    expect(getAttachmentConverter(".pdf").id).toBe("fake");
    expect(getAttachmentConverter(".docx")).toBe(nullConverter);
    expect(conversionOrigin("fake")).toBe("converted:fake");
    resetAttachmentConverters();
  });
});
