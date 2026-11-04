/**
 * evolutionScope.ts — escopo do RFC (`files_allowed`) e lockfiles estranhos, lado api-node (AU / N-3 / N-6).
 *
 * O gate de escopo do runner (`runner.py::_evolution_scope_check`) só vê o que o Dev grava; efeitos colaterais
 * de build (ex.: `pnpm install` num projeto npm criando `pnpm-lock.yaml`, +5.486 linhas no PR #5 da execução 4.5b)
 * escapam dele. Este módulo dá à API duas ferramentas independentes do runner:
 *   1. comparar o diff REAL do `apps/` com o escopo do RFC (mesma semântica de glob do runner);
 *   2. identificar lockfiles de OUTRO gerenciador de pacotes que não pertencem ao produto, para não publicá-los.
 */
import path from "node:path";

/** Sempre permitidos, espelho de `_EVO_ALWAYS_ALLOWED` (runner.py). */
export const EVO_ALWAYS_ALLOWED = ["tests/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "docs/**", "CHANGELOG.md"];

/** Diretórios que nunca são publicados (espelho de SKIP_DIRS de `pushProjectFiles`). */
export const NEVER_PUBLISHED_DIRS = new Set(["node_modules", ".next", "dist", ".git", "coverage", ".nyc_output", ".venv-genesis"]);

/**
 * AV/M-3: diretórios e arquivos que são ARTEFATO GERADO e nunca devem ir ao PR de uma evolução se o clone da linhagem não os rastreia
 * (o que o produto já versiona continua valendo). Mais largo que `NEVER_PUBLISHED_DIRS` (que vale sempre): inclui `build`, `out`, `target`,
 * ambientes virtuais e caches, que o `walk` do publicador não conhecia.
 */
export const GENERATED_DIRS = new Set([
  ...NEVER_PUBLISHED_DIRS, "build", "out", "target", "venv", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".turbo", ".cache", ".gradle", ".parcel-cache",
]);
/** `.env`, `.env.local`, `.env.production`… (segredo local); `.env.example|sample|template` são documentação e passam. */
const ENV_SECRET_RE = /^\.env(?:\..+)?$/;
const ENV_DOC_RE = /^\.env\.(?:example|sample|template|dist)$/;
/** Puro: o caminho (relativo a `apps/`) é artefato gerado/segredo local? */
export function isGeneratedArtifact(rel: string): boolean {
  const parts = normalize(rel).split("/");
  const base = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((seg) => GENERATED_DIRS.has(seg))) return true;
  if (ENV_SECRET_RE.test(base) && !ENV_DOC_RE.test(base)) return true;
  return base === ".DS_Store" || base.endsWith(".pyc");
}

