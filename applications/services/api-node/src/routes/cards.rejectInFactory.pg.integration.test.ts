/**
 * Saída humana do card pendurado em `promoted|in_factory` (rodada 4.5c / BD) — Postgres REAL efêmero, rotas reais, GitHub simulado (sem rede):
 *  1. `PATCH /api/tickets/:id {status:"rejected"}` e `POST /api/cards/:id/reject` recusam `promoted|in_factory` (antes: 409 TICKET_INVALID_TRANSITION):
 *     filho vivo ARQUIVADO por CAS com `extra.card_rejected`, evento auditado (`manual_reject_in_factory`), idempotente, papel (autor/tenant_admin),
 *     CAS perdido desfaz TUDO, corrida com a entrega serializada; filho com PR mergeado ⇒ 409 CARD_ALREADY_DELIVERABLE; prova inconclusiva ⇒ 409
 *     CARD_MERGE_UNVERIFIED; filho em execução ⇒ 409 CARD_CHILD_ACTIVE; card `delivered` nunca recusa.
 *  3. Linhagem após a recusa: v6 entregue, v7 (card A) aceito e NÃO mergeado, v8 (card B) sobre v7 ⇒ sem recusar, promover um card novo é 409
 *     CARD_PREVIOUS_UNMERGED; recusar B devolve a base a v7 (ainda bloqueia por A); recusar A devolve a base a v6/dev e a promoção volta a ser
 *     permitida (nos dois sentidos de ordem), com corrida de duas promoções criando exatamente 1 filho.
 * Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import {
  describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, childrenOf, raceN, sha256, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { cardRoutes } from "./cards.js";
import { ticketRoutes } from "./tickets.js";
import { __setOctokitFactoryForTests } from "../services/github.js";
import { transitionCard } from "../services/cardState.js";
import { rejectCardByUser } from "../services/cardReject.js";
import { resolveLineageHead } from "../services/lineage.js";

const rfc = (n: number, title: string) => `# RFC-${String(n).padStart(4, "0")} — ${title}

## Sumário
Permitir ${title.toLowerCase()} a partir da tela de entregas.

## Non-goals
Não altera o cálculo de prazos nem a tela de mapa.

## Requisitos
- REQ-01 — O sistema DEVE atender: ${title}.

## Critérios de aceite
### Cenário: ${title}
- **Dado** um usuário autenticado com entregas
- **Quando** usa a função
- **Então** recebe o resultado esperado

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

type PrState = "open" | "closed" | "merged" | "error";

describePg("Saída humana de card in_factory/promoted (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const prs: Record<number, PrState> = {};

  beforeAll(async () => { pool = await openPg(); app = await buildApp([cardRoutes, ticketRoutes]); }, 60_000);
  afterAll(async () => { await app?.close(); for (const s of seeds) s.cleanup(); await pool?.end(); });
  afterEach(() => { __setOctokitFactoryForTests(null); for (const k of Object.keys(prs)) delete prs[Number(k)]; });

  const as = (s: Seed, role = "tenant_admin", id?: string) => Object.assign(testUser, { id: id ?? s.userId, email: `u@${s.tenantId}.test`, role, tenantId: s.tenantId });
  const fakeGithub = () => __setOctokitFactoryForTests(async () => ({
    pulls: {
      get: async ({ pull_number }: { pull_number: number }) => {
        const st = prs[pull_number] ?? "open";
        if (st === "error") throw Object.assign(new Error("boom"), { status: 502 });
        return { data: { state: st === "open" ? "open" : "closed", merged: st === "merged", mergeable: true, mergeable_state: "clean", head: { sha: "H" }, base: { ref: "dev" }, merge_commit_sha: st === "merged" ? "M" : null } };
      },
    },
  }) as never);

  /** Produto com repositório na RAIZ da linhagem (a prova de merge consulta o GitHub) e a flag de cards ligada. */
  const mk = async () => {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(s);
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
    await pool.query(`INSERT INTO tenant_github_installations (tenant_id, installation_id, github_login) VALUES ($1, 4242, 'acme') ON CONFLICT (tenant_id) DO NOTHING`, [s.tenantId]);
    await pool.query(`INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url) VALUES ($1,'app','acme/app','https://github.com/acme/app','https://github.com/acme/app.git')`, [s.parentId]);
    as(s);
    fakeGithub();
    return s;
  };
  const post = async (s: Seed, url: string, payload?: Record<string, unknown>) => { as(s); return await app.inject({ method: "POST", url, ...(payload ? { payload } : {}) }); };
  const patch = async (s: Seed, id: string, payload: Record<string, unknown>) => { as(s); return await app.inject({ method: "PATCH", url: `/api/tickets/${id}`, payload }); };

  async function mkChild(s: Seed, parentId: string, version: number, status: string, extra: Record<string, unknown> = {}) {
    return (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
      [s.tenantId, s.userId, `App — Evolução v${version}`, status, s.productId, parentId, version, s.parentId,
        JSON.stringify({ evolution: true, evolution_origin: "card", evolution_parent_id: parentId, evolution_publish_state: "done", evolution_publish_mode: "pr", ...extra })],
    )).rows[0].id as string;
  }
  async function mkCard(s: Seed, childId: string | null, state: string) {
    const t = await seedTicket(pool, s, { status: "open" });
    const legacy = state === "delivered" ? "delivered" : state === "rejected" ? "rejected" : "promoted";
    await pool.query("UPDATE tickets SET card_state = $2, status = $3, child_project_id = $4, card_contract_version = 1 WHERE id = $1", [t.id, state, legacy, childId]);
    return t;
  }
  const cardOf = async (id: string) => (await pool.query("SELECT card_state, status, child_project_id, blocked_reason FROM tickets WHERE id = $1", [id])).rows[0] as
    { card_state: string; status: string; child_project_id: string | null; blocked_reason: string | null };
  const projOf = async (id: string) => (await pool.query("SELECT status, extra FROM projects WHERE id = $1", [id])).rows[0] as { status: string; extra: Record<string, unknown> };
  const events = async (id: string, to = "rejected") =>
    (await pool.query("SELECT from_state, actor_kind, reason, child_project_id FROM ticket_card_events WHERE ticket_id = $1 AND to_state = $2 ORDER BY id", [id, to])).rows;
  /** Card `in_factory` cujo filho foi ACEITO e cujo PR (nº `pr`) está no estado simulado. */
  async function hung(s: Seed, pr: number, prState: PrState, version = 2) {
    prs[pr] = prState;
    const child = await mkChild(s, s.parentId, version, "accepted", { evolution_pr_number: pr, evolution_pr_url: `https://github.com/acme/app/pull/${pr}` });
    const card = await mkCard(s, child, "in_factory");
    return { child, card };
  }

  // ── 1 ────────────────────────────────────────────────────────────────────────────────────
  describe("recusa humana de promoted|in_factory", () => {
    it("PATCH {status:'rejected'} em in_factory com filho aceito e PR FECHADO sem merge ⇒ 200; filho arquivado com card_rejected; evento auditado; repetir é idempotente", async () => {
      const s = await mk();
      const { child, card } = await hung(s, 7, "closed");
      const r = await patch(s, card.id, { status: "rejected" });
      expect(r.statusCode, r.body).toBe(200);
      expect(await cardOf(card.id)).toMatchObject({ card_state: "rejected", status: "rejected", child_project_id: child });
      const p = await projOf(child);
      expect(p.status).toBe("archived");
      expect(p.extra.card_rejected).toMatchObject({ ticket_id: card.id, previous_status: "accepted" });
      expect(await events(card.id)).toEqual([{ from_state: "in_factory", actor_kind: "user", reason: "manual_reject_in_factory", child_project_id: child }]);
      // idempotente: mesma chamada de novo e a rota do card ⇒ 200 e SEM evento novo
      expect((await patch(s, card.id, { status: "rejected" })).statusCode).toBe(200);
      const again = await post(s, `/api/cards/${card.id}/reject`);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().replayed).toBe(true);
      expect(await events(card.id)).toHaveLength(1);
    });

    it("POST /api/cards/:id/reject em promoted (filho ainda sem fábrica) arquiva o filho; filho em EXECUÇÃO ⇒ 409 CARD_CHILD_ACTIVE e nada muda", async () => {
      const s = await mk();
      const idle = await mkChild(s, s.parentId, 2, "draft");
      const c1 = await mkCard(s, idle, "promoted");
      const r1 = await post(s, `/api/cards/${c1.id}/reject`);
      expect(r1.statusCode, r1.body).toBe(200);
      expect((await projOf(idle)).status).toBe("archived");
      expect((await events(c1.id))[0]).toMatchObject({ from_state: "promoted", reason: "manual_reject_in_factory" });

      const running = await mkChild(s, s.parentId, 3, "running");
      const c2 = await mkCard(s, running, "in_factory");
      const r2 = await post(s, `/api/cards/${c2.id}/reject`);
      expect(r2.statusCode, r2.body).toBe(409);
      expect(r2.json().code).toBe("CARD_CHILD_ACTIVE");
      expect((await cardOf(c2.id)).card_state).toBe("in_factory");
      expect((await projOf(running)).status).toBe("running");
      expect(await events(c2.id)).toHaveLength(0);
    });

    it("filho aceito com PR MERGEADO ⇒ 409 CARD_ALREADY_DELIVERABLE (nunca recusa entrega real); GitHub fora do ar ⇒ 409 CARD_MERGE_UNVERIFIED (fail-closed); nada muda", async () => {
      const s = await mk();
      const merged = await hung(s, 11, "merged", 2);
      for (const call of [() => patch(s, merged.card.id, { status: "rejected" }), () => post(s, `/api/cards/${merged.card.id}/reject`)]) {
        const r = await call();
        expect(r.statusCode, r.body).toBe(409);
        expect(r.json().code).toBe("CARD_ALREADY_DELIVERABLE");
        expect(r.json().userMessage ?? r.json().message).toBeTruthy();
      }
      expect(await cardOf(merged.card.id)).toMatchObject({ card_state: "in_factory", status: "promoted" });
      expect((await projOf(merged.child)).status).toBe("accepted");
      expect(await events(merged.card.id)).toHaveLength(0);

      const down = await hung(s, 12, "error", 3);
      const r = await post(s, `/api/cards/${down.card.id}/reject`);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().code).toBe("CARD_MERGE_UNVERIFIED");
      expect((await cardOf(down.card.id)).card_state).toBe("in_factory");
      expect((await projOf(down.child)).status).toBe("accepted");
    });

    it("card já ENTREGUE não recusa (409, sem alterar nada); rejeitado repete como noop", async () => {
      const s = await mk();
      const child = await mkChild(s, s.parentId, 2, "accepted", { evolution_pr_number: 21 });
      const card = await mkCard(s, child, "delivered");
      const a = await patch(s, card.id, { status: "rejected" });
      expect(a.statusCode, a.body).toBe(409);
      expect(a.json().code).toBe("TICKET_INVALID_TRANSITION");
      const b = await post(s, `/api/cards/${card.id}/reject`);
      expect(b.statusCode).toBe(409);
      expect(b.json().code).toBe("CARD_INVALID_TRANSITION");
      expect((await cardOf(card.id)).card_state).toBe("delivered");
      expect((await projOf(child)).status).toBe("accepted");
    });

    it("papel: usuário comum que NÃO é o autor ⇒ 403 (PATCH e POST); o autor comum e o tenant_admin conseguem", async () => {
      const s = await mk();
      const { card } = await hung(s, 31, "closed", 2);
      const other = (await pool.query(`INSERT INTO users (email, name, role, tenant_id) VALUES ($1,'o','user',$2) RETURNING id`, [`o-${Date.now()}@x.test`, s.tenantId])).rows[0].id as string;
      as(s, "user", other);
      expect((await app.inject({ method: "PATCH", url: `/api/tickets/${card.id}`, payload: { status: "rejected" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/cards/${card.id}/reject` })).statusCode).toBe(403);
      expect((await cardOf(card.id)).card_state).toBe("in_factory");
      // detalhe do card: a ação `reject` só aparece para quem pode
      expect((await app.inject({ method: "GET", url: `/api/cards/${card.id}` })).json().actions.reject).toBe(false);
      as(s, "user", s.userId);   // autor
      expect((await app.inject({ method: "GET", url: `/api/cards/${card.id}` })).json().actions.reject).toBe(true);
      expect((await app.inject({ method: "PATCH", url: `/api/tickets/${card.id}`, payload: { status: "rejected" } })).statusCode).toBe(200);
    });

    it("CAS: o filho muda de status ENTRE a leitura e o arquivamento ⇒ child_changed e TUDO é desfeito (ticket continua in_factory, sem evento)", async () => {
      const s = await mk();
      const { child, card } = await hung(s, 41, "closed", 2);
      const wrapped = {
        query: pool.query.bind(pool),
        connect: async () => {
          const c = await pool.connect();
          const orig = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
          (c as unknown as { query: unknown }).query = async (sql: unknown, ...a: unknown[]) => {
            if (typeof sql === "string" && /UPDATE projects SET status = 'archived'/.test(sql)) await pool.query("UPDATE projects SET status = 'stopped' WHERE id = $1", [child]);
            return orig(sql, ...a);
          };
          return c;
        },
      };
      const r = await transitionCard(wrapped as never, {
        ticketId: card.id, to: "rejected", actorKind: "user", actorId: s.userId, reason: "x",
        rejectProof: { childProjectId: child, verified: true, merged: false },
      });
      expect(r).toEqual({ kind: "precondition_failed", code: "child_changed" });
      expect(await cardOf(card.id)).toMatchObject({ card_state: "in_factory", status: "promoted" });
      expect((await projOf(child)).status).toBe("stopped");
      expect(await events(card.id)).toHaveLength(0);
    });

    it("sem prova de merge (chamada direta sem rejectProof) com filho aceito ⇒ merge_unverified (a máquina nunca arquiva entrega possível sem prova)", async () => {
      const s = await mk();
      const { child, card } = await hung(s, 51, "closed", 2);
      const r = await transitionCard(pool, { ticketId: card.id, to: "rejected", actorKind: "user", actorId: s.userId });
      expect(r).toEqual({ kind: "precondition_failed", code: "merge_unverified" });
      expect((await projOf(child)).status).toBe("accepted");
    });

    it("corridas: duas recusas ⇒ 1 evento e 1 arquivamento; recusa × entrega do sistema ⇒ exatamente uma vence e o resultado é coerente", async () => {
      const s = await mk();
      const a = await hung(s, 61, "closed", 2);
      const rs = await raceN(2, () => post(s, `/api/cards/${a.card.id}/reject`));
      expect(rs.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(await events(a.card.id)).toHaveLength(1);
      expect((await projOf(a.child)).status).toBe("archived");

      const b = await hung(s, 62, "open", 3);   // PR aberto: a recusa pode vencer; a "entrega" (mergeCheck) também
      const res = await raceN(2, (i) => i === 0
        ? rejectCardByUser(pool, b.card.id, { id: s.userId })
        : transitionCard(pool, { ticketId: b.card.id, to: "delivered", actorKind: "system", mergeCheck: async () => true }));
      const applied = res.filter((r) => r.kind === "applied");
      expect(applied).toHaveLength(1);
      const final = await cardOf(b.card.id);
      if (res[0].kind === "applied") {
        expect(final.card_state).toBe("rejected");
        expect((await projOf(b.child)).status).toBe("archived");
        expect(res[1].kind).toBe("invalid");
      } else {
        expect(final.card_state).toBe("delivered");
        expect((await projOf(b.child)).status).toBe("accepted");   // entrega vencedora: o filho NÃO foi arquivado
      }
    });
  });

  // ── 3 ────────────────────────────────────────────────────────────────────────────────────
  describe("linhagem após a recusa", () => {
    /** v6 entregue (TK-0005, = raiz) ← v7 aceito/NÃO mergeado (card A, superado por v8) ← v8 aceito/NÃO mergeado (card B). */
    async function scenario(s: Seed) {
      const v6 = s.parentId;
      await pool.query("UPDATE projects SET version_number = 6 WHERE id = $1", [v6]);
      await mkCard(s, v6, "delivered");   // TK-0005
      const v7 = await mkChild(s, v6, 7, "archived", { evolution_pr_number: 7 });
      const v8 = await mkChild(s, v7, 8, "accepted", { evolution_pr_number: 8, supersedes: v7 });
      await pool.query("UPDATE projects SET extra = extra || $2::jsonb WHERE id = $1", [v7, JSON.stringify({ superseded_by: v8, superseded_at: "2026-11-04T00:00:00Z", superseded_version: "8" })]);
      await pool.query("UPDATE projects SET status = 'archived', extra = extra || $2::jsonb WHERE id = $1", [v6, JSON.stringify({ superseded_by: v7, superseded_at: "2026-11-03T00:00:00Z", superseded_version: "7" })]);
      const A = await mkCard(s, v7, "in_factory");
      const B = await mkCard(s, v8, "in_factory");
      // v6 está `archived`+superseded no cenário do bug (o supersedeParent do aceite de v7); o HEAD real era v8.
      return { v6, v7, v8, A, B };
    }
    const readyCard = async (s: Seed, n: number, title: string) => {
      as(s);
      const c = (await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: "feature", title, body: `Quero: ${title}.` } })).json() as { id: string; code: string; draftProjectId: string };
      const dir = join(s.uploadDir, c.draftProjectId, "docs/rfc");
      mkdirSync(dir, { recursive: true });
      const content = rfc(n, title);
      const fn = `RFC-${String(n).padStart(4, "0")}-x.md`;
      writeFileSync(join(dir, fn), content, "utf-8");
      await pool.query(
        `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256) VALUES ($1,$2,$3,'text/markdown','docs/rfc',false,$4)`,
        [c.draftProjectId, fn, join(dir, fn), sha256(content)],
      );
      const r = await post(s, `/api/cards/${c.id}/ready`);
      expect(r.statusCode, r.body).toBe(200);
      return c;
    };
    const rootOf = async (id: string) => (await resolveLineageHead(pool, id).catch(() => null));

    it("sem recusar: promover um card novo ⇒ 409 CARD_PREVIOUS_UNMERGED (bloqueado por B, a base é v8); nenhum filho é criado", async () => {
      const s = await mk();
      const { v6, B } = await scenario(s);
      const C = await readyCard(s, 3, "Ordenar entregas por prazo");
      const r = await post(s, `/api/cards/${C.id}/promote`);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ code: "CARD_PREVIOUS_UNMERGED", blockingCardId: B.id, blockingCardState: "in_factory", blockingPrNumber: 8 });
      expect((await childrenOf(pool, v6)).filter((c) => c.status === "materializing")).toHaveLength(0);
    });

    it("recusar B e depois A: o HEAD volta a v6 (dev) e a promoção do card C passa a ser permitida usando v6 como base; v7/v8 ficam arquivados com card_rejected", async () => {
      const s = await mk();
      const { v6, v7, v8, A, B } = await scenario(s);
      expect(await rootOf(v6)).toMatchObject({ id: v8 });
      const C = await readyCard(s, 3, "Ordenar entregas por prazo");   // validado com base v8

      // 1) recusar B: v8 arquivado/recusado; v7 (de A) volta a ser a base, ainda NÃO mergeada ⇒ continua bloqueando — agora por A
      expect((await post(s, `/api/cards/${B.id}/reject`)).statusCode).toBe(200);
      expect(await projOf(v8)).toMatchObject({ status: "archived" });
      expect((await projOf(v8)).extra.card_rejected).toMatchObject({ ticket_id: B.id });
      expect(await projOf(v7)).toMatchObject({ status: "accepted" });
      expect((await projOf(v7)).extra.superseded_by).toBeUndefined();
      expect((await projOf(v7)).extra.superseded_reverted).toMatchObject({ ticket_id: B.id, rejected_child: v8 });
      expect(await rootOf(v6)).toMatchObject({ id: v7 });
      let r = await post(s, `/api/cards/${C.id}/promote`);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().code).toBe("CARD_BASE_STALE");                     // C foi validado sobre v8: precisa revalidar
      expect((await post(s, `/api/cards/${C.id}/revalidate`)).statusCode).toBe(200);
      expect((await post(s, `/api/cards/${C.id}/ready`)).statusCode).toBe(200);
      r = await post(s, `/api/cards/${C.id}/promote`);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ code: "CARD_PREVIOUS_UNMERGED", blockingCardId: A.id, blockingProjectId: v7 });

      // 2) recusar A: v7 recusado; v6 volta a ser a base (accepted, sem superseded_by) ⇒ promoção liberada sobre v6/dev
      expect((await post(s, `/api/cards/${A.id}/reject`)).statusCode).toBe(200);
      expect((await projOf(v7)).status).toBe("archived");
      expect((await projOf(v7)).extra.card_rejected).toMatchObject({ ticket_id: A.id });
      expect(await projOf(v6)).toMatchObject({ status: "accepted" });
      expect((await projOf(v6)).extra.superseded_by).toBeUndefined();
      expect(await rootOf(v6)).toMatchObject({ id: v6 });
      expect((await post(s, `/api/cards/${C.id}/revalidate`)).statusCode).toBe(200);
      expect((await post(s, `/api/cards/${C.id}/ready`)).statusCode).toBe(200);
      r = await post(s, `/api/cards/${C.id}/promote`);
      expect(r.statusCode, r.body).toBe(201);
      const kid = (await childrenOf(pool, v6)).find((k) => k.id === r.json().childProjectId)!;
      expect(kid.version_number).toBe(7);
      expect(kid.extra.evolution_parent_id).toBe(v6);
    });

    it("ordem inversa (recusar A e depois B): A só marca v7 (v8 ainda o supersede); ao recusar B, v7 está recusado e a base cai direto em v6", async () => {
      const s = await mk();
      const { v6, v7, v8, A, B } = await scenario(s);
      expect((await post(s, `/api/cards/${A.id}/reject`)).statusCode).toBe(200);
      expect(await projOf(v7)).toMatchObject({ status: "archived" });
      expect((await projOf(v7)).extra.card_rejected).toMatchObject({ ticket_id: A.id });
      expect((await projOf(v7)).extra.superseded_by).toBe(v8);            // supersessão preservada: B ainda vale
      expect((await projOf(v6)).status).toBe("archived");                  // v6 NÃO foi reavivado (B, que contém A, segue válido)
      expect(await rootOf(v6)).toMatchObject({ id: v8 });
      // o card A recusado não pode ser tratado como "aceito-superado" na entrega
      expect(await cardOf(A.id)).toMatchObject({ card_state: "rejected" });

      expect((await post(s, `/api/cards/${B.id}/reject`)).statusCode).toBe(200);
      expect(await projOf(v6)).toMatchObject({ status: "accepted" });
      expect(await rootOf(v6)).toMatchObject({ id: v6 });
      const C = await readyCard(s, 3, "Ordenar entregas por prazo");
      const r = await post(s, `/api/cards/${C.id}/promote`);
      expect(r.statusCode, r.body).toBe(201);
    });

    it("corrida de duas promoções depois das recusas: exatamente 1 filho é criado sobre v6 (a outra responde em voo); antes das recusas, as duas são 409 CARD_PREVIOUS_UNMERGED", async () => {
      const s = await mk();
      const { v6, A, B } = await scenario(s);
      const C = await readyCard(s, 3, "Ordenar entregas por prazo");
      const D = await readyCard(s, 4, "Filtrar entregas por data");
      const before = await raceN(2, (i) => post(s, `/api/cards/${i === 0 ? C.id : D.id}/promote`));
      for (const r of before) { expect(r.statusCode, r.body).toBe(409); expect(r.json().code).toBe("CARD_PREVIOUS_UNMERGED"); }

      expect((await post(s, `/api/cards/${B.id}/reject`)).statusCode).toBe(200);
      expect((await post(s, `/api/cards/${A.id}/reject`)).statusCode).toBe(200);
      for (const c of [C, D]) {
        expect((await post(s, `/api/cards/${c.id}/revalidate`)).statusCode).toBe(200);
        expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
      }
      const after = await raceN(2, (i) => post(s, `/api/cards/${i === 0 ? C.id : D.id}/promote`));
      expect(after.filter((r) => r.statusCode === 201), after.map((r) => r.body).join("|")).toHaveLength(1);
      for (const r of after) expect(r.json().code).not.toBe("CARD_PREVIOUS_UNMERGED");
      expect((await childrenOf(pool, v6)).filter((k) => k.status === "materializing" || k.status === "draft" || k.status === "running" || k.status === "spec_submitted").length).toBe(1);
    });
  });
});
