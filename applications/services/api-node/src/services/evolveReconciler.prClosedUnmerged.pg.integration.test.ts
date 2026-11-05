/**
 * Rodada 4.5c / BD — detector `card_pr_closed_unmerged` do reconciliador: card `in_factory` cujo filho `accepted` tem o PR FECHADO sem merge
 * vira `blocked` (`pr_closed_unmerged`, ator `reconciler`) e gera achado; `shadow` só registra. Repositório/GitHub SIMULADOS (cliente injetável
 * `getPullRequest`, sem rede), mesma prova da entrega (`verifyChildPrMerged`). Postgres real em banco descartável; só roda com PG_TEST_URL.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type pg from "pg";
import { describePg, createScratchDb, dbClientMock, seedAcceptedProduct, seedTicket, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());

import { hashId } from "./anomalyDetectors.js";
import { runReconcilerPass } from "./evolveReconciler.js";
import { setGuardSetting } from "./llmGuard.js";
import { syncCardWithChild } from "./cardPromote.js";
import { rejectCardByUser } from "./cardReject.js";
import type { DeliveryDeps, PrLookup } from "./cardDelivery.js";

describePg("detector card_pr_closed_unmerged (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  const seeds: Seed[] = [];
  const dirs: string[] = [];
  let ver = 1;
  const prs: Record<number, PrLookup> = {};
  const calls: number[] = [];
  const deps: DeliveryDeps = { getPullRequest: async (_i, o) => { calls.push(o.number); return prs[o.number] ?? { ok: false, error: "sem resposta" }; } };
  const env = (mode: "shadow" | "on") => {
    if (mode === "shadow") return { EVOLVE_RECONCILER: "shadow" } as NodeJS.ProcessEnv;
    const d = mkdtempSync(join(tmpdir(), "genesis-bd-")); dirs.push(d);
    return { EVOLVE_RECONCILER: "on", PROJECT_FILES_ROOT: d, UPLOAD_DIR: d } as NodeJS.ProcessEnv;
  };

  beforeAll(async () => {
    scratch = await createScratchDb("evo_bd");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    await setGuardSetting(pool, "kill_switch", "off", "test");
  }, 120_000);
  afterAll(async () => {
    for (const s of seeds) s.cleanup();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await scratch?.drop();
  });

  /** Produto com repositório na raiz + card in_factory + filho `accepted` com o PR `pr`. */
  const mkHung = async (pr: number, lookup: PrLookup) => {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 30 });
    seeds.push(s);
    await pool.query(`INSERT INTO tenant_github_installations (tenant_id, installation_id, github_login) VALUES ($1, 4242, 'acme') ON CONFLICT (tenant_id) DO NOTHING`, [s.tenantId]);
    await pool.query(`INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url) VALUES ($1,'app','acme/app','https://github.com/acme/app','https://github.com/acme/app.git')`, [s.parentId]);
    prs[pr] = lookup;
    const child = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id, extra)
       VALUES ($1,$2,'filho','accepted',$3,$4,$5,$4,$6::jsonb) RETURNING id`,
      [s.tenantId, s.userId, s.productId, s.parentId, ++ver + 100,
        JSON.stringify({ evolution: true, evolution_origin: "card", evolution_pr_number: pr, evolution_publish_state: "done", evolution_publish_mode: "pr" })],
    )).rows[0].id as string;
    const t = await seedTicket(pool, s, { status: "open" });
    await pool.query("UPDATE tickets SET card_state = 'in_factory', status = 'promoted', child_project_id = $2 WHERE id = $1", [t.id, child]);
    return { s, child, id: t.id };
  };
  const card = async (id: string) => (await pool.query("SELECT card_state, blocked_reason FROM tickets WHERE id = $1", [id])).rows[0] as { card_state: string; blocked_reason: string | null };
  const blockedEvents = async (id: string) => (await pool.query("SELECT actor_kind, reason FROM ticket_card_events WHERE ticket_id = $1 AND to_state = 'blocked'", [id])).rows;
  const findings = async (open = true) => (await pool.query(
    `SELECT kind, severity, mode, action_taken, resolved_at, notified_at FROM evolve_reconciler_findings WHERE kind = 'card_pr_closed_unmerged' ${open ? "AND resolved_at IS NULL" : ""}`)).rows;

  it("PR FECHADO sem merge: shadow só registra (card intacto); on bloqueia (pr_closed_unmerged, reconciler), repetir não duplica e a sync não reabre", async () => {
    const { id } = await mkHung(7, { ok: true, merged: false, state: "closed" });
    const shadow = await runReconcilerPass(pool, env("shadow"), deps);
    expect(shadow.byKind.card_pr_closed_unmerged).toBe(1);
    expect(await card(id)).toMatchObject({ card_state: "in_factory", blocked_reason: null });
    expect(await findings()).toMatchObject([{ severity: "critical", mode: "shadow", action_taken: "shadow_would_block" }]);

    const on = await runReconcilerPass(pool, env("on"), deps);
    expect(on.mode).toBe("on");
    expect(on.byKind.card_pr_closed_unmerged).toBe(1);
    expect(await card(id)).toMatchObject({ card_state: "blocked", blocked_reason: "pr_closed_unmerged" });
    expect(await blockedEvents(id)).toEqual([{ actor_kind: "reconciler", reason: "pr_closed_unmerged" }]);
    const f = await findings();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ mode: "on", action_taken: "blocked_pr_closed_unmerged" });

    await runReconcilerPass(pool, env("on"), deps);                       // repetir: sem evento novo, achado continua aberto
    expect(await blockedEvents(id)).toHaveLength(1);
    expect(await findings()).toHaveLength(1);
    expect(await syncCardWithChild(pool, id)).toBeNull();                 // a sync (jornada) não devolve o card à fábrica
    expect((await card(id)).card_state).toBe("blocked");
  });

  it("saída: o humano recusa o card bloqueado por pr_closed_unmerged ⇒ rejected, filho arquivado e o achado some na passada seguinte", async () => {
    const { id, child } = await mkHung(8, { ok: true, merged: false, state: "closed" });
    await runReconcilerPass(pool, env("on"), deps);
    expect((await card(id)).blocked_reason).toBe("pr_closed_unmerged");
    const r = await rejectCardByUser(pool, id, { id: seeds[seeds.length - 1].userId }, { deps });
    expect(r.kind).toBe("applied");
    expect((await card(id)).card_state).toBe("rejected");
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [child])).rows[0].status).toBe("archived");
    const th = hashId(id);
    const open = async () => (await pool.query("SELECT 1 FROM evolve_reconciler_findings WHERE kind = 'card_pr_closed_unmerged' AND ticket_hash = $1 AND resolved_at IS NULL", [th])).rowCount;
    expect(await open()).toBe(1);
    await runReconcilerPass(pool, env("on"), deps);
    expect(await open()).toBe(0);
  });

  it("NÃO é achado: PR aberto, consulta ao GitHub falha, PR mergeado (vira entrega, não bloqueio)", async () => {
    const open = await mkHung(9, { ok: true, merged: false, state: "open" });
    const down = await mkHung(10, { ok: false, error: "502" });
    const merged = await mkHung(11, { ok: true, merged: true, state: "closed" });
    await runReconcilerPass(pool, env("on"), deps);
    expect((await card(open.id)).card_state).toBe("in_factory");
    expect((await card(down.id)).card_state).toBe("in_factory");
    expect((await card(merged.id)).card_state).toBe("delivered");
    expect((await blockedEvents(open.id)).length + (await blockedEvents(down.id)).length + (await blockedEvents(merged.id)).length).toBe(0);
    expect(calls).toContain(9);
  });
});
