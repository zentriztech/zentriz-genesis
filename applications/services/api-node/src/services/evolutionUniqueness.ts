/**
 * evolutionUniqueness.ts — índices parciais de unicidade do fluxo "Evoluir projeto" (Fase 1', tarefa 1.2;
 * desenho H §3). Passo de BOOT em TypeScript, não migration `.sql`:
 *   • o runner de migrations (db/init.ts) não usa transação e a API PARA se uma instrução falha — um
 *     `CREATE UNIQUE INDEX` sobre banco com duplicata derrubaria a subida em crash-loop;
 *   • aqui cada índice tem PRÉ-CHECAGEM do próprio predicado: banco limpo ⇒ cria; banco sujo ⇒ NÃO cria,
 *     loga erro estruturado, soma no contador e a API sobe (o claim segue protegido pelo advisory lock).
 * Sem `CONCURRENTLY` de propósito: tabelas pequenas (prod: 62 projetos, 0 tickets) e `IF NOT EXISTS` mascararia
 * um índice INVALID deixado por uma criação concorrente interrompida. Índice já existente porém INVÁLIDO é
 * reportado (não recriado automaticamente).
 *
 * Idempotente: segunda execução é no-op. Rollback: `DROP INDEX IF EXISTS <nome>` (ver `UNIQUENESS_INDEXES`).
 */
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

export interface UniquenessIndexDef {
  name: string;
  /** DDL exato do desenho H §3.1. */
  createSql: string;
  /** Devolve os GRUPOS que violariam o índice (vazio = limpo). Só ids/números, nunca PII. */
  dirtySql: string;
  description: string;
}

