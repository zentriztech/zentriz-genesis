/**
 * attachmentConversionRunner.ts — executa UMA conversão num PROCESSO FILHO isolado (achado S-04 da revisão adversarial).
 *
 * Por que processo e não worker thread: `resourceLimits` de worker limita só o heap do V8; `Buffer`/`ArrayBuffer`/saída de
 * `inflateRawSync` ficam FORA dele e dividem o processo da api (medido: worker com 64 MiB de heap alocou 2 GiB de Buffer).
 * Aqui cada conversão ganha um processo próprio, e a api só espera o resultado:
 *   • limite REAL do SO: o filho é iniciado por `/bin/sh -c 'ulimit -v <KiB>; exec node …'` (RLIMIT_AS). `ulimit` é built-in do
 *     busybox/ash, ou seja, EXISTE em `node:20-alpine` (que NÃO traz `prlimit`, do util-linux). Estourar o limite ⇒ o filho
 *     aborta/falha ao alocar e a api segue viva;
 *   • monitor de RSS no pai (poll de /proc/<pid>/status, ou `ps` fora do Linux): acima do teto ⇒ SIGKILL. Cobre plataformas sem
 *     RLIMIT_AS efetivo (macOS) e complementa o ulimit (que limita endereçamento, não RSS);
 *   • `--max-old-space-size` (heap V8) e timeout DURO com SIGKILL;
 *   • saída (stdout) cortada em `maxStdoutBytes` (SIGKILL ao passar); stderr guardado só no último 1 KiB;
 *   • ambiente vazio (`env: {}`: nenhum segredo da api) e sem stdin além do arquivo; sem rede (o filho substitui `fetch`; o
 *     bloqueio de rede real é do container — sem egress);
 *   • SEMÁFORO global por instância (`maxConcurrent`, 1–4): conversões além do teto esperam na fila.
 *
 * Em produção o filho é `attachmentConversionChild.js` (dist); em teste/dev (`tsx`/vitest) é um bundle esbuild do `.ts` (JS puro).
 * Todos os limites têm padrão conservador NÃO calibrado (calibrado=falso) e override por `ATTACHMENT_CONVERSION_<CAMPO>`.
 */
