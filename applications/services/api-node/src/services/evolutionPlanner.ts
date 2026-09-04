/**
 * evolutionPlanner.ts — Evoluir E2: a Bancada gera os ARTEFATOS DE EVOLUÇÃO de um projeto filho
 * (`extra.evolution=true`) a partir do pedido humano, com a lógica do split (analisa → questiona →
 * propõe → desenha): `docs/rfc/RFC-NNNN-<slug>.md` (Gherkin + `## Impacto`/files_allowed),
 * `docs/adr/ADR-NNN-<slug>.md` (só se há decisão — MADR 4), `CHANGELOG.md` (`## [Unreleased]`,
 * Keep a Changelog) e `connect.yaml` evoluído (se interfaces/eventos mudam).
 *
 * Contexto ao arquiteto (LLM via /invoke/raw, SEM ferramentas): spec vigente do produto/serviço,
 * charter do CTO do pai (disco), MAPA do repositório clonado no filho (árvore de `apps/`, cap),
 * `connect.yaml` herdado, RFCs já existentes no filho (não duplicar), pedido do humano.
 * Numeração: por PRODUTO (E-D4) via `products.next_rfc_seq/next_adr_seq` (migration 080), alocada
 * atomicamente; RFC ainda passa pelo mesmo parser do gate (E3) — problemas voltam como avisos para
 * o humano corrigir no editor ANTES de promover (o gate/Stage A bloqueiam de novo se persistirem).
 * Nada aqui promove: o humano revisa e clica "Promover à Fábrica" (type-to-confirm; D4 audita).
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { Pool } from "pg";
import { parseRfcMarkdown, RFC_DIR } from "./evolutionGate.js";
import { projectRootCandidates } from "./connectManifestsDisk.js";
import { parseSpecPath } from "../routes/specFiles.js";
import { sha256Hex, SPEC_TREE_MAX_FILES, SPEC_TREE_MAX_FILE_BYTES } from "../lib/specTreeHash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = path.resolve(__dirname, "..", "assets", "EVOLVE_PLAN_PROMPT.md");
export const ADR_DIR = "docs/adr";
const UPLOAD_DIR = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
const SPEC_CAP = 40_000;
const CHARTER_CAP = 12_000;
const REPO_MAP_CAP = 12_000;
const MAX_RFCS = 4;
const MAX_ADRS = 3;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", "coverage", ".turbo"]);

type Db = Pick<Pool, "query">;

let _promptCache: string | null = null;
export function loadEvolvePlanPrompt(): string {
  if (_promptCache === null) {
    try { _promptCache = fs.readFileSync(PROMPT_FILE, "utf-8"); } catch { _promptCache = ""; }
  }
  return _promptCache;
}

// ── Contexto ─────────────────────────────────────────────────────────────────

export interface EvolutionPlanContext {
  childId: string;
  parentId: string | null;
  productId: string | null;
  title: string;
  request: string;
  specMarkdown: string;
  charter: string;
  repoMap: string;
  connectYaml: string | null;
  existingRfcs: string[];
  existingChangelog: string | null;
  nextRfcSeq: number;
  nextAdrSeq: number;
}

async function readCapped(p: string, cap: number): Promise<string> {
  try {
    const s = await fsp.readFile(p, "utf-8");
    return s.length > cap ? s.slice(0, cap) + `\n… [truncado em ${cap} chars]` : s;
  } catch { return ""; }
}

async function firstExisting(cands: string[]): Promise<string | null> {
  for (const c of cands) {
    try { const st = await fsp.stat(c); if (st.isDirectory()) return c; } catch { /* next */ }
  }
  return null;
}

