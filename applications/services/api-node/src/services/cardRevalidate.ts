/**
 * cardRevalidate.ts — Fase 3 (3.5): conferência do card contra o HEAD novo (`POST /api/cards/:id/revalidate`).
 *
 * Até a Fase 2 revalidar só rebaseava o ponteiro de base. Aqui o resultado é EXPLÍCITO e com motivos:
 *   • `ok`       — a base registrada É o HEAD corrente e nada nele contradiz o card;
 *   • `stale`    — o HEAD andou (ou a spec do HEAD mudou) mas o RFC do card segue compatível: o card é REBASEADO e a validação
 *                  precisa ser refeita (volta a `refining`);
 *   • `conflict` — o RFC aponta para algo que a base nova não tem mais (glob de `files_allowed` que casava na base anterior e hoje não
 *                  casa com nada; arquivo de spec REMOVIDO que o card cita): o ponteiro NÃO é rebaseado e o card volta a `refining` para
 *                  o humano ajustar o RFC.
 *
 * O que é verificado, e o que NÃO é (declarado, sem fingir):
 *   • globs de `files_allowed` × árvore `apps/` do repositório/clone do HEAD novo (e do anterior, para saber se "casava antes").
 *     Só quando há clone em disco (`PROJECT_FILES_ROOT`); sem ele o motivo `REPO_UNAVAILABLE` (info) diz que a conferência não rodou.
 *     Glob que nunca casou (nova pasta de um recurso novo) é só aviso — não é conflito.
 *   • arquivos da spec-base REMOVIDOS/ALTERADOS entre a base anterior e o HEAD que o RFC ou o pedido do card citam por caminho.
 *   • NÃO verifica contradição SEMÂNTICA entre o texto do RFC e a spec nova (exigiria LLM; Lei "Genesis é 100% LLM"): quando a spec-base
 *     mudou, o motivo `NEEDS_HUMAN_REVIEW` pede a revisão. Zero LLM, zero escrita aqui — quem grava é `revalidateCard`.
 */
import fsp from "fs/promises";
import path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectRootCandidates } from "./connectManifestsDisk.js";

const execFileAsync = promisify(execFile);

type Row = Record<string, unknown>;
export type CheckDb = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> };

export type RevalidateVerdict = "ok" | "stale" | "conflict";
export interface RevalidateReason {
  code:
    | "BASE_MOVED" | "BASE_SPEC_CHANGED" | "GLOB_NO_LONGER_MATCHES" | "GLOB_UNMATCHED" | "RFC_REFERENCES_REMOVED_SPEC"
    | "RFC_REFERENCES_CHANGED_SPEC" | "NEEDS_HUMAN_REVIEW" | "REPO_UNAVAILABLE" | "NO_RFC";
  severity: "conflict" | "warning" | "info";
  message: string;
  details?: Record<string, unknown>;
}
export interface GlobCheck { rfc: string; glob: string; matchedNow: boolean | null; matchedBefore: boolean | null }

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", "coverage", ".turbo"]);
/** Teto de arquivos listados por árvore (anti-abuso; `capped` vira motivo informativo). */
export const REPO_TREE_MAX_FILES = 50_000;

/** Port do `_glob_to_regex` do runner (gate de escopo do E4): `**​/` = zero+ diretórios, `**` = tudo, `*` = segmento, `?` = 1 char; glob de diretório casa a árvore. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  const hadTrailingSlash = p.endsWith("/");
  p = p.replace(/\/+$/, "");
  const last = p.split("/").pop() ?? "";
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (p && (hadTrailingSlash || (!/[*?]/.test(p) && !last.includes(".")))) return new RegExp(`^${esc(p)}(?:/.*)?$`);
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

/** O glob casa o caminho (relativo a `apps/` OU com prefixo `apps/`, como o gate do runner)? */
export function globMatches(glob: string, relPath: string): boolean {
  const rel = relPath.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  const rx = globToRegExp(glob);
  return rx.test(rel) || rx.test(`apps/${rel}`);
}

/** Globs que o gate de escopo do runner SEMPRE libera (testes, docs, CHANGELOG): não são código da árvore `apps/` e não entram na conferência. */
export function isAlwaysAllowedGlob(glob: string): boolean {
  const g = glob.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  return /^(tests?|__tests__|docs)(\/|$)/i.test(g) || /^\*\*\/(tests?|__tests__)\//i.test(g) || /\.(test|spec)\.[a-z*]+$/i.test(g) || /\.md$/i.test(g);
}

export interface RepoTree {
  available: boolean; files: string[]; capped: boolean; root: string | null;
  /** `git-ls-tree` = árvore do COMMIT aceito (Y-13); `working-tree` = cópia de trabalho do disco (pode ter alterações não aceitas). */
  source?: "git-ls-tree" | "working-tree";
}

/** Commit aceito: SHA hexadecimal curto/longo (nunca opção do git). */
const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/i;

