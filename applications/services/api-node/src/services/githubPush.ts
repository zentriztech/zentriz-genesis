/**
 * githubPush — Triggered when a tenant accepts a project.
 *
 * Flow:
 * 1. Check tenant has GitHub App installed
 * 2. Idempotency check: skip if project_github_repos already exists
 * 3. Create repository (private, auto_init=true)
 * 4. Ensure 3 branches: main, staging, dev
 * 5. Push all apps/ files to branch "dev"
 * 6. If tenant has cloud connection: sync GitHub Secrets + push deploy workflow
 * 7. Save to project_github_repos
 * 8. Add dialogue entry so portal shows the repo link
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "../db/client.js";
import { identityInputsFor } from "./lineage.js";
import { syncSecretsToGitHub, getCloudConnection } from "./cloudConnector.js";
import {
  createRepository,
  ensureThreeBranches,
  pushProjectFiles,
  getInstallationTokenForClone,
  repoShortName,
} from "./github.js";

const execFileAsync = promisify(execFile);
import { notifyTelegramTenant } from "../routes/telegram.js";
import { validateDeployMatrix } from "./provision/deployMatrix.js";
import { renderMobileRncliBundle } from "./provision/renderers/mobileRncliRenderer.js";
import { renderMobileEasBundle } from "./provision/renderers/mobileEasRenderer.js";

const PROJECT_FILES_ROOT = (process.env.PROJECT_FILES_ROOT ?? "/shared/uploads").trim();
// #60: base URL do Deadpool para registrar o vínculo projeto-deployado → código-fonte.
// Vazio = integração desligada (skip silencioso; nunca falha o push).
const DEADPOOL_BASE_URL = (process.env.DEADPOOL_BASE_URL ?? "").trim().replace(/\/+$/, "");
const DEADPOOL_API_TOKEN = (process.env.DEADPOOL_API_TOKEN ?? "").trim();

/** Slug determinístico (lowercase, sem sufixo) — casa com o systemId/serviceId do envelope Connect. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Slugify project title to a valid GitHub repo name
function toRepoName(title: string): string {
  const base = slugify(title).slice(0, 50);
  // Append short random suffix to avoid collisions
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || "genesis-project"}-${suffix}`;
}

/** Argumentos do registro projeto→Deadpool. Campos runtime são opcionais (enviados ao ATIVAR monitoramento). */
export interface DeadpoolRegisterArgs {
  systemId: string;
  serviceId: string | null;
  repoUrl: string;
  installationId: number | string;
  // Ponto 3 (git-link): caminho da árvore de trabalho LOCAL git-linkada ao repo, no volume
  // compartilhado (/shared/uploads/<projectId>/apps). O Deadpool a usa como repo_dir para
  // manutenção/evolução SEM clone de rede (allow_network_clone=OFF por padrão). Opcional →
  // retrocompatível: ausente = Deadpool cai no fluxo antigo (clone quando habilitado).
  localPath?: string | null;
  // Runtime (opcional): enviado quando o monitoramento é ativado para um projeto deployado.
  appUrl?: string | null;
  healthUrl?: string | null;
  environment?: string | null;
  awsRegion?: string | null;
  logGroup?: string | null;
  /** true = habilitar monitoramento ativo de logs; false = desligar. undefined = não altera (registro #60 legado). */
  monitoring?: boolean;
  // Multi-cloud (M1/M2): provider + ponteiros por nuvem. Ausência = CloudWatch (default histórico).
  monitorProvider?: string | null;
  azureWorkspaceId?: string | null;
  azureTable?: string | null;
  azureMessageColumn?: string | null;
  gcpProjectId?: string | null;
  gcpLogFilter?: string | null;
  // Fork B (multi-tenant): credenciais AWS POR PROJETO, para o poller do Deadpool ler a CONTA do
  // tenant (não a identidade única do container). roleArn/externalId NÃO são segredos (assume-role
  // cross-account). awsCredentialsEnc é o PAYLOAD CIFRADO (crypto.ts) das chaves estáticas — enviamos
  // o CIPHERTEXT, nunca a chave em claro; o Deadpool decripta em memória com a chave compartilhada.
  awsRoleArn?: string | null;
  awsExternalId?: string | null;
  awsCredentialsEnc?: { encrypted: string; iv: string; tag: string; keyVersion?: number } | null;
  // R4 PR6 (plumbing build→Deadpool): manifests Connect emitidos pela fábrica (serviceManifest,
  // ownershipManifest, integrationReadyContract, runtimePassport, observabilityBaselineManifest —
  // NUNCA knownSafeActionsPack) + versão do Connect. Opcionais → retrocompatível.
  connectManifests?: Record<string, Record<string, unknown>> | null;
  connectVersion?: string | null;
}