function normalize(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/** Glob → regex (mesma semântica do runner): `**\/` = zero+ diretórios, `*` = segmento, glob de diretório casa a árvore. */
export function globToRegex(pattern: string): RegExp {
  let p = normalize(pattern);
  const trailing = p.endsWith("/");
  p = p.replace(/\/+$/, "");
  const last = p.split("/").pop() ?? "";
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (p && (trailing || (!/[*?]/.test(p) && !last.includes(".")))) return new RegExp(`^${[...p].map(esc).join("")}(?:/.*)?$`);
  let out = "";
  for (let i = 0; i < p.length;) {
    if (p.startsWith("**/", i)) { out += "(?:.*/)?"; i += 3; continue; }
    if (p.startsWith("**", i)) { out += ".*"; i += 2; continue; }
    const c = p[i];
    out += c === "*" ? "[^/]*" : c === "?" ? "[^/]" : esc(c);
    i++;
  }
  return new RegExp(`^${out}$`);
}

/** `rel` é relativo a `apps/`; os globs do RFC podem vir com ou sem o prefixo `apps/`. */
export function isPathInScope(rel: string, scope: string[]): boolean {
  const r = normalize(rel);
  const candidates = [r, `apps/${r}`];
  return [...scope, ...EVO_ALWAYS_ALLOWED].some((pat) => {
    const rx = globToRegex(pat);
    return candidates.some((c) => rx.test(c));
  });
}

export function pathsOutsideScope(files: string[], scope: string[]): string[] {
  return files.filter((f) => !isPathInScope(f, scope));
}

// ── Lockfiles de gerenciadores de pacote (JS) ────────────────────────────────

export const JS_LOCKFILES: Record<string, "npm" | "yarn" | "pnpm" | "bun"> = {
  "package-lock.json": "npm", "npm-shrinkwrap.json": "npm", "yarn.lock": "yarn", "pnpm-lock.yaml": "pnpm", "bun.lockb": "bun", "bun.lock": "bun",
};
const PM_PRIORITY: Array<"npm" | "yarn" | "pnpm" | "bun"> = ["npm", "yarn", "pnpm", "bun"];

/**
 * Lockfiles ESTRANHOS: numa pasta com lockfiles de mais de um gerenciador, ficam os do gerenciador do produto e os demais saem.
 * Quem é "do produto", em ordem: (1) lockfiles já RASTREADOS no clone (`tracked`, o que o repo da linhagem tinha);
 * (2) `packageManager` do `package.json` da pasta; (3) prioridade npm > yarn > pnpm > bun. Pasta com um único gerenciador: nada sai
 * (sem segundo gerenciador não há como provar que é estranho). Puro e testável.
 */
export function foreignLockfiles(relPaths: string[], ctx: { tracked?: Set<string> | null; packageManagerOf?: (dir: string) => string | null } = {}): string[] {
  const byDir = new Map<string, Array<{ rel: string; pm: "npm" | "yarn" | "pnpm" | "bun" }>>();
  for (const rel of relPaths) {
    const base = path.posix.basename(rel);
    const pm = JS_LOCKFILES[base];
    if (!pm) continue;
    const dir = path.posix.dirname(rel);
    byDir.set(dir, [...(byDir.get(dir) ?? []), { rel, pm }]);
  }
  const out: string[] = [];
  for (const [dir, locks] of byDir) {
    if (new Set(locks.map((l) => l.pm)).size < 2) continue;
    const trackedPms = new Set(locks.filter((l) => ctx.tracked?.has(l.rel)).map((l) => l.pm));
    let keep: Set<string>;
    if (trackedPms.size > 0) keep = trackedPms;
    else {
      const declared = (ctx.packageManagerOf?.(dir) ?? "").split("@")[0].trim();
      const declaredPm = PM_PRIORITY.find((p) => p === declared);
      keep = new Set([declaredPm && locks.some((l) => l.pm === declaredPm) ? declaredPm : PM_PRIORITY.find((p) => locks.some((l) => l.pm === p))!]);
    }
    for (const l of locks) if (!keep.has(l.pm)) out.push(l.rel);
  }
  return out.sort();
}

/** Versão com E/S: lê `git ls-files` e o `package.json` de `appsDir`. Falha de E/S ⇒ cai para a regra seguinte (nunca lança). */
export async function detectForeignLockfiles(appsDir: string, relPaths: string[]): Promise<string[]> {
  if (!relPaths.some((r) => JS_LOCKFILES[path.posix.basename(r)])) return [];
  const { readFileSync } = await import("node:fs");
  let tracked: Set<string> | null = null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("git", ["-C", appsDir, "ls-files", "-z"], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
    tracked = new Set(stdout.split("\0").map((s) => s.trim()).filter(Boolean));
  } catch { tracked = null; }
  const packageManagerOf = (dir: string): string | null => {
    try {
      const pj = JSON.parse(readFileSync(path.join(appsDir, dir, "package.json"), "utf-8")) as { packageManager?: unknown };
      return typeof pj.packageManager === "string" ? pj.packageManager : null;
    } catch { return null; }
  };
  return foreignLockfiles(relPaths, { tracked, packageManagerOf });
}

/**
 * Arquivos alterados/novos em `apps/` em relação ao clone da linhagem (`git status`), sem os diretórios nunca publicados.
 * `null` quando `apps/` não é um clone git ou o git falha — o chamador decide (não é "nenhuma alteração").
 */
export async function listChangedFiles(appsDir: string): Promise<string[] | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("git", ["-C", appsDir, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 });
    const parts = stdout.split("\0");
    const files: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      const code = e.slice(0, 2);
      // AV/M-3: artefato gerado NÃO rastreado (`??`) não é diff do produto — o publicador também não o envia.
      if (!(code === "??" && isGeneratedArtifact(e.slice(3)))) files.push(e.slice(3));
      if (code[0] === "R" || code[0] === "C") i++; // o par "origem" do renomeado vem como entrada seguinte
    }
    return files.filter((f) => !f.split("/").some((seg) => NEVER_PUBLISHED_DIRS.has(seg))).sort();
  } catch { return null; }
}

