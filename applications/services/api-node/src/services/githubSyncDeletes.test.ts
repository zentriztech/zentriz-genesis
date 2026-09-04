import { describe, it, expect } from "vitest";
import { computeDeletions, SYNC_DELETE_PROTECTED } from "./github.js";

describe("H4 — computeDeletions (deleções a propagar para evolution/vN)", () => {
  const remote = ["src/a.ts", "src/b.ts", "src/old.ts", "Dockerfile", ".github/workflows/deploy.yml", "CHANGELOG.md", "only-remote.ts", "docs/x.md"];
  const local = new Set(["src/a.ts", "src/b.ts", "docs/x.md"]);
  const tracked = new Set(["src/a.ts", "src/b.ts", "src/old.ts", "Dockerfile", ".github/workflows/deploy.yml", "CHANGELOG.md", "docs/x.md"]);

  it("apaga só o que existia no clone local e sumiu; nunca protegidos nem só-remotos", () => {
    expect(computeDeletions(remote, local, tracked)).toEqual(["src/old.ts"]);
  });
  it("H4-A: path rastreado que EXISTE no disco mas ficou fora do walk (dist/, >1,5 MB) NÃO é apagado", () => {
    const remote2 = ["src/a.ts", "dist/app.js", "assets/big.bin", "src/old.ts"];
    const tracked2 = new Set(remote2);
    const onDisk = new Set(["src/a.ts", "dist/app.js", "assets/big.bin"]);   // old.ts foi removido de verdade
    expect(computeDeletions(remote2, new Set(["src/a.ts"]), tracked2, SYNC_DELETE_PROTECTED, (p) => onDisk.has(p))).toEqual(["src/old.ts"]);
  });
  it("sem lista de rastreados (apps/ não é clone) → não apaga nada (fail-safe)", () => {
    expect(computeDeletions(remote, local, null)).toEqual([]);
  });
  it("protegidos cobrem workflows, Dockerfile, entrypoint, dockerignore, CHANGELOG, README, LICENSE", () => {
    for (const p of [".github/workflows/a.yml", "Dockerfile", "docker-entrypoint.sh", ".dockerignore", "CHANGELOG.md", "README.md", "LICENSE"]) {
      expect(SYNC_DELETE_PROTECTED.test(p)).toBe(true);
    }
    expect(SYNC_DELETE_PROTECTED.test("src/Dockerfile.ts")).toBe(false);
    expect(SYNC_DELETE_PROTECTED.test("apps/README.md")).toBe(false); // só raiz
  });
});
