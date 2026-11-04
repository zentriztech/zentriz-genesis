/**
 * lineage.ts — linhagem de versões de um projeto (evolução FT-10 / Evoluir via Bancada, E1).
 *
 * Princípio (plano Evoluir, 2026-09-04): uma evolução é uma nova VERSÃO do MESMO serviço. Logo a
 * identidade Connect (`systemId/serviceId`), o nome do repositório e a chave do Deadpool derivam da
 * RAIZ da linhagem — nunca do título do filho ("<pai> — Evolução vN"), que gerava serviço/repo/
 * registro novos a cada versão. O `/versions` antigo só subia 2 níveis (avô); aqui a CTE é
 * recursiva ASCENDENTE (qualquer profundidade), com guarda anti-ciclo.
 */
import type { Pool, PoolClient } from "pg";

export type LineageRoot = {
  id: string;
  title: string | null;
  product_id: string | null;
  depth: number; // 0 = o próprio projeto já é raiz
};

type Db = Pick<Pool | PoolClient, "query">;

/** Sobe `parent_project_id` até a raiz (profundidade ≤ 64). Devolve o próprio projeto se não tem pai. */
export async function resolveLineageRoot(db: Db, projectId: string): Promise<LineageRoot | null> {
  const res = await db.query(
    `WITH RECURSIVE up AS (
       SELECT id, title, product_id, parent_project_id, 0 AS depth, ARRAY[id] AS path
         FROM projects WHERE id = $1
       UNION ALL
       SELECT p.id, p.title, p.product_id, p.parent_project_id, up.depth + 1, up.path || p.id
         FROM projects p JOIN up ON p.id = up.parent_project_id
        WHERE up.depth < 64 AND NOT (p.id = ANY(up.path))
     )
     SELECT id, title, product_id, depth FROM up ORDER BY depth DESC LIMIT 1`,
    [projectId],
  );
  const row = res.rows[0] as { id: string; title: string | null; product_id: string | null; depth: number } | undefined;
  return row ? { id: row.id, title: row.title, product_id: row.product_id, depth: Number(row.depth) } : null;
}

export type LineageHead = {
  id: string;
  title: string | null;
  product_id: string | null;
  version_number: number;
  tenant_id: string | null;
};

/**
 * Versão CORRENTE do serviço (HEAD da linhagem) — regra única do claim do `/evolve` (Fase 1', 1.1):
 * entre os membros da linhagem (descendentes da raiz, profundidade ≤ 64) pega a de maior
 * `version_number` que esteja `accepted`, sem `extra.superseded_by` E SEM filho `accepted`.
 * A última cláusula fecha a janela de supersessão adiada (`evolution_push_pending`): filho já aceito
 * e pai ainda sem `superseded_by` ⇒ o HEAD é o filho, nunca os dois. `null` = sem versão aceita.
 */
export async function resolveLineageHead(db: Db, rootId: string): Promise<LineageHead | null> {
  const res = await db.query(
    `WITH RECURSIVE lin AS (
       SELECT id, title, product_id, tenant_id, parent_project_id, status, version_number, created_at, extra, 0 AS depth
         FROM projects WHERE id = $1
       UNION ALL
       SELECT p.id, p.title, p.product_id, p.tenant_id, p.parent_project_id, p.status, p.version_number, p.created_at, p.extra, l.depth + 1
         FROM projects p JOIN lin l ON p.parent_project_id = l.id
        WHERE l.depth < 64
     )
     SELECT l.id, l.title, l.product_id, l.tenant_id, l.version_number
       FROM lin l
      WHERE l.status = 'accepted'
        AND COALESCE(l.extra->>'superseded_by', '') = ''
        AND NOT EXISTS (SELECT 1 FROM lin c WHERE c.parent_project_id = l.id AND c.status = 'accepted')
      ORDER BY l.version_number DESC, l.created_at DESC
      LIMIT 1`,
    [rootId],
  );
  const r = res.rows[0] as { id: string; title: string | null; product_id: string | null; tenant_id: string | null; version_number: number } | undefined;
  return r ? { id: r.id, title: r.title, product_id: r.product_id, tenant_id: r.tenant_id, version_number: Number(r.version_number) } : null;
}

/**
 * Próximo número de versão da linhagem INTEIRA (M-02): `max(version_number)` das versões vivas (não `failed`/`archived`)
 * entre a raiz e todos os descendentes (profundidade ≤ 64) + 1. Substitui a contagem de dois níveis do
 * `createProjectFromSpec`, que errava em v1←v2←v3 e dava 409 determinístico (sem corrida) contra o índice
 * `uq_projects_parent_version_live`. Um número de tentativa `failed`/`archived` é reaproveitado (como no claim do /evolve).
 */
export async function nextLineageVersion(db: Db, rootId: string): Promise<number> {
  const res = await db.query(
    `WITH RECURSIVE lin AS (
       SELECT id, status, version_number, 0 AS depth FROM projects WHERE id = $1
       UNION ALL
       SELECT p.id, p.status, p.version_number, l.depth + 1
         FROM projects p JOIN lin l ON p.parent_project_id = l.id
        WHERE l.depth < 64
     )
     SELECT COALESCE(MAX(version_number) FILTER (WHERE status NOT IN ('failed', 'archived')), 0)::int AS max_version FROM lin`,
    [rootId],
  );
  return Number(res.rows[0]?.max_version ?? 0) + 1;
}

/**
 * Entradas de identidade para `deriveSystemService`: título e id da RAIZ (mesmo serviceId em todas
 * as versões). Para raiz sem pai devolve o próprio projeto — comportamento idêntico ao anterior.
 */
export async function identityInputsFor(db: Db, projectId: string, fallbackTitle: string | null): Promise<{ title: string | null; projectId: string; rootId: string; isEvolution: boolean }> {
  const root = await resolveLineageRoot(db, projectId).catch(() => null);
  if (!root || root.id === projectId) return { title: fallbackTitle, projectId, rootId: projectId, isEvolution: false };
  return { title: root.title ?? fallbackTitle, projectId: root.id, rootId: root.id, isEvolution: true };
}
