/**
 * Tarefa 0.3 do plano EVOLUIR-PROJETO-BANCADA (v2) — REPRODUÇÃO dos defeitos do fluxo "Evoluir projeto"
 * em Postgres REAL (efêmero), com as rotas reais (/evolve, /promote, tickets, tasks) e SEM mudar
 * comportamento de produto.
 *
 * Convenção: cada cenário roda UMA vez no `beforeAll` (erro de preparação deixa a suíte VERMELHA, nunca
 * "esperado-falha"); as asserções vivem nos `it`. Cada teste afirma o comportamento CORRETO/DESEJADO:
 *   • `it.fails(...)` = o defeito está PROVADO (a asserção correta falha hoje). Quando a tarefa 1.x
 *     corrigir, o `it.fails` passa a falhar ("expected to fail") e deve ser trocado por `it`.
 *   • `it(...)` = comportamento já correto (defeito REFUTADO) ou teste de controle/caracterização.
 * As linhas `[0.3-x] EVIDÊNCIA ...` no stdout são a saída real citada no relatório
 * project/docs/analysis/EVOLUIR-PROJETO-F-fase0-reproducao.md.
 *
 * Só roda com PG_TEST_URL (Postgres EFÊMERO migrado 1→N, ver src/testing/evolvePg.ts). Sem ele: skip.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, openPg, pgHolder, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp,
  raceN, queryGate, childrenOf, ticketRow, uid, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";
import { pipelineRoutes } from "./pipeline.js";
import { productRoutes } from "./products.js";
import { preflight } from "../services/llmGuard.js";
import { reopenTicketsOfChild } from "../services/tickets.js";
import { evaluateProductPromotability } from "../services/promotability.js";
import { recomputeProductLifecycle } from "../services/productLifecycle.js";

const ev = (tag: string, data: unknown) => console.log(`[${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);

describePg("Fase 0' / 0.3 — reprodução dos defeitos do /evolve (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];

  beforeAll(async () => {
    pool = await openPg();
    app = await buildApp([projectRoutes, ticketRoutes, pipelineRoutes, productRoutes]);
  });
  afterAll(async () => {
    await app?.close();
    for (const s of seeds) s.cleanup();
    await pool?.end();
  });

  const seed = async (o: Parameters<typeof seedAcceptedProduct>[1] = {}) => {
    const s = await seedAcceptedProduct(pool, o);
    seeds.push(s);
    return s;
  };
  const evolve = (parentId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/projects/${parentId}/evolve`, payload });

  // ── Controle: o harness funciona e o caminho feliz é o que o código diz ───────────
  describe("controle (harness + caminho feliz)", () => {
    let s: Seed; let res: Awaited<ReturnType<typeof evolve>>; let kids: Awaited<ReturnType<typeof childrenOf>>;
    beforeAll(async () => {
      s = await seed();
      res = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      kids = await childrenOf(pool, s.parentId);
    });
    it("uma evolução sozinha: 201, 1 filho v2, extra.evolution=true", () => {
      ev("0.3-ctl", { status: res.statusCode, filhos: kids.map((k) => ({ v: k.version_number, status: k.status })) });
      expect(res.statusCode).toBe(201);
      expect(kids).toHaveLength(1);
      expect(kids[0].version_number).toBe(2);
      expect(kids[0].extra.evolution).toBe(true);
    });
  });

  // ── (a) /evolve duplicado em corrida ──────────────────────────────────────────────
  describe("(a) /evolve em corrida — routes/projects.ts:3446 (SELECT EVOLUTION_IN_FLIGHT) → :3485 (INSERT)", () => {
    const N = 4;
    let s: Seed; let codes: number[]; let kids: Awaited<ReturnType<typeof childrenOf>>;
    beforeAll(async () => {
      s = await seed();
      // Barreira: as N requisições executam o SELECT do guard e só prosseguem quando as N o leram
      // (todas enxergam "nada em voo") — o intercalamento mais provável sob duplo clique/duas abas, tornado determinístico.
      const gate = queryGate(pool, /parent_project_id = \$1 AND status NOT IN/, { mode: "barrier", arrivals: N });
      const rs = await raceN(N, () => evolve(s.parentId, { request: "Adicionar exportação CSV" }));
      gate.uninstall();
      codes = rs.map((r) => r.statusCode).sort();
      kids = await childrenOf(pool, s.parentId);
      ev("0.3-a", { N, respostas: codes, filhos: kids.map((k) => ({ id: k.id.slice(0, 8), v: k.version_number, status: k.status })) });
    });
    it("harness: as N requisições responderam sem 5xx", () => {
      expect(codes).toHaveLength(N);
      expect(codes.every((c) => c < 500)).toBe(true);
    });
    // DEFEITO 0.3-a: N /evolve simultâneos criam N filhos com o MESMO version_number — remover it.fails quando corrigido (tarefa 1.1)
    it.fails("N requisições simultâneas ⇒ exatamente 1 filho (as demais 409)", () => {
      expect(kids).toHaveLength(1);
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
    });
    // DEFEITO 0.3-a: idem — versões duplicadas (sem índice único parcial) — remover it.fails quando corrigido (tarefas 1.1/1.2)
    it.fails("nunca dois filhos com o mesmo (parent_project_id, version_number)", () => {
      const versions = kids.map((k) => k.version_number);
      expect(new Set(versions).size).toBe(versions.length);
    });
  });

  // ── (b) promoção do ticket em corrida (sem AND status='open') ─────────────────────
  describe("(b) promoção do ticket — routes/projects.ts:3661 (UPDATE tickets sem AND status='open')", () => {
    const N = 3;
    let s: Seed; let codes: number[]; let kids: Awaited<ReturnType<typeof childrenOf>>; let tk: Awaited<ReturnType<typeof ticketRow>>;
    beforeAll(async () => {
      s = await seed();
      const t = await seedTicket(pool, s);
      const gate = queryGate(pool, /parent_project_id = \$1 AND status NOT IN/, { mode: "barrier", arrivals: N });
      const rs = await raceN(N, () => evolve(s.parentId, { ticketId: t.id }));
      gate.uninstall();
      codes = rs.map((r) => r.statusCode).sort();
      kids = await childrenOf(pool, s.parentId);
      tk = await ticketRow(pool, t.id);
      ev("0.3-b/dupla", { N, respostas: codes, filhos: kids.length, ticket: { status: tk.status, child: tk.child_project_id?.slice(0, 8) },
        filhosOrfaos: kids.filter((k) => k.id !== tk.child_project_id).length });
    });
    // DEFEITO 0.3-b: o mesmo ticket gera N filhos; o ticket aponta para um só, os outros ficam órfãos — remover it.fails quando corrigido (tarefa 1.1)
    it.fails("mesmo ticket promovido em corrida ⇒ 1 filho, ticket 'promoted' apontando para ele, sem órfãos", () => {
      expect(kids).toHaveLength(1);
      expect(tk.status).toBe("promoted");
      expect(kids.every((k) => k.id === tk.child_project_id)).toBe(true);
    });
  });

  describe("(b') transição perdida — UPDATE tickets sem AND status='open' sobrescreve 'rejected'", () => {
    let s: Seed; let patchStatus: number; let evolveStatus: number; let tk: Awaited<ReturnType<typeof ticketRow>>; let kids: Awaited<ReturnType<typeof childrenOf>>;
    beforeAll(async () => {
      s = await seed();
      const t = await seedTicket(pool, s);
      // Segura o /evolve imediatamente ANTES do UPDATE de promoção; nesse intervalo o humano recusa o pedido.
      const gate = queryGate(pool, /UPDATE tickets SET status = 'promoted'/, { mode: "hold-before" });
      const evolving = evolve(s.parentId, { ticketId: t.id });
      await gate.reached;
      const patch = await app.inject({ method: "PATCH", url: `/api/tickets/${t.id}`, payload: { status: "rejected" } });
      patchStatus = patch.statusCode;
      gate.release();
      const er = await evolving;
      evolveStatus = er.statusCode;
      gate.uninstall();
      tk = await ticketRow(pool, t.id);
      kids = await childrenOf(pool, s.parentId);
      ev("0.3-b/perdida", { patchRejeitar: patchStatus, evolve: evolveStatus, ticketFinal: tk.status, filhos: kids.length });
    });
    it("harness: a recusa foi aceita (200) enquanto o ticket ainda estava 'open'", () => {
      expect(patchStatus).toBe(200);
    });
    // DEFEITO 0.3-b: a promoção atropela a recusa ('rejected' → 'promoted') e cria filho de pedido recusado — remover it.fails quando corrigido (tarefa 1.1)
    it.fails("recusa concorrente vence: ticket permanece 'rejected' e o /evolve responde 409 (rowCount 0)", () => {
      expect(tk.status).toBe("rejected");
      expect(evolveStatus).toBe(409);
    });
  });

  // ── (c) cadeia do anexo binário até a lista de spec-files do runner ───────────────
  describe("(c) anexo binário chega à lista de spec-files que o runner lê (GET /spec-files)", () => {
    let s: Seed; let files: Array<{ filename: string; relDir: string; mimeType: string }>;
    beforeAll(async () => {
      s = await seed();
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28])]);
      const t = await seedTicket(pool, s, { attachments: [{ filename: "print.png", content: png, mime: "image/png" }] });
      const r = await evolve(s.parentId, { ticketId: t.id });
      const child = r.json().childProjectId as string;
      files = (await app.inject({ method: "GET", url: `/api/projects/${child}/spec-files` })).json();
      ev("0.3-c/api", { evolve: r.statusCode, arquivos: files.map((f) => `${f.relDir}/${f.filename} [${f.mimeType}]`) });
    });
    it("o PNG do ticket entra como spec-file do filho (sem filtro por tipo) — é o que o runner concatena", () => {
      const png = files.find((f) => f.filename === "print.png");
      expect(png).toBeDefined();
      expect(png!.relDir).toMatch(/^tickets\/TK-\d{4}\/anexos$/);
      expect(png!.mimeType).toBe("image/png");
    });
    // A quebra em si (read_text utf-8 estrito no runner) é provada em Python: applications/orchestrator/tests/test_evolve_repro_f0.py
  });

  // ── (d) status do filho × /promote ────────────────────────────────────────────────
  describe("(d) status do filho de /evolve × POST /api/projects/:id/promote (exige 'draft')", () => {
    let withFiles: { status: string; promote: { statusCode: number; code?: string } };
    let noFiles: { status: string; promote: { statusCode: number; code?: string } };
    beforeAll(async () => {
      const s1 = await seed();
      const c1 = (await evolve(s1.parentId, { request: "Adicionar exportação CSV" })).json().childProjectId as string;
      const st1 = (await pool.query("SELECT status FROM projects WHERE id=$1", [c1])).rows[0].status as string;
      const p1 = await app.inject({ method: "POST", url: `/api/projects/${c1}/promote` });
      withFiles = { status: st1, promote: { statusCode: p1.statusCode, code: p1.json().code } };

      const s2 = await seed({ specContent: null }); // pai sem arquivos de spec
      const c2 = (await evolve(s2.parentId, { request: "Adicionar exportação CSV" })).json().childProjectId as string;
      const st2 = (await pool.query("SELECT status FROM projects WHERE id=$1", [c2])).rows[0].status as string;
      const p2 = await app.inject({ method: "POST", url: `/api/projects/${c2}/promote` });
      noFiles = { status: st2, promote: { statusCode: p2.statusCode, code: p2.json().code } };
      ev("0.3-d", { paiComArquivos: withFiles, paiSemArquivos: noFiles });
    });
    it("harness: o filho de pai com spec nasce 'spec_submitted' (projects.ts:3575-3577)", () => {
      expect(withFiles.status).toBe("spec_submitted");
    });
    // DEFEITO 0.3-d: /evolve deixa o filho em 'spec_submitted'; /promote só admite 'draft' (pipeline.ts:141) ⇒ 409 NOT_ON_WORKBENCH — remover it.fails quando corrigido (tarefa 1.7)
    it.fails("filho recém-criado por /evolve NÃO é recusado com NOT_ON_WORKBENCH pelo /promote", () => {
      expect(withFiles.promote.code).not.toBe("NOT_ON_WORKBENCH");
    });
    it("REFUTAÇÃO parcial: filho de pai SEM arquivos fica 'draft' e o /promote não o recusa por status (cai no gate de spec ausente)", () => {
      expect(noFiles.status).toBe("draft");
      expect(noFiles.promote.code).not.toBe("NOT_ON_WORKBENCH");
    });
  });

  // ── (h) Bancada × filho de evolução (promoção do produto) ─────────────────────────
  describe("(h) Bancada promove filho de evolução? POST /api/products/:id/promote + veredito da tela", () => {
    let s: Seed; let lifecycleAfterEvolve: string; let lifecycleAfterRecompute: string | null;
    let promote: { statusCode: number; code?: string; lifecycleStatus?: string };
    let verdict: Awaited<ReturnType<typeof evaluateProductPromotability>>;
    let childExtra: Record<string, unknown>;
    beforeAll(async () => {
      s = await seed();
      const child = (await evolve(s.parentId, { request: "Adicionar exportação CSV" })).json().childProjectId as string;
      childExtra = (await pool.query("SELECT extra FROM projects WHERE id=$1", [child])).rows[0].extra;
      lifecycleAfterEvolve = (await pool.query("SELECT lifecycle_status FROM products WHERE id=$1", [s.productId])).rows[0].lifecycle_status;
      lifecycleAfterRecompute = await recomputeProductLifecycle(pool, s.productId);
      const pr = await app.inject({ method: "POST", url: `/api/products/${s.productId}/promote`, payload: {} });
      promote = { statusCode: pr.statusCode, code: pr.json().code, lifecycleStatus: pr.json().lifecycleStatus };
      const prod = (await pool.query("SELECT id, name, system_id, lifecycle_status, normalized_hash FROM products WHERE id=$1", [s.productId])).rows[0];
      verdict = await evaluateProductPromotability(pool, {
        id: prod.id, name: prod.name, systemId: prod.system_id, lifecycleStatus: prod.lifecycle_status, normalizedHash: prod.normalized_hash,
      });
      ev("0.3-h", { extraEvolution: childExtra.evolution, lifecycleAposEvolve: lifecycleAfterEvolve, lifecycleAposRecompute: lifecycleAfterRecompute,
        promoteProduto: promote, vereditoTela: { canPromote: verdict.canPromote, reason: verdict.reason, message: verdict.message } });
    });
    it("harness: o filho carrega extra.evolution=true", () => {
      expect(childExtra.evolution).toBe(true);
    });
    // DEFEITO 0.3-h: produto com filho de evolução está em 'accepted'/'partially_accepted', nunca 'draft'; o promote do produto exige 'draft' (products.ts:1333) ⇒ 409 NOT_ON_WORKBENCH — remover it.fails quando corrigido (tarefa 1.7)
    it.fails("a Bancada consegue promover o produto que tem um filho de evolução em rascunho (não responde NOT_ON_WORKBENCH)", () => {
      expect(promote.code).not.toBe("NOT_ON_WORKBENCH");
    });
    // DEFEITO 0.3-h: o veredito da tela diz 'já saiu da Bancada' (canPromote=false) para um filho que acabou de entrar nela — remover it.fails quando corrigido (tarefa 1.7)
    it.fails("o veredito da tela para o produto não é canPromote=false/NOT_ON_WORKBENCH", () => {
      expect(verdict.reason).not.toBe("NOT_ON_WORKBENCH");
    });
  });

  // ── (g) orçamento do filho ────────────────────────────────────────────────────────
  describe("(g) filho de evolução sem orçamento — INSERT sem budget_usd (projects.ts:3503) × Guard BUDGET_MISSING (llmGuard.ts:405)", () => {
    let parentDecision: Awaited<ReturnType<typeof preflight>>; let childDecision: Awaited<ReturnType<typeof preflight>>;
    let child: { budget_usd: string | null; budget_owner_project_id: string | null };
    let killBackup = "on";
    afterAll(async () => { await pool.query("UPDATE llm_guard_settings SET value=$1 WHERE key='kill_switch'", [killBackup]); });
    beforeAll(async () => {
      // A migration semeia a chave geral LIGADA (fail-closed; o banco vence o env). Desliga só neste banco efêmero para isolar o orçamento.
      killBackup = String((await pool.query("SELECT value FROM llm_guard_settings WHERE key='kill_switch'")).rows[0]?.value ?? "on");
      await pool.query("UPDATE llm_guard_settings SET value='off' WHERE key='kill_switch'");
      const s = await seed({ budgetUsd: 50 });
      const cid = (await evolve(s.parentId, { request: "Adicionar exportação CSV" })).json().childProjectId as string;
      child = (await pool.query("SELECT budget_usd, budget_owner_project_id FROM projects WHERE id=$1", [cid])).rows[0];
      parentDecision = await preflight(pool, { projectId: s.parentId, purpose: "teste-0.3-g", source: "teste" });
      childDecision = await preflight(pool, { projectId: cid, purpose: "teste-0.3-g", source: "teste" });
      ev("0.3-g", { filho: child, preflightPai: parentDecision, preflightFilho: childDecision });
    });
    it("controle: o pai com orçamento US$ 50 é liberado pelo Guard", () => {
      expect(parentDecision.allow).toBe(true);
    });
    // DEFEITO 0.3-g: o filho nasce sem budget_usd nem budget_owner_project_id ⇒ o Guard nega TODO LLM com BUDGET_MISSING — remover it.fails quando corrigido (tarefa 1.3)
    it.fails("o filho herda/compartilha o orçamento do pai (D-E10): budget_usd ou budget_owner_project_id preenchido", () => {
      expect(child.budget_usd !== null || child.budget_owner_project_id !== null).toBe(true);
    });
    // DEFEITO 0.3-g: idem, visto pelo Guard — remover it.fails quando corrigido (tarefa 1.3)
    it.fails("o Guard libera a primeira chamada de LLM do filho (não BUDGET_MISSING)", () => {
      expect(childDecision.allow).toBe(true);
    });
  });

  // ── (f) transições de ticket ──────────────────────────────────────────────────────
  describe("(f) PATCH /api/tickets/:id aceita qualquer transição (routes/tickets.ts:~270) e reopenTicketsOfChild reabre 'delivered' (services/tickets.ts:~241)", () => {
    const results: Record<string, { statusCode: number; code?: string; after: string }> = {};
    let reopen: { delivered: string; rejected: string; promoted: string };
    beforeAll(async () => {
      const s = await seed();
      const mkChild = async () => (await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number)
         VALUES ($1,$2,'filho','draft',$3,$4,2) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId])).rows[0].id as string;
      const patch = async (key: string, from: string, to: string, withChild: boolean) => {
        const child = withChild ? await mkChild() : null;
        const t = await seedTicket(pool, s, { status: from, childProjectId: child });
        const r = await app.inject({ method: "PATCH", url: `/api/tickets/${t.id}`, payload: { status: to } });
        results[key] = { statusCode: r.statusCode, code: r.json().code, after: (await ticketRow(pool, t.id)).status };
      };
      await patch("promoted→open", "promoted", "open", true);
      await patch("delivered→open", "delivered", "open", true);
      await patch("delivered→rejected", "delivered", "rejected", true);
      await patch("rejected→delivered", "rejected", "delivered", true);
      await patch("rejected→open", "rejected", "open", false);
      await patch("open→delivered", "open", "delivered", false);
      await patch("open→rejected", "open", "rejected", false);

      // reopenTicketsOfChild: um ticket por estado, cada um com seu filho descartado
      const states: Record<string, string> = {};
      for (const st of ["delivered", "rejected", "promoted"]) {
        const child = await mkChild();
        const t = await seedTicket(pool, s, { status: st, childProjectId: child });
        await reopenTicketsOfChild(pool, child);
        states[st] = (await ticketRow(pool, t.id)).status;
      }
      reopen = { delivered: states.delivered, rejected: states.rejected, promoted: states.promoted };
      ev("0.3-f", { patch: results, reopenTicketsOfChild: reopen });
    });
    const cases: Array<[string, string]> = [
      ["promoted→open", "promovido não volta a 'open' por PATCH manual (só pelo descarte do filho): fica com child_project_id e 'open' ⇒ promovível de novo"],
      ["delivered→open", "entregue não reabre por PATCH"],
      ["delivered→rejected", "entregue não vira 'rejected' por PATCH"],
      ["rejected→delivered", "recusado não vira 'delivered' por PATCH"],
    ];
    for (const [key, why] of cases) {
      // DEFEITO 0.3-f: o PATCH só valida o conjunto {open,rejected,delivered}; não há tabela de transições — remover it.fails quando corrigido (tarefa 1.4)
      it.fails(`PATCH ${key} é recusado (409): ${why}`, () => {
        expect(results[key].statusCode).toBe(409);
        expect(results[key].after).toBe(key.split("→")[0]);
      });
    }
    it("REFUTAÇÃO: open→delivered sem filho já é recusado (409 NOT_PROMOTED)", () => {
      expect(results["open→delivered"].statusCode).toBe(409);
      expect(results["open→delivered"].code).toBe("NOT_PROMOTED");
    });
    it("controle: transições legítimas open→rejected e rejected→open são aceitas (200)", () => {
      expect(results["open→rejected"].statusCode).toBe(200);
      expect(results["rejected→open"].statusCode).toBe(200);
    });
    // DEFEITO 0.3-f: reopenTicketsOfChild só exclui 'rejected' (WHERE status <> 'rejected') — reabre 'delivered' — remover it.fails quando corrigido (tarefa 1.4)
    it.fails("reopenTicketsOfChild NÃO reabre um ticket 'delivered' (D-A3)", () => {
      expect(reopen.delivered).toBe("delivered");
    });
    it("REFUTAÇÃO: reopenTicketsOfChild preserva 'rejected' e reabre 'promoted' (comportamento desejado)", () => {
      expect(reopen.rejected).toBe("rejected");
      expect(reopen.promoted).toBe("open");
    });
  });

  // ── (e) colisão de IDs no upsert (project_id, task_id) ────────────────────────────
  describe("(e) colisão TSK-INH-EVO-001 no upsert POST /api/projects/:id/tasks (projects.ts:~540)", () => {
    let rows: Array<{ task_id: string; requirements: string; status: string }>;
    beforeAll(async () => {
      const s = await seed();
      const cid = (await evolve(s.parentId, { request: "Adicionar exportação CSV" })).json().childProjectId as string;
      const post = (requirements: string) => app.inject({
        method: "POST", url: `/api/projects/${cid}/tasks`,
        payload: { tasks: [{ task_id: "TSK-INH-EVO-001", module: "backend", owner_role: "DEV", requirements, status: "DONE" }] },
      });
      await post("[HERDADA da versão anterior — TSK-EVO-001] origem v2: exportar CSV");
      await post("[HERDADA da versão anterior — TSK-EVO-001] origem v3: filtro por data");
      rows = (await pool.query("SELECT task_id, requirements, status FROM project_tasks WHERE project_id=$1", [cid])).rows;
      ev("0.3-e/upsert", { linhas: rows });
    });
    it("CARACTERIZAÇÃO: duas heranças com o mesmo ID colapsam em UMA linha e a segunda sobrescreve os requisitos da primeira", () => {
      expect(rows).toHaveLength(1);
      expect(rows[0].requirements).toContain("origem v3");
      expect(rows[0].requirements).not.toContain("origem v2");
      // O upsert é por desenho; o defeito está no gerador do ID (runner.py:3918) — ver test_evolve_repro_f0.py.
    });
  });

  void testUser; void uid;
});
