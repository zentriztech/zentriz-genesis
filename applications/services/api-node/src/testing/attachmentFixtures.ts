/**
 * attachmentFixtures.ts — geradores de arquivos REAIS e pequenos para os testes da conversão de anexos (Tarefa Q).
 * NÃO é código de produto: só é importado por `*.test.ts`. Nada é lido do disco; tudo é gerado em memória.
 */
import AdmZip from "adm-zip";
import { deflateRawSync } from "zlib";

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export interface DocxOpts { paragraphs?: string[]; headingFirst?: boolean; macro?: boolean; extraEntries?: Array<{ name: string; data: Buffer }> }

/** .docx mínimo válido (zip com [Content_Types].xml, _rels, word/document.xml e styles com Heading1). */
export function makeDocx(opts: DocxOpts = {}): Buffer {
  const paras = opts.paragraphs ?? ["Título do contrato", "Primeiro parágrafo com acentuação: ação, coração.", "Segundo parágrafo."];
  const body = paras.map((p, i) => {
    const style = i === 0 && opts.headingFirst !== false ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : "";
    return `<w:p>${style}<w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`;
  }).join("");
  const z = new AdmZip();
  z.addFile("[Content_Types].xml", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document${opts.macro ? ".macroEnabled" : ""}.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`));
  z.addFile("_rels/.rels", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`));
  z.addFile("word/_rels/document.xml.rels", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`));
  z.addFile("word/styles.xml", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`));
  z.addFile("word/document.xml", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`));
  if (opts.macro) z.addFile("word/vbaProject.bin", Buffer.from("VBA-FAKE"));
  for (const e of opts.extraEntries ?? []) z.addFile(e.name, e.data);
  return z.toBuffer();
}

/** docx cuja entrada `word/bomb.xml` descomprime para `bytes` (zeros) — razão altíssima, zip bomb sintético. */
export function makeDocxBomb(bytes: number): Buffer {
  return makeDocx({ extraEntries: [{ name: "word/bomb.xml", data: Buffer.alloc(bytes) }] });
}

/** docx com MUITAS entradas pequenas. */
export function makeDocxManyEntries(n: number): Buffer {
  return makeDocx({ extraEntries: Array.from({ length: n }, (_, i) => ({ name: `word/x/${i}.xml`, data: Buffer.from("<a/>") })) });
}

/**
 * docx cujo diretório central MENTE sobre o tamanho (declara 10 bytes, o conteúdo real descomprime para `realBytes`).
 * Troca o campo `uncompressed size` do diretório central da entrada `word/liar.xml`.
 */
export function makeDocxLyingSize(realBytes: number): Buffer {
  const buf = makeDocx({ extraEntries: [{ name: "word/liar.xml", data: Buffer.alloc(realBytes) }] });
  const name = Buffer.from("word/liar.xml");
  for (let i = 0; i < buf.length - 46; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50 && buf.subarray(i + 46, i + 46 + name.length).equals(name)) { buf.writeUInt32LE(10, i + 24); return buf; }
  }
  throw new Error("fixture: entrada não encontrada");
}

/** PDF mínimo com camada de texto (Helvetica, uma página por item de `pages`, cada item = linhas). */
export function makePdf(pages: string[][] = [["Relatório de requisitos", "Linha dois do documento."]]): Buffer {
  const objs: string[] = [];
  const kids: number[] = [];
  const first = 3; // 1 catalog, 2 pages, 3 font
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  let n = 4;
  for (const lines of pages) {
    const pageId = n++; const contentId = n++;
    const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l.replace(/[\\()]/g, "\\$&")}) Tj T*`).join(" ")} ET`;
    objs[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${first} 0 R >> >> >>`;
    kids.push(pageId);
  }
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  return assemblePdf(objs);
}

/** PDF "escaneado": página só com um desenho (sem operadores de texto). */
export function makePdfNoText(): Buffer {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>";
  const stream = "0 0 0 rg 100 100 200 200 re f";
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  return assemblePdf(objs);
}

/** PDF com ação /JavaScript no catálogo (conteúdo ativo; recusado já no upload e na conversão). */
export function makePdfWithJs(): Buffer {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>";
  objs[5] = "<< /S /JavaScript /JS (app.alert\\(1\\)) >>";
  return assemblePdf(objs);
}

