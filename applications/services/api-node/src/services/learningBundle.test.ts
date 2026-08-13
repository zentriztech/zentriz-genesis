/**
 * learningBundle.test.ts — Partilha de aprendizado LOCAL→PROD do Genesis (feature #3).
 *
 * Mocka db/client (não toca Postgres). Prova:
 *   • export lê skill + lessons_corpus(GLOBAL) + spec_catalog e produz manifest determinístico;
 *   • content_hash é estável independente da ordem de linhas retornadas pelo banco;
 *   • import é FALHA-FECHADA em schema incompatível (sem tocar o banco, ROLLBACK garantido);
 *   • import UPSERT por slug: conta inserted vs updated via (xmax=0), zera created_by/project_id,
 *     e reembedPending = nº de lições NOVAS.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Pool mockado: query() para o export (3 SELECTs), connect() devolve um client transacional.
const selectRows: Record<string, unknown[]> = { skill: [], lessons: [], specs: [] };
const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
// Fila de respostas para os INSERT ... RETURNING (xmax=0) do import, na ordem em que ocorrem.
let insertedFlags: Array<boolean | null> = [];
let insertPtr = 0;

const poolQuery = vi.fn(async (sql: string) => {
  if (/FROM skill/.test(sql)) return { rows: selectRows.skill };
  if (/FROM lessons_corpus/.test(sql)) return { rows: selectRows.lessons };
  if (/FROM spec_catalog/.test(sql)) return { rows: selectRows.specs };
  return { rows: [] };
});

// insertedFlags[i]: true → INSERT novo; false → UPDATE de conteúdo; null → NO-OP (WHERE falso, 0 linhas).
const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
  clientQueries.push({ sql, params: params ?? [] });
  if (/RETURNING \(xmax = 0\) AS inserted/.test(sql)) {
    const flag = insertedFlags[insertPtr];
    insertPtr++;
    if (flag === null) return { rows: [] as Array<{ inserted: boolean }> };
    return { rows: [{ inserted: flag ?? true }] };
  }
  return { rows: [] };
});
const clientRelease = vi.fn();

vi.mock("../db/client.js", () => ({
  pool: {
    query: (...a: unknown[]) => poolQuery(...(a as [string])),
    connect: async () => ({ query: (...a: unknown[]) => clientQuery(...(a as [string, unknown[]])), release: clientRelease }),
  },
}));

import {
  exportLearningBundle,
  importLearningBundle,
  LearningBundleError,
  LEARNING_SCHEMA_VERSION,
} from "./learningBundle.js";

beforeEach(() => {
  selectRows.skill = [];
  selectRows.lessons = [];
  selectRows.specs = [];
  clientQueries.length = 0;
  insertedFlags = [];
  insertPtr = 0;
  poolQuery.mockClear();
  clientQuery.mockClear();
  clientRelease.mockClear();
});

function skillRow(slug: string): Record<string, unknown> {
  return {
    slug, role: "dev", category: "stack", stack_key: "python-fastapi", domain: null,
    title: `t-${slug}`, body_md: `body ${slug}`, hard_rule: false, source: "human",
    origin_ref: null, ttl_days: null, status: "trusted",
  };
}
function lessonRow(slug: string): Record<string, unknown> {
  return {
    slug, category: "bug", scope: "ecosystem", stack_key: "generic", role: null,
    title: `t-${slug}`, body_md: `body ${slug}`, confidence: 1.0, pii_redacted: true, tags: ["x"],
  };
}
function specRow(slug: string): Record<string, unknown> {
  return {
    slug, title: `t-${slug}`, category: "Simples", description: "d",
    template_markdown: "# md", tags: ["a"],
  };
}

describe("exportLearningBundle", () => {
  it("agrega as três tabelas e produz manifest com content_hash", async () => {
    selectRows.skill = [skillRow("s1")];
    selectRows.lessons = [lessonRow("l1"), lessonRow("l2")];
    selectRows.specs = [specRow("sp1")];
    const bundle = await exportLearningBundle();
    expect(bundle.schemaVersion).toBe(LEARNING_SCHEMA_VERSION);
    expect(bundle.manifest).toEqual({
      skills: 1, lessons: 2, specs: 1, contentHash: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    // lessons_corpus é filtrado por project_id IS NULL (só aprendizado global viaja)
    const lessonsSql = poolQuery.mock.calls.map((c) => c[0] as string).find((s) => /FROM lessons_corpus/.test(s));
    expect(lessonsSql).toMatch(/project_id IS NULL/);
  });

  it("content_hash independe da ordem das linhas do banco", async () => {
    selectRows.skill = [skillRow("a"), skillRow("b")];
    const h1 = (await exportLearningBundle()).manifest.contentHash;
    selectRows.skill = [skillRow("b"), skillRow("a")];
    const h2 = (await exportLearningBundle()).manifest.contentHash;
    expect(h1).toBe(h2);
  });
});

describe("importLearningBundle", () => {
  it("falha-fechada em schemaVersion incompatível — sem tocar o banco", async () => {
    await expect(importLearningBundle({ schemaVersion: "wrong", skills: [], lessons: [], specs: [] }))
      .rejects.toBeInstanceOf(LearningBundleError);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("falha-fechada em bundle não-objeto", async () => {
    await expect(importLearningBundle(["não", "é", "objeto"])).rejects.toBeInstanceOf(LearningBundleError);
  });

  it("UPSERT: conta imported/updated/unchanged e reembedPending só p/ lições NOVAS", async () => {
    // skills: 1 nova, 1 update; lessons: 1 nova, 1 unchanged (no-op); spec: 1 nova
    insertedFlags = [true, false, true, null, true];
    const counts = await importLearningBundle({
      schemaVersion: LEARNING_SCHEMA_VERSION,
      skills: [skillRow("s1"), skillRow("s2")],
      lessons: [lessonRow("l1"), lessonRow("l2")],
      specs: [specRow("sp1")],
    });
    expect(counts).toEqual({
      skillsImported: 1, skillsUpdated: 1, skillsUnchanged: 0,
      lessonsImported: 1, lessonsUpdated: 0, lessonsUnchanged: 1,
      specsImported: 1, specsUpdated: 0, specsUnchanged: 0,
      reembedPending: 1,
    });
    // transação: BEGIN … COMMIT e release
    const sqls = clientQueries.map((q) => q.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    expect(clientRelease).toHaveBeenCalledOnce();
    // lições importadas como GLOBAIS (project_id NULL via literal na cláusula VALUES)
    const lessonInsert = clientQueries.find((q) => /INSERT INTO lessons_corpus/.test(q.sql));
    expect(lessonInsert?.sql).toMatch(/VALUES \(NULL,/);
    // confidence é monotônica (GREATEST) — a origem nunca regride
    expect(lessonInsert?.sql).toMatch(/confidence = GREATEST\(lessons_corpus\.confidence, EXCLUDED\.confidence\)/);
    // skill NÃO transporta created_by nem sobrescreve status do destino (destination-wins)
    const skillInsert = clientQueries.find((q) => /INSERT INTO skill/.test(q.sql));
    expect(skillInsert?.sql).not.toMatch(/created_by/);
    expect(skillInsert?.sql).not.toMatch(/status = EXCLUDED\.status/);
    // WHERE de conteúdo torna re-import idêntico um NO-OP verdadeiro
    expect(skillInsert?.sql).toMatch(/IS DISTINCT FROM/);
  });

  it("re-import idêntico é NO-OP verdadeiro (tudo unchanged, sem churn)", async () => {
    insertedFlags = [null, null, null];
    const counts = await importLearningBundle({
      schemaVersion: LEARNING_SCHEMA_VERSION,
      skills: [skillRow("s1")], lessons: [lessonRow("l1")], specs: [specRow("sp1")],
    });
    expect(counts.skillsUnchanged).toBe(1);
    expect(counts.lessonsUnchanged).toBe(1);
    expect(counts.specsUnchanged).toBe(1);
    expect(counts.reembedPending).toBe(0);
  });

  it("falha-fechada em registro com role fora do CHECK (→ não toca a transação)", async () => {
    await expect(importLearningBundle({
      schemaVersion: LEARNING_SCHEMA_VERSION,
      skills: [{ ...skillRow("s1"), role: "attacker" }], lessons: [], specs: [],
    })).rejects.toBeInstanceOf(LearningBundleError);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("falha-fechada em skill sem body_md obrigatório", async () => {
    const bad = skillRow("s1"); delete (bad as Record<string, unknown>).body_md;
    await expect(importLearningBundle({
      schemaVersion: LEARNING_SCHEMA_VERSION, skills: [bad], lessons: [], specs: [],
    })).rejects.toBeInstanceOf(LearningBundleError);
  });

  it("ROLLBACK quando um INSERT falha, propaga o erro e libera o client", async () => {
    clientQuery.mockImplementationOnce(async (sql: string, params?: unknown[]) => {
      clientQueries.push({ sql, params: params ?? [] });
      return { rows: [] }; // BEGIN
    }).mockImplementationOnce(async () => { throw new Error("db down"); }); // 1º INSERT
    await expect(importLearningBundle({
      schemaVersion: LEARNING_SCHEMA_VERSION, skills: [skillRow("s1")], lessons: [], specs: [],
    })).rejects.toThrow("db down");
    expect(clientQueries.some((q) => q.sql === "ROLLBACK")).toBe(true);
    expect(clientRelease).toHaveBeenCalledOnce();
  });

  it("arrays ausentes são normalizados p/ vazio (import vazio é no-op sem erro)", async () => {
    const counts = await importLearningBundle({ schemaVersion: LEARNING_SCHEMA_VERSION });
    expect(counts.skillsImported + counts.lessonsImported + counts.specsImported).toBe(0);
  });
});
