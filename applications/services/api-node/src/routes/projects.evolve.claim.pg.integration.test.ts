/**
 * Fase 1' (tarefas 1.1 e 1.3) — /evolve em DUAS ETAPAS (EVOLVE_CLAIM=on) em Postgres REAL efêmero, rotas reais.
 * Desenho: project/docs/analysis/EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md §1, §2, §6.
 *
 * Cobre: corrida de N simultâneas ⇒ 1 filho · repetição idempotente (ticket e Idempotency-Key) · crash simulado
 * em CADA ponto (antes/depois do commit do claim, de cada passo e do finalize) com retomada sem duplicar ·
 * ticket promovido 3 vezes ⇒ 1 filho · orçamento (dono terminal, negativa do Guard sem filho, saldo livre mínimo) ·
 * regras do HEAD (PARENT_SUPERSEDED, janela de supersessão adiada) · falha terminal reabre o ticket · lock_timeout ·
 * `off` byte-idêntico ao histórico.
 *
 * Só roda com PG_TEST_URL (localhost:55432|55440). Sem ele: skip.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { rmSync, mkdirSync, writeFileSync, existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp,
  raceN, queryGate, childrenOf, ticketRow, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";
import { preflight } from "../services/llmGuard.js";
import { evolveTestHooks, SimulatedCrash, NS_EVOLVE } from "../services/evolveClaim.js";

const ev = (tag: string, data: unknown) => console.log(`[F1-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);

describePg("Fase 1' / 1.1+1.3 — /evolve com claim (EVOLVE_CLAIM=on), Postgres real", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];

  beforeAll(async () => {
    vi.stubEnv("EVOLVE_CLAIM", "on");
    pool = await openPg();
    app = await buildApp([projectRoutes, ticketRoutes]);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    for (const s of seeds) s.cleanup();
    await pool?.end();
  });
  afterEach(() => { evolveTestHooks.fault = undefined; });

  const seed = async (o: Parameters<typeof seedAcceptedProduct>[1] = {}) => {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 50, ...o });
    seeds.push(s);
    return s;
  };
  const evolve = (parentId: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/api/projects/${parentId}/evolve`, payload, headers });
  const expireLease = (childId: string) => pool.query(
    `UPDATE projects SET extra = jsonb_set(extra, '{materialization,lease_until}', to_jsonb(now() - interval '1 minute')) WHERE id = $1`, [childId]);
  const specFiles = async (childId: string) => (await pool.query(
    "SELECT rel_dir, filename, is_primary FROM project_spec_files WHERE project_id = $1 ORDER BY rel_dir, filename", [childId])).rows as
    Array<{ rel_dir: string; filename: string; is_primary: boolean }>;
  const liveKids = async (parentId: string) => (await childrenOf(pool, parentId)).filter((k) => !["failed", "archived"].includes(k.status));
  const EXTRA = [{ relDir: "docs/rfc", filename: "RFC-0001.md", content: "# RFC 1\n" }];

  // ── caminho feliz ──────────────────────────────────────────────────────────────────────
  describe("caminho feliz (controle)", () => {
    it("201 com o mesmo corpo do caminho histórico, filho finalizado, ticket promovido na mesma operação", async () => {
      const s = await seed({ extraFiles: EXTRA });
      const t = await seedTicket(pool, s);
      const r = await evolve(s.parentId, { ticketId: t.id });
      const kids = await childrenOf(pool, s.parentId);
      const tk = await ticketRow(pool, t.id);
      ev("feliz", { status: r.statusCode, chaves: Object.keys(r.json()).sort(), filho: { status: kids[0]?.status, v: kids[0]?.version_number }, ticket: tk.status });
      expect(r.statusCode).toBe(201);
      expect(Object.keys(r.json()).sort()).toEqual(
        ["childProjectId", "evolutionSource", "evolutionSourceError", "inheritedFiles", "lineageRootId", "message", "ok", "parentProjectId", "title", "versionNumber", "workMode"]);
      expect(kids).toHaveLength(1);
      expect(kids[0].status).toBe("spec_submitted");
      expect(kids[0].version_number).toBe(2);
      expect(kids[0].extra.evolution).toBe(true);
      expect((kids[0].extra.materialization as { finalized_at?: string }).finalized_at).toBeTruthy();
      expect(tk.status).toBe("promoted");
      expect(tk.child_project_id).toBe(kids[0].id);
      const files = (await specFiles(kids[0].id)).map((f) => `${f.rel_dir}/${f.filename}`);
      expect(files).toEqual(["/spec-evolution-v2.md", "docs/rfc/RFC-0001.md", "tickets/TK-0001/request.md"]);
    });
  });

  // ── corrida ────────────────────────────────────────────────────────────────────────────
  describe("corrida de N simultâneas ⇒ 1 filho", () => {
    it("N=8 sem ticket, todas retidas NO advisory lock e soltas juntas: 1× 201, 7× 409 EVOLUTION_IN_FLIGHT, 1 filho", async () => {
      const s = await seed();
      const N = 8;
      const gate = queryGate(pool, /pg_advisory_xact_lock/, { mode: "hold-before", arrivals: N });
      const racing = raceN(N, () => evolve(s.parentId, { request: "Adicionar exportação CSV" }));
      await gate.reached;
      gate.release();
      const rs = await racing;
      gate.uninstall();
      const codes = rs.map((r) => r.statusCode).sort();
      const kids = await childrenOf(pool, s.parentId);
      ev("corrida-N8", { codes, filhos: kids.map((k) => ({ v: k.version_number, status: k.status })), erros409: [...new Set(rs.filter((r) => r.statusCode === 409).map((r) => r.json().code))] });
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(N - 1);
      expect(rs.filter((r) => r.statusCode === 409).every((r) => r.json().code === "EVOLUTION_IN_FLIGHT" && r.json().childProjectId === kids[0].id)).toBe(true);
      expect(kids).toHaveLength(1);
      expect(new Set(kids.map((k) => k.version_number)).size).toBe(kids.length);
    });

    it("N=8 sem barreira (Promise.all puro), repetido 3 vezes: sempre 1 filho", async () => {
      for (let rep = 0; rep < 3; rep++) {
        const s = await seed();
        const rs = await raceN(8, () => evolve(s.parentId, { request: "Adicionar exportação CSV" }));
        const kids = await childrenOf(pool, s.parentId);
        expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
        expect(rs.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
        expect(kids).toHaveLength(1);
      }
    });

    it("mesmo ticket em N=5 simultâneas: 1 filho, ticket 'promoted' apontando para ele, sem órfãos", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      const N = 5;
      const gate = queryGate(pool, /pg_advisory_xact_lock/, { mode: "hold-before", arrivals: N });
      const racing = raceN(N, () => evolve(s.parentId, { ticketId: t.id }));
      await gate.reached;
      gate.release();
      const rs = await racing;
      gate.uninstall();
      const kids = await childrenOf(pool, s.parentId);
      const tk = await ticketRow(pool, t.id);
      ev("ticket-N5", { codes: rs.map((r) => r.statusCode).sort(), codigos409: rs.filter((r) => r.statusCode === 409).map((r) => r.json().code), filhos: kids.length, ticket: tk.status });
      expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.statusCode !== 201).every((r) => [200, 409].includes(r.statusCode))).toBe(true);
      expect(rs.filter((r) => r.statusCode === 409).every((r) => r.json().code === "MATERIALIZATION_IN_PROGRESS")).toBe(true);
      expect(kids).toHaveLength(1);
      expect(tk.status).toBe("promoted");
      expect(tk.child_project_id).toBe(kids[0].id);
    });

    it("recusa concorrente vence (defeito (b') do estudo F): ticket 'rejected' antes do FOR UPDATE do claim ⇒ 409 e nenhum filho", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      // Retém o /evolve ANTES de ler o ticket sob lock; nesse intervalo o humano recusa o pedido.
      const gate = queryGate(pool, /FROM tickets WHERE id = \$1 FOR UPDATE/, { mode: "hold-before" });
      const evolving = evolve(s.parentId, { ticketId: t.id });
      await gate.reached;
      const patch = await app.inject({ method: "PATCH", url: `/api/tickets/${t.id}`, payload: { status: "rejected" } });
      gate.release();
      const er = await evolving;
      gate.uninstall();
      const tk = await ticketRow(pool, t.id);
      ev("recusa-concorrente", { patch: patch.statusCode, evolve: er.statusCode, codigo: er.json().code, ticket: tk.status, filhos: (await childrenOf(pool, s.parentId)).length });
      expect(patch.statusCode).toBe(200);
      expect(er.statusCode).toBe(409);
      expect(tk.status).toBe("rejected");
      expect(await childrenOf(pool, s.parentId)).toHaveLength(0);
    });
  });

  // ── idempotência ───────────────────────────────────────────────────────────────────────
  describe("idempotência", () => {
    it("ticket promovido 3 vezes em sequência: 201, 200 replayed, 200 replayed — sempre o MESMO filho", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      const rs = [await evolve(s.parentId, { ticketId: t.id }), await evolve(s.parentId, { ticketId: t.id }), await evolve(s.parentId, { ticketId: t.id })];
      const kids = await childrenOf(pool, s.parentId);
      ev("ticket-x3", { codes: rs.map((r) => r.statusCode), replayed: rs.map((r) => r.json().replayed ?? false), filhos: kids.length });
      expect(rs.map((r) => r.statusCode)).toEqual([201, 200, 200]);
      expect(rs[1].json().replayed).toBe(true);
      expect(rs[1].json().childProjectId).toBe(rs[0].json().childProjectId);
      expect(rs[2].json().childProjectId).toBe(rs[0].json().childProjectId);
      expect(kids).toHaveLength(1);
      expect(await specFiles(kids[0].id)).toHaveLength(2);
    });

    it("Idempotency-Key sem ticket: mesma chave+mesmo corpo ⇒ 200 replayed; corpo diferente ⇒ 422; sem chave ⇒ 409 EVOLUTION_IN_FLIGHT", async () => {
      const s = await seed();
      const h = { "idempotency-key": `k-${Date.now()}-abcdef` };
      const a = await evolve(s.parentId, { request: "Adicionar exportação CSV" }, h);
      const b = await evolve(s.parentId, { request: "Adicionar exportação CSV" }, h);
      const c = await evolve(s.parentId, { request: "Outra coisa completamente diferente" }, h);
      const d = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      ev("idem-key", { a: a.statusCode, b: [b.statusCode, b.json().replayed], c: [c.statusCode, c.json().code], d: [d.statusCode, d.json().code] });
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(200);
      expect(b.json().replayed).toBe(true);
      expect(b.json().childProjectId).toBe(a.json().childProjectId);
      expect(c.statusCode).toBe(422);
      expect(c.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(d.statusCode).toBe(409);
      expect(d.json().code).toBe("EVOLUTION_IN_FLIGHT");
      expect(await childrenOf(pool, s.parentId)).toHaveLength(1);
    });

    it("depois de falha terminal a MESMA chave abre nova tentativa (failed não prende a chave)", async () => {
      const s = await seed();
      const h = { "idempotency-key": `k-${Date.now()}-retry00` };
      const a = await evolve(s.parentId, { request: "Adicionar exportação CSV" }, h);
      await pool.query("UPDATE projects SET status = 'failed' WHERE id = $1", [a.json().childProjectId]);
      const b = await evolve(s.parentId, { request: "Adicionar exportação CSV" }, h);
      expect(b.statusCode).toBe(201);
      expect(b.json().childProjectId).not.toBe(a.json().childProjectId);
      expect(b.json().versionNumber).toBe(a.json().versionNumber); // o número da tentativa falha é reaproveitado (U1 exclui failed)
    });
  });

  // ── crash simulado em cada ponto ───────────────────────────────────────────────────────
  describe("crash simulado em cada ponto ⇒ retomada sem duplicar", () => {
    const STEPS = ["spec_tree", "code", "ticket", "triages", "dialogue"];
    const POINTS = [
      "after_claim",
      ...STEPS.flatMap((st) => [`before:${st}`, `after_work:${st}`, `after_mark:${st}`]),
      "before_finalize",
      "after_finalize",
    ];

    // C0: antes do COMMIT do claim ⇒ nada persiste, a repetição começa do zero
    it("C0 before_commit: rollback total (sem filho, ticket 'open'); repetição ⇒ 201", async () => {
      const s = await seed({ extraFiles: EXTRA });
      const t = await seedTicket(pool, s);
      let fired = false;
      evolveTestHooks.fault = (p) => { if (p === "before_commit" && !fired) { fired = true; throw new SimulatedCrash(p); } };
      const crashed = await evolve(s.parentId, { ticketId: t.id });
      expect(crashed.statusCode).toBe(500);
      expect(await childrenOf(pool, s.parentId)).toHaveLength(0);
      expect((await ticketRow(pool, t.id)).status).toBe("open");
      const again = await evolve(s.parentId, { ticketId: t.id });
      expect(again.statusCode).toBe(201);
      expect(await childrenOf(pool, s.parentId)).toHaveLength(1);
    });

    for (const point of POINTS) {
      it(`crash em ${point}: lease vigente ⇒ 409 MATERIALIZATION_IN_PROGRESS; lease vencido ⇒ retoma e termina com 1 filho íntegro`, async () => {
        const s = await seed({ extraFiles: EXTRA });
        const t = await seedTicket(pool, s);
        let fired = false;
        evolveTestHooks.fault = (p) => { if (p === point && !fired) { fired = true; throw new SimulatedCrash(p); } };
        const crashed = await evolve(s.parentId, { ticketId: t.id });
        evolveTestHooks.fault = undefined;
        expect(crashed.statusCode).toBe(500);

        const kidsAfterCrash = await childrenOf(pool, s.parentId);
        expect(kidsAfterCrash).toHaveLength(1);
        const childId = kidsAfterCrash[0].id;
        const finalizedAlready = point === "after_finalize";
        expect(kidsAfterCrash[0].status).toBe(finalizedAlready ? "spec_submitted" : "materializing");
        expect((await ticketRow(pool, t.id)).status).toBe("promoted");

        if (!finalizedAlready) {
          // o processo "morreu" com o lease na mão: uma repetição imediata NÃO pode atropelar
          const busy = await evolve(s.parentId, { ticketId: t.id });
          expect(busy.statusCode).toBe(409);
          expect(busy.json().code).toBe("MATERIALIZATION_IN_PROGRESS");
          expect(busy.headers["retry-after"]).toBeTruthy();
          await expireLease(childId);
        }
        const resumed = await evolve(s.parentId, { ticketId: t.id });
        expect(resumed.statusCode).toBe(200);
        expect(resumed.json().childProjectId).toBe(childId);
        expect(resumed.json()[finalizedAlready ? "replayed" : "resumed"]).toBe(true);

        const kids = await childrenOf(pool, s.parentId);
        const files = (await specFiles(childId)).map((f) => `${f.rel_dir}/${f.filename}`);
        const dlg = (await pool.query("SELECT count(*)::int AS n FROM project_dialogue WHERE project_id = $1", [childId])).rows[0].n as number;
        if (point === "after_work:spec_tree" || point === "after_mark:spec_tree") {
          // sanity: o crash ocorreu com a árvore já copiada e nada foi duplicado na retomada
        }
        expect(kids).toHaveLength(1);
        expect(kids[0].status).toBe("spec_submitted");
        expect((kids[0].extra.materialization as { finalized_at?: string }).finalized_at).toBeTruthy();
        expect(Object.keys((kids[0].extra.materialization as { steps: object }).steps).sort()).toEqual([...STEPS].sort());
        expect(files).toEqual(["/spec-evolution-v2.md", "docs/rfc/RFC-0001.md", "tickets/TK-0001/request.md"]);
        // única duplicação tolerada (cosmética, H §1.3 S5): mensagem do diálogo se o crash for entre o INSERT e o marcador
        expect(dlg).toBe(point === "after_work:dialogue" ? 2 : 1);
        expect((await ticketRow(pool, t.id)).child_project_id).toBe(childId);
        // e uma terceira repetição é um replay puro
        const third = await evolve(s.parentId, { ticketId: t.id });
        expect(third.statusCode).toBe(200);
        expect(third.json().replayed).toBe(true);
        expect(await liveKids(s.parentId)).toHaveLength(1);
      });
    }

    it("resumo das evidências: 19 pontos de crash exercitados", () => {
      ev("crash-pontos", { total: POINTS.length + 1, pontos: ["before_commit", ...POINTS] });
      expect(POINTS).toHaveLength(18);
    });

    it("falha recuperável (exceção comum, não crash): lease é liberado e a repetição retoma NA HORA", async () => {
      const s = await seed({ extraFiles: EXTRA });
      const t = await seedTicket(pool, s);
      let fired = false;
      evolveTestHooks.fault = (p) => { if (p === "after_mark:spec_tree" && !fired) { fired = true; throw new Error("disco cheio (simulado)"); } };
      const failed = await evolve(s.parentId, { ticketId: t.id });
      evolveTestHooks.fault = undefined;
      expect(failed.statusCode).toBe(500);
      expect(failed.json().code).toBe("MATERIALIZATION_FAILED");
      const again = await evolve(s.parentId, { ticketId: t.id });
      expect(again.statusCode).toBe(200);
      expect(again.json().resumed).toBe(true);
      expect(await liveKids(s.parentId)).toHaveLength(1);
    });
  });

  // ── passo `code` (cópia do apps/ da versão corrente, sem repositório GitHub) ──────────────
  describe("passo code (fallback disk-copy) é reexecutável enquanto 'materializing'", () => {
    it("crash depois do trabalho e ANTES do marcador: a retomada refaz a cópia do zero (descarta resíduo parcial) e registra disk-copy", async () => {
      const root = mkdtempSync(join(tmpdir(), "genesis-files-root-"));
      try {
        const s = await seed();
        vi.stubEnv("PROJECT_FILES_ROOT", root); // depois do seed (ele zera o env)
        mkdirSync(join(root, s.parentId, "apps", "src"), { recursive: true });
        writeFileSync(join(root, s.parentId, "apps", "src", "index.js"), "console.log('v1')\n");
        let fired = false;
        evolveTestHooks.fault = (p) => { if (p === "after_work:code" && !fired) { fired = true; throw new SimulatedCrash(p); } };
        const crashed = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
        evolveTestHooks.fault = undefined;
        expect(crashed.statusCode).toBe(500);
        const child = (await childrenOf(pool, s.parentId))[0];
        const childApps = join(root, child.id, "apps");
        expect(existsSync(join(childApps, "src", "index.js"))).toBe(true);
        writeFileSync(join(childApps, "residuo-parcial.tmp"), "lixo de uma cópia interrompida");
        await expireLease(child.id);
        const resumed = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
        const after = (await childrenOf(pool, s.parentId))[0];
        ev("code-disk-copy", { resumed: resumed.statusCode, codigo: (after.extra.materialization as { steps: { code: { source: string } } }).steps.code.source, residuoRemovido: !existsSync(join(childApps, "residuo-parcial.tmp")) });
        expect(resumed.statusCode).toBe(200);
        expect(existsSync(join(childApps, "residuo-parcial.tmp"))).toBe(false);
        expect(existsSync(join(childApps, "src", "index.js"))).toBe(true);
        expect(after.extra.evolution_source).toBe("disk-copy");
        expect(await childrenOf(pool, s.parentId)).toHaveLength(1);
      } finally {
        vi.unstubAllEnvs();
        vi.stubEnv("EVOLVE_CLAIM", "on");
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // ── falha terminal ─────────────────────────────────────────────────────────────────────
  describe("falha terminal", () => {
    it("spec da versão corrente ilegível no disco ⇒ 422 HEAD_SPEC_UNREADABLE, filho 'failed', ticket volta a 'open' e pode tentar de novo", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      const rows = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1", [s.parentId])).rows as Array<{ file_path: string }>;
      for (const r of rows) rmSync(r.file_path, { force: true });
      const r1 = await evolve(s.parentId, { ticketId: t.id });
      const kids = await childrenOf(pool, s.parentId);
      const tk = await ticketRow(pool, t.id);
      ev("terminal", { status: r1.statusCode, codigo: r1.json().code, filho: kids[0]?.status, ticket: tk.status, child: tk.child_project_id });
      expect(r1.statusCode).toBe(422);
      expect(r1.json().code).toBe("HEAD_SPEC_UNREADABLE");
      expect(kids).toHaveLength(1);
      expect(kids[0].status).toBe("failed");
      expect(tk.status).toBe("open");
      expect(tk.child_project_id).toBeNull();
      // failed sai do guard: nova tentativa cria outro filho
      const r2 = await evolve(s.parentId, { ticketId: t.id });
      expect(r2.statusCode).toBe(422);
      expect(await childrenOf(pool, s.parentId)).toHaveLength(2);
    });
  });

  // ── HEAD / versão ──────────────────────────────────────────────────────────────────────
  describe("HEAD da linhagem (resolveLineageHead)", () => {
    it("pai superado ⇒ 409 PARENT_SUPERSEDED com currentProjectId; a versão corrente evolui (v3)", async () => {
      const s = await seed();
      const v2 = (await evolve(s.parentId, { request: "primeira" })).json().childProjectId as string;
      // aceite do v2 COM supersessão do v1 concluída
      await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [v2]);
      await pool.query("UPDATE projects SET extra = extra || jsonb_build_object('superseded_by', $2::text) WHERE id = $1", [s.parentId, v2]);
      const old = await evolve(s.parentId, { request: "segunda" });
      const cur = await evolve(v2, { request: "segunda" });
      ev("head-superado", { velho: [old.statusCode, old.json().code, old.json().currentProjectId === v2], corrente: [cur.statusCode, cur.json().versionNumber] });
      expect(old.statusCode).toBe(409);
      expect(old.json().code).toBe("PARENT_SUPERSEDED");
      expect(old.json().currentProjectId).toBe(v2);
      expect(cur.statusCode).toBe(201);
      expect(cur.json().versionNumber).toBe(3);
    });

    it("janela de supersessão adiada (F10): v2 aceito mas v1 SEM superseded_by ⇒ evoluir v1 dá 409, evoluir v2 dá v3 (nunca dois 'vN')", async () => {
      const s = await seed();
      const v2 = (await evolve(s.parentId, { request: "primeira" })).json().childProjectId as string;
      await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [v2]);
      const old = await evolve(s.parentId, { request: "outra" });
      expect(old.statusCode).toBe(409);
      expect(old.json().code).toBe("PARENT_SUPERSEDED");
      expect(old.json().currentProjectId).toBe(v2);
      const cur = await evolve(v2, { request: "outra" });
      expect(cur.statusCode).toBe(201);
      expect(cur.json().versionNumber).toBe(3);
    });

    it("pai que não está 'accepted' mantém o 409 CONFLICT histórico; ticket inexistente ⇒ 404", async () => {
      const s = await seed();
      await pool.query("UPDATE projects SET status = 'draft' WHERE id = $1", [s.parentId]);
      const r = await evolve(s.parentId, { request: "x" });
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe("CONFLICT");
      await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [s.parentId]);
      const nf = await evolve(s.parentId, { ticketId: "00000000-0000-0000-0000-000000000000" });
      expect(nf.statusCode).toBe(404);
      expect(nf.json().code).toBe("TICKET_NOT_FOUND");
    });
  });

  // ── lock_timeout ───────────────────────────────────────────────────────────────────────
  describe("espera pelo lock da linhagem", () => {
    it("lock ocupado por outra sessão > 5 s ⇒ 409 EVOLUTION_BUSY + Retry-After, sem filho (lock_timeout vale para advisory lock)", async () => {
      const s = await seed();
      const holder = await pool.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1::int, hashtext($2::text))", [NS_EVOLVE, s.parentId]);
        const t0 = Date.now();
        const r = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
        const ms = Date.now() - t0;
        ev("lock-timeout", { status: r.statusCode, codigo: r.json().code, esperaMs: ms, retryAfter: r.headers["retry-after"] });
        expect(r.statusCode).toBe(409);
        expect(r.json().code).toBe("EVOLUTION_BUSY");
        expect(r.headers["retry-after"]).toBe("2");
        expect(ms).toBeGreaterThanOrEqual(4500);
        expect(await childrenOf(pool, s.parentId)).toHaveLength(0);
      } finally {
        await holder.query("SELECT pg_advisory_unlock($1::int, hashtext($2::text))", [NS_EVOLVE, s.parentId]);
        holder.release();
      }
    }, 30_000);
  });

  // ── DELETE de filho materializando ─────────────────────────────────────────────────────
  describe("DELETE de filho 'materializing'", () => {
    it("lease vigente ⇒ 409 MATERIALIZING; lease vencido ⇒ exclusão permitida (limpeza manual)", async () => {
      const s = await seed();
      let fired = false;
      evolveTestHooks.fault = (p) => { if (p === "after_claim" && !fired) { fired = true; throw new SimulatedCrash(p); } };
      await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      evolveTestHooks.fault = undefined;
      const child = (await childrenOf(pool, s.parentId))[0];
      const del1 = await app.inject({ method: "DELETE", url: `/api/projects/${child.id}`, payload: {} });
      expect(del1.statusCode).toBe(409);
      expect(del1.json().code).toBe("MATERIALIZING");
      await expireLease(child.id);
      const del2 = await app.inject({ method: "DELETE", url: `/api/projects/${child.id}`, payload: {} });
      expect(del2.statusCode).toBeLessThan(300);
      expect(await childrenOf(pool, s.parentId)).toHaveLength(0);
    });
  });

  // ── 1.3 orçamento ──────────────────────────────────────────────────────────────────────
  describe("1.3 orçamento na criação", () => {
    let killBackup = "on";
    beforeAll(async () => {
      killBackup = String((await pool.query("SELECT value FROM llm_guard_settings WHERE key='kill_switch'")).rows[0]?.value ?? "on");
      await pool.query("UPDATE llm_guard_settings SET value='off' WHERE key='kill_switch'");
    });
    afterAll(async () => { await pool.query("UPDATE llm_guard_settings SET value=$1 WHERE key='kill_switch'", [killBackup]); });

    it("o filho herda o dono do orçamento (budget_usd NULL, owner = pai) e o Guard libera a primeira chamada (inverte o it.fails (g))", async () => {
      const s = await seed();
      const r = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      const child = (await childrenOf(pool, s.parentId))[0];
      const pf = await preflight(pool, { projectId: child.id, purpose: "teste-f1-1.3", source: "teste" });
      ev("orcamento-herda", { status: r.statusCode, filho: { budget_usd: child.budget_usd, owner: child.budget_owner_project_id === s.parentId ? "pai" : child.budget_owner_project_id }, preflightFilho: { allow: pf.allow } });
      expect(r.statusCode).toBe(201);
      expect(child.budget_usd).toBeNull();
      expect(child.budget_owner_project_id).toBe(s.parentId);
      expect(pf.allow).toBe(true);
    });

    it("dono TERMINAL: v3 evoluída de v2 aponta para o dono de v2 (a raiz v1), nunca para o v2 (resolveBudgetOwner só sobe um nível)", async () => {
      const s = await seed();
      const v2 = (await evolve(s.parentId, { request: "primeira" })).json().childProjectId as string;
      await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [v2]);
      await pool.query("UPDATE projects SET extra = extra || jsonb_build_object('superseded_by', $2::text) WHERE id = $1", [s.parentId, v2]);
      const v3 = (await evolve(v2, { request: "segunda" })).json().childProjectId as string;
      const row = (await pool.query("SELECT budget_owner_project_id FROM projects WHERE id = $1", [v3])).rows[0];
      expect(row.budget_owner_project_id).toBe(s.parentId);
      const pf = await preflight(pool, { projectId: v3, purpose: "teste-f1-1.3", source: "teste" });
      expect(pf.allow).toBe(true);
    });

    it("negativa do Guard: orçamento PAUSADO ⇒ 402 BUDGET_PAUSED, nenhum filho, ticket continua 'open'", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'teste' WHERE id = $1", [s.parentId]);
      const r = await evolve(s.parentId, { ticketId: t.id });
      ev("guard-pausado", { status: r.statusCode, codigo: r.json().code, filhos: (await childrenOf(pool, s.parentId)).length, ticket: (await ticketRow(pool, t.id)).status });
      expect(r.statusCode).toBe(402);
      expect(r.json().code).toBe("BUDGET_PAUSED");
      expect(await childrenOf(pool, s.parentId)).toHaveLength(0);
      expect((await ticketRow(pool, t.id)).status).toBe("open");
    });

    it("negativa do Guard: dono sem orçamento ⇒ 402 BUDGET_MISSING, nenhum filho", async () => {
      const s = await seed({ budgetUsd: null });
      const r = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      expect(r.statusCode).toBe(402);
      expect(r.json().code).toBe("BUDGET_MISSING");
      expect(await childrenOf(pool, s.parentId)).toHaveLength(0);
    });

    it("saldo livre mínimo (genesis_runtime_config.EVOLVE_MIN_FREE_BUDGET_USD, padrão 5): US$ 3 ⇒ 402 BUDGET_FREE_BELOW_MIN; override do tenant = 0 libera", async () => {
      const seeded = (await pool.query("SELECT value FROM genesis_runtime_config WHERE key='EVOLVE_MIN_FREE_BUDGET_USD' AND tenant_id IS NULL")).rows[0]?.value;
      expect(seeded).toBe("5");
      const s = await seed({ budgetUsd: 3 });
      const low = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      ev("saldo-minimo", { padrao: seeded, orcamento: 3, status: low.statusCode, codigo: low.json().code, minFreeUsd: low.json().minFreeUsd });
      expect(low.statusCode).toBe(402);
      expect(low.json().code).toBe("BUDGET_FREE_BELOW_MIN");
      expect(low.json().minFreeUsd).toBe(5);
      expect(await childrenOf(pool, s.parentId)).toHaveLength(0);
      await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id, description) VALUES ('EVOLVE_MIN_FREE_BUDGET_USD','0',$1,'teste')", [s.tenantId]);
      const ok = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      expect(ok.statusCode).toBe(201);
      const s2 = await seed({ budgetUsd: 5 });
      const edge = await evolve(s2.parentId, { request: "Adicionar exportação CSV" });
      expect(edge.statusCode).toBe(201); // saldo livre == mínimo passa
    });

    it("repetição NÃO é barrada pelo orçamento: replay de pedido já aceito responde 200 mesmo com o Guard negando agora", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      const a = await evolve(s.parentId, { ticketId: t.id });
      await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'teste' WHERE id = $1", [s.parentId]);
      const b = await evolve(s.parentId, { ticketId: t.id });
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(200);
      expect(b.json().replayed).toBe(true);
    });
  });
});

// ── `off` byte-idêntico ──────────────────────────────────────────────────────────────────
describePg("Fase 1' — EVOLVE_CLAIM=off: comportamento HISTÓRICO preservado (regressão)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  beforeAll(async () => {
    vi.stubEnv("EVOLVE_CLAIM", "off");
    pool = await openPg();
    app = await buildApp([projectRoutes, ticketRoutes]);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    for (const s of seeds) s.cleanup();
    await pool?.end();
  });
  const seed = async (o: Parameters<typeof seedAcceptedProduct>[1] = {}) => { const s = await seedAcceptedProduct(pool, o); seeds.push(s); return s; };
  const evolve = (parentId: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/api/projects/${parentId}/evolve`, payload, headers });

  it("201 com as MESMAS chaves e valores do corpo histórico; filho 'spec_submitted', sem materialization, sem dono de orçamento, ticket promovido no fim", async () => {
    const s = await seed({ extraFiles: [{ relDir: "docs/rfc", filename: "RFC-0001.md", content: "# RFC 1\n" }] });
    const t = await seedTicket(pool, s);
    const r = await evolve(s.parentId, { ticketId: t.id });
    const kid = (await childrenOf(pool, s.parentId))[0];
    const body = r.json();
    const golden = {
      ok: true, parentProjectId: s.parentId, lineageRootId: s.parentId, versionNumber: 2, workMode: "copy", evolutionSource: "none",
      evolutionSourceError: null, inheritedFiles: 2, title: expect.stringMatching(/ — Evolução v2$/),
      message: "Projeto de evolução criado. Envie ao pipeline via POST /run quando estiver pronto.",
    };
    ev("off-golden", { status: r.statusCode, chaves: Object.keys(body) });
    expect(r.statusCode).toBe(201);
    expect(Object.keys(body)).toEqual(["ok", "childProjectId", "parentProjectId", "lineageRootId", "versionNumber", "workMode", "evolutionSource", "evolutionSourceError", "inheritedFiles", "title", "message"]);
    expect(body).toMatchObject(golden);
    expect(kid.status).toBe("spec_submitted");
    expect(kid.budget_owner_project_id).toBeNull();
    expect(kid.budget_usd).toBeNull();
    expect(kid.extra).not.toHaveProperty("materialization");
    expect(kid.extra).not.toHaveProperty("evolve_idempotency_key");
    expect(Object.keys(kid.extra).sort()).toEqual([
      "evolution", "evolution_branch", "evolution_inherited_files", "evolution_inherited_spec", "evolution_parent_id", "evolution_request",
      "evolution_root_id", "evolution_source", "evolution_source_error", "evolution_work_mode", "ticket_files", "ticket_id", "ticket_kind", "ticket_materialize_error", "ticket_number",
    ]);
    expect((await ticketRow(pool, t.id)).status).toBe("promoted");
  });

  it("contratos de erro históricos: repetição do ticket ⇒ 409 TICKET_ALREADY_PROMOTED; sem ticket ⇒ 409 EVOLUTION_IN_FLIGHT; Idempotency-Key é IGNORADA; pai sem orçamento NÃO é barrado", async () => {
    const s = await seed(); // SEM orçamento: o caminho histórico nunca consultou o Guard aqui
    const t = await seedTicket(pool, s);
    const a = await evolve(s.parentId, { ticketId: t.id });
    const b = await evolve(s.parentId, { ticketId: t.id });
    const c = await evolve(s.parentId, { request: "outra" }, { "idempotency-key": "k-ignorada-123" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(409);
    expect(b.json().code).toBe("TICKET_ALREADY_PROMOTED");
    expect(b.json().childProjectId).toBe(a.json().childProjectId);
    expect(c.statusCode).toBe(409);
    expect(c.json().code).toBe("EVOLUTION_IN_FLIGHT");
  });

  it("o defeito histórico de corrida segue presente com a flag desligada (nada mudou): N simultâneas ⇒ mais de um filho no mesmo número de versão", async () => {
    const s = await seed();
    const N = 4;
    const gate = queryGate(pool, /parent_project_id = \$1 AND status NOT IN/, { mode: "barrier", arrivals: N });
    const rs = await raceN(N, () => evolve(s.parentId, { request: "Adicionar exportação CSV" }));
    gate.uninstall();
    const kids = await childrenOf(pool, s.parentId);
    ev("off-corrida", { codes: rs.map((r) => r.statusCode).sort(), filhos: kids.length });
    expect(kids.length).toBeGreaterThan(1);
  });
});
