/**
 * 🔴 GAP-159 — testes da PERSISTÊNCIA do censo (migração 121).
 *
 * O que estes testes protegem não é o SQL: é o significado do que fica gravado. Três coisas farão a
 * série mentir se apodrecerem:
 *
 *   1. a correção pós-restart ser indistinguível de uma medição do processo (`head_source`);
 *   2. `outros` negativo ser "arrumado" no caminho até o banco (negativo é contagem dupla, com nome);
 *   3. o instrumento derrubar — ou fazer esperar — a chamada de LLM que ele mede.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PROMPT_CACHE_TTL_MS, recordPromptCensus, resetPromptCensusHeads } from "./promptCensus.js";
import { censusRow, persistPromptCensus, reconcileHeadFromDb, makePgPromptCensusSink } from "./promptCensusStore.js";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  resetPromptCensusHeads();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); });

/** Banco de mentira que registra as chamadas e devolve o que o teste mandar. */
function fakeDb(respostas: Array<{ rows: unknown[] }> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return respostas[i++] ?? { rows: [] };
    },
  };
}

const censo = (over: Partial<Parameters<typeof recordPromptCensus>[0]> = {}) =>
  recordPromptCensus({ origem: "api-gapfile", role: "CTO", file: "a.md", total: 100, fields: { file_content: 90 }, ...over });

