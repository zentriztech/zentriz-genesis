/**
 * Fase 3 / 3.5 — conferência do card contra o HEAD novo (núcleo puro): ok | stale | conflict com motivos, globs do runner (port) e árvore do repositório.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { evaluateRevalidation, globMatches, globToRegExp, isAlwaysAllowedGlob, listRepoTree, type RepoTree, type RevalidateInput } from "./cardRevalidate.js";

const tree = (files: string[]): RepoTree => ({ available: true, files, capped: false, root: "/x" });
const NO_TREE: RepoTree = { available: false, files: [], capped: false, root: null };
const input = (o: Partial<RevalidateInput> = {}): RevalidateInput => ({
  rfcs: [{ path: "docs/rfc/RFC-0001-x.md", filesAllowed: ["apps/api/src/deliveries/**", "tests/**"], text: "# RFC\nAltera a entrega." }],
  requestText: "Exportar entregas", previousBase: "H1", head: { id: "H1", version: 1 }, productId: null,
  specNow: [{ path: "spec.md", sha: "a" }], specBefore: null, treeNow: tree(["api/src/deliveries/list.ts", "api/src/users/u.ts"]), treeBefore: null,
  headSpecHashChanged: false, ...o,
});

describe("glob do gate de escopo (port do runner)", () => {
  it("com ou sem prefixo apps/, diretório casa a árvore, ** e *", () => {
    expect(globMatches("apps/api/src/deliveries/**", "api/src/deliveries/list.ts")).toBe(true);
    expect(globMatches("api/src/deliveries/**", "api/src/deliveries/a/b.ts")).toBe(true);
    expect(globMatches("apps/api/src/deliveries", "api/src/deliveries/list.ts")).toBe(true);   // glob de diretório
    expect(globMatches("apps/api/src/*.ts", "api/src/x.ts")).toBe(true);
    expect(globMatches("apps/api/src/*.ts", "api/src/sub/x.ts")).toBe(false);
    expect(globMatches("**/*.test.ts", "api/src/a/b.test.ts")).toBe(true);
    expect(globMatches("apps/api/src/users/**", "api/src/deliveries/list.ts")).toBe(false);
    expect(globToRegExp("apps/api/").test("apps/api/x")).toBe(true);
  });
});

describe("globs sempre liberados pelo gate (tests/docs/CHANGELOG) não entram na conferência", () => {
  it("classifica", () => {
    for (const g of ["tests/**", "docs/**", "**/tests/**", "**/*.test.ts", "CHANGELOG.md", "./docs/rfc/x.md", "__tests__/a.ts"]) expect(isAlwaysAllowedGlob(g), g).toBe(true);
    for (const g of ["apps/api/src/**", "apps/web/src/tests-util.ts", "api/src/deliveries"]) expect(isAlwaysAllowedGlob(g), g).toBe(false);
  });
  it("não geram aviso de 'sem arquivo'", () => {
    const o = evaluateRevalidation(input({ rfcs: [{ path: "docs/rfc/RFC-0001-x.md", filesAllowed: ["tests/**", "docs/**"], text: "" }] }));
    expect(o.globs).toEqual([]);
    expect(o.reasons.filter((r) => r.code === "GLOB_UNMATCHED")).toEqual([]);
  });
});

