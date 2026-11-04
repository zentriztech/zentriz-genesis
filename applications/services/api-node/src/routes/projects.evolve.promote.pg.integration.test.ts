/**
 * Tarefa 1.7 (Fase 1', EVOLUIR-PROJETO-BANCADA v2) — filho de EVOLUÇÃO promovível na Bancada, em Postgres REAL (efêmero).
 * Flag EVOLUTION_PROMOTE_BANCADA: `off` (padrão) = comportamento histórico (409 NOT_ON_WORKBENCH); `on` = o `/promote` (projeto e produto)
 * e o veredito da tela aceitam o filho de evolução em `spec_submitted`, SEM enfraquecer gate (RFC + connect.yaml + validação + orçamento),
 * e o produto reflete o filho (`partially_accepted`) logo após o `/evolve`.
 * Só roda com PG_TEST_URL (ver src/testing/evolvePg.ts). Sem ele: skip.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, buildApp, raceN, sha256, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";
import { pipelineRoutes } from "./pipeline.js";
import { productRoutes } from "./products.js";
import { specRoutes } from "./specs.js";

const CONNECT = "schemaVersion: '1.3.0'\nsystemId: sys\nserviceName: svc\nresponsibility: x\ninterfaces: []\n";
const RFC_GOOD = `# RFC-0001 — Exportar extrato em PDF

## Sumário
Permitir exportar o extrato mensal em PDF a partir da tela de relatórios.

## Escopo
**Não-objetivos:** não muda o cálculo do saldo.

## Requisitos
- REQ-01 — O sistema DEVE gerar PDF do extrato do mês selecionado.

## Critérios de aceite
### Cenário: exportar mês corrente
- **Dado** um usuário autenticado com lançamentos no mês
- **Quando** clica em "Exportar PDF"
- **Então** recebe um arquivo PDF com todos os lançamentos do mês

## Compatibilidade
- Tipo (SemVer): MINOR
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
  - "apps/api/src/reports/**"
  - "tests/**"
\`\`\`
`;
const RFC_BAD = "# RFC-0002 — Algo vago\n\n## Sumário\nFazer melhor.\n\n## Critérios de aceite\nDeve funcionar bem.\n";

describePg("Fase 1' / 1.7 — promoção do filho de evolução na Bancada (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  beforeAll(async () => {
    pool = await openPg();
    app = await buildApp([projectRoutes, ticketRoutes, pipelineRoutes, productRoutes, specRoutes]);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    for (const s of seeds) s.cleanup();
    await pool?.end();
  });

  /** Produto aceito + evolução criada pelo /evolve real. `rfc`: texto do RFC do delta (null = sem RFC). */
  const scenario = async (o: { rfc?: string | null; connect?: boolean; budget?: number | null } = {}) => {
    const s = await seedAcceptedProduct(pool, {
      budgetUsd: o.budget === undefined ? 50 : o.budget,
      extraFiles: o.connect === false ? [] : [{ relDir: "", filename: "connect.yaml", content: CONNECT, mime: "text/yaml" }],
    });
    seeds.push(s);
    const r = await app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "Exportar extrato em PDF" } });
    expect(r.statusCode).toBe(201);
    const childId = r.json().childProjectId as string;
    if (o.rfc) {
      const dir = join(s.uploadDir, childId, "docs", "rfc");
      mkdirSync(dir, { recursive: true });
      const fp = join(dir, "RFC-0001-exportar-pdf.md");
      writeFileSync(fp, o.rfc, "utf-8");
      await pool.query(
        `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
         VALUES ($1,'RFC-0001-exportar-pdf.md',$2,'text/markdown','docs/rfc',false,$3)`, [childId, fp, sha256(o.rfc)]);
    }
    return { s, childId };
  };
  const status = async (id: string) => (await pool.query("SELECT status FROM projects WHERE id=$1", [id])).rows[0].status as string;
  const lifecycle = async (productId: string) => (await pool.query("SELECT lifecycle_status FROM products WHERE id=$1", [productId])).rows[0].lifecycle_status as string;
  const promoteProject = (id: string) => app.inject({ method: "POST", url: `/api/projects/${id}/promote` });
  const verdictOf = async (id: string) => (await app.inject({ method: "GET", url: `/api/projects/${id}/normalized` })).json().promotion;

  describe("flag OFF (padrão, legado EVOLVE_CLAIM off) — histórico preservado", () => {
    beforeAll(() => { vi.stubEnv("EVOLUTION_PROMOTE_BANCADA", "off"); vi.stubEnv("EVOLVE_CLAIM", "off"); });
    afterAll(() => { vi.unstubAllEnvs(); });
    it("filho nasce spec_submitted, produto fica 'accepted', /promote e /products/:id/promote seguem 409 NOT_ON_WORKBENCH, veredito sem campo 'evolution'", async () => {
      const { s, childId } = await scenario({ rfc: RFC_GOOD });
      expect(await status(childId)).toBe("spec_submitted");
      expect(await lifecycle(s.productId)).toBe("accepted"); // defeito extra preservado com a flag off
      const p = await promoteProject(childId);
      expect(p.statusCode).toBe(409);
      expect(p.json().code).toBe("NOT_ON_WORKBENCH");
      const pp = await app.inject({ method: "POST", url: `/api/products/${s.productId}/promote`, payload: {} });
      expect(pp.statusCode).toBe(409);
      expect(pp.json().code).toBe("NOT_ON_WORKBENCH");
      const v = await verdictOf(childId);
      expect(v.reason).toBe("NOT_ON_WORKBENCH");
      expect("evolution" in v).toBe(false);
      expect(await status(childId)).toBe("spec_submitted");
    });
  });

  describe("flag ON (+ EVOLVE_CLAIM=on)", () => {
    beforeAll(() => { vi.stubEnv("EVOLUTION_PROMOTE_BANCADA", "on"); vi.stubEnv("EVOLVE_CLAIM", "on"); });
    afterAll(() => { vi.unstubAllEnvs(); });

    it("estado agregado do produto após /evolve = partially_accepted (accepted + spec_submitted); após promover continua partially_accepted", async () => {
      const { s, childId } = await scenario({ rfc: RFC_GOOD });
      expect(await status(childId)).toBe("spec_submitted");
      expect(await lifecycle(s.productId)).toBe("partially_accepted");
      expect((await promoteProject(childId)).statusCode).toBe(200);
      expect(await status(childId)).toBe("promoted");
      expect(await lifecycle(s.productId)).toBe("partially_accepted");
    });

    it("sem RFC: veredito EVOLUTION_RFC (canPromote=false, evolution=true) e /promote 409; GET não grava nada; status intacto", async () => {
      const { childId } = await scenario({ rfc: null });
      const before = (await pool.query("SELECT extra, updated_at FROM projects WHERE id=$1", [childId])).rows[0];
      const v = await verdictOf(childId);
      expect(v).toMatchObject({ canPromote: false, reason: "EVOLUTION_RFC", evolution: true, code: "EVOLUTION_RFC_REQUIRED" });
      const after = (await pool.query("SELECT extra, updated_at FROM projects WHERE id=$1", [childId])).rows[0];
      expect(after.extra).toEqual(before.extra);
      expect(+after.updated_at).toBe(+before.updated_at);
      const p = await promoteProject(childId);
      expect(p.statusCode).toBe(409);
      expect(p.json()).toMatchObject({ code: "EVOLUTION_RFC", gate: "EVOLUTION_RFC_REQUIRED" });
      expect(await status(childId)).toBe("spec_submitted");
    });

    it("gate de RFC invariante: RFC inválido continua barrando (EVOLUTION_RFC_INVALID)", async () => {
      const { childId } = await scenario({ rfc: RFC_BAD });
      const p = await promoteProject(childId);
      expect(p.statusCode).toBe(409);
      expect(p.json().gate).toBe("EVOLUTION_RFC_INVALID");
      expect(await status(childId)).toBe("spec_submitted");
    });

    it("sem connect.yaml: CONNECT_MISSING (gate de prontidão preservado)", async () => {
      const { childId } = await scenario({ rfc: RFC_GOOD, connect: false });
      const p = await promoteProject(childId);
      expect(p.statusCode).toBe(409);
      expect(p.json().code).toBe("CONNECT_MISSING");
      expect((await verdictOf(childId)).reason).toBe("CONNECT_MISSING");
    });

    it("RFC válido + connect.yaml + orçamento herdado: veredito canPromote=true e /promote 200; repetição idempotente (alreadyPromoted)", async () => {
      const { childId } = await scenario({ rfc: RFC_GOOD });
      expect(await verdictOf(childId)).toMatchObject({ canPromote: true, evolution: true, reason: null });
      const p = await promoteProject(childId);
      expect(p.statusCode).toBe(200);
      expect(p.json()).toMatchObject({ ok: true, status: "promoted" });
      expect(p.json().alreadyPromoted).toBeUndefined();
      const again = await promoteProject(childId);
      expect(again.statusCode).toBe(200);
      expect(again.json().alreadyPromoted).toBe(true);
      // depois de promovido o veredito diz 'já saiu da Bancada' (correto)
      expect((await verdictOf(childId)).reason).toBe("NOT_ON_WORKBENCH");
    });

    it("corrida: 6 /promote simultâneos ⇒ todos 200, exatamente uma transição, filho 'promoted'", async () => {
      const { childId } = await scenario({ rfc: RFC_GOOD });
      const res = await raceN(6, () => promoteProject(childId));
      expect(res.map((r) => r.statusCode).every((c) => c === 200)).toBe(true);
      expect(res.filter((r) => r.json().alreadyPromoted !== true)).toHaveLength(1);
      expect(await status(childId)).toBe("promoted");
    });

    it("filho que saiu da Bancada no meio (status 'running') ⇒ 409 NOT_ON_WORKBENCH, sem rebaixar o status", async () => {
      const { childId } = await scenario({ rfc: RFC_GOOD });
      await pool.query("UPDATE projects SET status='running' WHERE id=$1", [childId]);
      const p = await promoteProject(childId);
      expect(p.statusCode).toBe(409);
      expect(p.json().code).toBe("NOT_ON_WORKBENCH");
      expect(await status(childId)).toBe("running");
    });

    it("projeto que NÃO é evolução continua sob a regra histórica (rascunho sem normalizar ⇒ NOT_NORMALIZED; spec_submitted ⇒ NOT_ON_WORKBENCH)", async () => {
      const { s } = await scenario({ rfc: RFC_GOOD });
      const mk = async (st: string) => (await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number) VALUES ($1,$2,'x',$3,$4,1) RETURNING id`,
        [s.tenantId, s.userId, st, s.productId])).rows[0].id as string;
      const d = await mk("draft");
      const sub = await mk("spec_submitted");
      const dFile = join(s.uploadDir, d); mkdirSync(dFile, { recursive: true });
      writeFileSync(join(dFile, "spec.md"), "# Spec\n\nCorpo real da spec do rascunho com conteúdo suficiente para o gate.\n");
      await pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary) VALUES ($1,'spec.md',$2,'text/markdown','',true)`, [d, join(dFile, "spec.md")]);
      const pd = await promoteProject(d);
      expect(pd.statusCode).toBe(409);
      expect(pd.json().code).toBe("NOT_NORMALIZED");
      const ps = await promoteProject(sub);
      expect(ps.statusCode).toBe(409);
      expect(ps.json().code).toBe("NOT_ON_WORKBENCH");
    });

    it("Bancada (produto): veredito canPromote=true e POST /api/products/:id/promote promove o filho de evolução; sem RFC ⇒ 409 EVOLUTION_RFC", async () => {
      const noRfc = await scenario({ rfc: null });
      const g0 = (await app.inject({ method: "GET", url: `/api/products/${noRfc.s.productId}` })).json();
      expect(g0.promotion).toMatchObject({ canPromote: false, reason: "EVOLUTION_RFC", evolution: true });
      const p0 = await app.inject({ method: "POST", url: `/api/products/${noRfc.s.productId}/promote`, payload: {} });
      expect(p0.statusCode).toBe(409);
      expect(p0.json()).toMatchObject({ code: "EVOLUTION_RFC", evolution: true });
      expect(await status(noRfc.childId)).toBe("spec_submitted");

      const ok = await scenario({ rfc: RFC_GOOD });
      const g = (await app.inject({ method: "GET", url: `/api/products/${ok.s.productId}` })).json();
      expect(g.promotion).toMatchObject({ canPromote: true, evolution: true });
      const p = await app.inject({ method: "POST", url: `/api/products/${ok.s.productId}/promote`, payload: {} });
      expect(p.statusCode).toBe(200);
      expect(p.json()).toMatchObject({ ok: true, evolution: true, promotedProjects: [ok.childId], lifecycleStatus: "partially_accepted" });
      expect(await status(ok.childId)).toBe("promoted");
      // repetição: não há mais filho promovível ⇒ 409 histórico
      const again = await app.inject({ method: "POST", url: `/api/products/${ok.s.productId}/promote`, payload: {} });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("NOT_ON_WORKBENCH");
    });

    it("listagem 'Minhas SPECs' (GET /api/specs): o filho de evolução traz o veredito de evolução", async () => {
      const { childId } = await scenario({ rfc: RFC_GOOD });
      const r = await app.inject({ method: "GET", url: "/api/specs" });
      expect(r.statusCode).toBe(200);
      const row = (r.json() as Array<{ id: string; promotion: Record<string, unknown> }>).find((x) => x.id === childId);
      expect(row?.promotion).toMatchObject({ canPromote: true, evolution: true });
    });
  });

  describe("flag ON com EVOLVE_CLAIM=off (caminho legado do /evolve)", () => {
    beforeAll(() => { vi.stubEnv("EVOLUTION_PROMOTE_BANCADA", "on"); vi.stubEnv("EVOLVE_CLAIM", "off"); });
    afterAll(() => { vi.unstubAllEnvs(); });
    it("o /evolve legado também recomputa o produto (partially_accepted); sem orçamento herdado o gate de orçamento barra com BUDGET_BLOCKED", async () => {
      const { s, childId } = await scenario({ rfc: RFC_GOOD });
      expect(await lifecycle(s.productId)).toBe("partially_accepted");
      const p = await promoteProject(childId);
      expect(p.statusCode).toBe(409);
      expect(p.json()).toMatchObject({ code: "BUDGET_BLOCKED", gate: "BUDGET_MISSING" });
    });
  });
});
