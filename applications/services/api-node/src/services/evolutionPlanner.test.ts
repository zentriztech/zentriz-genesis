import { describe, it, expect, vi, beforeAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evo-plan-"));
process.env.UPLOAD_DIR = path.join(tmpRoot, "uploads");
process.env.PROJECT_FILES_ROOT = path.join(tmpRoot, "files");

const mod = await import("./evolutionPlanner.js");
const { parseEvolutionPlan, mergeChangelog, applyEvolutionPlan, buildEvolutionPlanContext, buildEvolutionPlanRequest, buildRepoMap, slugify } = mod;

const RFC_BODY = `# Exportar extrato em PDF

## Sumário
Permite exportar o extrato do mês em PDF.

## Escopo
**Não-objetivos:** não altera o cálculo do saldo.

## Requisitos
- REQ-01 — O sistema DEVE gerar o PDF do mês selecionado.

## Critérios de aceite
### Cenário: exportar mês corrente
- **Dado** um usuário autenticado com lançamentos
- **Quando** clica em "Exportar PDF"
- **Então** recebe um PDF com todos os lançamentos do mês

## Compatibilidade
- Tipo (SemVer): MINOR
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
  - "apps/api/src/reports/**"
  - "apps/web/src/pages/reports/**"
\`\`\`
`;

const PLAN_JSON = JSON.stringify({
  summary: "Desenhei 1 RFC para exportação em PDF.",
  compat: "minor",
  questions: ["Volume mensal esperado de exportações?"],
  rfcs: [{ slug: "Exportar PDF do Extrato!", title: "Exportar extrato em PDF", content: RFC_BODY }],
  adrs: [],
  changelog: { added: ["Exportação do extrato mensal em PDF"], changed: [], deprecated: [], removed: [], fixed: [], security: [] },
  connect_yaml: null,
});

describe("evolutionPlanner (Evoluir E2)", () => {
  it("parse: JSON (mesmo cercado) → plano tipado; sem RFC → erro; connect_yaml só se parece YAML", () => {
    const p = parseEvolutionPlan("```json\n" + PLAN_JSON + "\n```");
    expect(p.rfcs).toHaveLength(1);
    expect(p.rfcs[0].slug).toBe("exportar-pdf-do-extrato");
    expect(p.compat).toBe("minor");
    expect(p.changelog.added).toEqual(["Exportação do extrato mensal em PDF"]);
    expect(p.connectYaml).toBeNull();
    expect(() => parseEvolutionPlan(JSON.stringify({ rfcs: [] }))).toThrow(/PLAN_WITHOUT_RFC/);
    expect(() => parseEvolutionPlan("nada de json")).toThrow(/PLAN_NOT_JSON/);
    const withYaml = parseEvolutionPlan(JSON.stringify({ rfcs: [{ title: "x", content: RFC_BODY }], connect_yaml: "serviceName: extrato\ninterfaces: []\n", compat: "MAJOR" }));
    expect(withYaml.connectYaml).toMatch(/serviceName/);
    expect(withYaml.compat).toBe("major");
    expect(parseEvolutionPlan(JSON.stringify({ rfcs: [{ title: "x", content: RFC_BODY }], connect_yaml: "```yaml\nserviceName: x\n```" })).connectYaml).toBeNull();
    expect(slugify("Ação Ímpar — Teste")).toBe("acao-impar-teste");
  });

  it("mergeChangelog: cria esqueleto Keep a Changelog; mescla em Unreleased existente por seção", () => {
    const items = { added: ["PDF"], changed: [], deprecated: [], removed: [], fixed: ["Bug X"], security: [] };
    const fresh = mergeChangelog(null, items, "Extrato");
    expect(fresh).toMatch(/^# Changelog — Extrato/);
    expect(fresh).toMatch(/## \[Unreleased\]\n\n### Added\n- PDF\n\n### Fixed\n- Bug X/);
    const existing = "# Changelog\n\n## [Unreleased]\n\n### Added\n- Item antigo\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- Base\n";
    const merged = mergeChangelog(existing, items, "Extrato");
    const unreleased = merged.slice(merged.indexOf("## [Unreleased]"), merged.indexOf("## [1.0.0]"));
    expect(unreleased).toMatch(/### Added\n- Item antigo\n- PDF/);
    expect(unreleased).toMatch(/### Fixed\n- Bug X/);
    expect(merged).toMatch(/## \[1\.0\.0\] - 2026-01-01\n\n### Added\n- Base/);
    // sem Unreleased: insere antes da 1ª versão
    const noUnreleased = mergeChangelog("# Changelog\n\n## [1.0.0] - 2026-01-01\n- Base\n", items, "X");
    expect(noUnreleased.indexOf("## [Unreleased]")).toBeLessThan(noUnreleased.indexOf("## [1.0.0]"));
    // sem itens novos → inalterado
    expect(mergeChangelog(existing, { added: [], changed: [], deprecated: [], removed: [], fixed: [], security: [] }, "X")).toBe(existing);
    // dedupe: re-executar com os mesmos itens não duplica
    const twice = mergeChangelog(merged, items, "Extrato");
    expect((twice.match(/- PDF/g) ?? []).length).toBe(1);
    expect((twice.match(/- Bug X/g) ?? []).length).toBe(1);
    expect(mergeChangelog(merged, { ...items, added: ["pdf", "PDF "] }, "X")).toBe(merged);
  });

  it("contexto + apply: numera por produto (atômico), grava RFC/CHANGELOG no filho, reporta pendências do gate e atualiza extra", async () => {
    const childId = "child-1";
    const filesRoot = process.env.PROJECT_FILES_ROOT!;
    await fs.mkdir(path.join(filesRoot, "parent-1", "docs"), { recursive: true });
    await fs.writeFile(path.join(filesRoot, "parent-1", "docs", "cto_charter.md"), "# Charter\nNestJS + Postgres.");
    await fs.mkdir(path.join(filesRoot, childId, "apps", "api", "src", "reports"), { recursive: true });
    await fs.mkdir(path.join(filesRoot, childId, "apps", "api", "node_modules", "x"), { recursive: true });
    await fs.writeFile(path.join(filesRoot, childId, "apps", "api", "src", "reports", "service.ts"), "export const a = 1;");
    const specDir = path.join(process.env.UPLOAD_DIR!, childId);
    await fs.mkdir(specDir, { recursive: true });
    const primary = path.join(specDir, "spec-evolution-v2.md");
    // Formato REAL gravado pelo /evolve (E1): título, linha em branco, blockquote, linha em branco, ---, spec.
    await fs.writeFile(primary, "# EVOLUTION REQUEST — v2\n\n> quero pdf\n\n---\n\n# Spec do Extrato\nFR-01 …");

    const files: Array<Record<string, unknown>> = [
      { filename: "spec-evolution-v2.md", file_path: primary, rel_dir: "", is_primary: true },
      { filename: "RFC-0003-antigo.md", file_path: "/x/nao-existe.md", rel_dir: "docs/rfc", is_primary: false },
    ];
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    let seqRfc = 2, seqAdr = 1;
    const db = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM projects WHERE id/.test(sql)) return { rows: [{ id: childId, title: "Extrato — Evolução v2", product_id: "prod-1", parent_project_id: "parent-1", extra: { evolution: true, evolution_parent_id: "parent-1", evolution_request_original: "quero pdf" } }] };
      if (/FROM project_spec_files WHERE project_id = \$1 ORDER/.test(sql)) return { rows: files };
      if (/SELECT next_rfc_seq, next_adr_seq FROM products/.test(sql)) return { rows: [{ next_rfc_seq: seqRfc, next_adr_seq: seqAdr }] };
      if (/UPDATE products SET next_rfc_seq/.test(sql)) {
        const [, minRfc, nR, nA] = params as [string, number, number, number];
        seqRfc = Math.max(seqRfc, minRfc) + nR; seqAdr += nA;
        return { rows: [{ next_rfc_seq: seqRfc, next_adr_seq: seqAdr }] };
      }
      if (/SELECT file_path FROM project_spec_files WHERE project_id=\$1 AND rel_dir=\$2 AND filename=\$3/.test(sql)) {
        const f = files.find((x) => x.rel_dir === params[1] && x.filename === params[2]);
        return { rows: f ? [{ file_path: f.file_path }] : [] };
      }
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: files.length }] };
      if (/INSERT INTO project_spec_files/.test(sql)) { files.push({ filename: params[1], file_path: params[2], rel_dir: params[3], is_primary: false }); return { rows: [] }; }
      if (/UPDATE/.test(sql)) { updates.push({ sql, params }); return { rows: [] }; }
      return { rows: [] };
    }) };

    const ctx = await buildEvolutionPlanContext(db as never, childId);
    expect(ctx.request).toBe("quero pdf");
    expect(ctx.specMarkdown.startsWith("# Spec do Extrato")).toBe(true);   // header EVOLUTION REQUEST removido
    expect(ctx.charter).toMatch(/NestJS/);
    expect(ctx.repoMap).toMatch(/reports\//);
    expect(ctx.repoMap).not.toMatch(/node_modules/);
    expect(ctx.nextRfcSeq).toBe(4);   // produto diz 2, mas o filho já tem RFC-0003 → 4
    const req = buildEvolutionPlanRequest(ctx);
    expect(String(req.user_message)).toMatch(/RFC-0004/);
    expect(String(req.prompt_override).length).toBeGreaterThan(200);

    const plan = parseEvolutionPlan(PLAN_JSON);
    const res = await applyEvolutionPlan(db as never, ctx, plan);
    expect(res.written.map((w) => w.path)).toEqual(["docs/rfc/RFC-0004-exportar-pdf-do-extrato.md", "CHANGELOG.md"]);
    expect(res.rfcProblems).toEqual([]);   // RFC completo passa no parser do gate
    const rfcOnDisk = await fs.readFile(path.join(specDir, "docs", "rfc", "RFC-0004-exportar-pdf-do-extrato.md"), "utf-8");
    expect(rfcOnDisk).toMatch(/^# RFC-0004 — Exportar extrato em PDF/);
    expect(rfcOnDisk).toMatch(/files_allowed/);
    const changelog = await fs.readFile(path.join(specDir, "CHANGELOG.md"), "utf-8");
    expect(changelog).toMatch(/## \[Unreleased\]\n\n### Added\n- Exportação do extrato mensal em PDF/);
    const extraUpd = updates.find((u) => /UPDATE projects SET extra/.test(u.sql))!;
    const patch = JSON.parse(extraUpd.params[1] as string);
    expect(patch.evolution_plan.rfcs).toEqual(["docs/rfc/RFC-0004-exportar-pdf-do-extrato.md"]);
    expect(patch.evolution_compat).toBe("minor");
    expect(res.questions).toEqual(["Volume mensal esperado de exportações?"]);

    // 2ª rodada: RFC com o MESMO nome não é sobrescrito (skipped) e um RFC pobre vira pendência
    const poor = parseEvolutionPlan(JSON.stringify({ rfcs: [
      { slug: "exportar-pdf-do-extrato", title: "Exportar extrato em PDF", content: RFC_BODY },
      { slug: "vago", title: "Algo vago", content: "# Algo vago\n\n## Sumário\nFazer melhor, com bastante texto para passar do mínimo." },
    ], changelog: { added: ["x"] } }));
    const ctx2 = await buildEvolutionPlanContext(db as never, childId);
    const res2 = await applyEvolutionPlan(db as never, ctx2, poor);
    expect(res2.written[0].path).toMatch(/RFC-0005-exportar-pdf-do-extrato\.md/);   // número novo → não colide
    expect(res2.rfcProblems.some((p) => /RFC-0006-vago/.test(p.path) && p.problems.length >= 2)).toBe(true);
    expect(res2.warnings.some((w) => /pendências para o gate/.test(w))).toBe(true);
    expect(res2.written.find((w) => w.path === "CHANGELOG.md")?.action).toBe("updated");
  });

  it("nextRfcNumber: por produto (atômico, nunca abaixo dos RFCs locais) e sem produto (max local + 1)", async () => {
    const { nextRfcNumber } = mod;
    const mk = (productId: string | null, files: string[], seqAfter: number) => ({ query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/SELECT product_id FROM projects/.test(sql)) return { rows: [{ product_id: productId }] };
      if (/SELECT filename FROM project_spec_files/.test(sql)) return { rows: files.map((f) => ({ filename: f })) };
      if (/UPDATE products SET next_rfc_seq/.test(sql)) { expect(params[1]).toBe(files.length ? 4 : 1); return { rows: [{ next_rfc_seq: seqAfter }] }; }
      return { rows: [] };
    }) });
    expect(await nextRfcNumber(mk("prod", ["RFC-0003-a.md"], 5) as never, "p")).toBe(4);   // GREATEST(seq, 4)+1 = 5 → devolve 4
    expect(await nextRfcNumber(mk(null, ["RFC-0003-a.md", "RFC-0001-b.md"], 0) as never, "p")).toBe(4);
    expect(await nextRfcNumber(mk(null, [], 0) as never, "p")).toBe(1);
  });

  it("createPlanJob: 23505 devolve o job vivo (PLAN_IN_PROGRESS); vivo STALE (>10 min) vira interrupted e um novo é criado", async () => {
    const { createPlanJob } = mod;
    const live = (ageMs: number) => ({ id: "live", project_id: "p", owner_user_id: "u", status: "running", created_at: new Date(Date.now() - ageMs).toISOString() });
    const mk = (liveRow: Record<string, unknown> | null) => {
      let first = true; const calls: string[] = [];
      const db = { query: vi.fn(async (sql: string) => {
        calls.push(sql.split(" ")[0]);
        if (/INSERT INTO evolution_plan_jobs/.test(sql)) {
          if (first) { first = false; const e = new Error("dup") as Error & { code?: string }; e.code = "23505"; throw e; }
          return { rows: [{ id: "new", project_id: "p", owner_user_id: "u", status: "pending", created_at: new Date().toISOString() }] };
        }
        if (/SELECT \* FROM evolution_plan_jobs WHERE project_id/.test(sql)) return { rows: liveRow ? [liveRow] : [] };
        return { rows: [] };
      }) };
      return { db, calls };
    };
    const fresh = mk(live(60_000));
    const r1 = await createPlanJob(fresh.db as never, "p", "u", null);
    expect(r1.ok).toBe(false); expect(!r1.ok && r1.code).toBe("PLAN_IN_PROGRESS");
    const stale = mk(live(20 * 60_000));
    const r2 = await createPlanJob(stale.db as never, "p", "u", "req");
    expect(r2.ok).toBe(true); expect(r2.job.id).toBe("new");
    expect(stale.calls.filter((c) => c === "UPDATE").length).toBe(1);   // stale → interrupted antes de inserir de novo
  });

  it("buildRepoMap: vazio quando o diretório não existe", async () => {
    expect(await buildRepoMap(path.join(tmpRoot, "nope"))).toBe("");
  });
});
