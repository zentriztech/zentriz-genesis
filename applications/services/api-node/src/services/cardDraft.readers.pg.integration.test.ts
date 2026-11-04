/**
 * Fase 2 / 2.1 — CONTRATO do status de projeto `card_draft` (H §5, F14): o rascunho de card não aparece em listagens,
 * contagens, agregados nem leituras de spec do produto onde não deve. Postgres REAL, banco descartável, rotas reais.
 *
 * Cada leitor é exercitado com um `card_draft` semeado ao lado de um projeto `accepted`; um CONTROLE prova que o rascunho
 * existe (sem ele o teste seria vacuamente verde). O teste estático no fim varre o código-fonte: todo leitor novo que
 * filtre por EXCLUSÃO de status (`<> 'archived'`) precisa usar `notHiddenProjectSql` ou constar da lista de exceções.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "../routes/projects.js";
import { productRoutes } from "../routes/products.js";
import { specRoutes } from "../routes/specs.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { pipelineRoutes } from "../routes/pipeline.js";
import { loadProductProjects } from "./productNormalizer.js";
import { buildProductMap } from "./productContext.js";
import { buildTraceabilityReport } from "./productTraceability.js";
import { deriveProductLifecycle, recomputeProductLifecycle } from "./productLifecycle.js";
import { HIDDEN_FROM_PRODUCT_STATUSES, SPEC_EDITABLE_STATUSES, PRE_FACTORY_STATUSES, FACTORY_OR_TERMINAL_STATUSES, notHiddenProjectSql } from "./projectStatus.js";

const ev = (tag: string, data: unknown) => console.log(`[F2-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);
const here = dirname(fileURLToPath(import.meta.url));

describePg("Fase 2 / 2.1 — card_draft fora dos leitores de projeto/produto (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let s: Seed;
  let draftId: string;
  const seeds: Seed[] = [];
  const asTenantAdmin = () => Object.assign(testUser, { id: s.userId, role: "tenant_admin", tenantId: s.tenantId });

  beforeAll(async () => {
    scratch = await createScratchDb("evo_draft");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(s);
    draftId = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, extra)
       VALUES ($1,$2,'Rascunho do card TK-0001','card_draft',$3,0,$4::jsonb) RETURNING id`,
      [s.tenantId, s.userId, s.productId, JSON.stringify({ card: true, ticket_number: 1 })],
    )).rows[0].id as string;
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, rel_dir, is_primary) VALUES ($1,'request.md','/tmp/x/request.md','tickets/TK-0001',false)`,
      [draftId],
    );
    app = await buildApp([projectRoutes, productRoutes, specRoutes, dashboardRoutes, pipelineRoutes]);
    asTenantAdmin();
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    for (const x of seeds) x.cleanup();
    await scratch?.drop();
  });

  it("CONTROLE: o rascunho existe no banco, no produto, sem pai e com versão 0 (consulta sem filtro o enxerga)", async () => {
    const r = (await pool.query("SELECT status, parent_project_id, version_number FROM projects WHERE id = $1", [draftId])).rows[0];
    expect(r).toEqual({ status: "card_draft", parent_project_id: null, version_number: 0 });
    expect((await pool.query("SELECT count(*)::int AS n FROM projects WHERE product_id = $1", [s.productId])).rows[0].n).toBe(2);
    expect((await pool.query(`SELECT count(*)::int AS n FROM projects WHERE product_id = $1 AND ${notHiddenProjectSql("")}`, [s.productId])).rows[0].n).toBe(1);
  });

  it("constraints do banco: card_draft exige versão 0 e nenhum pai; status fora da lista continua recusado", async () => {
    const tryInsert = async (status: string, version: number, parent: string | null) => {
      try {
        await pool.query(
          `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, parent_project_id) VALUES ($1,$2,'x',$3,$4,$5,$6)`,
          [s.tenantId, s.userId, status, s.productId, version, parent],
        );
        return null;
      } catch (e) { return (e as { constraint?: string }).constraint ?? "erro"; }
    };
    expect(await tryInsert("card_draft", 1, null)).toBe("projects_card_draft_shape_check");
    expect(await tryInsert("card_draft", 0, s.parentId)).toBe("projects_card_draft_shape_check");
    expect(await tryInsert("card_draft_x", 0, null)).toBe("projects_status_check");
    // 'materializing' (141) continua válido: a regra é superconjunto
    expect(await tryInsert("materializing", 2, s.parentId)).toBeNull();
    await pool.query("DELETE FROM projects WHERE title = 'x' AND product_id = $1", [s.productId]);
  });

  it("GET /api/projects (lista de projetos) não traz o rascunho", async () => {
    const r = await app.inject({ method: "GET", url: "/api/projects" });
    expect(r.statusCode).toBe(200);
    const ids = (r.json() as Array<{ id: string }>).map((p) => p.id);
    ev("lista-projetos", { total: ids.length, temRascunho: ids.includes(draftId), temPai: ids.includes(s.parentId) });
    expect(ids).toContain(s.parentId);
    expect(ids).not.toContain(draftId);
  });

  it("GET /api/specs (Minhas SPECs, lista de permissão) não traz o rascunho", async () => {
    const r = await app.inject({ method: "GET", url: "/api/specs" });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).not.toContain(draftId);
  });

  it("GET /api/products: project_count conta 1 (não 2) e a árvore de spec do produto não traz arquivos do rascunho", async () => {
    const list = await app.inject({ method: "GET", url: "/api/products" });
    expect(list.statusCode).toBe(200);
    const prod = (list.json() as Array<{ id: string; project_count: number }>).find((p) => p.id === s.productId)!;
    ev("produto-contagem", { project_count: prod.project_count });
    expect(prod.project_count).toBe(1);
    const tree = await app.inject({ method: "GET", url: `/api/products/${s.productId}/spec-tree` });
    expect(tree.statusCode).toBe(200);
    expect(JSON.stringify(tree.json())).not.toContain("TK-0001");
    expect(JSON.stringify(tree.json())).not.toContain(draftId);
  });

  it("GET /api/dashboard/summary não traz o rascunho", async () => {
    const r = await app.inject({ method: "GET", url: "/api/dashboard/summary" });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).not.toContain(draftId);
    expect(JSON.stringify(r.json())).toContain(s.parentId);
  });

  it("serviços de produto: normalizador (projetos e contagem de arquivos), mapa do produto e rastreabilidade ignoram o rascunho", async () => {
    const projs = await loadProductProjects(pool, s.productId);
    expect(projs.map((p) => p.projectId)).toEqual([s.parentId]);
    const map = await buildProductMap(pool, s.parentId);
    expect(JSON.stringify(map)).not.toContain(draftId);
    const rep = await buildTraceabilityReport(pool, { productId: s.productId, profile: "summary" });
    expect(JSON.stringify(rep)).not.toContain(draftId);
    expect((rep as unknown as { projectsTotal?: number }).projectsTotal ?? 1).toBe(1);
  });

  it("agregado do produto: accepted + card_draft continua `accepted` (sem o filtro cairia no fallback `running`)", async () => {
    expect(deriveProductLifecycle(["accepted", "card_draft"])).toBe("running"); // prova do risco F15 se o filtro faltasse
    expect(await recomputeProductLifecycle(pool, s.productId)).toBe("accepted");
    expect((await pool.query("SELECT lifecycle_status FROM products WHERE id = $1", [s.productId])).rows[0].lifecycle_status).toBe("accepted");
  });

  it("run / promote do projeto não adotam card_draft (listas de permissão)", async () => {
    const run = await app.inject({ method: "POST", url: `/api/projects/${draftId}/run`, payload: {} });
    expect(run.statusCode).toBeGreaterThanOrEqual(400);
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [draftId])).rows[0].status).toBe("card_draft");
    const prom = await app.inject({ method: "POST", url: `/api/projects/${draftId}/promote`, payload: {} });
    expect(prom.statusCode).toBeGreaterThanOrEqual(400);
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [draftId])).rows[0].status).toBe("card_draft");
  });

  it("/unpromote: produto só com projetos `draft` + um card_draft NÃO é tratado como fábrica iniciada", async () => {
    const t = await seedAcceptedProduct(pool, { budgetUsd: 10 });
    seeds.push(t);
    await pool.query("UPDATE projects SET status = 'draft' WHERE id = $1", [t.parentId]);
    await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number) VALUES ($1,$2,'rasc2','card_draft',$3,0)`,
      [t.tenantId, t.userId, t.productId],
    );
    Object.assign(testUser, { id: t.userId, role: "tenant_admin", tenantId: t.tenantId });
    const r = await app.inject({ method: "POST", url: `/api/products/${t.productId}/unpromote`, payload: {} });
    ev("unpromote", { status: r.statusCode, code: r.json().code });
    expect(r.json().code).not.toBe("ALREADY_STARTED");
    asTenantAdmin();
  });

  it("conjuntos de status: card_draft é editável, fora de PRE_FACTORY e de FACTORY_OR_TERMINAL; HIDDEN = [card_draft]", () => {
    expect([...HIDDEN_FROM_PRODUCT_STATUSES]).toEqual(["card_draft"]);
    expect(SPEC_EDITABLE_STATUSES.has("card_draft")).toBe(true);
    expect((PRE_FACTORY_STATUSES as readonly string[]).includes("card_draft")).toBe(false);
    expect((FACTORY_OR_TERMINAL_STATUSES as readonly string[]).includes("card_draft")).toBe(false);
    expect(notHiddenProjectSql("p")).toBe("p.status NOT IN ('card_draft')");
    expect(notHiddenProjectSql("")).toBe("status NOT IN ('card_draft')");
  });
});

describe("Fase 2 / 2.1 — guarda estática do inventário de leitores por exclusão de status", () => {
  /**
   * Cada arquivo/ocorrência de `status <> 'archived'` / `!= 'archived'` / `NOT IN (... 'archived' ...)` sobre `projects` TEM de
   * usar `notHiddenProjectSql` até 4 linhas depois, ou constar aqui com o motivo (nenhum mostra um rascunho de card).
   */
  const EXCEPTIONS: Record<string, string> = {
    "services/evolutionUniqueness.ts": "predicados de índice/guard por pai (card_draft não tem pai)",
    "services/evolveClaim.ts": "consultas por pai/ticket (card_draft não tem pai)",
    "services/evolveReconciler.ts": "consultas por pai/ticket/materializing",
    "services/lineage.ts": "versão máxima por linhagem (card_draft não tem pai nem linhagem)",
    "services/stallEscalation.ts": "só status blocked/failed/pending_cyborg (lista de permissão)",
    "services/watchdog.ts": "pipeline_runs órfãs (run só existe para projeto executável)",
    "routes/pipeline.ts": "status de tarefas (OK/QA_PASS), não de projeto",
    "services/llmGuard.ts": "status de tarefa",
    "routes/projects.ts": "status de tarefa e deploys (DONE/CANCELLED, destroyed)",
    "routes/telegram.ts": "status de tarefa (DONE/CANCELLED)",
    "services/provision/backendState.ts": "status de deploy",
  };
  function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { if (f === "migrations" || f === "node_modules") continue; walk(p, out); }
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  it("nenhum leitor novo exclui só 'archived' sem filtrar card_draft", () => {
    const root = join(here, "..");
    const re = /status\s*(<>|!=)\s*'archived'|status\s+NOT\s+IN\s*\([^)]*'archived'[^)]*\)/;
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = relative(root, file);
      if (EXCEPTIONS[rel]) continue;
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((ln, i) => {
        if (/^\s*(\*|\/\/|\/\*)/.test(ln) || !re.test(ln)) return; // comentários não são consulta
        const win = lines.slice(Math.max(0, i - 4), i + 5).join("\n");
        if (!/notHiddenProjectSql|HIDDEN_FROM_PRODUCT_STATUSES/.test(win)) offenders.push(`${rel}:${i + 1}: ${ln.trim().slice(0, 100)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
