/**
 * cloudDeploy.ts — Item 2 (corrigido). Deploy na nuvem do TENANT via pipeline GitHub.
 *
 * Modelo (Jean, verbatim):
 *   "quem realmente faz o deploy é o github" — o GitHub Actions EXECUTA o deploy.
 *   "Genesis empurra e monitora pois se o github falhar com erro de escrita dos arquivos
 *    ele corrige e reenvia, ou seja a responsabilidade é nossa até o github retornar OK."
 *
 * Papel do Genesis:
 *   1. prepara — sincroniza os secrets da CONEXÃO ESCOLHIDA + commita o workflow (formato ×
 *      nuvem) na branch default (dispatchável) e na branch de código;
 *   2. dispara — workflow_dispatch com o id do deploy (correlação via run-name);
 *   3. MONITORA e AUTO-CURA — o worker (reconcileCloudDeployments) acompanha o run; se a
 *      escrita dos arquivos falhar → reenvia; se o run falhar → re-dispara (até MAX_ATTEMPTS);
 *      só marca 'deployed' no success. Demo com prazo → teardown no vencimento.
 */

import { pool } from "../../db/client.js";
import {
  commitAndPush, dispatchWorkflow, listRecentWorkflowRuns, getWorkflowRunStatus, getBranchSha,
  type WorkflowRunInfo,
} from "../github.js";
import { resolveLineageRoot } from "../lineage.js";
import { getCloudConnection, syncSecretsToGitHub, removeSyncedSecrets } from "../cloudConnector.js";
import {
  getCloudDeployWorkflow, getCloudTeardownWorkflow, deployWorkflowFileName, deployWorkflowPath,
  teardownWorkflowFileName, teardownWorkflowPath, isFormatViable,
  type DeployFormat, type CloudProvider,
} from "./deployTargets.js";

export const MAX_DEPLOY_ATTEMPTS = 4;

export type DeployTriggerKind = "manual" | "evolution_merge" | "rollback";

export interface StartCloudDeployParams {
  projectId: string;
  tenantId: string;
  userId: string | null;
  connectionId: string;
  format: DeployFormat;
  /** null = permanente (produção). Date = demo com teardown automático. */
  expiresAt: Date | null;
  consentedTeardown: boolean;
  // Bloco 4 (M5): encadeamento por linhagem / redeploy pós-merge / rollback por SHA.
  /** Sobrescreve a branch de deploy (hook de redeploy pós-merge usa "dev"). Default = decidido por estado. */
  branch?: string;
  /** SHA exato a deployar (redeploy pós-merge = merge_sha; rollback = SHA do deploy alvo). Default: HEAD da branch no dispatch. */
  gitSha?: string | null;
  /** Origem do deploy — grava trigger_kind (default 'manual'). */
  triggerKind?: DeployTriggerKind;
  /** Deploy anterior da linhagem que este substitui (marca o reverso superseded_by_deployment_id). */
  supersedesId?: string | null;
}

export type StartCloudDeployResult =
  | { ok: true; deploymentId: string; provider: CloudProvider; format: DeployFormat; branch: string }
  | { ok: false; code: string; message: string };

interface RepoCtx {
  owner: string;
  repo: string;
  repoFullName: string;
  defaultBranch: string;
  deployBranch: string;   // branch onde o código gerado vive (checkout do run)
  installationId: number;
}

async function loadRepoCtx(projectId: string): Promise<RepoCtx | null> {
  const res = await pool.query(
    `SELECT r.repo_name, r.repo_full_name, r.default_branch,
            gi.installation_id, gi.github_login, p.extra
       FROM project_github_repos r
       JOIN projects p ON p.id = r.project_id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
      WHERE r.project_id = $1`,
    [projectId],
  );
  const row = res.rows[0];
  if (!row || !row.installation_id || !row.github_login) return null;
  // Bloco 4 (M5) — branch de deploy por ESTADO: uma evolução ANTES do merge deploya a própria
  // branch evolution/vN (pré-visualização in-place — a UI avisa que substitui a versão corrente
  // na nuvem pela vN ainda não mergeada). Depois do merge (ou projeto normal) → 'dev'.
  const extra = (row.extra as Record<string, unknown> | null) ?? {};
  const isUnmergedEvolution = extra.evolution === true && !extra.evolution_merged_at;
  const deployBranch = isUnmergedEvolution
    ? ((extra.evolution_branch as string | undefined) ?? "dev")
    : "dev";
  return {
    owner: row.github_login as string,
    repo: row.repo_name as string,
    repoFullName: (row.repo_full_name as string) ?? `${row.github_login}/${row.repo_name}`,
    defaultBranch: (row.default_branch as string) ?? "main",
    deployBranch, // código gerado é empurrado p/ dev (githubPush.ts); evolução não-mergeada = evolution/vN
    installationId: Number(row.installation_id),
  };
}

