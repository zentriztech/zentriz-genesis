/**
 * attachmentConversionRunner.ts — executa UMA conversão numa worker thread isolada (fora do event loop principal).
 *
 *   • limite de memória (`resourceLimits`), timeout rígido (`terminate()`), `env: {}` (sem segredos), sem stdin/stdout;
 *   • a worker é descartada ao fim de cada conversão (nada de estado compartilhado entre anexos);
 *   • em produção a worker é `attachmentConversionWorker.js` (dist); em teste/dev (`tsx`/vitest) cai no `.ts` registrando o loader do tsx dentro da worker.
 */
import { Worker } from "worker_threads";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { ConversionError, CONVERSION_LIMIT_DEFAULTS, type ConvertMeta, type ConvertOutput, type ConversionErrorCode, type ConversionLimits } from "./attachmentConverters.js";

/** Limites efetivos: padrões + override por ambiente (`ATTACHMENT_CONVERSION_<CAMPO>`), ignorando valores inválidos. */
export function conversionLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ConversionLimits {
  const out: ConversionLimits = { ...CONVERSION_LIMIT_DEFAULTS };
  const map: Record<keyof ConversionLimits, string> = {
    maxInputBytes: "MAX_INPUT_BYTES", maxPages: "MAX_PAGES", maxOutputChars: "MAX_OUTPUT_CHARS", maxZipEntries: "MAX_ZIP_ENTRIES",
    maxZipEntryBytes: "MAX_ZIP_ENTRY_BYTES", maxZipTotalBytes: "MAX_ZIP_TOTAL_BYTES", maxZipRatio: "MAX_ZIP_RATIO",
    timeoutMs: "TIMEOUT_MS", workerMaxOldGenMb: "WORKER_MAX_OLD_GEN_MB",
  };
  for (const k of Object.keys(map) as Array<keyof ConversionLimits>) {
    const n = Number(env[`ATTACHMENT_CONVERSION_${map[k]}`]);
    if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  return out;
}

function workerEntry(): { file: string; evalCode?: boolean } {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(dir, "attachmentConversionWorker.js");
  if (existsSync(js)) return { file: js };
  // dev/teste (tsx/vitest): `--import tsx` não vale em worker; registra o loader do tsx dentro da própria worker.
  const ts = pathToFileURL(path.join(dir, "attachmentConversionWorker.ts")).href;
  return { file: `import("tsx/esm/api").then((m) => { m.register(); return import(${JSON.stringify(ts)}); }).catch((e) => { console.error(e); process.exit(3); });`, evalCode: true };
}

/** Roda a conversão isolada. Resolve com o resultado ou rejeita com `ConversionError` (TIMEOUT, RESOURCE_LIMIT, CORRUPT…). */
export function runConversionIsolated(
  ext: string, buffer: Buffer, meta: ConvertMeta, limits: ConversionLimits = conversionLimitsFromEnv(),
): Promise<ConvertOutput> {
  return new Promise<ConvertOutput>((resolve, reject) => {
    const { file, evalCode } = workerEntry();
    // cópia exclusiva dos bytes (transferida para a worker): o buffer do chamador continua utilizável
    const bytes = new Uint8Array(buffer).buffer;
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); fn(); };
    const worker = new Worker(file, {
      workerData: { ext, bytes, meta: { ...meta, now: meta.now.toISOString() }, limits },
      transferList: [bytes],
      env: {},
      eval: evalCode === true,
      stdin: false, stdout: true, stderr: true, // descartados (não herdam o console da api)
      resourceLimits: { maxOldGenerationSizeMb: limits.workerMaxOldGenMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    const timer = setTimeout(() => done(() => reject(new ConversionError("TIMEOUT", `conversão excedeu ${limits.timeoutMs} ms`))), limits.timeoutMs);
    worker.on("message", (m: { ok: true; out: ConvertOutput } | { ok: false; code: ConversionErrorCode; message: string }) => {
      done(() => (m.ok ? resolve(m.out) : reject(new ConversionError(m.code, m.message))));
    });
    worker.on("error", (err: Error & { code?: string }) => {
      done(() => reject(err.code === "ERR_WORKER_OUT_OF_MEMORY"
        ? new ConversionError("RESOURCE_LIMIT", `memória da conversão excedeu ${limits.workerMaxOldGenMb} MiB`)
        : new ConversionError("CONVERSION_FAILED", `falha na worker: ${err.message}`.slice(0, 300))));
    });
    worker.on("exit", (code) => {
      done(() => reject(new ConversionError("CONVERSION_FAILED", `worker encerrou sem resultado (código ${code})`)));
    });
  });
}
