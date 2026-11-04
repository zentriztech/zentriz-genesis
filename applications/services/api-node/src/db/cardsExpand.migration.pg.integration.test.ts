/**
 * Fase 2 / 2.1–2.3 — migrations expand 148/149/150 em Postgres REAL (banco descartável): idempotência (reaplicar os arquivos
 * não falha nem perde dados), colunas/CHECKs/índices esperados, `tickets.status` intacto, índice de boot `uq_tickets_draft`,
 * e o regex de ID de task do runner inalterado (2.3).
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type pg from "pg";
import { describePg, createScratchDb, dbClientMock, seedAcceptedProduct, seedTicket, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());

import { ensureEvolutionUniqueness, UNIQUENESS_INDEXES } from "../services/evolutionUniqueness.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = join(here, "migrations");
const FILES = readdirSync(MIG).filter((f) => /^(148|149|150)_.*\.sql$/.test(f)).sort();

/** Mesmo split do runner (db/init.ts): remove linhas de comentário e divide por ponto e vírgula. */
function statementsOf(sql: string): string[] {
  return sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean);
}

describePg("Fase 2 — migrations expand 148/149/150 (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let s: Seed;

  beforeAll(async () => {
    scratch = await createScratchDb("evo_mig");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    s = await seedAcceptedProduct(pool, { budgetUsd: 10 });
  }, 120_000);
  afterAll(async () => { s?.cleanup(); await scratch?.drop(); });

  it("os três arquivos existem e respeitam as regras do runner (sem DO, sem ponto e vírgula em literal ou comentário)", () => {
    expect(FILES).toEqual(["148_cards_expand.sql", "149_project_spec_files_origin.sql", "150_project_tasks_card.sql"]);
    for (const f of FILES) {
      const sql = readFileSync(join(MIG, f), "utf-8");
      expect(/\bDO\s+\$\$/i.test(sql), f).toBe(false);
      // comentários não podem conter ';' (o runner descarta a linha inteira, mas o espelho mais seguro é não ter)
      for (const l of sql.split("\n").filter((x) => x.trim().startsWith("--"))) expect(l.includes(";"), `${f}: ${l}`).toBe(false);
      // nenhum literal de string com ';'
      for (const m of sql.matchAll(/'([^']*)'/g)) expect(m[1].includes(";"), `${f}: ${m[0]}`).toBe(false);
    }
  });

  it("idempotente: reaplicar 148–150 duas vezes não falha e preserva dados já gravados nas colunas novas", async () => {
    const t = await seedTicket(pool, s);
    await pool.query(`UPDATE tickets SET card_state = 'draft', card_contract_version = 1, origin = 'import', external_ref = 'x-1' WHERE id = $1`, [t.id]);
    await pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, spec_origin) VALUES ($1,'z.md','/tmp/z.md','card:TK-0001')`, [s.parentId]);
    for (let round = 0; round < 2; round++) {
      for (const f of FILES) for (const st of statementsOf(readFileSync(join(MIG, f), "utf-8"))) await pool.query(st);
    }
    const after = (await pool.query("SELECT card_state, card_contract_version, origin, external_ref, status FROM tickets WHERE id = $1", [t.id])).rows[0];
    expect(after).toEqual({ card_state: "draft", card_contract_version: 1, origin: "import", external_ref: "x-1", status: "open" });
    expect((await pool.query("SELECT spec_origin FROM project_spec_files WHERE filename = 'z.md'")).rows[0].spec_origin).toBe("card:TK-0001");
  });

  it("esquema esperado: colunas novas nulas/default, tickets.status sem constraint nova, tabela de eventos e índices", async () => {
    const cols = async (table: string) => Object.fromEntries((await pool.query(
      "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1", [table])).rows.map((r) => [r.column_name, r]));
    const t = await cols("tickets");
    for (const c of ["card_state", "blocked_reason", "external_ref", "draft_project_id", "card_contract_version"]) expect(t[c].is_nullable, c).toBe("YES");
    expect(t.origin).toMatchObject({ is_nullable: "NO" });
    expect(String(t.origin.column_default)).toContain("manual");
    const f = await cols("project_spec_files");
    for (const c of ["spec_origin", "executed_in_project", "executed_at"]) expect(f[c].is_nullable, c).toBe("YES");
    const pt = await cols("project_tasks");
    for (const c of ["card_id", "origin_spec_file"]) expect(pt[c].is_nullable, c).toBe("YES");
    const cons = (await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'tickets'::regclass AND contype = 'c'")).rows.map((r) => r.conname).sort();
    expect(cons).toEqual(["tickets_blocked_reason_check", "tickets_card_state_check", "tickets_origin_check"]); // nenhuma CHECK em status
    const idx = (await pool.query("SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_tce_ticket','uq_tce_dedupe','idx_tickets_card_state','idx_project_tasks_card','idx_project_spec_files_origin')")).rows;
    expect(idx).toHaveLength(5);
    // spec_origin: só initial ou card:<código>
    let n = 0;
    const bad = async (v: string) => { try { await pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, spec_origin) VALUES ($1,$3,'/tmp/b.md',$2)`, [s.parentId, v, `bad${n++}.md`]); return null; } catch (e) { return (e as { constraint?: string }).constraint; } };
    expect(await bad("card:TK-0002")).toBeNull();
    expect(await bad("initial")).toBeNull();
    expect(await bad("outro")).toBe("project_spec_files_spec_origin_check");
    expect(await bad("card:")).toBe("project_spec_files_spec_origin_check");
  });

  it("legado intacto: ticket legado sem colunas novas continua com os 4 status e defaults; project_tasks.task_id aceita o formato atual", async () => {
    const t = await seedTicket(pool, s);
    expect((await pool.query("SELECT status, card_state, origin, blocked_reason, draft_project_id FROM tickets WHERE id = $1", [t.id])).rows[0])
      .toEqual({ status: "open", card_state: null, origin: "manual", blocked_reason: null, draft_project_id: null });
    for (const st of ["promoted", "delivered", "rejected", "open"]) await pool.query("UPDATE tickets SET status = $2 WHERE id = $1", [t.id, st]);
    await pool.query(`INSERT INTO project_tasks (project_id, task_id, module, owner_role) VALUES ($1,'TSK-INH-V1-TSK-BE-001','backend','DEV')`, [s.parentId]);
    expect((await pool.query("SELECT card_id, origin_spec_file FROM project_tasks WHERE task_id = 'TSK-INH-V1-TSK-BE-001'")).rows[0]).toEqual({ card_id: null, origin_spec_file: null });
  });

  it("índice de boot uq_tickets_draft: criado pelo passo de boot, 23505 em rascunho repetido, sujo ⇒ não cria e reporta", async () => {
    expect(UNIQUENESS_INDEXES.map((d) => d.name)).toContain("uq_tickets_draft");
    const draft = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number) VALUES ($1,$2,'r','card_draft',$3,0) RETURNING id`,
      [s.tenantId, s.userId, s.productId],
    )).rows[0].id as string;
    const a = await seedTicket(pool, s), b = await seedTicket(pool, s);
    await pool.query("DROP INDEX IF EXISTS uq_tickets_draft");
    // sujo: dois tickets com o mesmo rascunho
    await pool.query("UPDATE tickets SET draft_project_id = $2 WHERE id = ANY($1)", [[a.id, b.id], draft]);
    const logs: string[] = [];
    const dirty = await ensureEvolutionUniqueness(pool, { error: (l) => logs.push(l), info: (l) => logs.push(l) });
    expect(dirty.dirty.map((d) => d.index)).toContain("uq_tickets_draft");
    expect((await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'uq_tickets_draft'")).rows).toHaveLength(0);
    // limpo: cria
    await pool.query("UPDATE tickets SET draft_project_id = NULL WHERE id = $1", [b.id]);
    const clean = await ensureEvolutionUniqueness(pool, { error: (l) => logs.push(l), info: (l) => logs.push(l) });
    expect(clean.created).toContain("uq_tickets_draft");
    let code: string | undefined;
    try { await pool.query("UPDATE tickets SET draft_project_id = $2 WHERE id = $1", [b.id, draft]); } catch (e) { code = (e as { code?: string }).code; }
    expect(code).toBe("23505");
    // apagar o rascunho solta o vínculo (ON DELETE SET NULL)
    await pool.query("DELETE FROM projects WHERE id = $1", [draft]);
    expect((await pool.query("SELECT draft_project_id FROM tickets WHERE id = $1", [a.id])).rows[0].draft_project_id).toBeNull();
  });

  it("2.3 — o regex de ID de task do runner permanece o mesmo (sem mudança para card_id)", () => {
    const py = readFileSync(join(here, "..", "..", "..", "..", "orchestrator", "runner.py"), "utf-8");
    expect(py).toContain(String.raw`task_id_pattern = _re.compile(r'\b(TSK-[A-Z]+-\d+|TSK-\d+)\b')`);
    expect(py).toContain(String.raw`r'^\s*(?:#{2,4}\s+|\|\s*|\-\s+|\*\s+)(?:\**)?(TSK-[A-Z]+-\d+|TSK-\d+)\b'`);
    expect(py).not.toMatch(/TSK-EVO-\\d/); // Fase 4 (4.2): o runner passou a ligar TSK-EVO-* ao card (card_id, `_link_tasks_to_card`), mas o regex de ID não ganhou padrão EVO
  });

  // S-08: a reserva da migration 146 foi ABANDONADA; o esquema final, depois de TODAS as migrations, é o que as fases seguintes esperam.
  it("contrato (S-08): depois de todas as migrations, projects_status_check contém card_draft e materializing", async () => {
    const def = (await pool.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'projects_status_check' AND conrelid = 'projects'::regclass")).rows[0]?.def as string;
    expect(def).toBeTruthy();
    for (const st of ["card_draft", "materializing"]) expect(def, st).toContain(`'${st}'`);
    // não existe migration 146 (nem reserva): numeração das novas frentes >= 161
    expect(readdirSync(MIG).filter((f) => f.startsWith("146_"))).toEqual([]);
  });
});
