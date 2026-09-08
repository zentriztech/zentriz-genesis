/**
 * productTraceability.test.ts — o relatório de rastreabilidade tem de ser VERDADE, não vitrine.
 *
 * Os riscos que estes testes protegem (todos já vistos neste projeto em outra roupa):
 *  • **corte calado** — teto que morde e apaga trabalho sem aparecer no relatório (a família do
 *    GAP-116/tetos: número de orçamento usado como julgamento). Aqui todo corte tem de sair em
 *    `truncated[]` com quanto ficou de fora, e o que fica das rodadas são as MAIS RECENTES;
 *  • **"julgado" sem amarração de conteúdo** — dizer que o juiz leu um arquivo cujo sha não é o do
 *    disco (GAP-18). `judgedFullAtThisContent` só é `true` quando o sha bate;
 *  • **"nada mudou" falso** — no perfil `mixed` sem promoção nenhuma, o recorte temporal NÃO existe;
 *    inventar `changedSince` esconderia a construção inteira de um produto nunca promovido;
 *  • **relatório que escreve** — é leitura pura: nenhum INSERT/UPDATE/DELETE, nenhuma validação
 *    disparada (a matriz do duplo é FECHADA: SQL não previsto explode o teste).
 *
 * Exige disco real: o inventário sai de `computeCurrentSpecHash`, que lê bytes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildTraceabilityReport, isTraceabilityProfile, LIMITS, TRACEABILITY_PROFILES,
} from "./productTraceability.js";

const PROD = "aaaaaaaa-0000-0000-0000-000000000001";
const PROJ = "bbbbbbbb-0000-0000-0000-000000000001";
const RUN = "cccccccc-0000-0000-0000-000000000001";
const PROMO = "dddddddd-0000-0000-0000-000000000001";

const SPEC = "# NVX LastMile\n\n## Objetivo\nEntregar.\n";
const DIAGRAMS = [
  "# Arquitetura — desenhos", "", "## Modelo global", "```mermaid", "graph TD", "  A-->B", "```",
  "", "## APIs", "```mermaid", "sequenceDiagram", "  A->>B: POST /x", "```",
  "", "## Infra", "```mermaid", "graph LR", "  ALB-->ECS", "```", "",
].join("\n");

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface Fixture {
  dir: string;
  product: Record<string, unknown> | null;
  projects: Array<Record<string, unknown>>;
  files: Array<{ filename: string; rel_dir: string; file_path: string; is_primary: boolean; stage_b_full_sha: string | null }>;
  validations: Array<Record<string, unknown>>;
  verdicts: Array<Record<string, unknown>>;
  triage: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  autonomy: Array<Record<string, unknown>>;
  pipelines: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  promotions: Array<Record<string, unknown>>;
  promotionItems: Array<Record<string, unknown>>;
  deployments: Array<Record<string, unknown>>;
  repos: Array<Record<string, unknown>>;
  seen: string[];
}
let fx: Fixture;

/** Duplo de banco com matriz FECHADA — consulta não prevista lança. */
function db() {
  return {
    query: async (q: string, p: unknown[] = []) => {
      const sql = q.replace(/\s+/g, " ").trim();
      fx.seen.push(sql);
      if (sql.startsWith("SELECT id, tenant_id, name, description")) return { rows: fx.product ? [fx.product] : [] };
      if (sql.startsWith("SELECT id, title, status, extra")) return { rows: fx.projects };
      if (sql.includes("FROM product_promotions")) return { rows: fx.promotions };
      if (sql.includes("FROM product_promotion_items")) return { rows: fx.promotionItems };
      if (sql.includes("FROM project_github_repos")) return { rows: fx.repos };
      // `computeCurrentSpecHash` (inventário + hash da árvore, lendo o disco).
      if (sql.startsWith("SELECT filename, file_path, rel_dir FROM project_spec_files")) {
        return { rows: fx.files.map(({ filename, rel_dir, file_path }) => ({ filename, rel_dir, file_path })) };
      }
      if (sql.startsWith("SELECT filename, rel_dir, is_primary, stage_b_full_sha")) {
        return { rows: fx.files.map(({ filename, rel_dir, is_primary, stage_b_full_sha }) => ({ filename, rel_dir, is_primary, stage_b_full_sha })) };
      }
      // Consultas do certificado Factory (reaproveitado): arquivo primário, tipo e janela de runs.
      if (sql.startsWith("SELECT file_path FROM project_spec_files")) {
        const ordered = fx.files.slice().sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
        return { rows: ordered.length ? [{ file_path: ordered[0].file_path }] : [] };
      }
      if (sql.startsWith("SELECT extra->>'project_type'")) return { rows: [{ project_type: "backend_api_python" }] };
      if (sql.startsWith("SELECT rel_dir, filename, stage_b_full_sha")) {
        return { rows: fx.files.map((f) => ({ rel_dir: f.rel_dir, filename: f.filename, stage_b_full_sha: f.stage_b_full_sha })) };
      }
      if (sql.includes("FROM spec_validation_runs")) {
        // A do certificado filtra por projeto e status; a do relatório usa ANY($1).
        return { rows: sql.includes("ANY($1)") ? fx.validations : fx.validations.filter((v) => ["passed", "failed"].includes(String(v.status))) };
      }
      if (sql.includes("FROM spec_gap_promotion_verdicts")) return { rows: fx.verdicts };
      if (sql.includes("FROM spec_finding_triage")) return { rows: fx.triage };
      if (sql.includes("FROM spec_constraints")) return { rows: fx.constraints };
      if (sql.includes("FROM spec_autonomy_runs")) return { rows: fx.autonomy };
      if (sql.includes("FROM pipeline_runs")) return { rows: fx.pipelines };
      if (sql.includes("FROM project_tasks")) return { rows: fx.tasks };
      if (sql.includes("FROM backend_deployments")) return { rows: fx.deployments };
      throw new Error(`consulta não prevista no duplo: ${sql.slice(0, 90)}`);
    },
  };
}

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "traceability-"));
  const specPath = path.join(dir, "nvx.md");
  const diaPath = path.join(dir, "arquitetura-diagramas.md");
  await writeFile(specPath, SPEC);
  await writeFile(diaPath, DIAGRAMS);
  fx = {
    dir,
    product: {
      id: PROD, tenant_id: "t1", name: "VNX LastMile", description: "Última milha",
      status: "active", lifecycle_status: "promoted", product_hash: "ph1", system_id: "nvx",
      origin_project_id: PROJ, is_inbox: false, solo_app: false, created_at: new Date("2026-09-01T00:00:00Z"),
    },
    projects: [{
      id: PROJ, title: "NVX LastMile - Backend", status: "promoted",
      extra: { project_type: "backend_api_python" }, version_number: 1, parent_project_id: null,
      created_at: new Date("2026-09-02T00:00:00Z"), finished_at: null, run_count: 0,
      spec_fingerprint: "fp1",
    }],
    files: [
      { filename: "nvx.md", rel_dir: "", file_path: specPath, is_primary: true, stage_b_full_sha: sha(SPEC) },
      { filename: "arquitetura-diagramas.md", rel_dir: "", file_path: diaPath, is_primary: false, stage_b_full_sha: null },
    ],
    validations: [{
      id: RUN, project_id: PROJ, status: "failed", spec_hash: "h1", stage_b_ran: true,
      findings: [
        { severity: "blocker", title: "Falta LGPD", file: "nvx.md", anchor: "## Objetivo", fingerprint: "f1" },
        { severity: "info", title: "Estilo", file: "nvx.md", anchor: "## Objetivo", fingerprint: "f2" },
      ],
      stage_b_coverage: { full: ["nvx.md"], fullShas: { "nvx.md": sha(SPEC) } },
      finding_routes: { f1: "spec" },
      created_at: new Date("2026-09-06T10:00:00Z"), finished_at: new Date("2026-09-06T10:30:00Z"),
    }],
    verdicts: [{
      project_id: PROJ, fingerprint: "f9", file_path: "nvx.md", anchor: "## Objetivo",
      severity_at: "warning", title: "Detalhe de retry", impact: "nenhum", reason: "a fábrica resolve",
      factory_artifact: "código do worker", recurrence_times: 2, focus_rounds: 1,
      decided_by_model: "us.anthropic.claude-sonnet-4-6", created_at: new Date("2026-09-06T11:00:00Z"), revoked_at: null,
    }],
    triage: [
      { project_id: PROJ, fingerprint: "f1", state: "acked", reason_code: "FACTORY_SCOPE", severity_at: "blocker", recurrence_count: 1, actor_role: "tenant_admin", created_at: new Date("2026-09-06T12:00:00Z"), revoked_at: null },
      { project_id: PROJ, fingerprint: "f7", state: "acked", reason_code: "FACTORY_SCOPE", severity_at: "warning", recurrence_count: 1, actor_role: "tenant_admin", created_at: new Date("2026-09-03T12:00:00Z"), revoked_at: new Date("2026-09-04T12:00:00Z") },
    ],
    constraints: [
      { project_id: PROJ, constraint_key: "c1", applies_to: "backend", verifiable_at: "build", severity: "blocker", assertion: "usa Postgres", source_anchor: "## Objetivo" },
      { project_id: PROJ, constraint_key: "c2", applies_to: "backend", verifiable_at: "runtime", severity: "blocker", assertion: "expõe /health", source_anchor: "## Objetivo" },
    ],
    autonomy: [{
      id: "eeeeeeee-0000-0000-0000-000000000001", project_id: PROJ, status: "exhausted", mode: "per_file",
      passes: 1, round: 12, max_rounds: 1, gaps_current: 44,
      rounds: [{ round: 1, note: "primeira" }, { round: 2, note: "segunda" }],
      created_at: new Date("2026-09-06T09:00:00Z"), finished_at: new Date("2026-09-06T13:00:00Z"), last_error: null,
    }],
    pipelines: [{
      project_id: PROJ, run_id: "r1", trigger: "manual", started_at: new Date("2026-09-06T14:00:00Z"),
      finished_at: new Date("2026-09-06T14:40:00Z"), duration_sec: 2400, stop_reason: "done",
      input_tokens: 1000, output_tokens: 500, estimated_cost_usd: "0.12",
    }],
    tasks: [
      { project_id: PROJ, task_id: "T1", module: "api", owner_role: "backend", status: "done", artifacts_ref: "gh://x", updated_at: new Date("2026-09-06T14:20:00Z") },
      { project_id: PROJ, task_id: "T2", module: "api", owner_role: "backend", status: "pending", artifacts_ref: null, updated_at: new Date("2026-09-06T14:30:00Z") },
    ],
    promotions: [{
      id: PROMO, status: "done", model_used: "us.anthropic.claude-sonnet-4-6", edges_source: "llm",
      promoted_by: "u1", started_at: new Date("2026-09-05T00:00:00Z"), created_at: new Date("2026-09-05T00:00:00Z"),
    }],
    promotionItems: [{ promotion_id: PROMO, project_id: PROJ, wave: 1, layer: "backend", depends_on: [], dispatched_at: null }],
    deployments: [{
      project_id: PROJ, provider: "aws", class: "ecs", lifecycle: "durable", status: "running",
      app_url: "https://x", image_tag: "sha-abc", created_at: new Date("2026-09-06T15:00:00Z"), destroyed_at: null,
    }],
    repos: [{ project_id: PROJ, repo_full_name: "z/nvx", repo_url: "https://gh/z/nvx", default_branch: "dev", sha_dev: "abc", pushed_at: new Date("2026-09-06T14:45:00Z") }],
    seen: [],
  };
});