/** Árvore de `apps/` do projeto (sem node_modules etc.), até o cap — o "repo map" do arquiteto. */
export async function buildRepoMap(appsDir: string, cap = REPO_MAP_CAP, maxFiles = 600): Promise<string> {
  const lines: string[] = [];
  let count = 0;
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (count >= maxFiles || depth > 8) return;
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (count >= maxFiles) return;
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        lines.push(`${"  ".repeat(depth)}${e.name}/`);
        await walk(path.join(dir, e.name), r, depth + 1);
      } else {
        count++;
        lines.push(`${"  ".repeat(depth)}${e.name}`);
      }
    }
  }
  await walk(appsDir, "", 0);
  if (lines.length === 0) return "";
  const out = lines.join("\n");
  return out.length > cap ? out.slice(0, cap) + `\n… [árvore truncada: ${count} arquivos]` : out;
}

export async function buildEvolutionPlanContext(db: Db, childId: string, requestOverride?: string | null): Promise<EvolutionPlanContext> {
  const row = (await db.query(
    "SELECT id, title, product_id, parent_project_id, extra FROM projects WHERE id = $1", [childId],
  )).rows[0] as { id: string; title: string; product_id: string | null; parent_project_id: string | null; extra: Record<string, unknown> | null } | undefined;
  if (!row) throw new Error("PROJECT_NOT_FOUND");
  const extra = row.extra ?? {};
  if (extra.evolution !== true) throw new Error("NOT_EVOLUTION");
  const parentId = (extra.evolution_parent_id as string | undefined) ?? row.parent_project_id ?? null;
  const request = (requestOverride ?? "").trim()
    || String(extra.evolution_request_original ?? extra.evolution_request ?? "").trim();

  const files = (await db.query(
    "SELECT filename, file_path, rel_dir, is_primary FROM project_spec_files WHERE project_id = $1 ORDER BY is_primary DESC, rel_dir, filename",
    [childId],
  )).rows as Array<{ filename: string; file_path: string; rel_dir: string | null; is_primary: boolean }>;
  const norm = (d: string | null) => (d ?? "").replace(/^\/+|\/+$/g, "");
  const primary = files.find((f) => f.is_primary) ?? files[0];
  let specMarkdown = primary ? await readCapped(primary.file_path, SPEC_CAP) : "";
  // O primário do filho é a spec do pai com o header "# EVOLUTION REQUEST" — removemos o header
  // (o pedido vai em campo próprio) para o arquiteto ver a spec VIGENTE limpa.
  specMarkdown = specMarkdown.replace(/^# EVOLUTION REQUEST[^\n]*\n(?:>[^\n]*\n)*\n?/m, "").trim();
  const connectRow = files.find((f) => f.filename === "connect.yaml" && norm(f.rel_dir) === "");
  const connectYaml = connectRow ? (await readCapped(connectRow.file_path, 16_000) || null) : null;
  const changelogRow = files.find((f) => f.filename.toLowerCase() === "changelog.md" && norm(f.rel_dir) === "");
  const existingChangelog = changelogRow ? (await readCapped(changelogRow.file_path, 16_000) || null) : null;
  const existingRfcs = files.filter((f) => norm(f.rel_dir).toLowerCase() === RFC_DIR).map((f) => f.filename);

  const filesRoot = (process.env.PROJECT_FILES_ROOT ?? process.env.HOST_PROJECT_FILES_ROOT ?? "").trim();
  let charter = "";
  let repoMap = "";
  if (filesRoot) {
    if (parentId) {
      const pRoot = await firstExisting(projectRootCandidates(filesRoot, parentId, row.product_id));
      if (pRoot) charter = await readCapped(path.join(pRoot, "docs", "cto_charter.md"), CHARTER_CAP);
    }
    // apps/ do FILHO (clonado no E1); fallback: apps/ do pai.
    const cands = projectRootCandidates(filesRoot, childId, row.product_id).map((r) => path.join(r, "apps"))
      .concat(parentId ? projectRootCandidates(filesRoot, parentId, row.product_id).map((r) => path.join(r, "apps")) : []);
    for (const c of cands) {
      const m = await buildRepoMap(c);
      if (m) { repoMap = m; break; }
    }
  }

  let nextRfcSeq = 1, nextAdrSeq = 1;
  if (row.product_id) {
    const seq = (await db.query("SELECT next_rfc_seq, next_adr_seq FROM products WHERE id = $1", [row.product_id])).rows[0] as { next_rfc_seq?: number; next_adr_seq?: number } | undefined;
    nextRfcSeq = Number(seq?.next_rfc_seq ?? 1) || 1;
    nextAdrSeq = Number(seq?.next_adr_seq ?? 1) || 1;
  }
  // Numeração nunca colide com RFCs já presentes no filho (herdados de versões anteriores).
  for (const f of existingRfcs) {
    const n = Number(f.match(/^RFC-(\d{4})/i)?.[1] ?? 0);
    if (n >= nextRfcSeq) nextRfcSeq = n + 1;
  }

  return { childId, parentId, productId: row.product_id, title: row.title, request, specMarkdown, charter, repoMap, connectYaml, existingRfcs, existingChangelog, nextRfcSeq, nextAdrSeq };
}

// ── Pedido ao arquiteto (/invoke/raw) ────────────────────────────────────────

export function buildEvolutionPlanRequest(ctx: EvolutionPlanContext): Record<string, unknown> {
  const parts = [
    `PRODUTO/SERVIÇO: ${ctx.title}`,
    `PRÓXIMOS NÚMEROS: RFC-${String(ctx.nextRfcSeq).padStart(4, "0")} · ADR-${String(ctx.nextAdrSeq).padStart(3, "0")} (o sistema numera — não escreva números nos títulos)`,
    "",
    "--- PEDIDO DE EVOLUÇÃO (humano) ---",
    ctx.request || "(sem texto — deduza do histórico da spec e pergunte em `questions`)",
    "--- FIM DO PEDIDO ---",
    "",
    "--- SPEC VIGENTE DO PRODUTO/SERVIÇO (só leitura) ---",
    ctx.specMarkdown || "(spec indisponível)",
    "--- FIM DA SPEC ---",
  ];
  if (ctx.charter) parts.push("", "--- CHARTER DO CTO (arquitetura vigente; respeite) ---", ctx.charter, "--- FIM DO CHARTER ---");
  if (ctx.repoMap) parts.push("", "--- MAPA DO REPOSITÓRIO (apps/ — use estes caminhos REAIS no `files_allowed`) ---", ctx.repoMap, "--- FIM DO MAPA ---");
  else parts.push("", "MAPA DO REPOSITÓRIO: indisponível — declare `files_allowed` por pastas de módulo coerentes com a spec/charter.");
  if (ctx.connectYaml) parts.push("", "--- connect.yaml VIGENTE ---", ctx.connectYaml, "--- FIM ---");
  if (ctx.existingRfcs.length) parts.push("", `RFCs JÁ EXISTENTES no projeto (não duplique): ${ctx.existingRfcs.join(", ")}`);
  if (ctx.existingChangelog) parts.push("", "--- CHANGELOG.md ATUAL (só para contexto; devolva apenas os itens novos) ---", ctx.existingChangelog.slice(0, 4000), "--- FIM ---");
  parts.push("", "Devolva agora SOMENTE o objeto JSON no formato especificado.");
  return {
    prompt_override: loadEvolvePlanPrompt(),
    user_message: parts.join("\n"),
    max_tokens: 14_000,
  };
}

// ── Parse (saída de LLM NUNCA entra crua) ────────────────────────────────────

export type Compat = "patch" | "minor" | "major";
export interface PlanDoc { slug: string; title: string; content: string }
export interface EvolutionPlan {
  summary: string;
  compat: Compat;
  questions: string[];
  rfcs: PlanDoc[];
  adrs: PlanDoc[];
  changelog: Record<"added" | "changed" | "deprecated" | "removed" | "fixed" | "security", string[]>;
  connectYaml: string | null;
}

const CHANGELOG_KEYS = ["added", "changed", "deprecated", "removed", "fixed", "security"] as const;

export function slugify(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "evolucao";
}

function extractJson(text: string): unknown {
  let t = text.trim();
  // Só a cerca EXTERNA (o JSON legitimamente contém ```yaml dentro dos RFCs): se começa com ```,
  // descarta a 1ª linha e a ÚLTIMA cerca — nunca casa cercas internas.
  if (t.startsWith("```")) {
    t = t.replace(/^```[^\n]*\n/, "");
    const lastFence = t.lastIndexOf("```");
    if (lastFence >= 0) t = t.slice(0, lastFence);
    t = t.trim();
  }
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("PLAN_NOT_JSON");
  return JSON.parse(t.slice(start, end + 1));
}

function docList(raw: unknown, max: number): PlanDoc[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanDoc[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const content = typeof o.content === "string" ? o.content.trim() : "";
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 140) : "";
    if (content.length < 40 || !title) continue;
    const slug = slugify(typeof o.slug === "string" && o.slug.trim() ? o.slug : title);
    out.push({ slug, title, content });
    if (out.length >= max) break;
  }
  return out;
}

export function parseEvolutionPlan(text: string): EvolutionPlan {
  const j = extractJson(text) as Record<string, unknown>;
  const compatRaw = String(j.compat ?? "minor").toLowerCase();
  const compat: Compat = compatRaw === "major" || compatRaw === "patch" ? compatRaw : "minor";
  const changelog = Object.fromEntries(CHANGELOG_KEYS.map((k) => {
    const v = (j.changelog as Record<string, unknown> | undefined)?.[k];
    return [k, Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim().slice(0, 300)).slice(0, 20) : []];
  })) as EvolutionPlan["changelog"];
  const cy = j.connect_yaml;
  const connectYaml = typeof cy === "string" && cy.trim() && /serviceName\s*:/.test(cy) && !/```/.test(cy) ? cy.trim() : null;
  const rfcs = docList(j.rfcs, MAX_RFCS);
  if (rfcs.length === 0) throw new Error("PLAN_WITHOUT_RFC");
  return {
    summary: typeof j.summary === "string" ? j.summary.trim().slice(0, 1200) : "",
    compat,
    questions: Array.isArray(j.questions) ? j.questions.filter((q) => typeof q === "string" && q.trim()).map((q) => String(q).trim().slice(0, 400)).slice(0, 8) : [],
    rfcs,
    adrs: docList(j.adrs, MAX_ADRS),
    changelog,
    connectYaml,
  };
}

// ── Aplicação (grava no filho — mesmas regras do POST /spec-file) ────────────

function resolvePhysical(projectId: string, relDir: string, filename: string): string | null {
  const root = path.resolve(UPLOAD_DIR, projectId);
  const full = path.resolve(root, relDir, filename);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function upsertSpecFile(db: Db, projectId: string, relPath: string, content: string, overwrite: boolean): Promise<"created" | "updated" | "skipped"> {
  const parsed = parseSpecPath(relPath);
  if (!parsed) throw new Error(`BAD_PATH:${relPath}`);
  if (Buffer.byteLength(content, "utf-8") > SPEC_TREE_MAX_FILE_BYTES) throw new Error(`FILE_TOO_LARGE:${relPath}`);
  const physical = resolvePhysical(projectId, parsed.relDir, parsed.filename);
  if (!physical) throw new Error(`BAD_PATH:${relPath}`);
  const sha = sha256Hex(Buffer.from(content, "utf-8"));
  const existing = (await db.query(
    "SELECT file_path FROM project_spec_files WHERE project_id=$1 AND rel_dir=$2 AND filename=$3",
    [projectId, parsed.relDir, parsed.filename],
  )).rows[0] as { file_path: string } | undefined;
  if (existing) {
    if (!overwrite) return "skipped";
    await fsp.mkdir(path.dirname(existing.file_path), { recursive: true });
    await fsp.writeFile(existing.file_path, content, "utf-8");
    await db.query("UPDATE project_spec_files SET content_sha256=$1 WHERE project_id=$2 AND rel_dir=$3 AND filename=$4", [sha, projectId, parsed.relDir, parsed.filename]);
    return "updated";
  }
  const count = (await db.query("SELECT count(*)::int AS n FROM project_spec_files WHERE project_id=$1", [projectId])).rows[0] as { n: number };
  if (count.n >= SPEC_TREE_MAX_FILES) throw new Error("TOO_MANY_FILES");
  await db.query(
    `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
     VALUES ($1, $2, $3, 'text/markdown', $4, false, $5)`,
    [projectId, parsed.filename, physical, parsed.relDir, sha],
  );
  await fsp.mkdir(path.dirname(physical), { recursive: true });
  await fsp.writeFile(physical, content, "utf-8");
  return "created";
}

/** Insere itens em `## [Unreleased]` (Keep a Changelog 1.1); cria o arquivo se não existir. */
export function mergeChangelog(existing: string | null, items: EvolutionPlan["changelog"], title: string): string {
  const sections = CHANGELOG_KEYS.filter((k) => items[k].length > 0);
  const block = sections.map((k) => `### ${k[0].toUpperCase()}${k.slice(1)}\n${items[k].map((i) => `- ${i}`).join("\n")}`).join("\n\n");
  if (!existing || !existing.trim()) {
    return `# Changelog — ${title}\n\nTodas as mudanças relevantes deste serviço são registradas aqui.\nFormato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) · versionamento [SemVer](https://semver.org/lang/pt-BR/).\n\n## [Unreleased]\n\n${block}\n`;
  }
  if (!block) return existing;
  const idx = existing.search(/^## \[Unreleased\]/mi);
  if (idx < 0) {
    // Sem seção Unreleased: inserir antes da primeira versão (ou no fim).
    const firstVer = existing.search(/^## \[/m);
    const ins = `## [Unreleased]\n\n${block}\n\n`;
    return firstVer < 0 ? `${existing.trimEnd()}\n\n${ins}` : existing.slice(0, firstVer) + ins + existing.slice(firstVer);
  }
  // Existe Unreleased: mesclar por seção (append nos ### existentes; criar os ausentes) dentro dela.
  const after = existing.slice(idx);
  const nextVer = after.slice(1).search(/^## \[/m);
  const unreleasedEnd = nextVer < 0 ? existing.length : idx + 1 + nextVer;
  let unreleased = existing.slice(idx, unreleasedEnd).trimEnd();
  for (const k of sections) {
    const h = `### ${k[0].toUpperCase()}${k.slice(1)}`;
    const re = new RegExp(`^${h}\\s*$`, "mi");
    const lines = items[k].map((i) => `- ${i}`).join("\n");
    if (re.test(unreleased)) {
      // append ao fim da subseção
      const hIdx = unreleased.search(re);
      const rest = unreleased.slice(hIdx);
      const nextH = rest.slice(1).search(/^### /m);
      const secEnd = nextH < 0 ? unreleased.length : hIdx + 1 + nextH;
      unreleased = unreleased.slice(0, secEnd).trimEnd() + "\n" + lines + "\n" + (secEnd < unreleased.length ? "\n" + unreleased.slice(secEnd) : "");
    } else {
      unreleased = unreleased.trimEnd() + `\n\n${h}\n${lines}`;
    }
  }
  return existing.slice(0, idx) + unreleased.trimEnd() + "\n\n" + existing.slice(unreleasedEnd).replace(/^\s+/, "");
}

export interface ApplyResult {
  written: Array<{ path: string; action: "created" | "updated" | "skipped" }>;
  rfcProblems: Array<{ path: string; problems: string[] }>;
  warnings: string[];
  compat: Compat;
  summary: string;
  questions: string[];
}

export async function applyEvolutionPlan(db: Db, ctx: EvolutionPlanContext, plan: EvolutionPlan): Promise<ApplyResult> {
  const written: ApplyResult["written"] = [];
  const rfcProblems: ApplyResult["rfcProblems"] = [];
  const warnings: string[] = [];

  // Numeração por produto — alocação atômica (E-D4). Sem produto: sequência local do filho.
  let rfcBase = ctx.nextRfcSeq, adrBase = ctx.nextAdrSeq;
  if (ctx.productId) {
    const r = (await db.query(
      "UPDATE products SET next_rfc_seq = GREATEST(next_rfc_seq, $2) + $3, next_adr_seq = next_adr_seq + $4 WHERE id = $1 RETURNING next_rfc_seq, next_adr_seq",
      [ctx.productId, ctx.nextRfcSeq, plan.rfcs.length, plan.adrs.length],
    )).rows[0] as { next_rfc_seq: number; next_adr_seq: number } | undefined;
    if (r) { rfcBase = Number(r.next_rfc_seq) - plan.rfcs.length; adrBase = Number(r.next_adr_seq) - plan.adrs.length; }
  }

  plan.rfcs.forEach((_, i) => void i);
  for (let i = 0; i < plan.rfcs.length; i++) {
    const d = plan.rfcs[i];
    const num = String(rfcBase + i).padStart(4, "0");
    const filename = `RFC-${num}-${d.slug}.md`;
    const relPath = `${RFC_DIR}/${filename}`;
    // Título numerado no topo (o modelo não numera); preserva o resto do conteúdo.
    const body = d.content.replace(/^#\s+[^\n]*\n?/, "").trimStart();
    const content = `# RFC-${num} — ${d.title}\n\n> Compatibilidade declarada pelo arquiteto: **${plan.compat.toUpperCase()}** · gerado pela Bancada (Evoluir) — revise antes de promover.\n\n${body}\n`;
    const parsed = parseRfcMarkdown(relPath, content);
    if (parsed.problems.length) rfcProblems.push({ path: relPath, problems: parsed.problems });
    written.push({ path: relPath, action: await upsertSpecFile(db, ctx.childId, relPath, content, false) });
  }
  for (let i = 0; i < plan.adrs.length; i++) {
    const d = plan.adrs[i];
    const num = String(adrBase + i).padStart(3, "0");
    const relPath = `${ADR_DIR}/ADR-${num}-${d.slug}.md`;
    const body = d.content.replace(/^#\s+[^\n]*\n?/, "").trimStart();
    written.push({ path: relPath, action: await upsertSpecFile(db, ctx.childId, relPath, `# ADR-${num} — ${d.title}\n\n${body}\n`, false) });
  }
  const hasChangelogItems = CHANGELOG_KEYS.some((k) => plan.changelog[k].length > 0);
  if (hasChangelogItems) {
    const merged = mergeChangelog(ctx.existingChangelog, plan.changelog, ctx.title.replace(/ — Evolução v\d+$/i, ""));
    written.push({ path: "CHANGELOG.md", action: await upsertSpecFile(db, ctx.childId, "CHANGELOG.md", merged, true) });
  } else {
    warnings.push("O arquiteto não propôs itens de CHANGELOG — adicione ao menos um item em `## [Unreleased]` antes do aceite.");
  }
  if (plan.connectYaml) {
    if (plan.connectYaml === ctx.connectYaml) {
      warnings.push("connect.yaml devolvido igual ao vigente — mantido.");
    } else {
      // A API não tem parser YAML: o contrato é validado no /run (gate Connect do runner) e no Stage A.
      written.push({ path: "connect.yaml", action: await upsertSpecFile(db, ctx.childId, "connect.yaml", plan.connectYaml + (plan.connectYaml.endsWith("\n") ? "" : "\n"), true) });
      warnings.push("connect.yaml EVOLUÍDO pelo arquiteto — revise a diferença; a validação contra o schema Connect ocorre na promoção.");
    }
  }
  if (rfcProblems.length) {
    warnings.push(`${rfcProblems.length} RFC(s) com pendências para o gate de promoção — corrija no editor ou peça ao chat do arquivo.`);
  }
  await db.query(
    "UPDATE projects SET extra = COALESCE(extra, '{}'::jsonb) || $2::jsonb, updated_at = now(), spec_dirty_at = now() WHERE id = $1",
    [ctx.childId, JSON.stringify({
      evolution_plan: {
        at: new Date().toISOString(), compat: plan.compat, summary: plan.summary.slice(0, 600),
        rfcs: written.filter((w) => w.path.startsWith(RFC_DIR)).map((w) => w.path),
        adrs: written.filter((w) => w.path.startsWith(ADR_DIR)).map((w) => w.path),
        questions: plan.questions,
      },
      evolution_compat: plan.compat,
    })],
  );
  return { written, rfcProblems, warnings, compat: plan.compat, summary: plan.summary, questions: plan.questions };
}

// ── Jobs em memória (padrão do spec-chat; morre no restart — best-effort, o humano reenvia) ──

export type PlanJobStatus = "pending" | "running" | "done" | "error";
export interface PlanJob {
  id: string;
  projectId: string;
  ownerUserId: string;
  status: PlanJobStatus;
  createdAt: number;
  result?: ApplyResult;
  error?: string;
}
const _jobs = new Map<string, PlanJob>();
const JOB_TTL_MS = 60 * 60 * 1000;

export function createPlanJob(projectId: string, ownerUserId: string): PlanJob {
  for (const [k, j] of _jobs) if (Date.now() - j.createdAt > JOB_TTL_MS) _jobs.delete(k);
  const job: PlanJob = { id: `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, projectId, ownerUserId, status: "pending", createdAt: Date.now() };
  _jobs.set(job.id, job);
  return job;
}
export function getPlanJob(id: string): PlanJob | undefined { return _jobs.get(id); }
/** Há job vivo (pending/running) para o projeto? Evita 2 planejamentos concorrentes no mesmo filho. */
export function activePlanJobFor(projectId: string): PlanJob | undefined {
  for (const j of _jobs.values()) if (j.projectId === projectId && (j.status === "pending" || j.status === "running")) return j;
  return undefined;
}

export async function runEvolutionPlan(db: Db, job: PlanJob, requestOverride: string | null, invoke: (body: Record<string, unknown>) => Promise<string>): Promise<void> {
  job.status = "running";
  try {
    const ctx = await buildEvolutionPlanContext(db, job.projectId, requestOverride);
    if (!ctx.request) throw new Error("EMPTY_REQUEST");
    const raw = await invoke(buildEvolutionPlanRequest(ctx));
    const data = JSON.parse(raw) as { response?: string; model_used?: string };
    const text = String(data.response ?? "");
    if (text.trim().length < 50) throw new Error("EMPTY_RESPONSE");
    const plan = parseEvolutionPlan(text);
    job.result = await applyEvolutionPlan(db, ctx, plan);
    job.status = "done";
  } catch (e) {
    job.status = "error";
    const msg = e instanceof Error ? e.message : String(e);
    job.error = msg === "PLAN_WITHOUT_RFC" ? "O arquiteto não devolveu nenhum RFC válido. Reformule o pedido (o que muda, para quem, por quê)."
      : msg === "PLAN_NOT_JSON" || /JSON/.test(msg) ? "O arquiteto não devolveu um plano em JSON válido. Tente de novo."
      : msg === "EMPTY_REQUEST" ? "Pedido de evolução vazio — descreva o que deve mudar."
      : msg.slice(0, 300);
  }
}
