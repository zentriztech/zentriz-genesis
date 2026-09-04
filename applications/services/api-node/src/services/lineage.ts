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

/**
 * Entradas de identidade para `deriveSystemService`: título e id da RAIZ (mesmo serviceId em todas
 * as versões). Para raiz sem pai devolve o próprio projeto — comportamento idêntico ao anterior.
 */
export async function identityInputsFor(db: Db, projectId: string, fallbackTitle: string | null): Promise<{ title: string | null; projectId: string; rootId: string; isEvolution: boolean }> {
  const root = await resolveLineageRoot(db, projectId).catch(() => null);
  if (!root || root.id === projectId) return { title: fallbackTitle, projectId, rootId: projectId, isEvolution: false };
  return { title: root.title ?? fallbackTitle, projectId: root.id, rootId: root.id, isEvolution: true };
}
