/**
 * Tarefa 1.5 (anexos do card) em Postgres REAL (efêmero): POST multipart + materialização na árvore da spec
 * + listagens separadas. Rotas reais; sem LLM. Só roda com PG_TEST_URL (ver src/testing/evolvePg.ts).
 *
 *   ATTACHMENTS_STRICT=off ⇒ comportamento anterior (qualquer arquivo entra no card e é copiado para a árvore).
 *   ATTACHMENTS_STRICT=on  ⇒ allowlist + magic bytes + tetos; txt/md na árvore; pdf/doc/docx só no card.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { writeFileSync } from "fs";
import {
  describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";
import { pipelineRoutes } from "./pipeline.js";
import { productRoutes } from "./products.js";
import { materializeTicketIntoSpecTree, loadTicket } from "../services/tickets.js";
import { registerAttachmentConverter, resetAttachmentConverters } from "../services/attachmentConversion.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28])]);
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xml xl/workbook.xml"), Buffer.from([0xff, 0xfe])]);
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\n%%EOF\n", "latin1");
const DOC = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 0x80)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("..[Content_Types].xml..word/document.xml..")]);
const MD = Buffer.from("# Regras\n\nO CSV usa ponto e vírgula.\n", "utf-8");
const TXT = Buffer.from("anotação em texto puro\n", "utf-8");

const BOUNDARY = "----f2attach";
function multipart(fields: Record<string, string>, files: Array<{ filename: string; content: Buffer; mime?: string }> = []) {
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: ${f.mime ?? "application/octet-stream"}\r\n\r\n`));
    chunks.push(f.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

describePg("Tarefa 1.5 — anexos do card (Postgres real)", () => {
  let pool: pg.Pool; let app: FastifyInstance;
  const seeds: Seed[] = [];
  beforeAll(async () => {
    pool = await openPg();
    app = await buildApp([projectRoutes, ticketRoutes, pipelineRoutes, productRoutes]);
  });
  afterAll(async () => { await app?.close(); for (const s of seeds) s.cleanup(); await pool?.end(); });
  afterEach(() => { delete process.env.ATTACHMENTS_STRICT; resetAttachmentConverters(); });

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
  const materialize = async (s: Seed, ticketId: string, childId: string) => {
    const t = (await loadTicket(pool, ticketId))!;
    return materializeTicketIntoSpecTree(pool, { ticket: t, childProjectId: childId });
  };
  const specFiles = async (childId: string) => (await app.inject({ method: "GET", url: `/api/projects/${childId}/spec-files` })).json() as
    Array<{ filename: string; relDir: string }>;

  // ── controle: com a flag off nada mudou ───────────────────────────────────────────
  it("off (padrão): png/xlsx/pdf entram no card E na árvore da spec, como antes", async () => {
    const s = await seed();
    const r = await post(s, [{ filename: "print.png", content: PNG }, { filename: "plan.xlsx", content: XLSX }, { filename: "man.pdf", content: PDF }]);
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    const child = await newChild(s, id);
    const m = await materialize(s, id, child);
    expect(m.ok).toBe(true);
    const names = (await specFiles(child)).map((f) => f.filename).sort();
    expect(names).toEqual(["man.pdf", "plan.xlsx", "print.png", "request.md"]);
    const det = (await app.inject({ method: "GET", url: `/api/tickets/${id}` })).json();
    expect(Object.keys(det.attachments[0]).sort()).toEqual(["filename", "id", "mimeType", "sizeBytes"]); // formato anterior
  });

  // ── POST ──────────────────────────────────────────────────────────────────────────
  it("on: png/xlsx recusados (400 com a lista) e NADA é gravado", async () => {
    process.env.ATTACHMENTS_STRICT = "on";
    const s = await seed();
    const r = await post(s, [{ filename: "ok.md", content: MD }, { filename: "print.png", content: PNG }, { filename: "plan.xlsx", content: XLSX }]);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("ATTACHMENT_INVALID");
    expect((r.json().errors as Array<{ code: string }>).map((e) => e.code)).toEqual(["ATTACHMENT_TYPE_NOT_ALLOWED", "ATTACHMENT_TYPE_NOT_ALLOWED"]);
    expect((await pool.query("SELECT count(*)::int n FROM tickets WHERE product_id=$1", [s.productId])).rows[0].n).toBe(0);
  });
  it("on: extensão que mente (pdf que é docx; txt que é png) é recusada pelo conteúdo", async () => {
    process.env.ATTACHMENTS_STRICT = "on";
    const s = await seed();
    const r = await post(s, [{ filename: "falso.pdf", content: DOCX }, { filename: "falso.txt", content: PNG }]);
    expect(r.statusCode).toBe(400);
    expect((r.json().errors as Array<{ code: string }>).map((e) => e.code)).toEqual(["ATTACHMENT_CONTENT_MISMATCH", "ATTACHMENT_CONTENT_MISMATCH"]);
  });
  it("on: teto por card vem de genesis_runtime_config (override do tenant)", async () => {
    process.env.ATTACHMENTS_STRICT = "on";
    const s = await seed();
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('ATTACHMENT_MAX_FILES','1',$1)", [s.tenantId]);
    const r = await post(s, [{ filename: "a.md", content: MD }, { filename: "b.txt", content: TXT }]);
    expect(r.statusCode).toBe(400);
    expect((r.json().errors as Array<{ code: string }>)[0].code).toBe("ATTACHMENT_TOO_MANY");
    await pool.query("UPDATE genesis_runtime_config SET value='2' WHERE key='ATTACHMENT_MAX_FILES' AND tenant_id=$1", [s.tenantId]);
    expect((await post(s, [{ filename: "a.md", content: MD }, { filename: "b.txt", content: TXT }])).statusCode).toBe(201);
    await pool.query("UPDATE genesis_runtime_config SET value='1024' WHERE key='ATTACHMENT_MAX_TOTAL_BYTES' AND tenant_id IS NULL");
    const big = await post(s, [{ filename: "a.md", content: Buffer.alloc(900, 0x61) }, { filename: "b.txt", content: Buffer.alloc(900, 0x62) }]);
    await pool.query("UPDATE genesis_runtime_config SET value='20971520' WHERE key='ATTACHMENT_MAX_TOTAL_BYTES' AND tenant_id IS NULL");
    expect(big.statusCode).toBe(400);
    expect((big.json().errors as Array<{ code: string }>).map((e) => e.code)).toContain("ATTACHMENT_TOTAL_TOO_LARGE");
  });

  // ── materialização e listagens ────────────────────────────────────────────────────
  it("on: txt/md na árvore; pdf/doc/docx só no card (listáveis e baixáveis); spec de texto intacta", async () => {
    process.env.ATTACHMENTS_STRICT = "on";
    const s = await seed();
    const files = [
      { filename: "regras.md", content: MD }, { filename: "nota.txt", content: TXT },
      { filename: "man.pdf", content: PDF }, { filename: "velho.doc", content: DOC }, { filename: "contrato.docx", content: DOCX },
    ];
    const r = await post(s, files);
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    const kinds = (await pool.query("SELECT filename, kind, origin, content_sha256 FROM ticket_attachments WHERE ticket_id=$1 ORDER BY filename", [id])).rows;
    expect(kinds.map((k) => `${k.filename}:${k.kind}:${k.origin}`)).toEqual([
      "contrato.docx:card_only:upload", "man.pdf:card_only:upload", "nota.txt:spec_text:upload", "regras.md:spec_text:upload", "velho.doc:card_only:upload",
    ]);
    expect(kinds.every((k) => /^[0-9a-f]{64}$/.test(k.content_sha256))).toBe(true);

    const child = await newChild(s, id);
    const m = await materialize(s, id, child);
    expect(m.ok).toBe(true);
    const tree = await specFiles(child);
    expect(tree.map((f) => f.filename).sort()).toEqual(["nota.txt", "regras.md", "request.md"]);
    expect(tree.some((f) => /\.(pdf|docx?)$/i.test(f.filename))).toBe(false);
    // request.md declara os guardados no card, sem linkar para a árvore
    const reqPath = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id=$1 AND filename='request.md'", [child])).rows[0].file_path as string;
    const reqMd = (await import("fs")).readFileSync(reqPath, "utf-8");
    expect(reqMd).toContain("## Anexos guardados no card (fora da spec)");
    expect(reqMd).toContain("`man.pdf`");
    expect(reqMd).not.toContain("anexos/man.pdf");
    // (d) listagem separada dos anexos do card
    const card = (await app.inject({ method: "GET", url: `/api/projects/${child}/ticket-attachments` })).json() as Array<Record<string, unknown>>;
    expect(card.map((c) => c.filename).sort()).toEqual(["contrato.docx", "man.pdf", "velho.doc"]);
    expect(card.every((c) => c.kind === "card_only" && c.origin === "upload" && c.derivedFromAttachmentId === null)).toBe(true);
    // baixável
    const dl = await app.inject({ method: "GET", url: String(card.find((c) => c.filename === "man.pdf")!.downloadUrl) });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.from(dl.rawPayload).equals(PDF)).toBe(true);
    // detalhe do ticket traz tipo/hash/origem
    const det = (await app.inject({ method: "GET", url: `/api/tickets/${id}` })).json();
    expect(det.attachments.find((a: { filename: string }) => a.filename === "man.pdf")).toMatchObject({ kind: "card_only", origin: "upload" });
  });

  it("on: anexo legado (png já gravado no card) não entra na árvore e o spec-files filtra a linha legada", async () => {
    process.env.ATTACHMENTS_STRICT = "on";
    const s = await seed();
    const t = await seedTicket(pool, s, { attachments: [{ filename: "print.png", content: PNG, mime: "image/png" }, { filename: "ok.md", content: MD, mime: "text/markdown" }] });
    const child = await newChild(s, t.id);
    await materialize(s, t.id, child);
    expect((await specFiles(child)).map((f) => f.filename).sort()).toEqual(["ok.md", "request.md"]);
    // linha legada em project_spec_files (gravada com a flag off) some da listagem de spec com a flag on
    await pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary) VALUES ($1,'old.png','/x','image/png','tickets/TK-0001/anexos',false)`, [child]);
    expect((await specFiles(child)).map((f) => f.filename)).not.toContain("old.png");
    expect(((await app.inject({ method: "GET", url: `/api/projects/${child}/ticket-attachments` })).json() as Array<{ filename: string }>).map((c) => c.filename)).toEqual(["print.png"]);
  });

  it("on: txt/md ilegível na materialização ⇒ erro explícito (ok=false, nome do arquivo), nada copiado", async () => {
    process.env.ATTACHMENTS_STRICT = "on";
    const s = await seed();
    const t = await seedTicket(pool, s, { attachments: [{ filename: "quebrado.md", content: MD, mime: "text/markdown" }] });
    const fp = (await pool.query("SELECT file_path FROM ticket_attachments WHERE ticket_id=$1", [t.id])).rows[0].file_path as string;
    writeFileSync(fp, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x80, 0xc3, 0x28]));
    const child = await newChild(s, t.id);
    const m = await materialize(s, t.id, child);
    expect(m.ok).toBe(false);
    expect(m.error).toMatch(/ATTACHMENT_UNREADABLE: quebrado\.md/);
    expect((await specFiles(child)).map((f) => f.filename)).not.toContain("quebrado.md");
  });

  it("on: ponto de extensão — conversor registrado cria linha DERIVADA (origem marcada) que segue como texto da spec", async () => {
    process.env.ATTACHMENTS_STRICT = "on";
    registerAttachmentConverter({ id: "fake", accepts: (e) => e === ".pdf", convert: async () => ({ filename: "man.pdf.md", markdown: "# convertido\n" }) });
    const s = await seed();
    const r = await post(s, [{ filename: "man.pdf", content: PDF }]);
    const id = r.json().id as string;
    const child = await newChild(s, id);
    expect((await materialize(s, id, child)).ok).toBe(true);
    expect((await materialize(s, id, child)).ok).toBe(true); // idempotente
    const rows = (await pool.query("SELECT filename, kind, origin, derived_from_attachment_id FROM ticket_attachments WHERE ticket_id=$1 ORDER BY filename", [id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ filename: "man.pdf.md", kind: "spec_text", origin: "converted:fake" });
    expect(rows[1].derived_from_attachment_id).toBeTruthy();
    expect((await specFiles(child)).map((f) => f.filename).sort()).toEqual(["man.pdf.md", "request.md"]);
  });

  it("on: com o conversor NULO nenhuma linha derivada é criada", async () => {
    process.env.ATTACHMENTS_STRICT = "on";
    const s = await seed();
    const id = (await post(s, [{ filename: "man.pdf", content: PDF }])).json().id as string;
    await materialize(s, id, await newChild(s, id));
    expect((await pool.query("SELECT count(*)::int n FROM ticket_attachments WHERE ticket_id=$1", [id])).rows[0].n).toBe(1);
  });
});