/** Resultado do registro. Nunca lança — best-effort — mas informa sucesso/falha ao chamador. */
export interface DeadpoolRegisterResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** true quando a integração está desligada (DEADPOOL_BASE_URL ausente). */
  skipped?: boolean;
}

/**
 * Deriva (systemId, serviceId) canônicos — casam com o envelope Connect que o Deadpool consome.
 * systemId = product.systemId do manifesto quando presente; senão slug do nome do produto;
 * para projeto standalone, slug do título. serviceId = slug do título dentro do produto (ou null).
 * FONTE ÚNICA: usada tanto no push (#60) quanto no botão Ativar Monitoramento (#1).
 */
export function deriveSystemService(opts: {
  productSystemId?: string | null;
  productName?: string | null;
  title?: string | null;
  projectId: string;
  /**
   * §4.17 (migration 064): App solo — o produto homônimo criado na graduação. Um App solo
   * é um SISTEMA MONO-SERVIÇO (o sistema É o app), não um produto com um serviço dentro.
   * Preserva a semântica do antigo standalone (serviceId=null): mantém a topologia do
   * Deadpool limpa e o systemId estável frente a renomeações do título.
   */
  soloApp?: boolean;
}): { systemId: string; serviceId: string | null } {
  const canonicalSystemId = opts.productSystemId?.trim();
  const systemId =
    canonicalSystemId ||
    (opts.productName ? slugify(opts.productName) : slugify(opts.title ?? opts.projectId));
  // App solo → sistema mono-serviço: sem serviceId (o serviço é o próprio sistema).
  if (opts.soloApp) return { systemId, serviceId: null };
  const serviceId =
    canonicalSystemId || opts.productName ? slugify(opts.title ?? opts.projectId) : null;
  return { systemId, serviceId };
}

/**
 * #60/#1 — Registra o vínculo (systemId, serviceId) → repo_url no Deadpool, para que o
 * plano de sustainment consiga clonar o código-fonte do projeto deployado, e (no #1) receba
 * os dados de runtime (appUrl/healthUrl/logGroup) + o flag de monitoramento ativo.
 * Out-of-band, best-effort: NUNCA lança (não pode falhar o aceite/push). Retorna o resultado
 * para que o botão Ativar Monitoramento possa reportar sucesso/falha ao usuário.
 */
