/**
 * Fase 1' (tarefa 1.2) — índices parciais de unicidade do fluxo "Evoluir projeto", em Postgres REAL.
 * Roda num BANCO DESCARTÁVEL (CREATE DATABASE + migrations 1→N pelo mesmo `initDb` do produto): cria/derruba índices e
 * semeia duplicatas à vontade sem afetar as outras suítes que dividem o Postgres efêmero.
 *
 * Só roda com PG_TEST_URL (localhost:55432|55440). Sem ele: skip.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { rmSync } from "fs";

const uploadTmp = await vi.hoisted(async () => {
  // projectCreation.ts lê UPLOAD_DIR no import: aponta para um tmp (senão escreveria em ./uploads)
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-uniq-"));
  process.env.UPLOAD_DIR = d;
  return d;
});

import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, raceN, queryGate, childrenOf, uid,
  type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "../routes/projects.js";
import { specRoutes } from "../routes/specs.js";
import {
  ensureEvolutionUniqueness, UNIQUENESS_INDEXES, getUniquenessCounters, resetUniquenessCountersForTest,
} from "./evolutionUniqueness.js";
import { createProjectFromSpec, VersionConflictError } from "./projectCreation.js";

const ev = (tag: string, data: unknown) => console.log(`[F1-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);

describePg("Fase 1' / 1.2 — unicidade parcial (banco descartável)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const logs: string[] = [];
  const logger = { error: (l: string) => logs.push(l), info: (l: string) => logs.push(l) };

  beforeAll(async () => {
    scratch = await createScratchDb("evo_uniq");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([projectRoutes, specRoutes]);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    for (const s of seeds) s.cleanup();
    rmSync(uploadTmp, { recursive: true, force: true });
    await scratch?.drop();
  });

  const seed = async (o: Parameters<typeof seedAcceptedProduct>[1] = {}) => { const s = await seedAcceptedProduct(pool, { budgetUsd: 50, ...o }); seeds.push(s); return s; };
  const indexNames = async () => (await pool.query("SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)", [UNIQUENESS_INDEXES.map((d) => d.name)])).rows.map((r) => r.indexname as string).sort();
  const dropAll = async () => { for (const d of UNIQUENESS_INDEXES) await pool.query(`DROP INDEX IF EXISTS ${d.name}`); };
  const mkChild = (s: Seed, o: { parent?: string; version?: number; status?: string; extra?: Record<string, unknown> } = {}) =>
    pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra)
       VALUES ($1,$2,'filho',$3,$4,$5,$6,$7::jsonb) RETURNING id`,
      [s.tenantId, s.userId, o.status ?? "draft", s.productId, o.parent ?? s.parentId, o.version ?? 2, JSON.stringify(o.extra ?? {})],
    );
  const constraintOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { const x = e as { code?: string; constraint?: string }; return `${x.code}:${x.constraint}`; } };

  it("banco limpo ⇒ os 5 índices são criados; segunda execução é no-op", async () => {
    await dropAll();
    resetUniquenessCountersForTest();
    const r1 = await ensureEvolutionUniqueness(pool, logger);
    const r2 = await ensureEvolutionUniqueness(pool, logger);
    ev("indices-criados", { primeira: { created: r1.created.length, dirty: r1.dirty.length }, segunda: { created: r2.created.length, existing: r2.existing.length }, noBanco: (await indexNames()).length });
    expect(r1.created.sort()).toEqual(UNIQUENESS_INDEXES.map((d) => d.name).sort());
    expect(r1.dirty).toHaveLength(0);
    expect(r1.errors).toHaveLength(0);
    expect(r2.created).toHaveLength(0);
    expect(r2.existing).toHaveLength(5);
    expect(await indexNames()).toEqual(UNIQUENESS_INDEXES.map((d) => d.name).sort());
    expect(getUniquenessCounters().created).toBe(5);
  });

  it("conflito ⇒ 23505 em cada índice (INSERT direto de duplicata)", async () => {
    const s = await seed();
    const t = await seedTicket(pool, s);
    await mkChild(s, { version: 2, status: "spec_submitted", extra: { evolution: true, ticket_id: "TK-A", evolve_idempotency_key: "key-A" } });
    const results: Record<string, string | null> = {};
    // U1: mesmo (pai, versão) vivo
    results.U1 = await constraintOf(mkChild(s, { version: 2, status: "draft" }));
    // U2: segundo filho de EVOLUÇÃO vivo do mesmo pai (versão diferente)
    results.U2 = await constraintOf(mkChild(s, { version: 3, status: "draft", extra: { evolution: true } }));
    // U3: mesmo ticket_id vivo (outra versão, sem 'evolution' para não cair em U2)
    results.U3 = await constraintOf(mkChild(s, { version: 4, status: "draft", extra: { ticket_id: "TK-A" } }));
    // U4: mesma Idempotency-Key no tenant
    results.U4 = await constraintOf(mkChild(s, { version: 5, status: "draft", extra: { evolve_idempotency_key: "key-A" } }));
    // U5: dois tickets vivos apontando para o mesmo filho
    const kid = (await childrenOf(pool, s.parentId))[0].id;
    await pool.query("UPDATE tickets SET status='promoted', child_project_id=$2 WHERE id=$1", [t.id, kid]);
    const t2 = await seedTicket(pool, s);
    results.U5 = await constraintOf(pool.query("UPDATE tickets SET status='promoted', child_project_id=$2 WHERE id=$1", [t2.id, kid]));
    ev("23505", results);
    expect(results).toEqual({
      U1: "23505:uq_projects_parent_version_live",
      U2: "23505:uq_projects_one_live_evolution_child",
      U3: "23505:uq_projects_ticket_live",
      U4: "23505:uq_projects_evolve_idem_live",
      U5: "23505:uq_tickets_child_live",
    });
  });

  it("failed e archived guardam o número SEM bloquear o retry (U1/U2/U3/U4 os excluem)", async () => {
    const s = await seed();
    await mkChild(s, { version: 2, status: "failed", extra: { evolution: true, ticket_id: "TK-B", evolve_idempotency_key: "key-B" } });
    await mkChild(s, { version: 2, status: "archived", extra: { evolution: true, ticket_id: "TK-B", evolve_idempotency_key: "key-B" } });
    const retry = await constraintOf(mkChild(s, { version: 2, status: "materializing", extra: { evolution: true, ticket_id: "TK-B", evolve_idempotency_key: "key-B" } }));
    expect(retry).toBeNull();
    // e 'accepted' continua contando para U1 (um aceito vN impede outro vN) mas não para U2
    const s2 = await seed();
    await mkChild(s2, { version: 2, status: "accepted", extra: { evolution: true } });
    expect(await constraintOf(mkChild(s2, { version: 3, status: "draft", extra: { evolution: true } }))).toBeNull();
    expect(await constraintOf(mkChild(s2, { version: 2, status: "draft" }))).toBe("23505:uq_projects_parent_version_live");
  });

  it("boot com DUPLICATA ⇒ não cria o índice sujo, cria os demais, loga estruturado, incrementa o contador e NÃO lança (a api sobe)", async () => {
    await dropAll();
    const s = await seed();
    const dup1 = (await mkChild(s, { version: 2, status: "spec_submitted" })).rows[0].id as string;
    const dup2 = (await mkChild(s, { version: 2, status: "draft" })).rows[0].id as string; // (pai, versão 2) duplicado e vivo
    resetUniquenessCountersForTest();
    logs.length = 0;
    // simula o boot do index.ts: `await ensureEvolutionUniqueness(pool).catch(log)` — jamais derruba
    let threw = false;
    let report!: Awaited<ReturnType<typeof ensureEvolutionUniqueness>>;
    try { report = await ensureEvolutionUniqueness(pool, logger); } catch { threw = true; }
    const present = await indexNames();
    const parsed = logs.map((l) => JSON.parse(l) as { event: string; index: string; level: string });
    ev("boot-sujo", { threw, dirty: report.dirty.map((d) => ({ index: d.index, grupos: d.groups.length, n: d.groups[0]?.n })), criados: report.created, naoCriado: !present.includes("uq_projects_parent_version_live"), contador: getUniquenessCounters(), log: parsed.filter((p) => p.level === "error").map((p) => p.event) });
    expect(threw).toBe(false);
    expect(report.dirty.map((d) => d.index)).toEqual(["uq_projects_parent_version_live"]);
    expect(report.created.sort()).toEqual(UNIQUENESS_INDEXES.map((d) => d.name).filter((n) => n !== "uq_projects_parent_version_live").sort());
    expect(present).not.toContain("uq_projects_parent_version_live");
    expect(present).toHaveLength(4);
    expect(getUniquenessCounters().dirty).toBe(1);
    expect(parsed.some((p) => p.level === "error" && p.event === "evolution_uniqueness_dirty" && p.index === "uq_projects_parent_version_live")).toBe(true);

    // resolvidas as duplicatas, o próximo boot cria o que faltava
    await pool.query("DELETE FROM projects WHERE id = ANY($1)", [[dup1, dup2]]);
    const again = await ensureEvolutionUniqueness(pool, logger);
    expect(again.created).toEqual(["uq_projects_parent_version_live"]);
    expect(await indexNames()).toHaveLength(5);
  });

  it("erro inesperado num índice não derruba os outros (catch por índice)", async () => {
    const calls: string[] = [];
    const flaky = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push(sql.slice(0, 30));
        if (/uq_projects_ticket_live/.test(sql) || params?.[0] === "uq_projects_ticket_live") throw new Error("boom");
        return pool.query(sql, params as unknown[]);
      },
    };
    await dropAll();
    const r = await ensureEvolutionUniqueness(flaky, logger);
    expect(r.errors.map((e) => e.index)).toEqual(["uq_projects_ticket_live"]);
    expect(r.created).toHaveLength(4);
    await dropAll();
    await ensureEvolutionUniqueness(pool, logger);
  });

  it("rede de segurança: com os índices e SEM claim (flag off), N simultâneas no /evolve histórico ⇒ 1× 201 e o resto 409 EVOLUTION_IN_FLIGHT (antes: N filhos)", async () => {
    expect(await indexNames()).toHaveLength(5);
    vi.stubEnv("EVOLVE_CLAIM", "off");
    try {
      const s = await seed();
      const N = 4;
      const gate = queryGate(pool, /parent_project_id = \$1 AND status NOT IN/, { mode: "barrier", arrivals: N });
      const rs = await raceN(N, () => app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "Adicionar exportação CSV" } }));
      gate.uninstall();
      const kids = await childrenOf(pool, s.parentId);
      ev("rede-seguranca-off", { codes: rs.map((r) => r.statusCode).sort(), codigos: rs.filter((r) => r.statusCode === 409).map((r) => r.json().code), filhos: kids.length });
      expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(N - 1);
      expect(rs.filter((r) => r.statusCode === 409).every((r) => r.json().code === "EVOLUTION_IN_FLIGHT")).toBe(true);
      expect(kids).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("claim ligado + índices: N=8 simultâneas ⇒ 1 filho (lock e índice juntos)", async () => {
    vi.stubEnv("EVOLVE_CLAIM", "on");
    try {
      const s = await seed();
      const rs = await raceN(8, () => app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "Adicionar exportação CSV" } }));
      expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(rs.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
      expect(await childrenOf(pool, s.parentId)).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("POST /api/specs com parentProjectId (createProjectFromSpec, numeração por max(versão viva) da linhagem): corrida ⇒ uma cria, a outra recebe VersionConflictError (rota ⇒ 409)", async () => {
    const s = await seed();
    const gate = queryGate(pool, /MAX\(version_number\)/, { mode: "barrier", arrivals: 2 });
    const make = async (i: number) => {
      const client = await pool.connect();
      try {
        return await createProjectFromSpec(client, {
          tenantId: s.tenantId, createdBy: s.userId, title: `v-concorrente-${i}-${uid()}`,
          files: [{ filename: "spec.md", buffer: Buffer.from(`# spec ${i} ${uid()}\n`), mimeType: "text/markdown" }],
          productId: s.productId, parentProjectId: s.parentId,
        });
      } finally { client.release(); }
    };
    const rs = await Promise.allSettled([make(1), make(2)]);
    gate.uninstall();
    const ok = rs.filter((r) => r.status === "fulfilled");
    const bad = rs.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    ev("specs-corrida", { ok: ok.length, rejeitadas: bad.map((b) => (b.reason as Error).name), codigo: bad.map((b) => (b.reason as { code?: string }).code) });
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(VersionConflictError);
    expect((bad[0].reason as VersionConflictError).code).toBe("VERSION_CONFLICT");
    const versions = (await pool.query("SELECT version_number FROM projects WHERE parent_project_id = $1", [s.parentId])).rows.map((r) => r.version_number);
    expect(versions).toEqual([2]);
  });

  it("M-09: transação longa segurando a tabela ⇒ o DDL desiste em ~3 s (lock_timeout), loga evolution_uniqueness_lock_timeout e o boot segue", async () => {
    await dropAll();
    resetUniquenessCountersForTest();
    const holder = await pool.connect();
    const lines: string[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE projects IN ROW EXCLUSIVE MODE"); // conflita com o SHARE do CREATE UNIQUE INDEX
      const t0 = Date.now();
      const r = await ensureEvolutionUniqueness(pool, { error: (l) => lines.push(l), info: (l) => lines.push(l) });
      const ms = Date.now() - t0;
      const lt = lines.filter((l) => l.includes("evolution_uniqueness_lock_timeout"));
      ev("ddl-lock-timeout", { ms, criados: r.created, erros: r.errors.length, lockTimeouts: getUniquenessCounters().lockTimeouts });
      expect(lt.length).toBeGreaterThan(0);
      expect(getUniquenessCounters().lockTimeouts).toBeGreaterThan(0);
      expect(r.errors.length).toBeGreaterThan(0);
      // 4 índices em projects × ~3 s; o ponto é: termina (não pendura) e a sessão volta limpa ao pool
      expect(ms).toBeLessThan(25_000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    // liberada a tabela, a próxima execução cria tudo (o timeout não deixa a sessão do pool com lock_timeout preso)
    const again = await ensureEvolutionUniqueness(pool, logger);
    expect(again.errors).toHaveLength(0);
    expect(await indexNames()).toEqual(UNIQUENESS_INDEXES.map((d) => d.name).sort());
    const lt = (await pool.query("SHOW lock_timeout")).rows[0].lock_timeout;
    expect(lt).toBe("0");
  }, 60_000);

  // ── M-02-a / M-12: POST /api/specs numera pela linhagem INTEIRA e o 409 só ocorre em corrida real ──────────────────
  const multipart = (fields: Record<string, string>, fileName: string, fileBody: string) => {
    const b = "----g1boundary";
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    parts.push(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/markdown\r\n\r\n${fileBody}\r\n`);
    parts.push(`--${b}--\r\n`);
    return { payload: parts.join(""), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
  };
  const postSpec = (s: Seed, parentProjectId: string, tag: string) => {
    const mp = multipart({
      title: `Evolucao via specs ${tag}`, projectType: "backend_api", intakeMode: "attachments", budgetUsd: "10", budgetAlertStepPct: "20",
      productId: s.productId, parentProjectId,
    }, "spec.md", `# Spec ${tag}\n\nO aplicativo lista entregas e permite exportar os dados em formato CSV para o cliente final.\n`);
    return app.inject({ method: "POST", url: "/api/specs", payload: mp.payload, headers: mp.headers });
  };
  const lineageDepth3 = async (s: Seed) => {
    // v1 (seed) ← v2 ← v3, como o /evolve histórico cria (cada filho aponta para o HEAD anterior)
    const v2 = (await mkChild(s, { parent: s.parentId, version: 2, status: "accepted" })).rows[0].id as string;
    const v3 = (await mkChild(s, { parent: v2, version: 3, status: "accepted" })).rows[0].id as string;
    return { v2, v3 };
  };

  it("M-02-a: linhagem v1←v2←v3 + POST /api/specs com parentProjectId de QUALQUER versão ⇒ v4, sem 409 (antes: 409 determinístico)", async () => {
    await ensureEvolutionUniqueness(pool, logger);
    const s = await seed();
    const { v2, v3 } = await lineageDepth3(s);
    const out: Record<string, unknown> = {};
    let expected = 4;
    for (const [label, pid] of [["v3", v3], ["v2", v2], ["v1", s.parentId]] as const) {
      const r = await postSpec(s, pid, label);
      const id = r.json().projectId ?? r.json().id;
      const row = id ? (await pool.query("SELECT version_number, parent_project_id FROM projects WHERE id = $1", [id])).rows[0] : null;
      out[label] = { status: r.statusCode, code: r.json().code ?? null, version: row?.version_number ?? null };
      expect(r.statusCode, `${label}: ${r.body}`).toBeLessThan(300);
      expect(row?.version_number).toBe(expected);
      expected++;
    }
    ev("specs-profundidade-3", out);
  });

  it("M-12: POST /api/specs, corrida real na mesma linhagem ⇒ uma cria e a outra recebe 409 VERSION_CONFLICT pela ROTA", async () => {
    await ensureEvolutionUniqueness(pool, logger);
    const s = await seed();
    const { v3 } = await lineageDepth3(s);
    const gate = queryGate(pool, /MAX\(version_number\)/, { mode: "barrier", arrivals: 2 });
    const rs = await raceN(2, (i) => postSpec(s, v3, `corrida-${i}`));
    gate.uninstall();
    const codes = rs.map((r) => r.statusCode).sort();
    const conflict = rs.find((r) => r.statusCode === 409);
    ev("specs-rota-409", { codes, code: conflict?.json().code ?? null });
    expect(codes.filter((c) => c < 300)).toHaveLength(1);
    expect(conflict?.json().code).toBe("VERSION_CONFLICT");
    const versions = (await pool.query(
      "SELECT version_number FROM projects WHERE parent_project_id = $1 AND status NOT IN ('failed','archived') ORDER BY version_number", [(await pool.query("SELECT parent_project_id FROM projects WHERE id = $1", [v3])).rows[0].parent_project_id])).rows.map((r) => r.version_number);
    expect(versions).toEqual([3, 4]);
  });
});
