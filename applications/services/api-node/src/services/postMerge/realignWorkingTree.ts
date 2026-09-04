/**
 * realignWorkingTree.ts — Bloco 4 (M3): após o merge da evolução em `dev`, realinha a working tree
 * LOCAL do filho (a que o Deadpool usa como `repo_dir`) para `dev`. Roda na API (que tem `git`; o
 * runner não), atrás da flag `EVOLUTION_POST_MERGE_REALIGN` (checada pelo orquestrador de hooks).
 *
 * Segurança / robustez (GAPs 8/9/14):
 *  • NUNCA `reset --hard` sobre árvore suja: se `git status --porcelain` não está vazio, ou o HEAD é
 *    `deadpool/<id>` (Deadpool em trabalho) — `deferred_dirty`, sem tocar nada (re-tentável).
 *  • Token ESCOPADO ao repo, `contents:read`, `requireScoped:true` (recusa PAT global — cross-tenant);
 *    autenticação só no header do fetch, jamais persistida em `.git/config`.
 *  • Após squash, `evolution/vN` local não é ancestral de `dev` → `fetchAndResetBranch` usa
 *    `checkout -B dev` + `reset --hard origin/dev` (alinhamento controlado).
 *  • Idempotente: grava `evolution_realign_state="done"` uma vez; re-execução com estado `done` é no-op.
 * Best-effort: nunca lança para fora (o merge já aconteceu e não pode ser desfeito por um hook).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Pool } from "pg";
import { getInstallationTokenForClone, repoShortName } from "../github.js";
import { fetchAndResetBranch, isGitAvailable } from "../githubPush.js";

const execFileAsync = promisify(execFile);
type Db = Pick<Pool, "query">;

const PROJECT_FILES_ROOT = (process.env.PROJECT_FILES_ROOT ?? "/shared/uploads").trim();

type RealignState = "done" | "deferred_dirty" | "skipped_no_repo" | "skipped_no_gitdir" | "blocked_permission" | "failed";

async function persist(db: Db, childId: string, fields: Record<string, unknown>): Promise<void> {
  await db.query(
    "UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1",
    [childId, JSON.stringify(fields)],
  ).catch(() => {});
}
async function logDialogue(db: Db, childId: string, msg: string): Promise<void> {
  await db.query(
    "INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1, 'system', 'system', 'step', $2)",
    [childId, msg],
  ).catch(() => {});
}
function done(db: Db, childId: string, state: RealignState, human: string, extra: Record<string, unknown> = {}): Promise<void> {
  return persist(db, childId, { evolution_realign_state: state, evolution_realign_at: new Date().toISOString(), ...extra })
    .then(() => logDialogue(db, childId, human));
}

/**
 * Realinha a árvore local do filho para `dev`. `mergeSha` (quando conhecido) é verificado como
 * ancestral do novo HEAD (squash → o merge é o topo de `dev`; outros merges depois → descendente).
 */
export async function realignAfterMerge(db: Db, childId: string, mergeSha?: string): Promise<void> {
  const row = (await db.query(
    `SELECT c.extra, r.repo_full_name, gi.installation_id, gi.revoked_at
       FROM projects c
       LEFT JOIN project_github_repos r ON r.project_id = c.id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = c.tenant_id
      WHERE c.id = $1`,
    [childId],
  )).rows[0] as {
    extra: Record<string, unknown> | null;
    repo_full_name: string | null;
    installation_id: number | string | null;
    revoked_at: string | null;
  } | undefined;
  if (!row) return;
  const extra = row.extra ?? {};
  if (extra.evolution_realign_state === "done") return; // idempotente

  if (!row.repo_full_name) return done(db, childId, "skipped_no_repo", "ℹ️ Realinhamento pós-merge pulado: projeto sem repositório publicado.");
  const installationId = row.installation_id != null ? Number(row.installation_id) : null;
  if (!installationId || row.revoked_at) {
    return done(db, childId, "blocked_permission", "⚠️ Realinhamento pós-merge não realizado: GitHub App do tenant ausente ou revogado.");
  }

  const localPath = join(PROJECT_FILES_ROOT, childId, "apps");
  if (!(await isGitAvailable())) return done(db, childId, "failed", "⚠️ Realinhamento pós-merge não realizado: binário `git` ausente no runtime da API.");

  const git = (args: string[]) => execFileAsync("git", ["-C", localPath, ...args], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });

  // Pré-checagens (GAP 9): só realinhamos árvore LIMPA e num branch esperado (nunca sobre trabalho do Deadpool).
  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return done(db, childId, "skipped_no_gitdir", "ℹ️ Realinhamento pós-merge pulado: a pasta local não é uma working tree git (sem git-link).");
  }
  let currentBranch = "";
  try {
    const [{ stdout: st }, { stdout: br }] = await Promise.all([
      git(["status", "--porcelain"]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    currentBranch = br.trim();
    const evolutionBranch = String(extra.evolution_branch ?? "");
    const branchOk = currentBranch === "dev" || (evolutionBranch !== "" && currentBranch === evolutionBranch);
    if (st.trim() !== "" || !branchOk) {
      return persist(db, childId, { evolution_realign_state: "deferred_dirty", evolution_realign_head: null })
        .then(() => logDialogue(db, childId,
          `⏸️ Realinhamento pós-merge adiado: a árvore local não está limpa ou o HEAD ('${currentBranch || "?"}') não é 'dev'/'${evolutionBranch || "evolution/vN"}' (possível trabalho do Auto Care em andamento). Será re-tentado.`));
    }
  } catch (e) {
    return done(db, childId, "failed", `⚠️ Realinhamento pós-merge falhou nas pré-checagens: ${e instanceof Error ? e.message : String(e)}.`);
  }

  // Token escopado (contents:read, requireScoped → recusa PAT). Ausência de App → não-fatal.
  let token: string;
  try {
    token = await getInstallationTokenForClone(installationId, {
      repositoryNames: [repoShortName(row.repo_full_name)],
      permissions: { contents: "read" },
      requireScoped: true,
    });
  } catch (e) {
    return done(db, childId, "blocked_permission", `⚠️ Realinhamento pós-merge não realizado: não foi possível obter token escopado (${e instanceof Error ? e.message : String(e)}).`);
  }

  const aligned = await fetchAndResetBranch({ localPath, branch: "dev", token });
  if (!aligned.ok) {
    return done(db, childId, "failed", `⚠️ Realinhamento pós-merge falhou ao alinhar 'dev': ${aligned.error}.`);
  }

  // Verificação (não-bloqueante): o merge (squash) deve ser o topo de 'dev' ou um ancestral do HEAD.
  let mergeMatches: boolean | null = null;
  if (mergeSha && aligned.head) {
    if (aligned.head === mergeSha) mergeMatches = true;
    else {
      mergeMatches = await git(["merge-base", "--is-ancestor", mergeSha, "HEAD"]).then(() => true).catch(() => false);
    }
  }
  await done(db, childId, "done",
    `✅ Working tree local realinhada para 'dev'${aligned.head ? ` (${aligned.head.slice(0, 8)})` : ""}. O Auto Care passa a operar sobre 'dev'.`,
    { evolution_realign_head: aligned.head ?? null, evolution_realign_merge_matches: mergeMatches });
}
