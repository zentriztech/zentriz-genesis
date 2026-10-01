/**
 * projects.evolve-ticket.test.ts — RFC-0009: promover um Ticket é o `/evolve` com `ticketId`.
 *
 * Não existe segunda porta de promoção. O que precisa ficar provado:
 *  • as guardas do pedido (inexistente · de outro produto · já promovido);
 *  • o caminho ANTIGO (sem ticketId) continua idêntico;
 *  • promovido, o texto que vale é o do humano (nunca o `request` do body), o ticket viaja
 *    no `extra` do filho (é assim que ele alcança o commit/PR) e o `request.md` é escrito
 *    DE VERDADE na árvore da spec, em `tickets/TK-NNNN/`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PARENT = "33333333-3333-4333-8333-333333333333";
const CHILD = "44444444-4444-4444-8444-444444444444";
const PROD_ID = "55555555-5555-4555-8555-555555555555";
const OUTRO_PROD = "66666666-6666-4666-8666-666666666666";
const TICKET_ID = "77777777-7777-4777-8777-777777777777";

let currentUser = { id: "u1", email: "jean@zentriz.com.br", role: "tenant_admin" as const, tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = currentUser;
  },
}));

const captured: Array<{ sql: string; params: unknown[] }> = [];
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] });
const fakeQuery = async (sql: string, params: unknown[] = []) => {
  captured.push({ sql, params });
  return queryHandler(sql, params);
};
vi.mock("../db/client.js", () => ({
  pool: { query: fakeQuery, connect: async () => ({ query: fakeQuery, release: () => {} }) },
}));

function ticketRow(over: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID, tenant_id: TENANT, product_id: PROD_ID, project_id: PARENT, number: 12,
    title: "Exportar CSV", body: "Quero baixar a lista de entregas em CSV.", change_kind: "feature",
    status: "open", child_project_id: null, created_by: "u1", promoted_at: null, delivered_at: null,
    extra: {}, created_at: new Date("2026-09-11T12:00:00Z"), updated_at: new Date("2026-09-11T12:00:00Z"),
    ...over,
  };
}

/** Roteia as consultas do /evolve. Sem arquivos de spec no pai e sem PROJECT_FILES_ROOT,
 *  a rota pula a herança de arquivos e o clone do repo — sobra o que estamos testando. */
function evolveHandler(opts: { ticket?: Record<string, unknown> | null } = {}) {
  return (sql: string): { rows: unknown[]; rowCount?: number } => {
    if (sql.includes("SELECT tenant_id, created_by FROM projects")) return { rows: [{ tenant_id: TENANT, created_by: "u1" }] };
    if (sql.includes("SELECT id, title, status, product_id")) {
      return { rows: [{ id: PARENT, title: "VNX LastMile", status: "accepted", product_id: PROD_ID, tenant_id: TENANT, created_by: "u1", version_number: 1, complexity_hint: null }] };
    }
    if (sql.startsWith("SELECT * FROM tickets WHERE id")) return { rows: opts.ticket === undefined ? [ticketRow()] : opts.ticket ? [opts.ticket] : [] };
    if (sql.includes("parent_project_id = $1 AND status NOT IN")) return { rows: [] };  // nada em voo
    if (sql.includes("SELECT extra FROM projects")) return { rows: [{ extra: {} }] };
    if (sql.includes("SELECT status, is_inbox FROM products")) return { rows: [{ status: "active", is_inbox: false }] };
    if (sql.includes("INSERT INTO projects")) return { rows: [{ id: CHILD }] };
    if (sql.includes("FROM project_spec_files WHERE project_id")) return { rows: [] };
    if (sql.includes("FROM ticket_attachments")) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
}

let app: FastifyInstance;
let uploadDir: string;
const envBackup = { UPLOAD_DIR: process.env.UPLOAD_DIR, PROJECT_FILES_ROOT: process.env.PROJECT_FILES_ROOT };

beforeEach(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "genesis-tickets-"));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.PROJECT_FILES_ROOT = "";
  const { projectRoutes } = await import("./projects.js");
  app = Fastify({ logger: false });
  await app.register(projectRoutes);
  await app.ready();
  captured.length = 0;
  currentUser = { id: "u1", email: "jean@zentriz.com.br", role: "tenant_admin", tenantId: TENANT };
});

afterEach(() => {
  rmSync(uploadDir, { recursive: true, force: true });
  process.env.UPLOAD_DIR = envBackup.UPLOAD_DIR;
  process.env.PROJECT_FILES_ROOT = envBackup.PROJECT_FILES_ROOT;
});

