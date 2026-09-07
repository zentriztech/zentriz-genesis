/**
 * 🔴 GAP-69 — o teto de crescimento se REGENERAVA a cada run: 2% compostos.
 *
 * Medido em prod (NVX LastMile, 2026-09-07): nove runs sobre a MESMA spec levaram-na de 986.117 a
 * 1.136.538 bytes (+15,3% em 7h46) enquanto a contagem de GAPs subia de 26 para 38. Nenhuma run abusou
 * do teto — cada uma gastou quase exatamente o que lhe foi dado, e como o orçamento é 2% de uma massa
 * que ele mesmo faz crescer, a run seguinte recebia mais. O orçamento funcionava como META DE GASTO.
 *
 * Estes testes cobrem as duas peças: a dívida da janela (`projectGrowthUsedInWindow`) e como ela entra
 * no orçamento (`growthAllowance`), incluindo as duas guardas que impedem a correção de virar um
 * estrangulamento: monotonicidade enquanto o PISO governa, e crédito de quem encolhe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { growthAllowance, projectGrowthUsedInWindow } from "./specAutonomy.js";

/** Rodada do log, no formato mínimo que as contas de crescimento leem. */
function R(over: Record<string, unknown>) {
  return { round: 1, pass: 0, applied: true, deltaChars: 0, ...over } as never;
}

describe("growthAllowance — dívida das runs irmãs (GAP-69)", () => {
  it("com a spec grande, o que as irmãs escreveram SAI do orçamento desta run", () => {
    // Fatos da run `f101303f`: proporcional 22.731 (2% de 1.136.538 bytes), nada gasto ainda.
    const run = { passes: 0, rounds: [] as never[] };
    expect(growthAllowance(run, 2_000, 22_731, 0)).toBe(22_731);
    // A run anterior (`b1bc1195`) escreveu +19.414 na mesma janela ⇒ sobra pouco, não outro 2%.
    expect(growthAllowance(run, 2_000, 22_731, 19_414)).toBe(3_317);
  });

  it("duas runs seguidas dividem UM orçamento em vez de ganhar um cada", () => {
    const base = 20_000;
    const primeira = growthAllowance({ passes: 0, rounds: [] as never[] }, 2_000, base, 0);
    const segunda = growthAllowance({ passes: 0, rounds: [] as never[] }, 2_000, base, primeira);
    // Antes seriam 40.000. Agora a segunda só recebe o resto — mais o piso, que é intocável.
    expect(primeira).toBe(20_000);
    expect(segunda).toBe(2_000);
  });

  it("🔴 a dívida PARA NO PISO — margem zero não consolida, só descarta rodada paga", () => {
    // A dívida real do NVX LastMile na janela é 154.456 chars: crua, zeraria a margem de toda run nova
    // por 24 h. Cada rodada que crescesse 1 caractere seria descartada (penhasco do GAP-64) e a
    // contagem de GAPs ficaria parada — o oposto do critério do Jean.
    expect(growthAllowance({ passes: 0, rounds: [] as never[] }, 2_000, 22_731, 154_456)).toBe(2_000);
    // E o piso cresce com os passes, como na regra do GAP-33.
    expect(growthAllowance({ passes: 3, rounds: [] as never[] }, 2_000, 22_731, 154_456)).toBe(8_000);
  });

  it("o COMPOSTO morre: 5 runs seguidas somam ~1 janela + pisos, não 5 janelas", () => {
    const prop = 20_000;
    let acumulado = 0;
    for (let i = 0; i < 5; i++) {
      acumulado += growthAllowance({ passes: 0, rounds: [] as never[] }, 2_000, prop, acumulado);
    }
    // Antes: 5 × 20.000 = 100.000. Agora: a janela uma vez + o piso das runs seguintes.
    expect(acumulado).toBe(28_000);
  });

  it("🔴 MONOTONIA: enquanto o PISO governa (spec jovem), a dívida das irmãs NÃO cobra", () => {
    // É o NORTE do Genesis: texto simples tem de virar spec completa. Cobrar de um projeto jovem o que
    // as runs de ontem escreveram o estrangularia — e a mudança deixaria de ser monótona.
    const run = { passes: 0, rounds: [] as never[] };
    expect(growthAllowance(run, 2_000, 500, 50_000)).toBe(2_000);  // piso 2.000 > proporcional 500
    expect(growthAllowance(run, 2_000, 0, 50_000)).toBe(2_000);    // spec sem massa medida (pré-103)
  });

  it("empate entre piso e proporcional resolve pelo piso — a dívida não entra", () => {
    // `proportional > floor` é estrito de propósito: no empate o caso ainda é o do piso.
    expect(growthAllowance({ passes: 0, rounds: [] as never[] }, 2_000, 2_000, 5_000)).toBe(2_000);
  });

  it("crédito de quem ENCOLHEU atravessa runs (mesma regra do GAP-33)", () => {
    // Uma run que consolidou de verdade devolve margem para a seguinte, e o efeito LÍQUIDO na janela
    // continua sendo os mesmos 2%: encolher 5.000 e depois crescer 25.000 é crescer 20.000.
    expect(growthAllowance({ passes: 0, rounds: [] as never[] }, 2_000, 20_000, -5_000)).toBe(25_000);
  });

  it("o gasto da PRÓPRIA run continua sendo cobrado por cima da dívida da janela", () => {
    const rounds = [R({ applied: true, deltaChars: 4_000 }), R({ applied: false, deltaChars: 9_999 })];
    expect(growthAllowance({ passes: 0, rounds } as never, 2_000, 20_000, 6_000)).toBe(10_000);
  });

  it("gasto da própria run pode SIM zerar a margem (regra do GAP-33, inalterada)", () => {
    // O piso protege contra a dívida das IRMÃS, não contra o que esta run já escreveu.
    const rounds = [R({ applied: true, deltaChars: 30_000 })];
    expect(growthAllowance({ passes: 0, rounds } as never, 2_000, 20_000, 0)).toBe(0);
  });
});

