/**
 * A4.2 — declara a LINHAGEM de projetos que são VERSÕES do mesmo aplicativo.
 *
 * PROBLEMA MEDIDO EM PROD (2026-09-05/06): o produto "OrienteMe" tem **9 projetos** `accepted`
 * (V5…V13, criados em 2026-07-03/04) que não são 9 aplicações — são 9 VERSÕES do mesmo app.
 * Nenhum tem `parent_project_id` nem `extra.superseded_by`, então todo lugar que conta "projetos
 * vivos do produto" conta 9: o Mapa do Produto do CTO (`productContext.ts:168` filtra justamente
 * `COALESCE(p.extra->>'superseded_by','') = ''`), a listagem de projetos, o agregado do
 * certificado e o grafo. O CTO recebe nove contextos concorrentes da MESMA aplicação.
 *
 * O caminho normal de supersessão é o `evolutionAccept.ts` (aceitar uma evolução arquiva o pai e
 * grava `superseded_by`). Estes 9 nasceram antes desse fluxo, por importação — não há evolução a
 * aceitar. Daí este script: escreve a MESMA forma de dado que o fluxo normal escreveria.
 *
 * ⚠️ É UPDATE DE DADOS EM PROD, não código: por decisão do plano mestre (Onda 4 / A4.2) só roda
 * com OK explícito do Jean. Por isso: DRY-RUN por default, cadeia com ids EXPLÍCITOS na linha de
 * comando (nunca "descobre sozinho" quem arquivar), backup das linhas afetadas numa tabela antes
 * de qualquer UPDATE, e uma única transação.
 *
 * FORMA DO DADO (idêntica ao `evolutionAccept.ts` passo 3 + registro no filho):
 *   • cada projeto da cadeia, menos o último: `status='archived'`,
 *     `extra.superseded_by=<próximo>`, `extra.superseded_at=<agora>`, `extra.superseded_version=<n+1>`;
 *   • cada projeto, menos o primeiro: `extra.supersedes=<anterior>`, `extra.lineage_version=<n>`;
 *   • o ÚLTIMO da cadeia é a versão corrente: fica como está (nada é arquivado).
 * `parent_project_id` NÃO é tocado: ele significa "nasceu de uma evolução deste pai", o que não
 * aconteceu aqui — inventar essa aresta faria a herança do runner (H6) buscar tasks que não existem.
 *
 * Uso (no container da api em PROD, com o JS compilado):
 *   node dist/db/link-project-lineage.js --chain <id1>,<id2>,…,<idN>            # DRY-RUN
 *   node dist/db/link-project-lineage.js --chain <id1>,<id2>,…,<idN> --commit   # aplica
 *
 * A cadeia é ordenada da versão MAIS ANTIGA para a MAIS NOVA (a última é a corrente).
 * Idempotente: linha que já tem `superseded_by` não é tocada; reexecutar é no-op.
 * Rollback: a tabela `projects_lineage_backup_<timestamp>` guarda `id, status, extra` de todas as
 * linhas da cadeia como estavam antes (o script imprime o UPDATE de volta).
 */
import { pool } from "./client.js";

interface Row { id: string; title: string; status: string; extra: Record<string, unknown> | null }