export async function registerProjectWithDeadpool(
  args: DeadpoolRegisterArgs,
): Promise<DeadpoolRegisterResult> {
  if (!DEADPOOL_BASE_URL) return { ok: false, skipped: true }; // integração desligada
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (DEADPOOL_API_TOKEN) headers["Authorization"] = `Bearer ${DEADPOOL_API_TOKEN}`;
    const body: Record<string, unknown> = {
      systemId: args.systemId,
      serviceId: args.serviceId,
      repoUrl: args.repoUrl,
      installationId: String(args.installationId),
    };
    // Campos runtime/monitoring só entram no payload quando fornecidos → retrocompatível
    // com o registro #60 (que manda apenas systemId/serviceId/repoUrl/installationId).
    if (args.localPath != null) body.localPath = args.localPath;
    if (args.appUrl != null) body.appUrl = args.appUrl;
    if (args.healthUrl != null) body.healthUrl = args.healthUrl;
    if (args.environment != null) body.environment = args.environment;
    if (args.awsRegion != null) body.awsRegion = args.awsRegion;
    if (args.logGroup != null) body.logGroup = args.logGroup;
    if (args.monitoring != null) body.monitoring = args.monitoring;
    // Multi-cloud: só entram quando fornecidos → retrocompatível com CloudWatch (sem esses campos).
    if (args.monitorProvider != null) body.monitorProvider = args.monitorProvider;
    if (args.azureWorkspaceId != null) body.azureWorkspaceId = args.azureWorkspaceId;
    if (args.azureTable != null) body.azureTable = args.azureTable;
    if (args.azureMessageColumn != null) body.azureMessageColumn = args.azureMessageColumn;
    if (args.gcpProjectId != null) body.gcpProjectId = args.gcpProjectId;
    if (args.gcpLogFilter != null) body.gcpLogFilter = args.gcpLogFilter;
    // Fork B: credenciais AWS por projeto (só quando fornecidas → retrocompatível).
    if (args.awsRoleArn != null) body.awsRoleArn = args.awsRoleArn;
    if (args.awsExternalId != null) body.awsExternalId = args.awsExternalId;
    if (args.awsCredentialsEnc != null) body.awsCredentialsEnc = args.awsCredentialsEnc;
    // R4 PR6: contratos Connect do build → registry do Deadpool (só quando lidos do disco).
    if (args.connectManifests != null && Object.keys(args.connectManifests).length > 0) {
      body.connectManifests = args.connectManifests;
      if (args.connectVersion) body.connectVersion = args.connectVersion;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${DEADPOOL_BASE_URL}/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[GitHubPush] Deadpool register-project returned ${res.status} (non-fatal)`);
        return { ok: false, status: res.status };
      }
      console.log(`[GitHubPush] ✓ registered ${args.systemId}/${args.serviceId ?? "*"} with Deadpool`);
      return { ok: true, status: res.status };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[GitHubPush] Deadpool register-project failed (non-fatal):", err);
    return { ok: false, error: msg };
  }
}

/** Resultado do git-link da pasta local (Ponto 3). Nunca lança — best-effort. */
export interface GitLinkResult {
  ok: boolean;
  localPath?: string;
  error?: string;
}

/**
 * Preflight — o binário `git` existe no runtime desta API? O Ponto 3 (gitLinkProjectFolder)
 * depende dele; se ausente (ex.: imagem base sem `apk add git`), validamos ANTES de tentar
 * qualquer subcomando git e retornamos um erro claro/acionável, em vez de um ENOENT cru
 * repetido a cada passo. Cacheado por processo — a disponibilidade não muda em runtime.
 */
let _gitAvailable: boolean | null = null;
export async function isGitAvailable(): Promise<boolean> {
  if (_gitAvailable !== null) return _gitAvailable;
  try {
    await execFileAsync("git", ["--version"], { timeout: 5_000 });
    _gitAvailable = true;
  } catch {
    _gitAvailable = false;
  }
  return _gitAvailable;
}

/**
 * Ponto 3 (Jean) — git-linka a pasta LOCAL do projeto ao repositório recém-criado, para que
 * o Deadpool a use como working tree (`repo_dir`) nas manutenções/melhorias/evolução SEM
 * clone de rede (o executor do Deadpool usa `repo_dir` local quando
 * `DEADPOOL_ALLOW_NETWORK_CLONE` está OFF — o default). Genesis e Deadpool compartilham o
 * volume (/shared/uploads), então a árvore linkada aqui é lida diretamente pelo Deadpool.
 *
 * O layout do repo = conteúdo achatado de `<root>/<projectId>/apps/` (a MESMA pasta que
 * `pushProjectFiles` envia). Passos: `git init` → remote `origin` com URL LIMPA (o token de
 * instalação é curto — ~1h; o Deadpool injeta o SEU token na hora do push/PR, como já faz no
 * clone) → `fetch` autenticado pontual do branch (token só no header `http.extraheader`,
 * NUNCA persistido em config/URL) → `checkout -B <branch> origin/<branch>`. Resultado: a
 * árvore local vira um espelho fiel do branch remoto, com histórico COMUM — os PRs do
 * Deadpool nascem limpos (sem "unrelated histories"). Idempotente e não-fatal: NUNCA derruba
 * o push (roda depois do repo já criado e salvo).
 */
/**
 * Evoluir E1: cria (ou reaproveita) o branch local de trabalho da evolução (`evolution/vN`) a partir
 * do estado atual do working tree (pós-`gitLinkProjectFolder` = tip de `origin/dev`). Idempotente e
 * não-fatal — quem chama registra o resultado no `extra` do projeto.
 */
export async function checkoutNewBranch(projectId: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  const localPath = join(PROJECT_FILES_ROOT, projectId, "apps");
  const git = (args: string[]) =>
    execFileAsync("git", ["-C", localPath, ...args], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  try {
    await git(["checkout", "-q", "-B", branch]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function gitLinkProjectFolder(opts: {
  projectId: string;
  fullName: string;
  installationId: number;
  branch: string;
  /** Seam de teste: sobrescreve a URL do remote (default = repo do GitHub). */
  remoteUrl?: string;
}): Promise<GitLinkResult> {
  const localPath = join(PROJECT_FILES_ROOT, opts.projectId, "apps");
  // Preflight 1: binário git disponível? (evita ENOENT cru a cada subcomando).
  if (!(await isGitAvailable())) {
    return {
      ok: false,
      localPath,
      error:
        "binário `git` ausente no runtime da API — instale-o na imagem (Dockerfile: `apk add --no-cache git`). " +
        "Sem git-link, o repo/push seguem OK (via API do GitHub), mas o Deadpool não recebe a pasta local e cai em clone/dry-run.",
    };
  }
  // Preflight 2: pasta de código existe? (sem apps/, nada a linkar).
  try {
    await access(localPath);
  } catch {
    return { ok: false, error: `pasta local ausente: ${localPath}` };
  }
  const git = (args: string[]) =>
    execFileAsync("git", ["-C", localPath, ...args], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  try {
    // C3 (rota B): token escopado a ESTE repo, contents:write (push do código gerado).
    const token = await getInstallationTokenForClone(opts.installationId, {
      repositoryNames: [repoShortName(opts.fullName)],
      permissions: { contents: "write" },
    });
    const plainUrl = opts.remoteUrl ?? `https://github.com/${opts.fullName}.git`;
    // Auth via header (Basic x-access-token:token) só no fetch — não fica em nenhum config.
    const authHeader = `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

    // `-b <branch>`: o branch inicial já nasce com o nome alvo (idempotente em repo existente).
    await git(["init", "-q", "-b", opts.branch]);
    await git(["config", "user.email", "genesis@zentriz.com.br"]);
    await git(["config", "user.name", "Zentriz Genesis"]);
    await git(["config", "commit.gpgsign", "false"]);
    // Remote LIMPO (sem token), idempotente entre re-execuções.
    await git(["remote", "remove", "origin"]).catch(() => {});
    await git(["remote", "add", "origin", plainUrl]);
    // Fetch autenticado pontual do branch alvo (token só no header desta invocação).
    await git(["-c", authHeader, "fetch", "--depth=1", "-q", "origin", opts.branch]);
    // Alinha a árvore local ao tip remoto (histórico comum p/ PRs limpos do Deadpool).
    // reset --hard (e não checkout) porque a pasta JÁ contém os arquivos enviados como
    // NÃO-rastreados: o checkout recusaria ("untracked would be overwritten"); o reset
    // sobrescreve as colisões e faz o branch nascer apontando ao tip remoto.
    await git(["reset", "--hard", "-q", `origin/${opts.branch}`]);
    // Rastreio upstream = origin/<branch> (o reset não seta upstream sozinho).
    await git(["branch", `--set-upstream-to=origin/${opts.branch}`, opts.branch]).catch(() => {});
    return { ok: true, localPath };
  } catch (err) {
    return { ok: false, localPath, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function pushProjectToGitHub(projectId: string): Promise<void> {
  const client = await pool.connect();
  try {
    // ── 1. Load project + tenant ──────────────────────────────────────────────
    const projRes = await client.query(
      `SELECT p.id, p.title, p.tenant_id, p.created_by, p.product_id, p.extra,
              pr.name AS product_name, pr.system_id AS product_system_id, pr.solo_app AS product_solo_app,
              gi.installation_id, gi.github_login, gi.installation_type
       FROM projects p
       LEFT JOIN products pr ON pr.id = p.product_id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
       WHERE p.id = $1`,
      [projectId],
    );
    const row = projRes.rows[0];
    if (!row) { console.warn(`[GitHubPush] Project ${projectId} not found`); return; }
    if (!row.installation_id) {
      console.log(`[GitHubPush] Tenant has no GitHub App installation — skipping`);
      // #59: never fail silently — surface WHY no repo was created so the portal/tenant sees it.
      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
         VALUES ($1, 'system', 'system', 'step', $2)`,
        [projectId, `⚠️ Repositório GitHub não criado: o tenant ainda não instalou o GitHub App da Zentriz. Instale o App (Settings → Integrações) e reprocesse o projeto para publicar o código.`],
      );
      return;
    }

    // ── 2. Idempotency ────────────────────────────────────────────────────────
    const existing = await client.query(
      "SELECT repo_url FROM project_github_repos WHERE project_id = $1",
      [projectId],
    );
    if (existing.rows.length > 0) {
      console.log(`[GitHubPush] Repo already exists for ${projectId}: ${existing.rows[0].repo_url}`);
      return;
    }

    const installationId = row.installation_id as number;
    const owner = row.github_login as string;
    const repoName = toRepoName((row.title as string) ?? "genesis-project");

    console.log(`[GitHubPush] Creating repo ${owner}/${repoName} for project ${projectId}`);

    // ── 3. Create repo ────────────────────────────────────────────────────────
    const { url: repoUrl, fullName } = await createRepository(installationId, {
      org: row.installation_type === "Organization" ? owner : undefined,
      name: repoName,
      description: `Generated by Zentriz Genesis — ${row.title ?? projectId}`,
      private: true,
      autoInit: true,
    });

    // ── 4. 3 branches ─────────────────────────────────────────────────────────
    await ensureThreeBranches(installationId, owner, repoName);

    // ── 5. Push files to dev ──────────────────────────────────────────────────
    const { sha: shaDevResult, fileCount } = await pushProjectFiles(
      installationId, owner, repoName, "dev",
      PROJECT_FILES_ROOT, projectId,
    );

    // ── 6. Cloud connection: sync secrets + push deploy workflow ──────────────
    let deployMsg = "";
    try {
      const tenantId = row.tenant_id as string;
      const cloudConn = await getCloudConnection(tenantId);
      if (cloudConn) {
        const { synced, provider } = await syncSecretsToGitHub(
          tenantId, owner, repoName, installationId,
        );
        deployMsg = ` | ${provider.toUpperCase()} secrets synced (${synced})`;
        console.log(`[GitHubPush] Cloud secrets synced: ${synced} secrets for ${provider}`);

        // Push deploy workflow to the repo
        const { commitAndPush } = await import("./github.js");
        const workflowContent = getDeployWorkflow(cloudConn.provider, repoName);
        if (workflowContent) {
          await commitAndPush(installationId, {
            owner, repo: repoName, branch: "dev",
            message: `ci: add ${cloudConn.provider} deploy workflow (generated by Genesis)`,
            files: [{ path: ".github/workflows/deploy.yml", content: workflowContent }],
          });
          deployMsg += " | deploy.yml committed";
        }
      }
    } catch (cloudErr) {
      console.warn("[GitHubPush] Cloud connector step failed (non-fatal):", cloudErr);
    }

    // ── 6b. Mobile: injeta CI de build no repo (#82 / D-2) ────────────────────
    // Simétrico ao deploy.yml de web/backend: projeto mobile aceito ganha o workflow
    // de build no próprio repo (Android APK como artefato; iOS build no simulador).
    // Best-effort e não-fatal (igual à etapa cloud): nunca falha o aceite/push.
    try {
      const extra = (row.extra as Record<string, unknown> | null) ?? {};
      const projectType = (extra.project_type as string | undefined) ?? null;
      const runtimeTarget = (extra.runtime_target as string | undefined) ?? null;
      const deliveryMode = (extra.delivery_mode as string | undefined) ?? null;
      const apiUrl = (extra.api_url as string | undefined) ?? (extra.apiUrl as string | undefined) ?? null;
      const mobileWf = getMobileBuildWorkflow({
        projectType, runtimeTarget, deliveryMode,
        appName: (row.title as string | undefined)?.trim() || repoName,
        apiUrl,
      });
      if (mobileWf) {
        const { commitAndPush } = await import("./github.js");
        await commitAndPush(installationId, {
          owner, repo: repoName, branch: "dev",
          message: `ci: add mobile build workflow (generated by Genesis)`,
          files: [{ path: mobileWf.path, content: mobileWf.content }],
        });
        deployMsg += " | mobile-build CI committed";
        console.log(`[GitHubPush] Mobile build workflow committed: ${mobileWf.path}`);
      }
    } catch (mobileErr) {
      console.warn("[GitHubPush] Mobile CI step failed (non-fatal):", mobileErr);
    }

    // ── 7. Save to DB ─────────────────────────────────────────────────────────
    const cloneUrl = repoUrl;
    await client.query(
      `INSERT INTO project_github_repos
         (project_id, repo_name, repo_full_name, repo_url, clone_url, default_branch, pushed_at, sha_dev)
       VALUES ($1, $2, $3, $4, $5, 'main', now(), $6)
       ON CONFLICT (project_id) DO UPDATE
         SET pushed_at = now(), sha_dev = $6`,
      [projectId, repoName, fullName, `https://github.com/${fullName}`, cloneUrl, shaDevResult],
    );

    // ── 7a-bis. Ponto 3: git-linka a pasta local ao repo ─────────────────────
    // Transforma <root>/<projectId>/apps/ num working tree git espelhando o branch dev
    // remoto (histórico comum). O Deadpool, no volume compartilhado, usa essa pasta como
    // repo_dir para manutenção/evolução sem clone de rede. Best-effort: nunca falha o push.
    const gitLink = await gitLinkProjectFolder({ projectId, fullName, installationId, branch: "dev" });
    if (gitLink.ok) {
      console.log(`[GitHubPush] ✓ pasta local git-linkada ao dev p/ Deadpool: ${gitLink.localPath}`);
    } else {
      console.warn(`[GitHubPush] git-link da pasta local falhou (non-fatal): ${gitLink.error}`);
    }

    // ── 7b. Registrar vínculo com o Deadpool (#60) ────────────────────────────
    // systemId canônico do manifesto (product.systemId, ex.: "zvoices") quando presente;
    // senão slug do nome do produto; para projeto standalone, slug do título.
    // serviceId = slug do título do projeto (dentro do produto). Casam com o
    // systemId/serviceId do envelope Connect que o Deadpool consome.
    // Evoluir E1: identidade pela RAIZ da linhagem (mesmo serviceId em todas as versões).
    const lineage = await identityInputsFor(client, projectId, row.title as string | null);
    const { systemId, serviceId } = deriveSystemService({
      productSystemId: row.product_system_id as string | null,
      productName: row.product_name as string | null,
      title: lineage.title,
      projectId: lineage.projectId,
      soloApp: (row.product_solo_app as boolean | null) ?? false,
    });
    // #60: registro base no push (sem runtime/monitoring). O monitoramento ativo é
    // habilitado depois, sob demanda, pelo botão Ativar Monitoramento (#1) — que envia
    // os dados de runtime e monitoring=true. Best-effort: resultado ignorado aqui.
    await registerProjectWithDeadpool({
      systemId,
      serviceId,
      repoUrl: `https://github.com/${fullName}`,
      installationId,
      // Ponto 3: informa ao Deadpool o repo_dir local (só quando o git-link deu certo).
      localPath: gitLink.ok ? gitLink.localPath : null,
    });

    // ── 8. Dialogue entry ─────────────────────────────────────────────────────
    await client.query(
      `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
       VALUES ($1, 'system', 'system', 'step', $2)`,
      [projectId, `Repositório GitHub criado: https://github.com/${fullName} — ${fileCount} arquivos enviados para branch dev${deployMsg}.`],
    );

    console.log(`[GitHubPush] ✓ ${fullName} — ${fileCount} files pushed to dev (${shaDevResult.slice(0, 8)})${deployMsg}`);

    // ── 9. Telegram (best-effort, nunca bloqueia) ─────────────────────────────
    if (row.tenant_id) {
      notifyTelegramTenant(
        row.tenant_id,
        `🐙 Repositório GitHub criado para *${row.title}*\nhttps://github.com/${fullName}`,
      ).catch(() => {});
    }
  } catch (err) {
    console.error(`[GitHubPush] Failed for project ${projectId}:`, err);
    // Fire-and-forget: never throw — must not fail the accept request.
    // #59: but never swallow silently — record WHY so the portal/tenant sees the failure.
    try {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number })?.status;
      // #59: 403 "Resource not accessible by integration" ao criar repo em org = o GitHub App
      // não tem a permissão de REPOSITÓRIO "Administration: Read & write" (distinta de
      // "Organization administration"). É configuração do App (dono aprova), não erro de código.
      const hint =
        status === 403 || /not accessible by integration/i.test(msg)
          ? " → O GitHub App precisa da permissão de repositório 'Administration: Read & write' (Settings do App → Permissions → Repository → Administration), e o proprietário da organização deve aprovar a nova permissão na instalação."
          : "";
      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
         VALUES ($1, 'system', 'system', 'step', $2)`,
        [projectId, `⚠️ Falha ao criar o repositório GitHub: ${msg}. O projeto foi aceito, mas o código ainda não foi publicado.${hint}`],
      );
    } catch (dialogueErr) {
      console.error(`[GitHubPush] Could not record failure dialogue for ${projectId}:`, dialogueErr);
    }
  } finally {
    client.release();
  }
}

// ── Evoluir E5: push da EVOLUÇÃO no repo do serviço (branch evolution/vN + PR) ──

export interface EvolutionPushResult {
  ok: boolean;
  mode: "evolution" | "fallback_new_repo" | "skipped";
  fullName?: string;
  branch?: string;
  prUrl?: string;
  compareUrl?: string;
  fileCount?: number;
  error?: string;
}

/**
 * Evolução = nova versão do MESMO serviço → o código vai para o repo da RAIZ da linhagem, em
 * `evolution/vN`, com PR aberto para `dev` (E-D2). Sem repo na linhagem → fallback: fluxo normal
 * (cria repo; a identidade já é a da raiz — E1). Registra o filho em `project_github_repos` (mesmo
 * repo) e re-registra no Deadpool com a MESMA chave (identidade pela raiz) apontando o `local_path`
 * do filho. Best-effort: nunca lança; tudo vai a `project_dialogue`.
 */
export async function pushEvolutionToGitHub(projectId: string, opts: { versionLabel: string; prBody: string }): Promise<EvolutionPushResult> {
  const client = await pool.connect();
  try {
    const projRes = await client.query(
      `SELECT p.id, p.title, p.tenant_id, p.product_id, p.extra, p.parent_project_id, p.version_number,
              pr.name AS product_name, pr.system_id AS product_system_id, pr.solo_app AS product_solo_app,
              gi.installation_id, gi.github_login, gi.installation_type
       FROM projects p
       LEFT JOIN products pr ON pr.id = p.product_id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
       WHERE p.id = $1`,
      [projectId],
    );
    const row = projRes.rows[0];
    if (!row) return { ok: false, mode: "skipped", error: "projeto não encontrado" };
    if (!row.installation_id) {
      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1, 'system', 'system', 'step', $2)`,
        [projectId, "⚠️ Evolução aceita, mas o código não foi publicado: o tenant não tem o GitHub App instalado."],
      );
      return { ok: false, mode: "skipped", error: "sem GitHub App" };
    }
    const { findLineageRepo, evolutionBranchName } = await import("./evolutionAccept.js");
    const lineageRepo = await findLineageRepo(client, projectId, (row.parent_project_id as string | null) ?? null);
    if (!lineageRepo) {
      // Pai nunca publicou (sem GitHub na época?) → cria repo pelo fluxo normal (identidade pela raiz).
      await pushProjectToGitHub(projectId);
      return { ok: true, mode: "fallback_new_repo" };
    }
    const installationId = row.installation_id as number;
    const [owner, repoName] = lineageRepo.repo_full_name.split("/");
    const branch = evolutionBranchName(row.version_number as number | null);
    const { createBranchIfNotExists, pushProjectFiles, openPullRequest } = await import("./github.js");

    await createBranchIfNotExists(installationId, owner, repoName, branch, "dev");
    const { sha, fileCount } = await pushProjectFiles(installationId, owner, repoName, branch, PROJECT_FILES_ROOT, projectId);

    await client.query(
      `INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url, default_branch, pushed_at, sha_dev)
       VALUES ($1, $2, $3, $4, $5, 'main', now(), $6)
       ON CONFLICT (project_id) DO UPDATE SET pushed_at = now(), sha_dev = $6`,
      [projectId, repoName, lineageRepo.repo_full_name, `https://github.com/${lineageRepo.repo_full_name}`, lineageRepo.repo_url, sha],
    );

    const pr = await openPullRequest(installationId, {
      owner, repo: repoName, head: branch, base: "dev",
      title: `Evolução v${opts.versionLabel} — ${(row.title as string) ?? projectId}`.replace(/ — Evolução v\d+ —/, " —"),
      body: opts.prBody,
    });

    // Deadpool: MESMA chave (identidade pela raiz); local_path do filho (E1 git-linkou apps/ em evolution/vN).
    const lineage = await identityInputsFor(client, projectId, row.title as string | null);
    const { systemId, serviceId } = deriveSystemService({
      productSystemId: row.product_system_id as string | null,
      productName: row.product_name as string | null,
      title: lineage.title,
      projectId: lineage.projectId,
      soloApp: (row.product_solo_app as boolean | null) ?? false,
    });
    const localApps = join(PROJECT_FILES_ROOT, projectId, "apps");
    const { existsSync: _exists } = await import("node:fs");
    await registerProjectWithDeadpool({
      systemId, serviceId,
      repoUrl: `https://github.com/${lineageRepo.repo_full_name}`,
      installationId,
      localPath: _exists(join(localApps, ".git")) ? localApps : null,
    });

    const prMsg = pr.ok ? `PR aberto: ${pr.url}` : `PR não aberto automaticamente (${pr.error}) — abra em ${pr.compareUrl}`;
    await client.query(
      `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1, 'system', 'system', 'step', $2)`,
      [projectId, `🔄 Evolução v${opts.versionLabel} publicada em ${lineageRepo.repo_full_name}@${branch} (${fileCount} arquivos). ${prMsg}. Deadpool segue a mesma chave ${systemId}/${serviceId}.`],
    );
    if (row.tenant_id) {
      notifyTelegramTenant(row.tenant_id as string, `🔄 Evolução v${opts.versionLabel} de *${row.title}*: ${pr.ok ? pr.url : `https://github.com/${lineageRepo.repo_full_name}/tree/${branch}`}`).catch(() => {});
    }
    return { ok: true, mode: "evolution", fullName: lineageRepo.repo_full_name, branch, fileCount, prUrl: pr.ok ? pr.url : undefined, compareUrl: pr.ok ? undefined : pr.compareUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GitHubPush] Evolution push failed for ${projectId}:`, err);
    try {
      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1, 'system', 'system', 'step', $2)`,
        [projectId, `⚠️ Falha ao publicar a evolução no GitHub: ${msg.slice(0, 300)}. O aceite foi registrado; publique manualmente ou reprocesse.`],
      );
    } catch { /* ignore */ }
    return { ok: false, mode: "evolution", error: msg };
  } finally {
    client.release();
  }
}