import { spawn, execFileSync } from "child_process";
import { readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { ConversionError, CONVERSION_LIMIT_DEFAULTS, type ConvertMeta, type ConvertOutput, type ConversionErrorCode, type ConversionLimits } from "./attachmentConverters.js";

/** Limites efetivos: padrões + override por ambiente (`ATTACHMENT_CONVERSION_<CAMPO>`), ignorando valores inválidos. */
export function conversionLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ConversionLimits {
  const out: ConversionLimits = { ...CONVERSION_LIMIT_DEFAULTS };
  const map: Record<keyof ConversionLimits, string> = {
    maxInputBytes: "MAX_INPUT_BYTES", maxPages: "MAX_PAGES", maxOutputChars: "MAX_OUTPUT_CHARS", maxZipEntries: "MAX_ZIP_ENTRIES",
    maxZipEntryBytes: "MAX_ZIP_ENTRY_BYTES", maxZipTotalBytes: "MAX_ZIP_TOTAL_BYTES", maxZipRatio: "MAX_ZIP_RATIO",
    timeoutMs: "TIMEOUT_MS", workerMaxOldGenMb: "WORKER_MAX_OLD_GEN_MB",
    procMaxRssMb: "PROC_MAX_RSS_MB", procMaxAddressSpaceMb: "PROC_MAX_ADDRESS_SPACE_MB", maxStdoutBytes: "MAX_STDOUT_BYTES",
    maxConcurrent: "MAX_CONCURRENT",
  };
  for (const k of Object.keys(map) as Array<keyof ConversionLimits>) {
    const n = Number(env[`ATTACHMENT_CONVERSION_${map[k]}`]);
    if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  out.maxConcurrent = Math.min(Math.max(out.maxConcurrent, 1), 4);
  // `0` desliga o ulimit (único limite que aceita zero); número inválido mantém o padrão
  if (env.ATTACHMENT_CONVERSION_PROC_MAX_ADDRESS_SPACE_MB !== undefined && Number(env.ATTACHMENT_CONVERSION_PROC_MAX_ADDRESS_SPACE_MB) === 0) out.procMaxAddressSpaceMb = 0;
  return out;
}

// ── semáforo global (por instância da api) ─────────────────────────────────────────────────────────
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(max: number): Promise<void> {
  if (active < max) { active++; return; }
  await new Promise<void>((res) => waiters.push(res));
}
function release(max: number): void {
  const next = active > max ? undefined : waiters.shift(); // se o teto caiu, não repassa a vaga
  if (next) next(); else active--;
}
/** Observabilidade/teste: conversões em andamento e na fila. */
export function conversionConcurrency(): { active: number; queued: number } { return { active, queued: waiters.length }; }

// ── entrada do filho ─────────────────────────────────────────────────────────────────────────────
let devBundle: string | null = null;
/**
 * Em dev/teste (sem `dist/`), o filho é um bundle esbuild do `.ts` — JS puro, como em produção. NÃO se usa o loader do tsx
 * no filho: ele roda threads/WebAssembly próprios e distorceria o limite de endereçamento que este módulo quer provar.
 */
function devChildBundle(dir: string): string {
  if (devBundle && existsSync(devBundle)) return devBundle;
  const req = createRequire(import.meta.url);
  const esbuild = req("esbuild") as { buildSync(o: Record<string, unknown>): unknown };
  const cacheDir = path.join(path.dirname(req.resolve("tsx/package.json")), "..", ".cache", "genesis-conversion-child");
  mkdirSync(cacheDir, { recursive: true });
  // bundle único e estável (sem resíduo por processo): constrói num nome temporário e troca por rename atômico
  const outfile = path.join(cacheDir, `child-${createHash("sha1").update(dir).digest("hex").slice(0, 10)}.mjs`); // por checkout (worktrees compartilham node_modules)
  const tmp = path.join(cacheDir, `child.${process.pid}.tmp.mjs`);
  esbuild.buildSync({
    entryPoints: [path.join(dir, "attachmentConversionChild.ts")], outfile: tmp, bundle: true, platform: "node", format: "esm",
    packages: "external", logLevel: "silent",
  });
  renameSync(tmp, outfile);
  devBundle = outfile;
  return outfile;
}

function childEntry(): { args: string[] } {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(dir, "attachmentConversionChild.js");
  return { args: [existsSync(js) ? js : devChildBundle(dir)] };
}

function rssMb(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      return m ? Number(m[1]) / 1024 : null;
    }
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", env: {} }).trim()) / 1024;
  } catch { return null; }
}
const RSS_POLL_MS = 50;
const SHELL_WRAP = 'if [ "$1" != 0 ]; then ulimit -v "$1" 2>/dev/null; fi; shift; exec "$@"';

type Reply = { ok: true; out: ConvertOutput } | { ok: false; code: ConversionErrorCode; message: string };

/**
 * Executa `node <nodeArgs>` como processo filho LIMITADO (ulimit -v + monitor de RSS + timeout SIGKILL + teto de stdout +
 * ambiente vazio), escreve `stdin` e devolve o stdout. Rejeita com `ConversionError` (TIMEOUT / RESOURCE_LIMIT /
 * CONVERSION_FAILED). Sem semáforo (ver `runConversionIsolated`). Exportado para o teste de isolamento.
 */
