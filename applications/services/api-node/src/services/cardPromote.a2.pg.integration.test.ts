/**
 * AV / A-2 — o card volta a `blocked` na SEGUNDA ocorrência (segunda pausa de orçamento; segundo filho que falha), sem duplicar evento
 * na repetição da MESMA ocorrência; e o reconciliador alarma card `in_factory` cujo filho vivo está parado por orçamento/falha.
 * Postgres real em banco descartável; só roda com PG_TEST_URL.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type pg from "pg";
import { describePg, createScratchDb, dbClientMock, seedAcceptedProduct, seedTicket, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());

import { syncCardWithChild } from "./cardPromote.js";
import { transitionCard } from "./cardState.js";
import { setGuardSetting } from "./llmGuard.js";
import { runReconcilerPass } from "./evolveReconciler.js";

describePg("A-2 (AV) — dedupe por ocorrência e detector de card parado (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  const seeds: Seed[] = [];
  const dirs: string[] = [];
  let ver = 1;

  beforeAll(async () => {
    scratch = await createScratchDb("evo_a2");
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

  const mkChild = async (s: Seed, status: string, stoppedBy: string | null = null) =>
    (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, stopped_by, product_id, parent_project_id, version_number, budget_owner_project_id)
       VALUES ($1,$2,'filho',$3,$4,$5,$6,$7,$6) RETURNING id`, [s.tenantId, s.userId, status, stoppedBy, s.productId, s.parentId, ++ver + 100],
    )).rows[0].id as string;
  /** Card `in_factory` ligado ao filho (estado real após a promoção + entrada do filho na fábrica). */
  const mkCard = async (s: Seed, childId: string) => {
    const t = await seedTicket(pool, s, { status: "open" });
    await pool.query("UPDATE tickets SET card_state = 'in_factory', status = 'promoted', child_project_id = $2 WHERE id = $1", [t.id, childId]);
    return t.id;
  };
  const newSeed = async () => { const s = await seedAcceptedProduct(pool, { budgetUsd: 30 }); seeds.push(s); return s; };
  const card = async (id: string) => (await pool.query("SELECT card_state, blocked_reason, child_project_id FROM tickets WHERE id = $1", [id])).rows[0];
  const blockedEvents = async (id: string) =>
    (await pool.query("SELECT dedupe_key FROM ticket_card_events WHERE ticket_id = $1 AND to_state = 'blocked' ORDER BY id", [id])).rows.map((r) => String(r.dedupe_key));
  const pause = (ownerId: string) => pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'saldo' WHERE id = $1", [ownerId]);
  const resume = (ownerId: string) => pool.query("UPDATE projects SET budget_paused_at = NULL, budget_paused_reason = NULL WHERE id = $1", [ownerId]);

  it("segunda pausa de orçamento no MESMO filho (pausa → retomada → pausa): o card volta a blocked; repetir a passada não duplica", async () => {
    const s = await newSeed();
    const child = await mkChild(s, "stopped", "budget");
    const id = await mkCard(s, child);

    await pause(s.parentId);
    expect((await syncCardWithChild(pool, id))?.kind).toBe("applied");
    expect(await card(id)).toMatchObject({ card_state: "blocked", blocked_reason: "budget:BUDGET_PAUSED" });
    expect(await syncCardWithChild(pool, id)).toBeNull();                       // repetição: nada a fazer
    expect(await blockedEvents(id)).toHaveLength(1);

    await resume(s.parentId);                                                    // retomada humana: card volta a in_factory
    expect((await syncCardWithChild(pool, id))?.kind).toBe("applied");
    expect((await card(id)).card_state).toBe("in_factory");

    await new Promise((r) => setTimeout(r, 15));                                 // o carimbo da pausa é em ms
    await pause(s.parentId);                                                     // SEGUNDA pausa, mesmo filho, mesmo código
    const again = await syncCardWithChild(pool, id);
    expect(again?.kind).toBe("applied");
    expect(await card(id)).toMatchObject({ card_state: "blocked", blocked_reason: "budget:BUDGET_PAUSED" });
    const keys = await blockedEvents(id);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(await syncCardWithChild(pool, id)).toBeNull();                        // repetir a 2ª ocorrência não duplica
    expect(await blockedEvents(id)).toHaveLength(2);
  });

  it("segundo filho que falha (blocked por child_failed → novo filho → falha): o card volta a blocked", async () => {
    const s = await newSeed();
    const child1 = await mkChild(s, "running");
    const id = await mkCard(s, child1);
    await pool.query("UPDATE projects SET status = 'failed' WHERE id = $1", [child1]);
    expect((await syncCardWithChild(pool, id))?.kind).toBe("applied");
    expect((await card(id)).card_state).toBe("blocked");

    // reabertura legítima: blocked → ready (filho descartado) → promoted com OUTRO filho → in_factory
    const child2 = await mkChild(s, "running");
    expect((await transitionCard(pool, { ticketId: id, to: "ready", actorKind: "system", reason: "reopen" })).kind).toBe("applied");
    expect((await transitionCard(pool, { ticketId: id, to: "promoted", actorKind: "system", childProjectId: child2 })).kind).toBe("applied");
    expect((await syncCardWithChild(pool, id))?.kind).toBe("applied");
    expect((await card(id)).card_state).toBe("in_factory");

    await pool.query("UPDATE projects SET status = 'failed' WHERE id = $1", [child2]);
    expect((await syncCardWithChild(pool, id))?.kind).toBe("applied");
    expect(await card(id)).toMatchObject({ card_state: "blocked", blocked_reason: "child_failed" });
    const keys = await blockedEvents(id);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(await syncCardWithChild(pool, id)).toBeNull();
    expect(await blockedEvents(id)).toHaveLength(2);
  });

  it("reconciliador: card in_factory com filho parado por orçamento ⇒ achado card_child_stalled (shadow) e, em `on`, transição + sem achado", async () => {
    const s = await newSeed();
    const child = await mkChild(s, "stopped", "budget");
    const id = await mkCard(s, child);
    await pause(s.parentId);
    await pool.query("UPDATE projects SET updated_at = now() - interval '2 hours' WHERE id = $1", [child]);
    const stalled = async () => (await pool.query("SELECT 1 FROM evolve_reconciler_findings WHERE kind = 'card_child_stalled' AND resolved_at IS NULL")).rowCount ?? 0;

    const shadow = await runReconcilerPass(pool, { EVOLVE_RECONCILER: "shadow" } as NodeJS.ProcessEnv);
    expect(shadow.byKind.card_child_stalled).toBe(1);
    expect(await stalled()).toBe(1);
    expect((await card(id)).card_state).toBe("in_factory");                      // shadow só detecta

    const dir = mkdtempSync(join(tmpdir(), "genesis-a2-")); dirs.push(dir);
    const on = await runReconcilerPass(pool, { EVOLVE_RECONCILER: "on", PROJECT_FILES_ROOT: dir, UPLOAD_DIR: dir } as NodeJS.ProcessEnv);
    expect(on.mode).toBe("on");
    expect((await card(id)).card_state).toBe("blocked");
    expect(on.byKind.card_child_stalled ?? 0).toBe(0);
    expect(await stalled()).toBe(0);                                             // condição cessou ⇒ achado resolvido
  });
});
