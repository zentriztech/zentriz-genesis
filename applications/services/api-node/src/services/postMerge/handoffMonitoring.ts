/**
 * handoffMonitoring.ts — Bloco 4 (M3): migra o monitoramento Auto Care do PAI (versão arquivada) para
 * o FILHO (versão mergeada em `dev`), sem perder histórico. Roda na API atrás da flag
 * `EVOLUTION_POST_MERGE_REALIGN` (mesma do realinhamento; checada pelo orquestrador de hooks).
 *
 * A chave do Deadpool (systemId/serviceId) é a MESMA em toda a linhagem (derivada da raiz — ver
 * lineage.ts), então o Deadpool faz MERGE na mesma entrada do registry: muda o `local_path` para o do
 * filho e o `branch` para `dev`. O histórico do Deadpool (incidents/history/KB) é chaveado por
 * `service_name`/`incident_id`, NÃO por `project_id` → nada se perde ao migrar a linha do registry.
 *
 * Genesis side (project_deadpool_monitoring): copia a linha do pai para o filho (rastreando
 * `migrated_from_project_id`) e desativa a do pai (`migrated_to_project_id`, `last_error='superseded_by:<child>'`).
 * Idempotente (GAP 14): grava `evolution_monitoring_handoff_at` uma vez; re-execução é no-op.
 * Best-effort: nunca lança para fora.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Pool } from "pg";
import { registerProjectWithDeadpool } from "../githubPush.js";

type Db = Pick<Pool, "query">;
const PROJECT_FILES_ROOT = (process.env.PROJECT_FILES_ROOT ?? "/shared/uploads").trim();

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

/**
 * Migra o monitoramento do pai para o filho e reenvia o registro ao Deadpool com `branch:"dev"`.
 */
export async function handoffMonitoring(db: Db, childId: string): Promise<void> {
  const row = (await db.query(
    `SELECT c.parent_project_id, c.extra, c.tenant_id,
            r.repo_full_name,
            gi.installation_id,
            pm.active AS parent_active, pm.system_id, pm.service_id
       FROM projects c
       LEFT JOIN project_github_repos r ON r.project_id = c.id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = c.tenant_id
       LEFT JOIN project_deadpool_monitoring pm ON pm.project_id = c.parent_project_id
      WHERE c.id = $1`,
    [childId],
  )).rows[0] as {
    parent_project_id: string | null;
    extra: Record<string, unknown> | null;
    tenant_id: string | null;
    repo_full_name: string | null;
    installation_id: number | string | null;
    parent_active: boolean | null;
    system_id: string | null;
    service_id: string | null;
  } | undefined;
  if (!row) return;
  const extra = row.extra ?? {};
  if (extra.evolution_monitoring_handoff_at) return; // idempotente

  const now = new Date().toISOString();
  const parentId = row.parent_project_id;
  // Sem pai OU pai sem linha de monitoramento → nada a migrar (evolução da raiz, ou monitoramento nunca ativado).
  if (!parentId || row.parent_active == null) {
    await persist(db, childId, { evolution_monitoring_handoff_at: now, evolution_monitoring_handoff_state: "skipped_no_parent_monitoring" });
    return;
  }

  // 1. Copia a linha do pai para o filho (rastreando a origem). ON CONFLICT: atualiza sem apagar histórico local.
  await db.query(
    `INSERT INTO project_deadpool_monitoring
       (project_id, active, system_id, service_id, activated_by, activated_at, last_registered_at, migrated_from_project_id,
        monitor_provider, azure_workspace_id, azure_table, azure_message_column, gcp_project_id, gcp_log_filter)
     SELECT $1, active, system_id, service_id, activated_by, activated_at, now(), $2,
            monitor_provider, azure_workspace_id, azure_table, azure_message_column, gcp_project_id, gcp_log_filter
       FROM project_deadpool_monitoring WHERE project_id = $2
     ON CONFLICT (project_id) DO UPDATE SET
       active = EXCLUDED.active, system_id = EXCLUDED.system_id, service_id = EXCLUDED.service_id,
       activated_by = EXCLUDED.activated_by, activated_at = EXCLUDED.activated_at,
       last_registered_at = now(), migrated_from_project_id = EXCLUDED.migrated_from_project_id,
       monitor_provider = EXCLUDED.monitor_provider, azure_workspace_id = EXCLUDED.azure_workspace_id,
       azure_table = EXCLUDED.azure_table, azure_message_column = EXCLUDED.azure_message_column,
       gcp_project_id = EXCLUDED.gcp_project_id, gcp_log_filter = EXCLUDED.gcp_log_filter,
       deactivated_at = NULL, updated_at = now()`,
    [childId, parentId],
  );

  // 2. Desativa o pai (mantém a linha para auditoria; o histórico do Deadpool é independente).
  await db.query(
    `UPDATE project_deadpool_monitoring
        SET active = false, deactivated_at = now(), last_error = $2, migrated_to_project_id = $1, updated_at = now()
      WHERE project_id = $3`,
    [childId, `superseded_by:${childId}`, parentId],
  );

  // 3. Reenvia ao Deadpool com a MESMA chave + local_path do filho + branch 'dev'. Best-effort (não lança).
  const installationId = row.installation_id != null ? Number(row.installation_id) : null;
  if (installationId && row.repo_full_name && row.system_id) {
    const localApps = join(PROJECT_FILES_ROOT, childId, "apps");
    await registerProjectWithDeadpool({
      systemId: row.system_id,
      serviceId: row.service_id,
      repoUrl: `https://github.com/${row.repo_full_name}`,
      installationId,
      localPath: existsSync(join(localApps, ".git")) ? localApps : null,
      branch: "dev",
      monitoring: row.parent_active === true,
    }).catch(() => undefined);
  }

  await persist(db, childId, { evolution_monitoring_handoff_at: now, evolution_monitoring_handoff_state: "done" });
  await logDialogue(db, childId,
    `✅ Monitoramento Auto Care migrado da versão anterior para esta versão (chave ${row.system_id}/${row.service_id ?? "*"}, branch 'dev').`);
}
