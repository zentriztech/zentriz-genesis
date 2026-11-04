/**
 * Fase 2 — REGRESSÃO com CARDS_BANCADA=off (padrão): os caminhos antigos (PATCH de ticket, /evolve legado com ticket,
 * descarte do filho, tarefas) não leem nem escrevem as colunas novas e a resposta não ganha chaves. Postgres REAL, tenant isolado.
 * Mais uma guarda estática: nenhum arquivo de produto fora da lista abaixo menciona as colunas novas.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, childrenOf, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";
import { reopenTicketsOfChild } from "../services/tickets.js";

describePg("Fase 2 — CARDS_BANCADA=off: caminhos antigos não tocam as colunas novas (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let s: Seed;

  beforeAll(async () => {
    pool = await openPg();
    s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    app = await buildApp([projectRoutes, ticketRoutes]);
  }, 60_000);
  afterAll(async () => { await app?.close(); s?.cleanup(); await pool?.end(); });

  it("PATCH, /evolve legado com ticket, tarefas e reabertura do filho: colunas novas seguem NULL/default e nenhum evento de card", async () => {
    const t1 = await seedTicket(pool, s), t2 = await seedTicket(pool, s);
    const rej = await app.inject({ method: "PATCH", url: `/api/tickets/${t2.id}`, payload: { status: "rejected" } });
    expect(rej.statusCode).toBe(200);
    const ev = await app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "Exportar CSV", ticketId: t1.id } });
    expect(ev.statusCode).toBe(201);
    const kid = (await childrenOf(pool, s.parentId))[0];
    await pool.query(`INSERT INTO project_tasks (project_id, task_id, module, owner_role) VALUES ($1,'TSK-BE-001','backend','DEV')`, [kid.id]);
    const tasks = await app.inject({ method: "GET", url: `/api/projects/${kid.id}/tasks` });
    expect(tasks.statusCode).toBe(200);
    for (const row of tasks.json()) {
      expect(Object.keys(row).sort()).toEqual(["artifactsRef", "createdAt", "evidence", "id", "module", "monitorAttempted", "ownerRole", "projectId", "requirements", "status", "taskId", "updatedAt"]);
    }
    expect(await reopenTicketsOfChild(pool, kid.id)).toBe(1);

    const tk = await pool.query("SELECT status, card_state, blocked_reason, origin, external_ref, draft_project_id, card_contract_version FROM tickets WHERE tenant_id = $1 ORDER BY number", [s.tenantId]);
    expect(tk.rows.map((r) => r.status)).toEqual(["open", "rejected"]);
    for (const r of tk.rows) expect(r).toMatchObject({ card_state: null, blocked_reason: null, origin: "manual", external_ref: null, draft_project_id: null, card_contract_version: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM ticket_card_events WHERE ticket_id IN (SELECT id FROM tickets WHERE tenant_id = $1)", [s.tenantId])).rows[0].n).toBe(0);
    const files = await pool.query(
      "SELECT count(*)::int AS n FROM project_spec_files f JOIN projects p ON p.id = f.project_id WHERE p.tenant_id = $1 AND (f.spec_origin IS NOT NULL OR f.executed_in_project IS NOT NULL OR f.executed_at IS NOT NULL)", [s.tenantId]);
    expect(files.rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM project_tasks pt JOIN projects p ON p.id = pt.project_id WHERE p.tenant_id = $1 AND (pt.card_id IS NOT NULL OR pt.origin_spec_file IS NOT NULL)", [s.tenantId])).rows[0].n).toBe(0);
  });

  // S-05 (lote B): contrato de chaves das respostas de ticket com a flag desligada.
  const LEGACY_TICKET_KEYS = [
    "attachments_count", "body", "change_kind", "child_project_id", "code", "created_at", "created_by", "delivered_at", "execution_status",
    "execution_title", "extra", "id", "number", "product_id", "project_id", "promoted_at", "status", "tenant_id", "title", "updated_at",
  ];
  const CARD_KEYS = ["blocked_reason", "card_contract_version", "card_state", "draft_project_id", "external_ref", "origin"];
  const keys = (o: object) => Object.keys(o).sort();

  it("S-05: com a flag OFF nenhuma resposta de ticket (POST, lista, detalhe, PATCH) traz as colunas de card — conjunto de chaves idêntico ao contrato anterior", async () => {
    const created = await app.inject({ method: "POST", url: `/api/products/${s.productId}/tickets`, payload: { title: "Contrato", body: "Pedido para o contrato de chaves." } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect(keys(created.json())).toEqual(LEGACY_TICKET_KEYS);
    const list = await app.inject({ method: "GET", url: `/api/products/${s.productId}/tickets` });
    expect(list.statusCode).toBe(200);
    for (const row of list.json() as object[]) expect(keys(row)).toEqual(LEGACY_TICKET_KEYS);
    const detail = await app.inject({ method: "GET", url: `/api/tickets/${id}` });
    expect(keys(detail.json())).toEqual([...LEGACY_TICKET_KEYS, "attachments"].sort());
    const patched = await app.inject({ method: "PATCH", url: `/api/tickets/${id}`, payload: { title: "Contrato 2" } });
    expect(keys(patched.json())).toEqual(LEGACY_TICKET_KEYS);
    const rej = await app.inject({ method: "PATCH", url: `/api/tickets/${id}`, payload: { status: "rejected" } });
    expect(keys(rej.json())).toEqual(LEGACY_TICKET_KEYS);
    console.log(`[F2-S05] EVIDÊNCIA ${JSON.stringify({ chavesOff: keys(detail.json()) })}`);
  });

  it("S-05: as chaves de card só aparecem para ticket que É card em tenant com a flag ligada (ticket legado com a flag on e card com a flag off continuam sem elas)", async () => {
    const t = await seedTicket(pool, s);
    const legacyOn = async () => keys((await app.inject({ method: "GET", url: `/api/tickets/${t.id}` })).json());
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA','1',$1)", [s.tenantId]);
    try {
      expect(await legacyOn()).toEqual([...LEGACY_TICKET_KEYS, "attachments"].sort());            // flag on, ticket legado
      await pool.query("UPDATE tickets SET card_state = 'draft', card_contract_version = 1 WHERE id = $1", [t.id]);
      const asCard = (await app.inject({ method: "GET", url: `/api/tickets/${t.id}` })).json();
      expect(keys(asCard)).toEqual([...LEGACY_TICKET_KEYS, ...CARD_KEYS, "attachments"].sort());   // flag on, card
      expect(asCard).toMatchObject({ card_state: "draft", origin: "manual", blocked_reason: null });
    } finally {
      await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id = $1", [s.tenantId]);
    }
    expect(await legacyOn()).toEqual([...LEGACY_TICKET_KEYS, "attachments"].sort());               // flag off de novo: card some do contrato
    await pool.query("UPDATE tickets SET card_state = NULL, card_contract_version = NULL WHERE id = $1", [t.id]);
  });
});

describe("Fase 2 — guarda estática: só o código novo da Fase 2 menciona as colunas novas", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ALLOWED = new Set([
    "services/cardState.ts", "services/cardsBackfill.ts", "services/cardDelivery.ts", "services/taskCardLinks.ts", // código novo (Fase 2, 2.1-2.5)
    "services/cardService.ts", "services/cardPromote.ts", "routes/cards.ts",           // API de cards (2.6)
    // 2.6 (d): escritores legados roteados pela máquina. Cada um só TOCA a coluna para ticket que já é card (card_state não nulo);
    // com a flag off nenhum ticket tem card_state, e a regressão acima prova que nada muda.
    "routes/tickets.ts", "routes/projects.ts", "services/tickets.ts", "services/evolveClaim.ts", "services/evolveReconciler.ts",
    "services/evolutionUniqueness.ts",                                                 // índice de boot uq_tickets_draft
    "services/featureFlags.ts", "services/ticketTransitions.ts", "routes/runtimeConfig.ts", // só comentários
    // Fase 3 (3.3/3.5): jornada do card, guarda da spec do rascunho (lê o estado do card dono do `card_draft`) e veredito do `card_draft`.
    "services/cardJourney.ts", "services/cardSpecGuard.ts", "services/promotability.ts",
    "services/specChatJobs.ts", // homônimo: chave `blocked_reason` do JSON de erro do job (não é a coluna de tickets)
  ]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { if (f === "db" || f === "node_modules") continue; walk(p, out); }
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }
  it("nenhum outro arquivo de produto lê ou escreve card_state/card_id/spec_origin/origin_spec_file/draft_project_id/ticket_card_events", () => {
    const root = join(here, "..");
    const re = /\bcard_state\b|\bcard_id\b|\borigin_spec_file\b|\bspec_origin\b|\bdraft_project_id\b|\bticket_card_events\b|\bcard_contract_version\b|\bexecuted_in_project\b|\bexecuted_at\b|\bblocked_reason\b|\bexternal_ref\b/;
    const offenders = walk(root).map((f) => relative(root, f)).filter((rel) => !ALLOWED.has(rel) && re.test(readFileSync(join(root, rel), "utf-8")));
    expect(offenders).toEqual([]);
  });
});