/**
 * AV/M-3: separa o que PODE ir ao PR do que é artefato gerado ou ignorado. Regras, nesta ordem:
 *  1. rastreado no clone da linhagem (`git ls-files`) ⇒ é do produto, SEMPRE publicável;
 *  2. não rastreado e `isGeneratedArtifact` (build/, dist/, venv/, .env…) ⇒ excluído;
 *  3. não rastreado e IGNORADO pelo `.gitignore` do clone (`git check-ignore`) ⇒ excluído.
 * Sem git (apps/ não é clone) só vale a regra 2. Nunca lança; falha do git cai para a regra 2.
 */
export async function filterPublishable(appsDir: string, relPaths: string[]): Promise<{ kept: string[]; excluded: string[] }> {
  const { execFile, spawn } = await import("node:child_process");
  const { promisify } = await import("node:util");
  let tracked: Set<string> | null = null;
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", appsDir, "ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
    tracked = new Set(stdout.split("\0").map((x) => x.trim()).filter(Boolean));
  } catch { tracked = null; }
  const isTracked = (r: string) => tracked?.has(r) === true;
  const excluded = new Set<string>();
  const candidates: string[] = [];
  for (const r of relPaths) {
    if (isTracked(r)) continue;
    if (isGeneratedArtifact(r)) { excluded.add(r); continue; }
    candidates.push(r);
  }
  if (tracked && candidates.length) {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const ch = spawn("git", ["-C", appsDir, "check-ignore", "-z", "--stdin"], { stdio: ["pipe", "pipe", "ignore"] });
        let buf = "";
        const t = setTimeout(() => { ch.kill(); reject(new Error("timeout")); }, 30_000);
        ch.stdout.on("data", (d) => { buf += String(d); });
        ch.on("error", (e) => { clearTimeout(t); reject(e); });
        // exit 0 = algum ignorado, 1 = nenhum, 128 = erro
        ch.on("close", (code) => { clearTimeout(t); code === 0 || code === 1 ? resolve(buf) : reject(new Error(`git check-ignore ${code}`)); });
        ch.stdin.end(candidates.join("\0") + "\0");
      });
      for (const x of out.split("\0")) if (x) excluded.add(x);
    } catch { /* sem .gitignore verificável: vale só a regra 2 */ }
  }
  return { kept: relPaths.filter((r) => !excluded.has(r)), excluded: relPaths.filter((r) => excluded.has(r)).sort() };
}

/**
 * AV/M-4: o gate de escopo FALHOU (arquivo fora do `files_allowed` do RFC no diff real) num filho de CARD? Lê o veredito gravado no aceite
 * (`extra.evolution_scope_gate`). Sem veredito ou `not_run` ⇒ `null` (não há prova de violação; o texto do PR declara o que não rodou).
 */
export function scopeGateFailure(extra: Record<string, unknown> | null | undefined): string | null {
  if (!extra || extra.evolution_origin !== "card") return null;
  const g = extra.evolution_scope_gate as { status?: unknown; detail?: unknown } | undefined;
  return g && g.status === "failed" ? String(g.detail ?? "escopo do RFC violado") : null;
}
