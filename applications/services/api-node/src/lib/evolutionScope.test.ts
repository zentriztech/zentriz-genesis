/**
 * evolutionScope.test.ts — AU (N-3/N-6): escopo do RFC e lockfiles estranhos, lado api-node.
 */
import { describe, it, expect } from "vitest";
import { isPathInScope, pathsOutsideScope, foreignLockfiles, listChangedFiles, detectForeignLockfiles, isGeneratedArtifact, filterPublishable, scopeGateFailure } from "./evolutionScope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isPathInScope (mesma semântica do runner)", () => {
  const scope = ["apps/src/retry/**", "src/util/retry.util.ts"];
  it("casa glob com e sem prefixo apps/, sempre permite testes/docs/CHANGELOG", () => {
    expect(isPathInScope("src/retry/a.ts", scope)).toBe(true);
    expect(isPathInScope("src/util/retry.util.ts", scope)).toBe(true);
    expect(isPathInScope("src/util/retry.util.spec.ts", scope)).toBe(true);
    expect(isPathInScope("CHANGELOG.md", scope)).toBe(true);
    expect(isPathInScope("docs/x.md", scope)).toBe(true);
  });
  it("lockfile e arquivo alheio ficam FORA", () => {
    expect(pathsOutsideScope(["pnpm-lock.yaml", "src/retry/a.ts", "package.json"], scope)).toEqual(["pnpm-lock.yaml", "package.json"]);
  });
  it("glob de diretório sem curinga casa a árvore", () => {
    expect(isPathInScope("src/retry/deep/x.ts", ["src/retry"])).toBe(true);
    expect(isPathInScope("src/other/x.ts", ["src/retry"])).toBe(false);
  });
});

describe("foreignLockfiles", () => {
  it("npm + pnpm na mesma pasta, sem rastreio/packageManager: fica o npm, sai o pnpm (caso do PR #5 da 4.5b)", () => {
    expect(foreignLockfiles(["package-lock.json", "pnpm-lock.yaml", "src/a.ts"])).toEqual(["pnpm-lock.yaml"]);
  });
  it("o que o clone da linhagem já rastreia manda (produto pnpm com npm gerado por engano)", () => {
    expect(foreignLockfiles(["package-lock.json", "pnpm-lock.yaml"], { tracked: new Set(["pnpm-lock.yaml"]) })).toEqual(["package-lock.json"]);
  });
  it("sem rastreio, o campo packageManager do package.json decide", () => {
    expect(foreignLockfiles(["package-lock.json", "pnpm-lock.yaml"], { packageManagerOf: () => "pnpm@9.1.0" })).toEqual(["package-lock.json"]);
  });
  it("um único gerenciador por pasta: nada sai (não há como provar que é estranho); pastas independentes", () => {
    expect(foreignLockfiles(["pnpm-lock.yaml"])).toEqual([]);
    expect(foreignLockfiles(["a/package-lock.json", "b/pnpm-lock.yaml"])).toEqual([]);
    expect(foreignLockfiles(["a/package-lock.json", "a/yarn.lock", "b/pnpm-lock.yaml"])).toEqual(["a/yarn.lock"]);
  });
});

