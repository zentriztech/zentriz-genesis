/**
 * evolutionScope.test.ts — AU (N-3/N-6): escopo do RFC e lockfiles estranhos, lado api-node.
 */
import { describe, it, expect } from "vitest";
import { isPathInScope, pathsOutsideScope, foreignLockfiles, listChangedFiles, detectForeignLockfiles } from "./evolutionScope.js";
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
