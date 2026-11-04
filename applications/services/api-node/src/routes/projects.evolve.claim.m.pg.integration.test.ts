/**
 * Correções da revisão adversarial M (EVOLUIR-PROJETO-M) no motor do claim/consistência — Fase 1', Postgres REAL efêmero.
 * Relatório: project/docs/analysis/EVOLUIR-PROJETO-N-correcoes-fase1-motor.md
 *
 * Cobre: M-04 (heartbeat do lease, abortar sem efeito destrutivo, failTerminal com CAS de dono) · M-05 (transitório lança,
 * permanente é falha terminal, marcador só quando concluiu) · M-06/M-21 (lifecycle do produto) · M-11 (pedido recusado) ·
 * M-12 (laço dos pontos de crash COM PROJECT_FILES_ROOT e apps/ semeado; git de verdade contra um remote local: fetch,
 * reset --hard e retomada) · M-15 (`steps._started`) · M-23 (herança de orçamento / mensagem).
 *
 * Só roda com PG_TEST_URL (localhost:55432|55440|55441). Sem ele: skip.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

// PROJECT_FILES_ROOT é lido no import por githubPush.ts: define ANTES de qualquer import do app.
const FILES_ROOT = await vi.hoisted(async () => {
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-m-files-"));
  process.env.PROJECT_FILES_ROOT = d;
  return d;
});
const remote = vi.hoisted(() => ({ url: null as string | null }));

import {
  describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, childrenOf, ticketRow, queryGate, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());
vi.mock("../services/github.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getInstallationTokenForClone: async () => "test-token" }));
// Seam `remoteUrl` de gitLinkProjectFolder: o git roda DE VERDADE (init/remote/fetch/checkout/reset) contra um repositório local.
vi.mock("../services/githubPush.js", async (orig) => {
  const real = await orig<typeof import("../services/githubPush.js")>();
  return {
    ...real,
    gitLinkProjectFolder: (o: Parameters<typeof real.gitLinkProjectFolder>[0]) => real.gitLinkProjectFolder({ ...o, remoteUrl: remote.url ?? o.remoteUrl }),
  };
});

import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";
import { evolveTestHooks, SimulatedCrash } from "../services/evolveClaim.js";
import { recomputeProductLifecycle } from "../services/productLifecycle.js";

const ev = (tag: string, data: unknown) => console.log(`[N-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

describePg("Revisão M / motor do claim e consistência (Postgres real)", () => {
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
    rmSync(FILES_ROOT, { recursive: true, force: true });
  });
  afterEach(() => {
    evolveTestHooks.fault = undefined;
    evolveTestHooks.stall = undefined;
    evolveTestHooks.heartbeatMs = undefined;
    remote.url = null;
  });

  /** O seed zera PROJECT_FILES_ROOT; aqui ele volta a apontar para o diretório de teste e o `apps/` do pai é semeado. */
  const seed = async (o: Parameters<typeof seedAcceptedProduct>[1] = {}, withApps = true) => {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 50, ...o });
    seeds.push(s);
    process.env.PROJECT_FILES_ROOT = FILES_ROOT;
    if (withApps) {
      mkdirSync(join(FILES_ROOT, s.parentId, "apps", "src"), { recursive: true });
      writeFileSync(join(FILES_ROOT, s.parentId, "apps", "src", "index.js"), "console.log('v1')\n");
    }
    return s;
  };
  const evolve = (parentId: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/api/projects/${parentId}/evolve`, payload, headers });
  const expireLease = (childId: string) => pool.query(
    `UPDATE projects SET extra = jsonb_set(extra, '{materialization,lease_until}', to_jsonb(now() - interval '1 minute')) WHERE id = $1`, [childId]);
  const takeOver = (childId: string) => pool.query(
    `UPDATE projects SET extra = jsonb_set(jsonb_set(extra, '{materialization,lease_owner}', '"intruder"'::jsonb),
            '{materialization,lease_until}', to_jsonb(now() + interval '10 minutes')) WHERE id = $1`, [childId]);
  const child = async (id: string) => (await pool.query("SELECT status, extra FROM projects WHERE id = $1", [id])).rows[0] as { status: string; extra: Record<string, any> };
  const stepKeys = (extra: Record<string, any>) => Object.keys(extra.materialization?.steps ?? {}).sort();
  const live = async (parentId: string) => (await childrenOf(pool, parentId)).filter((k) => !["failed", "archived"].includes(k.status));

  // ── M-04 ───────────────────────────────────────────────────────────────────────────────
  describe("M-04 — lease pulsado durante o passo longo; perdeu o lease ⇒ aborta sem efeito destrutivo", () => {
    it("passo mais longo que o lease: o heartbeat mantém o lease e a repetição concorrente recebe 409 (não assume o passo)", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      evolveTestHooks.heartbeatMs = 100;
      let done = false;
      let during: { leaseValid: boolean; owner: string } | null = null;
      let concurrent: { statusCode: number; json(): any } | null = null;
      evolveTestHooks.stall = async (pt) => {
        if (pt !== "during:code" || done) return;
        done = true;
        const kid = (await childrenOf(pool, s.parentId))[0];
        await expireLease(kid.id); // o passo já passou do lease (simulado: o lease acabou de vencer)
        await sleep(450); // ≥ 3 pulsos de 100 ms
        const r = (await pool.query(
          "SELECT (extra->'materialization'->>'lease_until')::timestamptz > now() AS ok, extra->'materialization'->>'lease_owner' AS owner FROM projects WHERE id = $1", [kid.id])).rows[0];
        during = { leaseValid: r.ok, owner: r.owner };
        concurrent = await evolve(s.parentId, { ticketId: t.id }); // outra requisição tenta assumir no meio do passo
      };
      const r = await evolve(s.parentId, { ticketId: t.id });
      ev("m04-heartbeat", { final: r.statusCode, leaseDuranteOPasso: during, concorrente: concurrent && { status: (concurrent as any).statusCode, code: (concurrent as any).json().code } });
      expect(during).toMatchObject({ leaseValid: true });
      expect((concurrent as any).statusCode).toBe(409);
      expect((concurrent as any).json().code).toBe("MATERIALIZATION_IN_PROGRESS");
      expect(r.statusCode).toBe(201);
      expect(await live(s.parentId)).toHaveLength(1);
    });

    it("lease tomado por outro executor DURANTE o passo (heartbeat vê): não grava marcador, não finaliza, filho do outro intacto", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      evolveTestHooks.heartbeatMs = 80;
      let kidId = "";
      evolveTestHooks.stall = async (pt) => {
        if (pt !== "during:code") return;
        kidId = (await childrenOf(pool, s.parentId))[0].id;
        await takeOver(kidId);
        await sleep(400);
      };
      const r = await evolve(s.parentId, { ticketId: t.id });
      const k = await child(kidId);
      ev("m04-lease-perdido", { status: r.statusCode, code: r.json().code, filho: k.status, dono: k.extra.materialization.lease_owner, passos: stepKeys(k.extra) });
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe("MATERIALIZATION_IN_PROGRESS");
      expect(k.status).toBe("materializing");
      expect(k.extra.materialization.lease_owner).toBe("intruder");
      expect(stepKeys(k.extra)).not.toContain("code"); // marcador do passo NÃO gravado
      expect((await ticketRow(pool, t.id)).status).toBe("promoted");
    });

    it("lease tomado SEM o heartbeat ter notado: a reconfirmação ANTES do rm/cópia aborta e o diretório do outro executor não é tocado", async () => {
      const s = await seed();
      evolveTestHooks.heartbeatMs = 60_000; // heartbeat "dormindo": só a checagem estrita antes do efeito destrutivo pode salvar
      let childApps = "";
      evolveTestHooks.stall = async (pt) => {
        if (pt !== "during:code") return;
        const kid = (await childrenOf(pool, s.parentId))[0];
        childApps = join(FILES_ROOT, kid.id, "apps");
        mkdirSync(childApps, { recursive: true });
        writeFileSync(join(childApps, "trabalho-do-outro-executor.txt"), "não pode ser apagado");
        await takeOver(kid.id);
      };
      const r = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      ev("m04-ensureLease", { status: r.statusCode, code: r.json().code, arquivoDoOutroPreservado: existsSync(join(childApps, "trabalho-do-outro-executor.txt")) });
      expect(r.statusCode).toBe(409);
      expect(existsSync(join(childApps, "trabalho-do-outro-executor.txt"))).toBe(true); // rmSync NÃO rodou
      expect(existsSync(join(childApps, "src", "index.js"))).toBe(false); // cópia NÃO rodou
    });

    it("failTerminal só vale para quem ainda é o dono: terminal de executor que perdeu o lease NÃO marca o filho do outro como failed", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      const rows = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1", [s.parentId])).rows as Array<{ file_path: string }>;
      for (const x of rows) rmSync(x.file_path, { force: true }); // ⇒ TerminalFailure HEAD_SPEC_UNREADABLE no spec_tree
      evolveTestHooks.heartbeatMs = 60_000;
      let kidId = "";
      evolveTestHooks.stall = async (pt) => {
        if (pt !== "during:spec_tree") return;
        kidId = (await childrenOf(pool, s.parentId))[0].id;
        await takeOver(kidId);
      };
      const r = await evolve(s.parentId, { ticketId: t.id });
      const k = await child(kidId);
      ev("m04-failTerminal-cas", { status: r.statusCode, code: r.json().code, filho: k.status, ticket: (await ticketRow(pool, t.id)).status });
      expect(r.statusCode).toBe(409);
      expect(k.status).toBe("materializing");
      expect(k.extra.materialization.error).toBeUndefined();
      expect((await ticketRow(pool, t.id)).status).toBe("promoted"); // não reabriu o ticket do outro
    });

    it("controle: falha terminal de quem é o dono continua marcando failed e reabrindo o ticket (422)", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      const rows = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1", [s.parentId])).rows as Array<{ file_path: string }>;
      for (const x of rows) rmSync(x.file_path, { force: true });
      const r = await evolve(s.parentId, { ticketId: t.id });
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("HEAD_SPEC_UNREADABLE");
      expect((await childrenOf(pool, s.parentId))[0].status).toBe("failed");
      expect((await ticketRow(pool, t.id)).status).toBe("open");
    });
  });

  // ── M-05 ───────────────────────────────────────────────────────────────────────────────
  describe("M-05 — erro transitório lança e retoma; permanente é falha terminal; marcador só quando concluiu", () => {
    it("falha TRANSITÓRIA de disco no passo code ⇒ 500 MATERIALIZATION_FAILED, sem marcador `code`, lease liberado; repetição retoma e conclui", async () => {
      const s = await seed();
      let blocked = "";
      // o hook de fault é síncrono e não conhece o id do filho: usa o stall (async) para descobri-lo
      evolveTestHooks.stall = async (pt) => {
        if (pt !== "during:code" || blocked) return;
        const kid = (await childrenOf(pool, s.parentId))[0];
        blocked = join(FILES_ROOT, kid.id);
        writeFileSync(blocked, "arquivo no lugar do diretório");
      };
      const r1 = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      const kid = (await childrenOf(pool, s.parentId))[0];
      const k1 = await child(kid.id);
      ev("m05-transitorio", { status: r1.statusCode, code: r1.json().code, passos: stepKeys(k1.extra), filho: k1.status });
      expect(r1.statusCode).toBe(500);
      expect(r1.json().code).toBe("MATERIALIZATION_FAILED");
      expect(stepKeys(k1.extra)).not.toContain("code");
      expect(k1.status).toBe("materializing");
      // o ambiente se recupera; a repetição RETOMA (lease liberado) sem esperar vencer
      rmSync(blocked, { force: true });
      evolveTestHooks.stall = undefined;
      const r2 = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      const k2 = await child(kid.id);
      expect(r2.statusCode).toBe(200);
      expect(r2.json().resumed).toBe(true);
      expect(k2.status).toBe("spec_submitted");
      expect(k2.extra.materialization.steps.code.source).toBe("disk-copy");
      expect(existsSync(join(FILES_ROOT, kid.id, "apps", "src", "index.js"))).toBe(true);
    });

    it("anexo de texto ilegível (ATTACHMENTS_STRICT=on) é PERMANENTE ⇒ 422 ATTACHMENT_UNREADABLE, filho failed, ticket volta a open", async () => {
      vi.stubEnv("ATTACHMENTS_STRICT", "on");
      try {
        const s = await seed();
        const t = await seedTicket(pool, s, { attachments: [{ filename: "notas.txt", content: Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x81]), mime: "text/plain" }] });
        const r = await evolve(s.parentId, { ticketId: t.id });
        const kid = (await childrenOf(pool, s.parentId))[0];
        ev("m05-permanente", { status: r.statusCode, code: r.json().code, filho: kid.status, ticket: (await ticketRow(pool, t.id)).status });
        expect(r.statusCode).toBe(422);
        expect(r.json().code).toBe("ATTACHMENT_UNREADABLE");
        expect(kid.status).toBe("failed");
        expect(stepKeys(kid.extra)).not.toContain("ticket");
        expect((await ticketRow(pool, t.id)).status).toBe("open");
      } finally {
        vi.unstubAllEnvs();
        vi.stubEnv("EVOLVE_CLAIM", "on");
      }
    });
  });

  // ── M-06 / M-21 ────────────────────────────────────────────────────────────────────────
  describe("M-06 / M-21 — lifecycle do produto", () => {
    const lifecycleOf = async (productId: string) => (await pool.query("SELECT lifecycle_status FROM products WHERE id = $1", [productId])).rows[0].lifecycle_status as string;
    const mkEvo = (s: Seed, o: { status: string; version?: number; parent?: string }) => pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra)
       VALUES ($1,$2,'evo',$3,$4,$5,$6,'{"evolution":true}'::jsonb) RETURNING id`,
      [s.tenantId, s.userId, o.status, s.productId, o.parent ?? s.parentId, o.version ?? 2]);

    it("tentativa failed SUPERADA (irmão vivo no mesmo pai/versão) não derruba o produto; failed SEM retry ainda conta", async () => {
      const s = await seed({}, false);
      await mkEvo(s, { status: "failed", version: 2 });
      expect(await recomputeProductLifecycle(pool, s.productId)).toBe("failed"); // sem retry: continua falha
      await mkEvo(s, { status: "accepted", version: 2 }); // o retry (mesmo número) foi aceito
      const lc = await recomputeProductLifecycle(pool, s.productId);
      ev("m06-superada", { lifecycle: lc });
      expect(lc).toBe("accepted");
    });

    it("`materializing` conta como em andamento: accepted + materializing ⇒ partially_accepted (e não `running` por acaso)", async () => {
      const s = await seed({}, false);
      await mkEvo(s, { status: "materializing", version: 2 });
      expect(await recomputeProductLifecycle(pool, s.productId)).toBe("partially_accepted");
    });

    it("failTerminal recomputa o produto: sem filho vivo, o `materializing` some do agregado (failed, não partially_accepted)", async () => {
      const s = await seed();
      const rows = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1", [s.parentId])).rows as Array<{ file_path: string }>;
      for (const x of rows) rmSync(x.file_path, { force: true });
      const r = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      expect(r.statusCode).toBe(422);
      expect(await lifecycleOf(s.productId)).toBe("failed");
    });

    it("M-21 — replay de filho finalizado há pouco recomputa o lifecycle (crash entre o COMMIT do finalize e o recompute)", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      expect((await evolve(s.parentId, { ticketId: t.id })).statusCode).toBe(201);
      await pool.query("UPDATE products SET lifecycle_status = 'accepted' WHERE id = $1", [s.productId]); // estado velho, como após o crash
      const again = await evolve(s.parentId, { ticketId: t.id });
      ev("m21-replay", { status: again.statusCode, replayed: again.json().replayed, lifecycle: await lifecycleOf(s.productId) });
      expect(again.statusCode).toBe(200);
      expect(again.json().replayed).toBe(true);
      expect(await lifecycleOf(s.productId)).toBe("partially_accepted");
    });
  });

  // ── M-11 ───────────────────────────────────────────────────────────────────────────────
  describe("M-11 — pedido recusado durante a materialização nunca vira filho", () => {
    it("promoted→rejected no meio do passo: o finalize falha com TICKET_REJECTED (422), filho failed, ticket segue rejected", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      evolveTestHooks.stall = async (pt) => {
        if (pt !== "during:code") return;
        await pool.query("UPDATE tickets SET status = 'rejected', updated_at = now() WHERE id = $1", [t.id]);
      };
      const r = await evolve(s.parentId, { ticketId: t.id });
      const kid = (await childrenOf(pool, s.parentId))[0];
      ev("m11-finalize", { status: r.statusCode, code: r.json().code, filho: kid.status, ticket: (await ticketRow(pool, t.id)).status });
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("TICKET_REJECTED");
      expect(kid.status).toBe("failed");
      expect((await ticketRow(pool, t.id)).status).toBe("rejected"); // a decisão humana não é desfeita
    });

    it("crash, pedido recusado, lease vencido: a repetição NÃO retoma o filho (TICKET_REJECTED logo no início)", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s);
      evolveTestHooks.fault = (p) => { if (p === "after_claim") throw new SimulatedCrash(p); };
      expect((await evolve(s.parentId, { ticketId: t.id })).statusCode).toBe(500);
      evolveTestHooks.fault = undefined;
      const kid = (await childrenOf(pool, s.parentId))[0];
      await pool.query("UPDATE tickets SET status = 'rejected' WHERE id = $1", [t.id]);
      await expireLease(kid.id);
      const r = await evolve(s.parentId, { ticketId: t.id });
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("TICKET_REJECTED");
      expect((await child(kid.id)).status).toBe("failed");
      expect(stepKeys((await child(kid.id)).extra)).toEqual([]); // nenhum passo rodou
    });
  });

  // ── M-23 ───────────────────────────────────────────────────────────────────────────────
  describe("M-23 — linhagem mista (HEAD sem orçamento)", () => {
    it("HEAD legado sem orçamento mas a raiz tem: herda o dono do avô e o claim segue (201)", async () => {
      const s = await seed({ budgetUsd: 50 }, false);
      const v2 = (await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra)
         VALUES ($1,$2,'v2 legado','accepted',$3,$4,2,'{"evolution":true}'::jsonb) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId])).rows[0].id as string;
      const r = await evolve(v2, { request: "Adicionar exportação CSV" });
      const kid = (await childrenOf(pool, v2))[0];
      ev("m23-herda", { status: r.statusCode, dono: kid?.budget_owner_project_id === s.parentId ? "raiz" : kid?.budget_owner_project_id });
      expect(r.statusCode).toBe(201);
      expect(kid.budget_owner_project_id).toBe(s.parentId);
    });

    it("nenhum orçamento na cadeia ⇒ 402 BUDGET_MISSING com mensagem que orienta definir o orçamento da versão corrente", async () => {
      const s = await seed({ budgetUsd: null }, false);
      const v2 = (await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra)
         VALUES ($1,$2,'v2 legado','accepted',$3,$4,2,'{"evolution":true}'::jsonb) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId])).rows[0].id as string;
      const r = await evolve(v2, { request: "Adicionar exportação CSV" });
      expect(r.statusCode).toBe(402);
      expect(r.json().code).toBe("BUDGET_MISSING");
      expect(r.json().message).toMatch(/linhagem mista/);
      expect(r.json().message).toMatch(/Defina o orçamento/);
      expect(await childrenOf(pool, v2)).toHaveLength(0);
    });
  });

  // ── M-12 / M-15 : crash em cada ponto, agora COM disco e apps/ ─────────────────────────────
  describe("M-12 — laço dos pontos de crash com PROJECT_FILES_ROOT e apps/ semeado (o passo code deixa de ser no-op)", () => {
    const STEPS = ["spec_tree", "code", "ticket", "triages", "dialogue"];
    const POINTS = ["after_claim", ...STEPS.flatMap((st) => [`before:${st}`, `after_work:${st}`, `after_mark:${st}`]), "before_finalize", "after_finalize"];
    for (const point of POINTS) {
      it(`crash em ${point}: retoma e termina com 1 filho íntegro, apps/ copiado (disk-copy) e steps._started`, async () => {
        const s = await seed();
        const t = await seedTicket(pool, s);
        let fired = false;
        evolveTestHooks.fault = (p) => { if (p === point && !fired) { fired = true; throw new SimulatedCrash(p); } };
        const crashed = await evolve(s.parentId, { ticketId: t.id });
        evolveTestHooks.fault = undefined;
        expect(crashed.statusCode).toBe(500);
        const kid = (await childrenOf(pool, s.parentId))[0];
        if (point !== "after_finalize") await expireLease(kid.id);
        const resumed = await evolve(s.parentId, { ticketId: t.id });
        expect(resumed.statusCode).toBe(200);
        const k = await child(kid.id);
        expect(k.status).toBe("spec_submitted");
        expect(stepKeys(k.extra)).toEqual([...STEPS, "_started"].sort());
        expect(k.extra.materialization.steps.code.source).toBe("disk-copy");
        expect(k.extra.evolution_source).toBe("disk-copy");
        expect(readFileSync(join(FILES_ROOT, kid.id, "apps", "src", "index.js"), "utf8")).toBe("console.log('v1')\n");
        expect(await live(s.parentId)).toHaveLength(1);
      });
    }

    it("M-15 — crash antes do primeiro passo: `steps` vazio (sem `_started`); crash dentro do passo: `_started` já gravado antes do efeito em disco", async () => {
      const a = await seed();
      evolveTestHooks.fault = (p) => { if (p === "after_claim") throw new SimulatedCrash(p); };
      await evolve(a.parentId, { request: "Adicionar exportação CSV" });
      evolveTestHooks.fault = undefined;
      const ka = (await childrenOf(pool, a.parentId))[0];
      expect(stepKeys(ka.extra)).toEqual([]);
      const b = await seed();
      evolveTestHooks.fault = (p) => { if (p === "before:spec_tree") throw new SimulatedCrash(p); };
      await evolve(b.parentId, { request: "Adicionar exportação CSV" });
      evolveTestHooks.fault = undefined;
      const kb = (await childrenOf(pool, b.parentId))[0];
      ev("m15-started", { semPassos: stepKeys(ka.extra), antesDoEfeito: stepKeys(kb.extra) });
      expect(stepKeys(kb.extra)).toEqual(["_started"]);
    });
  });

  // ── M-12 : git de verdade contra um remote local (fetch / reset --hard / retomada) ──────────
  describe("M-12 — passo code com git real (remote local via seam remoteUrl)", () => {
    const mkRemote = (name: string) => {
      const dir = join(FILES_ROOT, `remote-${name}`);
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "-b", "dev");
      git(dir, "config", "user.email", "t@x.test");
      git(dir, "config", "user.name", "t");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "README.md"), "# app v1\n");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "app.js"), "export const v = 1;\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "v1");
      return dir;
    };
    const linkRepo = async (s: Seed) => {
      await pool.query(`INSERT INTO tenant_github_installations (tenant_id, installation_id, github_login) VALUES ($1, 4242, 'acme') ON CONFLICT (tenant_id) DO NOTHING`, [s.tenantId]);
      await pool.query(`INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url) VALUES ($1,'app','acme/app','https://github.com/acme/app','https://github.com/acme/app.git')`, [s.parentId]);
    };

    it("clone real: fetch + checkout -B + reset --hard; crash DEPOIS do trabalho (resíduo e edição local) ⇒ a retomada refaz o reset e converge", async () => {
      const s = await seed({}, false);
      await linkRepo(s);
      remote.url = `file://${mkRemote("a")}`;
      let fired = false;
      evolveTestHooks.fault = (p) => { if (p === "after_work:code" && !fired) { fired = true; throw new SimulatedCrash(p); } };
      const crashed = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      evolveTestHooks.fault = undefined;
      expect(crashed.statusCode).toBe(500);
      const kid = (await childrenOf(pool, s.parentId))[0];
      const apps = join(FILES_ROOT, kid.id, "apps");
      expect(readFileSync(join(apps, "src", "app.js"), "utf8")).toBe("export const v = 1;\n");
      expect(git(apps, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("evolution/v2");
      // o processo "morreu" com o trabalho feito; alguém mexeu na árvore antes da retomada
      writeFileSync(join(apps, "src", "app.js"), "export const v = 999; // edição que a retomada deve descartar\n");
      await expireLease(kid.id);
      const resumed = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      const k = await child(kid.id);
      ev("m12-git-retomada", { status: resumed.statusCode, fonte: k.extra.materialization.steps.code.source, appJs: readFileSync(join(apps, "src", "app.js"), "utf8").trim(), branch: git(apps, "rev-parse", "--abbrev-ref", "HEAD").trim() });
      expect(resumed.statusCode).toBe(200);
      expect(k.extra.materialization.steps.code.source).toBe("git-clone");
      expect(readFileSync(join(apps, "src", "app.js"), "utf8")).toBe("export const v = 1;\n"); // reset --hard na retomada
      expect(git(apps, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("evolution/v2");
      expect(git(apps, "remote", "get-url", "origin").trim()).toMatch(/^file:\/\//); // remote sem token
      expect(k.status).toBe("spec_submitted");
    });

    it("falha TRANSITÓRIA do git (remote inalcançável) ⇒ 500, sem marcador `code`; remote volta ⇒ a repetição retoma com git-clone", async () => {
      const s = await seed({}, false);
      await linkRepo(s);
      const good = `file://${mkRemote("b")}`;
      remote.url = "http://127.0.0.1:9/inalcancavel.git"; // conexão recusada: transitório
      const r1 = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      const kid = (await childrenOf(pool, s.parentId))[0];
      const k1 = await child(kid.id);
      ev("m12-git-transitorio", { status: r1.statusCode, code: r1.json().code, passos: stepKeys(k1.extra) });
      expect(r1.statusCode).toBe(500);
      expect(r1.json().code).toBe("MATERIALIZATION_FAILED");
      expect(JSON.stringify(r1.json())).not.toMatch(/Basic |x-access-token|test-token/);
      expect(stepKeys(k1.extra)).not.toContain("code");
      remote.url = good;
      const r2 = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      expect(r2.statusCode).toBe(200);
      expect((await child(kid.id)).extra.materialization.steps.code.source).toBe("git-clone");
    });

    it("falha PERMANENTE do git (repositório inexistente) e SEM cópia no disco ⇒ 422 CODE_BASE_UNAVAILABLE, filho failed, ticket reaberto", async () => {
      const s = await seed({}, false); // sem apps/ no pai
      await linkRepo(s);
      const t = await seedTicket(pool, s);
      remote.url = `file://${join(FILES_ROOT, "remote-nao-existe")}`;
      const r = await evolve(s.parentId, { ticketId: t.id });
      ev("m12-git-permanente", { status: r.statusCode, code: r.json().code });
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("CODE_BASE_UNAVAILABLE");
      expect((await childrenOf(pool, s.parentId))[0].status).toBe("failed");
      expect((await ticketRow(pool, t.id)).status).toBe("open");
    });

    it("falha PERMANENTE do git COM cópia no disco ⇒ cai no disk-copy e registra o erro (comportamento histórico preservado)", async () => {
      const s = await seed({}, true);
      await linkRepo(s);
      remote.url = `file://${join(FILES_ROOT, "remote-nao-existe-2")}`;
      const r = await evolve(s.parentId, { request: "Adicionar exportação CSV" });
      expect(r.statusCode).toBe(201);
      expect(r.json().evolutionSource).toBe("disk-copy");
      expect(r.json().evolutionSourceError).toBeTruthy();
    });
  });

  // ── M-07 : caminho legado (EVOLVE_CLAIM=off) com TICKET_TRANSITIONS=on ─────────────────────
  describe("M-07 — /evolve legado (EVOLVE_CLAIM=off) com TICKET_TRANSITIONS=on: promoção com CAS e evento", () => {
    const legacy = async (fn: () => Promise<void>) => {
      vi.stubEnv("EVOLVE_CLAIM", "off");
      vi.stubEnv("TICKET_TRANSITIONS", "on");
      try { await fn(); } finally { vi.unstubAllEnvs(); vi.stubEnv("EVOLVE_CLAIM", "on"); }
    };
    const eventsOf = async (ticketId: string) => (await pool.query(
      "SELECT from_status, to_status, actor_kind, reason FROM ticket_events WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows;

    it("promove e grava o evento open→promoted (reason evolve_legacy)", async () => {
      await legacy(async () => {
        const s = await seed();
        const t = await seedTicket(pool, s);
        const r = await evolve(s.parentId, { ticketId: t.id });
        expect(r.statusCode).toBe(201);
        expect((await ticketRow(pool, t.id)).status).toBe("promoted");
        expect(await eventsOf(t.id)).toEqual([{ from_status: "open", to_status: "promoted", actor_kind: "system", reason: "evolve_legacy" }]);
      });
    });

    it("pedido recusado entre a leitura e a promoção: o CAS impede rejected→promoted (sem evento; o filho registra o conflito)", async () => {
      await legacy(async () => {
        const s = await seed();
        const t = await seedTicket(pool, s);
        const gate = queryGate(pool, /UPDATE tickets SET status = 'promoted'/, { mode: "hold-before", arrivals: 1 });
        const racing = evolve(s.parentId, { ticketId: t.id });
        await gate.reached;
        await pool.query("UPDATE tickets SET status = 'rejected' WHERE id = $1", [t.id]);
        gate.release();
        const r = await racing;
        gate.uninstall();
        const kid = (await childrenOf(pool, s.parentId))[0];
        ev("m07-legado-cas", { status: r.statusCode, ticket: (await ticketRow(pool, t.id)).status, eventos: (await eventsOf(t.id)).length, conflito: kid.extra.ticket_promotion_conflict });
        expect((await ticketRow(pool, t.id)).status).toBe("rejected"); // antes: virava 'promoted'
        expect(await eventsOf(t.id)).toEqual([]);
        expect(kid.extra.ticket_promotion_conflict).toBe(true);
      });
    });

    it("com TICKET_TRANSITIONS=off o UPDATE legado segue idêntico ao histórico (sem CAS, sem evento)", async () => {
      vi.stubEnv("EVOLVE_CLAIM", "off");
      try {
        const s = await seed();
        const t = await seedTicket(pool, s);
        expect((await evolve(s.parentId, { ticketId: t.id })).statusCode).toBe(201);
        expect((await ticketRow(pool, t.id)).status).toBe("promoted");
        expect(await eventsOf(t.id)).toEqual([]);
      } finally { vi.unstubAllEnvs(); vi.stubEnv("EVOLVE_CLAIM", "on"); }
    });
  });
});
