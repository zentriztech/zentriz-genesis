/**
 * evolutionMerge.ts — Bloco 4 (M1): merge automático do PR `evolution/vN → dev`.
 *
 * Princípio (plano §3.1): o merge é um passo ADICIONAL e OPCIONAL do aceite; nunca condiciona o
 * push nem a supersessão (que já funcionam). Cada saída é um ESTADO TERMINAL legível gravado em
 * `extra.evolution_merge_state`, com ação inversa manual visível no painel. Best-effort: nunca lança
 * (o chamador — aceite/republish/observador — não pode falhar por causa do merge).
 *
 * Pré-condições determinísticas, NESTA ordem (a primeira que falha define o estado; as baratas antes
 * de tocar a rede). `force` (rota manual, humano com confirmação) ignora as travas de POLÍTICA
 * (flag, compat, regressões, sem-testes) — nunca as travas de REALIDADE do GitHub (conflito,
 * proteção, permissão, head movido) nem o fail-closed sem evidência de PASS_TO_PASS.
 *
 * Segurança: `requireApp:true` nas primitivas do GitHub (recusa o PAT global — cross-tenant, GAP 4);
 * `sha` = head empurrado (409 se alguém empurrou no meio — GAP 2); claim atômico do estado `merging`
 * (GAP 3); instalação sempre do tenant do projeto com `revoked_at IS NULL` (fail-closed).
 */
import type { Pool } from "pg";
import { resolveLineageRoot } from "./lineage.js";
import { readEvolutionCheckpoint } from "./evolutionState.js";
import { getPullRequest, mergePullRequest, updatePullRequestBranch } from "./github.js";

type Db = Pick<Pool, "query">;

export type MergeState =
  | "merged"
  | "skipped_flag"
  | "skipped_no_pr"
  | "blocked_permission"
  | "blocked_conflict"
  | "blocked_protection"
  | "blocked_checks"
  | "blocked_major"
  | "blocked_compat_implicit"
  | "blocked_regressions"
  | "blocked_no_tests"
  | "blocked_no_evidence"
  | "blocked_head_moved"
  | "blocked_base_mismatch"
  | "failed";

export interface TryAutoMergeResult {
  state: MergeState;
  sha?: string;
  detail?: string;
  acceptedPermissions?: string;
}

type Compat = "patch" | "minor" | "major";
const COMPAT_RANK: Record<Compat, number> = { patch: 1, minor: 2, major: 3 };

function flagOn(name: string, def: "on" | "off" = "off"): boolean {
  return (process.env[name] ?? def).trim().toLowerCase() === "on";
}

/** Método de merge configurado (squash|merge). Qualquer valor inválido cai em squash (§5.4). */
function configuredMethod(): "squash" | "merge" {
  const m = (process.env.EVOLUTION_AUTO_MERGE_METHOD ?? "squash").trim().toLowerCase();
  return m === "merge" ? "merge" : "squash";
}

/** Teto de compatibilidade automática (patch|minor); `major` nunca é automático. */
function maxAutoCompat(): Compat {
  const c = (process.env.EVOLUTION_AUTO_MERGE_MAX_COMPAT ?? "minor").trim().toLowerCase();
  return c === "patch" ? "patch" : "minor";
}

// Backoff (segundos) enquanto `mergeable === null` — máx. 5 tentativas (GAP 5 / 18). Seam de teste
// para não segurar os testes por ~60s reais (default = setTimeout; testes injetam um no-op).
const NULL_BACKOFF_S = [2, 4, 8, 16, 30];
let _sleepForTests: ((ms: number) => Promise<void>) | null = null;
export function __setMergeSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  _sleepForTests = fn;
}
function sleep(ms: number): Promise<void> {
  if (_sleepForTests) return _sleepForTests(ms);
  return new Promise((r) => setTimeout(r, ms));
}

/** `commit_title` vem do título do projeto (controlado pelo usuário) — remove controles/quebras (GAP 17). */
function sanitizeTitle(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 250);
}

async function persistExtra(db: Db, projectId: string, fields: Record<string, unknown>): Promise<void> {
  await db.query(
    "UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1",
    [projectId, JSON.stringify(fields)],
  ).catch(() => {});
}

