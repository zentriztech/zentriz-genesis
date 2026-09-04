/**
 * evolutionAccept.ts — Evoluir E5: ACEITE de uma evolução (projeto filho `extra.evolution=true`).
 *
 * Princípio: evolução = nova VERSÃO do MESMO serviço. No aceite:
 *  1. CHANGELOG.md: `## [Unreleased]` → `## [x.y.z] - AAAA-MM-DD` (SemVer pela compatibilidade
 *     declarada nos RFCs — `extra.evolution_compat`: major/minor/patch; base = última versão do
 *     CHANGELOG ou 1.0.0 do pai) e cópia para `apps/CHANGELOG.md` (o mesmo arquivo vai ao repo).
 *  2. Push do `apps/` do filho no repo do PRODUTO/SERVIÇO (o da RAIZ da linhagem) em `evolution/vN`
 *     + PR aberto para `dev` (E-D2: merge automático só depois de provada a permissão em prod);
 *     sem repo na linhagem → fallback: fluxo normal (cria repo — identidade já é a da raiz).
 *  3. Supersessão do pai (E-D1): `archived` + `extra.superseded_by` (o filho vira a versão corrente;
 *     `extra.supersedes` no filho). Nunca apaga nada.
 *  4. Deadpool: mesma chave (identidade pela raiz — E1), re-registro apontando o `local_path` novo.
 * Tudo best-effort e registrado em `project_dialogue` — o aceite HTTP nunca falha por isto.
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import type { Pool } from "pg";
import { resolveLineageRoot } from "./lineage.js";
import { projectRootCandidates } from "./connectManifestsDisk.js";
import { sha256Hex } from "../lib/specTreeHash.js";

type Db = Pick<Pool, "query">;
export type Compat = "patch" | "minor" | "major";

export function bumpSemver(base: string, compat: Compat): string {
  const m = base.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  let [maj, min, pat] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [1, 0, 0];
  if (compat === "major") { maj += 1; min = 0; pat = 0; }
  else if (compat === "minor") { min += 1; pat = 0; }
  else { pat += 1; }
  return `${maj}.${min}.${pat}`;
}

/** Última versão liberada no CHANGELOG (`## [x.y.z] - data`), ignorando Unreleased. */
export function lastReleasedVersion(changelog: string): string | null {
  for (const m of changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)) return m[1];
  return null;
}

/**
 * Fecha a seção Unreleased como versão datada (Keep a Changelog 1.1): mantém um `## [Unreleased]`
 * vazio no topo e move o conteúdo para `## [x.y.z] - AAAA-MM-DD`. Sem Unreleased com conteúdo →
 * cria a versão com um item genérico (nunca aceita sem registro).
 */
