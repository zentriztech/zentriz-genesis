/**
 * specVersions.test.ts — Onda 4 (A4.3): as rotas que finalmente EXPÕEM as versões da spec
 * (G2 / migração 092). O histórico existia desde 2026-09-05, mas só para quem tinha psql.
 *
 * O que estes testes travam (as três exigências da auditoria antes de expor):
 *  • **nunca conteúdo na listagem** — até 10 versões × ~100 kB por arquivo viajariam em toda
 *    troca de tela, e a spec inteira vazaria num endpoint de metadados;
 *  • **nunca path absoluto do servidor** — o mesmo motivo pelo qual `/spec-tree` nasceu sem
 *    `file_path`: a topologia de `/shared/uploads/<id>/…` não é assunto do cliente;
 *  • **guarda de tenant/projeto igual à do resto da família** — id de outro tenant é 404, e
 *    restaurar é ESCRITA de spec (token de serviço 403, status não-editável 409).
 *
 * E o invariante que dá sentido ao "restaurar": o conteúdo VIVO vira versão ANTES de ser
 * sobrescrito, como pré-condição — se o snapshot falha, nada é alterado (503).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sha256Hex } from "../lib/specTreeHash.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const PROJ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SNAP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UPLOADS = "/tmp/specversions-test-uploads";
const ABS = `${UPLOADS}/${PROJ}/backend/01-api.md`;

process.env.UPLOAD_DIR = UPLOADS;

/** Usuário mutável: os testes trocam papel/tenant/svc sem re-registrar o app. */
let currentUser: Record<string, unknown> = { id: "u1", role: "tenant_admin", tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = currentUser;
  },
}));

/** Projeto que o banco devolve (os testes ajustam tenant/status). */
let projectRow: Record<string, unknown> = { id: PROJ, tenant_id: TENANT, created_by: "u1", status: "draft" };
/** Linha da árvore para o `file_path` do snapshot — `null` simula arquivo removido (FILE_GONE). */
let treeRow: Record<string, unknown> | null = { rel_dir: "backend", filename: "01-api.md", file_path: ABS };

const queries: Array<{ sql: string; params: unknown[] }> = [];
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const s = sql.replace(/\s+/g, " ");
      if (s.includes("FROM projects WHERE id")) return { rows: projectRow ? [projectRow] : [] };
      if (s.includes("FROM project_spec_files")) return { rows: treeRow ? [treeRow] : [] };
      return { rows: [] };
    },
  },
}));

const snapshots = [
  { id: SNAP, filePath: ABS, contentSha256: "sha-antiga", chars: 1234, reason: "manual-file-edit",
    createdBy: "u1", createdAt: "2026-09-05T12:00:00.000Z" },
  { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", filePath: `${UPLOADS}/${PROJ}/spec.md`,
    contentSha256: "sha-2", chars: 99, reason: "autonomy:round-3", createdBy: null,
    createdAt: "2026-09-04T12:00:00.000Z" },
];
const listSpy = vi.fn(async () => snapshots);
const getSpy = vi.fn(async (_db: unknown, _pid: string, id: string) =>
  (id === SNAP ? { filePath: ABS, content: "# versão antiga\n" } : null));
const snapSpy = vi.fn(async () => true);
vi.mock("../services/specSnapshots.js", () => ({
  listSpecSnapshots: (db: unknown, pid: string, fp?: string | null) => listSpy(db as never, pid as never, fp as never),
  getSpecSnapshotContent: (db: unknown, pid: string, id: string) => getSpy(db, pid, id),
  snapshotSpecFile: (db: unknown, input: unknown) => snapSpy(db as never, input as never),
}));

