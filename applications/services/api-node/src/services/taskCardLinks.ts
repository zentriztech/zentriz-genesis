/**
 * taskCardLinks.ts — tarefa 2.3 da Fase 2 (plano EVOLUIR-PROJETO-BANCADA v2): LEITURA do vínculo task → card.
 *
 * `project_tasks.card_id` e `project_tasks.origin_spec_file` (migration 150) são nuláveis; quem as preenche é o runner na
 * Fase 4 (tarefa 4.2) — o formato do `task_id` e o regex de backlog do runner NÃO mudam. Aqui só se lê, e só com a flag
 * `CARDS_BANCADA` ligada para o tenant do projeto: com a flag desligada a resposta de `GET /api/projects/:id/tasks`
 * é byte-idêntica à de antes (as colunas novas nem são consultadas).
 */
import { flagEnabled, tenantOfProject } from "./featureFlags.js";
import type { RuntimeConfigDb } from "./runtimeTunables.js";

export interface TaskCardLink { cardId: string | null; originSpecFile: string | null }

/** `null` = flag desligada (não consulta as colunas novas). Mapa por `project_tasks.id`. */
export async function loadTaskCardLinksIfEnabled(db: RuntimeConfigDb, projectId: string): Promise<Map<string, TaskCardLink> | null> {
  const tenantId = await tenantOfProject(db, projectId);
  if (!(await flagEnabled(db, "CARDS_BANCADA", tenantId))) return null;
  const r = await db.query("SELECT id, card_id, origin_spec_file FROM project_tasks WHERE project_id = $1", [projectId]);
  const m = new Map<string, TaskCardLink>();
  for (const row of r.rows) {
    m.set(String(row.id), {
      cardId: row.card_id ? String(row.card_id) : null,
      originSpecFile: row.origin_spec_file ? String(row.origin_spec_file) : null,
    });
  }
  return m;
}