export function runLimitedNode(nodeArgs: string[], stdin: Buffer, limits: ConversionLimits): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const asKb = limits.procMaxAddressSpaceMb > 0 ? String(limits.procMaxAddressSpaceMb * 1024) : "0";
    // WebAssembly reserva ~10 GiB de ENDEREÇOS (guard regions) e quebra sob RLIMIT_AS; sem o trap handler a reserva some
    const wasmFlag = process.allowedNodeEnvironmentFlags.has("--disable-wasm-trap-handler") ? ["--disable-wasm-trap-handler"] : [];
    const child = spawn("/bin/sh", ["-c", SHELL_WRAP, "sh", asKb, process.execPath, ...wasmFlag, `--max-old-space-size=${limits.workerMaxOldGenMb}`, ...nodeArgs], {
      env: {}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let settled = false;
    let killedBy: ConversionError | null = null;
    const out: Buffer[] = []; let outBytes = 0; let errTail = "";
    const kill = (e: ConversionError) => { if (!killedBy) killedBy = e; try { child.kill("SIGKILL"); } catch { /* já morto */ } };
    const timer = setTimeout(() => kill(new ConversionError("TIMEOUT", `conversão excedeu ${limits.timeoutMs} ms`)), limits.timeoutMs);
    const monitor = setInterval(() => {
      if (!child.pid) return;
      const r = rssMb(child.pid);
      if (r !== null && r > limits.procMaxRssMb) kill(new ConversionError("RESOURCE_LIMIT", `memória do processo de conversão excedeu ${limits.procMaxRssMb} MiB (RSS)`));
    }, RSS_POLL_MS);
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(monitor); try { child.kill("SIGKILL"); } catch { /* ok */ } fn(); };

    child.stdout.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > limits.maxStdoutBytes) { kill(new ConversionError("RESOURCE_LIMIT", `saída da conversão excedeu ${limits.maxStdoutBytes} bytes`)); return; }
      out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => { errTail = (errTail + c.toString("utf8")).slice(-1024); });
    child.stdin.on("error", () => { /* filho morreu antes de ler tudo: o 'close' decide o erro */ });
    child.on("error", (err) => done(() => reject(new ConversionError("CONVERSION_FAILED", `falha ao iniciar o processo de conversão: ${err.message}`.slice(0, 300)))));
    child.on("close", (code, signal) => done(() => {
      if (killedBy) return reject(killedBy);
      if (code === 0) return resolve(Buffer.concat(out));
      const oom = /heap out of memory|allocation failed|out of memory|cannot allocate|invalid (typed )?array length/i.test(errTail) || signal === "SIGABRT" || signal === "SIGSEGV" || signal === "SIGBUS" || signal === "SIGTRAP" || code === 134 || code === 139;
      if (oom) return reject(new ConversionError("RESOURCE_LIMIT", `processo de conversão abortou por limite de memória (heap ${limits.workerMaxOldGenMb} MiB, endereçamento ${limits.procMaxAddressSpaceMb} MiB)`));
      reject(new ConversionError("CONVERSION_FAILED", `processo de conversão encerrou sem resultado (código ${code}, sinal ${signal})`));
    }));
    child.stdin.end(stdin);
  });
}

async function runChild(ext: string, buffer: Buffer, meta: ConvertMeta, limits: ConversionLimits): Promise<ConvertOutput> {
  const header = Buffer.from(JSON.stringify({ ext, meta: { ...meta, now: meta.now.toISOString() }, limits }), "utf8");
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(header.length, 0);
  const raw = await runLimitedNode(childEntry().args, Buffer.concat([lenBuf, header, buffer]), limits);
  let m: Reply;
  try { m = JSON.parse(raw.toString("utf8")) as Reply; }
  catch { throw new ConversionError("CONVERSION_FAILED", "saída do processo de conversão ilegível"); }
  if (m.ok) return m.out;
  throw new ConversionError(m.code, m.message);
}

/** Roda a conversão isolada. Resolve com o resultado ou rejeita com `ConversionError` (TIMEOUT, RESOURCE_LIMIT, CORRUPT…). */
export async function runConversionIsolated(
  ext: string, buffer: Buffer, meta: ConvertMeta, limits: ConversionLimits = conversionLimitsFromEnv(),
): Promise<ConvertOutput> {
  await acquire(limits.maxConcurrent);
  try { return await runChild(ext, buffer, meta, limits); }
  finally { release(limits.maxConcurrent); }
}
