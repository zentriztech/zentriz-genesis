/**
 * specFiles.create.test.ts — Onda 2 / escrita (revisão adversarial das ações da Bancada):
 * o "Novo arquivo" da árvore (`POST /api/projects/:id/spec-file`) não pode deixar o banco
 * afirmando um arquivo que o disco não sustenta.
 *
 * Modo de falha real: a linha em `project_spec_files` é criada ANTES do disco de propósito — é
 * dela que sai o `409 EXISTS` (a unicidade é do banco). Se o `mkdir`/`writeFile` falhasse
 * (ENOSPC, permissão, `rel_dir` irrecuperável), a linha ficava órfã; e
 * `computeCurrentSpecHash` devolve `null` quando QUALQUER linha aponta para arquivo
 * inexistente → o projeto INTEIRO parava de validar e de promover, sem nada na UI explicando,
 * e a única saída era apagar o fantasma no banco.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sha256Hex } from "../lib/specTreeHash.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPLOADS = "/tmp/specfiles-create-test-uploads";

process.env.UPLOAD_DIR = UPLOADS;

let currentUser: Record<string, unknown> = { id: "u1", role: "tenant_admin", tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = currentUser;
  },
}));

let projectRow: Record<string, unknown> | null = { id: PROJ, tenant_id: TENANT, created_by: "u1", status: "draft" };
let fileCount = 3;
/** Erro que o INSERT deve lançar (ex.: 23505 do caminho já existente). */
let insertError: (Error & { code?: string }) | null = null;

const queries: Array<{ sql: string; params: unknown[] }> = [];
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const s = sql.replace(/\s+/g, " ");
      if (s.includes("FROM projects WHERE id")) return { rows: projectRow ? [projectRow] : [] };
      if (s.includes("count(*)")) return { rows: [{ n: fileCount }] };
      if (s.includes("INSERT INTO project_spec_files")) {
        if (insertError) throw insertError;
        return { rows: [] };
      }
      return { rows: [] };
    },
  },
}));

/** Disco fake: `diskError` liga a falha de gravação sem depender do sistema de arquivos real. */
let diskError: Error | null = null;
const written: Array<{ file: string; content: string }> = [];
const mkdirs: string[] = [];
vi.mock("fs/promises", () => ({
  default: {
    mkdir: async (dir: string) => { mkdirs.push(dir); if (diskError) throw diskError; },
    writeFile: async (file: string, content: string) => {
      if (diskError) throw diskError;
      written.push({ file, content });
    },
    readFile: async () => Buffer.from("", "utf-8"),
    unlink: async () => {},
  },
}));

let app: FastifyInstance;

beforeEach(async () => {
  const { specFileRoutes } = await import("./specFiles.js");
  app = Fastify();
  await app.register(specFileRoutes);
  await app.ready();
  currentUser = { id: "u1", role: "tenant_admin", tenantId: TENANT };
  projectRow = { id: PROJ, tenant_id: TENANT, created_by: "u1", status: "draft" };
  fileCount = 3;
  insertError = null;
  diskError = null;
  queries.length = 0; written.length = 0; mkdirs.length = 0;
});

afterEach(async () => { await app.close(); });

function create(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/projects/${PROJ}/spec-file`, payload: body });
}

const deletes = () => queries.filter((q) => /DELETE FROM project_spec_files/.test(q.sql));
const inserts = () => queries.filter((q) => /INSERT INTO project_spec_files/.test(q.sql));

describe("POST /spec-file — criação atômica (Onda 2)", () => {
  it("caminho feliz: reserva a linha, grava o disco e devolve 201 com o sha do conteúdo", async () => {
    const content = "# ADR-002 — Fila de eventos\n";
    const res = await create({ path: "docs/adr/ADR-002-fila.md", content });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { contentSha256: string }).contentSha256).toBe(sha256Hex(Buffer.from(content, "utf-8")));
    // a ORDEM importa: a linha (reserva do caminho) vem antes do disco
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params.slice(0, 4)).toEqual([PROJ, "ADR-002-fila.md", `${UPLOADS}/${PROJ}/docs/adr/ADR-002-fila.md`, "docs/adr"]);
    expect(written).toEqual([{ file: `${UPLOADS}/${PROJ}/docs/adr/ADR-002-fila.md`, content }]);
    expect(deletes()).toHaveLength(0);
  });

  it("🔴 disco falhou → 500 WRITE_FAILED e a LINHA é desfeita (sem arquivo fantasma bloqueando o projeto)", async () => {
    diskError = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const res = await create({ path: "docs/adr/ADR-003-z.md", content: "# ADR\n" });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("WRITE_FAILED");
    expect(body.message).toMatch(/nada foi criado/);
    expect(body.message).toMatch(/ENOSPC/);              // a causa real chega ao humano
    expect(inserts()).toHaveLength(1);
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].params).toEqual([PROJ, "docs/adr", "ADR-003-z.md"]);   // exatamente a linha criada
    expect(written).toHaveLength(0);
    // e o projeto NÃO é marcado como sujo por uma criação que não aconteceu
    expect(queries.some((q) => /spec_dirty_at/.test(q.sql))).toBe(false);
  });

  it("caminho já existente (23505) → 409 EXISTS e NENHUM DELETE (a linha é de outro arquivo, vivo)", async () => {
    insertError = Object.assign(new Error("duplicate key"), { code: "23505" });
    const res = await create({ path: "docs/adr/ADR-002-fila.md", content: "# outro\n" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("EXISTS");
    expect(deletes()).toHaveLength(0);   // apagar aqui destruiria o arquivo do vencedor
    expect(written).toHaveLength(0);
  });

  it("guardas antes de qualquer escrita: traversal, token de serviço, status travado e teto de arquivos", async () => {
    expect((await create({ path: "../../../etc/passwd", content: "x" })).statusCode).toBe(400);

    currentUser = { id: "runner", role: "user", tenantId: TENANT, svc: "runner" };
    expect((await create({ path: "docs/adr/ADR-004-a.md", content: "x" })).statusCode).toBe(403);

    currentUser = { id: "u1", role: "tenant_admin", tenantId: TENANT };
    projectRow = { id: PROJ, tenant_id: TENANT, created_by: "u1", status: "running" };
    expect((await create({ path: "docs/adr/ADR-004-a.md", content: "x" })).statusCode).toBe(409);

    projectRow = { id: PROJ, tenant_id: TENANT, created_by: "u1", status: "draft" };
    fileCount = 200;
    const cheio = await create({ path: "docs/adr/ADR-004-a.md", content: "x" });
    expect(cheio.statusCode).toBe(413);
    expect((cheio.json() as { code: string }).code).toBe("TOO_MANY_FILES");

    expect(inserts()).toHaveLength(0);
    expect(written).toHaveLength(0);
  });
});
