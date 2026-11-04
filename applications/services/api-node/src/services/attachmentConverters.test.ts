/**
 * Tarefa Q — conversão pdf/docx/doc → Markdown: fixtures REAIS geradas em memória (src/testing/attachmentFixtures.ts),
 * executadas no processo filho isolado (o mesmo caminho do produto). Sem Postgres, sem rede, sem LLM.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { runConversionIsolated, conversionLimitsFromEnv } from "./attachmentConversionRunner.js";
import { CONVERSION_LIMIT_DEFAULTS, ConversionError, convertBuffer, type ConversionLimits } from "./attachmentConverters.js";
import {
  makeDocx, makeDocxBomb, makeDocxLyingSize, makeDocxManyEntries, makePdf, makePdfNoText, makePdfWithJs, makeDoc,
} from "../testing/attachmentFixtures.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const meta = (name: string, b: Buffer) => ({ attachmentId: "11111111-2222-3333-4444-555555555555", filename: name, sha256: sha(b), now: new Date("2026-11-04T12:00:00Z") });
const run = (ext: string, b: Buffer, name = `arq${ext}`, limits: Partial<ConversionLimits> = {}) =>
  runConversionIsolated(ext, b, meta(name, b), { ...CONVERSION_LIMIT_DEFAULTS, ...limits });
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ConversionError; } throw new Error("deveria ter falhado"); };

describe("cabeçalho de origem", () => {
  it("todo derivado começa com a marca de origem (nome, anexo, sha256 de 8, data, aviso de perdas)", async () => {
    const b = makeDocx();
    const out = await run(".docx", b, "contrato.docx");
    expect(out.markdown.split("\n")[0]).toBe(
      `> Convertido automaticamente de contrato.docx (anexo 11111111-2222-3333-4444-555555555555, sha256 ${sha(b).slice(0, 8)}) em 2026-11-04; pode conter perdas de formatação`);
  });
});

describe("docx → md (mammoth, sem executar nada)", () => {
  it("converte título, parágrafos e acentuação", async () => {
    const out = await run(".docx", makeDocx({ paragraphs: ["Visão geral", "Texto com acentuação: ação, coração.", "Fim."] }));
    expect(out.markdown).toContain("# Visão geral");
    expect(out.markdown).toContain("Texto com acentuação: ação, coração");
    expect(out.warnings).toEqual([]);
    expect(out.stats.entries).toBe(5);
  });
  it("docx sem texto algum ⇒ vazio com NO_TEXT_LAYER (nada inventado)", async () => {
    const out = await run(".docx", makeDocx({ paragraphs: [""], headingFirst: false }));
    expect(out.markdown).toBe("");
    expect(out.warnings).toContain("NO_TEXT_LAYER");
  });
  it("macro (vbaProject.bin) é recusada na conversão mesmo se passou pelo upload (defesa em profundidade)", async () => {
    const e = await fails(run(".docx", makeDocx({ macro: true })));
    expect(e.code).toBe("ACTIVE_CONTENT");
  });
  it("zip bomb sintético (razão de compressão altíssima) ⇒ ZIP_BOMB, sem descomprimir", async () => {
    const bomb = makeDocxBomb(30 * 1024 * 1024); // ~30 MiB de zeros, ~30 KiB comprimidos
    expect(bomb.length).toBeLessThan(200 * 1024);
    const e = await fails(run(".docx", bomb));
    expect(e.code).toBe("ZIP_BOMB");
    expect(e.message).toMatch(/razão de compressão|descomprime/);
  });
  it("zip que MENTE no tamanho declarado é pego pela descompressão real com teto", async () => {
    const e = await fails(run(".docx", makeDocxLyingSize(2 * 1024 * 1024), "mente.docx", { maxZipEntryBytes: 512 * 1024 }));
    expect(e.code).toBe("ZIP_BOMB");
  });
  it("número de entradas acima do teto ⇒ ZIP_BOMB", async () => {
    const e = await fails(run(".docx", makeDocxManyEntries(60), "muitas.docx", { maxZipEntries: 50 }));
    expect(e.code).toBe("ZIP_BOMB");
    expect(e.message).toMatch(/entradas/);
  });
  it("soma descomprimida acima do teto ⇒ ZIP_BOMB", async () => {
    const b = makeDocx({ extraEntries: [{ name: "word/a.xml", data: Buffer.alloc(600_000, 0x61) }, { name: "word/b.xml", data: Buffer.alloc(600_000, 0x62) }] });
    const e = await fails(run(".docx", b, "soma.docx", { maxZipTotalBytes: 1_000_000, maxZipRatio: 100_000 }));
    expect(e.code).toBe("ZIP_BOMB");
  });
  it("docx corrompido (assinatura boa, zip truncado) ⇒ CORRUPT com erro claro", async () => {
    const good = makeDocx();
    const e = await fails(run(".docx", good.subarray(0, Math.floor(good.length / 2)), "quebrado.docx"));
    expect(e.code).toBe("CORRUPT");
    expect(e.message.length).toBeGreaterThan(10);
  });
  it("saída acima do teto de caracteres é truncada COM aviso explícito", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `Parágrafo número ${i} com bastante texto repetido para encher.`);
    const out = await run(".docx", makeDocx({ paragraphs: long }), "longo.docx", { maxOutputChars: 2000 });
    expect(out.warnings).toContain("TRUNCATED_CHARS");
    expect(out.markdown).toContain("> Aviso: o texto foi truncado em 2000 caracteres.");
    expect(out.markdown.length).toBeLessThan(2000 + 600);
  });
});

describe("pdf → md (pdf.js, só camada de texto, sem scripting)", () => {
  it("PDF com camada de texto: linhas e páginas", async () => {
    const out = await run(".pdf", makePdf([["Relatório de requisitos", "Segunda linha."], ["Conteúdo da página dois."]]));
    expect(out.stats.pages).toBe(2);
    expect(out.markdown).toContain("Relatório de requisitos\nSegunda linha.");
    expect(out.markdown).toContain("<!-- página 2 -->");
    expect(out.markdown).toContain("Conteúdo da página dois.");
  });
  it("PDF só imagem/escaneado ⇒ resultado VAZIO com NO_TEXT_LAYER, nunca texto inventado", async () => {
    const out = await run(".pdf", makePdfNoText());
    expect(out.markdown).toBe("");
    expect(out.warnings).toEqual(["NO_TEXT_LAYER"]);
  });
  it("limite de páginas ⇒ TRUNCATED_PAGES e só as primeiras páginas", async () => {
    const pages = Array.from({ length: 6 }, (_, i) => [`Texto da pagina ${i + 1}`]);
    const out = await run(".pdf", makePdf(pages), "seis.pdf", { maxPages: 2 });
    expect(out.warnings).toContain("TRUNCATED_PAGES");
    expect(out.markdown).toContain("pagina 2");
    expect(out.markdown).not.toContain("pagina 3");
    expect(out.markdown).toContain("> Aviso: só as primeiras 2 páginas foram convertidas.");
  });
  it("PDF com /JavaScript é recusado (M-16) e PDF corrompido dá erro claro", async () => {
    expect((await fails(run(".pdf", makePdfWithJs()))).code).toBe("ACTIVE_CONTENT");
    const broken = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("lixo sem estrutura nenhuma ".repeat(20))]);
    const e = await fails(run(".pdf", broken, "quebrado.pdf"));
    expect(e.code).toBe("CORRUPT");
  });
  it("começo de linha com # ou > é escapado (não vira título/citação por acidente)", async () => {
    const out = await run(".pdf", makePdf([["# nao e titulo", "> nem citacao"]]));
    expect(out.markdown).toContain("\\# nao e titulo");
    expect(out.markdown).toContain("\\> nem citacao");
  });
});

describe("doc legado → md (word-extractor, OLE2)", () => {
  it("converte o texto do corpo em parágrafos", async () => {
    const out = await run(".doc", makeDoc("Primeiro parágrafo legado\rSegundo parágrafo\r"));
    expect(out.markdown).toContain("Primeiro parágrafo legado\n\nSegundo parágrafo");
  });
  it("doc com projeto VBA é recusado; cabeçalho OLE forjado ou arquivo truncado dá erro claro", async () => {
    expect((await fails(run(".doc", makeDoc("x\r", { withVba: true })))).code).toBe("ACTIVE_CONTENT");
    const forged = makeDoc(); forged.writeUInt16LE(31, 30);
    expect((await fails(run(".doc", forged))).code).toBe("CORRUPT");
    const trunc = makeDoc().subarray(0, 900);
    expect((await fails(run(".doc", trunc))).code).toBe("CORRUPT");
  });
});

describe("limites gerais, timeout e isolamento", () => {
  it("entrada acima do teto ⇒ INPUT_TOO_LARGE; extensão estranha ⇒ UNSUPPORTED_TYPE; assinatura incoerente ⇒ CORRUPT", async () => {
    expect((await fails(run(".pdf", makePdf(), "g.pdf", { maxInputBytes: 100 }))).code).toBe("INPUT_TOO_LARGE");
    expect((await fails(run(".png", Buffer.from("x")))).code).toBe("UNSUPPORTED_TYPE");
    expect((await fails(run(".pdf", makeDocx(), "falso.pdf"))).code).toBe("CORRUPT");
  });
  it("timeout rígido: a worker é morta e o erro é TIMEOUT", async () => {
    const t0 = Date.now();
    const e = await fails(run(".pdf", makePdf(), "lento.pdf", { timeoutMs: 1 }));
    expect(e.code).toBe("TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("limite de memória da worker: estourar ⇒ RESOURCE_LIMIT (processo principal intacto)", async () => {
    const e = await fails(run(".docx", makeDocx(), "mem.docx", { workerMaxOldGenMb: 4 }));
    expect(e.code).toBe("RESOURCE_LIMIT");
    // o processo continua de pé e converte normalmente em seguida
    expect((await run(".docx", makeDocx())).markdown).toContain("Convertido automaticamente");
  });
  it("não bloqueia o event loop principal durante a conversão", async () => {
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 5);
    await run(".pdf", makePdf(Array.from({ length: 30 }, (_, i) => [`linha ${i}`])));
    clearInterval(iv);
    expect(ticks).toBeGreaterThan(3);
  });
  it("conversão direta (sem worker) tem o mesmo resultado — a worker só isola", async () => {
    const b = makeDocx();
    const direct = await convertBuffer(".docx", b, meta("a.docx", b));
    const isolated = await run(".docx", b, "a.docx");
    expect(isolated.markdown).toBe(direct.markdown);
  });
  it("limites por ambiente: ATTACHMENT_CONVERSION_* sobrepõe o padrão; valores inválidos são ignorados", () => {
    const l = conversionLimitsFromEnv({ ATTACHMENT_CONVERSION_MAX_PAGES: "7", ATTACHMENT_CONVERSION_TIMEOUT_MS: "abc", ATTACHMENT_CONVERSION_MAX_ZIP_RATIO: "-3" } as NodeJS.ProcessEnv);
    expect(l.maxPages).toBe(7);
    expect(l.timeoutMs).toBe(CONVERSION_LIMIT_DEFAULTS.timeoutMs);
    expect(l.maxZipRatio).toBe(CONVERSION_LIMIT_DEFAULTS.maxZipRatio);
  });
});
