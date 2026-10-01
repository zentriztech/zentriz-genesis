/**
 * tickets.test.ts — RFC-0009: as guardas do PEDIDO.
 *
 * O que precisa ficar provado: o pedido só entra com conteúdo e tipo válidos; depois de
 * promovido é IMUTÁVEL (invariante 1 — o texto do humano já foi materializado na árvore da
 * spec, editar aqui criaria duas verdades); o estado de EXECUÇÃO nunca é copiado para
 * `tickets.status`, é derivado do projeto filho; e tenant alheio não enxerga nada.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OUTRO_TENANT = "22222222-2222-4222-8222-222222222222";
const PROD_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_ID = "55555555-5555-4555-8555-555555555555";
const CHILD_ID = "66666666-6666-4666-8666-666666666666";

let currentUser: { id: string; email: string; role: "user" | "tenant_admin" | "zentriz_admin"; tenantId: string | null } = {
  id: "u1", email: "jean@zentriz.com.br", role: "tenant_admin", tenantId: TENANT,
};
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

const PRODUTO = { id: PROD_ID, tenant_id: TENANT, created_by: "u1", name: "VNX LastMile", status: "active" };

function ticketRow(over: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID, tenant_id: TENANT, product_id: PROD_ID, project_id: null, number: 12,
    title: "Exportar CSV", body: "Quero baixar em CSV.", change_kind: "feature", status: "open",
    child_project_id: null, created_by: "u1", promoted_at: null, delivered_at: null, extra: {},
    created_at: new Date("2026-09-11T12:00:00Z"), updated_at: new Date("2026-09-11T12:00:00Z"),
    ...over,
  };
}

/** Roteia as consultas das rotas de ticket. */
function handler(opts: { product?: Record<string, unknown> | null; ticket?: Record<string, unknown> | null; child?: Record<string, unknown> } = {}) {
  const product = opts.product === undefined ? PRODUTO : opts.product;
  const ticket = opts.ticket === undefined ? ticketRow() : opts.ticket;
  return (sql: string): { rows: unknown[]; rowCount?: number } => {
    if (sql.includes("FROM products WHERE id")) return { rows: product ? [product] : [] };
    if (sql.includes("UPDATE products SET next_ticket_seq")) return { rows: [{ allocated: 12 }] };
    if (sql.startsWith("SELECT * FROM tickets WHERE id")) return { rows: ticket ? [ticket] : [] };
    if (sql.includes("FROM tickets WHERE product_id")) return { rows: ticket ? [ticket] : [] };
    if (sql.includes("INSERT INTO tickets")) return { rows: [ticketRow()] };
    if (sql.includes("UPDATE tickets SET")) return { rows: [ticketRow({ status: "rejected" })], rowCount: 1 };
    if (sql.includes("FROM projects WHERE id = ANY")) return { rows: opts.child ? [opts.child] : [] };
    if (sql.includes("FROM ticket_attachments")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
}

let app: FastifyInstance;
beforeEach(async () => {
  const { ticketRoutes } = await import("./tickets.js");
  app = Fastify();
  await app.register(ticketRoutes);
  await app.ready();
  captured.length = 0;
  currentUser = { id: "u1", email: "jean@zentriz.com.br", role: "tenant_admin", tenantId: TENANT };
});

describe("POST /api/products/:id/tickets — abrir o pedido", () => {
  it("cria com corpo e tipo declarado, devolvendo o código estável", async () => {
    queryHandler = handler();
    const res = await app.inject({
      method: "POST", url: `/api/products/${PROD_ID}/tickets`,
      payload: { body: "Quero baixar em CSV.", changeKind: "feature" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBe("TK-0012");
    // O número veio do contador do produto — o MESMO mecanismo de next_rfc_seq.
    expect(captured.some((c) => c.sql.includes("UPDATE products SET next_ticket_seq"))).toBe(true);
  });

  it("recusa pedido vazio — sem texto não há o que evoluir", async () => {
    queryHandler = handler();
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/tickets`, payload: { body: "   " } });
    expect(res.statusCode).toBe(400);
  });

  it("recusa tipo inventado — o tipo é DECLARADO, não texto livre", async () => {
    queryHandler = handler();
    const res = await app.inject({
      method: "POST", url: `/api/products/${PROD_ID}/tickets`,
      payload: { body: "algo", changeKind: "refatoração-total" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("título vazio herda a primeira linha do pedido, em vez de exigir do humano", async () => {
    queryHandler = handler();
    const res = await app.inject({
      method: "POST", url: `/api/products/${PROD_ID}/tickets`,
      payload: { body: "Exportar CSV\ndetalhes abaixo", changeKind: "feature" },
    });
    expect(res.statusCode).toBe(201);
    const ins = captured.find((c) => c.sql.includes("INSERT INTO tickets"));
    expect(ins?.params[4]).toBe("Exportar CSV");
  });

  it("produto de outro tenant não existe para quem pergunta", async () => {
    currentUser = { id: "u9", email: "outro@x.com", role: "tenant_admin", tenantId: OUTRO_TENANT };
    queryHandler = handler();
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/tickets`, payload: { body: "x" } });
    expect(res.statusCode).toBe(404);
  });

  it("produto arquivado não recebe pedido novo", async () => {
    queryHandler = handler({ product: { ...PRODUTO, status: "archived" } });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/tickets`, payload: { body: "x" } });
    expect(res.statusCode).toBe(409);
  });

  it("token de serviço (runner) não abre pedido — autoria é humana", async () => {
    currentUser = { ...currentUser, ...{ svc: "runner" } } as typeof currentUser;
    queryHandler = handler();
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/tickets`, payload: { body: "x" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("PATCH /api/tickets/:id — invariante 1: o pedido promovido é imutável", () => {
  it("editar o corpo depois de promovido dá 409 com o código do ticket na mensagem", async () => {
    queryHandler = handler({ ticket: ticketRow({ status: "promoted", child_project_id: CHILD_ID }) });
    const res = await app.inject({ method: "PATCH", url: `/api/tickets/${TICKET_ID}`, payload: { body: "outra coisa" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("TICKET_IMMUTABLE");
    expect(res.json().message).toContain("TK-0012");
  });

  it("enquanto aberto, o humano corrige o próprio texto", async () => {
    queryHandler = handler();
    const res = await app.inject({ method: "PATCH", url: `/api/tickets/${TICKET_ID}`, payload: { body: "texto corrigido" } });
    expect(res.statusCode).toBe(200);
  });

  it("recusar é permitido mesmo depois de promovido — recusa não reescreve o pedido", async () => {
    queryHandler = handler({ ticket: ticketRow({ status: "promoted", child_project_id: CHILD_ID }) });
    const res = await app.inject({ method: "PATCH", url: `/api/tickets/${TICKET_ID}`, payload: { status: "rejected" } });
    expect(res.statusCode).toBe(200);
  });

  it("o cliente não consegue escrever 'promoted' — quem promove é o /evolve", async () => {
    queryHandler = handler();
    const res = await app.inject({ method: "PATCH", url: `/api/tickets/${TICKET_ID}`, payload: { status: "promoted" } });
    expect(res.statusCode).toBe(400);
  });

  it("marcar entregue sem execução é recusado", async () => {
    queryHandler = handler();
    const res = await app.inject({ method: "PATCH", url: `/api/tickets/${TICKET_ID}`, payload: { status: "delivered" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("NOT_PROMOTED");
  });
});

describe("GET — o estado da EXECUÇÃO é derivado, nunca copiado", () => {
  it("lista traz execution_status vindo do projeto filho, não de tickets.status", async () => {
    queryHandler = handler({
      ticket: ticketRow({ status: "promoted", child_project_id: CHILD_ID }),
      child: { id: CHILD_ID, status: "blocked_cyborg", title: "LastMile — Evolução v2" },
    });
    const res = await app.inject({ method: "GET", url: `/api/products/${PROD_ID}/tickets` });
    expect(res.statusCode).toBe(200);
    const [t] = res.json();
    expect(t.status).toBe("promoted");          // estado do PEDIDO
    expect(t.execution_status).toBe("blocked_cyborg"); // estado da EXECUÇÃO, derivado
  });

  it("pedido sem execução não inventa estado", async () => {
    queryHandler = handler();
    const res = await app.inject({ method: "GET", url: `/api/tickets/${TICKET_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().execution_status).toBeNull();
  });

  it("ticket de outro tenant não existe para quem pergunta", async () => {
    currentUser = { id: "u9", email: "outro@x.com", role: "tenant_admin", tenantId: OUTRO_TENANT };
    queryHandler = handler();
    const res = await app.inject({ method: "GET", url: `/api/tickets/${TICKET_ID}` });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * O diálogo "Evoluir" manda SEMPRE FormData — com ou sem anexo. Estes dois testes existem
 * porque `req.files()` não emite nada quando não há parte de arquivo: os campos se perdiam e
 * o pedido sem anexo virava 400. Aqui o corpo multipart é montado à mão, como o browser faria.
 */
describe("POST multipart — o caminho real do diálogo", () => {
  const BOUNDARY = "----genesisTicketBoundary";
  function multipart(fields: Record<string, string>, files: Array<{ field: string; filename: string; content: string }> = []) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    }
    for (const f of files) {
      parts.push(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: text/plain\r\n\r\n${f.content}\r\n`);
    }
    parts.push(`--${BOUNDARY}--\r\n`);
    return parts.join("");
  }

  let mapp: FastifyInstance;
  let uploadDir: string;
  const prevUploadDir = process.env.UPLOAD_DIR;

  beforeEach(async () => {
    uploadDir = mkdtempSync(join(tmpdir(), "genesis-tk-up-"));
    process.env.UPLOAD_DIR = uploadDir;
    const { ticketRoutes } = await import("./tickets.js");
    mapp = Fastify();
    await mapp.register(fastifyMultipart, { limits: { files: 10, fileSize: 10 * 1024 * 1024 } });
    await mapp.register(ticketRoutes);
    await mapp.ready();
    queryHandler = handler();
    captured.length = 0;
  });
  afterEach(() => {
    rmSync(uploadDir, { recursive: true, force: true });
    process.env.UPLOAD_DIR = prevUploadDir;
  });

  it("SEM anexo: os campos chegam e o pedido é criado (regressão do 400)", async () => {
    const res = await mapp.inject({
      method: "POST", url: `/api/products/${PROD_ID}/tickets`,
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ body: "Quero exportar em CSV.", changeKind: "feature", projectId: "" }),
    });
    expect(res.statusCode).toBe(201);
    const ins = captured.find((c) => c.sql.includes("INSERT INTO tickets"));
    expect(ins?.params[5]).toBe("Quero exportar em CSV.");
    expect(ins?.params[6]).toBe("feature");
  });

  it("COM anexo: o arquivo vai para o disco e é registrado com hash", async () => {
    const res = await mapp.inject({
      method: "POST", url: `/api/products/${PROD_ID}/tickets`,
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart(
        { body: "Segue a planilha do cliente.", changeKind: "evolution" },
        [{ field: "files", filename: "planilha.csv", content: "a,b\n1,2\n" }],
      ),
    });
    expect(res.statusCode).toBe(201);
    const att = captured.find((c) => c.sql.includes("INSERT INTO ticket_attachments"));
    expect(att?.params[1]).toBe("planilha.csv");
    expect(String(att?.params[5])).toMatch(/^[0-9a-f]{64}$/); // sha256 do conteúdo
    const dest = String(att?.params[2]);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("a,b\n1,2\n");
  });

  it("nome de arquivo com caminho é neutralizado (nada de ../)", async () => {
    const res = await mapp.inject({
      method: "POST", url: `/api/products/${PROD_ID}/tickets`,
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ body: "x" }, [{ field: "files", filename: "../../etc/passwd", content: "nope" }]),
    });
    expect(res.statusCode).toBe(201);
    const att = captured.find((c) => c.sql.includes("INSERT INTO ticket_attachments"));
    expect(att?.params[1]).toBe("passwd");
    expect(String(att?.params[2])).not.toContain("..");
  });
});

describe("DELETE /api/tickets/:id — histórico não se apaga", () => {
  it("pedido ainda aberto pode ser apagado", async () => {
    queryHandler = handler();
    const res = await app.inject({ method: "DELETE", url: `/api/tickets/${TICKET_ID}` });
    expect(res.statusCode).toBe(204);
  });

  it("pedido promovido não se apaga — recusa-se", async () => {
    queryHandler = handler({ ticket: ticketRow({ status: "promoted", child_project_id: CHILD_ID }) });
    const res = await app.inject({ method: "DELETE", url: `/api/tickets/${TICKET_ID}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("TICKET_PROMOTED");
  });
});