describe("censusRow — o que fica gravado é o que foi medido", () => {
  it("cabeça medida pelo PROCESSO é declarada `memoria`", () => {
    const r = censusRow(censo({ head: "cabeça estável ".repeat(500) }), null);
    expect(r.head_source).toBe("memoria");
    expect(r.head_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(r.head_cacheable).toBe(true);
  });

  it("sem cabeça declarada NÃO há fonte de veredicto (NULL ≠ 'memoria')", () => {
    const r = censusRow(censo(), null);
    expect(r.head_hash).toBeNull();
    expect(r.head_source).toBeNull();
    expect(r.head_hit_within_ttl).toBeNull();
  });

  it("`outros` negativo vai CRU para o banco — é contagem dupla, não economia", () => {
    const r = censusRow(recordPromptCensus({ origem: "t", total: 100, fields: { a: 80, b: 80 } }), null);
    expect(r.outros).toBe(-60);
  });

  it("veredicto reconciliado no banco é declarado `banco` e o contador deixa de dizer 'visto 1 vez'", () => {
    const r = censusRow(censo({ head: "cabeça ".repeat(1000) }), { sinceLastMs: 30_000, hitWithinTtl: true });
    expect(r.head_source).toBe("banco");
    expect(r.head_since_last_ms).toBe(30_000);
    expect(r.head_hit_within_ttl).toBe(true);
    expect(r.head_seen).toBe(2);
  });
});

/**
 * 🔴 GAP-167 — a série que decide o ponto de cache passa a levar os CORTES de prefixo, não só a cabeça
 * inteira. Medido em prod: 57 chamadas de `api-gapfile`, 0 com cabeça repetida — porque a cabeça
 * declarada é por arquivo por construção. Sem os cortes no banco, a decisão "onde marcar" continuaria
 * sem dado depois do primeiro deploy.
 */
describe("censusRow — GAP-167: os cortes de prefixo chegam ao banco (e o que NÃO é reconciliado)", () => {
  it("cabeça declarada grava o maior acerto e a série inteira de cortes", () => {
    const r = censusRow(censo({ head: "cabeça estável ".repeat(500) }), null);
    expect(r.head_prefix_hit_chars).toBe(0);   // estreia: 0 é MEDIÇÃO (avaliou e não acertou)
    expect(r.head_prefix_cuts).toEqual([{ chars: 4_096, seen: 1, hitWithinTtl: false }]);
  });

  it("sem cabeça declarada os cortes são NULL — ausência de medição ≠ medição de zero", () => {
    const r = censusRow(censo(), null);
    expect(r.head_prefix_hit_chars).toBeNull();
    expect(r.head_prefix_cuts).toBeNull();
  });

  it("🔴 a reconciliação pelo banco NÃO inventa acerto de corte (o banco não guarda hash por corte)", () => {
    // Este é o limite declarado da migração 122: depois de um restart o `head_hash` pode ser corrigido
    // pelo banco, mas os cortes ficam subestimados por uma janela. Subestimar dito é aceitável;
    // afirmar acerto que não se pode observar seria o defeito do GAP-147 de novo.
    const r = censusRow(censo({ head: "cabeça ".repeat(1000) }), { sinceLastMs: 30_000, hitWithinTtl: true });
    expect(r.head_source).toBe("banco");
    expect(r.head_prefix_hit_chars).toBe(0);
    expect(r.head_prefix_cuts!.every((c) => !c.hitWithinTtl)).toBe(true);
  });

  it("o corte que REPETIU dentro do TTL é o que fica gravado", () => {
    const head = "prefixo comum ".repeat(1_000);   // 14.000c ⇒ cortes 4096 e 8192
    censo({ head });
    const r = censusRow(censo({ head }), null);
    expect(r.head_prefix_hit_chars).toBe(8_192);
    expect(r.head_prefix_cuts).toEqual([
      { chars: 4_096, seen: 2, hitWithinTtl: true },
      { chars: 8_192, seen: 2, hitWithinTtl: true },
    ]);
  });

  it("o INSERT leva as duas colunas novas como jsonb — e nenhum byte do prefixo", async () => {
    const db = fakeDb();
    await persistPromptCensus(db, censo({ head: "SIGILO-DA-SPEC ".repeat(500) }));
    const insert = db.calls.at(-1)!;
    expect(insert.sql).toContain("head_prefix_hit_chars");
    expect(insert.sql).toContain("head_prefix_cuts");
    expect(insert.sql).toContain("$15::jsonb");
    expect(insert.params).toHaveLength(15);
    expect(insert.params).toContain(JSON.stringify([{ chars: 4_096, seen: 1, hitWithinTtl: false }]));
    expect(JSON.stringify(insert.params)).not.toContain("SIGILO-DA-SPEC");
  });

  it("caminho sem cabeça grava NULL nas duas colunas (nada de `0` que pareceria medição)", async () => {
    const db = fakeDb();
    await persistPromptCensus(db, censo());
    const params = db.calls.at(-1)!.params;
    expect(params[13]).toBeNull();
    expect(params[14]).toBeNull();
  });
});

describe("reconcileHeadFromDb — só se pergunta ao banco quando o processo NÃO sabe", () => {
  it("processo já conhecia o prefixo ⇒ nenhuma query (o veredicto dele é o melhor que existe)", async () => {
    const head = "cabeça ".repeat(1000);
    censo({ head });                       // estreia
    const segundo = censo({ head });       // o processo já viu
    const db = fakeDb();
    expect(await reconcileHeadFromDb(db, segundo)).toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  it("estreia no processo + prefixo no banco dentro do TTL ⇒ ACERTO corrigido", async () => {
    const db = fakeDb([{ rows: [{ created_at: new Date(Date.now() - 30_000).toISOString() }] }]);
    const rec = await reconcileHeadFromDb(db, censo({ head: "cabeça ".repeat(1000) }));
    expect(rec?.hitWithinTtl).toBe(true);
    expect(rec!.sinceLastMs).toBeGreaterThanOrEqual(30_000);
    expect(db.calls[0].sql).toContain("head_hash");
  });

  it("prefixo no banco FORA do TTL não é acerto (o provedor já expirou o prefixo)", async () => {
    const db = fakeDb([{ rows: [{ created_at: new Date(Date.now() - PROMPT_CACHE_TTL_MS - 60_000) }] }]);
    const rec = await reconcileHeadFromDb(db, censo({ head: "cabeça ".repeat(1000) }));
    expect(rec?.hitWithinTtl).toBe(false);
  });

  it("banco sem a cabeça ⇒ estreia MESMO (nada é inventado)", async () => {
    const db = fakeDb([{ rows: [] }]);
    expect(await reconcileHeadFromDb(db, censo({ head: "cabeça ".repeat(1000) }))).toBeNull();
  });

  it("relógio do banco à frente do processo é RUÍDO, não acerto", async () => {
    const db = fakeDb([{ rows: [{ created_at: new Date(Date.now() + 120_000) }] }]);
    expect(await reconcileHeadFromDb(db, censo({ head: "cabeça ".repeat(1000) }))).toBeNull();
  });

  it("caminho sem cabeça declarada não consulta o banco", async () => {
    const db = fakeDb();
    expect(await reconcileHeadFromDb(db, censo())).toBeNull();
    expect(db.calls).toHaveLength(0);
  });
});

describe("persistPromptCensus", () => {
  it("grava tamanhos e jsonb de campos — e nenhum conteúdo de spec", async () => {
    const db = fakeDb();
    const segredo = "TEXTO-SIGILOSO-DA-SPEC ".repeat(50);
    await persistPromptCensus(db, censo({ head: segredo }));
    const insert = db.calls.at(-1)!;
    expect(insert.sql).toContain("INSERT INTO prompt_census");
    expect(JSON.stringify(insert.params)).not.toContain("TEXTO-SIGILOSO-DA-SPEC");
    expect(insert.params).toContain(JSON.stringify({ file_content: 90 }));
    expect(insert.params).toContain("memoria");
  });

  it("correção pós-restart é LOGADA (o log já tinha dito 'estreia'; divergir em silêncio é pior)", async () => {
    const db = fakeDb([{ rows: [{ created_at: new Date(Date.now() - 45_000).toISOString() }] }]);
    await persistPromptCensus(db, censo({ head: "cabeça ".repeat(1000) }));
    const linha = logs.find((l) => l.includes("correção de cabeça")) ?? "";
    expect(linha).toContain("fonte=banco");
    expect(linha).toContain("ACERTO dentro do TTL");
    expect(db.calls.at(-1)!.params).toContain("banco");
  });

  it("falha da CONSULTA de reconciliação não impede a gravação da linha", async () => {
    const calls: string[] = [];
    const db = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes("SELECT")) throw new Error("timeout");
        return { rows: [] };
      },
    };
    await persistPromptCensus(db, censo({ head: "cabeça ".repeat(1000) }));
    expect(calls.some((s) => s.includes("INSERT INTO prompt_census"))).toBe(true);
  });

  it("sink de produção não lança quando o banco cai — o log segue sendo a medição", async () => {
    const sink = makePgPromptCensusSink({ query: async () => { throw new Error("banco fora"); } });
    expect(() => sink(censo())).not.toThrow();
    // O `void` do sink é assíncrono: espera o microtask para o aviso aparecer.
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.join("\n")).toContain("persistência indisponível");
  });
});