describe("evaluateRevalidation", () => {
  it("ok: base == HEAD e globs casam", () => {
    const o = evaluateRevalidation(input());
    expect(o.verdict).toBe("ok");
    expect(o.moved).toBe(false);
    expect(o.globs.find((g) => g.glob === "apps/api/src/deliveries/**")).toMatchObject({ matchedNow: true });
    expect(o.reasons.filter((r) => r.severity === "conflict")).toEqual([]);
  });
  it("glob que nunca casou é só aviso (recurso novo cria a pasta)", () => {
    const o = evaluateRevalidation(input({ rfcs: [{ path: "docs/rfc/RFC-0001-x.md", filesAllowed: ["apps/api/src/novo/**"], text: "" }] }));
    expect(o.verdict).toBe("ok");
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: "GLOB_UNMATCHED", severity: "warning" }));
  });
  it("stale: HEAD andou e o RFC segue compatível", () => {
    const o = evaluateRevalidation(input({
      previousBase: "H1", head: { id: "H2", version: 2 },
      treeBefore: tree(["api/src/deliveries/list.ts"]), treeNow: tree(["api/src/deliveries/list.ts", "api/src/deliveries/csv.ts"]),
      specBefore: [{ path: "spec.md", sha: "a" }], specNow: [{ path: "spec.md", sha: "b" }],
    }));
    expect(o.verdict).toBe("stale");
    expect(o.moved).toBe(true);
    expect(o.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["BASE_MOVED", "NEEDS_HUMAN_REVIEW"]));
    expect(o.specDiff).toEqual({ added: [], removed: [], changed: ["spec.md"] });
  });
  it("conflict: glob que casava na base anterior e não casa mais", () => {
    const o = evaluateRevalidation(input({
      previousBase: "H1", head: { id: "H2", version: 2 },
      treeBefore: tree(["api/src/deliveries/list.ts"]), treeNow: tree(["api/src/entregas/list.ts"]),
    }));
    expect(o.verdict).toBe("conflict");
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: "GLOB_NO_LONGER_MATCHES", severity: "conflict", details: { glob: "apps/api/src/deliveries/**", rfc: "docs/rfc/RFC-0001-x.md" } }));
  });
  it("conflict: o RFC cita arquivo de spec removido; arquivo alterado é só aviso", () => {
    const o = evaluateRevalidation(input({
      previousBase: "H1", head: { id: "H2", version: 2 }, treeNow: NO_TREE,
      rfcs: [{ path: "docs/rfc/RFC-0001-x.md", filesAllowed: [], text: "Segue as regras de docs/regras-entrega.md e de docs/prazos.md." }],
      specBefore: [{ path: "docs/regras-entrega.md", sha: "1" }, { path: "docs/prazos.md", sha: "2" }, { path: "docs/outro.md", sha: "3" }],
      specNow: [{ path: "docs/prazos.md", sha: "9" }, { path: "docs/outro.md", sha: "3" }],
    }));
    expect(o.verdict).toBe("conflict");
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: "RFC_REFERENCES_REMOVED_SPEC", severity: "conflict" }));
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: "RFC_REFERENCES_CHANGED_SPEC", severity: "warning" }));
  });
  it("sem clone em disco: declara que NÃO conferiu os globs (info) e segue pela spec", () => {
    const o = evaluateRevalidation(input({ treeNow: NO_TREE, previousBase: "H1", head: { id: "H2", version: 2 } }));
    expect(o.verdict).toBe("stale");
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: "REPO_UNAVAILABLE", severity: "info" }));
    expect(o.repo.available).toBe(false);
  });
  it("a spec do mesmo HEAD mudou desde o carimbo ⇒ stale", () => {
    const o = evaluateRevalidation(input({ headSpecHashChanged: true }));
    expect(o.verdict).toBe("stale");
    expect(o.reasons.map((r) => r.code)).toContain("BASE_SPEC_CHANGED");
  });
});

describe("listRepoTree", () => {
  it("lê apps/ (sem node_modules/.git), por produto ou direto; sem raiz ⇒ indisponível", async () => {
    const root = mkdtempSync(join(tmpdir(), "k1-repo-"));
    try {
      mkdirSync(join(root, "prod", "proj", "apps", "api", "src"), { recursive: true });
      mkdirSync(join(root, "prod", "proj", "apps", "node_modules", "x"), { recursive: true });
      writeFileSync(join(root, "prod", "proj", "apps", "api", "src", "a.ts"), "x");
      writeFileSync(join(root, "prod", "proj", "apps", "node_modules", "x", "i.js"), "x");
      const t = await listRepoTree("proj", "prod", { PROJECT_FILES_ROOT: root } as NodeJS.ProcessEnv);
      expect(t).toMatchObject({ available: true, files: ["api/src/a.ts"] });
      expect((await listRepoTree("outro", "prod", { PROJECT_FILES_ROOT: root } as NodeJS.ProcessEnv)).available).toBe(false);
      expect((await listRepoTree("proj", "prod", { PROJECT_FILES_ROOT: "" } as NodeJS.ProcessEnv)).available).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