describe("projectGrowthUsedInWindow (GAP-69)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  beforeEach(() => warn.mockClear());

  it("soma o delta LÍQUIDO das rodadas aplicadas e exclui a run corrente", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: (sql: string, params: unknown[]) => { calls.push({ sql, params }); return Promise.resolve({ rows: [{ used: "19414" }] }); } } as never;
    expect(await projectGrowthUsedInWindow(db, "proj-1", "run-atual", 24)).toBe(19_414);
    expect(calls[0].sql).toContain("r.id <> $2");
    expect(calls[0].sql).toContain("(e->>'applied') = 'true'");   // rodada vetada não gastou disco
    expect(calls[0].params).toEqual(["proj-1", "run-atual", 24]);
  });

  it("projeto sem histórico devolve 0, não `NaN`", async () => {
    const db = { query: () => Promise.resolve({ rows: [{ used: null }] }) } as never;
    expect(await projectGrowthUsedInWindow(db, "p", "r", 24)).toBe(0);
  });

  it("janela 0 desliga a dívida SEM ir ao banco (kill-switch por env)", async () => {
    const db = { query: () => { throw new Error("não deveria consultar"); } } as never;
    expect(await projectGrowthUsedInWindow(db, "p", "r", 0)).toBe(0);
  });

  it("falha do banco degrada para 0 e DECLARA no log — degrade silencioso reabriria o GAP", async () => {
    const db = { query: () => Promise.reject(new Error("boom")) } as never;
    expect(await projectGrowthUsedInWindow(db, "p", "r", 24)).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("GAP-69");
  });

  it("resultado não-numérico do banco não vira `NaN` no orçamento", async () => {
    const db = { query: () => Promise.resolve({ rows: [{ used: "lixo" }] }) } as never;
    expect(await projectGrowthUsedInWindow(db, "p", "r", 24)).toBe(0);
  });
});