describe("POST /api/projects/:id/evolve — guardas do pedido", () => {
  it("ticketId inexistente → 404, sem criar filho", async () => {
    queryHandler = evolveHandler({ ticket: null });
    const res = await app.inject({ method: "POST", url: `/api/projects/${PARENT}/evolve`, payload: { ticketId: TICKET_ID } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("TICKET_NOT_FOUND");
    expect(captured.some((c) => c.sql.includes("INSERT INTO projects"))).toBe(false);
  });

  it("pedido de outro produto → 400 (não se promove pedido de vizinho)", async () => {
    queryHandler = evolveHandler({ ticket: ticketRow({ product_id: OUTRO_PROD }) });
    const res = await app.inject({ method: "POST", url: `/api/projects/${PARENT}/evolve`, payload: { ticketId: TICKET_ID } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("TICKET_WRONG_PRODUCT");
  });

  it("pedido já promovido → 409 apontando a execução que já existe", async () => {
    queryHandler = evolveHandler({ ticket: ticketRow({ status: "promoted", child_project_id: CHILD }) });
    const res = await app.inject({ method: "POST", url: `/api/projects/${PARENT}/evolve`, payload: { ticketId: TICKET_ID } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("TICKET_ALREADY_PROMOTED");
    expect(res.json().childProjectId).toBe(CHILD);
  });

  it("caminho ANTIGO intocado: sem ticketId e sem request → 400 como antes", async () => {
    queryHandler = evolveHandler();
    const res = await app.inject({ method: "POST", url: `/api/projects/${PARENT}/evolve`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("BAD_REQUEST");
  });
});

describe("POST /api/projects/:id/evolve — promoção do pedido", () => {
  it("o texto que vale é o do humano, o ticket viaja no extra e o pedido vira 'promoted'", async () => {
    queryHandler = evolveHandler();
    const res = await app.inject({
      method: "POST", url: `/api/projects/${PARENT}/evolve`,
      payload: { ticketId: TICKET_ID, request: "TEXTO DO CLIENTE QUE NÃO PODE VENCER" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().childProjectId).toBe(CHILD);

    const ins = captured.find((c) => c.sql.includes("INSERT INTO projects"));
    const extra = JSON.parse(String(ins?.params[6])) as Record<string, unknown>;
    expect(extra.evolution_request).toBe("Quero baixar a lista de entregas em CSV.");
    expect(extra.ticket_number).toBe(12);           // é daqui que sai o carimbo TK-0012 no PR
    expect(extra.ticket_kind).toBe("feature");
    expect(extra.ticket_id).toBe(TICKET_ID);

    const upd = captured.find((c) => c.sql.includes("UPDATE tickets SET status = 'promoted'"));
    expect(upd?.params).toEqual([TICKET_ID, CHILD]);
  });

  it("o pedido é materializado na ÁRVORE da spec do filho, legível e com o texto cru", async () => {
    queryHandler = evolveHandler();
    const res = await app.inject({ method: "POST", url: `/api/projects/${PARENT}/evolve`, payload: { ticketId: TICKET_ID } });
    expect(res.statusCode).toBe(201);

    const mdPath = join(uploadDir, CHILD, "tickets", "TK-0012", "request.md");
    expect(existsSync(mdPath)).toBe(true);
    const md = readFileSync(mdPath, "utf-8");
    expect(md).toContain("Quero baixar a lista de entregas em CSV.");
    expect(md).toContain("ticket: TK-0012");

    // E fica registrado na árvore (rel_dir), que é como a Bancada e a Fábrica enxergam pastas.
    const reg = captured.find((c) => c.sql.includes("INSERT INTO project_spec_files") && String(c.params[1]) === "request.md");
    expect(reg?.params[3]).toBe("tickets/TK-0012");
    expect(reg?.params[0]).toBe(CHILD);
  });

  it("materialização é best-effort: disco indisponível NÃO aborta a evolução já criada", async () => {
    queryHandler = evolveHandler();
    // ENOTDIR imediato (um arquivo no lugar do diretório). NÃO usar um caminho sob /proc:
    // `mkdirSync(..., {recursive:true})` ali TRAVA o processo neste kernel.
    process.env.UPLOAD_DIR = "/dev/null/genesis-sem-disco";
    const res = await app.inject({ method: "POST", url: `/api/projects/${PARENT}/evolve`, payload: { ticketId: TICKET_ID } });
    expect(res.statusCode).toBe(201);
    // … e o erro fica REGISTRADO no filho, em vez de sumir.
    const upd = captured.find((c) => c.sql.includes("UPDATE projects SET extra") && String(c.params[1]).includes("ticket_materialize_error"));
    expect(JSON.parse(String(upd?.params[1])).ticket_materialize_error).toBeTruthy();
  });
});
