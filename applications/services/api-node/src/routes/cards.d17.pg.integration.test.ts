/**
 * Rodada 4.5d (BF) — correções D-17 e CARD_PREVIOUS_IN_PROGRESS — Postgres REAL efêmero, rotas reais, sem rede.
 *  1. D-17: card escrito sobre v7 (HEAD), v7 recusado (HEAD volta a v6) ⇒ "Validar" e "Promover" respondem 409 CARD_BASE_STALE exigindo
 *     `revalidate`; `revalidate` rebaseia (card_base, evolution_parent_id, ticket.project_id) e a promoção nasce de v6.
 *  2. Promover com outro card da linhagem em andamento (filho `blocked_cyborg`) ⇒ 409 CARD_PREVIOUS_IN_PROGRESS (card bloqueante, estado do
 *     filho, ação), não o EVOLUTION_IN_FLIGHT genérico do /evolve; filho vivo SEM card mantém EVOLUTION_IN_FLIGHT; recusar o card bloqueante libera.
 * Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, childrenOf, sha256, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { cardRoutes } from "./cards.js";
import { __setOctokitFactoryForTests } from "../services/github.js";

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

describePg("D-17 e CARD_PREVIOUS_IN_PROGRESS (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];

  beforeAll(async () => { pool = await openPg(); app = await buildApp([cardRoutes]); }, 60_000);
  afterAll(async () => { __setOctokitFactoryForTests(null); await app?.close(); for (const s of seeds) s.cleanup(); await pool?.end(); });

  const as = (s: Seed) => Object.assign(testUser, { id: s.userId, email: `u@${s.tenantId}.test`, role: "tenant_admin", tenantId: s.tenantId });
  const post = async (s: Seed, url: string, payload?: Record<string, unknown>) => { as(s); return await app.inject({ method: "POST", url, ...(payload ? { payload } : {}) }); };

  /** GitHub simulado (sem rede): todo PR consultado está ABERTO e não mergeado (prova de "não entregue" para a recusa). */
  const fakeGithub = () => __setOctokitFactoryForTests(async () => ({
    pulls: { get: async () => ({ data: { state: "open", merged: false, mergeable: true, mergeable_state: "clean", head: { sha: "H" }, base: { ref: "dev" }, merge_commit_sha: null } }) },
  }) as never);
  const mk = async () => {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(s);
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
    await pool.query(`INSERT INTO tenant_github_installations (tenant_id, installation_id, github_login) VALUES ($1, 4242, 'acme') ON CONFLICT (tenant_id) DO NOTHING`, [s.tenantId]);
    await pool.query(`INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url) VALUES ($1,'app','acme/app','https://github.com/acme/app','https://github.com/acme/app.git')`, [s.parentId]);
    fakeGithub();
    await pool.query("UPDATE projects SET version_number = 6 WHERE id = $1", [s.parentId]);
    as(s);
    return s;
  };
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
    const legacy = state === "delivered" ? "delivered" : "promoted";
    await pool.query("UPDATE tickets SET card_state = $2, status = $3, child_project_id = $4, card_contract_version = 1 WHERE id = $1", [t.id, state, legacy, childId]);
    return t;
  }
  const projOf = async (id: string) => (await pool.query("SELECT status, extra FROM projects WHERE id = $1", [id])).rows[0] as { status: string; extra: Record<string, unknown> };

  /** Cria o card pela API sobre `projectId`, escreve o RFC no rascunho; NÃO valida. */
  async function newCard(s: Seed, projectId: string | null, n: number, title: string) {
    as(s);
    const c = (await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: "feature", title, body: `Quero: ${title}.`, ...(projectId ? { projectId } : {}) } })).json() as { id: string; draftProjectId: string };
    const dir = join(s.uploadDir, c.draftProjectId, "docs/rfc");
    mkdirSync(dir, { recursive: true });
    const content = rfc(n, title);
    const fn = `RFC-${String(n).padStart(4, "0")}-x.md`;
    writeFileSync(join(dir, fn), content, "utf-8");
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256) VALUES ($1,$2,$3,'text/markdown','docs/rfc',false,$4)`,
      [c.draftProjectId, fn, join(dir, fn), sha256(content)],
    );
    return c;
  }
  const draftExtra = async (draftId: string) => (await pool.query("SELECT extra FROM projects WHERE id = $1", [draftId])).rows[0].extra as Record<string, any>;

  describe("D-17: base registrada do card × recusa do v7", () => {
    /** v6 entregue; v7 (card B) aceito e superando v6. */
    async function scenario(s: Seed) {
      const v6 = s.parentId;
      await mkCard(s, v6, "delivered");
      const v7 = await mkChild(s, v6, 7, "accepted", { evolution_pr_number: 7 });
      await pool.query("UPDATE projects SET status = 'archived', extra = extra || $2::jsonb WHERE id = $1", [v6, JSON.stringify({ superseded_by: v7, superseded_at: "2026-11-03T00:00:00Z", superseded_version: "7" })]);
      const B = await mkCard(s, v7, "in_factory");
      return { v6, v7, B };
    }

    it("card criado sobre v7, v7 recusado ⇒ Validar 409 CARD_BASE_STALE (não carimba v6 em silêncio); revalidate rebaseia; validar e promover nascem de v6", async () => {
      const s = await mk();
      const { v6, v7, B } = await scenario(s);
      const A = await newCard(s, v7, 3, "Ordenar entregas por prazo");
      expect((await draftExtra(A.draftProjectId)).card_base.head_project_id).toBe(v7);
      expect((await pool.query("SELECT project_id FROM tickets WHERE id = $1", [A.id])).rows[0].project_id).toBe(v7);

      expect((await post(s, `/api/cards/${B.id}/reject`)).statusCode).toBe(200);   // v7 arquivado/recusado; v6 volta a ser o HEAD
      expect((await projOf(v7)).status).toBe("archived");
      expect((await projOf(v6)).status).toBe("accepted");

      const stale = await post(s, `/api/cards/${A.id}/ready`);
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toMatchObject({ code: "CARD_BASE_STALE", expectedHead: v7, currentHead: v6, revalidate: `POST /api/cards/${A.id}/revalidate` });
      expect((await pool.query("SELECT card_state FROM tickets WHERE id = $1", [A.id])).rows[0].card_state).toBe("draft");
      expect((await draftExtra(A.draftProjectId)).card_ready).toBeUndefined();

      const rv = await post(s, `/api/cards/${A.id}/revalidate`);
      expect(rv.statusCode, rv.body).toBe(200);
      expect(rv.json()).toMatchObject({ result: "stale", rebased: true });
      const ex = await draftExtra(A.draftProjectId);
      expect(ex.card_base.head_project_id).toBe(v6);
      expect(ex.evolution_parent_id).toBe(v6);
      expect((await pool.query("SELECT project_id FROM tickets WHERE id = $1", [A.id])).rows[0].project_id).toBe(v6);

      expect((await post(s, `/api/cards/${A.id}/ready`)).statusCode).toBe(200);
      const pr = await post(s, `/api/cards/${A.id}/promote`);
      expect(pr.statusCode, pr.body).toBe(201);
      const kid = (await childrenOf(pool, v6)).find((k) => k.id === pr.json().childProjectId)!;
      expect(kid.extra.evolution_parent_id).toBe(v6);
    });

    it("promoção: carimbo `card_ready` em dia mas `card_base` do rascunho preso a v7 recusado ⇒ 409 CARD_BASE_STALE (defesa em profundidade) e o card volta a refining", async () => {
      const s = await mk();
      const { v6, v7, B } = await scenario(s);
      const A = await newCard(s, v7, 3, "Ordenar entregas por prazo");
      expect((await post(s, `/api/cards/${B.id}/reject`)).statusCode).toBe(200);
      await post(s, `/api/cards/${A.id}/revalidate`);
      expect((await post(s, `/api/cards/${A.id}/ready`)).statusCode).toBe(200);
      // regressão simulada: a base registrada volta ao v7 já recusado, com o carimbo apontando para o HEAD corrente
      await pool.query(`UPDATE projects SET extra = extra || $2::jsonb WHERE id = $1`, [A.draftProjectId, JSON.stringify({ card_base: { head_project_id: v7, head_version: 7 } })]);
      const r = await post(s, `/api/cards/${A.id}/promote`);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ code: "CARD_BASE_STALE", expectedHead: v7, currentHead: v6 });
      expect((await pool.query("SELECT card_state FROM tickets WHERE id = $1", [A.id])).rows[0].card_state).toBe("refining");
      expect((await childrenOf(pool, v6)).filter((c) => c.status === "materializing")).toHaveLength(0);
    });
  });

  describe("CARD_PREVIOUS_IN_PROGRESS", () => {
    async function readyCard(s: Seed, n: number, title: string) {
      const c = await newCard(s, null, n, title);
      const r = await post(s, `/api/cards/${c.id}/ready`);
      expect(r.statusCode, r.body).toBe(200);
      return c;
    }

    it("outro card com filho blocked_cyborg ⇒ 409 CARD_PREVIOUS_IN_PROGRESS (card, estado do filho, ação); recusar o bloqueante libera a promoção", async () => {
      const s = await mk();
      const v6 = s.parentId;
      const v7 = await mkChild(s, v6, 7, "blocked_cyborg");
      const B = await mkCard(s, v7, "in_factory");
      const C = await readyCard(s, 3, "Ordenar entregas por prazo");

      const r = await post(s, `/api/cards/${C.id}/promote`);
      expect(r.statusCode, r.body).toBe(409);
      const b = r.json();
      expect(b.code).toBe("CARD_PREVIOUS_IN_PROGRESS");
      expect(b).toMatchObject({ blockingCardId: B.id, blockingCardCode: expect.stringMatching(/^TK-\d+$/), blockingCardState: "in_factory", blockingProjectId: v7, blockingChildStatus: "blocked_cyborg", rejectBlockingCard: `POST /api/cards/${B.id}/reject` });
      expect(b.action).toContain(`/api/cards/${B.id}/reject`);
      expect(b.userMessage).toBeTruthy();
      expect((await childrenOf(pool, v6)).filter((c) => c.status === "materializing")).toHaveLength(0);
      expect((await pool.query("SELECT card_state FROM tickets WHERE id = $1", [C.id])).rows[0].card_state).toBe("ready");   // nada é revertido

      expect((await post(s, `/api/cards/${B.id}/reject`)).statusCode).toBe(200);
      const ok = await post(s, `/api/cards/${C.id}/promote`);
      expect(ok.statusCode, ok.body).toBe(201);
    });

    it("filho vivo SEM card (evolução legada) continua EVOLUTION_IN_FLIGHT", async () => {
      const s = await mk();
      await mkChild(s, s.parentId, 7, "blocked_cyborg", { evolution_origin: "legacy" });
      const C = await readyCard(s, 3, "Ordenar entregas por prazo");
      const r = await post(s, `/api/cards/${C.id}/promote`);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().code).toBe("EVOLUTION_IN_FLIGHT");
    });
  });
});
