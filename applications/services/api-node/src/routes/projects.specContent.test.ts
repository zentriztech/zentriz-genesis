/**
 * projects.specContent.test.ts — H2 (revisão adversarial das ações da Bancada, Onda 2):
 * `PATCH /api/projects/:id/spec-content` era o ÚNICO caminho de escrita da spec sem pré-condição.
 *
 * Modo de falha real: com o modo autônomo ligado, o servidor reescreve o arquivo primário a cada
 * rodada. Uma aba aberta antes disso ainda tem o texto velho no editor; "Salvar rascunho"
 * sobrescrevia o disco às cegas e apagava as rodadas do CTO sem avisar ninguém.
 * O `baseSha` é OPCIONAL de propósito: a api sobe antes do portal, e um cliente que ainda não sabe
 * mandá-lo precisa continuar salvando como antes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PROJ_ID = "44444444-4444-4444-8444-444444444444";

let currentUser: { id: string; role: "user" | "tenant_admin" | "zentriz_admin"; tenantId: string | null; svc?: string } = {
  id: "u1", role: "zentriz_admin", tenantId: null,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = currentUser;
  },
}));

const captured: Array<{ sql: string; params: unknown[] }> = [];
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] });
vi.mock("../db/client.js", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => { captured.push({ sql, params }); return queryHandler(sql, params); },
      release: () => {},
    }),
    query: async (sql: string, params: unknown[] = []) => { captured.push({ sql, params }); return queryHandler(sql, params); },
  },
}));

let app: FastifyInstance;
let specPath: string;
const sha = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
const ON_DISK = "# Spec de verdade\n\nConteúdo que o laço autônomo gravou na última rodada.\n";

beforeEach(async () => {
  const { projectRoutes } = await import("./projects.js");
  app = Fastify();
  await app.register(projectRoutes);
  await app.ready();
  captured.length = 0;
  currentUser = { id: "u1", role: "zentriz_admin", tenantId: null };
  specPath = join(mkdtempSync(join(tmpdir(), "spec-content-")), "spec.md");
  writeFileSync(specPath, ON_DISK, "utf-8");
  queryHandler = (sql: string) => {
    if (/FROM projects p WHERE p\.id/.test(sql)) {
      return { rows: [{ id: PROJ_ID, tenant_id: null, created_by: "u1", status: "draft", title: "NVX" }] };
    }
    if (/FROM project_spec_files WHERE project_id = \$1\s+ORDER BY is_primary/.test(sql)) {
      return { rows: [{ file_path: specPath, filename: "spec.md" }] };
    }
    return { rows: [] };
  };
});

function patch(body: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/api/projects/${PROJ_ID}/spec-content`, payload: body });
}

describe("GET /spec-content — o sha do que foi lido viaja com o conteúdo (H2)", () => {
  it("devolve contentSha256 do disco (base do If-Match do editor)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/projects/${PROJ_ID}/spec-content` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { specMarkdown: string; contentSha256: string };
    expect(body.specMarkdown).toBe(ON_DISK);
    expect(body.contentSha256).toBe(sha(ON_DISK));
  });
});

describe("PATCH /spec-content — pré-condição (H2)", () => {
  it("🔴 baseSha DIVERGENTE → 409 CONFLICT e o disco fica INTACTO", async () => {
    const r = await patch({ specMarkdown: "# texto velho da aba antiga\n", baseSha: sha("outra coisa") });
    expect(r.statusCode).toBe(409);
    const body = r.json() as { code: string; currentSha: string };
    expect(body.code).toBe("CONFLICT");
    expect(body.currentSha).toBe(sha(ON_DISK));            // o editor recebe o sha real para reagir
    expect(readFileSync(specPath, "utf-8")).toBe(ON_DISK);  // a rodada do laço NÃO foi apagada
    expect(captured.some((q) => /UPDATE project_spec_files SET content_sha256/.test(q.sql))).toBe(false);
  });

  it("baseSha IGUAL ao disco → grava e atualiza o content_sha256 com o sha novo", async () => {
    const novo = "# Spec revisada pelo humano\n";
    const r = await patch({ specMarkdown: novo, baseSha: sha(ON_DISK) });
    expect(r.statusCode).toBe(200);
    expect(readFileSync(specPath, "utf-8")).toBe(novo);
    const upd = captured.find((q) => /UPDATE project_spec_files SET content_sha256/.test(q.sql));
    expect(upd?.params[0]).toBe(sha(novo));
    expect((r.json() as { contentSha256: string }).contentSha256).toBe(sha(novo));
  });

  it("SEM baseSha → grava como antes (cliente anterior ao deploy continua salvando)", async () => {
    const r = await patch({ specMarkdown: "# sem pré-condição\n" });
    expect(r.statusCode).toBe(200);
    expect(readFileSync(specPath, "utf-8")).toBe("# sem pré-condição\n");
  });

  it("a pré-condição NÃO enfraquece as guardas anteriores: svc runner e status não editável", async () => {
    currentUser = { id: "runner", role: "user", tenantId: null, svc: "runner" };
    expect((await patch({ specMarkdown: "x".repeat(10), baseSha: sha(ON_DISK) })).statusCode).toBe(403);
    currentUser = { id: "u1", role: "zentriz_admin", tenantId: null };
    queryHandler = (sql: string) => {
      if (/FROM projects p WHERE p\.id/.test(sql)) {
        return { rows: [{ id: PROJ_ID, tenant_id: null, created_by: "u1", status: "running", title: "NVX" }] };
      }
      if (/FROM project_spec_files WHERE project_id = \$1\s+ORDER BY is_primary/.test(sql)) {
        return { rows: [{ file_path: specPath, filename: "spec.md" }] };
      }
      return { rows: [] };
    };
    const locked = await patch({ specMarkdown: "y".repeat(10), baseSha: sha(ON_DISK) });
    expect(locked.statusCode).toBe(409);
    expect((locked.json() as { code: string }).code).toBe("SPEC_LOCKED");
    expect(readFileSync(specPath, "utf-8")).toBe(ON_DISK);
  });
});