afterEach(async () => { await rm(fx.dir, { recursive: true, force: true }); });

describe("buildTraceabilityReport — os três perfis", () => {
  it("perfis válidos são exatamente os três que o Jean pediu", () => {
    expect(TRACEABILITY_PROFILES).toEqual(["summary", "full", "mixed"]);
    expect(isTraceabilityProfile("summary")).toBe(true);
    expect(isTraceabilityProfile("completo")).toBe(false);
  });

  it("produto inexistente → null (a rota devolve 404, não um relatório vazio)", async () => {
    fx.product = null;
    expect(await buildTraceabilityReport(db(), { productId: PROD, profile: "full" })).toBeNull();
  });

  it("`summary`: contagens sim, listas item a item não — mas os DESENHOS vêm integrais", async () => {
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "summary" }))!;
    expect(r.product.name).toBe("VNX LastMile");
    expect(r.projects).toHaveLength(1);
    // Totais e desenhos: é o que um executivo lê.
    expect(r.projects[0].spec.totalChars).toBe(SPEC.length + DIAGRAMS.length);
    expect(r.projects[0].spec.diagrams?.content).toContain("```mermaid");
    expect((r.projects[0].spec.diagrams!.content.match(/```mermaid/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // Sem inventário arquivo a arquivo, sem findings/vereditos/constraints item a item.
    expect(r.projects[0].spec.files).toEqual([]);
    expect(r.gaps.items).toEqual([]);
    expect(r.verdicts).toEqual([]);
    expect(r.constraints.items).toEqual([]);
    expect(r.autonomyRuns).toEqual([]);
    expect(r.factory.tasks).toEqual([]);
    // …mas as contagens existem, inclusive do que NÃO foi listado.
    expect(r.gaps.counts).toEqual({ blocker: 1, info: 1 });
    expect(r.constraints.counts).toEqual({ "backend/build/blocker": 1, "backend/runtime/blocker": 1 });
    expect(r.factory.tasksByStatus).toEqual({ done: 1, pending: 1 });
    expect(r.changedSince).toBeNull();
  });

  it("`full`: o mapeamento inteiro da construção, spec E código", async () => {
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "full" }))!;
    expect(r.projects[0].spec.files.map((f) => f.path)).toEqual(["nvx.md", "arquitetura-diagramas.md"]);
    expect(r.projects[0].spec.specHash).toBeTruthy();
    expect(r.projects[0].repo?.fullName).toBe("z/nvx");
    expect(r.projects[0].certificate).not.toBeNull();
    // GAPs de TODAS as severidades (o `full` não filtra), com a rota do finding.
    expect(r.gaps.items.map((g) => g.severity).sort()).toEqual(["blocker", "info"]);
    expect(r.gaps.items.find((g) => g.fingerprint === "f1")!.route).toBe("spec");
    expect(r.verdicts[0].factoryArtifact).toBe("código do worker");
    // Triagem REVOGADA aparece no `full` (é história da construção) e o revogado está declarado.
    expect(r.triage).toHaveLength(2);
    expect(r.triage.find((t) => t.fingerprint === "f7")!.revokedAt).toBeTruthy();
    expect(r.constraints.items).toHaveLength(2);
    expect(r.autonomyRuns[0].rounds).toHaveLength(2);
    expect(r.factory.pipelineRuns[0].estimatedCostUsd).toBe(0.12);
    expect(r.factory.tasks).toHaveLength(2);
    expect(r.promotions[0].items[0].wave).toBe(1);
    expect(r.deployments[0].appUrl).toBe("https://x");
    expect(r.validations[0].findingsBySeverity).toEqual({ blocker: 1, info: 1 });
    expect(r.validations[0].filesJudgedFull).toBe(1);
    expect(r.truncated).toEqual([]);
  });

  it("`mixed`: recorta na última promoção e mostra só o que está ABERTO", async () => {
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "mixed" }))!;
    expect(r.changedSince).toBe("2026-09-05T00:00:00.000Z");
    // Validação de 06/09 é posterior à promoção → entra.
    expect(r.validations).toHaveLength(1);
    // GAP informativo não entra na lista de decisão (mas continua na contagem).
    expect(r.gaps.items.map((g) => g.severity)).toEqual(["blocker"]);
    expect(r.gaps.counts.info).toBe(1);
    // Triagem revogada é história: no `mixed` sobra o que está valendo.
    expect(r.triage.map((t) => t.fingerprint)).toEqual(["f1"]);
  });

  it("`mixed` sem promoção nenhuma: recorte NÃO existe — não se inventa \"nada mudou\"", async () => {
    fx.promotions = [];
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "mixed" }))!;
    expect(r.changedSince).toBeNull();
    expect(r.promotions).toEqual([]);
    // Tudo o que existe continua no relatório (o filtro temporal está desligado).
    expect(r.validations).toHaveLength(1);
    expect(r.autonomyRuns).toHaveLength(1);
    expect(r.deployments).toHaveLength(1);
  });

  it("`mixed`: o que é ANTERIOR à promoção sai do relatório de revisão", async () => {
    fx.validations = [{ ...fx.validations[0], created_at: new Date("2026-09-01T10:00:00Z") }];
    fx.autonomy = [{ ...fx.autonomy[0], created_at: new Date("2026-09-01T09:00:00Z") }];
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "mixed" }))!;
    expect(r.validations).toEqual([]);
    expect(r.autonomyRuns).toEqual([]);
    // …e o `full` do MESMO estado continua mostrando tudo (o corte é do perfil, não do dado).
    const full = (await buildTraceabilityReport(db(), { productId: PROD, profile: "full" }))!;
    expect(full.validations).toHaveLength(1);
    expect(full.autonomyRuns).toHaveLength(1);
  });
});

describe("buildTraceabilityReport — honestidade", () => {
  it('"julgado por inteiro" só quando o sha do juiz é o do DISCO (GAP-18)', async () => {
    fx.files[0].stage_b_full_sha = sha("outro conteúdo qualquer");
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "full" }))!;
    expect(r.projects[0].spec.files.find((f) => f.path === "nvx.md")!.judgedFullAtThisContent).toBe(false);
    fx.files[0].stage_b_full_sha = sha(SPEC);
    const r2 = (await buildTraceabilityReport(db(), { productId: PROD, profile: "full" }))!;
    expect(r2.projects[0].spec.files.find((f) => f.path === "nvx.md")!.judgedFullAtThisContent).toBe(true);
  });

  it("corte de rodadas é DECLARADO e guarda as MAIS RECENTES", async () => {
    const total = LIMITS.autonomyRounds + 5;
    fx.autonomy[0].rounds = Array.from({ length: total }, (_, i) => ({ round: i + 1, note: `r${i + 1}` }));
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "full" }))!;
    const kept = r.autonomyRuns[0].rounds;
    expect(kept).toHaveLength(LIMITS.autonomyRounds);
    expect((kept[kept.length - 1] as { round: number }).round).toBe(total);
    const cut = r.truncated.find((c) => c.section.startsWith("autonomyRounds:"));
    expect(cut).toMatchObject({ kept: LIMITS.autonomyRounds, total, limit: LIMITS.autonomyRounds });
  });

  it("desenho gigante é cortado, e o corte aparece com o tamanho REAL", async () => {
    const big = `${DIAGRAMS}\n${"x".repeat(LIMITS.diagramChars)}`;
    await writeFile(path.join(fx.dir, "arquitetura-diagramas.md"), big);
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "summary" }))!;
    expect(r.projects[0].spec.diagrams!.content).toHaveLength(LIMITS.diagramChars);
    expect(r.projects[0].spec.diagrams!.chars).toBe(big.length);
    expect(r.truncated.find((c) => c.section.startsWith("diagrams:"))).toMatchObject({
      kept: LIMITS.diagramChars, total: big.length,
    });
  });

  it("spec fora do disco → inventário vazio e `specHash: null`, sem inventar tamanho", async () => {
    await rm(path.join(fx.dir, "nvx.md"));
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "full" }))!;
    expect(r.projects[0].spec.specHash).toBeNull();
    expect(r.projects[0].spec.files).toEqual([]);
    expect(r.projects[0].spec.totalChars).toBe(0);
    expect(r.projects[0].spec.diagrams).toBeNull();
  });

  it("é leitura pura: nada de INSERT/UPDATE/DELETE em nenhum perfil", async () => {
    for (const profile of TRACEABILITY_PROFILES) {
      await buildTraceabilityReport(db(), { productId: PROD, profile });
    }
    expect(fx.seen.some((s) => /^(INSERT|UPDATE|DELETE)/i.test(s))).toBe(false);
    expect(fx.seen.length).toBeGreaterThan(10);
  });

  it("produto sem projeto nenhum não consulta tabelas por projeto (e não explode)", async () => {
    fx.projects = [];
    const r = (await buildTraceabilityReport(db(), { productId: PROD, profile: "full" }))!;
    expect(r.product.projectsTotal).toBe(0);
    expect(r.projects).toEqual([]);
    expect(r.gaps.counts).toEqual({});
    expect(fx.seen.some((s) => s.includes("ANY($1)"))).toBe(false);
  });
});
