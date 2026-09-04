/**
 * evolutionGate.ts — Evoluir E3: gatilho de promoção de uma EVOLUÇÃO (projeto filho, `extra.evolution=true`).
 *
 * Regra: uma evolução só entra na fábrica com pelo menos um **RFC** na Bancada
 * (`docs/rfc/RFC-NNNN-<slug>.md`) que seja IMPLEMENTÁVEL e TESTÁVEL:
 *  - critérios de aceite em Gherkin (Dado/Quando/Então ou Given/When/Then) — vira FAIL_TO_PASS do QA;
 *  - seção `## Impacto` com `files_allowed` (globs) — vira o ESCOPO do gate determinístico do E4
 *    ("arquivos tocados ⊆ escopo"); nunca é auto-expandido pela fábrica;
 *  - `## Compatibilidade` (opcional, recomendado): PATCH/MINOR/MAJOR (SemVer) / `breaking: true`.
 * Sem RFC → 409 EVOLUTION_RFC_REQUIRED (com o caminho do template). Com RFC inválido → 409
 * EVOLUTION_RFC_INVALID listando o que falta. Com RFC válido → grava em `projects.extra`:
 * `evolution_rfcs[]`, `evolution_scope[]` (união dos globs), `evolution_compat`, e um
 * `evolution_request` SINTETIZADO dos RFCs (o runner injeta no CTO — não mais o texto livre cru).
 * Grounding: Rust RFC / Google design docs (Non-goals + Impacto), RFC 2119, Gherkin (cucumber.io),
 * Keep a Changelog / SemVer, change impact analysis (Bohner & Arnold) — plano Evoluir §2/§4.
 * Fase 1: RFC escrito à mão (template em src/assets/RFC_TEMPLATE.md, servido por GET /api/spec-templates/rfc);
 * Fase 2 (E2): gerado pelo chat.
 */
import { readFile } from "fs/promises";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const RFC_DIR = "docs/rfc";
export const RFC_FILENAME_RE = /^RFC-(\d{4})-[a-z0-9][a-z0-9-]*\.md$/i;
/** Template vendorizado em src/assets (o Dockerfile copia src/assets → dist/assets). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RFC_TEMPLATE_FILE = path.resolve(__dirname, "..", "assets", "RFC_TEMPLATE.md");
/** Como o tenant obtém o modelo (rota autenticada — o caminho do repositório não serve ao cliente). */
export const RFC_TEMPLATE_ENDPOINT = "GET /api/spec-templates/rfc";
/** Globs que esvaziam o gate do E4 (escopo = "tudo"). Fase 1: proibidos — o RFC declara módulos/pastas. */
const UNRESTRICTED_GLOBS = new Set(["**", "*", "**/*", ".", "./", "./**", "apps", "apps/", "apps/**", "apps/*", "apps/**/*"]);

let _templateCache: string | null = null;
export function loadRfcTemplate(): string {
  if (_templateCache === null) {
    try { _templateCache = fs.readFileSync(RFC_TEMPLATE_FILE, "utf-8"); } catch { _templateCache = ""; }
  }
  return _templateCache;
}

export type RfcCompat = "patch" | "minor" | "major";

export interface ParsedRfc {
  path: string;
  number: number | null;
  title: string;
  summary: string;
  hasGherkin: boolean;
  gherkinScenarios: number;
  mustCount: number;
  filesAllowed: string[];
  compat: RfcCompat | null;
  breaking: boolean;
  hasNonGoals: boolean;
  problems: string[];
}

type Db = { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

function section(md: string, heading: RegExp): string {
  // Conteúdo entre um heading que casa `heading` e o próximo heading de nível ≤ 2.
  const lines = md.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i]) && heading.test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