/**
 * Arquivos de `<PROJECT_FILES_ROOT>/[produto/]<projeto>/apps` (relativos a `apps/`). Sem clone/raiz ⇒ `available:false`.
 * Y-13: com `opts.ref` (o commit aceito do HEAD, `extra.evolution_head_sha`) e um repositório git em `apps/`, a lista vem de
 * `git ls-tree -r --name-only <ref>` — a árvore do commit aceito, não a cópia de trabalho. Sem `ref`/sem `.git`/erro do git ⇒ cópia de trabalho.
 */
export async function listRepoTree(projectId: string, productId: string | null, env: NodeJS.ProcessEnv = process.env, opts: { ref?: string | null } = {}): Promise<RepoTree> {
  const root = (env.PROJECT_FILES_ROOT ?? env.HOST_PROJECT_FILES_ROOT ?? "").trim();
  if (!root) return { available: false, files: [], capped: false, root: null };
  for (const cand of projectRootCandidates(root, projectId, productId)) {
    const apps = path.join(cand, "apps");
    try { if (!(await fsp.stat(apps)).isDirectory()) continue; } catch { continue; }
    if (opts.ref && COMMIT_SHA_RE.test(opts.ref)) {
      try {
        await fsp.stat(path.join(apps, ".git"));
        const out = await execFileAsync("git", ["-C", apps, "ls-tree", "-r", "--name-only", opts.ref], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
        const all = String(out.stdout).split("\n").map((l) => l.trim()).filter(Boolean)
          .filter((f) => !f.split("/").some((seg) => SKIP_DIRS.has(seg) || (seg.startsWith(".") && seg !== ".env.example")));
        const capped = all.length > REPO_TREE_MAX_FILES;
        return { available: true, files: capped ? all.slice(0, REPO_TREE_MAX_FILES) : all, capped, root: cand, source: "git-ls-tree" };
      } catch { /* commit ausente do clone / git indisponível: cai na cópia de trabalho */ }
    }
    const files: string[] = [];
    let capped = false;
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (capped || depth > 12) return;
      let entries: import("fs").Dirent[] = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (capped) return;
        if (e.name.startsWith(".") && e.name !== ".env.example") continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), r, depth + 1); }
        else { files.push(r); if (files.length >= REPO_TREE_MAX_FILES) { capped = true; return; } }
      }
    };
    await walk(apps, "", 0);
    return { available: true, files, capped, root: cand, source: "working-tree" };
  }
  return { available: false, files: [], capped: false, root: null };
}

export interface SpecFileSnapshot { path: string; sha: string }

