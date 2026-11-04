/**
 * attachmentConversionChild.ts — ENTRADA do PROCESSO FILHO de conversão (ver attachmentConversionRunner.ts, achado S-04).
 *
 * Roda num processo próprio, lançado pelo runner com ambiente VAZIO (nenhum segredo da api é visível), limite de
 * espaço de endereçamento do SO (`ulimit -v`), `--max-old-space-size` e monitor de RSS do lado do pai. Protocolo:
 *   stdin  = [4 bytes BE: tamanho do cabeçalho][cabeçalho JSON {ext, meta, limits}][bytes do arquivo]
 *   stdout = UMA linha JSON {ok:true,out} | {ok:false,code,message}   (o pai corta a leitura no teto de bytes)
 * Sem rede: `fetch` é substituído por um erro e as bibliotecas da rota de texto não abrem sockets. ISOLAMENTO DE REDE REAL
 * é do container (sem egress) — nem processo filho nem Node 20 o garantem.
 */
import Module from "module";
import { convertBuffer, ConversionError, type ConvertMeta, type ConversionLimits } from "./attachmentConverters.js";

interface Header { ext: string; meta: Omit<ConvertMeta, "now"> & { now: string }; limits: ConversionLimits }

/**
 * S-15: a extração de TEXTO do pdf.js não precisa do binário nativo `@napi-rs/canvas` (só usado para polyfill de
 * DOMMatrix/ImageData/Path2D e para renderizar). Aqui ele NÃO é carregado (menos código nativo no processo que lê PDF
 * hostil, e o carregamento reserva muito espaço de endereçamento sob `ulimit -v`); os três globais viram stubs inertes.
 */
const g = globalThis as Record<string, unknown>;
for (const n of ["DOMMatrix", "ImageData", "Path2D"]) if (!g[n]) g[n] = class {};
const mod = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveOrig = mod._resolveFilename;
mod._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
  if (request.startsWith("@napi-rs/canvas")) throw new Error("módulo nativo de canvas desabilitado na conversão de texto");
  return resolveOrig.call(this, request, ...rest);
};

(globalThis as { fetch?: unknown }).fetch = () => { throw new Error("rede desabilitada no processo de conversão"); };

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const OOM_RE = /allocation failed|invalid (typed )?array length|invalid array buffer length|out of memory|cannot allocate/i;

async function main(): Promise<void> {
  let reply: Record<string, unknown>;
  try {
    const raw = await readStdin();
    const hl = raw.readUInt32BE(0);
    const header = JSON.parse(raw.subarray(4, 4 + hl).toString("utf8")) as Header;
    const body = raw.subarray(4 + hl);
    const out = await convertBuffer(header.ext, body, { ...header.meta, now: new Date(header.meta.now) }, header.limits);
    reply = { ok: true, out };
  } catch (e) {
    if (e instanceof ConversionError) reply = { ok: false, code: e.code, message: e.message };
    else {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      reply = { ok: false, code: OOM_RE.test(msg) ? "RESOURCE_LIMIT" : "CONVERSION_FAILED", message: msg };
    }
  }
  process.stdout.write(JSON.stringify(reply) + "\n", () => process.exit(0));
}

void main();