async function logDialogue(db: Db, projectId: string, msg: string): Promise<void> {
  await db.query(
    "INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1, 'system', 'system', 'step', $2)",
    [projectId, msg],
  ).catch(() => {});
}

/** Grava o estado terminal (blocked_x / merged / failed) em `extra` + diálogo, e devolve o resultado. */
async function finish(db: Db, childId: string, res: TryAutoMergeResult, humanMsg: string): Promise<TryAutoMergeResult> {
  await persistExtra(db, childId, {
    evolution_merge_state: res.state,
    evolution_merge_detail: res.detail ?? null,
    evolution_merge_accepted_permissions: res.acceptedPermissions ?? null,
  });
  await logDialogue(db, childId, humanMsg);
  return res;
}

/**
 * Tenta mergear o PR da evolução. `opts.force` (rota manual com confirmação humana) ignora só as
 * travas de política; `opts.actorUserId` vira o `evolution_merge_actor` (senão "genesis").
 */
export async function tryAutoMergeEvolution(
  db: Db,
  childId: string,
  opts: { force?: boolean; actorUserId?: string } = {},
): Promise<TryAutoMergeResult> {
  const force = opts.force === true;

  // ── Carrega projeto + instalação do tenant (revoked → fail-closed) + repo da linhagem ──
  const row = (await db.query(
    `SELECT p.title, p.version_number, p.extra,
            gi.installation_id, gi.revoked_at,
            r.repo_full_name
       FROM projects p
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
       LEFT JOIN project_github_repos r ON r.project_id = p.id
      WHERE p.id = $1`,
    [childId],
  )).rows[0] as {
    title: string | null;
    version_number: number | null;
    extra: Record<string, unknown> | null;
    installation_id: number | string | null;
    revoked_at: string | null;
    repo_full_name: string | null;
  } | undefined;

  if (!row || row.extra?.evolution !== true) {
    return { state: "skipped_no_pr", detail: "projeto não é uma evolução" };
  }
  const extra = row.extra ?? {};

  // Já mergeado (idempotência do observador/republish): não repetir.
  if (typeof extra.evolution_merged_at === "string" && extra.evolution_merged_at) {
    return { state: "merged", sha: (extra.evolution_merge_sha as string | undefined) ?? undefined };
  }

  // 1. Flag (force ignora só esta).
  if (!force && !flagOn("EVOLUTION_AUTO_MERGE")) {
    return { state: "skipped_flag", detail: "EVOLUTION_AUTO_MERGE desligado" };
  }

  // 2. PR aberto pela App + push resolvido + repo conhecido.
  const prNumber = typeof extra.evolution_pr_number === "number" ? extra.evolution_pr_number : null;
  if (!prNumber || extra.evolution_push_pending === true || !row.repo_full_name) {
    return { state: "skipped_no_pr", detail: "sem número de PR / publicação pendente" };
  }
  const installationId = row.installation_id != null ? Number(row.installation_id) : null;
  if (!installationId || row.revoked_at) {
    return finish(db, childId,
      { state: "blocked_permission", detail: "GitHub App do tenant ausente ou revogado" },
      "⚠️ Merge não realizado: a instalação do GitHub App do tenant está ausente ou foi revogada.");
  }
  const [owner, repo] = row.repo_full_name.split("/");
  if (!owner || !repo) {
    return finish(db, childId, { state: "failed", detail: `repo inválido: ${row.repo_full_name}` },
      `⚠️ Merge não realizado: repositório inválido (${row.repo_full_name}).`);
  }

  // 3. Claim atômico do estado `merging` (GAP 3 — accept + republish + observador ao mesmo tempo).
  const claim = await db.query(
    `UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || '{"evolution_merge_state":"merging"}'::jsonb, updated_at = now()
      WHERE id = $1 AND coalesce(extra->>'evolution_merge_state','') NOT IN ('merging','merged') RETURNING id`,
    [childId],
  );
  if ((claim.rows as unknown[]).length === 0) {
    // Outra tentativa está em curso (ou já mergeou entre o load e o claim) — não duplicar.
    const cur = (await db.query("SELECT extra->>'evolution_merge_state' AS s, extra->>'evolution_merge_sha' AS sha FROM projects WHERE id=$1", [childId])).rows[0] as { s?: string; sha?: string } | undefined;
    if (cur?.s === "merged") return { state: "merged", sha: cur.sha ?? undefined };
    return { state: "failed", detail: "outra tentativa de merge em andamento" };
  }

  // 4. Compatibilidade (política — force ignora).
  const compatRaw = String(extra.evolution_compat ?? "minor").toLowerCase();
  const compat: Compat = compatRaw === "major" || compatRaw === "patch" ? compatRaw : "minor";
  const version = (extra.evolution_version as string | undefined) ?? String(row.version_number ?? "");
  if (!force) {
    if (compat === "major") {
      return finish(db, childId, { state: "blocked_major", detail: "compatibilidade major exige merge manual" },
        "⏸️ Merge automático bloqueado: mudança MAJOR exige confirmação humana. Use \"Mergear agora\" no painel.");
    }
    if (extra.evolution_compat_explicit !== true) {
      return finish(db, childId, { state: "blocked_compat_implicit", detail: "compatibilidade não declarada (default silencioso 'minor')" },
        "⏸️ Merge automático bloqueado: a compatibilidade não foi declarada no RFC (obrigatória para merge automático).");
    }
    if (COMPAT_RANK[compat] > COMPAT_RANK[maxAutoCompat()]) {
      return finish(db, childId, { state: "blocked_major", detail: `compat ${compat} acima do teto ${maxAutoCompat()}` },
        `⏸️ Merge automático bloqueado: compatibilidade ${compat.toUpperCase()} acima do teto configurado (${maxAutoCompat().toUpperCase()}).`);
    }
  }

  // 5. PASS_TO_PASS (fail-closed sem evidência — nem `force` contorna a AUSÊNCIA de evidência).
  const checkpoint = await readEvolutionCheckpoint(childId);
  const baseline = (checkpoint?.evolution_baseline as Record<string, unknown> | null | undefined) ?? null;
  if (!checkpoint || !baseline) {
    return finish(db, childId, { state: "blocked_no_evidence", detail: "checkpoint / baseline PASS_TO_PASS ausente" },
      "⛔ Merge bloqueado: sem evidência de testes (checkpoint do runner ausente). Fail-closed por segurança.");
  }
  const baselineStatus = String((baseline as { status?: unknown }).status ?? "");
  const final = (baseline as { final?: Record<string, unknown> | null }).final ?? null;
  const regressions = Array.isArray((final as { regressions?: unknown[] } | null)?.regressions)
    ? ((final as { regressions?: unknown[] }).regressions as unknown[])
    : [];
  if (baselineStatus === "no_tests") {
    if (!force && !flagOn("EVOLUTION_AUTO_MERGE_ALLOW_NO_TESTS")) {
      return finish(db, childId, { state: "blocked_no_tests", detail: "baseline sem testes" },
        "⏸️ Merge automático bloqueado: a linha de base não tem testes (PASS_TO_PASS vazio). Confirme manualmente se aceitar o risco.");
    }
  } else if (!force) {
    const finalStatus = String((final as { status?: unknown } | null)?.status ?? "");
    if (!final || finalStatus === "error" || regressions.length > 0) {
      return finish(db, childId, { state: "blocked_regressions", detail: regressions.length ? `${regressions.length} regressão(ões)` : "sem resultado final de testes" },
        `⏸️ Merge automático bloqueado: ${regressions.length ? `${regressions.length} regressão(ões) no PASS_TO_PASS` : "sem resultado final de testes (TSK-FULL-TEST não concluído)"}.`);
    }
  }

  // 6. Realidade do GitHub (nunca contornada por `force`).
  let pr = await getPullRequest(installationId, { owner, repo, number: prNumber });
  if (!pr.ok) {
    if (pr.status === 403) {
      return finish(db, childId, { state: "blocked_permission", detail: pr.error },
        "⚠️ Merge não realizado: a GitHub App não tem permissão para ler/mergear o PR (conceda 'Pull requests: Read & write').");
    }
    return finish(db, childId, { state: "failed", detail: pr.error },
      `⚠️ Merge não realizado: falha ao consultar o PR (${pr.error}).`);
  }
  if (pr.merged) {
    // Alguém (humano/observador) mergeou entre o claim e agora.
    return recordMergedAndHooks(db, childId, pr.mergeCommitSha ?? "", configuredMethod(), opts.actorUserId ?? "genesis", version, row.title ?? childId);
  }
  if (pr.baseRef !== "dev") {
    return finish(db, childId, { state: "blocked_base_mismatch", detail: `base do PR é '${pr.baseRef}', esperado 'dev'` },
      `⚠️ Merge não realizado: o PR aponta para '${pr.baseRef}' e não para 'dev'.`);
  }
  const expectedHead = (extra.evolution_head_sha as string | undefined) ?? "";
  if (expectedHead && pr.headSha && pr.headSha !== expectedHead) {
    return finish(db, childId, { state: "blocked_head_moved", detail: `head ${pr.headSha.slice(0, 8)} ≠ empurrado ${expectedHead.slice(0, 8)}` },
      "⚠️ Merge não realizado: o head da evolução mudou após a publicação (alguém empurrou no branch). Revise antes de mergear.");
  }

  // Resolve mergeability: poll enquanto null; trata `behind` com update-branch 1×.
  let mergeSha = pr.headSha;
  let didUpdateBranch = false;
  for (let attempt = 0; ; attempt++) {
    if (pr.mergeable === null) {
      if (attempt >= NULL_BACKOFF_S.length) {
        return finish(db, childId, { state: "blocked_checks", detail: "mergeability não computada a tempo" },
          "⚠️ Merge não realizado: o GitHub não computou a mergeabilidade a tempo. Tente novamente em instantes.");
      }
      await sleep(NULL_BACKOFF_S[attempt] * 1000);
      const next = await getPullRequest(installationId, { owner, repo, number: prNumber });
      if (!next.ok) {
        return finish(db, childId, { state: "failed", detail: next.error },
          `⚠️ Merge não realizado: falha ao reconsultar o PR (${next.error}).`);
      }
      pr = next;
      if (pr.merged) return recordMergedAndHooks(db, childId, pr.mergeCommitSha ?? "", configuredMethod(), opts.actorUserId ?? "genesis", version, row.title ?? childId);
      mergeSha = pr.headSha;
      continue;
    }
    const st = pr.mergeableState;
    if (st === "clean" || (st === "has_hooks" && flagOn("EVOLUTION_AUTO_MERGE_ALLOW_HAS_HOOKS"))) break;
    if (st === "behind" && !didUpdateBranch) {
      didUpdateBranch = true;
      const upd = await updatePullRequestBranch(installationId, { owner, repo, number: prNumber, expectedHeadSha: pr.headSha });
      if (!upd.ok) {
        return finish(db, childId, { state: "blocked_protection", detail: `update-branch falhou: ${upd.error ?? upd.status}` },
          "⚠️ Merge não realizado: o branch está atrás de 'dev' e a atualização automática falhou. Atualize o PR no GitHub.");
      }
      // update-branch move o head → reconsultar e usar o NOVO head no merge (não re-checar head_moved: nós o movemos).
      const after = await getPullRequest(installationId, { owner, repo, number: prNumber });
      if (!after.ok) {
        return finish(db, childId, { state: "failed", detail: after.error },
          `⚠️ Merge não realizado: falha ao reconsultar após atualizar o branch (${after.error}).`);
      }
      pr = after;
      if (pr.merged) return recordMergedAndHooks(db, childId, pr.mergeCommitSha ?? "", configuredMethod(), opts.actorUserId ?? "genesis", version, row.title ?? childId);
      mergeSha = pr.headSha;
      continue;
    }
    if (st === "dirty") {
      return finish(db, childId, { state: "blocked_conflict", detail: "conflito com 'dev'" },
        "⚠️ Merge não realizado: há conflito com 'dev'. Resolva o conflito no GitHub.");
    }
    if (st === "blocked") {
      return finish(db, childId, { state: "blocked_protection", detail: "proteção de branch não satisfeita" },
        "⚠️ Merge não realizado: as regras de proteção do branch 'dev' não foram satisfeitas.");
    }
    // unstable | draft | unknown | has_hooks (sem flag)
    return finish(db, childId, { state: "blocked_checks", detail: `mergeable_state=${st}` },
      `⚠️ Merge não realizado: o PR está em '${st}' (checks pendentes/rascunho). Aguarde ou verifique no GitHub.`);
  }

  // 7. Merge (sha = head empurrado; 409 se moveu — GAP 2).
  let method = configuredMethod();
  let commitTitle = sanitizeTitle(`Evolução v${version || pr.headSha.slice(0, 7)} — ${row.title ?? childId}`);
  let commitMessage = "";
  try {
    const { buildPullRequestBody } = await import("./evolutionAccept.js");
    commitMessage = (await buildPullRequestBody(db, childId, version, { ...extra, evolution_compat: compat })).slice(0, 4000);
  } catch { commitMessage = ""; }

  let merge = await mergePullRequest(installationId, { owner, repo, number: prNumber, method, sha: mergeSha, commitTitle, commitMessage });
  if (!merge.ok && merge.status === 405 && method === "squash" && /method|not allowed|disabled|squash/i.test(merge.error)) {
    // Repo desabilitou squash → uma tentativa com merge commit (§1.1 / §3.1).
    method = "merge";
    merge = await mergePullRequest(installationId, { owner, repo, number: prNumber, method, sha: mergeSha, commitTitle, commitMessage });
  }
  if (!merge.ok) {
    if (merge.status === 403) {
      return finish(db, childId, { state: "blocked_permission", detail: merge.error, acceptedPermissions: merge.acceptedPermissions },
        `⚠️ Merge não realizado: a GitHub App não tem permissão de merge${merge.acceptedPermissions ? ` (falta: ${merge.acceptedPermissions})` : ""}. Conceda 'Pull requests: Read & write' e aprove na instalação.`);
    }
    if (merge.status === 405) {
      return finish(db, childId, { state: "blocked_protection", detail: merge.error },
        "⚠️ Merge não realizado: o GitHub recusou o merge (proteção de branch ou método desabilitado).");
    }
    if (merge.status === 409) {
      return finish(db, childId, { state: "blocked_head_moved", detail: merge.error },
        "⚠️ Merge não realizado: o head do PR mudou entre a verificação e o merge. Revise e tente novamente.");
    }
    return finish(db, childId, { state: "failed", detail: merge.error },
      `⚠️ Merge não realizado: ${merge.error}.`);
  }

  return recordMergedAndHooks(db, childId, merge.sha, method, opts.actorUserId ?? "genesis", version, row.title ?? childId);
}

