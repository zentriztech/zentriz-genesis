/**
 * specSnapshots.test.ts — a rede de segurança da spec (G2, migração 092).
 *
 * O QUE ISTO PROTEGE: `project_spec_files` guarda UMA versão viva por projeto e a escrita é
 * in-place (`writeFile`). Sem snapshot, uma revisão ruim aplicada pelo laço autônomo é PERDA
 * DEFINITIVA de conteúdo — foi o que aconteceu em prod 2026-09-05 (7 de 14 seções).
 */
import { describe, it, expect } from "vitest";
import { snapshotSpecFile, SPEC_SNAPSHOT_KEEP } from "./specSnapshots.js";

type Call = { sql: string; params: unknown[] };

function dbWith(lastSha: string | null): { db: never; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (/SELECT content_sha256/.test(sql)) {
        return { rows: lastSha ? [{ content_sha256: lastSha }] : [], rowCount: lastSha ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as never;
  return { db, calls };
}

const base = { projectId: "proj-1", filePath: "/project-files/p/docs/spec/PRODUCT_SPEC.md", reason: "autonomy:round-2", createdBy: "user-1" };

describe("snapshotSpecFile", () => {
  it("guarda o conteúdo ANTERIOR e poda o histórico na mesma passada", async () => {
    const { db, calls } = dbWith(null);
    expect(await snapshotSpecFile(db, { ...base, content: "# Spec antiga\n\n## 1. Contexto\ntexto" })).toBe(true);
    const insert = calls.find((c) => /INSERT INTO project_spec_snapshots/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert!.params[1]).toBe("proj-1");
    expect(insert!.params[3]).toContain("# Spec antiga"); // o conteúdo SUBSTITUÍDO, não o novo
    expect(insert!.params[6]).toBe("autonomy:round-2");
    const prune = calls.find((c) => /DELETE FROM project_spec_snapshots/.test(c.sql));
    expect(prune).toBeDefined();
    expect(prune!.params[2]).toBe(SPEC_SNAPSHOT_KEEP);
  });

  it("não duplica quando o último snapshot já é o conteúdo atual (mesmo sha)", async () => {
    const content = "# Spec\n\n## 1. Contexto\ntexto";
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
    const { db, calls } = dbWith(sha);
    expect(await snapshotSpecFile(db, { ...base, content })).toBe(true);
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  it("conteúdo anterior vazio = não havia nada a perder → ok sem escrever", async () => {
    const { db, calls } = dbWith(null);
    expect(await snapshotSpecFile(db, { ...base, content: "" })).toBe(true);
    expect(await snapshotSpecFile(db, { ...base, content: null })).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("falha de banco devolve FALSE — o chamador autônomo aborta a escrita", async () => {
    const db = { query: async () => { throw new Error("db down"); } } as unknown as never;
    expect(await snapshotSpecFile(db, { ...base, content: "# Spec\ntexto" })).toBe(false);
  });
});