export async function listSpecSnapshot(db: CheckDb, projectId: string): Promise<SpecFileSnapshot[]> {
  const rows = (await db.query("SELECT rel_dir, filename, content_sha256 FROM project_spec_files WHERE project_id = $1", [projectId])).rows;
  return rows.map((r) => {
    const dir = String(r.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
    return { path: dir ? `${dir}/${String(r.filename)}` : String(r.filename), sha: String(r.content_sha256 ?? "") };
  });
}

export interface RevalidateInput {
  /** Globs `files_allowed` por RFC do card (já parseados pelo gate). */
  rfcs: Array<{ path: string; filesAllowed: string[]; text: string }>;
  /** Texto do pedido do card (`request.md`/corpo) — também pode citar arquivos da spec-base. */
  requestText: string;
  previousBase: string | null;
  head: { id: string; version: number };
  productId: string | null;
  specNow: SpecFileSnapshot[];
  /** `null` = a base anterior não tem mais spec legível/ não se aplica (base == HEAD). */
  specBefore: SpecFileSnapshot[] | null;
  treeNow: RepoTree;
  treeBefore: RepoTree | null;
  /** O hash da spec do HEAD mudou em relação ao carimbado em `card_ready.base_spec_hash` (mesmo id de HEAD). */
  headSpecHashChanged: boolean;
}

export interface RevalidateOutcome {
  verdict: RevalidateVerdict;
  reasons: RevalidateReason[];
  globs: GlobCheck[];
  /** O HEAD é outro (ou a spec do HEAD mudou): rebasear o ponteiro é necessário. */
  moved: boolean;
  repo: { available: boolean; filesNow: number; filesBefore: number | null; capped: boolean };
  /**
   * Y-13: o HEAD andou e os globs de `files_allowed` NÃO puderam ser conferidos (sem clone). O veredito é `stale` com
   * `NEEDS_HUMAN_REVIEW`, e a jornada mostra o bloqueador "globs não conferidos" até alguém revalidar de novo.
   */
  globsUnverified: boolean;
  specDiff: { added: string[]; removed: string[]; changed: string[] };
}

/** Núcleo PURO (sem I/O) — testável sem banco nem disco. */
export function evaluateRevalidation(i: RevalidateInput): RevalidateOutcome {
  const reasons: RevalidateReason[] = [];
  const baseMoved = !!i.previousBase && i.previousBase !== i.head.id;
  const moved = baseMoved || i.headSpecHashChanged;
  if (baseMoved) {
    reasons.push({ code: "BASE_MOVED", severity: "info", message: `A versão corrente avançou (agora v${i.head.version}); o card foi escrito sobre uma base anterior.`, details: { previousBase: i.previousBase, headProjectId: i.head.id, headVersion: i.head.version } });
  } else if (i.headSpecHashChanged) {
    reasons.push({ code: "BASE_SPEC_CHANGED", severity: "info", message: "A spec da versão corrente mudou desde que o card foi validado." });
  }
  if (i.rfcs.length === 0) reasons.push({ code: "NO_RFC", severity: "info", message: "O card ainda não tem RFC: não há escopo (files_allowed) a conferir." });

  // Spec-base: o que mudou entre a base anterior e o HEAD novo.
  const specDiff = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  if (i.specBefore) {
    const before = new Map(i.specBefore.map((f) => [f.path, f.sha]));
    const now = new Map(i.specNow.map((f) => [f.path, f.sha]));
    for (const [p, sha] of now) { if (!before.has(p)) specDiff.added.push(p); else if (before.get(p) !== sha) specDiff.changed.push(p); }
    for (const p of before.keys()) if (!now.has(p)) specDiff.removed.push(p);
    for (const k of Object.keys(specDiff) as Array<keyof typeof specDiff>) specDiff[k].sort();
    if (specDiff.changed.length + specDiff.removed.length + specDiff.added.length > 0) {
      reasons.push({
        code: "NEEDS_HUMAN_REVIEW", severity: "warning",
        message: "A spec da versão corrente mudou: confira se o RFC do card continua coerente com ela (contradição semântica não é verificada automaticamente).",
        details: { ...specDiff },
      });
    }
  }
  // Citações (por caminho) do card a arquivos da spec-base que sumiram ou mudaram.
  const cards = [...i.rfcs.map((r) => ({ label: r.path, text: r.text })), { label: "pedido do card", text: i.requestText }];
  const cites = (text: string, p: string) => p.length >= 5 && text.toLowerCase().includes(p.toLowerCase());
  for (const p of specDiff.removed) {
    const by = cards.filter((c) => cites(c.text, p)).map((c) => c.label);
    if (by.length) reasons.push({ code: "RFC_REFERENCES_REMOVED_SPEC", severity: "conflict", message: `O card cita \`${p}\`, que foi REMOVIDO da spec da versão corrente.`, details: { path: p, citedBy: by } });
  }
  for (const p of specDiff.changed) {
    const by = cards.filter((c) => cites(c.text, p)).map((c) => c.label);
    if (by.length) reasons.push({ code: "RFC_REFERENCES_CHANGED_SPEC", severity: "warning", message: `O card cita \`${p}\`, que MUDOU na spec da versão corrente — releia antes de validar.`, details: { path: p, citedBy: by } });
  }

  // Globs × árvore do repositório.
  const globs: GlobCheck[] = [];
  const repo = { available: i.treeNow.available, filesNow: i.treeNow.files.length, filesBefore: i.treeBefore?.available ? i.treeBefore.files.length : null, capped: i.treeNow.capped };
  if (!i.treeNow.available) {
    if (i.rfcs.some((r) => r.filesAllowed.length > 0)) {
      reasons.push({ code: "REPO_UNAVAILABLE", severity: "info", message: "Sem repositório/clone do HEAD em disco: os globs de files_allowed NÃO foram conferidos contra a árvore de código." });
    }
  } else {
    for (const r of i.rfcs) {
      for (const g of r.filesAllowed) {
        if (isAlwaysAllowedGlob(g)) continue;
        const matchedNow = i.treeNow.files.some((f) => globMatches(g, f));
        const matchedBefore = i.treeBefore?.available ? i.treeBefore.files.some((f) => globMatches(g, f)) : null;
        globs.push({ rfc: r.path, glob: g, matchedNow, matchedBefore });
        if (matchedNow) continue;
        if (baseMoved && matchedBefore === true) {
          reasons.push({ code: "GLOB_NO_LONGER_MATCHES", severity: "conflict", message: `O glob \`${g}\` (${r.path}) casava com arquivos da base anterior e não casa com nada na versão corrente (v${i.head.version}).`, details: { glob: g, rfc: r.path } });
        } else {
          reasons.push({ code: "GLOB_UNMATCHED", severity: "warning", message: `O glob \`${g}\` (${r.path}) não casa com nenhum arquivo da versão corrente — esperado só se o card cria essa pasta/arquivo.`, details: { glob: g, rfc: r.path } });
        }
      }
    }
  }
  const globsUnverified = !i.treeNow.available && moved && i.rfcs.some((r) => r.filesAllowed.some((g) => !isAlwaysAllowedGlob(g)));
  if (globsUnverified && !reasons.some((r) => r.code === "NEEDS_HUMAN_REVIEW")) {
    reasons.push({
      code: "NEEDS_HUMAN_REVIEW", severity: "warning",
      message: "A versão corrente avançou e os globs de files_allowed não puderam ser conferidos (sem repositório/clone do HEAD): um humano precisa conferir o escopo do RFC antes de validar.",
      details: { globsUnverified: true },
    });
  }
  const verdict: RevalidateVerdict = reasons.some((r) => r.severity === "conflict") ? "conflict" : moved ? "stale" : "ok";
  return { verdict, reasons, globs, moved, repo, globsUnverified, specDiff };
}