// ── Mobile build CI (D-2) ──────────────────────────────────────────────────────

/**
 * #82 (D-2) — Simetria com web/backend: no accept, projeto mobile também ganha CI de
 * build no repo. Web/backend recebem `deploy.yml` (getDeployWorkflow); mobile recebia
 * `null` → o repo mobile nascia SEM pipeline de build (o kit só saía no download avulso).
 *
 * Reusa os renderers de kit mobile (FONTE ÚNICA — sem duplicar YAML) e extrai apenas o
 * arquivo de workflow do bundle: rncli → `.github/workflows/mobile-build.yml` (Android
 * `gradlew assembleRelease` → APK como artefato; iOS build no simulador); expo → `eas-build.yml`.
 * O canal é decidido pela política no-Expo (mobile_expo → eas; demais → rncli).
 *
 * Prod-safe: o workflow roda no GitHub Actions do PRÓPRIO tenant; artefatos ASSINADOS e
 * submit à loja permanecem gated por secrets que o tenant fornece (a Zentriz não guarda
 * credenciais nem dispara build). Não-mobile → null (não altera o caminho web/backend).
 */
export function getMobileBuildWorkflow(args: {
  projectType: string | null | undefined;
  runtimeTarget?: string | null;
  deliveryMode?: string | null;
  appName: string;
  apiUrl?: string | null;
}): { path: string; content: string } | null {
  const decision = validateDeployMatrix(args.projectType, args.runtimeTarget, args.deliveryMode);
  if (!decision.isMobile) return null;
  const delivery = "source_only" as const; // no accept, sempre o kit source_only (assinatura é gated)
  const { files } = decision.deliveryChannel === "eas"
    ? renderMobileEasBundle({ appName: args.appName, apiUrl: args.apiUrl ?? undefined, delivery })
    : renderMobileRncliBundle({ appName: args.appName, apiUrl: args.apiUrl ?? undefined, delivery });
  const wf = files.find((f) => f.path.startsWith(".github/workflows/"));
  return wf ? { path: wf.path, content: wf.content } : null;
}

