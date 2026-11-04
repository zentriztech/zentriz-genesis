/**
 * Fase 2 / lote B — S-02 (regressão): o rascunho `card_draft` (extra.card_ticket_id, SEM ticket_id) e o filho promovido do MESMO ticket
 * coexistem. Banco DESCARTÁVEL com `initDb` (os índices U1–U4 nascem no boot; sem eles o teste seria vacuamente verde).
 *   • `/evolve` do ticket-card não dá 500 (409 USE_CARD_PROMOTE) e, com um rascunho órfão de ticket legado, promove (201);
 *   • `uq_projects_ticket_live` segue valendo para o filho e não vê o rascunho; `findExisting` não adota o rascunho (replay = mesmo filho);
 *   • o reconciliador não gera achado para o rascunho.
 * Só roda com PG_TEST_URL (localhost:55432|55440|55441).
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, childrenOf, sha256, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { cardRoutes } from "./cards.js";
import { ticketRoutes } from "./tickets.js";
import { projectRoutes } from "./projects.js";
import { hashId } from "../services/anomalyDetectors.js";
import { runReconcilerPass } from "../services/evolveReconciler.js";

const RFC = `# RFC-0001 — Exportar entregas em CSV

## Sumário
Permitir exportar a lista de entregas em CSV a partir da tela de entregas.

## Non-goals
Não altera o cálculo de prazos nem a tela de mapa.

## Requisitos
- REQ-01 — O sistema DEVE gerar um CSV com as entregas do filtro atual.

## Critérios de aceite
### Cenário: exportar entregas
- **Dado** um usuário autenticado com entregas
- **Quando** clica em "Exportar CSV"
- **Então** recebe um arquivo CSV com todas as entregas

## Compatibilidade
- Tipo (SemVer): MINOR
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
  - "apps/api/src/deliveries/**"
  - "tests/**"
\`\`\`
`;

describePg("Fase 2 / S-02 — rascunho e filho do mesmo ticket (Postgres real, com índices de boot)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const as = (s: Seed) => Object.assign(testUser, { id: s.userId, role: "tenant_admin", tenantId: s.tenantId });

  beforeAll(async () => {
    scratch = await createScratchDb("evo_ticketkeys");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    const { ensureEvolutionUniqueness } = await import("../services/evolutionUniqueness.js"); // passo de boot (src/index.ts), fora do initDb
    const rep = await ensureEvolutionUniqueness(pool as unknown as Parameters<typeof ensureEvolutionUniqueness>[0]);
    expect(rep.dirty).toEqual([]);
    app = await buildApp([cardRoutes, ticketRoutes, projectRoutes]);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    for (const x of seeds) x.cleanup();
    await scratch?.drop();
  });

  it("os índices de boot existem neste banco (controle contra falso verde)", async () => {
    const r = await pool.query("SELECT indexname FROM pg_indexes WHERE indexname IN ('uq_projects_ticket_live','uq_projects_one_live_evolution_child')");
    expect(r.rows.map((x) => x.indexname).sort()).toEqual(["uq_projects_one_live_evolution_child", "uq_projects_ticket_live"]);
  });

  it("card pronto: /evolve legado ⇒ 409 (nunca 500); promoção ⇒ 201 com rascunho vivo; replay = mesmo filho; índice e reconciliador sem colisão", async () => {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(s);
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA','1',$1)", [s.tenantId]);
    as(s);
    const c = await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: "feature", title: "Exportar CSV", body: "Quero baixar a lista de entregas em CSV." } });
    expect(c.statusCode, c.body).toBe(201);
    const card = c.json() as { id: string; draftProjectId: string };
    const dir = join(s.uploadDir, card.draftProjectId, "docs/rfc");
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, "RFC-0001-exportar-csv.md");
    writeFileSync(fp, RFC, "utf-8");
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256) VALUES ($1,'RFC-0001-exportar-csv.md',$2,'text/markdown','docs/rfc',false,$3)`,
      [card.draftProjectId, fp, sha256(RFC)],
    );
    expect((await app.inject({ method: "POST", url: `/api/cards/${card.id}/ready` })).statusCode).toBe(200);

    const draft = (await pool.query("SELECT status, extra FROM projects WHERE id = $1", [card.draftProjectId])).rows[0];
    expect(draft.status).toBe("card_draft");
    expect(draft.extra.card_ticket_id).toBe(card.id);
    expect(draft.extra).not.toHaveProperty("ticket_id");

    const legacy = await app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "x", ticketId: card.id } });
    expect(legacy.statusCode, legacy.body).toBe(409);
    expect(legacy.json().code).toBe("USE_CARD_PROMOTE");

    const pr = await app.inject({ method: "POST", url: `/api/cards/${card.id}/promote` });
    expect(pr.statusCode, pr.body).toBe(201);
    const childId = pr.json().childProjectId as string;
    const live = (await pool.query("SELECT id FROM projects WHERE extra->>'ticket_id' = $1 AND status NOT IN ('failed','archived')", [card.id])).rows;
    expect(live.map((x) => x.id)).toEqual([childId]);
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [card.draftProjectId])).rows[0].status).toBe("card_draft");

    const again = await app.inject({ method: "POST", url: `/api/cards/${card.id}/promote` });
    expect([200, 201]).toContain(again.statusCode);
    expect(again.json().childProjectId).toBe(childId);
    expect((await childrenOf(pool, s.parentId)).length).toBe(1);

    // o índice continua valendo para o que importa
    await expect(pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra)
       VALUES ($1,$2,'dup','draft',$3,$4,9, jsonb_build_object('evolution', true, 'ticket_id', $5::text))`,
      [s.tenantId, s.userId, s.productId, s.parentId, card.id])).rejects.toMatchObject({ code: "23505" });

    const env = { EVOLVE_RECONCILER: "shadow" } as NodeJS.ProcessEnv;
    let r = await runReconcilerPass(pool, env);
    for (let i = 0; i < 40 && r.skipped === "locked"; i++) { await new Promise((res) => setTimeout(res, 250)); r = await runReconcilerPass(pool, env); }
    expect(r.skipped).toBeUndefined();
    const fd = (await pool.query("SELECT kind FROM evolve_reconciler_findings WHERE entity_hash = $1", [hashId(card.draftProjectId)])).rows;
    expect(fd).toEqual([]);
    console.log(`[F2-B-S02] EVIDÊNCIA ${JSON.stringify({ legacy: legacy.statusCode, promote: pr.statusCode, replay: again.statusCode, achadosDoRascunho: fd.length })}`);
  });

  it("ticket LEGADO com rascunho órfão de card (flag desligada depois): /evolve promove normalmente (201), com e sem EVOLVE_CLAIM", async () => {
    for (const claim of ["off", "on"]) {
      vi.stubEnv("EVOLVE_CLAIM", claim);
      const s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
      seeds.push(s);
      const t = await seedTicket(pool, s);
      await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, extra)
         VALUES ($1,$2,'rasc','card_draft',$3,0, jsonb_build_object('card', true, 'evolution', true, 'card_ticket_id', $4::text))`,
        [s.tenantId, s.userId, s.productId, t.id]);
      as(s);
      const r = await app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "x", ticketId: t.id } });
      expect(r.statusCode, `claim=${claim} ${r.body}`).toBe(201);
      expect((await childrenOf(pool, s.parentId)).length).toBe(1);
    }
    vi.unstubAllEnvs();
  });
});
