/**
 * 🔴 GAP-70 — com margem 0, a tolerância do GAP-64 também é 0, e o veto volta a ser o penhasco que o
 * GAP-64 veio matar.
 *
 * MEDIDO em prod (run `f101303f`, passe 1, rodada 10): o `README.md` recebeu pedido DUPLO — fechar 4
 * GAPs E remover 9 redeclarações de contrato. A revisão voltou **+692 chars** contra margem 0 e foi
 * descartada INTEIRA. O Opus estava pago, nada foi escrito, e o que se perdeu foi a REMOÇÃO — a única
 * coisa que ataca o crescimento da spec (GAP-8).
 *
 * A graça é um EMPRÉSTIMO, e estes testes cobrem os três limites que impedem que ela vire um segundo
 * orçamento: só com a citação do oráculo, pool por PASSE (não por rodada) e cobrada no `deltaChars`.
 */
import { describe, it, expect } from "vitest";
import { consolidationGraceLeft, runConsolidationGraceUsed } from "./specAutonomy.js";

function R(over: Record<string, unknown>) {
  return { round: 1, pass: 0, applied: true, ...over } as never;
}
const run = (rounds: unknown[], passes = 0) => ({ rounds, passes } as never);

describe("runConsolidationGraceUsed (GAP-70)", () => {
  it("soma só o que foi EMPRESTADO, não o excesso tolerado do GAP-64", () => {
    // `toleratedOverflow` é o excesso TOTAL; `consolidationGrace` é a parcela emprestada do pool. Se o
    // pool fosse consumido pelo total, um estouro sem consolidação nenhuma esgotaria a graça de quem
    // realmente removeu redeclaração.
    const rounds = [
      R({ toleratedOverflow: 900 }),
      R({ toleratedOverflow: 1_200, consolidationGrace: 400 }),
      R({ consolidationGrace: 300 }),
    ];
    expect(runConsolidationGraceUsed(run(rounds))).toBe(700);
  });

  it("log sem a chave, com `null` ou com lixo não vira `NaN`", () => {
    const rounds = [R({}), R({ consolidationGrace: null }), R({ consolidationGrace: "muito" }), R({ consolidationGrace: -50 })];
    expect(runConsolidationGraceUsed(run(rounds))).toBe(0);
  });

  it("`rounds` corrompido (não-array) devolve 0 em vez de explodir no despacho", () => {
    expect(runConsolidationGraceUsed({ rounds: null } as never)).toBe(0);
  });
});

describe("consolidationGraceLeft (GAP-70)", () => {
  it("run nova tem o pool de UM passe — a rodada 10 da `f101303f` teria cabido", () => {
    // O caso real: pool 2.000, estouro de 692.
    expect(consolidationGraceLeft(run([]), 2_000)).toBe(2_000);
    expect(consolidationGraceLeft(run([]), 2_000)).toBeGreaterThan(692);
  });

  it("🔴 o pool é por PASSE, não por rodada — 12 arquivos não ganham 12 graças", () => {
    // É o limite que impede a graça de virar um segundo orçamento pela porta dos fundos.
    const gasto = [R({ consolidationGrace: 1_500 })];
    expect(consolidationGraceLeft(run(gasto), 2_000)).toBe(500);
    const esgotado = [R({ consolidationGrace: 1_500 }), R({ consolidationGrace: 500 })];
    expect(consolidationGraceLeft(run(esgotado), 2_000)).toBe(0);
  });

  it("o pool acompanha os passes, como o piso do GAP-33", () => {
    expect(consolidationGraceLeft(run([], 3), 2_000)).toBe(8_000);
    expect(consolidationGraceLeft(run([R({ consolidationGrace: 6_000 })], 3), 2_000)).toBe(2_000);
  });

  it("run que já tomou MAIS que o pool tem graça 0, nunca dívida negativa", () => {
    // Acontece se o pool for reduzido por env no meio da run: a graça acaba, mas uma graça negativa
    // proibiria até o encolhimento (mesma armadilha que o GAP-28 documentou na margem).
    expect(consolidationGraceLeft(run([R({ consolidationGrace: 9_999 })]), 2_000)).toBe(0);
  });

  it("pool 0 é KILL-SWITCH: volta exatamente ao comportamento do GAP-64", () => {
    expect(consolidationGraceLeft(run([]), 0)).toBe(0);
    expect(consolidationGraceLeft(run([], 4), 0)).toBe(0);
    expect(consolidationGraceLeft(run([]), Number.NaN)).toBe(0);
    expect(consolidationGraceLeft(run([]), -100)).toBe(0);
  });

  it("MONOTONIA: a graça só AUMENTA o limite — nenhuma rodada que passava antes passa a ser vetada", () => {
    // A graça entra como `budget + tolerance + grace`, e `grace >= 0` sempre. Este teste trava a
    // propriedade no nível da conta, que é onde uma regressão futura entraria.
    for (const passes of [0, 2, 4]) {
      for (const usado of [0, 500, 5_000, 99_999]) {
        const g = consolidationGraceLeft(run([R({ consolidationGrace: usado })], passes), 2_000);
        expect(g).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
