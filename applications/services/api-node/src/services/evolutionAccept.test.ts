import { describe, it, expect, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evo-accept-"));
process.env.UPLOAD_DIR = path.join(tmpRoot, "uploads");
process.env.PROJECT_FILES_ROOT = path.join(tmpRoot, "files");

const { bumpSemver, lastReleasedVersion, releaseChangelog, finalizeEvolutionChangelog, supersedeParent, evolutionBranchName, buildPullRequestBody } = await import("./evolutionAccept.js");

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
    expect(JSON.parse(parentUpd.params[2] as string)).toMatchObject({ superseded_by: "child", superseded_version: "1.1.0" });
    expect(await supersedeParent(db as never, "child", null, "1.1.0")).toBe(false);
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
});
