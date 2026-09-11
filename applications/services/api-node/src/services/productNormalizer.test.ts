/**
 * productNormalizer.test.ts — o que se prova aqui é o que o adversarial da RFC-0008 Emenda 01
 * apontou como risco, não o caminho feliz:
 *   • o HASH condiciona o botão (determinístico, sensível ao conteúdo, insensível à ordem);
 *   • o VETO da saída do LLM (target forjado, documento vazio, ready=false, plano sem RFC);
 *   • a regra ANTI-LAVAGEM (não sobrescrever spec editada depois de aprovada);
 *   • os ÍNDICES são deterministas e com links relativos.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { computeCurrentSpecHashMock, upsertSpecFileMock } = vi.hoisted(() => ({
  computeCurrentSpecHashMock: vi.fn(),
  // Assinatura declarada (db, projectId, relPath, content, overwrite): sem os parâmetros o TS infere
  // `calls` como tupla VAZIA e `c[2]` (o caminho do arquivo) vira erro de compilação.
  upsertSpecFileMock: vi.fn(async (..._args: unknown[]) => "created" as const),
}));
vi.mock("./specValidation.js", () => ({ computeCurrentSpecHash: computeCurrentSpecHashMock }));
vi.mock("./evolutionPlanner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./evolutionPlanner.js")>()),
  upsertSpecFile: upsertSpecFileMock,
}));

import {
  computeProductSpecHash,
  loadProductProjects,
  parseNormalization,
  applyNormalization,
  isProductNormalized,
  renderFolderReadme,
  renderProjectReadme,
  NormalizationError,
  NORMALIZED_CHECK_MAX_FILES,
  type ProductProjectRow,
  type NormalizationContext,
  type Queryable,
} from "./productNormalizer.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const PRODUCT = "99999999-9999-4999-8999-999999999999";

function proj(id: string, title: string, extra: Record<string, unknown> = {}): ProductProjectRow {
  return { projectId: id, title, status: "draft", projectType: null, extra };
}

function fakeDb(handler: (sql: string, params?: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number }) {
  return { query: async (sql: string, params?: unknown[]) => handler(sql, params) } as unknown as Queryable & {
    query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  };
}

const PRODUCT_ID = { id: PRODUCT, systemId: "nvx-lastmile", name: "VNX LastMile" };

beforeEach(() => {
  computeCurrentSpecHashMock.mockReset();
  upsertSpecFileMock.mockReset();
  upsertSpecFileMock.mockResolvedValue("created");
});
afterEach(() => vi.restoreAllMocks());

describe("computeProductSpecHash — o que condiciona o botão", () => {
  const db = fakeDb(() => ({ rows: [] }));

  it("é determinístico e NÃO depende da ordem em que os projetos chegam", async () => {
    computeCurrentSpecHashMock.mockImplementation(async (_db: unknown, id: string) => ({
      specHash: id === P1 ? "aaa" : "bbb", files: [],
    }));
    const a = await computeProductSpecHash(db, PRODUCT_ID, [proj(P1, "A"), proj(P2, "B")]);
    const b = await computeProductSpecHash(db, PRODUCT_ID, [proj(P2, "B"), proj(P1, "A")]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("muda quando a spec de UM projeto muda — é isso que retrava o promover", async () => {
    computeCurrentSpecHashMock.mockImplementation(async (_db: unknown, id: string) => ({
      specHash: id === P1 ? "aaa" : "bbb", files: [],
    }));
    const antes = await computeProductSpecHash(db, PRODUCT_ID, [proj(P1, "A"), proj(P2, "B")]);
    computeCurrentSpecHashMock.mockImplementation(async (_db: unknown, id: string) => ({
      specHash: id === P1 ? "aaa" : "bbb-EDITADO", files: [],
    }));
    const depois = await computeProductSpecHash(db, PRODUCT_ID, [proj(P1, "A"), proj(P2, "B")]);
    expect(depois.hash).not.toBe(antes.hash);
  });

  it("renomear o produto (ou mudar o system_id) também invalida a normalização", async () => {
    computeCurrentSpecHashMock.mockResolvedValue({ specHash: "aaa", files: [] });
    const a = await computeProductSpecHash(db, PRODUCT_ID, [proj(P1, "A")]);
    const b = await computeProductSpecHash(db, { ...PRODUCT_ID, name: "Outro nome" }, [proj(P1, "A")]);
    const c = await computeProductSpecHash(db, { ...PRODUCT_ID, systemId: "nvx-outro" }, [proj(P1, "A")]);
    expect(new Set([a.hash, b.hash, c.hash]).size).toBe(3);
  });

  it("projeto com arquivo sumido do disco é DECLARADO em missing (não entra no hash em silêncio)", async () => {
    computeCurrentSpecHashMock.mockImplementation(async (_db: unknown, id: string) =>
      id === P1 ? { specHash: "aaa", files: [] } : null);
    const fp = await computeProductSpecHash(db, PRODUCT_ID, [proj(P1, "A"), proj(P2, "B")]);
    expect(fp.missing).toEqual([P2]);
    expect(fp.perProject).toHaveLength(1);
  });
});

describe("loadProductProjects — o recorte é 'spec viva', não 'spec na Bancada'", () => {
  /**
   * O recorte antigo (`status IN ('draft','promoted')`) devolvia vazio para os 15 produtos de prod
   * (medido em 2026-09-11) — o [Normalizar] de produto respondia NO_PROJECTS no parque inteiro,
   * que foi o "não temos RFC/ADR" relatado pelo Jean. Estes testes prendem o recorte novo.
   */
  function capture() {
    const sqls: string[] = [];
    const db = fakeDb((sql) => {
      sqls.push(sql);
      return { rows: [
        { id: P1, title: "Backend", status: "spec_submitted", extra: { a: 1 }, project_type: "service" },
        { id: P2, title: "App", status: "accepted", extra: null, project_type: null },
      ] };
    });
    return { sqls, db };
  }

  it("inclui spec em QUALQUER estado vivo — inclusive já aceita pela Fábrica", async () => {
    const { sqls, db } = capture();
    const rows = await loadProductProjects(db, PRODUCT);
    expect(rows.map((r) => r.status)).toEqual(["spec_submitted", "accepted"]);
    expect(sqls[0]).not.toContain("'draft','promoted'");
  });

  it("exclui o que não é spec viva: arquivada e substituída (superseded_by)", async () => {
    const { sqls, db } = capture();
    await loadProductProjects(db, PRODUCT);
    expect(sqls[0]).toContain("p.status <> 'archived'");
    expect(sqls[0]).toContain("superseded_by");
  });

  it("normaliza `extra` nulo para objeto — o prompt não pode receber null", async () => {
    const { db } = capture();
    const rows = await loadProductProjects(db, PRODUCT);
    expect(rows[1].extra).toEqual({});
    expect(rows[0].projectType).toBe("service");
  });
});

