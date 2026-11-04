/**
 * Fase 1' (tarefa 1.8) — reconciliador do /evolve em Postgres REAL, banco DESCARTÁVEL (CREATE DATABASE + migrations 1→N).
 * Banco próprio porque o job (modo `on`) pode limpar claims vencidos: não pode varrer fixtures de outras suítes.
 *
 * Só roda com PG_TEST_URL (localhost:55432|55440|55441). Sem ele: skip.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { rmSync, mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

const uploadTmp = await vi.hoisted(async () => {
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-recon-"));
  process.env.UPLOAD_DIR = d;
  return d;
});

import type pg from "pg";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, seedAcceptedProduct, seedTicket, buildApp, raceN, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
// Autenticação mínima e DETERMINÍSTICA para provar 401/403/200 (o middleware real exige JWT + tenant ativo):
// sem `authorization` ⇒ 401; o papel vem de `x-test-role` e a identidade de serviço de `x-test-svc`.
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.headers.authorization) return reply.status(401).send({ code: "UNAUTHORIZED" });
    (req as unknown as { user: unknown }).user = {
      id: "u", email: "u@x.test", role: String(req.headers["x-test-role"] ?? "tenant_admin"), tenantId: null,
      svc: req.headers["x-test-svc"] ? String(req.headers["x-test-svc"]) : undefined,
    };
  },
}));

import { hashId } from "./anomalyDetectors.js";
import { ensureEvolutionUniqueness, UNIQUENESS_INDEXES } from "./evolutionUniqueness.js";
import { NS_EVOLVE } from "./evolveClaim.js";
import { RECONCILER_LOCK_NS, reconcilerDiskProblems } from "./evolveReconciler.js";
import {
  runReconcilerPass, cleanExpiredClaim, reconcilerMode, resolveReconcilerParams, startReconcilerWorker, stopReconcilerWorker,
} from "./evolveReconciler.js";
import { evolveReconcilerRoutes } from "../routes/evolveReconciler.js";

const ev = (tag: string, data: unknown) => console.log(`[L-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);

describePg("Fase 1' / 1.8 — reconciliador do /evolve (banco descartável)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  // O env é montado NA HORA: seedAcceptedProduct troca process.env.UPLOAD_DIR a cada semente (o diretório em disco do filho
  // precisa ser o que o job enxerga).
  // M-15: `on` exige PROJECT_FILES_ROOT e UPLOAD_DIR existentes — o seed zera o primeiro, então o job recebe um tmp de verdade.
  const filesTmp = mkdtempSync(join(tmpdir(), "genesis-recon-files-"));
  const envOf = (m: string) => ({ ...process.env, EVOLVE_RECONCILER: m, PROJECT_FILES_ROOT: filesTmp }) as NodeJS.ProcessEnv;
  const run = (m: "on" | "shadow") => runReconcilerPass(pool, envOf(m));

  beforeAll(async () => {
    scratch = await createScratchDb("evo_recon");
    pool = scratch.pool;
    pool.on("error", () => undefined); // DROP DATABASE ... FORCE derruba clientes ociosos (57P01) no teardown
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([evolveReconcilerRoutes]);
  }, 120_000);
  afterAll(async () => {
    stopReconcilerWorker();
    await app?.close();
    for (const s of seeds) s.cleanup();
    rmSync(uploadTmp, { recursive: true, force: true });
    await scratch?.drop();
  });

  const seed = async () => { const s = await seedAcceptedProduct(pool, { budgetUsd: 50 }); seeds.push(s); return s; };

  /** Filho de evolução `materializing` + ticket `promoted` apontando para ele (como o claim da 1.1 deixa). */
  async function mkClaim(o: { leaseAgoS?: number; steps?: Record<string, unknown>; specFile?: boolean; disk?: boolean; ticket?: boolean } = {}) {
    const s = await seed();
    const t = o.ticket === false ? null : await seedTicket(pool, s, { status: "open" });
    const claimId = randomUUID();
    const extra = {
      evolution: true, evolution_root_id: s.parentId, evolution_parent_id: s.parentId, ...(t ? { ticket_id: t.id } : {}),
      materialization: { claim_id: claimId, lease_owner: claimId, attempt: 1, head_project_id: s.parentId, steps: o.steps ?? {} },
    };
    const c = await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra)
       VALUES ($1,$2,'filho','materializing',$3,$4,2,
               jsonb_set($5::jsonb, '{materialization,lease_until}', to_jsonb(now() - ($6::int * interval '1 second')))) RETURNING id`,
      [s.tenantId, s.userId, s.productId, s.parentId, JSON.stringify(extra), o.leaseAgoS ?? 3600],
    );
    const childId = c.rows[0].id as string;
    if (t) await pool.query("UPDATE tickets SET status='promoted', child_project_id=$2, promoted_at=now(), updated_at=now() WHERE id=$1", [t.id, childId]);
    if (o.specFile) {
      await pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
                        VALUES ($1,'spec.md','/nao/existe/spec.md','text/markdown','',true,'x')`, [childId]);
    }
    if (o.disk) mkdirSync(join(process.env.UPLOAD_DIR!, childId), { recursive: true });
    return { s, childId, ticketId: t?.id ?? null };
  }
  const finding = async (kind: string, id: string) =>
    (await pool.query("SELECT * FROM evolve_reconciler_findings WHERE kind=$1 AND entity_hash=$2", [kind, hashId(id)])).rows;
  const childRow = async (id: string) => (await pool.query("SELECT status, extra FROM projects WHERE id=$1", [id])).rows[0];
  const ticketRow = async (id: string) => (await pool.query("SELECT status, child_project_id, promoted_at FROM tickets WHERE id=$1", [id])).rows[0];
  const totalFindings = async () => Number((await pool.query("SELECT count(*)::int AS n FROM evolve_reconciler_findings")).rows[0].n);

  it("flag: ausente/desconhecida ⇒ off; parâmetros com padrão conservador", () => {
    expect(reconcilerMode({})).toBe("off");
    expect(reconcilerMode({ EVOLVE_RECONCILER: "1" } as never)).toBe("off");
    expect(reconcilerMode({ EVOLVE_RECONCILER: "shadow" } as never)).toBe("shadow");
    expect(reconcilerMode({ EVOLVE_RECONCILER: " ON " } as never)).toBe("on");
    expect(resolveReconcilerParams({})).toEqual({ claimGraceS: 300, stuckHours: 72, orphanGraceS: 300 });
  });

  it("off: nada roda, nada é lido nem escrito (pool que explode ao ser tocado) e o worker nem agenda timer", async () => {
    const c = await mkClaim();
    const before = await totalFindings();
    const boom = new Proxy({}, { get() { throw new Error("off não pode tocar o banco"); } }) as unknown as pg.Pool;
    const r = await runReconcilerPass(boom, { ...process.env, EVOLVE_RECONCILER: "off" } as NodeJS.ProcessEnv);
    expect(r).toMatchObject({ mode: "off", skipped: "off", detected: 0, cleaned: 0 });
    expect(await totalFindings()).toBe(before);
    expect((await childRow(c.childId)).status).toBe("materializing");
    expect((await ticketRow(c.ticketId!)).status).toBe("promoted");
    vi.useFakeTimers();
    try {
      const prev = process.env.EVOLVE_RECONCILER;
      delete process.env.EVOLVE_RECONCILER;
      startReconcilerWorker(() => boom);
      expect(vi.getTimerCount()).toBe(0);
      if (prev !== undefined) process.env.EVOLVE_RECONCILER = prev;
    } finally { vi.useRealTimers(); }
    ev("off", { findingsAntes: before, depois: await totalFindings(), filho: "materializing", ticket: "promoted" });
  });

  it("(1) shadow: claim vencido SEM efeitos é detectado e gravado, mas NÃO é limpo nem notificado", async () => {
    const c = await mkClaim();
    const r = await run("shadow");
    expect(r.cleaned).toBe(0);
    const f = await finding("claim_expired_no_effects", c.childId);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ mode: "shadow", action_taken: "shadow_would_clean", resolved_at: null, notified_at: null });
    expect((await childRow(c.childId)).status).toBe("materializing");
    const t = await ticketRow(c.ticketId!);
    expect(t).toMatchObject({ status: "promoted", child_project_id: c.childId });
    ev("shadow", { achado: f[0].kind, acao: f[0].action_taken, filho: "materializing", ticket: t.status });
  });

  it("(1) on: claim vencido SEM efeitos é limpo (filho failed, ticket reaberto) e auditado; rodar 3× não repete a limpeza", async () => {
    const c = await mkClaim();
    const r1 = await run("on");
    const r2 = await run("on");
    const r3 = await run("on");
    expect([r1.cleaned >= 1, r2.cleaned, r3.cleaned]).toEqual([true, 0, 0]);
    const ch = await childRow(c.childId);
    expect(ch.status).toBe("failed");
    expect(ch.extra.materialization).toMatchObject({ reason: "claim_expired_no_effects", reaped_by: "evolve_reconciler" });
    expect(ch.extra.materialization.reaped_at).toBeTruthy();
    expect(await ticketRow(c.ticketId!)).toMatchObject({ status: "open", child_project_id: null, promoted_at: null });
    const f = await finding("claim_expired_no_effects", c.childId);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ action_taken: "cleaned_claim_expired_no_effects", mode: "on" });
    expect(f[0].resolved_at).not.toBeNull();
    ev("limpeza", { filho: ch.status, reason: ch.extra.materialization.reason, ticket: "open", achados: f.length, limpezas: [r1.cleaned, r2.cleaned, r3.cleaned] });
  });

  it("(1) COM efeitos (passo marcado, linha de spec ou diretório em disco): só notifica; filho e ticket intactos", async () => {
    const withStep = await mkClaim({ steps: { spec_tree: { files: 1 } } });
    const withSpec = await mkClaim({ specFile: true });
    const withDisk = await mkClaim({ disk: true });
    for (let i = 0; i < 3; i++) await run("on");
    for (const c of [withStep, withSpec, withDisk]) {
      expect((await childRow(c.childId)).status).toBe("materializing");
      expect(await ticketRow(c.ticketId!)).toMatchObject({ status: "promoted", child_project_id: c.childId });
      const f = await finding("claim_expired_with_effects", c.childId);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "critical", action_taken: null, resolved_at: null });
      expect(f[0].detail.rule).toBe("notify_only_resume_by_repeating_request");
      expect(await finding("claim_expired_no_effects", c.childId)).toHaveLength(0);
    }
    expect((await finding("claim_expired_with_effects", withDisk.childId))[0].detail.disk).toEqual(["upload_dir"]);
    expect((await finding("claim_expired_with_effects", withStep.childId))[0].seen_count).toBe(3);
    ev("com-efeitos", { intactos: 3, achados: 3, vistas: 3 });
  });

  it("(1) lease vigente ou vencido dentro da carência não é achado", async () => {
    const live = await mkClaim({ leaseAgoS: -600 });
    const grace = await mkClaim({ leaseAgoS: 60 });
    await run("on");
    for (const c of [live, grace]) {
      expect((await childRow(c.childId)).status).toBe("materializing");
      expect(await finding("claim_expired_no_effects", c.childId)).toHaveLength(0);
      expect(await finding("claim_expired_with_effects", c.childId)).toHaveLength(0);
    }
  });

  it("(1) retomada concorrente: se o lease foi renovado entre a detecção e a limpeza, a limpeza é no-op", async () => {
    const c = await mkClaim();
    await pool.query(`UPDATE projects SET extra = jsonb_set(extra, '{materialization,lease_until}', to_jsonb(now() + interval '10 minutes')) WHERE id=$1`, [c.childId]);
    expect(await cleanExpiredClaim(pool, { id: c.childId, root: c.s.parentId }, resolveReconcilerParams({}))).toBe(false);
    expect((await childRow(c.childId)).status).toBe("materializing");
    expect((await ticketRow(c.ticketId!)).status).toBe("promoted");
    // e passo marcado depois da detecção também barra
    const d = await mkClaim();
    await pool.query(`UPDATE projects SET extra = jsonb_set(extra, '{materialization,steps,spec_tree}', '{"files":1}') WHERE id=$1`, [d.childId]);
    expect(await cleanExpiredClaim(pool, { id: d.childId, root: d.s.parentId }, resolveReconcilerParams({}))).toBe(false);
  });

  it("(2) ticket promovido sem filho: child nulo, filho inexistente e filho failed; recente não conta", async () => {
    const mk = async (childId: string | null, ageS: number) => {
      const s = await seed();
      const t = await seedTicket(pool, s, { status: "promoted", childProjectId: childId });
      await pool.query("UPDATE tickets SET updated_at = now() - ($2::int * interval '1 second') WHERE id=$1", [t.id, ageS]);
      return t.id;
    };
    const nul = await mk(null, 3600);
    const missing = await mk(randomUUID(), 3600);
    const failedChild = (await mkClaim({ ticket: false }));
    await pool.query("UPDATE projects SET status='failed' WHERE id=$1", [failedChild.childId]);
    const failed = await mk(failedChild.childId, 3600);
    const recent = await mk(null, 10);
    await run("on");
    expect((await finding("ticket_promoted_without_child", nul))[0].detail.reason).toBe("child_null");
    expect((await finding("ticket_promoted_without_child", missing))[0].detail.reason).toBe("child_missing");
    expect((await finding("ticket_promoted_without_child", failed))[0].detail.reason).toBe("child_failed");
    expect(await finding("ticket_promoted_without_child", recent)).toHaveLength(0);
    // nunca altera o ticket
    expect((await ticketRow(nul)).status).toBe("promoted");
    // a condição some ⇒ resolved_at; volta ⇒ reabre
    await pool.query("UPDATE tickets SET status='rejected' WHERE id=$1", [nul]);
    await run("on");
    expect((await finding("ticket_promoted_without_child", nul))[0].resolved_at).not.toBeNull();
    await pool.query("UPDATE tickets SET status='promoted' WHERE id=$1", [nul]);
    await run("on");
    const again = (await finding("ticket_promoted_without_child", nul))[0];
    expect(again.resolved_at).toBeNull();
    expect(again.notified_at).toBeNull();
    ev("ticket-sem-filho", { motivos: ["child_null", "child_missing", "child_failed"], recenteIgnorado: true, reabre: true });
  });

  it("(3) filho de evolução × ticket: cita ticket que não aponta de volta; ticket aponta para filho sem extra.ticket_id", async () => {
    const mkChild = async (extra: Record<string, unknown>) => {
      const s = await seed();
      const r = await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra, updated_at)
         VALUES ($1,$2,'filho','spec_submitted',$3,$4,2,$5::jsonb, now() - interval '1 hour') RETURNING id`,
        [s.tenantId, s.userId, s.productId, s.parentId, JSON.stringify({ evolution: true, ...extra })],
      );
      return { s, id: r.rows[0].id as string };
    };
    const a = await mkChild({});
    const ta = await seedTicket(pool, a.s, { status: "open" }); // ticket NÃO aponta para o filho
    await pool.query("UPDATE projects SET extra = extra || jsonb_build_object('ticket_id', $2::text) WHERE id=$1", [a.id, ta.id]);
    const b = await mkChild({});
    await seedTicket(pool, b.s, { status: "promoted", childProjectId: b.id }); // filho sem extra.ticket_id
    const ok = await mkChild({});
    const tok = await seedTicket(pool, ok.s, { status: "promoted", childProjectId: ok.id });
    await pool.query("UPDATE projects SET extra = extra || jsonb_build_object('ticket_id', $2::text) WHERE id=$1", [ok.id, tok.id]);
    await run("on");
    expect((await finding("child_ticket_mismatch", a.id))[0].detail.reason).toBe("child_cites_ticket_not_linked_back");
    expect((await finding("child_ticket_mismatch", b.id))[0].detail.reason).toBe("ticket_points_to_child_without_ticket_id");
    expect(await finding("child_ticket_mismatch", ok.id)).toHaveLength(0);
    ev("filho-sem-ticket", { a: "child_cites_ticket_not_linked_back", b: "ticket_points_to_child_without_ticket_id", ok: "sem achado" });
  });

  it("(4) EVOLUTION_IN_FLIGHT preso: filho vivo parado há mais de N horas; recente e `running` não contam", async () => {
    const mk = async (status: string, ageH: number) => {
      const s = await seed();
      const r = await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra, updated_at)
         VALUES ($1,$2,'filho',$3,$4,$5,2,'{"evolution":true}'::jsonb, now() - ($6::float8 * interval '1 hour')) RETURNING id`,
        [s.tenantId, s.userId, status, s.productId, s.parentId, ageH],
      );
      return r.rows[0].id as string;
    };
    const stuck = await mk("blocked_cyborg", 80);
    const stuck2 = await mk("needs_spec_input", 100);
    const fresh = await mk("blocked_cyborg", 5);
    const running = await mk("running", 200);
    await run("on");
    expect((await finding("evolution_in_flight_stuck", stuck))).toHaveLength(1);
    expect((await finding("evolution_in_flight_stuck", stuck2))[0].detail.status).toBe("needs_spec_input");
    expect(await finding("evolution_in_flight_stuck", fresh)).toHaveLength(0);
    expect(await finding("evolution_in_flight_stuck", running)).toHaveLength(0);
    expect((await childRow(stuck)).status).toBe("blocked_cyborg"); // nunca age
    ev("preso", { detectados: 2, ignorados: ["recente", "running"] });
  });

  it("(5) índices de unicidade ausentes são detectados; criados ⇒ achado resolvido", async () => {
    for (const d of UNIQUENESS_INDEXES) await pool.query(`DROP INDEX IF EXISTS ${d.name}`);
    await run("on");
    for (const d of UNIQUENESS_INDEXES) {
      const f = await finding("uniqueness_index_missing", d.name);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "critical", resolved_at: null });
      expect(f[0].detail.index).toBe(d.name);
    }
    // as fixtures acima podem ter duplicatas legítimas de teste: remove-as da frente antes de criar os índices
    await pool.query("UPDATE projects SET status='archived' WHERE (extra->>'evolution')='true' AND status NOT IN ('archived','failed')");
    await pool.query("UPDATE tickets SET child_project_id = NULL WHERE child_project_id IS NOT NULL");
    const rep = await ensureEvolutionUniqueness(pool, { error: () => undefined, info: () => undefined });
    expect(rep.created.length + rep.existing.length).toBe(UNIQUENESS_INDEXES.length);
    await run("on");
    for (const d of UNIQUENESS_INDEXES) {
      const f = (await finding("uniqueness_index_missing", d.name))[0];
      expect(f.resolved_at !== null || rep.dirty.some((x) => x.index === d.name)).toBe(true);
    }
    ev("indices", { ausentes: UNIQUENESS_INDEXES.length, criados: rep.created.length, sujos: rep.dirty.length });
  });

  it("idempotência: 3 passadas seguidas não duplicam achados nem mudam o primeiro registro (seen_count sobe)", async () => {
    const c = await mkClaim({ steps: { code: { source: "none" } } });
    await run("on");
    const first = (await finding("claim_expired_with_effects", c.childId))[0];
    await run("on");
    await run("on");
    const rows = await finding("claim_expired_with_effects", c.childId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(new Date(rows[0].detected_at).getTime()).toBe(new Date(first.detected_at).getTime());
    expect(rows[0].seen_count).toBe(3);
    expect(new Date(rows[0].last_seen_at).getTime()).toBeGreaterThanOrEqual(new Date(first.last_seen_at).getTime());
    const dup = await pool.query("SELECT kind, entity_hash, count(*)::int n FROM evolve_reconciler_findings GROUP BY 1,2 HAVING count(*) > 1");
    expect(dup.rows).toHaveLength(0);
  });

  it("concorrência: 2 reconciliadores simultâneos ⇒ uma limpeza só (advisory lock do job + WHERE); quem não pega o lock pula", async () => {
    const c = await mkClaim();
    const rs = await raceN(2, () => run("on"));
    const cleaned = rs.reduce((n, r) => n + r.cleaned, 0);
    expect(cleaned).toBe(1);
    expect(rs.filter((r) => r.skipped === "locked").length).toBeLessThanOrEqual(1);
    expect(await finding("claim_expired_no_effects", c.childId)).toHaveLength(1);
    expect((await childRow(c.childId)).status).toBe("failed");
    // lock do job segurado por outro cliente ⇒ a passada pula sem tocar em nada
    const d = await mkClaim();
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::int, 0)", [RECONCILER_LOCK_NS]);
      const r = await run("on");
      expect(r.skipped).toBe("locked");
      expect((await childRow(d.childId)).status).toBe("materializing");
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1::int, 0)", [RECONCILER_LOCK_NS]);
      holder.release();
    }
    // 6 chamadas diretas de limpeza em paralelo (sem o lock do job): o WHERE garante exatamente uma
    const e = await mkClaim();
    const direct = await raceN(6, () => cleanExpiredClaim(pool, { id: e.childId, root: e.s.parentId }, resolveReconcilerParams({})));
    expect(direct.filter(Boolean)).toHaveLength(1);
    ev("concorrencia", { passadas: rs.map((r) => r.skipped ?? "rodou"), limpezas: cleaned, diretas: direct.filter(Boolean).length });
  });

  it("sem PII: achados guardam só hash (16 hex); nenhum uuid em claro, e-mail ou nome", async () => {
    const c = await mkClaim({ steps: { ticket: { files: [] } } });
    await run("on");
    const all = JSON.stringify((await pool.query("SELECT * FROM evolve_reconciler_findings")).rows);
    expect(all).not.toContain(c.childId);
    expect(all).not.toContain(c.ticketId!);
    expect(all).not.toMatch(/@x\.test|Exportar CSV/);
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    const f = (await finding("claim_expired_with_effects", c.childId))[0];
    expect(f.project_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(f.ticket_hash === null || /^[0-9a-f]{16}$/.test(f.ticket_hash)).toBe(true);
  });

  it("endpoint: sem token 401; tenant_admin e token de serviço 403; zentriz_admin 200 (filtros por id viram hash e não são ecoados)", async () => {
    const c = await mkClaim({ steps: { code: { source: "none" } } });
    await run("on");
    const url = "/api/admin/evolve-reconciler/findings";
    const noAuth = await app.inject({ method: "GET", url });
    const tenant = await app.inject({ method: "GET", url, headers: { authorization: "Bearer x", "x-test-role": "tenant_admin" } });
    const svc = await app.inject({ method: "GET", url, headers: { authorization: "Bearer x", "x-test-role": "zentriz_admin", "x-test-svc": "runner" } });
    const ok = await app.inject({ method: "GET", url: `${url}?projectId=${c.childId}&open=true`, headers: { authorization: "Bearer x", "x-test-role": "zentriz_admin" } });
    expect([noAuth.statusCode, tenant.statusCode, svc.statusCode, ok.statusCode]).toEqual([401, 403, 403, 200]);
    const body = JSON.parse(ok.body);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ kind: "claim_expired_with_effects", project_hash: hashId(c.childId) });
    expect(ok.body).not.toContain(c.childId);
    const byKind = JSON.parse((await app.inject({ method: "GET", url: `${url}?kind=uniqueness_index_missing&open=false`, headers: { authorization: "Bearer x", "x-test-role": "zentriz_admin" } })).body);
    expect(byKind.findings.every((f: { kind: string }) => f.kind === "uniqueness_index_missing")).toBe(true);
    ev("endpoint", { codes: [noAuth.statusCode, tenant.statusCode, svc.statusCode, ok.statusCode], achadosDoProjeto: body.findings.length });
  });

  it("M-22: o lock de sessão do job usa outro namespace (7342): uma linhagem com hashtext(raiz)=0 no namespace do claim (7341) NÃO bloqueia o job", async () => {
    expect(RECONCILER_LOCK_NS).not.toBe(NS_EVOLVE);
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::int, 0)", [NS_EVOLVE]); // o que um claim de raiz com hash 0 seguraria
      const r = await run("shadow");
      expect(r.skipped).not.toBe("locked");
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1::int, 0)", [NS_EVOLVE]);
      holder.release();
    }
  });

  it("M-15: `on` sem PROJECT_FILES_ROOT/UPLOAD_DIR existentes ⇒ rebaixa para shadow (não limpa), registra o achado e ele some quando o ambiente é corrigido", async () => {
    const c = await mkClaim();
    const bad = { ...process.env, EVOLVE_RECONCILER: "on", PROJECT_FILES_ROOT: "" } as NodeJS.ProcessEnv;
    expect(reconcilerDiskProblems(bad)).toContain("PROJECT_FILES_ROOT");
    const r1 = await runReconcilerPass(pool, bad);
    expect(r1.mode).toBe("shadow");
    expect(r1.cleaned).toBe(0);
    expect((await childRow(c.childId)).status).toBe("materializing"); // nada foi limpo
    const f = await pool.query("SELECT severity, detail, resolved_at FROM evolve_reconciler_findings WHERE kind = 'reconciler_disk_unverifiable'");
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0].severity).toBe("critical");
    expect(f.rows[0].detail).toMatchObject({ configured_mode: "on", effective_mode: "shadow" });
    expect(f.rows[0].resolved_at).toBeNull();
    const r2 = await run("on"); // ambiente corrigido: opera em `on` e o achado é resolvido
    expect(r2.mode).toBe("on");
    expect(r2.cleaned).toBeGreaterThanOrEqual(1);
    const g = await pool.query("SELECT resolved_at FROM evolve_reconciler_findings WHERE kind = 'reconciler_disk_unverifiable'");
    expect(g.rows[0].resolved_at).not.toBeNull();
    ev("m15", { rebaixou: r1.mode, limpouDepois: r2.cleaned });
  });

  it("M-07: a limpeza do Q1 grava o evento promoted→open (reason claim_expired_no_effects) quando TICKET_TRANSITIONS=on", async () => {
    vi.stubEnv("TICKET_TRANSITIONS", "on");
    try {
      const c = await mkClaim();
      await run("on");
      expect(await ticketRow(c.ticketId!)).toMatchObject({ status: "open", child_project_id: null });
      const evs = (await pool.query("SELECT from_status, to_status, actor_kind, reason, child_project_id FROM ticket_events WHERE ticket_id = $1", [c.ticketId])).rows;
      expect(evs).toEqual([{ from_status: "promoted", to_status: "open", actor_kind: "system", reason: "claim_expired_no_effects", child_project_id: c.childId }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
