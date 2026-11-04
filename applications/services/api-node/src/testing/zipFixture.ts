/**
 * zipFixture.ts — monta um zip MÍNIMO e válido (cabeçalhos locais + diretório central + EOCD) para testes de anexos
 * (.docx real, .docm renomeado). Só para testes; o CRC não é calculado (o leitor da api não o confere).
 */
import { deflateRawSync } from "zlib";

export function buildZip(entries: Array<{ name: string; content: string | Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, "utf8");
    const method = e.deflate === false ? 0 : 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, name, data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(0, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CT_PLAIN = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const CT_MACRO = CT_PLAIN.replace("document.main+xml", "document.macroEnabled.main+xml");

/** `.docx` legítimo (sem macros). */
export function cleanDocx(): Buffer {
  return buildZip([{ name: "[Content_Types].xml", content: CT_PLAIN }, { name: "word/document.xml", content: "<w:document/>" }]);
}
/** `.docm` renomeado para `.docx`: Content_Types declara macroEnabled E há `word/vbaProject.bin`. */
export function macroDocx(opts: { withBin?: boolean } = {}): Buffer {
  const entries = [{ name: "[Content_Types].xml", content: CT_MACRO }, { name: "word/document.xml", content: "<w:document/>" }];
  if (opts.withBin !== false) entries.push({ name: "word/vbaProject.bin", content: "VBA" });
  return buildZip(entries);
}