async function loadProjectType(projectId: string): Promise<string | null> {
  const res = await pool.query("SELECT extra FROM projects WHERE id = $1", [projectId]);
  const extra = (res.rows[0]?.extra as Record<string, unknown> | null) ?? {};
  return (extra.project_type as string | undefined) ?? null;
}

/**
 * Cria a linha de deploy (pending), valida, e agenda a 1ª tentativa de push+dispatch.
 * Retorna rápido (202); o worker garante a entrega até o GitHub retornar OK.
 */
export async function startCloudDeploy(p: StartCloudDeployParams): Promise<StartCloudDeployResult> {
  const repo = await loadRepoCtx(p.projectId);
  if (!repo) {
    return { ok: false, code: "REPO_REQUIRED",
      message: "O projeto ainda não tem repositório GitHub (ou o tenant não instalou o GitHub App). Publique o código primeiro." };
  }
  const conn = await getCloudConnection(p.tenantId, p.connectionId);
  if (!conn) {
    return { ok: false, code: "CONNECTION_NOT_FOUND",
      message: "Conexão de cloud não encontrada para este tenant." };
  }
  const projectType = await loadProjectType(p.projectId);
  if (!isFormatViable(projectType, conn.provider, p.format)) {
    return { ok: false, code: "INVALID_FORMAT",
      message: `Formato '${p.format}' não é viável para projeto '${projectType ?? "?"}' em ${conn.provider.toUpperCase()}.` };
  }

  // Bloco 4 (M5): identidade da linhagem (recursos nomeados pela raiz) + encadeamento/rastreio.
  const branch = p.branch ?? repo.deployBranch;
  const triggerKind: DeployTriggerKind = p.triggerKind ?? "manual";
  const lineageRoot = await resolveLineageRoot(pool, p.projectId).catch(() => null);
  const lineageRootId = lineageRoot?.id ?? p.projectId;

  const ins = await pool.query(
    `INSERT INTO cloud_deployments
       (project_id, tenant_id, connection_id, provider, deploy_format, branch, repo_full_name,
        workflow_file, status, expires_at, consented_teardown, created_by,
        git_sha, lineage_root_id, trigger_kind, supersedes_deployment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [p.projectId, p.tenantId, p.connectionId, conn.provider, p.format, branch,
     repo.repoFullName, deployWorkflowFileName(), p.expiresAt, p.consentedTeardown, p.userId,
     p.gitSha ?? null, lineageRootId, triggerKind, p.supersedesId ?? null],
  );
  const deploymentId = ins.rows[0].id as string;

  // Encadeamento: marca o deploy anterior como substituído por este (reverso de supersedes).
  // teardownExpired passa a ignorar os substituídos — os recursos agora pertencem a esta versão.
  if (p.supersedesId) {
    await pool.query(
      "UPDATE cloud_deployments SET superseded_by_deployment_id=$2, updated_at=now() WHERE id=$1",
      [p.supersedesId, deploymentId],
    ).catch((e) => console.warn(`[CloudDeploy] mark superseded ${p.supersedesId} failed:`, e));
  }

  // 1ª tentativa fora do caminho da request (não bloqueia o 202). Falha → worker cura.
  setImmediate(() => {
    runDeployAttempt(deploymentId).catch((err) => {
      console.warn(`[CloudDeploy] eager attempt ${deploymentId} failed (worker will heal):`, err);
    });
  });

  return { ok: true, deploymentId, provider: conn.provider, format: p.format, branch };
}

/**
 * Uma tentativa de PREPARAR+DISPARAR: sync de secrets → commit do workflow na branch default
 * (dispatchável) e na branch de código → workflow_dispatch. Idempotente: chamada tanto pelo
 * eager path quanto pelo worker (auto-cura de "erro de escrita dos arquivos"). Deixa a linha
 * em 'dispatching' no sucesso; em 'pending' (com last_error) no erro — p/ o worker reenviar.
 */
export async function runDeployAttempt(deploymentId: string): Promise<void> {
  const row = (await pool.query(
    `SELECT d.*, r.repo_name, r.default_branch, gi.installation_id, gi.github_login
       FROM cloud_deployments d
       JOIN project_github_repos r ON r.project_id = d.project_id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = d.tenant_id
      WHERE d.id = $1`,
    [deploymentId],
  )).rows[0];
  if (!row) return;
  if (row.status !== "pending") return; // já avançou (ou outro runner já fez o claim)
  if (!row.installation_id || !row.github_login) {
    await pool.query(
      "UPDATE cloud_deployments SET status='failed', last_error=$2, updated_at=now() WHERE id=$1",
      [deploymentId, "GitHub App installation ausente"]);
    return;
  }

  // Claim ATÔMICO da transição pending→dispatching: um único runner vence, mesmo com o eager
  // path e um (ou mais) ticks do worker concorrendo. Incrementa attempts e carimba dispatched_at
  // AQUI para que a correlação do run só case com runs criados a partir deste instante (evita
  // fixar o run ANTIGO que falhou, quando o run novo ainda não foi registrado pelo GitHub).
  const claim = await pool.query(
    `UPDATE cloud_deployments
        SET status='dispatching', attempts = attempts + 1, dispatched_at = now(),
            last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING attempts`,
    [deploymentId],
  );
  if (claim.rowCount === 0) return; // outro runner pegou primeiro
  const claimedAttempts = Number(claim.rows[0].attempts);

  const owner = row.github_login as string;
  const repoName = row.repo_name as string;
  const installationId = Number(row.installation_id);
  const provider = row.provider as CloudProvider;
  const format = row.deploy_format as DeployFormat;
  const deployBranch = (row.branch as string) ?? "dev";
  const defaultBranch = (row.default_branch as string) ?? "main";

  try {
    // (a) sync secrets da conexão ESCOLHIDA
    await syncSecretsToGitHub(row.tenant_id as string, owner, repoName, installationId, row.connection_id as string);

    // (b) commit do workflow na branch default (p/ ser dispatchável) e na de código
    const content = getCloudDeployWorkflow(provider, format, repoName);
    const branches = defaultBranch === deployBranch ? [deployBranch] : [defaultBranch, deployBranch];
    for (const br of branches) {
      await commitAndPush(installationId, {
        owner, repo: repoName, branch: br,
        message: `ci: genesis deploy workflow (${provider}/${format})`,
        files: [{ path: deployWorkflowPath(), content }],
      });
    }

    // Bloco 4 (M5): resolve o SHA exato a deployar. Já gravado (redeploy pós-merge = merge_sha,
    // rollback = SHA alvo) → usa; senão resolve o HEAD da branch de deploy AGORA e persiste
    // (rastreabilidade + rollback futuro por SHA). Se não resolver, o workflow cai no github.ref.
    let gitSha = (row.git_sha as string | null) ?? null;
    if (!gitSha) {
      gitSha = await getBranchSha(installationId, { owner, repo: repoName, branch: deployBranch });
      if (gitSha) {
        await pool.query(
          "UPDATE cloud_deployments SET git_sha=$2, updated_at=now() WHERE id=$1",
          [deploymentId, gitSha],
        );
      }
    }

    // (c) floor de correlação (maior run_id ANTES do dispatch) + dispatch. Guardar o floor faz a
    // correlação ignorar o run antigo que falhou — sem depender de relógio. (workflow já existe
    // na branch default — garantido acima.)
    const floor = await maxRunId(installationId, owner, repoName, deployBranch);
    const inputs: Record<string, string> = { genesis_deploy_id: deploymentId };
    if (gitSha) inputs.genesis_git_sha = gitSha;
    await dispatchWorkflow(installationId, {
      owner, repo: repoName, workflowFile: deployWorkflowFileName(), ref: deployBranch,
      inputs,
    });
    await pool.query(
      "UPDATE cloud_deployments SET run_id_floor=$2, updated_at=now() WHERE id=$1",
      [deploymentId, floor],
    );

    console.log(`[CloudDeploy] dispatched ${deploymentId} (${provider}/${format}) on ${owner}/${repoName}@${deployBranch} (attempt ${claimedAttempts}, floor ${floor ?? "-"})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "erro de escrita dos arquivos" → volta a pending p/ o worker reenviar, até o teto.
    // attempts já foi incrementado no claim; não incrementar de novo.
    const terminal = claimedAttempts >= MAX_DEPLOY_ATTEMPTS;
    await pool.query(
      `UPDATE cloud_deployments SET status=$2, last_error=$3, updated_at=now() WHERE id=$1`,
      [deploymentId, terminal ? "failed" : "pending", msg],
    );
    console.warn(`[CloudDeploy] attempt ${claimedAttempts}/${MAX_DEPLOY_ATTEMPTS} failed for ${deploymentId}: ${msg}`);
    if (terminal) throw err;
  }
}

