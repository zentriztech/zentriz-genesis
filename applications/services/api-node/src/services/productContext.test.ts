/**
 * productContext.test.ts — Fase 1 do contexto de PRODUTO.
 *
 * O que estes testes protegem (na ordem em que a revisão adversarial os pediu):
 *  • GAP-2 tenant fail-closed: irmão de OUTRO tenant JAMAIS entra no mapa (a classe do vazamento
 *    cross-tenant de `/api/deadpool/*` — passar a consultar por `product_id` amplia a superfície);
 *  • GAP-4 linhagem: `archived` e `superseded_by` fora do mapa (senão v1/v2/v3 viram três irmãos);
 *  • GAP-12 produto de 1 projeto vigente não paga nada (8 de 13 produtos em prod);
 *  • GAP-11 spec ilegível no disco é REPORTADA, não omitida (omitir é o defeito D em outra roupa);
 *  • GAP-7 `connect.yaml` é whole-file-or-nothing (YAML cortado é contrato ilegível);
 *  • dependências vêm de `project_triggers` (o `dependsOn` do decompose; `project_links` está vazia).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProductMap, selectSiblingBodies, extractSections, type Queryable } from "./productContext.js";

const P_ANCHOR = "11111111-1111-1111-1111-111111111111";
const P_SIB = "22222222-2222-2222-2222-222222222222";
/** Irmão SEM aresta para o âncora e com spec grande: só entra no corpo se for citado. */
const P_SIB2 = "66666666-6666-6666-6666-666666666666";
const P_OTHER_TENANT = "33333333-3333-3333-3333-333333333333";
const P_ARCHIVED = "44444444-4444-4444-4444-444444444444";
const P_SUPERSEDED = "55555555-5555-5555-5555-555555555555";
const PRODUCT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let dir = "";
const files: Record<string, string> = {};

interface FakeProject {
  id: string; title: string; status: string; tenant_id: string | null; created_by: string | null;
  product_id: string | null; project_type: string | null; superseded_by?: string;
}

