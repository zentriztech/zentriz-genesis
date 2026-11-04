import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evo-accept-"));
process.env.UPLOAD_DIR = path.join(tmpRoot, "uploads");
process.env.PROJECT_FILES_ROOT = path.join(tmpRoot, "files");

const pushMock = vi.fn();
vi.mock("./githubPush.js", () => ({ pushEvolutionToGitHub: (...args: unknown[]) => pushMock(...args) }));
// Bloco 4 M1: o aceite dispara tryAutoMergeEvolution (best-effort) — mockado para não tocar a rede.
const mergeMock = vi.fn(async (..._args: unknown[]) => ({ state: "skipped_flag" as const }));
vi.mock("./evolutionMerge.js", () => ({ tryAutoMergeEvolution: (...args: unknown[]) => mergeMock(...args) }));

const { bumpSemver, lastReleasedVersion, releaseChangelog, finalizeEvolutionChangelog, supersedeParent, evolutionBranchName, buildPullRequestBody, runEvolutionAcceptFlow } = await import("./evolutionAccept.js");

describe("evolutionAccept (Evoluir E5)", () => {
  it("bumpSemver / lastReleasedVersion / branch name", () => {
    expect(bumpSemver("1.0.0", "minor")).toBe("1.1.0");
    expect(bumpSemver("1.4.2", "patch")).toBe("1.4.3");
    expect(bumpSemver("v1.4.2", "major")).toBe("2.0.0");
    expect(bumpSemver("lixo", "minor")).toBe("1.1.0");
    expect(lastReleasedVersion("# C\n\n## [Unreleased]\n- x\n\n## [2.3.1] - 2026-01-01\n\n## [2.3.0] - 2025-12-01\n")).toBe("2.3.1");
    expect(lastReleasedVersion("## [Unreleased]\n- x\n")).toBeNull();
    expect(evolutionBranchName(3)).toBe("evolution/v3");
    expect(evolutionBranchName(null)).toBe("evolution/v2");
    expect(evolutionBranchName(1)).toBe("evolution/v2");
  });

  it("releaseChangelog: fecha Unreleased como versão datada mantendo Unreleased vazio no topo", () => {
    const cl = "# Changelog\n\n## [Unreleased]\n\n### Added\n- PDF\n\n### Fixed\n- Bug\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- Base\n";
    const out = releaseChangelog(cl, "1.1.0", "2026-09-04", "fallback");
    expect(out).toMatch(/## \[Unreleased\]\n\n## \[1\.1\.0\] - 2026-09-04\n\n### Added\n- PDF\n\n### Fixed\n- Bug\n\n## \[1\.0\.0\] - 2026-01-01/);
    expect(out).not.toMatch(/fallback/);
    // Unreleased vazio → item genérico (nunca aceita sem registro)
    const empty = releaseChangelog("# C\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n- Base\n", "1.0.1", "2026-09-04", "Evolução aceita — X");
    expect(empty).toMatch(/## \[1\.0\.1\] - 2026-09-04\n\n### Changed\n- Evolução aceita — X/);
    // sem arquivo → esqueleto
    expect(releaseChangelog(null, "1.1.0", "2026-09-04", "Evolução aceita — X")).toMatch(/## \[Unreleased\]\n\n## \[1\.1\.0\] - 2026-09-04/);
    // sem Unreleased mas com versões → insere antes da 1ª versão
    const noUnrel = releaseChangelog("# C\n\n## [1.0.0] - 2026-01-01\n- Base\n", "1.1.0", "2026-09-04", "x");
    expect(noUnrel.indexOf("## [1.1.0]")).toBeLessThan(noUnrel.indexOf("## [1.0.0]"));
  });

  it("finalizeEvolutionChangelog: versiona o spec-file, atualiza sha e copia para apps/CHANGELOG.md", async () => {
    const childId = "child-9";
    const specDir = path.join(process.env.UPLOAD_DIR!, childId);
    await fs.mkdir(specDir, { recursive: true });
    const clPath = path.join(specDir, "CHANGELOG.md");
    await fs.writeFile(clPath, "# Changelog\n\n## [Unreleased]\n\n### Added\n- PDF\n\n## [1.2.0] - 2026-01-01\n- Base\n");
    const appsDir = path.join(process.env.PROJECT_FILES_ROOT!, childId, "apps");
    await fs.mkdir(appsDir, { recursive: true });
    const updates: string[] = [];
    const db = { query: vi.fn(async (sql: string) => {
      if (/SELECT file_path FROM project_spec_files/.test(sql)) return { rows: [{ file_path: clPath }] };
      if (/UPDATE project_spec_files SET content_sha256/.test(sql)) { updates.push(sql); return { rows: [] }; }
      return { rows: [] };
    }) };
    const r = await finalizeEvolutionChangelog(db as never, childId, { compat: "minor", title: "Extrato", productId: null, date: "2026-09-04" });
    expect(r.version).toBe("1.3.0");
    expect(await fs.readFile(clPath, "utf-8")).toMatch(/## \[Unreleased\]\n\n## \[1\.3\.0\] - 2026-09-04\n\n### Added\n- PDF/);
    expect(await fs.readFile(path.join(appsDir, "CHANGELOG.md"), "utf-8")).toMatch(/\[1\.3\.0\]/);
    expect(updates.length).toBe(1);
    // sem CHANGELOG na Bancada → cria (INSERT) com item genérico
    const inserts: string[] = [];
    const db2 = { query: vi.fn(async (sql: string) => { if (/INSERT INTO project_spec_files/.test(sql)) inserts.push(sql); return { rows: [] }; }) };
    const r2 = await finalizeEvolutionChangelog(db2 as never, "child-10", { compat: "major", title: "X", productId: null, date: "2026-09-04" });
    expect(r2.version).toBe("2.0.0");
    expect(inserts.length).toBe(1);
    expect(await fs.readFile(path.join(process.env.UPLOAD_DIR!, "child-10", "CHANGELOG.md"), "utf-8")).toMatch(/## \[2\.0\.0\] - 2026-09-04\n\n### Changed\n- Evolução aceita — X/);
  });

  it("supersedeParent: pai accepted → archived + superseded_by (guardado); sem pai → só marca o filho", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/SET status = 'archived'/.test(sql)) return { rows: [{ id: params[0] }] };
      return { rows: [] };
    }) };
    expect(await supersedeParent(db as never, "child", "parent", "1.1.0")).toBe(true);
    const childUpd = calls.find((c) => /WHERE id = \$1$/.test(c.sql.trim()) && c.params[0] === "child")!;
    expect(JSON.parse(childUpd.params[1] as string)).toMatchObject({ supersedes: "parent", evolution_version: "1.1.0" });
    const parentUpd = calls.find((c) => /SET status = 'archived'/.test(c.sql))!;
    expect(parentUpd.sql).toMatch(/AND status = 'accepted' AND coalesce\(extra->>'superseded_by',''\) = ''/);
    // E2E 2026-09-04: nº de parâmetros deve casar com os placeholders ($1, $2) — antes eram 3 params e o UPDATE falhava
    const placeholders = new Set((parentUpd.sql.match(/\$\d+/g) ?? []));
    expect(placeholders.size).toBe(parentUpd.params.length);
    expect(parentUpd.params[0]).toBe("parent");
    expect(JSON.parse(parentUpd.params[1] as string)).toMatchObject({ superseded_by: "child", superseded_version: "1.1.0" });
    expect(await supersedeParent(db as never, "child", null, "1.1.0")).toBe(false);
  });

  it("runEvolutionAcceptFlow: não-evolução → false; push falho → supersessão ADIADA (flag); push ok → pai supersedido", async () => {
    const mkDb = (extra: Record<string, unknown> | null) => {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      const db = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/SELECT id, title, product_id, parent_project_id, version_number, extra FROM projects/.test(sql)) {
          return { rows: [{ id: "child", title: "Extrato — Evolução v2", product_id: null, parent_project_id: "parent", version_number: 2, extra }] };
        }
        if (/SET status = 'archived'/.test(sql)) return { rows: [{ id: "parent" }] };
        return { rows: [] };
      }) };
      return { db, calls };
    };
    // não-evolução
    const a = mkDb({ foo: 1 });
    expect(await runEvolutionAcceptFlow(a.db as never, "child")).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();

    // push falho → sem archived, flag evolution_push_pending
    pushMock.mockResolvedValueOnce({ ok: false, mode: "evolution", error: "403" });
    const b = mkDb({ evolution: true, evolution_parent_id: "parent", evolution_compat: "minor" });
    expect(await runEvolutionAcceptFlow(b.db as never, "child")).toBe(true);
    expect(b.calls.some((c) => /SET status = 'archived'/.test(c.sql))).toBe(false);
    const pend = b.calls.find((c) => /evolution_push_pending/.test(String(c.params[1] ?? "")))!;
    expect(JSON.parse(pend.params[1] as string)).toMatchObject({ evolution_push_pending: true, evolution_version: "1.1.0" });
    expect(pushMock).toHaveBeenLastCalledWith("child", expect.objectContaining({ versionLabel: "1.1.0", title: "Extrato" }));

    // push ok → pai archived + superseded_by
    pushMock.mockResolvedValueOnce({ ok: true, mode: "evolution", prUrl: "https://github.com/x/y/pull/1" });
    const c = mkDb({ evolution: true, evolution_parent_id: "parent", evolution_compat: "major" });
    expect(await runEvolutionAcceptFlow(c.db as never, "child")).toBe(true);
    const arch = c.calls.find((x) => /SET status = 'archived'/.test(x.sql))!;
    expect(arch.params[0]).toBe("parent");
    expect(JSON.parse(arch.params[1] as string)).toMatchObject({ superseded_by: "child", superseded_version: "2.0.0" });
    // Bloco 4 M1: após push ok + supersessão, o aceite tenta o merge automático (best-effort).
    expect(mergeMock).toHaveBeenCalledWith(c.db, "child");
    // sem GitHub App (skipped) também supersede — o tenant não publica de forma alguma
    pushMock.mockResolvedValueOnce({ ok: false, mode: "skipped", error: "sem GitHub App" });
    const d = mkDb({ evolution: true, evolution_parent_id: "parent" });
    await runEvolutionAcceptFlow(d.db as never, "child");
    expect(d.calls.some((x) => /SET status = 'archived'/.test(x.sql))).toBe(true);
  });

  it("H2 — republicar/reprocessar REUSA a versão (nunca dobra) e limpa evolution_push_pending quando o push passa", async () => {
    const specDir = path.join(process.env.UPLOAD_DIR!, "child-h2");
    await fs.mkdir(specDir, { recursive: true });
    const clPath = path.join(specDir, "CHANGELOG.md");
    await fs.writeFile(clPath, "# C\n\n## [Unreleased]\n\n## [1.1.0] - 2026-09-04\n\n### Added\n- PDF\n");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/SELECT id, title, product_id, parent_project_id, version_number, extra FROM projects/.test(sql)) {
        return { rows: [{ id: "child-h2", title: "Extrato — Evolução v2", product_id: null, parent_project_id: "parent", version_number: 2,
          extra: { evolution: true, evolution_parent_id: "parent", evolution_compat: "minor", evolution_version: "1.1.0", evolution_push_pending: true } }] };
      }
      if (/SELECT file_path FROM project_spec_files/.test(sql)) return { rows: [{ file_path: clPath }] };
      if (/SET status = 'archived'/.test(sql)) return { rows: [{ id: "parent" }] };
      return { rows: [] };
    }) };
    pushMock.mockResolvedValueOnce({ ok: true, mode: "evolution" });
    expect(await runEvolutionAcceptFlow(db as never, "child-h2", { republish: true })).toBe(true);
    // CHANGELOG NÃO reescrito (nenhum UPDATE de sha) e versão reusada no push
    expect(calls.some((c) => /UPDATE project_spec_files SET content_sha256/.test(c.sql))).toBe(false);
    expect(await fs.readFile(clPath, "utf-8")).not.toMatch(/1\.2\.0/);
    expect(pushMock).toHaveBeenLastCalledWith("child-h2", expect.objectContaining({ versionLabel: "1.1.0" }));
    // flag limpa após push ok + pai supersedido
    const clear = calls.find((c) => /evolution_push_pending/.test(String(c.params[1] ?? "")) && /"evolution_push_pending":false/.test(String(c.params[1])));
    expect(clear).toBeTruthy();
    expect(calls.some((c) => /SET status = 'archived'/.test(c.sql))).toBe(true);
  });

  it("buildPullRequestBody: resumo + RFCs + seção do CHANGELOG da versão", async () => {
    const childId = "child-11";
    const specDir = path.join(process.env.UPLOAD_DIR!, childId);
    await fs.mkdir(specDir, { recursive: true });
    const clPath = path.join(specDir, "CHANGELOG.md");
    await fs.writeFile(clPath, "# C\n\n## [Unreleased]\n\n## [1.1.0] - 2026-09-04\n\n### Added\n- PDF\n\n## [1.0.0] - 2026-01-01\n- Base\n");
    const db = { query: vi.fn(async (sql: string) => /SELECT file_path FROM project_spec_files/.test(sql) ? { rows: [{ file_path: clPath }] } : { rows: [] }) };
    const body = await buildPullRequestBody(db as never, childId, "1.1.0", { evolution_compat: "minor", evolution_rfcs: ["docs/rfc/RFC-0004-pdf.md"], evolution_plan: { summary: "Exporta PDF." } });
    expect(body).toMatch(/Evolução v1\.1\.0/);
    expect(body).toMatch(/Exporta PDF\./);
    expect(body).toMatch(/RFC-0004-pdf\.md/);
    expect(body).toMatch(/### CHANGELOG\n\n## \[1\.1\.0\] - 2026-09-04\n\n### Added\n- PDF/);
    expect(body).not.toMatch(/\[1\.0\.0\]/);
  });

  describe("D-13 (AR) — o corpo do PR reflete o resultado REAL de cada gate", () => {
    const prevRoot = process.env.PROJECT_FILES_ROOT;
    afterEach(() => { if (prevRoot === undefined) delete process.env.PROJECT_FILES_ROOT; else process.env.PROJECT_FILES_ROOT = prevRoot; });

    const mkDb = (dialogue: Array<{ event_type: string | null; summary_human: string }>, taskStatus: string | null = null) => ({
      query: vi.fn(async (sql: string) => /FROM project_dialogue/.test(sql) ? { rows: dialogue }
        : /FROM project_tasks/.test(sql) ? { rows: taskStatus ? [{ status: taskStatus }] : [] } : { rows: [] }),
    });
    const writeCheckpoint = async (childId: string, violations: Record<string, string[]>, more: Record<string, unknown> = {}) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "d13-"));
      process.env.PROJECT_FILES_ROOT = root;
      await fs.mkdir(path.join(root, ".runner-state", childId), { recursive: true });
      await fs.writeFile(path.join(root, ".runner-state", childId, "checkpoint.json"), JSON.stringify({ evolution_violations: violations, ...more }));
      return root;
    };

    it("QA reprovado e escopo violado ⇒ o texto diz FALHOU nos dois e NÃO afirma que 'rodaram'", async () => {
      await writeCheckpoint("d13-a", { "TSK-1": ["FORA DO ESCOPO do RFC: apps/x.ts (permitido: apps/api/**)"] });
      const db = mkDb([
        { event_type: "qa.review", summary_human: "QA revisou" },
        { event_type: "step", summary_human: "QA reportou QA_FAIL (reatempto 3/3). Task TSK-1 marcada como DONE (não aprovada)." },
      ]);
      const body = await buildPullRequestBody(db as never, "d13-a", "1.0.1", { evolution_compat: "patch" });
      expect(body).toMatch(/Gate de escopo[^\n]*\*\*FALHOU\*\*/);
      expect(body).toMatch(/- QA: \*\*FALHOU\*\*/);
      expect(body).toMatch(/Símbolos preservados: \*\*passou\*\*/);
      expect(body).not.toMatch(/rodaram na fábrica/);
    });

    it("sem checkpoint e sem registro do QA ⇒ 'não executado/sem evidência' (nunca 'passou')", async () => {
      process.env.PROJECT_FILES_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "d13-"));
      const body = await buildPullRequestBody(mkDb([]) as never, "d13-b", "1.0.1", {});
      expect(body.match(/não executado\/sem evidência/g)?.length).toBe(5); // escopo, símbolos, QA, TSK-FULL-TEST, baseline
      expect(body).not.toMatch(/\*\*passou\*\*/);
    });

    it("escopo/símbolos/QA registrados e limpos ⇒ passou nos três; FULL-TEST e baseline SEM evidência continuam não executados", async () => {
      await writeCheckpoint("d13-c", {});
      const body = await buildPullRequestBody(mkDb([{ event_type: "qa.review", summary_human: "QA revisou" }]) as never, "d13-c", "1.0.1", {});
      expect(body.match(/\*\*passou\*\*/g)?.length).toBe(3);
      expect(body).toMatch(/TSK-FULL-TEST \(e2e\): \*\*não executado/);
      expect(body).toMatch(/Baseline \/ não-regressão \(P2P\): \*\*não executado/);
    });
  });
  describe("N-6 (AU) — o texto do PR nunca declara 'passou' sem evidência do diff real, do FULL-TEST e da baseline", () => {
    const prevRoot = process.env.PROJECT_FILES_ROOT;
    afterEach(() => { if (prevRoot === undefined) delete process.env.PROJECT_FILES_ROOT; else process.env.PROJECT_FILES_ROOT = prevRoot; });
    const qaOk = [{ event_type: "qa.review", summary_human: "QA revisou" }];
    const mkDb = (dialogue: Array<{ event_type: string | null; summary_human: string }>, taskStatus: string | null) => ({
      query: vi.fn(async (sql: string) => /FROM project_dialogue/.test(sql) ? { rows: dialogue }
        : /FROM project_tasks/.test(sql) ? { rows: taskStatus ? [{ status: taskStatus }] : [] } : { rows: [] }),
    });
    const setup = async (id: string, checkpoint: Record<string, unknown>) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "n6-"));
      process.env.PROJECT_FILES_ROOT = root;
      await fs.mkdir(path.join(root, ".runner-state", id), { recursive: true });
      await fs.writeFile(path.join(root, ".runner-state", id, "checkpoint.json"), JSON.stringify({ evolution_violations: {}, ...checkpoint }));
      const apps = path.join(root, id, "apps");
      await fs.mkdir(path.join(apps, "src"), { recursive: true });
      const git = (...a: string[]) => execFileSync("git", ["-C", apps, "-c", "user.email=a@b.c", "-c", "user.name=t", ...a]);
      execFileSync("git", ["init", "-q", apps]);
      await fs.writeFile(path.join(apps, "src", "a.ts"), "1");
      await fs.writeFile(path.join(apps, "package-lock.json"), "{}");
      git("add", "-A"); git("commit", "-qm", "base");
      return apps;
    };
    const line = (body: string, name: string) => body.split("\n").find((l) => l.includes(name)) ?? "";

    it("🔴 PR #5 da 4.5b: arquivo FORA do files_allowed no diff real ⇒ escopo FALHOU (antes: 'passou', pois o checkpoint não tinha violações)", async () => {
      const apps = await setup("n6-a", {});
      await fs.writeFile(path.join(apps, "src", "a.ts"), "2");
      await fs.mkdir(path.join(apps, "other"), { recursive: true });
      await fs.writeFile(path.join(apps, "other", "x.ts"), "x");
      await fs.writeFile(path.join(apps, "package-lock.json"), "{\"changed\":1}"); // lockfile do próprio npm, fora do files_allowed
      const body = await buildPullRequestBody(mkDb(qaOk, null) as never, "n6-a", "1.0.1", { evolution_scope: ["src/**"] });
      const l = line(body, "Gate de escopo");
      expect(l).toMatch(/\*\*FALHOU\*\*/);
      expect(l).toContain("other/x.ts");
      expect(l).toContain("package-lock.json");
      expect(l).not.toMatch(/\*\*passou\*\*/);
    });

    it("lockfile de OUTRO gerenciador (pnpm-lock.yaml) é excluído da publicação: o escopo passa, mas o texto DIZ que foi excluído", async () => {
      const apps = await setup("n6-b", {});
      await fs.writeFile(path.join(apps, "src", "a.ts"), "2");
      await fs.writeFile(path.join(apps, "pnpm-lock.yaml"), "lockfileVersion: 9");
      const body = await buildPullRequestBody(mkDb(qaOk, null) as never, "n6-b", "1.0.1", { evolution_scope: ["src/**"] });
      const l = line(body, "Gate de escopo");
      expect(l).toMatch(/\*\*passou\*\*/);
      expect(l).toContain("EXCLUÍDO");
      expect(l).toContain("pnpm-lock.yaml");
    });

    it("diff real dentro do escopo ⇒ passou, com a contagem real", async () => {
      const apps = await setup("n6-c", {});
      await fs.writeFile(path.join(apps, "src", "a.ts"), "2");
      const body = await buildPullRequestBody(mkDb(qaOk, null) as never, "n6-c", "1.0.1", { evolution_scope: ["src/**"] });
      expect(line(body, "Gate de escopo")).toMatch(/\*\*passou\*\*.*diff real \(1 arquivo/);
    });

    it("TSK-FULL-TEST: CANCELLED ⇒ NOT_RUN explícito; DONE sem registro de execução ⇒ não executado (o aceite fecha como DONE); aprovada ⇒ passou; REPROVADA ⇒ FALHOU", async () => {
      await setup("n6-d", {});
      const ft = async (dialogue: Array<{ event_type: string | null; summary_human: string }>, status: string | null) =>
        line(await buildPullRequestBody(mkDb([...qaOk, ...dialogue], status) as never, "n6-d", "1.0.1", {}), "TSK-FULL-TEST (e2e)");
      expect(await ft([{ event_type: "step", summary_human: "⚠️ TASK-FULL-TEST NÃO EXECUTADA (NOT_RUN): full-test-server indisponível" }], "CANCELLED")).toMatch(/não executado.*NOT_RUN/);
      expect(await ft([], "DONE")).toMatch(/\*\*não executado[^*]*\*\*.*sem registro de execução/);
      expect(await ft([], null)).toMatch(/\*\*não executado/);
      expect(await ft([{ event_type: "step", summary_human: "✅ TASK-FULL-TEST (Claude Code): aprovada" }], "DONE")).toMatch(/\*\*passou\*\*/);
      expect(await ft([{ event_type: "step", summary_human: "⚠️ TASK-FULL-TEST (Claude Code): REPROVADA — gate P2P sem medição: baseline NÃO medida — ver QA_REPORT_TSK-FULL-TEST.md" }], "DONE")).toMatch(/\*\*FALHOU\*\*/);
    });

    it("baseline: no_tests (com exit≠0 avisa que o executor quebrou) e error ⇒ não executado; medida sem regressão ⇒ passou; regressões ⇒ FALHOU", async () => {
      const bl = async (baseline: Record<string, unknown>) => {
        await setup("n6-e", { evolution_baseline: baseline });
        return line(await buildPullRequestBody(mkDb(qaOk, null) as never, "n6-e", "1.0.1", {}), "Baseline");
      };
      const noTests = await bl({ status: "no_tests", no_tests: true, exit_code: 1, total: 0 });
      expect(noTests).toMatch(/\*\*não executado/);
      expect(noTests).toMatch(/SEM TESTES/);
      expect(noTests).toMatch(/exit 1/);
      expect(await bl({ status: "error", error: "npm install falhou (rc=243)" })).toMatch(/\*\*não executado[^*]*\*\*.*NÃO medida.*rc=243/);
      expect(await bl({ status: "ok", passed: 12, final: { status: "ok", regressions: [] } })).toMatch(/\*\*passou\*\*.*12 teste.*0 regressões/);
      expect(await bl({ status: "ok", passed: 12, final: { status: "ok", regressions: ["a", "b"] } })).toMatch(/\*\*FALHOU\*\*.*2 regressão/);
      expect(await bl({ status: "ok", passed: 12 })).toMatch(/\*\*não executado/);
    });
  });
});