describe("parseNormalization — o VETO da saída do agente", () => {
  const targets = new Set([P1, P2]);
  const rfcOk = {
    target: "product", slug: "ingestao", title: "Ingestão idempotente",
    content: "# Ingestão\n\n## Sumário\nTexto suficientemente longo para passar do piso de 40 chars.",
  };

  it("aceita JSON dentro de cerca EXTERNA (o conteúdo do RFC tem cercas internas)", () => {
    const body = "```json\n" + JSON.stringify({ summary: "ok", rfcs: [rfcOk] }) + "\n```";
    const plan = parseNormalization(body, targets);
    expect(plan.rfcs).toHaveLength(1);
    expect(plan.rfcs[0].slug).toBe("ingestao");
  });

  it("DESCARTA documento cujo target não é projeto deste produto (id forjado não vira escrita)", () => {
    const plan = parseNormalization(JSON.stringify({
      rfcs: [rfcOk, { ...rfcOk, slug: "outro", target: "00000000-0000-4000-8000-000000000000" }],
    }), targets);
    expect(plan.rfcs.map((r) => r.slug)).toEqual(["ingestao"]);
    expect(plan.warnings.join(" ")).toContain("não é um projeto deste produto");
  });

  it("DESCARTA documento sem título ou com conteúdo curto demais", () => {
    const plan = parseNormalization(JSON.stringify({
      rfcs: [rfcOk, { ...rfcOk, slug: "vazio", content: "curto" }, { ...rfcOk, slug: "sem-titulo", title: "" }],
    }), targets);
    expect(plan.rfcs).toHaveLength(1);
  });

  it("ready=false vira NOT_READY com os blockers — travar é melhor que inventar", () => {
    try {
      parseNormalization(JSON.stringify({ ready: false, blockers: ["spec só tem título"], rfcs: [rfcOk] }), targets);
      throw new Error("deveria ter lançado");
    } catch (e) {
      expect(e).toBeInstanceOf(NormalizationError);
      expect((e as NormalizationError).code).toBe("NOT_READY");
      expect((e as NormalizationError).details.blockers).toEqual(["spec só tem título"]);
    }
  });

  it("plano sem nenhum RFC é recusado (PLAN_WITHOUT_RFC) — não há normalização muda", () => {
    expect(() => parseNormalization(JSON.stringify({ rfcs: [], adrs: [] }), targets))
      .toThrowError(/PLAN_WITHOUT_RFC|nenhum RFC/);
  });

  it("resposta sem JSON legível é recusada em vez de virar documento vazio", () => {
    expect(() => parseNormalization("desculpe, não consigo ajudar", targets)).toThrowError(NormalizationError);
  });

  it("decision com campos fora do enum cai no padrão seguro (status proposed, compat null)", () => {
    const plan = parseNormalization(JSON.stringify({
      rfcs: [rfcOk],
      decisions: [{ decisionId: "ingestao", kind: "banana", title: "Ingestão", status: "aprovadíssimo", compat: "gigante" }],
    }), targets);
    expect(plan.decisions[0]).toMatchObject({ kind: "rfc", status: "proposed", compat: null, scope: "product" });
  });
});