const written: Array<{ file: string; content: string }> = [];
let liveContent: string | null = "# conteúdo VIVO\n";
vi.mock("fs/promises", () => ({
  default: {
    readFile: async () => (liveContent === null ? Promise.reject(new Error("ENOENT")) : Buffer.from(liveContent, "utf-8")),
    writeFile: async (file: string, content: string) => { written.push({ file, content }); },
    mkdir: async () => {},
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
  treeRow = { rel_dir: "backend", filename: "01-api.md", file_path: ABS };
  liveContent = "# conteúdo VIVO\n";
  queries.length = 0; written.length = 0;
  listSpy.mockClear(); getSpy.mockClear(); snapSpy.mockClear();
  snapSpy.mockImplementation(async () => true);
});

afterEach(async () => { await app.close(); });

describe("GET /api/projects/:id/spec-versions — listagem", () => {
  it("devolve METADADOS com path relativo: nem `content`, nem o caminho do servidor", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/spec-versions` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { editable: boolean; versions: Array<Record<string, unknown>> };
    expect(body.editable).toBe(true);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0]).toEqual({
      id: SNAP, path: "backend/01-api.md", chars: 1234, contentSha256: "sha-antiga",
      reason: "manual-file-edit", createdBy: "u1", createdAt: "2026-09-05T12:00:00.000Z",
    });
    expect(body.versions[1].path).toBe("spec.md");
    // O invariante em texto cru: nada de conteúdo e nada de /shared|/tmp no payload.
    expect(res.body).not.toContain("content\"");
    expect(res.body).not.toContain(UPLOADS);
  });

  it("`?path=` filtra pelo file_path ABSOLUTO da árvore (não pelo que o cliente mandou)", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/projects/${PROJ}/spec-versions?path=backend/01-api.md`,
    });
    expect(res.statusCode).toBe(200);
    expect(listSpy.mock.calls[0][2]).toBe(ABS);
  });

  it("`?path=` com traversal → 400 e nenhuma consulta de versão", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/spec-versions?path=../../etc/passwd` });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("BAD_PATH");
    expect(listSpy).not.toHaveBeenCalled();
  });

  /**
   * Defeito MEDIDO na prova ao vivo (prod, 2026-09-06): o arquivo em disco é o do upload
   * (`1785093867177-nvx-lastmile-backend.md`) e a árvore mostra `nvx-lastmile-backend.md`.
   * Derivando o nome do caminho físico, a lista exibia um arquivo que o humano nunca viu.
   */
  it("nome de exibição vem da ÁRVORE, não do arquivo físico do upload", async () => {
    const fisico = `${UPLOADS}/${PROJ}/1785093867177-nvx.md`;
    treeRow = { rel_dir: "", filename: "nvx.md", file_path: fisico };
    listSpy.mockImplementationOnce(async () => [{
      id: SNAP, filePath: fisico, contentSha256: "s", chars: 10, reason: "spec-chat",
      createdBy: null, createdAt: "2026-09-06T00:00:00.000Z",
    }]);
    const res = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/spec-versions` });
    expect(res.statusCode).toBe(200);
    expect(res.json().versions[0].path).toBe("nvx.md");
  });

  it("versão de arquivo já removido da árvore ainda aparece — sem caminho do servidor", async () => {
    treeRow = null; // nenhuma linha na árvore para mapear: cai no fallback do caminho físico
    const res = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/spec-versions` });
    expect(res.statusCode).toBe(200);
    const paths = (res.json().versions as Array<{ path: string }>).map((v) => v.path);
    expect(paths).toEqual(["backend/01-api.md", "spec.md"]);
    expect(res.body).not.toContain(UPLOADS);
  });

  it("projeto de OUTRO tenant → 404, sem tocar no histórico", async () => {
    projectRow = { id: PROJ, tenant_id: OTHER_TENANT, created_by: "outro", status: "draft" };
    const res = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/spec-versions` });
    expect(res.statusCode).toBe(404);
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/:id/spec-versions/:snapshotId — conteúdo", () => {
  it("devolve o conteúdo com sha recalculado e path relativo", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/spec-versions/${SNAP}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, string>;
    expect(body.content).toBe("# versão antiga\n");
    expect(body.path).toBe("backend/01-api.md");
    expect(body.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    // A guarda de tenant é do serviço: o `project_id` do usuário entra no WHERE.
    expect(getSpy.mock.calls[0][1]).toBe(PROJ);
  });

  it("versão inexistente (ou de outro projeto) → 404", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/spec-versions/${SNAP.replace("c", "e")}` });
    expect(res.statusCode).toBe(404);
  });

  it("id fora do formato uuid: o erro do Postgres não vira 500", async () => {
    getSpy.mockRejectedValueOnce(new Error('invalid input syntax for type uuid: "nope"'));
    const res = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/spec-versions/nope` });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/projects/:id/spec-versions/:id/restore — escrita", () => {
  it("restaura: guarda o VIVO como versão ANTES de sobrescrever e atualiza o sha da árvore", async () => {
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/spec-versions/${SNAP}/restore` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, path: "backend/01-api.md", chars: "# versão antiga\n".length });
    // Ordem importa: o snapshot do vivo é PRÉ-condição da escrita.
    expect(snapSpy).toHaveBeenCalledTimes(1);
    const input = snapSpy.mock.calls[0][1] as unknown as Record<string, string>;
    expect(input.content).toBe("# conteúdo VIVO\n");
    expect(input.reason).toContain("pre-restore:");
    expect(written).toEqual([{ file: ABS, content: "# versão antiga\n" }]);
    expect(queries.some((q) => q.sql.includes("UPDATE project_spec_files SET content_sha256"))).toBe(true);
  });

  it("snapshot do conteúdo vivo falhou → 503 e NADA é escrito", async () => {
    snapSpy.mockImplementation(async () => false);
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/spec-versions/${SNAP}/restore` });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("SNAPSHOT_FAILED");
    expect(written).toHaveLength(0);
  });

  it("arquivo já não está na árvore da spec → 409 FILE_GONE", async () => {
    treeRow = null;
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/spec-versions/${SNAP}/restore` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("FILE_GONE");
    expect(written).toHaveLength(0);
  });

  it("conteúdo vivo já é igual à versão → no-op idempotente, sem versão nova", async () => {
    liveContent = "# versão antiga\n";
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/spec-versions/${SNAP}/restore` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, unchanged: true, path: "backend/01-api.md" });
    expect(snapSpy).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it("token de serviço (runner) → 403: restaurar spec é autoria humana", async () => {
    currentUser = { id: "runner", role: "tenant_admin", tenantId: TENANT, svc: "runner" };
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/spec-versions/${SNAP}/restore` });
    expect(res.statusCode).toBe(403);
    expect(written).toHaveLength(0);
  });

  it("projeto em status não-editável → 409 SPEC_LOCKED", async () => {
    projectRow = { id: PROJ, tenant_id: TENANT, created_by: "u1", status: "running" };
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/spec-versions/${SNAP}/restore` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("SPEC_LOCKED");
    expect(written).toHaveLength(0);
  });

  it("arquivo vivo ausente no disco: restaura sem exigir snapshot do que não existe", async () => {
    liveContent = null;
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/spec-versions/${SNAP}/restore` });
    expect(res.statusCode).toBe(200);
    expect(snapSpy).not.toHaveBeenCalled();
    expect(written).toEqual([{ file: ABS, content: "# versão antiga\n" }]);
  });
});

/**
 * O editor por-arquivo é hoje o caminho humano PRINCIPAL de escrita e era o ÚNICO write de spec
 * sem rede de segurança: o `PATCH /spec-content` e o laço autônomo já guardavam a versão
 * anterior. Sem isto, "restaurar" só ofereceria versões produzidas por agentes.
 */
describe("PUT /api/projects/:id/spec-file — G2: guarda a versão anterior", () => {
  const liveSha = () => sha256Hex(Buffer.from("# conteúdo VIVO\n", "utf-8"));

  it("salvar guarda o conteúdo anterior como versão (reason manual-file-edit)", async () => {
    const res = await app.inject({
      method: "PUT", url: `/api/projects/${PROJ}/spec-file?path=backend/01-api.md`,
      payload: { content: "# novo texto\n", baseSha: liveSha() },
    });
    expect(res.statusCode).toBe(200);
    const input = snapSpy.mock.calls[0][1] as unknown as Record<string, string>;
    expect(input).toMatchObject({ projectId: PROJ, filePath: ABS, content: "# conteúdo VIVO\n", reason: "manual-file-edit" });
    expect(written).toEqual([{ file: ABS, content: "# novo texto\n" }]);
  });

  it("salvar conteúdo IDÊNTICO não gera versão (o histórico não enche de cópias)", async () => {
    const res = await app.inject({
      method: "PUT", url: `/api/projects/${PROJ}/spec-file?path=backend/01-api.md`,
      payload: { content: "# conteúdo VIVO\n", baseSha: liveSha() },
    });
    expect(res.statusCode).toBe(200);
    expect(snapSpy).not.toHaveBeenCalled();
  });

  it("baseSha divergente → 409 e nenhuma versão gravada (o conflito vem antes)", async () => {
    const res = await app.inject({
      method: "PUT", url: `/api/projects/${PROJ}/spec-file?path=backend/01-api.md`,
      payload: { content: "# novo texto\n", baseSha: "sha-velho" },
    });
    expect(res.statusCode).toBe(409);
    expect(snapSpy).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });
});