const CORRELATE_SKEW_MS = 10_000; // fallback quando run_id_floor é NULL — folga aproximada
// Após este tempo sem run correlacionado, o dispatch é considerado "não gerou run" e o worker
// re-dispara (deploy) ou marca inspeção manual (teardown) — auto-cura de dispatch perdido.
const DISPATCH_RUN_TIMEOUT = "10 minutes";

/** Maior run_id do repo (branch) AGORA — capturado ANTES do dispatch como floor de correlação. */
async function maxRunId(
  installationId: number, owner: string, repo: string, branch: string,
): Promise<number | null> {
  const runs = await listRecentWorkflowRuns(installationId, {
    owner, repo, branch, event: "workflow_dispatch", perPage: 30,
  });
  let max = 0;
  for (const r of runs) if (r.id > max) max = r.id;
  return max || null;
}

/**
 * Casa um run pelo genesis_deploy_id no display_title (o dispatch não retorna o run id). Como o
 * run_id do GitHub é monotônico crescente por repo, aceita SÓ runs com id > run_id_floor (o maior
 * id observado antes do dispatch) — imune a skew de relógio. Sem floor (linhas antigas), cai no
 * time-gate por dispatched_at. Entre os válidos, retorna o de MAIOR id (o mais novo).
 */
function correlateRun(
  runs: WorkflowRunInfo[],
  deploymentId: string,
  dispatchedAt: string | null,
  runIdFloor: number | null,
): WorkflowRunInfo | null {
  const floorMs = dispatchedAt ? new Date(dispatchedAt).getTime() - CORRELATE_SKEW_MS : 0;
  return runs
    .filter((r) => {
      if (!r.displayTitle.includes(deploymentId)) return false;
      // Preferência: floor por run_id (robusto a clock). Fallback: time-gate.
      if (runIdFloor != null) return r.id > runIdFloor;
      return new Date(r.createdAt).getTime() >= floorMs;
    })
    .sort((a, b) => b.id - a.id)[0] ?? null;
}