// ── Deploy workflow templates ─────────────────────────────────────────────────

function getDeployWorkflow(provider: "aws" | "azure" | "gcp", repoName: string): string | null {
  if (provider === "aws") {
    return `name: Deploy to AWS ECS
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ secrets.AWS_REGION }}
      - uses: aws-actions/amazon-ecr-login@v2
      - name: Build and push image
        run: |
          IMAGE_URI=\${{ secrets.AWS_ECR_REGISTRY }}/${repoName}:\${{ github.sha }}
          docker build -t $IMAGE_URI apps/
          docker push $IMAGE_URI
      - name: Force new ECS deployment
        run: |
          aws ecs update-service \\
            --cluster \${{ secrets.AWS_ECS_CLUSTER }} \\
            --service ${repoName} \\
            --force-new-deployment \\
            --region \${{ secrets.AWS_REGION }}
`;
  }
  if (provider === "azure") {
    return `name: Deploy to Azure Container Apps
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_CREDENTIALS }}
      - name: Build and push to ACR
        run: |
          ACR=$(az acr list -g \${{ secrets.AZURE_RESOURCE_GROUP }} --query "[0].loginServer" -o tsv)
          az acr build --registry $ACR --image ${repoName}:\${{ github.sha }} apps/
      - name: Update Container App
        run: |
          ACR=$(az acr list -g \${{ secrets.AZURE_RESOURCE_GROUP }} --query "[0].loginServer" -o tsv)
          az containerapp update \\
            --name \${{ secrets.AZURE_CONTAINER_APP }} \\
            --resource-group \${{ secrets.AZURE_RESOURCE_GROUP }} \\
            --image $ACR/${repoName}:\${{ github.sha }}
`;
  }
  if (provider === "gcp") {
    return `name: Deploy to GCP Cloud Run
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: \${{ secrets.GCP_SA_KEY }}
      - uses: google-github-actions/setup-gcloud@v2
      - name: Build and push image
        run: |
          gcloud auth configure-docker gcr.io --quiet
          docker build -t gcr.io/\${{ secrets.GCP_PROJECT_ID }}/${repoName}:\${{ github.sha }} apps/
          docker push gcr.io/\${{ secrets.GCP_PROJECT_ID }}/${repoName}:\${{ github.sha }}
      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy ${repoName} \\
            --image gcr.io/\${{ secrets.GCP_PROJECT_ID }}/${repoName}:\${{ github.sha }} \\
            --region \${{ secrets.GCP_REGION }} \\
            --platform managed \\
            --allow-unauthenticated \\
            --project \${{ secrets.GCP_PROJECT_ID }}
`;
  }
  return null;
}