const PROJECTS: FakeProject[] = [
  { id: P_ANCHOR, title: "identity-svc", status: "on_bench", tenant_id: TENANT, created_by: "u1", product_id: PRODUCT, project_type: "backend_api_python" },
  { id: P_SIB, title: "tms", status: "accepted", tenant_id: TENANT, created_by: "u1", product_id: PRODUCT, project_type: "backend_api_python" },
  { id: P_SIB2, title: "billing", status: "accepted", tenant_id: TENANT, created_by: "u1", product_id: PRODUCT, project_type: "backend_api_python" },
  { id: P_OTHER_TENANT, title: "vizinho", status: "accepted", tenant_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", created_by: "u9", product_id: PRODUCT, project_type: "backend_api_python" },
  { id: P_ARCHIVED, title: "morto", status: "archived", tenant_id: TENANT, created_by: "u1", product_id: PRODUCT, project_type: "backend_api_python" },
  { id: P_SUPERSEDED, title: "v1-antigo", status: "accepted", tenant_id: TENANT, created_by: "u1", product_id: PRODUCT, project_type: "backend_api_python", superseded_by: P_SIB },
];

/**
 * Duplo de banco: interpreta as 4 consultas do serviço pelo prefixo do SQL e aplica os MESMOS
 * filtros do WHERE em memória (tenant, produto, linhagem). Não é um mock de retorno fixo — se o
 * serviço parar de filtrar, o teste vê o projeto proibido aparecer.
 */
function fakeDb(): Queryable {
  return {
    async query(q: string, p: unknown[] = []) {
      const sql = q.replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT p.id, p.title, p.status, p.product_id")) {
        const row = PROJECTS.find((x) => x.id === p[0]);
        return { rows: row ? [{ ...row, product_name: "Venuxx V2" }] : [] };
      }
      if (sql.startsWith("SELECT p.id, p.title, p.status, p.extra->>'project_type'")) {
        const [productId, scope] = p as [string, string | null];
        const byTenant = sql.includes("p.tenant_id IS NULL")
          ? (x: FakeProject) => x.tenant_id === null && x.created_by === scope
          : (x: FakeProject) => x.tenant_id === scope;
        const rows = PROJECTS
          .filter((x) => x.product_id === productId && byTenant(x))
          .filter((x) => x.status !== "archived" && !x.superseded_by)
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((x) => ({ id: x.id, title: x.title, status: x.status, project_type: x.project_type }));
        return { rows };
      }
      if (sql.startsWith("SELECT project_id, trigger_project_id FROM project_triggers")) {
        const ids = p[0] as string[];
        const edges = [{ project_id: P_ANCHOR, trigger_project_id: P_SIB }, { project_id: P_ANCHOR, trigger_project_id: P_OTHER_TENANT }];
        return { rows: edges.filter((e) => ids.includes(e.project_id) && ids.includes(e.trigger_project_id)) };
      }
      if (sql.startsWith("SELECT project_id, filename")) {
        const ids = p[0] as string[];
        const all = [
          { project_id: P_ANCHOR, filename: "identity.md", rel_dir: "", file_path: files.anchor },
          { project_id: P_SIB, filename: "tms.md", rel_dir: "", file_path: files.sib },
          { project_id: P_SIB, filename: "connect.yaml", rel_dir: "", file_path: files.connect },
          { project_id: P_SIB, filename: "sumiu.md", rel_dir: "", file_path: path.join(dir, "nao-existe.md") },
          { project_id: P_SIB2, filename: "billing.md", rel_dir: "", file_path: files.sib2 },
        ];
        return { rows: all.filter((f) => ids.includes(f.project_id)) };
      }
      throw new Error(`consulta não prevista no duplo: ${sql.slice(0, 60)}`);
    },
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "product-ctx-"));
  files.anchor = path.join(dir, "identity.md");
  files.sib = path.join(dir, "tms.md");
  files.connect = path.join(dir, "connect.yaml");
  files.sib2 = path.join(dir, "billing.md");
  await writeFile(files.anchor, "# identity\n\n## Contexto\ntexto\n\n## API\nrotas\n");
  await writeFile(files.sib, `# tms\n\n## Contexto\n${"x".repeat(400)}\n\n## Fluxos\ny\n`);
  // Maior que o piso de orçamento (14.000) — é o que força o corte de arquivo comum.
  await writeFile(files.sib2, `# billing\n\n## Cobrança\n${"b".repeat(20_000)}\n`);
  await writeFile(files.connect, `systemId: tms\nintegrationTier: tier2-deadpool-ready\n${"# comentario\n".repeat(30)}`);
});

afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("buildProductMap", () => {
  it("monta o mapa com os irmãos do MESMO tenant, produto e linhagem viva", async () => {
    const map = await buildProductMap(fakeDb(), P_ANCHOR);
    expect(map).not.toBeNull();
    const titles = map!.projects.map((p) => p.title);
    expect(titles).toEqual(["billing", "identity-svc", "tms"]);
    // GAP-2 / GAP-4: vizinho de outro tenant, arquivado e superado ficam FORA.
    expect(titles).not.toContain("vizinho");
    expect(titles).not.toContain("morto");
    expect(titles).not.toContain("v1-antigo");
  });

  it("marca o âncora e traz dependências de project_triggers (só dentro do escopo)", async () => {
    const map = await buildProductMap(fakeDb(), P_ANCHOR);
    const anchor = map!.projects.find((p) => p.isAnchor)!;
    expect(anchor.title).toBe("identity-svc");
    // A aresta para o projeto de outro tenant é descartada junto com o projeto.
    expect(anchor.dependsOn).toEqual(["tms"]);
    expect(map!.block).toContain("identity-svc ←");
    expect(map!.block).toContain("| tms |");
  });

  it("reporta spec ILEGÍVEL em vez de omitir a linha (GAP-11)", async () => {
    const map = await buildProductMap(fakeDb(), P_ANCHOR);
    expect(map!.warnings.some((w) => w.includes("ILEGÍVEL") && w.includes("sumiu.md"))).toBe(true);
    // O irmão continua no mapa, com os bytes dos arquivos que DERAM para ler.
    const sib = map!.projects.find((p) => p.title === "tms")!;
    expect(sib.bytes).toBeGreaterThan(0);
    expect(sib.sections).toContain("Contexto");
  });

  it("produto com 1 projeto vigente não gera bloco algum (GAP-12)", async () => {
    const db = fakeDb();
    const only: Queryable = {
      query: async (q, p) => {
        const res = await db.query(q, p);
        if (q.replace(/\s+/g, " ").includes("p.extra->>'project_type'")) {
          return { rows: res.rows.filter((r) => (r as { id: string }).id === P_ANCHOR) };
        }
        return res;
      },
    };
    const map = await buildProductMap(only, P_ANCHOR);
    expect(map!.projects).toHaveLength(1);
    expect(map!.block).toBe("");
  });

  it("projeto sem produto → sem mapa e sem consulta de irmãos", async () => {
    const db: Queryable = {
      query: async (q) => q.includes("p.product_id")
        ? { rows: [{ id: P_ANCHOR, title: "solto", product_id: null, tenant_id: TENANT, created_by: "u1", product_name: null }] }
        : (() => { throw new Error("não deveria consultar irmãos"); })(),
    };
    const map = await buildProductMap(db, P_ANCHOR);
    expect(map!.block).toBe("");
    expect(map!.projects).toEqual([]);
  });
});