/**
 * Correlaciona o run e acompanha até completar. success → deployed;
 * failure → re-dispara (até MAX_ATTEMPTS) então failed.
 */
async function pollDeploymentRun(row: Record<string, unknown>): Promise<void> {
  const deploymentId = row.id as string;
  const owner = row.github_login as string;
  const repoName = row.repo_name as string;
  const installationId = Number(row.installation_id);
  const deployBranch = (row.branch as string) ?? "dev";
  const runId = row.run_id ? Number(row.run_id) : null;

  if (!runId) {
    // Ainda em 'dispatching': procurar o run pelo display_title (genesis_deploy_id), MAS só
    // entre runs criados a partir do último dispatch (dispatched_at) — assim uma re-tentativa
    // NÃO fixa o run antigo que falhou enquanto o GitHub ainda não registrou o run novo. Entre
    // os candidatos válidos, escolhe o mais recente.
    const match = correlateRun(
      await listRecentWorkflowRuns(installationId, {
        owner, repo: repoName, branch: deployBranch, event: "workflow_dispatch", perPage: 30,
      }),
      deploymentId,
      row.dispatched_at as string | null,
      row.run_id_floor != null ? Number(row.run_id_floor) : null,
    );
    if (!match) return; // GitHub ainda não registrou o run novo — próximo tick (watchdog cobre timeout)
    await pool.query(
      "UPDATE cloud_deployments SET run_id=$2, run_url=$3, status='running', updated_at=now() WHERE id=$1",
      [deploymentId, match.id, match.htmlUrl],
    );
    return;
  }

  const info = await getWorkflowRunStatus(installationId, { owner, repo: repoName, runId });
  if (!info) return;
  if (info.status !== "completed") return; // ainda rodando

  if (info.conclusion === "success") {
    await pool.query(
      "UPDATE cloud_deployments SET status='deployed', run_url=$2, last_error=NULL, updated_at=now() WHERE id=$1",
      [deploymentId, info.htmlUrl],
    );
    await recordDialogue(row.project_id as string,
      `✅ Deploy concluído pelo GitHub Actions (${row.provider}/${row.deploy_format}). Run: ${info.htmlUrl}`);
    return;
  }

  // Run falhou: auto-cura por re-dispatch até o teto.
  const attempts = Number(row.attempts ?? 0);
  if (attempts >= MAX_DEPLOY_ATTEMPTS) {
    await pool.query(
      "UPDATE cloud_deployments SET status='failed', run_url=$2, last_error=$3, updated_at=now() WHERE id=$1",
      [deploymentId, info.htmlUrl, `run ${info.conclusion} após ${attempts} tentativas`],
    );
    await recordDialogue(row.project_id as string,
      `⚠️ Deploy falhou no GitHub Actions (${info.conclusion}) após ${attempts} tentativas. Run: ${info.htmlUrl}`);
    return;
  }
  // Volta p/ pending → runDeployAttempt re-dispara no próximo tick.
  await pool.query(
    "UPDATE cloud_deployments SET status='pending', run_id=NULL, last_error=$2, updated_at=now() WHERE id=$1",
    [deploymentId, `run ${info.conclusion} — re-disparando`],
  );
}