function parseChain(argv: string[]): string[] {
  const i = argv.indexOf("--chain");
  if (i < 0 || !argv[i + 1]) return [];
  const ids = argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of ids) {
    if (!uuid.test(id)) throw new Error(`id fora do formato uuid na cadeia: ${id}`);
  }
  if (new Set(ids).size !== ids.length) throw new Error("a cadeia tem id repetido");
  return ids;
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const chain = parseChain(process.argv);
  if (chain.length < 2) {
    console.error("uso: node dist/db/link-project-lineage.js --chain <id-antigo>,…,<id-corrente> [--commit]");
    process.exit(2);
  }
  console.log(`[lineage] modo = ${commit ? "COMMIT" : "DRY-RUN"} | ${chain.length} projetos na cadeia`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = (await client.query<Row>(
      "SELECT id, title, status, extra FROM projects WHERE id = ANY($1::uuid[])",
      [chain],
    )).rows;
    if (rows.length !== chain.length) {
      const faltando = chain.filter((id) => !rows.some((r) => r.id === id));
      throw new Error(`projeto(s) não encontrado(s): ${faltando.join(", ")}`);
    }
    // Um tenant só: encadear projetos de tenants diferentes vazaria contexto entre clientes.
    const tenants = (await client.query<{ tenant_id: string }>(
      "SELECT DISTINCT tenant_id FROM projects WHERE id = ANY($1::uuid[])", [chain],
    )).rows;
    if (tenants.length !== 1) throw new Error(`a cadeia atravessa ${tenants.length} tenants — recusado`);

    const byId = new Map(rows.map((r) => [r.id, r]));
    const plano: Array<{ id: string; title: string; de: string; para: string; nota: string }> = [];
    for (let n = 0; n < chain.length; n += 1) {
      const r = byId.get(chain[n]) as Row;
      const ex = (r.extra ?? {}) as Record<string, unknown>;
      const jaTem = String(ex.superseded_by ?? "") !== "";
      const ultimo = n === chain.length - 1;
      plano.push({
        id: r.id, title: r.title, de: r.status,
        para: ultimo ? r.status : jaTem ? r.status : "archived",
        nota: ultimo ? "versão CORRENTE (não arquiva)"
          : jaTem ? `já tem superseded_by=${String(ex.superseded_by).slice(0, 8)} → não toca`
            : `superseded_by → ${chain[n + 1].slice(0, 8)} (v${n + 2})`,
      });
    }
    for (const p of plano) {
      console.log(`  • ${p.title.padEnd(20)} ${p.id.slice(0, 8)}  ${p.de} → ${p.para}   ${p.nota}`);
    }

    if (!commit) {
      await client.query("ROLLBACK");
      console.log("[lineage] DRY-RUN — nada gravado. Reexecute com --commit (exige OK do Jean).");
      return;
    }

    // Backup ANTES de qualquer UPDATE: linhas exatas, com `extra` original.
    const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const backup = `projects_lineage_backup_${stamp}`;
    await client.query(
      `CREATE TABLE ${backup} AS SELECT id, status, extra, now() AS backed_up_at
         FROM projects WHERE id = ANY($1::uuid[])`,
      [chain],
    );
    console.log(`[lineage] backup em ${backup} (${chain.length} linhas)`);

    const now = new Date().toISOString();
    let arquivados = 0;
    let marcados = 0;
    for (let n = 0; n < chain.length; n += 1) {
      const id = chain[n];
      if (n < chain.length - 1) {
        // Guarda de concorrência: só arquiva o que ainda não foi arquivado por outro caminho.
        const res = await client.query(
          `UPDATE projects
              SET status = 'archived',
                  extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb,
                  updated_at = now()
            WHERE id = $1 AND COALESCE(extra->>'superseded_by','') = ''
            RETURNING id`,
          [id, JSON.stringify({
            superseded_by: chain[n + 1], superseded_at: now, superseded_version: n + 2,
            superseded_reason: "backfill A4.2 — versões do mesmo app importadas antes do fluxo de evolução",
          })],
        );
        arquivados += res.rowCount ?? 0;
      }
      if (n > 0) {
        const res = await client.query(
          `UPDATE projects
              SET extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now()
            WHERE id = $1 AND COALESCE(extra->>'supersedes','') = ''`,
          [id, JSON.stringify({ supersedes: chain[n - 1], lineage_version: n + 1 })],
        );
        marcados += res.rowCount ?? 0;
      }
    }
    await client.query("COMMIT");
    console.log(`[lineage] COMMIT — arquivados=${arquivados} marcados_supersedes=${marcados}`);
    console.log(`[lineage] rollback: UPDATE projects p SET status=b.status, extra=b.extra `
      + `FROM ${backup} b WHERE p.id=b.id;`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

// `import`ável nos testes sem disparar nada (o teste cobre `parseChain`).
if (process.argv[1] && process.argv[1].includes("link-project-lineage")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { parseChain };