function assemblePdf(objs: string[]): Buffer {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  const max = objs.length - 1;
  for (let i = 1; i <= max; i++) {
    if (objs[i] === undefined) continue;
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++) out += offsets[i] === undefined ? "0000000000 65535 f \n" : `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * .doc legado (OLE2/CFB + FIB do Word 97) mínimo: texto 8-bit numa única peça. Streams de 4096 B (setores regulares,
 * sem mini-stream). `withVba` acrescenta um nome de entrada `_VBA_PROJECT` (macro) no diretório.
 */
export function makeDoc(text = "Documento legado\rSegundo parágrafo do doc.\r", opts: { withVba?: boolean } = {}): Buffer {
  const SEC = 512;
  const ENDOFCHAIN = -2, FREESECT = -1, FATSECT = -3;
  const textBytes = Buffer.from(text, "latin1");
  const word = Buffer.alloc(4096);
  word.writeUInt16LE(0xa5ec, 0);
  word.writeUInt16LE(0x00c1, 2); // nFib
  word.writeUInt16LE(0, 0xa); // flags: 0Table
  const fcMin = 0x800;
  word.writeUInt32LE(fcMin, 0x18);
  word.writeUInt32LE(fcMin + textBytes.length, 0x1c);
  word.writeUInt32LE(textBytes.length, 0x4c); // ccpText
  word.writeUInt32LE(0, 0x1a2); // fcClx = 0
  word.writeUInt32LE(0, 0x1a6);
  textBytes.copy(word, fcMin);
  const table = Buffer.alloc(4096);
  // CLX: Pcdt (0x02), lcb, PlcPcd = CPs (n+1) + PCDs (n*8)
  const pieceFc = ((fcMin * 2) | 0x40000000) >>> 0; // 8-bit: fc*2 com bit 30
  table.writeUInt8(2, 0);
  table.writeUInt32LE(4 * 2 + 8, 1); // lcb = (n+1)*4 + n*8 com n=1 => 8+8 = 16... (pieceTableSize-4)/12 = n
  table.writeUInt32LE(0, 5);
  table.writeUInt32LE(textBytes.length, 9);
  table.writeUInt16LE(0, 13);
  table.writeUInt32LE(pieceFc, 15);
  table.writeUInt16LE(0, 19);
  // pieceTableSize = 16 => (16-4)/12 = 1 peça
  table.writeUInt32LE(16, 1);

  const dir = Buffer.alloc(SEC);
  const putEntry = (idx: number, name: string, type: number, left: number, right: number, child: number, start: number, size: number) => {
    const o = idx * 128;
    Buffer.from(name, "utf16le").copy(dir, o);
    dir.writeInt16LE((name.length + 1) * 2, o + 64);
    dir.writeInt8(type, o + 66);
    dir.writeInt8(1, o + 67);
    dir.writeInt32LE(left, o + 68); dir.writeInt32LE(right, o + 72); dir.writeInt32LE(child, o + 76);
    dir.writeInt32LE(start, o + 116); dir.writeInt32LE(size, o + 120);
  };
  putEntry(0, "Root Entry", 5, -1, -1, 1, ENDOFCHAIN, 0);
  putEntry(1, "WordDocument", 2, -1, 2, -1, 2, 4096);
  putEntry(2, "0Table", 2, -1, opts.withVba ? 3 : -1, -1, 10, 4096);
  if (opts.withVba) putEntry(3, "_VBA_PROJECT", 2, -1, -1, -1, ENDOFCHAIN, 0);

  const fat = Buffer.alloc(SEC, 0xff);
  const setFat = (i: number, v: number) => fat.writeInt32LE(v, i * 4);
  setFat(0, FATSECT); setFat(1, ENDOFCHAIN);
  for (let i = 2; i < 9; i++) setFat(i, i + 1);
  setFat(9, ENDOFCHAIN);
  for (let i = 10; i < 17; i++) setFat(i, i + 1);
  setFat(17, ENDOFCHAIN);

  const header = Buffer.alloc(SEC, 0);
  Buffer.from("D0CF11E0A1B11AE1", "hex").copy(header, 0);
  header.writeUInt16LE(0x3e, 24); header.writeUInt16LE(3, 26); header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30); header.writeUInt16LE(6, 32);
  header.writeInt32LE(1, 44); // SATSize
  header.writeInt32LE(1, 48); // dirSecId
  header.writeInt32LE(4096, 56);
  header.writeInt32LE(ENDOFCHAIN, 60); header.writeInt32LE(0, 64);
  header.writeInt32LE(ENDOFCHAIN, 68); header.writeInt32LE(0, 72);
  for (let i = 0; i < 109; i++) header.writeInt32LE(i === 0 ? 0 : FREESECT, 76 + i * 4);
  return Buffer.concat([header, fat, dir, word, table]);
}

/** Raw deflate helper exposto para testes que montam entradas à mão. */
export const rawDeflate = (b: Buffer) => deflateRawSync(b);