describe("listChangedFiles / detectForeignLockfiles (git real)", () => {
  it("lista o diff real de apps/ (modificado + novo), ignora node_modules e devolve null fora de um clone", async () => {
    const root = mkdtempSync(join(tmpdir(), "au-scope-"));
    try {
      const sh = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=a@b.c", "-c", "user.name=t", ...a]);
      execFileSync("git", ["init", "-q", root]);
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "a.ts"), "1");
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "package-lock.json"), "{}");
      sh("add", "-A"); sh("commit", "-qm", "base");
      writeFileSync(join(root, "src", "a.ts"), "2");
      writeFileSync(join(root, "pnpm-lock.yaml"), "x");
      mkdirSync(join(root, "node_modules", "m"), { recursive: true });
      writeFileSync(join(root, "node_modules", "m", "i.js"), "x");
      expect(await listChangedFiles(root)).toEqual(["pnpm-lock.yaml", "src/a.ts"]);
      // package-lock.json está rastreado no clone ⇒ o pnpm-lock.yaml criado depois é o estranho
      expect(await detectForeignLockfiles(root, ["package-lock.json", "pnpm-lock.yaml", "src/a.ts"])).toEqual(["pnpm-lock.yaml"]);
      const plain = mkdtempSync(join(tmpdir(), "au-scope-nogit-"));
      expect(await listChangedFiles(plain)).toBeNull();
      rmSync(plain, { recursive: true, force: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("AV / M-3 — artefatos gerados e .gitignore", () => {
  it("isGeneratedArtifact: build/dist/venv/caches e .env* são gerados; .env.example e fontes não", () => {
    for (const p of ["build/app.js", "packages/a/dist/x.js", "target/classes/A.class", "venv/lib/x.py", "src/__pycache__/a.pyc", ".env", "api/.env.production", "node_modules/x/i.js", "a/b.pyc"]) {
      expect(isGeneratedArtifact(p), p).toBe(true);
    }
    for (const p of ["src/a.ts", ".env.example", "src/env/index.ts", "docs/build-notes.md", "Dockerfile"]) expect(isGeneratedArtifact(p), p).toBe(false);
  });
  it("scopeGateFailure: só filho de card com gate `failed`", () => {
    expect(scopeGateFailure({ evolution_origin: "card", evolution_scope_gate: { status: "failed", detail: "d" } })).toBe("d");
    expect(scopeGateFailure({ evolution_origin: "card", evolution_scope_gate: { status: "passed" } })).toBeNull();
    expect(scopeGateFailure({ evolution_origin: "card", evolution_scope_gate: { status: "not_run" } })).toBeNull();
    expect(scopeGateFailure({ evolution_scope_gate: { status: "failed", detail: "d" } })).toBeNull();
    expect(scopeGateFailure(null)).toBeNull();
  });
  it("filterPublishable (git real): rastreado sempre fica; gerado não rastreado e ignorado pelo .gitignore saem; fonte nova fica", async () => {
    const root = mkdtempSync(join(tmpdir(), "av-m3-"));
    try {
      const sh = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=a@b.c", "-c", "user.name=t", ...a]);
      execFileSync("git", ["init", "-q", root]);
      mkdirSync(join(root, "src")); mkdirSync(join(root, "build")); mkdirSync(join(root, "private"));
      writeFileSync(join(root, ".gitignore"), "*.secret.json\nprivate/\n");
      writeFileSync(join(root, "src", "a.ts"), "1");
      writeFileSync(join(root, "build", "keep.js"), "tracked-build");      // build/ RASTREADO no produto: fica
      sh("add", "-A"); sh("commit", "-qm", "base");
      writeFileSync(join(root, "src", "novo.ts"), "n");
      writeFileSync(join(root, "build", "out.js"), "gerado");              // build/ não rastreado: sai
      writeFileSync(join(root, "cfg.secret.json"), "{}");                  // .gitignore: sai
      writeFileSync(join(root, "private", "p.txt"), "p");                  // .gitignore (dir): sai
      writeFileSync(join(root, ".env"), "TOKEN=x");                        // segredo local: sai
      writeFileSync(join(root, ".env.example"), "TOKEN=");                 // documentação: fica
      const all = ["src/a.ts", "src/novo.ts", "build/keep.js", "build/out.js", "cfg.secret.json", "private/p.txt", ".env", ".env.example"];
      const { kept, excluded } = await filterPublishable(root, all);
      expect(excluded).toEqual([".env", "build/out.js", "cfg.secret.json", "private/p.txt"]);
      expect(kept).toEqual(["src/a.ts", "src/novo.ts", "build/keep.js", ".env.example"]);
      // o gate de escopo também não vê o gerado não rastreado como diff do produto
      expect(await listChangedFiles(root)).toEqual([".env.example", "src/novo.ts"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("filterPublishable sem git: vale só a regra de artefato gerado", async () => {
    const plain = mkdtempSync(join(tmpdir(), "av-m3-nogit-"));
    try {
      const r = await filterPublishable(plain, ["src/a.ts", "dist/x.js", ".env"]);
      expect(r.kept).toEqual(["src/a.ts"]);
      expect(r.excluded).toEqual([".env", "dist/x.js"]);
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });
});
