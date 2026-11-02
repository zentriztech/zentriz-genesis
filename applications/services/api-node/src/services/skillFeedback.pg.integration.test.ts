/**
 * Teste de integração do motor de feedback de skill contra Postgres REAL (plano v2, tarefa 1.1b).
 *
 * Só roda com PG_TEST_URL definido (Postgres EFÊMERO já migrado, ver scripts/apply-migrations-test.ts):
 *   docker run --rm -d --name evo-pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 pgvector/pgvector:pg16
 *   DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npx tsx scripts/apply-migrations-test.ts
 *   PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres npx vitest run src/services/skillFeedback.pg.integration.test.ts
 *
 * Recusa qualquer URL que não seja localhost:55432 (nunca toca dev/produção). Sem PG_TEST_URL o bloco é skip.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { applyOutcome, applySkillSignal, pgFeedbackStore, withTransaction } from "./skillFeedback.js";

const URL = process.env.PG_TEST_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_134 = path.join(here, "../db/migrations/134_skill_feedback_idempotency.sql");

const d = URL ? describe : describe.skip;

d("skillFeedback — Postgres real (efêmero)", () => {
  let pool: pg.Pool;
  let tenantId: string;
  let userId: string;
  let productId: string;
  let seq = 0;
  const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    if (!/@(localhost|127\.0\.0\.1):55432\//.test(URL!)) {
      throw new Error("PG_TEST_URL deve apontar para o Postgres efêmero em localhost:55432");
    }
    pool = new pg.Pool({ connectionString: URL, max: 12 });
    const t = await pool.query(`INSERT INTO tenants (name, plan_id) VALUES ('t-'||$1, 'plan_prata') RETURNING id`, [uid()]);
    tenantId = t.rows[0].id;
    const u = await pool.query(`INSERT INTO users (email, name) VALUES ($1,'u') RETURNING id`, [`u-${uid()}@t.test`]);
    userId = u.rows[0].id;
    const p = await pool.query(`INSERT INTO products (tenant_id, created_by, name) VALUES ($1,$2,'p') RETURNING id`, [tenantId, userId]);
    productId = p.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function newProject(): Promise<string> {
    const r = await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, product_id) VALUES ($1,$2,'proj',$3) RETURNING id`,
      [tenantId, userId, productId]);
    return r.rows[0].id;
  }
  async function newSkill(o: { status?: string; q?: number; hard?: boolean } = {}): Promise<string> {
    const r = await pool.query(
      `INSERT INTO skill (slug, role, title, body_md, status, quality_score, hard_rule)
       VALUES ($1,'dev','t','b',$2,$3,$4) RETURNING id`,
      [`sk-${uid()}`, o.status ?? "shadow", o.q ?? 1, o.hard ?? false]);
    return r.rows[0].id;
  }
  const skillRow = async (id: string) =>
    (await pool.query(`SELECT status, use_count, quality_score::float AS q FROM skill WHERE id=$1`, [id])).rows[0];
  const fbCount = async (id: string) =>
    (await pool.query(`SELECT COUNT(*)::int AS n FROM skill_feedback WHERE skill_id=$1`, [id])).rows[0].n as number;

  /** Aplica UM sinal numa transação própria (como a rota/o runner fazem). */
  const apply = (projectId: string, skillId: string, taskRef: string, signal: string, mode: "on" | "shadow" = "on") =>
    withTransaction(pool as never, (db) =>
      applySkillSignal(pgFeedbackStore(db), mode, { projectId, taskRef, skillId, signal }));

  it("idempotência: o mesmo sinal 2x não conta duas vezes", async () => {
    const proj = await newProject();
    const sk = await newSkill();
    const a = await apply(proj, sk, "T1", "oracle_pass");
    const b = await apply(proj, sk, "T1", "oracle_pass");
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(await fbCount(sk)).toBe(1);
    const s = await skillRow(sk);
    expect(s.use_count).toBe(1);
    expect(s.q).toBeCloseTo(0.525, 3); // prior 0,5 → EMA com alvo 1,0
    // task diferente = evidência nova
    await apply(proj, sk, "T2", "oracle_pass");
    expect(await fbCount(sk)).toBe(2);
  });

  it("concorrência: 8 requisições simultâneas com a mesma chave contam uma vez só", async () => {
    const proj = await newProject();
    const sk = await newSkill();
    const res = await Promise.all(Array.from({ length: 8 }, () => apply(proj, sk, "TC", "oracle_pass")));
    expect(res.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(res.filter((r) => r.duplicate)).toHaveLength(7);
    expect(await fbCount(sk)).toBe(1);
    expect((await skillRow(sk)).use_count).toBe(1);
  });

  it("concorrência: sinais distintos simultâneos na mesma skill serializam (FOR UPDATE) sem perder update", async () => {
    const proj = await newProject();
    const sk = await newSkill();
    await Promise.all(Array.from({ length: 6 }, (_, i) => apply(proj, sk, `TD${i}`, "oracle_pass")));
    const s = await skillRow(sk);
    expect(await fbCount(sk)).toBe(6);
    expect(s.use_count).toBe(6);
    // 0,5 → 6 passos de alvo 1,0: 1 − 0,5·0,95^6 ≈ 0,632 (round3 a cada passo pode divergir 1e-3)
    expect(s.q).toBeGreaterThan(0.62);
    expect(s.q).toBeLessThan(0.64);
  });

  it("shadow→trusted exige >=5 evidências fortes E score >=0,7", async () => {
    const proj = await newProject();
    // (a) score alto mas só 4 evidências → não transita; a 5ª transita
    const sk = await newSkill();
    await apply(proj, sk, "T1", "oracle_pass");
    await pool.query(`UPDATE skill SET quality_score=0.95 WHERE id=$1`, [sk]);
    for (const t of ["T2", "T3", "T4"]) await apply(proj, sk, t, "oracle_pass");
    expect((await skillRow(sk)).status).toBe("shadow"); // 4 evidências
    const o5 = await apply(proj, sk, "T5", "oracle_pass");
    expect(o5.transition).toBe("trusted");
    expect((await skillRow(sk)).status).toBe("trusted");

    // (b) 5 evidências com score baixo (<0,7) → não transita
    const sk2 = await newSkill();
    for (let i = 1; i <= 5; i++) await apply(proj, sk2, `L${i}`, "oracle_pass");
    const s2 = await skillRow(sk2);
    expect(s2.q).toBeLessThan(0.7);
    expect(s2.status).toBe("shadow");

    // (c) a partir de 10 passos sobe de 0,5 a >=0,7 e transita pelo caminho natural
    for (let i = 6; i <= 10; i++) await apply(proj, sk2, `L${i}`, "oracle_pass");
    const s3 = await skillRow(sk2);
    expect(s3.q).toBeGreaterThanOrEqual(0.7);
    expect(s3.status).toBe("trusted");
  });

  it("human_approve (sinal forte) também conta para trusted; oracle_fail não promove", async () => {
    const proj = await newProject();
    const sk = await newSkill();
    await apply(proj, sk, "H1", "human_approve");
    await pool.query(`UPDATE skill SET quality_score=0.95 WHERE id=$1`, [sk]);
    for (const t of ["H2", "H3", "H4", "H5"]) await apply(proj, sk, t, "human_approve");
    expect((await skillRow(sk)).status).toBe("trusted");

    const sk2 = await newSkill({ q: 0.95 });
    for (let i = 1; i <= 6; i++) await apply(proj, sk2, `N${i}`, "oracle_fail");
    expect((await skillRow(sk2)).status).toBe("shadow");
  });

  it("trusted→deprecated exige >=10 evidências fortes E score <0,3; hard_rule nunca deprecia", async () => {
    const proj = await newProject();
    const sk = await newSkill({ status: "trusted" });
    await apply(proj, sk, "F1", "oracle_fail");
    await pool.query(`UPDATE skill SET quality_score=0.31 WHERE id=$1`, [sk]);
    for (let i = 2; i <= 9; i++) await apply(proj, sk, `F${i}`, "oracle_fail");
    const at9 = await skillRow(sk);
    expect(at9.q).toBeLessThan(0.3);            // score já abaixo do limiar...
    expect(at9.status).toBe("trusted");         // ...mas só 9 evidências
    const o10 = await apply(proj, sk, "F10", "oracle_fail");
    expect(o10.transition).toBe("deprecated");
    expect((await skillRow(sk)).status).toBe("deprecated");

    const hr = await newSkill({ status: "trusted", hard: true });
    await apply(proj, hr, "R1", "oracle_fail");
    await pool.query(`UPDATE skill SET quality_score=0.1 WHERE id=$1`, [hr]);
    for (let i = 2; i <= 12; i++) await apply(proj, hr, `R${i}`, "oracle_fail");
    expect((await skillRow(hr)).status).toBe("trusted");
  });

  it("qa_pass/qa_fail nunca mudam status nem use_count (só o score informativo)", async () => {
    const proj = await newProject();
    const up = await newSkill({ status: "shadow", q: 0.95 });
    for (let i = 1; i <= 30; i++) await apply(proj, up, `Q${i}`, "qa_pass");
    const u = await skillRow(up);
    expect(u.status).toBe("shadow");
    expect(u.use_count).toBe(0);

    const down = await newSkill({ status: "trusted", q: 0.2 });
    for (let i = 1; i <= 30; i++) await apply(proj, down, `Q${i}`, "qa_fail");
    const dn = await skillRow(down);
    expect(dn.status).toBe("trusted");
    expect(dn.use_count).toBe(0);
    expect(dn.q).toBeLessThan(0.2);
    expect(await fbCount(down)).toBe(30);
  });

  it("modo shadow grava com chave 'shadow|' mas não altera skill", async () => {
    const proj = await newProject();
    const sk = await newSkill();
    const o = await apply(proj, sk, "S1", "oracle_pass", "shadow");
    expect(o.duplicate).toBe(false);
    const s = await skillRow(sk);
    expect(s.use_count).toBe(0);
    expect(s.q).toBe(1);
    const k = (await pool.query(`SELECT idempotency_key FROM skill_feedback WHERE skill_id=$1`, [sk])).rows[0].idempotency_key;
    expect(k.startsWith("shadow|")).toBe(true);
    // shadow não colide com o modo on para a mesma task
    const on = await apply(proj, sk, "S1", "oracle_pass", "on");
    expect(on.duplicate).toBe(false);
  });

  it("hit_count de lição é idempotente (por projeto+lição+sinal), com fan-out real de bundles e injeções", async () => {
    const proj = await newProject();
    const sk = await newSkill();
    await pool.query(`INSERT INTO skill_bundle (project_id, task_id, role, stack_key, skill_ids, bundle_hash)
                      VALUES ($1,'TA','dev','generic',ARRAY[$2]::uuid[],'h1'), ($1,'TA','dev','generic',ARRAY[$2]::uuid[],'h2')`,
      [proj, sk]); // rework: 2 bundles da mesma task
    const slug = `lic-${uid()}`;
    await pool.query(`INSERT INTO lessons_corpus (slug, category, scope, title, body_md) VALUES ($1,'c','global','t','b')`, [slug]);
    await pool.query(`INSERT INTO lesson_injection (project_id, task_id, lesson_slug) VALUES ($1,'TA',$2), ($1,'TB',$2)`, [proj, slug]);
    const hit = async () => (await pool.query(`SELECT hit_count FROM lessons_corpus WHERE slug=$1`, [slug])).rows[0].hit_count as number;
    const run = (taskId: string | null, signal = "oracle_pass", mode: "on" | "shadow" = "on") =>
      withTransaction(pool as never, (db) => applyOutcome(pgFeedbackStore(db), mode, { projectId: proj, taskId, signal }));

    const r1 = await run("TA");
    expect(r1.skills).toHaveLength(1);            // 2 bundles → 1 skill contada
    expect(r1.lessons).toEqual([{ slug, duplicate: false }]);
    expect(await hit()).toBe(1);
    expect(await fbCount(sk)).toBe(1);

    const r2 = await run("TA");                   // retry
    expect(r2.lessons).toEqual([{ slug, duplicate: true }]);
    expect(r2.skills[0].duplicate).toBe(true);
    expect(await hit()).toBe(1);

    await run("TB");                              // outra task, mesma lição → não infla
    expect(await hit()).toBe(1);

    await run(null);                              // projeto inteiro → ainda 1
    expect(await hit()).toBe(1);

    // concorrência no hit
    const proj2 = await newProject();
    await pool.query(`INSERT INTO lesson_injection (project_id, task_id, lesson_slug) VALUES ($1,'TX',$2)`, [proj2, slug]);
    await Promise.all(Array.from({ length: 6 }, () =>
      withTransaction(pool as never, (db) => applyOutcome(pgFeedbackStore(db), "on", { projectId: proj2, taskId: "TX", signal: "oracle_pass" }))));
    expect(await hit()).toBe(2);                  // +1 pelo proj2, não +6

    // sinal negativo não conta acerto
    await run("TA", "oracle_fail");
    expect(await hit()).toBe(2);

    // shadow registra evento shadow| mas não incrementa
    const proj3 = await newProject();
    await pool.query(`INSERT INTO lesson_injection (project_id, task_id, lesson_slug) VALUES ($1,'TY',$2)`, [proj3, slug]);
    await withTransaction(pool as never, (db) => applyOutcome(pgFeedbackStore(db), "shadow", { projectId: proj3, taskId: "TY", signal: "oracle_pass" }));
    expect(await hit()).toBe(2);
    const ev = await pool.query(`SELECT COUNT(*)::int AS n FROM lesson_hit_event WHERE project_id=$1 AND idempotency_key LIKE 'shadow|%'`, [proj3]);
    expect(ev.rows[0].n).toBe(1);
  });

  it("CHECK de sinais (DROP+ADD da 134): aceita os 9 sinais e rejeita desconhecido", async () => {
    const proj = await newProject();
    const sk = await newSkill();
    const signals = ["qa_pass","qa_fail","cyborg_reject","bug_recurrence","human_fix","human_approve","oracle_pass","oracle_fail","human_reject"];
    for (const s of signals) {
      await pool.query(`INSERT INTO skill_feedback (skill_id, project_id, signal, weight) VALUES ($1,$2,$3,0)`, [sk, proj, s]);
    }
    await expect(pool.query(`INSERT INTO skill_feedback (skill_id, project_id, signal, weight) VALUES ($1,$2,'bogus',0)`, [sk, proj]))
      .rejects.toThrow(/skill_feedback_signal_check/);
    const defs = (await pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='skill_feedback'::regclass AND conname='skill_feedback_signal_check'`)).rows;
    expect(defs).toHaveLength(1);
  });

  it("índice único parcial: chave NULL repetida é permitida (linhas legadas), chave igual é barrada", async () => {
    const proj = await newProject();
    const sk = await newSkill();
    for (let i = 0; i < 2; i++) {
      await pool.query(`INSERT INTO skill_feedback (skill_id, project_id, signal, weight) VALUES ($1,$2,'qa_pass',0.5)`, [sk, proj]);
    }
    await pool.query(`INSERT INTO skill_feedback (skill_id, project_id, signal, weight, idempotency_key) VALUES ($1,$2,'qa_pass',0.5,$3)`, [sk, proj, `k-${uid()}`]);
    const dup = `k-${uid()}`;
    await pool.query(`INSERT INTO skill_feedback (skill_id, project_id, signal, weight, idempotency_key) VALUES ($1,$2,'qa_pass',0.5,$3)`, [sk, proj, dup]);
    await expect(pool.query(`INSERT INTO skill_feedback (skill_id, project_id, signal, weight, idempotency_key) VALUES ($1,$2,'qa_pass',0.5,$3)`, [sk, proj, dup]))
      .rejects.toThrow(/uq_skill_feedback_idempotency/);
  });

  it("a migration 134 pode ser reexecutada (mesmo split ingênuo do runner) sem erro e sem perder dados", async () => {
    // Replica fielmente runMigration de src/db/init.ts (sem o INSERT em schema_migrations).
    const sql = await fs.readFile(MIGRATION_134, "utf-8");
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      .split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(5);

    const proj = await newProject();
    const sk = await newSkill();
    await apply(proj, sk, "M1", "oracle_pass");
    const before = await fbCount(sk);

    for (let round = 0; round < 2; round++) {
      for (const st of statements) await pool.query(st);
    }
    expect(await fbCount(sk)).toBe(before);
    const c = await pool.query(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conrelid='skill_feedback'::regclass AND conname='skill_feedback_signal_check'`);
    expect(c.rows[0].n).toBe(1);
    // o motor segue funcionando e a idempotência persiste após a reexecução
    expect((await apply(proj, sk, "M1", "oracle_pass")).duplicate).toBe(true);
    expect((await apply(proj, sk, "M2", "oracle_fail")).duplicate).toBe(false);
  });
});