export function releaseChangelog(changelog: string | null, version: string, date: string, fallbackItem: string): string {
  const header = `## [${version}] - ${date}`;
  if (!changelog || !changelog.trim()) {
    return `# Changelog\n\nFormato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) · [SemVer](https://semver.org/lang/pt-BR/).\n\n## [Unreleased]\n\n${header}\n\n### Changed\n- ${fallbackItem}\n`;
  }
  const idx = changelog.search(/^## \[Unreleased\]/mi);
  if (idx < 0) {
    const firstVer = changelog.search(/^## \[/m);
    const block = `## [Unreleased]\n\n${header}\n\n### Changed\n- ${fallbackItem}\n\n`;
    return firstVer < 0 ? `${changelog.trimEnd()}\n\n${block}` : changelog.slice(0, firstVer) + block + changelog.slice(firstVer);
  }
  const after = changelog.slice(idx);
  const headerLineEnd = after.indexOf("\n");
  const bodyStart = idx + (headerLineEnd < 0 ? after.length : headerLineEnd + 1);
  const nextVer = changelog.slice(bodyStart).search(/^## \[/m);
  const bodyEnd = nextVer < 0 ? changelog.length : bodyStart + nextVer;
  const body = changelog.slice(bodyStart, bodyEnd).trim();
  const released = body ? `${header}\n\n${body}\n\n` : `${header}\n\n### Changed\n- ${fallbackItem}\n\n`;
  return `${changelog.slice(0, idx)}## [Unreleased]\n\n${released}${changelog.slice(bodyEnd).replace(/^\s+/, "")}`;
}

async function firstExistingDir(cands: string[]): Promise<string | null> {
  for (const c of cands) {
    try { if ((await fsp.stat(c)).isDirectory()) return c; } catch { /* next */ }
  }
  return null;
}

export interface FinalizeResult { version: string; changelogPath: string | null; appsCopy: string | null }

/** Passo 1 — versiona o CHANGELOG do filho (spec-file) e copia para apps/CHANGELOG.md. */
export async function finalizeEvolutionChangelog(db: Db, childId: string, opts: { compat: Compat; title: string; productId: string | null; date?: string }): Promise<FinalizeResult> {
  const row = (await db.query(
    "SELECT file_path FROM project_spec_files WHERE project_id = $1 AND lower(filename) = 'changelog.md' AND coalesce(rel_dir,'') = ''",
    [childId],
  )).rows[0] as { file_path: string } | undefined;
  let existing: string | null = null;
  if (row) { try { existing = await fsp.readFile(row.file_path, "utf-8"); } catch { existing = null; } }
  const base = (existing && lastReleasedVersion(existing)) ?? "1.0.0";
  const version = bumpSemver(base, opts.compat);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const released = releaseChangelog(existing, version, date, `Evolução aceita — ${opts.title}`);
  let changelogPath: string | null = null;
  if (row) {
    await fsp.writeFile(row.file_path, released, "utf-8");
    await db.query("UPDATE project_spec_files SET content_sha256=$1 WHERE project_id=$2 AND lower(filename)='changelog.md' AND coalesce(rel_dir,'')=''", [sha256Hex(Buffer.from(released, "utf-8")), childId]);
    changelogPath = row.file_path;
  } else {
    // Sem CHANGELOG na Bancada (planner não rodou ou humano apagou): cria na raiz da spec.
    const uploadDir = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
    const physical = path.resolve(uploadDir, childId, "CHANGELOG.md");
    await fsp.mkdir(path.dirname(physical), { recursive: true });
    await fsp.writeFile(physical, released, "utf-8");
    await db.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
       VALUES ($1, 'CHANGELOG.md', $2, 'text/markdown', '', false, $3) ON CONFLICT DO NOTHING`,
      [childId, physical, sha256Hex(Buffer.from(released, "utf-8"))],
    );
    changelogPath = physical;
  }
  // Cópia para o código (vai no push): apps/CHANGELOG.md do filho.
  let appsCopy: string | null = null;
  const filesRoot = (process.env.PROJECT_FILES_ROOT ?? process.env.HOST_PROJECT_FILES_ROOT ?? "").trim();
  if (filesRoot) {
    const appsDir = await firstExistingDir(projectRootCandidates(filesRoot, childId, opts.productId).map((r) => path.join(r, "apps")));
    if (appsDir) {
      appsCopy = path.join(appsDir, "CHANGELOG.md");
      await fsp.writeFile(appsCopy, released, "utf-8");
    }
  }
  return { version, changelogPath, appsCopy };
}

/** Passo 3 — pai vira `archived` + `superseded_by`; filho registra `supersedes` + versão. */
export async function supersedeParent(db: Db, childId: string, parentId: string | null, version: string): Promise<boolean> {
  const now = new Date().toISOString();
  await db.query(
    "UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1",
    [childId, JSON.stringify({ supersedes: parentId, evolution_version: version, evolution_accepted_at: now })],
  );
  if (!parentId) return false;
  // Só supersede um pai ACEITO (versão corrente); pai já arquivado/superseded → no-op.
  const r = await db.query(
    "UPDATE projects SET status = 'archived', extra = COALESCE(extra,'{}'::jsonb) || $3::jsonb, updated_at = now() WHERE id = $1 AND status = 'accepted' AND coalesce(extra->>'superseded_by','') = '' RETURNING id",
    [parentId, childId, JSON.stringify({ superseded_by: childId, superseded_at: now, superseded_version: version })],
  ).catch(() => ({ rows: [] as unknown[] }));
  return (r.rows as unknown[]).length > 0;
}

export function evolutionBranchName(versionNumber: number | null | undefined): string {
  return `evolution/v${Math.max(2, Number(versionNumber ?? 2) || 2)}`;
}

/** Repo GitHub da linhagem: o da RAIZ; senão o do pai. */
export async function findLineageRepo(db: Db, childId: string, parentId: string | null): Promise<{ projectId: string; repo_full_name: string; repo_url: string } | null> {
  const root = await resolveLineageRoot(db as never, childId);
  const cands = [root?.id, parentId].filter((x): x is string => Boolean(x) && x !== childId);
  for (const pid of cands) {
    const r = (await db.query("SELECT repo_full_name, repo_url FROM project_github_repos WHERE project_id = $1", [pid])).rows[0] as { repo_full_name: string; repo_url: string } | undefined;
    if (r?.repo_full_name) return { projectId: pid, repo_full_name: r.repo_full_name, repo_url: r.repo_url };
  }
  return null;
}

/** Corpo do PR: resumo do plano + RFCs + seção liberada do CHANGELOG. */
export async function buildPullRequestBody(db: Db, childId: string, version: string, extra: Record<string, unknown>): Promise<string> {
  const plan = (extra.evolution_plan as Record<string, unknown> | undefined) ?? {};
  const rfcs = (extra.evolution_rfcs as string[] | undefined) ?? (plan.rfcs as string[] | undefined) ?? [];
  const lines = [
    `## Evolução v${version} — gerada pelo Zentriz Genesis (Bancada → Fábrica)`,
    "",
    typeof plan.summary === "string" && plan.summary ? plan.summary : (typeof extra.evolution_request === "string" ? String(extra.evolution_request).slice(0, 1500) : ""),
    "",
    `**Compatibilidade:** ${String(extra.evolution_compat ?? "minor").toUpperCase()}`,
    rfcs.length ? `\n**RFCs:**\n${rfcs.map((r) => `- \`${r}\``).join("\n")}` : "",
    "",
  ];
  const row = (await db.query(
    "SELECT file_path FROM project_spec_files WHERE project_id = $1 AND lower(filename) = 'changelog.md' AND coalesce(rel_dir,'') = ''", [childId],
  )).rows[0] as { file_path: string } | undefined;
  if (row) {
    try {
      const cl = await fsp.readFile(row.file_path, "utf-8");
      const i = cl.indexOf(`## [${version}]`);
      if (i >= 0) {
        const rest = cl.slice(i);
        const next = rest.slice(1).search(/^## \[/m);
        lines.push("### CHANGELOG", "", (next < 0 ? rest : rest.slice(0, next + 1)).trim());
      }
    } catch { /* sem changelog no corpo */ }
  }
  lines.push("", "_Gate de escopo (RFC `files_allowed`), símbolos preservados e QA rodaram na fábrica; revise o diff antes do merge em `dev`._");
  return lines.filter((l) => l !== undefined).join("\n");
}

export function hasGitDir(appsDir: string): boolean {
  try { return fs.existsSync(path.join(appsDir, ".git")); } catch { return false; }
}

/**
 * Orquestra o aceite de uma evolução. Devolve `false` (sem efeito) se o projeto NÃO é evolução —
 * o chamador segue o fluxo normal (`pushProjectToGitHub`). Best-effort: nunca lança.
 */
export async function runEvolutionAcceptFlow(db: Db, childId: string): Promise<boolean> {
  const row = (await db.query(
    "SELECT id, title, product_id, parent_project_id, version_number, extra FROM projects WHERE id = $1", [childId],
  )).rows[0] as { id: string; title: string; product_id: string | null; parent_project_id: string | null; version_number: number | null; extra: Record<string, unknown> | null } | undefined;
  if (!row || row.extra?.evolution !== true) return false;
  const extra = row.extra ?? {};
  const compatRaw = String(extra.evolution_compat ?? "minor").toLowerCase();
  const compat: Compat = compatRaw === "major" || compatRaw === "patch" ? compatRaw : "minor";
  const parentId = (extra.evolution_parent_id as string | undefined) ?? row.parent_project_id ?? null;
  const title = row.title.replace(/ — Evolução v\d+$/i, "");

  const log = async (msg: string) => {
    await db.query(
      "INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1, 'system', 'system', 'step', $2)",
      [childId, msg],
    ).catch(() => {});
  };

  let version = "?";
  try {
    const fin = await finalizeEvolutionChangelog(db, childId, { compat, title, productId: row.product_id });
    version = fin.version;
    await log(`📦 CHANGELOG fechado como v${version} (${compat.toUpperCase()})${fin.appsCopy ? " e copiado para apps/CHANGELOG.md" : ""}.`);
  } catch (e) {
    await log(`⚠️ Não foi possível versionar o CHANGELOG: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Push do código. A supersessão do pai SÓ acontece se o código foi publicado (ou se o tenant não
  // publica de forma alguma — sem GitHub App): pai arquivado sem código publicado = "sumiu meu
  // projeto" com a versão corrente invisível no repo. Falha real → supersessão ADIADA (flag).
  let pushOk = false;
  try {
    const { pushEvolutionToGitHub } = await import("./githubPush.js");
    const body = await buildPullRequestBody(db, childId, version, { ...extra, evolution_compat: compat });
    const push = await pushEvolutionToGitHub(childId, { versionLabel: version, prBody: body, title });
    pushOk = push.ok || push.mode === "skipped" || push.mode === "fallback_new_repo";
    if (!pushOk) await log(`⚠️ Publicação da evolução não concluída (${push.error ?? "erro"}). Supersessão da versão anterior ADIADA até o push ser reprocessado.`);
  } catch (e) {
    await log(`⚠️ Publicação da evolução falhou: ${e instanceof Error ? e.message : String(e)}. Supersessão da versão anterior ADIADA.`);
  }

  if (!pushOk) {
    await db.query(
      "UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1",
      [childId, JSON.stringify({ evolution_push_pending: true, evolution_version: version })],
    ).catch(() => {});
    return true;
  }

  try {
    const superseded = await supersedeParent(db, childId, parentId, version);
    await log(superseded
      ? `♻️ Versão anterior arquivada (superseded_by → esta evolução). Esta é a versão corrente v${version}.`
      : `ℹ️ Versão anterior não alterada (já arquivada/superseded ou inexistente). Esta é v${version}.`);
  } catch (e) {
    await log(`⚠️ Supersessão do pai falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}
