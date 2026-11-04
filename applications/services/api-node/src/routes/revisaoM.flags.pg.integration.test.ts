/**
 * Revisão adversarial M (correções O) em Postgres REAL, banco DESCARTÁVEL (CREATE DATABASE + migrations 1→N):
 * M-03 (flags por tenant, api e runner), R2 (adminOnly), M-14 (download), M-16 (conteúdo ativo), M-17 (teto do multipart),
 * M-19 (rotas novas ⇒ 404 com a flag off) e a migration 147 (saneamento de segredos). Só com PG_TEST_URL.
 * Banco próprio porque grava linhas GLOBAIS de genesis_runtime_config (afetariam outras suítes em paralelo).
 */
import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, type Seed,
} from "../testing/evolvePg.js";
import { cleanDocx, macroDocx } from "../testing/zipFixture.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";
import { productRoutes } from "./products.js";
import { projectFlagsRoutes } from "./projectFlags.js";
import { runtimeConfigRoutes } from "./runtimeConfig.js";
import { evolveReconcilerRoutes } from "./evolveReconciler.js";

const ev = (tag: string, data: unknown) => console.log(`[O-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);
const BOUNDARY = "----oattach";
function multipart(files: Array<{ filename: string; content: Buffer; mime?: string }>) {
  const chunks: Buffer[] = [Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="body"\r\n\r\nQuero exportar em CSV.\r\n`)];
  for (const f of files) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: ${f.mime ?? "application/octet-stream"}\r\n\r\n`));
    chunks.push(f.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}
const MD = Buffer.from("# Regras\n\nO CSV usa ponto e vírgula.\n", "utf-8");
const PDF_OK = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n", "latin1");
const PDF_JS = Buffer.from("%PDF-1.4\n1 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj\n%%EOF\n", "latin1");

describePg("Revisão M / correções O — flags por tenant, anexos e segredos (banco descartável)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const ENVS = ["ATTACHMENTS_STRICT", "TASK_INHERIT_TRANSITIVE", "EVOLVE_RECONCILER"] as const;

  beforeAll(async () => {
    scratch = await createScratchDb("evo_o");
    pool = scratch.pool;
    pool.on("error", () => undefined);
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([projectRoutes, ticketRoutes, productRoutes, projectFlagsRoutes, runtimeConfigRoutes, evolveReconcilerRoutes]);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    for (const s of seeds) s.cleanup();
    await scratch?.drop();
  });
  afterEach(async () => {
    for (const k of ENVS) delete process.env[k];
    await pool.query("DELETE FROM genesis_runtime_config WHERE key = ANY($1)", [[...ENVS, "AGENT_TIMEOUT_PM"]]);
    testUser.role = "tenant_admin";
  });

  const seed = async () => { const s = await seedAcceptedProduct(pool); seeds.push(s); testUser.id = s.userId; testUser.tenantId = s.tenantId; return s; };
  const as = (s: Seed, role = "tenant_admin") => { testUser.id = s.userId; testUser.tenantId = s.tenantId; testUser.role = role; };
  const setRow = (key: string, value: string, tenantId: string | null) => pool.query(
    `INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ($1,$2,$3)
     ON CONFLICT (key, tenant_id) DO UPDATE SET value = EXCLUDED.value`, [key, value, tenantId]);
  const flagsOf = async (s: Seed) => { as(s); return (await app.inject({ method: "GET", url: `/api/projects/${s.parentId}/effective-flags` })).json() as
    { attachmentsStrict: boolean; taskInheritTransitive: boolean; sources: { attachmentsStrict: string; taskInheritTransitive: string } }; };
  const post = (s: Seed, files: Array<{ filename: string; content: Buffer; mime?: string }>) => { as(s); return app.inject({
    method: "POST", url: `/api/products/${s.productId}/tickets`,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` }, payload: multipart(files) }); };

  // ── M-03: precedência, api e runner veem o mesmo valor ────────────────────────────────────────
  it("M-03: tenant explícito > global > env (default) > off — e o contrato do runner reflete o tenant do projeto", async () => {
    const A = await seed(); const B = await seed();
    const trace: unknown[] = [];
    const snap = async (label: string) => { const [a, b] = [await flagsOf(A), await flagsOf(B)]; trace.push({ label, A: [a.attachmentsStrict, a.sources.attachmentsStrict], B: [b.attachmentsStrict, b.sources.attachmentsStrict] }); return { a, b }; };

    let r = await snap("nada");
    expect([r.a.attachmentsStrict, r.b.attachmentsStrict, r.a.sources.attachmentsStrict]).toEqual([false, false, "default"]);

    process.env.ATTACHMENTS_STRICT = "on";
    r = await snap("env=on");
    expect([r.a.attachmentsStrict, r.b.attachmentsStrict, r.a.sources.attachmentsStrict]).toEqual([true, true, "env"]);

    await setRow("ATTACHMENTS_STRICT", "0", null);
    r = await snap("env=on + global=0");
    expect([r.a.attachmentsStrict, r.b.attachmentsStrict, r.a.sources.attachmentsStrict]).toEqual([false, false, "global"]); // o env NÃO sobrepõe o global

    await setRow("ATTACHMENTS_STRICT", "1", A.tenantId);
    r = await snap("env=on + global=0 + A=1");
    expect([r.a.attachmentsStrict, r.b.attachmentsStrict, r.a.sources.attachmentsStrict]).toEqual([true, false, "tenant"]);

    process.env.ATTACHMENTS_STRICT = "off";
    await setRow("ATTACHMENTS_STRICT", "0", null);
    await setRow("TASK_INHERIT_TRANSITIVE", "1", B.tenantId);
    r = await snap("env=off + A=1 + B(task)=1");
    expect(r.a.attachmentsStrict).toBe(true);               // tenant 1 vence env off
    expect((await flagsOf(B)).taskInheritTransitive).toBe(true);
    expect((await flagsOf(A)).taskInheritTransitive).toBe(false);
    ev("M03-precedencia", trace);
  });

  it("M-03: a MESMA flag efetiva governa a api (spec-files / ticket-attachments) e o contrato do runner — sem divergência", async () => {
    const A = await seed(); const B = await seed();
    const child = async (s: Seed) => {
      const c = (await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number)
         VALUES ($1,$2,'filho','spec_submitted',$3,$4,2) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId])).rows[0].id as string;
      await pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary) VALUES ($1,'old.png','/x','image/png','tickets/TK-0001/anexos',false)`, [c]);
      return c;
    };
    const cA = await child(A), cB = await child(B);
    await setRow("ATTACHMENTS_STRICT", "1", A.tenantId);
    as(A);
    const listA = (await app.inject({ method: "GET", url: `/api/projects/${cA}/spec-files` })).json() as Array<{ filename: string }>;
    as(B);
    const listB = (await app.inject({ method: "GET", url: `/api/projects/${cB}/spec-files` })).json() as Array<{ filename: string }>;
    expect(listA.map((f) => f.filename)).not.toContain("old.png");   // A estrito: png legado filtrado
    expect(listB.map((f) => f.filename)).toContain("old.png");       // B off: formato anterior
    expect((await flagsOf(A)).attachmentsStrict).toBe(true);          // e o runner recebe exatamente isso
    expect((await flagsOf(B)).attachmentsStrict).toBe(false);
    // outro tenant não lê as flags do projeto alheio
    as(B);
    expect((await app.inject({ method: "GET", url: `/api/projects/${cA}/effective-flags` })).statusCode).toBe(404);
  });

  it("M-03: as flags já por tenant (EVOLVE_CLAIM/TICKET_TRANSITIONS/EVOLUTION_PROMOTE_BANCADA) também respeitam o tenant sobre o env", async () => {
    const A = await seed();
    const { evolveClaimEnabled } = await import("../services/evolveFlags.js");
    const { ticketTransitionsEnabled } = await import("../services/ticketTransitions.js");
    const { evolutionPromoteEnabled } = await import("../services/evolutionPromote.js");
    process.env.EVOLVE_CLAIM = "on"; process.env.TICKET_TRANSITIONS = "on"; process.env.EVOLUTION_PROMOTE_BANCADA = "on";
    try {
      for (const k of ["EVOLVE_CLAIM", "TICKET_TRANSITIONS", "EVOLUTION_PROMOTE_BANCADA"]) await setRow(k, "0", A.tenantId);
      expect(await evolveClaimEnabled(pool, { parentProjectId: A.parentId })).toBe(false);
      expect(await ticketTransitionsEnabled(pool, { tenantId: A.tenantId })).toBe(false);
      expect(await evolutionPromoteEnabled(pool, { projectId: A.parentId })).toBe(false);
      await pool.query("DELETE FROM genesis_runtime_config WHERE tenant_id = $1", [A.tenantId]);
      expect(await evolveClaimEnabled(pool, { parentProjectId: A.parentId })).toBe(true); // sem linha: env liga (default de plataforma)
    } finally {
      delete process.env.EVOLVE_CLAIM; delete process.env.TICKET_TRANSITIONS; delete process.env.EVOLUTION_PROMOTE_BANCADA;
      await pool.query("DELETE FROM genesis_runtime_config WHERE key = ANY($1)", [["EVOLVE_CLAIM", "TICKET_TRANSITIONS", "EVOLUTION_PROMOTE_BANCADA"]]);
    }
  });

  // ── R2: só zentriz_admin grava as flags ────────────────────────────────────────────────────────
  it("R2: tenant_admin NÃO liga/desliga flag de rollout (PUT/DELETE ⇒ 403); zentriz_admin sim; chave comum segue liberada", async () => {
    const A = await seed();
    as(A, "tenant_admin");
    const put = (key: string, value: unknown, extra: Record<string, unknown> = {}) => app.inject({ method: "PUT", url: `/api/admin/runtime-config/${key}`, payload: { value, ...extra } });
    for (const k of ["ATTACHMENTS_STRICT", "TASK_INHERIT_TRANSITIVE", "EVOLVE_RECONCILER", "EVOLVE_CLAIM", "TICKET_TRANSITIONS", "EVOLUTION_PROMOTE_BANCADA"]) {
      const r = await put(k, 1);
      expect(r.statusCode, k).toBe(403);
      expect(r.json().code).toBe("ADMIN_ONLY_KEY");
    }
    expect((await pool.query("SELECT count(*)::int n FROM genesis_runtime_config WHERE key='ATTACHMENTS_STRICT'")).rows[0].n).toBe(0);
    // DELETE do override que o zentriz_admin criou também é bloqueado ao tenant_admin
    as(A, "zentriz_admin"); testUser.tenantId = null;
    expect((await put("ATTACHMENTS_STRICT", 1, { tenantId: A.tenantId })).statusCode).toBe(200);
    expect((await put("ATTACHMENTS_STRICT", 2, { tenantId: A.tenantId })).statusCode).toBe(400);   // faixa 0..1
    expect((await put("EVOLVE_RECONCILER", 2)).statusCode).toBe(200);                              // tri-estado 0..2, global
    as(A, "tenant_admin");
    expect((await app.inject({ method: "DELETE", url: "/api/admin/runtime-config/ATTACHMENTS_STRICT" })).statusCode).toBe(403);
    expect((await pool.query("SELECT value FROM genesis_runtime_config WHERE key='ATTACHMENTS_STRICT' AND tenant_id=$1", [A.tenantId])).rows[0].value).toBe("1");
    // chave comum continua editável pelo tenant_admin (sem regressão)
    expect((await put("AGENT_TIMEOUT_PM", 600)).statusCode).toBe(200);
    // a listagem avisa a UI
    const list = (await app.inject({ method: "GET", url: "/api/admin/runtime-config" })).json() as Array<{ key: string; adminOnly: boolean }>;
    expect(list.find((c) => c.key === "ATTACHMENTS_STRICT")?.adminOnly).toBe(true);
    expect(list.find((c) => c.key === "AGENT_TIMEOUT_PM")?.adminOnly).toBe(false);
  });

  // ── M-19: rotas novas com a flag off ⇒ 404 ─────────────────────────────────────────────────────
  it("M-19: GET ticket-attachments e GET evolve-reconciler/findings ⇒ 404 com a flag off; autorização continua valendo", async () => {
    const A = await seed(); const B = await seed();
    const child = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number)
       VALUES ($1,$2,'filho','spec_submitted',$3,$4,2) RETURNING id`, [A.tenantId, A.userId, A.productId, A.parentId])).rows[0].id as string;
    as(A);
    expect((await app.inject({ method: "GET", url: `/api/projects/${child}/ticket-attachments` })).statusCode).toBe(404); // off
    await setRow("ATTACHMENTS_STRICT", "1", A.tenantId);
    expect((await app.inject({ method: "GET", url: `/api/projects/${child}/ticket-attachments` })).statusCode).toBe(200);  // on
    as(B);
    expect((await app.inject({ method: "GET", url: `/api/projects/${child}/ticket-attachments` })).statusCode).toBe(404);  // outro tenant: segue negado

    as(A, "tenant_admin");
    expect((await app.inject({ method: "GET", url: "/api/admin/evolve-reconciler/findings" })).statusCode).toBe(403);      // autorização primeiro
    as(A, "zentriz_admin");
    expect((await app.inject({ method: "GET", url: "/api/admin/evolve-reconciler/findings" })).statusCode).toBe(404);      // off
    await setRow("EVOLVE_RECONCILER", "1", null);
    const on = await app.inject({ method: "GET", url: "/api/admin/evolve-reconciler/findings" });
    expect(on.statusCode).toBe(200);
    expect(on.json().mode).toBe("shadow");
  });

  // ── M-14: download ─────────────────────────────────────────────────────────────────────────────
  it("M-14: Content-Type pela extensão (cliente disse text/html), nosniff e nome fora de Latin-1 sem 500", async () => {
    const A = await seed(); as(A);
    const t = await seedTicket(pool, A, { attachments: [
      { filename: "relatório 😀 日本.txt", content: Buffer.from("<script>alert(1)</script>"), mime: "text/html" },
      { filename: "foto.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: "image/svg+xml" },
    ] });
    const rows = (await pool.query("SELECT id, filename FROM ticket_attachments WHERE ticket_id=$1 ORDER BY filename", [t.id])).rows as Array<{ id: string; filename: string }>;
    const get = (id: string) => app.inject({ method: "GET", url: `/api/tickets/${t.id}/attachments/${id}` });
    const txt = await get(rows.find((r) => r.filename.endsWith(".txt"))!.id);
    expect(txt.statusCode).toBe(200);
    expect(txt.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(txt.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(txt.headers["content-disposition"])).toContain("filename*=UTF-8''relat%C3%B3rio%20%F0%9F%98%80%20%E6%97%A5%E6%9C%AC.txt");
    expect(String(txt.headers["content-disposition"])).toMatch(/^attachment; filename="[\x20-\x7e]+"/);
    const png = await get(rows.find((r) => r.filename === "foto.png")!.id);
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("application/octet-stream");
    ev("M14", { txt: { ct: txt.headers["content-type"], nosniff: txt.headers["x-content-type-options"], cd: txt.headers["content-disposition"] }, png: png.headers["content-type"] });
  });

  // ── M-16: conteúdo ativo no upload ─────────────────────────────────────────────────────────────
  it("M-16: .docm renomeado e PDF com /JavaScript recusados no upload (400 ATTACHMENT_ACTIVE_CONTENT); limpos passam", async () => {
    const A = await seed(); await setRow("ATTACHMENTS_STRICT", "1", A.tenantId);
    const bad = await post(A, [{ filename: "macro.docx", content: macroDocx() }, { filename: "js.pdf", content: PDF_JS }, { filename: "ok.md", content: MD }]);
    expect(bad.statusCode).toBe(400);
    expect((bad.json().errors as Array<{ code: string; filename: string }>).map((e) => `${e.filename}:${e.code}`)).toEqual(["macro.docx:ATTACHMENT_ACTIVE_CONTENT", "js.pdf:ATTACHMENT_ACTIVE_CONTENT"]);
    expect((await pool.query("SELECT count(*)::int n FROM tickets WHERE product_id=$1", [A.productId])).rows[0].n).toBe(0);
    const ok = await post(A, [{ filename: "limpo.docx", content: cleanDocx() }, { filename: "limpo.pdf", content: PDF_OK }]);
    expect(ok.statusCode).toBe(201);
  });

  // ── M-17: teto do multipart ─────────────────────────────────────────────────────────────────────
  it("M-17: estouro do teto (arquivo > 10 MiB; > 10 arquivos) responde a lista da 1.5 com a flag on; off mantém o erro histórico", async () => {
    const A = await seed(); await setRow("ATTACHMENTS_STRICT", "1", A.tenantId);
    const big = await post(A, [{ filename: "grande.md", content: Buffer.alloc(10 * 1024 * 1024 + 1024, 0x61) }]);
    expect(big.statusCode).toBe(400);
    expect(big.json().code).toBe("ATTACHMENT_INVALID");
    expect((big.json().errors as Array<{ code: string }>)[0].code).toBe("ATTACHMENT_TOO_LARGE");
    const many = await post(A, Array.from({ length: 11 }, (_, i) => ({ filename: `n${i}.md`, content: MD })));
    expect(many.statusCode).toBe(400);
    expect((many.json().errors as Array<{ code: string }>)[0].code).toBe("ATTACHMENT_TOO_MANY");
    ev("M17", { big: [big.statusCode, big.json().errors[0].code], many: [many.statusCode, many.json().errors[0].code] });
    // flag off no tenant ⇒ comportamento histórico (erro do multipart, não o formato da 1.5)
    const B = await seed();
    const off = await post(B, [{ filename: "grande.md", content: Buffer.alloc(10 * 1024 * 1024 + 1024, 0x61) }]);
    expect(off.statusCode).not.toBe(201);
    expect(off.json().code).not.toBe("ATTACHMENT_INVALID");
    // as faixas de configuração terminam no teto do multipart
    as(A, "zentriz_admin"); testUser.tenantId = null;
    const put = (k: string, v: number) => app.inject({ method: "PUT", url: `/api/admin/runtime-config/${k}`, payload: { value: v } });
    expect((await put("ATTACHMENT_MAX_FILES", 11)).statusCode).toBe(400);
    expect((await put("ATTACHMENT_MAX_FILE_BYTES", 10 * 1024 * 1024 + 1)).statusCode).toBe(400);
    expect((await put("ATTACHMENT_MAX_FILES", 10)).statusCode).toBe(200);
    await pool.query("UPDATE genesis_runtime_config SET value='10' WHERE key='ATTACHMENT_MAX_FILES' AND tenant_id IS NULL");
  }, 60_000);

  // ── M-01: saneamento único (migration 147) ─────────────────────────────────────────────────────
  it("M-01: a migration 147 mascara o Authorization gravado em projects.extra e project_dialogue, é idempotente e mantém o JSON válido", async () => {
    const A = await seed();
    const b64 = Buffer.from("x-access-token:ghs_FAKEFAKEFAKEFAKEFAKE0123456789").toString("base64");
    const leaked = `Command failed: git -C /x -c http.extraheader=Authorization: Basic ${b64} fetch --depth=1 -q origin dev`;
    await pool.query("UPDATE projects SET extra = $2::jsonb WHERE id = $1", [A.parentId, JSON.stringify({
      evolution_source_error: leaked, materialization: { steps: { code: { error: leaked } } }, keep: "intacto" })]);
    await pool.query(`INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1,'system','system','step',$2)`, [A.parentId, `Falha: ${leaked}`]);
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../db/migrations/147_redact_git_secrets_in_extra.sql"), "utf-8");
    for (let i = 0; i < 2; i++) await pool.query(sql);   // 2ª execução = idempotente
    const row = (await pool.query("SELECT extra::text AS t, extra FROM projects WHERE id=$1", [A.parentId])).rows[0];
    expect(row.t).not.toContain(b64);
    expect(row.t).not.toMatch(/Basic [A-Za-z0-9+/=]{16,}/);
    expect(row.extra.keep).toBe("intacto");
    expect(row.extra.evolution_source_error).toContain("Authorization: Basic [REDACTED]");
    expect(row.extra.materialization.steps.code.error).toContain("Basic [REDACTED]");
    const d = (await pool.query("SELECT summary_human FROM project_dialogue WHERE project_id=$1", [A.parentId])).rows[0].summary_human as string;
    expect(d).not.toContain(b64);
    ev("M01-migration147", { depois: row.extra.evolution_source_error });
  });
});