/**
 * Grava o sucesso do merge (idempotente pela chave `evolution_merged_at`), atualiza `sha_dev` da raiz
 * e do filho, registra no diálogo e dispara os hooks pós-merge (itens 2 e 3, cada um com flag própria).
 */
async function recordMergedAndHooks(
  db: Db, childId: string, sha: string, method: string, actor: string, version: string, title: string,
): Promise<TryAutoMergeResult> {
  const now = new Date().toISOString();
  await persistExtra(db, childId, {
    evolution_merged_at: now,
    evolution_merge_sha: sha || null,
    evolution_merge_method: method,
    evolution_merge_state: "merged",
    evolution_merge_actor: actor,
    evolution_merge_detail: null,
    evolution_merge_accepted_permissions: null,
  });
  // sha_dev da RAIZ (o merge é no repo da linhagem) e do próprio filho.
  if (sha) {
    try {
      const root = await resolveLineageRoot(db as never, childId);
      const ids = [...new Set([childId, root?.id].filter((x): x is string => Boolean(x)))];
      await db.query("UPDATE project_github_repos SET sha_dev = $2, pushed_at = now() WHERE project_id = ANY($1)", [ids, sha]).catch(() => {});
    } catch { /* best-effort */ }
  }
  await logDialogue(db, childId, `✅ Evolução v${version || "?"} mergeada em 'dev' (${method}, ${actor})${sha ? ` — ${sha.slice(0, 8)}` : ""}. "${title}".`);

  // Hooks pós-merge (item 2 redeploy, item 3 Auto Care) — best-effort, cada um atrás da sua flag.
  try {
    const { runPostMergeHooks } = await import("./postMerge/runPostMergeHooks.js");
    await runPostMergeHooks(db, childId, { mergeSha: sha });
  } catch (e) {
    await logDialogue(db, childId, `⚠️ Hooks pós-merge falharam (não bloqueiam o merge): ${e instanceof Error ? e.message : String(e)}`);
  }
  return { state: "merged", sha: sha || undefined };
}