function extractFilesAllowed(impacto: string): string[] {
  const globs = new Set<string>();
  // (a) bloco yaml: files_allowed:\n  - "src/**"
  const yamlBlock = impacto.match(/```ya?ml\s*([\s\S]*?)```/i)?.[1] ?? impacto;
  const fa = yamlBlock.match(/files_allowed\s*:\s*([\s\S]*?)(?:\n[a-zA-Z_]+\s*:|\n```|$)/i)?.[1] ?? "";
  // (a1) lista inline: files_allowed: [apps/a.ts, "apps/b/**"]
  const inline = fa.match(/^\s*\[([^\]]*)\]/);
  if (inline) {
    for (const item of inline[1].split(",")) {
      const g = item.trim().replace(/^["'`]|["'`]$/g, "").trim();
      if (g) globs.add(g);
    }
  }
  for (const m of fa.matchAll(/^\s*-\s*["'`]?([^"'`\n#]+?)["'`]?\s*$/gm)) globs.add(m[1].trim());
  // (b) bullets com caminho em crase: - `apps/api/src/reports/**`
  for (const m of impacto.matchAll(/^\s*[-*]\s*`([^`\n]+)`/gm)) {
    const g = m[1].trim();
    if (/[\/.]/.test(g)) globs.add(g);
  }
  return [...globs].filter((g) => g && !g.includes("..") && !g.startsWith("/")).slice(0, 64);
}

export function parseRfcMarkdown(pathOrName: string, content: string): ParsedRfc {
  const name = pathOrName.split("/").pop() ?? pathOrName;
  const num = name.match(/^RFC-(\d{4})/i)?.[1];
  const title = (content.match(/^#\s+(.+)$/m)?.[1] ?? name).trim();
  const summary = section(content, /(sum[áa]rio|resumo|summary)/i).trim().split("\n").filter(Boolean).slice(0, 4).join(" ").slice(0, 600);
  // Gherkin SÓ nas seções de critérios de aceite OU de requisitos (E2E 2026-09-04: o arquiteto aninha
  // "- **Dado/Quando/Então**" sob cada MUST em `## Requisitos (MUST)` — válido, é o que o prompt pede),
  // sem fallback para o documento inteiro (prosa solta não conta) e com as palavras-chave em INÍCIO de
  // linha/bullet. Aceita "aceite"/"aceitação"/"acceptance"/"cenários".
  const acSec = [
    section(content, /(crit[ée]rios? de aceit(e|a[çc][ãa]o)|acceptance|cen[áa]rios)/i),
    section(content, /(requisitos|requirements)/i),
  ].filter(Boolean).join("\n");
  const kw = (w: RegExp) => new RegExp(`^\\s*(?:[-*+]\\s*|\\d+[.)]\\s*)?(?:\\*\\*|__)?\\s*(?:${w.source})\\b`, "im").test(acSec);
  const dado = kw(/dado|given/), quando = kw(/quando|when/), entao = kw(/ent[ãa]o|then/);
  const hasGherkin = Boolean(acSec) && dado && quando && entao;
  const gherkinScenarios = (acSec.match(/\b(cen[áa]rio|scenario)\b/gi) ?? []).length || (hasGherkin ? 1 : 0);
  const mustCount = (content.match(/\b(MUST|DEVE)\b/g) ?? []).length;
  const impacto = section(content, /(impacto|impact|escopo de arquivos|files)/i);
  const filesAllowedRaw = extractFilesAllowed(impacto);
  const unrestricted = filesAllowedRaw.filter((g) => UNRESTRICTED_GLOBS.has(g.replace(/\/+$/, "") || "."));
  const filesAllowed = filesAllowedRaw.filter((g) => !unrestricted.includes(g));
  // Escopo precisa de ≥1 glob de CÓDIGO: só testes/docs (que o gate já permite sempre) deixaria a fábrica
  // sem poder tocar código → toda entrega viraria violação → bloqueio garantido no E4.
  const codeGlobs = filesAllowed.filter((g) => !/(?:^|\/)(?:tests?|__tests__|docs)(?:\/|$)|\.(?:test|spec)\.[a-z]+$|\.md$/i.test(g));
  const compatSec = section(content, /(compatibilidade|compatibility)/i).toLowerCase();
  const breaking = /breaking\s*:\s*(true|sim)|\bmajor\b|\bbreaking change\b|\bincompat/i.test(compatSec);
  const compat: RfcCompat | null = breaking ? "major" : /\bminor\b|nova funcionalidade|feature/i.test(compatSec) ? "minor" : /\bpatch\b|correção|bugfix|fix\b/i.test(compatSec) ? "patch" : null;
  const hasNonGoals = /(n[ãa]o[- ]objetivos|non-goals|fora de escopo)/i.test(content);
  const problems: string[] = [];
  if (!hasGherkin) problems.push(acSec ? "critérios de aceite sem Gherkin em bullets (Dado/Quando/Então no início da linha, em `## Critérios de aceite` ou sob cada requisito)" : "sem seção `## Critérios de aceite`/`## Requisitos` com cenários Gherkin (Dado/Quando/Então)");
  if (unrestricted.length > 0) problems.push(`escopo irrestrito em files_allowed (${unrestricted.join(", ")}) — declare módulos/pastas específicos; "tudo" anula o gate de escopo`);
  if (filesAllowed.length === 0) problems.push("seção `## Impacto` sem `files_allowed` (globs dos arquivos que a fábrica pode tocar)");
  else if (codeGlobs.length === 0) problems.push("files_allowed só com testes/docs — declare ≥1 pasta/arquivo de CÓDIGO que a fábrica pode alterar");
  if (!num) problems.push("nome fora do padrão RFC-NNNN-<slug>.md");
  return { path: pathOrName, number: num ? parseInt(num, 10) : null, title, summary, hasGherkin, gherkinScenarios, mustCount, filesAllowed, compat, breaking, hasNonGoals, problems };
}

/**
 * RFCs desta evolução. E2E 2026-09-04: a v3 herda os RFCs da v2 (`/evolve` copia docs/rfc) — um RFC herdado e
 * NÃO alterado é história da versão anterior, não o delta desta; se contasse, o gate passaria sem RFC novo e o
 * CTO reimplementaria o RFC antigo. Herdados vêm em `extra.evolution_inherited_spec` [{path, sha}]; só são
 * ignorados enquanto o sha for idêntico (editar/ampliar um RFC herdado o torna RFC desta versão).
 */
export async function collectEvolutionRfcs(db: Db, projectId: string, extra?: Record<string, unknown> | null): Promise<ParsedRfc[]> {
  const rows = (await db.query(
    "SELECT filename, file_path, rel_dir, content_sha256 FROM project_spec_files WHERE project_id = $1 ORDER BY filename ASC",
    [projectId],
  )).rows as Array<{ filename: string; file_path: string; rel_dir: string | null; content_sha256: string | null }>;
  const inherited = new Map<string, string>();
  for (const it of (extra?.evolution_inherited_spec as Array<{ path?: string; sha?: string }> | undefined) ?? []) {
    if (it?.path && it?.sha) inherited.set(String(it.path).toLowerCase(), String(it.sha));
  }
  const out: ParsedRfc[] = [];
  for (const r of rows) {
    const rel = (r.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
    if (rel.toLowerCase() !== RFC_DIR || !RFC_FILENAME_RE.test(r.filename)) continue;
    const inheritedSha = inherited.get(`${rel}/${r.filename}`.toLowerCase());
    if (inheritedSha && r.content_sha256 && inheritedSha === r.content_sha256) continue; // herdado sem alteração
    let content = "";
    try { content = await readFile(r.file_path, "utf-8"); } catch { continue; }
    out.push(parseRfcMarkdown(`${rel}/${r.filename}`, content));
  }
  return out;
}

export type EvolutionGateResult =
  | { ok: true; applied: false }
  | { ok: true; applied: true; rfcs: number; scope: string[]; compat: RfcCompat | null }
  | { ok: false; code: "EVOLUTION_RFC_REQUIRED" | "EVOLUTION_RFC_INVALID"; message: string; details?: unknown };

function compatMax(list: Array<RfcCompat | null>): RfcCompat | null {
  const rank: Record<RfcCompat, number> = { patch: 1, minor: 2, major: 3 };
  let best: RfcCompat | null = null;
  for (const c of list) if (c && (!best || rank[c] > rank[best])) best = c;
  return best;
}

/** Aplica o gate à promoção de um projeto. Não-evolução → passthrough. Evolução válida → grava metadados. */
export async function evaluateEvolutionGate(db: Db, projectId: string, extra: Record<string, unknown> | null | undefined): Promise<EvolutionGateResult> {
  if (!extra || extra.evolution !== true) return { ok: true, applied: false };
  const rfcs = await collectEvolutionRfcs(db, projectId, extra);
  if (rfcs.length === 0) {
    return {
      ok: false, code: "EVOLUTION_RFC_REQUIRED",
      message: `Evolução sem RFC. Escreva pelo menos um \`${RFC_DIR}/RFC-0001-<slug>.md\` na Bancada (critérios de aceite em Gherkin + \`## Impacto\` com \`files_allowed\`). Modelo: ${RFC_TEMPLATE_ENDPOINT}.`,
      details: { template_endpoint: "/api/spec-templates/rfc", rfc_dir: RFC_DIR },
    };
  }
  const invalid = rfcs.filter((r) => r.problems.length > 0);
  if (invalid.length > 0) {
    return {
      ok: false, code: "EVOLUTION_RFC_INVALID",
      message: "RFC(s) incompletos para a fábrica: " + invalid.map((r) => `${r.path}: ${r.problems.join("; ")}`).join(" | "),
      details: invalid.map((r) => ({ path: r.path, problems: r.problems })),
    };
  }
  const scope = [...new Set(rfcs.flatMap((r) => r.filesAllowed))];
  const compat = compatMax(rfcs.map((r) => r.compat));
  const synthesized = rfcs.map((r) => `- ${r.path.split("/").pop()} — ${r.title}${r.summary ? `: ${r.summary}` : ""}`).join("\n");
  const patch: Record<string, unknown> = {
    evolution_rfcs: rfcs.map((r) => r.path),
    evolution_scope: scope,
    evolution_compat: compat,
    // Bloco 4 GAP 7: `compat` pode ser `null` (nenhuma seção "Compatibilidade" casou) e o aceite
    // normaliza `null → "minor"` silenciosamente — um breaking change entraria como minor. O merge
    // automático exige compat EXPLÍCITO; só é explícito se ao menos um RFC declarou a compatibilidade.
    evolution_compat_explicit: rfcs.some((r) => r.compat !== null),
    evolution_request: `Implementar os RFCs abaixo (fonte autoritativa do delta — ver docs/rfc/):\n${synthesized}`,
  };
  if (typeof extra.evolution_request === "string" && extra.evolution_request && !extra.evolution_request_original) {
    patch.evolution_request_original = extra.evolution_request;
  }
  await db.query(
    "UPDATE projects SET extra = COALESCE(extra, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1",
    [projectId, JSON.stringify(patch)],
  );
  return { ok: true, applied: true, rfcs: rfcs.length, scope, compat };
}