describe("applyNormalization — anti-lavagem e numeração", () => {
  function ctxOf(projects: ProductProjectRow[]): NormalizationContext {
    return {
      productId: PRODUCT, productName: "VNX LastMile", systemId: "nvx-lastmile", description: null,
      projects: projects.map((p) => ({ ...p, files: ["spec.md"], specHead: "spec", existingRfcs: [], existingAdrs: [] })),
      truncated: [], nextRfcSeq: 7, nextAdrSeq: 3, anchorProjectId: projects[0].projectId,
    };
  }
  const plan = () => ({
    summary: "", ready: true as const, blockers: [], warnings: [], decisions: [],
    rfcs: [{ target: "product", slug: "ingestao", title: "Ingestão", content: "## Sumário\nconteúdo longo o bastante para passar." }],
    adrs: [],
  });

  it("PULA projeto cuja spec foi editada depois da aprovação — normalizar não lava a edição", async () => {
    computeCurrentSpecHashMock.mockResolvedValue({ specHash: "hash-do-disco-AGORA", files: [] });
    const db = fakeDb((sql) => {
      if (sql.includes("UPDATE products")) return { rows: [{ next_rfc_seq: 8, next_adr_seq: 3 }] };
      return { rows: [] };
    });
    const ctx = ctxOf([
      proj(P1, "Aprovado e intacto", { spec_approved: true, spec_hash: "hash-do-disco-AGORA" }),
      proj(P2, "Aprovado e EDITADO", { spec_approved: true, spec_hash: "hash-antigo" }),
    ]);
    const out = await applyNormalization(db as never, ctx, plan());
    expect(out.skippedProjects.map((s) => s.projectId)).toEqual([P2]);
    expect(out.skippedProjects[0].reason).toMatch(/editada após a aprovação/);
    expect([...out.touched]).toEqual([P1]);
  });

  it("recusa tudo (SPEC_FILES_MISSING) se NENHUM projeto pode ser escrito sem lavar edição", async () => {
    computeCurrentSpecHashMock.mockResolvedValue({ specHash: "outro", files: [] });
    const db = fakeDb(() => ({ rows: [] }));
    const ctx = ctxOf([proj(P1, "Editado", { spec_approved: true, spec_hash: "hash-antigo" })]);
    await expect(applyNormalization(db as never, ctx, plan())).rejects.toThrowError(NormalizationError);
  });

  it("re-carimba o spec_hash do projeto aprovado guardando o ANTERIOR (rastro auditável)", async () => {
    computeCurrentSpecHashMock
      .mockResolvedValueOnce({ specHash: "hash-antes", files: [] })   // checagem anti-lavagem
      .mockResolvedValue({ specHash: "hash-depois", files: [] });      // recomputado após escrever
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    const db = fakeDb((sql, params) => {
      seen.push({ sql, params });
      if (sql.includes("UPDATE products")) return { rows: [{ next_rfc_seq: 8, next_adr_seq: 3 }] };
      return { rows: [] };
    });
    const ctx = ctxOf([proj(P1, "Aprovado", { spec_approved: true, spec_hash: "hash-antes" })]);
    await applyNormalization(db as never, ctx, plan());
    const stamp = seen.find((s) => s.sql.includes("spec_hash_prev"));
    expect(stamp).toBeTruthy();
    expect(stamp!.params).toEqual([P1, "hash-depois", "hash-antes", expect.any(String)]);
  });

  it("NÃO mexe no spec_hash de projeto que nunca foi aprovado (não há gate a satisfazer)", async () => {
    computeCurrentSpecHashMock.mockResolvedValue({ specHash: "x", files: [] });
    const seen: string[] = [];
    const db = fakeDb((sql) => {
      seen.push(sql);
      if (sql.includes("UPDATE products")) return { rows: [{ next_rfc_seq: 8, next_adr_seq: 3 }] };
      return { rows: [] };
    });
    await applyNormalization(db as never, ctxOf([proj(P1, "Rascunho")]), plan());
    expect(seen.some((s) => s.includes("spec_hash_prev"))).toBe(false);
  });

  it("numera a partir do que o UPDATE ... RETURNING devolveu (alocação atômica, sem colisão)", async () => {
    computeCurrentSpecHashMock.mockResolvedValue({ specHash: "x", files: [] });
    const db = fakeDb((sql) => {
      if (sql.includes("UPDATE products")) return { rows: [{ next_rfc_seq: 43, next_adr_seq: 3 }] };
      return { rows: [] };
    });
    await applyNormalization(db as never, ctxOf([proj(P1, "A")]), plan());
    const paths = upsertSpecFileMock.mock.calls.map((c) => c[2] as string);
    expect(paths).toContain("docs/rfc/RFC-0042-ingestao.md");
  });

  it("o RFC gravado carrega o cabeçalho de PROVENIÊNCIA (a Fábrica lê isto como spec)", async () => {
    computeCurrentSpecHashMock.mockResolvedValue({ specHash: "x", files: [] });
    const db = fakeDb((sql) =>
      sql.includes("UPDATE products") ? { rows: [{ next_rfc_seq: 8, next_adr_seq: 3 }] } : { rows: [] });
    await applyNormalization(db as never, ctxOf([proj(P1, "A")]), plan());
    const rfc = upsertSpecFileMock.mock.calls.find((c) => String(c[2]).startsWith("docs/rfc/"));
    expect(String(rfc?.[3])).toContain("Gerado pela Bancada");
    expect(String(rfc?.[3])).toMatch(/^# RFC-0007 — Ingestão/);
  });

  it("decision-record sem documento correspondente é DESCARTADA (índice nunca aponta para o vazio)", async () => {
    computeCurrentSpecHashMock.mockResolvedValue({ specHash: "x", files: [] });
    const db = fakeDb((sql) =>
      sql.includes("UPDATE products") ? { rows: [{ next_rfc_seq: 8, next_adr_seq: 3 }] } : { rows: [] });
    const p = { ...plan(), decisions: [
      { decisionId: "ingestao", kind: "rfc" as const, title: "Ingestão", status: "proposed", scope: "product" as const, summary: null, compat: null, tags: [] },
      { decisionId: "fantasma", kind: "rfc" as const, title: "Fantasma", status: "proposed", scope: "product" as const, summary: null, compat: null, tags: [] },
    ] };
    await applyNormalization(db as never, ctxOf([proj(P1, "A")]), p);
    const jsons = upsertSpecFileMock.mock.calls.map((c) => String(c[2])).filter((s) => s.startsWith("docs/decisions/"));
    expect(jsons).toHaveLength(1);
    expect(jsons[0]).toContain("ingestao");
    expect(p.warnings.join(" ")).toContain("fantasma");
  });

  it("o decision-record gravado valida contra o schema Connect (campos obrigatórios presentes)", async () => {
    computeCurrentSpecHashMock.mockResolvedValue({ specHash: "x", files: [] });
    const db = fakeDb((sql) =>
      sql.includes("UPDATE products") ? { rows: [{ next_rfc_seq: 8, next_adr_seq: 3 }] } : { rows: [] });
    const p = { ...plan(), decisions: [
      { decisionId: "ingestao", kind: "rfc" as const, title: "Ingestão", status: "proposed", scope: "product" as const, summary: "resumo", compat: "minor", tags: ["x"] },
    ] };
    await applyNormalization(db as never, ctxOf([proj(P1, "A")]), p);
    const call = upsertSpecFileMock.mock.calls.find((c) => String(c[2]).startsWith("docs/decisions/"));
    const rec = JSON.parse(String(call?.[3])) as Record<string, unknown>;
    for (const k of ["schemaVersion", "decisionId", "kind", "number", "title", "status", "scope", "productId", "path", "createdBy", "createdAt"]) {
      expect(rec[k], `campo obrigatório ${k}`).toBeDefined();
    }
    expect(rec.createdBy).toBe("workbench");
    expect(rec.path).toBe("docs/rfc/RFC-0007-ingestao.md");
  });
});

describe("índices (README) — transporte escrito por CÓDIGO", () => {
  it("lista em ordem binária estável e com links RELATIVOS", () => {
    const md = renderFolderReadme("docs/rfc", "RFCs", "intenção", [
      { filename: "RFC-0010-b.md", title: "B" },
      { filename: "RFC-0002-a.md", title: "A" },
    ]);
    expect(md.indexOf("RFC-0002-a.md")).toBeLessThan(md.indexOf("RFC-0010-b.md"));
    expect(md).toContain("[RFC-0002-a.md](./RFC-0002-a.md)");
    expect(md).not.toMatch(/\]\(\//); // nenhum link absoluto
  });

  it("o índice do projeto só lista pastas que têm documento", () => {
    const md = renderProjectReadme("Backend", "VNX LastMile", [
      { dir: "docs/rfc", label: "RFC", count: 2 },
      { dir: "docs/adr", label: "ADR", count: 0 },
    ], ["spec.md", "docs/rfc/RFC-0001-x.md"]);
    expect(md).toContain("docs/rfc");
    expect(md).not.toContain("docs/adr");
    expect(md).toContain("[spec.md](./spec.md)");
  });
});

describe("isProductNormalized — a leitura barata que a listagem usa", () => {
  it("sem normalized_hash é false SEM tocar o disco", async () => {
    const db = fakeDb(() => { throw new Error("não deveria consultar"); });
    const r = await isProductNormalized(db, { ...PRODUCT_ID, normalizedHash: null });
    expect(r.normalized).toBe(false);
  });

  it("produto grande demais devolve null (o /promote decide com o hash real)", async () => {
    const db = fakeDb(() => ({ rows: [{ n: NORMALIZED_CHECK_MAX_FILES + 1 }] }));
    const r = await isProductNormalized(db, { ...PRODUCT_ID, normalizedHash: "abc" });
    expect(r.normalized).toBeNull();
  });

  it("hash igual ⇒ true; hash diferente ⇒ false", async () => {
    computeCurrentSpecHashMock.mockResolvedValue({ specHash: "aaa", files: [] });
    const db = fakeDb((sql) => {
      if (sql.includes("count(*)")) return { rows: [{ n: 3 }] };
      return { rows: [{ id: P1, title: "A", status: "draft", extra: {}, project_type: null }] };
    });
    const fp = await computeProductSpecHash(db, PRODUCT_ID, [proj(P1, "A")]);
    expect((await isProductNormalized(db, { ...PRODUCT_ID, normalizedHash: fp.hash })).normalized).toBe(true);
    expect((await isProductNormalized(db, { ...PRODUCT_ID, normalizedHash: "outro" })).normalized).toBe(false);
  });
});
