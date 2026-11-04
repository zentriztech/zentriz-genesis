/**
 * attachmentConversionWorker.ts — ENTRADA da worker thread de conversão (ver attachmentConversionRunner.ts).
 *
 * Roda isolada do event loop principal, com `resourceLimits` de memória e sem variáveis de ambiente (o runner passa
 * `env: {}`: nenhum segredo da api é visível aqui). Sem rede: `fetch` é substituído por um erro e nenhum módulo de rede é
 * usado pelas bibliotecas na rota de texto. ISOLAMENTO DE REDE REAL é do container (sem egress) — worker thread não o dá.
 */
import { parentPort, workerData } from "worker_threads";
import { convertBuffer, ConversionError, type ConvertMeta, type ConversionLimits } from "./attachmentConverters.js";

interface Job { ext: string; bytes: ArrayBuffer; meta: Omit<ConvertMeta, "now"> & { now: string }; limits: ConversionLimits }

(globalThis as { fetch?: unknown }).fetch = () => { throw new Error("rede desabilitada na worker de conversão"); };

async function main(): Promise<void> {
  const job = workerData as Job;
  try {
    const out = await convertBuffer(job.ext, Buffer.from(job.bytes), { ...job.meta, now: new Date(job.meta.now) }, job.limits);
    parentPort?.postMessage({ ok: true, out });
  } catch (e) {
    if (e instanceof ConversionError) parentPort?.postMessage({ ok: false, code: e.code, message: e.message });
    else parentPort?.postMessage({ ok: false, code: "CONVERSION_FAILED", message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  }
}

void main();