describe("selectSiblingBodies", () => {
  it("prioriza o connect.yaml do irmão ligado por aresta", async () => {
    const map = await buildProductMap(fakeDb(), P_ANCHOR);
    const out = selectSiblingBodies(map!, {});
    expect(out.included[0]).toBe("tms/connect.yaml");
    expect(out.block).toContain("systemId: tms");
    expect(out.block).toContain("SOMENTE LEITURA");
  });

  it("corta arquivo comum mas nunca o connect.yaml — inteiro ou fora (GAP-7)", async () => {
    const map = await buildProductMap(fakeDb(), P_ANCHOR);
    // `billing.md` (20.000 chars) é citado nos findings e não cabe no orçamento junto do YAML:
    // o comum é CORTADO com a marca sem reticências; o contrato do irmão ligado vai inteiro.
    const out = selectSiblingBodies(map!, {
      budget: 15_000, // acima do piso de 14.000 e abaixo do corpo do billing
      findings: [{ file: "billing.md", line: null, severity: "blocker", title: "cobrança sem billing", rationale: "", source: "stage_a" }],
    });
    expect(out.included).toEqual(["tms/connect.yaml", "billing/billing.md"]);
    expect(out.block).toContain("integrationTier: tier2-deadpool-ready"); // YAML íntegro
    expect(out.block).toContain("[CORTE DE CONTEXTO]");
    expect(out.block).not.toContain("…"); // reticências disparariam `validate_response_quality`
    expect(out.block).not.toContain("b".repeat(20_000)); // o corpo NÃO foi enviado inteiro
    expect(out.block.length).toBeLessThan(16_500); // orçamento + cabeçalho/rótulos
  });

  it("traz o corpo do irmão citado nos findings ativos", async () => {
    const map = await buildProductMap(fakeDb(), P_ANCHOR);
    const out = selectSiblingBodies(map!, {
      findings: [{ file: "tms.md", line: null, severity: "blocker", title: "contrato divergente com tms", rationale: "", source: "stage_a" }],
    });
    expect(out.included).toContain("tms/tms.md");
  });

  it("lista quem ficou só no índice (o modelo precisa saber que existe)", async () => {
    const map = await buildProductMap(fakeDb(), P_ANCHOR);
    // Sem findings e sem citação: o único corpo é o connect.yaml do irmão LIGADO (tms).
    // `billing` não tem aresta nem citação → fica só no índice, e isso é dito por nome.
    const out = selectSiblingBodies(map!, {});
    expect(out.included).toEqual(["tms/connect.yaml"]);
    expect(out.block).toContain("apenas no MAPA");
    expect(out.block).toContain("billing");
  });
});

describe("extractSections", () => {
  it("pega H2 e ignora o que está dentro de cerca de código", () => {
    const md = "# t\n\n## Um\ntexto\n\n```\n## Falso\n```\n\n## Dois\n";
    expect(extractSections(md)).toEqual(["Um", "Dois"]);
  });
});
