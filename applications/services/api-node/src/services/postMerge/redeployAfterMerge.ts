/**
 * redeployAfterMerge.ts — Bloco 4 (M6): redeploy in-place da nova versão com a MESMA identidade de
 * nuvem da linhagem, logo após o merge de `evolution/vN → dev`. Roda na API atrás da flag
 * `EVOLUTION_AUTO_REDEPLOY` (checada pelo orquestrador de hooks).
 *
 * Princípio: a identidade cloud da linhagem já é única por construção (recursos nomeados pela raiz —
 * ver deployTargets/lineage). O hook NUNCA cria o PRIMEIRO deploy sozinho: só redeploya se a linhagem
 * já tinha um deploy 'deployed'. Herda a conexão e o formato do deploy anterior; se o anterior era uma
 * demo com prazo, herda `expires_at`/`consented_teardown` (é o contrato aceito pelo tenant) e encadeia
 * (o novo `supersedes` o anterior; o teardownExpired ignora o anterior — os recursos são do novo).
 *
 * Idempotente (GAP 14): grava `evolution_redeploy_at` uma vez; re-execução é no-op.
 * Best-effort: nunca lança para fora (o merge já aconteceu e não pode ser desfeito por um hook).
 */
import type { Pool } from "pg";
import { resolveLineageRoot } from "../lineage.js";
import { getCloudConnection } from "../cloudConnector.js";
import { startCloudDeploy } from "../provision/cloudDeploy.js";
import type { DeployFormat } from "../provision/deployTargets.js";

type Db = Pick<Pool, "query">;

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

interface PrevDeploy {
  id: string;
  connection_id: string | null;
  deploy_format: string;
  expires_at: string | null;
  consented_teardown: boolean;
}

/**
 * Redeploya a nova versão com a identidade da linhagem. `mergeSha` é o SHA do merge em `dev` — o
 * deploy é carimbado com ele (rastreabilidade + rollback futuro por SHA).
 */
export async function redeployAfterMerge(db: Db, childId: string, mergeSha?: string): Promise<void> {
  const child = (await db.query(
    "SELECT tenant_id, parent_project_id, extra FROM projects WHERE id = $1",
    [childId],
  )).rows[0] as { tenant_id: string | null; parent_project_id: string | null; extra: Record<string, unknown> | null } | undefined;
  if (!child) return;
  const extra = child.extra ?? {};
  if (extra.evolution_redeploy_at) return; // idempotente
  const now = new Date().toISOString();
  const tenantId = child.tenant_id;
  if (!tenantId) {
    await persist(db, childId, { evolution_redeploy_at: now, evolution_redeploy_state: "skipped_no_tenant" });
    return;
  }

  // Prev = último deploy 'deployed' da MESMA linhagem. Preferência: lineage_root_id (M5); fallback
  // (linhas antigas sem lineage): project_id do filho/pai/raiz. Nunca criamos o 1º deploy sozinho.
  const root = await resolveLineageRoot(db, childId).catch(() => null);
  const rootId = root?.id ?? childId;
  const ids = [childId, child.parent_project_id, rootId].filter((x): x is string => !!x);
  const prev = (await db.query(
    `SELECT id, connection_id, deploy_format, expires_at, consented_teardown
       FROM cloud_deployments
      WHERE status = 'deployed'
        AND (lineage_root_id = $1 OR project_id = ANY($2::uuid[]))
      ORDER BY created_at DESC LIMIT 1`,
    [rootId, ids],
  )).rows[0] as PrevDeploy | undefined;

  if (!prev || !prev.connection_id) {
    // Sem deploy anterior na nuvem → nada a redeployar (o tenant nunca fez deploy desta linhagem).
    await persist(db, childId, { evolution_redeploy_at: now, evolution_redeploy_state: "skipped_no_prev" });
    return;
  }

  // Conexão precisa estar ATIVA (getCloudConnection só devolve status='active'). Revogada → bloqueia.
  const conn = await getCloudConnection(tenantId, prev.connection_id).catch(() => null);
  if (!conn) {
    await persist(db, childId, { evolution_redeploy_at: now, evolution_redeploy_state: "blocked_connection" });
    await logDialogue(db, childId,
      "⚠️ Redeploy pós-merge bloqueado: a conexão de nuvem usada na versão anterior não está mais ativa. Reative a conexão e deploye manualmente.");
    return;
  }

  // Demo com prazo → herda o contrato aceito pelo tenant (expira junto, teardown consentido).
  const inheritsDemo = prev.expires_at != null;
  const expiresAt = inheritsDemo ? new Date(prev.expires_at as string) : null;
  const consentedTeardown = inheritsDemo ? prev.consented_teardown === true : false;

  const result = await startCloudDeploy({
    projectId: childId,
    tenantId,
    userId: null,
    connectionId: prev.connection_id,
    format: prev.deploy_format as DeployFormat,
    expiresAt,
    consentedTeardown,
    branch: "dev",              // pós-merge o código canônico vive em 'dev'
    gitSha: mergeSha ?? null,    // deploy exatamente o SHA do merge
    triggerKind: "evolution_merge",
    supersedesId: prev.id,       // encadeia + marca o anterior como superseded (teardown o ignora)
  });

  if (result.ok) {
    await persist(db, childId, {
      evolution_redeploy_at: now, evolution_redeploy_state: "dispatched",
      evolution_redeploy_id: result.deploymentId,
    });
    await logDialogue(db, childId,
      `🚀 Redeploy pós-merge disparado com a mesma identidade (${result.provider}/${result.format}, branch 'dev', SHA ${mergeSha ? mergeSha.slice(0, 8) : "HEAD"}). Substitui o deploy anterior da linhagem.`);
  } else {
    await persist(db, childId, {
      evolution_redeploy_at: now, evolution_redeploy_state: `failed:${result.code}`,
    });
    await logDialogue(db, childId,
      `⚠️ Redeploy pós-merge não iniciou (${result.code}): ${result.message}`);
  }
}
