/**
 * Tarefa Q — fila de conversão pdf/doc/docx → .md em Postgres REAL (efêmero): rotas reais, worker thread real, fixtures reais.
 * Só roda com PG_TEST_URL (porta 55432/55440/55441; ver src/testing/evolvePg.ts). Sem LLM, sem rede.
 *
 *   ATTACHMENT_CONVERSION=off (padrão) ⇒ nada é enfileirado nem gravado (byte-idêntico ao anterior).
 *   ATTACHMENT_CONVERSION=on (+ ATTACHMENTS_STRICT=on) ⇒ derivado `.md` (kind=spec_text, origin=converted:<id>) na spec.
 */
import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { readFileSync, writeFileSync } from "fs";
import {
  describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "../routes/projects.js";
import { ticketRoutes } from "../routes/tickets.js";
import { pipelineRoutes } from "../routes/pipeline.js";
import { productRoutes } from "../routes/products.js";
import { materializeTicketIntoSpecTree, loadTicket } from "./tickets.js";
import {
  attachmentConversionEnabled, enqueueTicketConversions, runConversionTick, drainTicketConversions, BUILTIN_CONVERTER_ID,
} from "./attachmentConversionQueue.js";
import { makeDocx, makePdf, makePdfNoText, makeDoc } from "../testing/attachmentFixtures.js";
import { isRolloutFlagKey } from "./featureFlags.js";

const MD = Buffer.from("# Regras\n\nO CSV usa ponto e vírgula.\n", "utf-8");
const BOUNDARY = "----qconv";
function multipart(fields: Record<string, string>, files: Array<{ filename: string; content: Buffer }> = []) {
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(f.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describePg("Tarefa Q — conversão automática de anexos (Postgres real)", () => {
  let pool: pg.Pool; let app: FastifyInstance;
  const seeds: Seed[] = [];
  beforeAll(async () => {
    pool = await openPg();
    app = await buildApp([projectRoutes, ticketRoutes, pipelineRoutes, productRoutes]);
  });
  afterAll(async () => { await app?.close(); for (const s of seeds) s.cleanup(); await pool?.end(); });
  afterEach(() => { delete process.env.ATTACHMENTS_STRICT; delete process.env.ATTACHMENT_CONVERSION; });

  const on = () => { process.env.ATTACHMENTS_STRICT = "on"; process.env.ATTACHMENT_CONVERSION = "on"; };
  const seed = async () => { const s = await seedAcceptedProduct(pool); seeds.push(s); return s; };
  const post = (s: Seed, files: Array<{ filename: string; content: Buffer }>) => app.inject({
    method: "POST", url: `/api/products/${s.productId}/tickets`,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipart({ body: "Quero exportar em CSV.", changeKind: "feature" }, files),
  });
  const newChild = async (s: Seed, ticketId: string) => {
    const child = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number)
       VALUES ($1,$2,'filho','spec_submitted',$3,$4,2) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId])).rows[0].id as string;
    await pool.query("UPDATE tickets SET child_project_id=$1, status='promoted' WHERE id=$2", [child, ticketId]);
    return child;
  };
  const materialize = async (ticketId: string, childId: string) =>
    materializeTicketIntoSpecTree(pool, { ticket: (await loadTicket(pool, ticketId))!, childProjectId: childId });
  const specFiles = async (childId: string) => (await app.inject({ method: "GET", url: `/api/projects/${childId}/spec-files` })).json() as
    Array<{ filename: string; relDir: string; filePath?: string }>;
  const convs = async (ticketId: string) => (await pool.query(
    `SELECT c.status, c.attempts, c.error_code, c.warnings, c.derived_attachment_id, a.filename
       FROM attachment_conversions c JOIN ticket_attachments a ON a.id = c.attachment_id WHERE a.ticket_id = $1 ORDER BY a.filename`, [ticketId])).rows;
  const atts = async (ticketId: string) => (await pool.query(
    "SELECT id, filename, kind, origin, derived_from_attachment_id, file_path FROM ticket_attachments WHERE ticket_id=$1 ORDER BY filename", [ticketId])).rows;
  const waitConversions = async (ticketId: string, n: number) => {
    for (let i = 0; i < 100; i++) {
      const r = await convs(ticketId);
      if (r.length >= n && r.every((c) => !["pending", "running"].includes(c.status))) return r;
      await sleep(100);
    }
    throw new Error("conversões não terminaram: " + JSON.stringify(await convs(ticketId)));
  };

  it("a flag é de rollout (adminOnly via FLAG_DEFS) e o padrão é off", async () => {
    expect(isRolloutFlagKey("ATTACHMENT_CONVERSION")).toBe(true);
    const s = await seed();
    expect(await attachmentConversionEnabled(pool, s.tenantId)).toBe(false);
    process.env.ATTACHMENT_CONVERSION = "on";
    expect(await attachmentConversionEnabled(pool, s.tenantId)).toBe(false); // sem ATTACHMENTS_STRICT não converte
    process.env.ATTACHMENTS_STRICT = "on";
    expect(await attachmentConversionEnabled(pool, s.tenantId)).toBe(true);
    // tenant explícito vence o ambiente (mesma precedência das outras flags)
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('ATTACHMENT_CONVERSION','0',$1)", [s.tenantId]);
    expect(await attachmentConversionEnabled(pool, s.tenantId)).toBe(false);
  });

  it("off (padrão, mesmo com ATTACHMENTS_STRICT=on): nada é enfileirado, nenhum derivado, spec idêntica à de antes", async () => {
    process.env.ATTACHMENTS_STRICT = "on";
    const s = await seed();
    const r = await post(s, [{ filename: "man.pdf", content: makePdf() }, { filename: "nota.md", content: MD }]);
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    await sleep(300);
    expect(await convs(id)).toEqual([]);
    expect((await runConversionTick(pool, { ticketId: id })).claimed).toBe(0);
    await drainTicketConversions(pool, id); // mesmo chamada direta: sem flag não há trabalho
    const child = await newChild(s, id);
    expect((await materialize(id, child)).ok).toBe(true);
    expect((await specFiles(child)).map((f) => f.filename).sort()).toEqual(["nota.md", "request.md"]);
    expect((await atts(id)).map((a) => `${a.filename}:${a.kind}:${a.origin}`)).toEqual(["man.pdf:card_only:upload", "nota.md:spec_text:upload"]);
  });

  it("on: upload enfileira em segundo plano; pdf, docx e doc viram .md derivado com origem marcada e entram na spec (o binário não)", async () => {
    on();
    const s = await seed();
    const files = [
      { filename: "man.pdf", content: makePdf([["Manual de operação", "Passo um."]]) },
      { filename: "contrato.docx", content: makeDocx({ paragraphs: ["Contrato", "Cláusula primeira."] }) },
      { filename: "velho.doc", content: makeDoc("Documento legado\rConteúdo antigo\r") },
      { filename: "regras.md", content: MD },
    ];
    const r = await post(s, files);
    expect(r.statusCode).toBe(201); // a resposta não espera a conversão
    const id = r.json().id as string;
    const done = await waitConversions(id, 3);
    expect(done.map((c) => `${c.filename}:${c.status}`)).toEqual(["contrato.docx:done", "man.pdf:done", "velho.doc:done"]);

    const rows = await atts(id);
    const derived = rows.filter((a) => a.derived_from_attachment_id);
    expect(derived.map((d) => d.filename).sort()).toEqual(["contrato.docx.md", "man.pdf.md", "velho.doc.md"]);
    expect(derived.every((d) => d.kind === "spec_text" && d.origin === `converted:${BUILTIN_CONVERTER_ID}`)).toBe(true);
    const orig = new Map(rows.filter((a) => !a.derived_from_attachment_id).map((a) => [a.id as string, a.filename as string]));
    expect(derived.map((d) => orig.get(d.derived_from_attachment_id as string)).sort()).toEqual(["contrato.docx", "man.pdf", "velho.doc"]);
    const pdfMd = readFileSync(derived.find((d) => d.filename === "man.pdf.md")!.file_path as string, "utf-8");
    expect(pdfMd).toMatch(/^> Convertido automaticamente de man\.pdf \(anexo [0-9a-f-]{36}, sha256 [0-9a-f]{8}\) em \d{4}-\d{2}-\d{2}; pode conter perdas de formatação\n/);
    expect(pdfMd).toContain("Manual de operação\nPasso um.");

    const child = await newChild(s, id);
    expect((await materialize(id, child)).ok).toBe(true);
    const tree = (await specFiles(child)).map((f) => f.filename).sort();
    expect(tree).toEqual(["contrato.docx.md", "man.pdf.md", "regras.md", "request.md", "velho.doc.md"]);
    expect(tree.some((n) => /\.(pdf|docx?)$/i.test(n))).toBe(false);
    // o originais seguem guardados no card
    const card = (await app.inject({ method: "GET", url: `/api/projects/${child}/ticket-attachments` })).json() as Array<{ filename: string }>;
    expect(card.map((c) => c.filename).sort()).toEqual(["contrato.docx", "man.pdf", "velho.doc"]);
  });

  it("idempotência: enfileirar e rodar 2 vezes ⇒ 1 linha de fila e 1 derivado (chave attachment_id + sha256)", async () => {
    on();
    const s = await seed();
    const t = await seedTicket(pool, s, { attachments: [{ filename: "man.pdf", content: makePdf(), mime: "application/pdf" }] });
    expect(await enqueueTicketConversions(pool, t.id)).toBe(1);
    expect(await enqueueTicketConversions(pool, t.id)).toBe(0);
    const r1 = await runConversionTick(pool, { ticketId: t.id });
    const r2 = await runConversionTick(pool, { ticketId: t.id });
    expect(r1.done).toBe(1); expect(r2.claimed).toBe(0);
    await drainTicketConversions(pool, t.id);
    expect((await convs(t.id))).toHaveLength(1);
    expect((await atts(t.id)).filter((a) => a.derived_from_attachment_id)).toHaveLength(1);
  });

  it("concorrência: 2 workers disputando 3 anexos ⇒ cada anexo convertido uma vez, 3 derivados", async () => {
    on();
    const s = await seed();
    const t = await seedTicket(pool, s, { attachments: [
      { filename: "a.pdf", content: makePdf([["Alfa"]]), mime: "application/pdf" },
      { filename: "b.docx", content: makeDocx({ paragraphs: ["Beta"] }), mime: "x" },
      { filename: "c.doc", content: makeDoc("Gama\r"), mime: "x" },
    ] });
    await enqueueTicketConversions(pool, t.id);
    const [w1, w2] = await Promise.all([runConversionTick(pool, { ticketId: t.id }), runConversionTick(pool, { ticketId: t.id })]);
    expect(w1.claimed + w2.claimed).toBe(3);
    expect(w1.done + w2.done).toBe(3);
    expect((await convs(t.id)).map((c) => `${c.status}/${c.attempts}`)).toEqual(["done/1", "done/1", "done/1"]);
    expect((await atts(t.id)).filter((a) => a.derived_from_attachment_id)).toHaveLength(3);
  });

  it("retomável após reinício: 'running' com lock vencido é retomado; com lock vivo não é tocado", async () => {
    on();
    const s = await seed();
    const t = await seedTicket(pool, s, { attachments: [{ filename: "man.pdf", content: makePdf(), mime: "application/pdf" }] });
    await enqueueTicketConversions(pool, t.id);
    await pool.query("UPDATE attachment_conversions SET status='running', attempts=1, locked_until=now()+interval '5 minutes' WHERE attachment_id IN (SELECT id FROM ticket_attachments WHERE ticket_id=$1)", [t.id]);
    expect((await runConversionTick(pool, { ticketId: t.id })).claimed).toBe(0); // outro processo ainda está nele
    await pool.query("UPDATE attachment_conversions SET locked_until=now()-interval '1 second' WHERE status='running'");
    const r = await runConversionTick(pool, { ticketId: t.id }); // o processo morreu: retoma
    expect(r.done).toBe(1);
    expect((await convs(t.id))[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  it("falha não bloqueia o card: docx corrompido ⇒ failed/CORRUPT, original guardado, sem derivado, materialização ok", async () => {
    on();
    const s = await seed();
    const good = makeDocx();
    // passa na validação do upload (assinatura ZIP + [Content_Types].xml + word/) mas o diretório central foi cortado
    const broken = good.subarray(0, good.length - 40);
    const r = await post(s, [{ filename: "quebrado.docx", content: broken }, { filename: "ok.md", content: MD }]);
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    const [c] = await waitConversions(id, 1);
    expect(c).toMatchObject({ status: "failed", error_code: "CORRUPT", derived_attachment_id: null });
    expect((await atts(id)).some((a) => a.derived_from_attachment_id)).toBe(false);
    const child = await newChild(s, id);
    expect((await materialize(id, child)).ok).toBe(true);
    expect((await specFiles(child)).map((f) => f.filename).sort()).toEqual(["ok.md", "request.md"]);
    // terminal: não repete
    expect((await runConversionTick(pool, { ticketId: id, ignoreBackoff: true })).claimed).toBe(0);
  });

  it("PDF escaneado (sem camada de texto) ⇒ status empty + NO_TEXT_LAYER, nenhum derivado inventado", async () => {
    on();
    const s = await seed();
    const id = (await post(s, [{ filename: "scan.pdf", content: makePdfNoText() }])).json().id as string;
    const [c] = await waitConversions(id, 1);
    expect(c.status).toBe("empty");
    expect(c.error_code).toBe("NO_TEXT_LAYER");
    expect(c.warnings).toEqual(["NO_TEXT_LAYER"]);
    expect((await atts(id)).filter((a) => a.derived_from_attachment_id)).toHaveLength(0);
  });

  it("macro e PDF com JS já são recusados na ENTRADA (400), sem gravar nem enfileirar nada", async () => {
    on();
    const s = await seed();
    const { makePdfWithJs } = await import("../testing/attachmentFixtures.js");
    const r = await post(s, [{ filename: "macro.docx", content: makeDocx({ macro: true }) }, { filename: "js.pdf", content: makePdfWithJs() }]);
    expect(r.statusCode).toBe(400);
    expect((r.json().errors as Array<{ code: string }>).map((e) => e.code)).toEqual(["ATTACHMENT_ACTIVE_CONTENT", "ATTACHMENT_ACTIVE_CONTENT"]);
  });

  it("arquivo alterado no disco depois do upload ⇒ failed/FILE_CHANGED (sha256 da chave não confere)", async () => {
    on();
    const s = await seed();
    const t = await seedTicket(pool, s, { attachments: [{ filename: "man.pdf", content: makePdf(), mime: "application/pdf" }] });
    const fp = (await pool.query("SELECT file_path FROM ticket_attachments WHERE ticket_id=$1", [t.id])).rows[0].file_path as string;
    await enqueueTicketConversions(pool, t.id);
    writeFileSync(fp, makePdf([["Outro conteúdo"]]));
    await runConversionTick(pool, { ticketId: t.id });
    expect((await convs(t.id))[0]).toMatchObject({ status: "failed", error_code: "FILE_CHANGED" });
  });

  it("colisão de nome: o derivado nunca sobrescreve um anexo enviado com o mesmo nome", async () => {
    on();
    const s = await seed();
    const mine = Buffer.from("# meu texto\n", "utf-8");
    const t = await seedTicket(pool, s, { attachments: [
      { filename: "man.pdf", content: makePdf(), mime: "application/pdf" },
      { filename: "man.pdf.md", content: mine, mime: "text/markdown" },
    ] });
    await enqueueTicketConversions(pool, t.id);
    expect((await runConversionTick(pool, { ticketId: t.id })).done).toBe(1);
    const rows = await atts(t.id);
    const derived = rows.find((a) => a.derived_from_attachment_id)!;
    expect(derived.filename).toMatch(/^man\.pdf\.[0-9a-f]{8}\.md$/);
    const upl = rows.find((a) => a.filename === "man.pdf.md")!;
    expect(readFileSync(upl.file_path as string)).toEqual(mine);
  });

  it("materialização drena o que estiver pendente (derivado já entra na spec mesmo sem o worker ter rodado)", async () => {
    on();
    const s = await seed();
    const t = await seedTicket(pool, s, { attachments: [{ filename: "contrato.docx", content: makeDocx({ paragraphs: ["Contrato X"] }), mime: "x" }] });
    const child = await newChild(s, t.id);
    expect((await materialize(t.id, child)).ok).toBe(true);
    const names = (await specFiles(child)).map((f) => f.filename).sort();
    expect(names).toEqual(["contrato.docx.md", "request.md"]);
  });
});