async function recordDialogue(projectId: string, summary: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
       VALUES ($1, 'system', 'system', 'step', $2)`,
      [projectId, summary],
    );
  } catch { /* best-effort */ }
}

/**
 * Dispara o teardown de um deploy demo vencido (com consentimento). NÃO marca 'torn_down' aqui:
 * o run de teardown ainda vai rodar e PRECISA dos secrets em runtime para destruir os recursos.
 * Marca 'tearing_down' + carimba dispatched_at; pollTeardownRun confirma o sucesso do run, só
 * então purga os secrets do repo.
 */
async function teardownExpired(row: Record<string, unknown>): Promise<void> {
  const deploymentId = row.id as string;
  const owner = row.github_login as string;
  const repoName = row.repo_name as string;
  const installationId = Number(row.installation_id);
  const provider = row.provider as CloudProvider;
  const format = row.deploy_format as DeployFormat;
  const defaultBranch = (row.default_branch as string) ?? "main";
  const deployBranch = (row.branch as string) ?? "dev";
  try {
    const content = getCloudTeardownWorkflow(provider, format, repoName);
    const branches = defaultBranch === deployBranch ? [deployBranch] : [defaultBranch, deployBranch];
    for (const br of branches) {
      await commitAndPush(installationId, {
        owner, repo: repoName, branch: br,
        message: `ci: genesis teardown workflow (${provider}/${format})`,
        files: [{ path: teardownWorkflowPath(), content }],
      });
    }
    const floor = await maxRunId(installationId, owner, repoName, deployBranch);
    await dispatchWorkflow(installationId, {
      owner, repo: repoName, workflowFile: teardownWorkflowFileName(), ref: deployBranch,
      inputs: { genesis_deploy_id: deploymentId },
    });
    await pool.query(
      "UPDATE cloud_deployments SET status='tearing_down', run_id=NULL, run_id_floor=$2, dispatched_at=now(), last_error=NULL, updated_at=now() WHERE id=$1",
      [deploymentId, floor],
    );
    await recordDialogue(row.project_id as string,
      `🧹 Deploy demo expirado — teardown disparado (${provider}/${format}).`);
  } catch (err) {
    console.warn(`[CloudDeploy] teardown ${deploymentId} failed:`, err);
  }
}

/**
 * Acompanha o run de teardown (correlação idêntica ao deploy). success → 'torn_down' e purga os
 * secrets do repo (se nenhum outro deploy do mesmo repo ainda precisar deles). failure → também
 * marca 'torn_down' (para não repetir), mas registra o erro e NÃO purga secrets (recurso pode
 * ainda existir — inspeção manual).
 */
async function pollTeardownRun(row: Record<string, unknown>): Promise<void> {
  const deploymentId = row.id as string;
  const owner = row.github_login as string;
  const repoName = row.repo_name as string;
  const installationId = Number(row.installation_id);
  const deployBranch = (row.branch as string) ?? "dev";
  const provider = row.provider as CloudProvider;
  const runId = row.run_id ? Number(row.run_id) : null;

  if (!runId) {
    const match = correlateRun(
      await listRecentWorkflowRuns(installationId, {
        owner, repo: repoName, branch: deployBranch, event: "workflow_dispatch", perPage: 30,
      }),
      deploymentId,
      row.dispatched_at as string | null,
      row.run_id_floor != null ? Number(row.run_id_floor) : null,
    );
    if (!match) return;
    await pool.query(
      "UPDATE cloud_deployments SET run_id=$2, run_url=$3, updated_at=now() WHERE id=$1",
      [deploymentId, match.id, match.htmlUrl],
    );
    return;
  }

  const info = await getWorkflowRunStatus(installationId, { owner, repo: repoName, runId });
  if (!info) return;
  if (info.status !== "completed") return; // ainda rodando

  if (info.conclusion === "success") {
    // Teardown confirmado → seguro purgar os secrets, MAS só se nenhum outro deploy do mesmo
    // repo ainda precisa deles. Isso inclui QUALQUER 'deployed' (permanente OU demo ainda no ar
    // que ainda vai fazer seu próprio teardown — senão o teardown futuro dela roda sem creds e
    // deixa recurso órfão na conta paga) e qualquer deploy em andamento/teardown.
    const siblings = await pool.query(
      `SELECT 1 FROM cloud_deployments
        WHERE repo_full_name = $1 AND id <> $2
          AND status IN ('pending','dispatching','running','tearing_down','deployed')
        LIMIT 1`,
      [row.repo_full_name, deploymentId],
    );
    if (siblings.rowCount === 0) {
      await removeSyncedSecrets(installationId, owner, repoName, provider).catch((e) =>
        console.warn(`[CloudDeploy] remove secrets ${deploymentId} failed:`, e));
    }
    await pool.query(
      "UPDATE cloud_deployments SET status='torn_down', torn_down_at=now(), run_url=$2, last_error=NULL, updated_at=now() WHERE id=$1",
      [deploymentId, info.htmlUrl],
    );
    await recordDialogue(row.project_id as string, `🧹 Teardown concluído. Run: ${info.htmlUrl}`);
    return;
  }

  await pool.query(
    "UPDATE cloud_deployments SET status='torn_down', torn_down_at=now(), run_url=$2, last_error=$3, updated_at=now() WHERE id=$1",
    [deploymentId, info.htmlUrl, `teardown ${info.conclusion} — verificar recursos manualmente`],
  );
  await recordDialogue(row.project_id as string,
    `⚠️ Teardown falhou (${info.conclusion}). Verifique os recursos. Run: ${info.htmlUrl}`);
}

/**
 * Tick do worker: (1) reenvia/dispara pendentes; (2) correlaciona/acompanha runs;
 * (3) teardown de demos vencidas. Idempotente e bounded (LIMIT por tipo).
 */
export async function reconcileCloudDeployments(): Promise<void> {
  // (0) WATCHDOG de dispatch perdido: um dispatch que nunca materializou um run (YAML inválido
  // que o GitHub não registra, clock atrasado, etc.) ficaria preso em 'dispatching'/'tearing_down'
  // para sempre. Após o timeout (sem run_id correlacionado), auto-cura:
  //   dispatching → volta a 'pending' (re-dispara até o teto; failed no teto);
  //   tearing_down → 'torn_down' com aviso de inspeção manual (bounded, NÃO purga secrets).
  await pool.query(
    `UPDATE cloud_deployments
        SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
            last_error = CASE WHEN attempts >= $1
              THEN 'dispatch não gerou run dentro do tempo — falhou'
              ELSE 'dispatch não gerou run dentro do tempo — reenviando' END,
            updated_at = now()
      WHERE status = 'dispatching' AND run_id IS NULL
        AND dispatched_at IS NOT NULL AND dispatched_at < now() - INTERVAL '${DISPATCH_RUN_TIMEOUT}'`,
    [MAX_DEPLOY_ATTEMPTS],
  );
  await pool.query(
    `UPDATE cloud_deployments
        SET status = 'torn_down', torn_down_at = now(),
            last_error = 'teardown não gerou run dentro do tempo — verificar recursos manualmente',
            updated_at = now()
      WHERE status = 'tearing_down' AND run_id IS NULL
        AND dispatched_at IS NOT NULL AND dispatched_at < now() - INTERVAL '${DISPATCH_RUN_TIMEOUT}'`,
  );

  // (1) pendentes → (re)dispatch
  const pending = (await pool.query(
    "SELECT id FROM cloud_deployments WHERE status='pending' AND attempts < $1 ORDER BY updated_at ASC LIMIT 10",
    [MAX_DEPLOY_ATTEMPTS],
  )).rows;
  for (const r of pending) {
    await runDeployAttempt(r.id as string).catch((e) =>
      console.warn(`[CloudDeploy] reconcile dispatch ${r.id} failed:`, e));
  }

  // (2) dispatching/running → correlaciona/acompanha
  const active = (await pool.query(
    `SELECT d.*, r.repo_name, r.default_branch, gi.installation_id, gi.github_login
       FROM cloud_deployments d
       JOIN project_github_repos r ON r.project_id = d.project_id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = d.tenant_id
      WHERE d.status IN ('dispatching','running') AND gi.installation_id IS NOT NULL
      ORDER BY d.updated_at ASC LIMIT 20`,
  )).rows;
  for (const r of active) {
    await pollDeploymentRun(r).catch((e) =>
      console.warn(`[CloudDeploy] reconcile poll ${r.id} failed:`, e));
  }

  // (2b) tearing_down → acompanha o run de teardown (confirma sucesso antes de purgar secrets)
  const tearing = (await pool.query(
    `SELECT d.*, r.repo_name, r.default_branch, gi.installation_id, gi.github_login
       FROM cloud_deployments d
       JOIN project_github_repos r ON r.project_id = d.project_id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = d.tenant_id
      WHERE d.status = 'tearing_down' AND gi.installation_id IS NOT NULL
      ORDER BY d.updated_at ASC LIMIT 20`,
  )).rows;
  for (const r of tearing) {
    await pollTeardownRun(r).catch((e) =>
      console.warn(`[CloudDeploy] reconcile teardown-poll ${r.id} failed:`, e));
  }

  // (3) demos vencidas com consentimento → teardown.
  // Bloco 4 (M5): ignora deploys SUBSTITUÍDOS por uma versão mais nova (superseded_by_deployment_id
  // preenchido) — os recursos agora pertencem ao novo deploy, que herdou o mesmo expires_at e fará
  // o próprio teardown ao vencer. Derrubá-los aqui apagaria a versão corrente no ar.
  const expired = (await pool.query(
    `SELECT d.*, r.repo_name, r.default_branch, gi.installation_id, gi.github_login
       FROM cloud_deployments d
       JOIN project_github_repos r ON r.project_id = d.project_id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = d.tenant_id
      WHERE d.status='deployed' AND d.expires_at IS NOT NULL AND d.expires_at < now()
        AND d.consented_teardown = true AND gi.installation_id IS NOT NULL
        AND d.superseded_by_deployment_id IS NULL
      ORDER BY d.expires_at ASC LIMIT 10`,
  )).rows;
  for (const r of expired) {
    await teardownExpired(r).catch((e) =>
      console.warn(`[CloudDeploy] reconcile teardown ${r.id} failed:`, e));
  }
}