export const UNIQUENESS_INDEXES: readonly UniquenessIndexDef[] = [
  {
    name: "uq_projects_parent_version_live",
    description: "uma versão viva por (pai, número); failed/archived guardam o número sem bloquear o retry",
    createSql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_parent_version_live
  ON projects (parent_project_id, version_number)
  WHERE parent_project_id IS NOT NULL AND status NOT IN ('failed', 'archived')`,
    dirtySql: `SELECT parent_project_id::text AS k1, version_number::text AS k2, count(*)::int AS n
  FROM projects
 WHERE parent_project_id IS NOT NULL AND status NOT IN ('failed', 'archived')
 GROUP BY parent_project_id, version_number HAVING count(*) > 1 LIMIT 5`,
  },
  {
    name: "uq_projects_one_live_evolution_child",
    description: "um filho de EVOLUÇÃO vivo (não terminal) por pai — mesma semântica do guard EVOLUTION_IN_FLIGHT",
    createSql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_one_live_evolution_child
  ON projects (parent_project_id)
  WHERE parent_project_id IS NOT NULL AND (extra->>'evolution') = 'true'
    AND status NOT IN ('accepted', 'archived', 'failed')`,
    dirtySql: `SELECT parent_project_id::text AS k1, NULL::text AS k2, count(*)::int AS n
  FROM projects
 WHERE parent_project_id IS NOT NULL AND (extra->>'evolution') = 'true'
   AND status NOT IN ('accepted', 'archived', 'failed')
 GROUP BY parent_project_id HAVING count(*) > 1 LIMIT 5`,
  },
  {
    name: "uq_projects_ticket_live",
    description: "um filho vivo por ticket (chave de idempotência do /evolve)",
    createSql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_ticket_live
  ON projects ((extra->>'ticket_id'))
  WHERE (extra->>'ticket_id') IS NOT NULL AND status NOT IN ('failed', 'archived')`,
    dirtySql: `SELECT (extra->>'ticket_id') AS k1, NULL::text AS k2, count(*)::int AS n
  FROM projects
 WHERE (extra->>'ticket_id') IS NOT NULL AND status NOT IN ('failed', 'archived')
 GROUP BY (extra->>'ticket_id') HAVING count(*) > 1 LIMIT 5`,
  },
  {
    name: "uq_projects_evolve_idem_live",
    description: "Idempotency-Key do /evolve sem ticket, por tenant",
    createSql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_evolve_idem_live
  ON projects (tenant_id, (extra->>'evolve_idempotency_key'))
  WHERE (extra->>'evolve_idempotency_key') IS NOT NULL AND status NOT IN ('failed', 'archived')`,
    // a chave é um valor do cliente: não vai para o log (só o tenant e a contagem)
    dirtySql: `SELECT tenant_id::text AS k1, NULL::text AS k2, count(*)::int AS n
  FROM projects
 WHERE (extra->>'evolve_idempotency_key') IS NOT NULL AND status NOT IN ('failed', 'archived')
 GROUP BY tenant_id, (extra->>'evolve_idempotency_key') HAVING count(*) > 1 LIMIT 5`,
  },
  {
    name: "uq_tickets_child_live",
    description: "ticket aponta para no máximo um filho vivo (inverso de uq_projects_ticket_live)",
    createSql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_child_live
  ON tickets (child_project_id)
  WHERE child_project_id IS NOT NULL AND status IN ('promoted', 'delivered')`,
    dirtySql: `SELECT child_project_id::text AS k1, NULL::text AS k2, count(*)::int AS n
  FROM tickets
 WHERE child_project_id IS NOT NULL AND status IN ('promoted', 'delivered')
 GROUP BY child_project_id HAVING count(*) > 1 LIMIT 5`,
  },
] as const;

export interface UniquenessReport {
  created: string[];
  existing: string[];
  dirty: Array<{ index: string; groups: Array<{ k1: string | null; k2: string | null; n: number }> }>;
  invalid: string[];
  errors: Array<{ index: string; error: string }>;
}

/** Contadores do processo (sem lib de métricas no api-node): lidos por `getUniquenessCounters()` e pelos testes. */
const counters = { runs: 0, created: 0, dirty: 0, invalid: 0, errors: 0 };
export function getUniquenessCounters(): Readonly<typeof counters> {
  return { ...counters };
}
export function resetUniquenessCountersForTest(): void {
  counters.runs = counters.created = counters.dirty = counters.invalid = counters.errors = 0;
}

type LogFn = (line: string) => void;

export async function ensureEvolutionUniqueness(
  db: Queryable,
  logger: { error: LogFn; info: LogFn } = { error: (l) => console.error(l), info: (l) => console.log(l) },
): Promise<UniquenessReport> {
  counters.runs++;
  const report: UniquenessReport = { created: [], existing: [], dirty: [], invalid: [], errors: [] };
  for (const def of UNIQUENESS_INDEXES) {
    try {
      const ex = await db.query(
        `SELECT i.indisvalid AS valid
           FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = $1 AND c.relkind = 'i'`,
        [def.name],
      );
      if (ex.rows[0]) {
        if (ex.rows[0].valid === false) {
          report.invalid.push(def.name);
          counters.invalid++;
          logger.error(JSON.stringify({ level: "error", event: "evolution_uniqueness_index_invalid", index: def.name,
            action: "DROP INDEX e reiniciar a api para recriar" }));
        } else {
          report.existing.push(def.name);
        }
        continue;
      }
      const dirty = await db.query(def.dirtySql);
      if (dirty.rows.length > 0) {
        const groups = dirty.rows.map((r) => ({ k1: (r.k1 as string | null) ?? null, k2: (r.k2 as string | null) ?? null, n: Number(r.n) }));
        report.dirty.push({ index: def.name, groups });
        counters.dirty++;
        logger.error(JSON.stringify({
          level: "error", event: "evolution_uniqueness_dirty", index: def.name, groupsSample: groups.length,
          sample: groups.slice(0, 3),
          msg: "banco com duplicatas: índice NÃO criado; a api sobe e o claim do /evolve segue protegido só pelo advisory lock. Resolver as duplicatas e reiniciar.",
        }));
        continue;
      }
      await db.query(def.createSql);
      report.created.push(def.name);
      counters.created++;
      logger.info(JSON.stringify({ level: "info", event: "evolution_uniqueness_index_created", index: def.name }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      report.errors.push({ index: def.name, error });
      counters.errors++;
      logger.error(JSON.stringify({ level: "error", event: "evolution_uniqueness_error", index: def.name, error }));
    }
  }
  return report;
}

/** `23505` do índice de versão (POST /api/specs com parentProjectId e /evolve legado) — para mapear em 409. */
export function isVersionConflict(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return !!err && err.code === "23505" && (err.constraint === "uq_projects_parent_version_live");
}
/** `23505` de qualquer um dos índices de unicidade do /evolve. */
export function isEvolutionUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return !!err && err.code === "23505" && UNIQUENESS_INDEXES.some((d) => d.name === err.constraint);
}
