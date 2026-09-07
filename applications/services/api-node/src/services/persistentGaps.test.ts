/**
 * 🔴 GAP-68 — o fato "este GAP já foi entregue antes e sobreviveu à edição" tem de chegar ao agente.
 *
 * O GAP-67 provou em prod (run `b1bc1195`) que 8 de 14 "fechados" eram o MESMO defeito rebatizado.
 * Medir isso não muda nada sozinho: o CTO segue recebendo o defeito como novidade, reescreve a seção,
 * a âncora muda outra vez e a spec engorda. Estes testes cobrem as três peças que fecham o circuito —
 * registrar a linhagem, reencontrá-la no despacho e dizê-la ao agente — e a armadilha mais provável
 * da correção: ficar INERTE porque o fingerprint não casou.
 */
import { describe, it, expect } from "vitest";
import { buildPersistentRefs, type PersistentGapRef } from "./gapContinuity.js";
import {
  lastPersistedGaps, persistentGapsFor, knownPersistentGaps,
  gapAnchorsOf, lastUntouchedAnchors, stableRecurrenceFor,
} from "./specAutonomy.js";
import { persistentGapFactBlock } from "../routes/specChat.js";
import { findingFingerprint } from "./findingTriage.js";
import type { ValidationFinding } from "./specValidation.js";

function f(over: Partial<ValidationFinding> & { title: string }): ValidationFinding {
  return {
    file: "modelo-dados.md", line: null, severity: "blocker", rationale: "", source: "stage_b",
    category: "consistency", anchor: null, ...over,
  };
}

/** O par REAL medido em prod: `§6.1` virou `§6` e o defeito do `actor_role` continuou. */
const CLOSED = f({ anchor: "§6.1", title: "Domínio de `audit_log.actor_role` fechado por constraint e aberto no mesmo DDL" });
const OPENED = f({ anchor: "§6", title: "O `CREATE TABLE audit_log` de §6 declara `actor_role VARCHAR(10)` sem CHECK" });

describe("buildPersistentRefs", () => {
  it("indexa pelo lado ATUAL — é o fingerprint que o próximo despacho vai enviar", () => {
    const [ref] = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "mesma contradição" }]);
    expect(ref.fingerprint).toBe(findingFingerprint(OPENED));
    expect(ref.fingerprint).not.toBe(findingFingerprint(CLOSED));
    expect(ref.anchor).toBe("§6");
    expect(ref.anchorBefore).toBe("§6.1");
    expect(ref.times).toBe(2);
  });

  it("acumula a LINHAGEM: o defeito que volta pela 3ª vez diz 3, não 2", () => {
    // Rodada anterior: o defeito estava em §6.1 (o fingerprint que hoje é o lado FECHADO).
    const prior: PersistentGapRef[] = [{
      fingerprint: findingFingerprint(CLOSED), file: "modelo-dados.md", anchor: "§6.1",
      anchorBefore: "§6.1.2", title: "t", why: "w", times: 2,
    }];
    const [ref] = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "de novo" }], prior);
    expect(ref.times).toBe(3);
  });

  it("linhagem de outro defeito não contamina a contagem", () => {
    const prior: PersistentGapRef[] = [{
      fingerprint: "fp-de-outro-defeito", file: "privacidade-lgpd.md", anchor: "§9",
      anchorBefore: null, title: "t", why: "w", times: 7,
    }];
    const [ref] = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "w" }], prior);
    expect(ref.times).toBe(2);
  });

  it("no teto, quem cai é o MENOS reincidente (o pedido forte sobrevive)", () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({
      closed: f({ anchor: `§a${i}`, title: `antes ${i}` }),
      opened: f({ anchor: `§b${i}`, title: `depois ${i}` }),
      why: "w",
    }));
    // O par 19 já tem linhagem longa; os outros nascem em 2.
    const prior: PersistentGapRef[] = [{
      fingerprint: findingFingerprint(pairs[19].closed), file: "modelo-dados.md",
      anchor: "§a19", anchorBefore: null, title: "t", why: "w", times: 5,
    }];
    const refs = buildPersistentRefs(pairs, prior);
    expect(refs).toHaveLength(12);
    expect(refs[0].times).toBe(6);
    expect(refs[0].fingerprint).toBe(findingFingerprint(pairs[19].opened));
  });
});

describe("lastPersistedGaps", () => {
  const REF: PersistentGapRef = {
    fingerprint: "fp1", file: "modelo-dados.md", anchor: "§6", anchorBefore: "§6.1",
    title: "t", why: "w", times: 2,
  };

  it("devolve as refs da medição mais recente", () => {
    const run = { rounds: [{ persistedGaps: [REF] }, { note: "rodada de arquivo" }] } as never;
    expect(lastPersistedGaps(run)).toEqual([REF]);
  });

  it("`gapsPersisted: 0` PARA a busca — reincidente fechado não pode ressuscitar", () => {
    // Passe antigo tinha reincidente; o passe seguinte reconciliou e não achou nenhum.
    const run = { rounds: [{ persistedGaps: [REF] }, { gapsPersisted: 0 }] } as never;
    expect(lastPersistedGaps(run)).toEqual([]);
  });

  it("rodada NÃO reconciliada (`gapsPersisted: null`) não apaga o que a anterior sabia", () => {
    const run = { rounds: [{ persistedGaps: [REF] }, { gapsPersisted: null }] } as never;
    expect(lastPersistedGaps(run)).toEqual([REF]);
  });

  it("run sem nenhuma medição devolve vazio, não `undefined`", () => {
    expect(lastPersistedGaps({ rounds: [] } as never)).toEqual([]);
  });
});

/**
 * 🔴 O defeito que a revisão adversarial da PRÓPRIA correção achou: as refs vivem no log da RUN, e uma
 * run nasce com `rounds: []`. A run `b1bc1195` morreu sabendo de 8 defeitos rebatizados e a seguinte
 * começaria CEGA — o primeiro passe de toda run repetiria o erro que a correção existe para evitar.
 */
describe("knownPersistentGaps (herança entre runs)", () => {
  const REF = (id: string, times = 2): PersistentGapRef => ({
    fingerprint: id, file: "modelo-dados.md", anchor: "§6", anchorBefore: "§6.1",
    title: `t-${id}`, why: "w", times,
  });
  const run = (over: Record<string, unknown>) =>
    ({ id: "run-atual", projectId: "proj-1", rounds: [], ...over }) as never;
  const dbWith = (rows: Array<{ rounds: unknown }>) => {
    const calls: unknown[][] = [];
    return {
      calls,
      db: { query: (sql: string, params: unknown[]) => { calls.push([sql, params]); return Promise.resolve({ rows }); } } as never,
    };
  };

  it("a medição da PRÓPRIA run vence a herança — nunca busca no banco", async () => {
    const { db, calls } = dbWith([{ rounds: [{ persistedGaps: [REF("herdado")] }] }]);
    const refs = await knownPersistentGaps(db, run({ rounds: [{ persistedGaps: [REF("proprio")] }] }));
    expect(refs.map((r) => r.fingerprint)).toEqual(["proprio"]);
    expect(calls).toHaveLength(0);
  });

  it("run que JÁ mediu e não achou reincidente não herda (o passado não ressuscita)", async () => {
    const { db, calls } = dbWith([{ rounds: [{ persistedGaps: [REF("herdado")] }] }]);
    expect(await knownPersistentGaps(db, run({ rounds: [{ gapsPersisted: 0 }] }))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("run NOVA (rounds vazio) herda as refs da run anterior do MESMO projeto", async () => {
    const { db, calls } = dbWith([{ rounds: [{ persistedGaps: [REF("herdado")] }] }]);
    const refs = await knownPersistentGaps(db, run({}));
    expect(refs.map((r) => r.fingerprint)).toEqual(["herdado"]);
    // A consulta tem de excluir a run corrente, senão ela herdaria de si mesma.
    expect(String(calls[0][0])).toContain("id <> $2");
    expect(calls[0][1]).toEqual(["proj-1", "run-atual"]);
  });

  it("run anterior sem reincidente não impede achar numa mais antiga", async () => {
    const { db } = dbWith([{ rounds: [{ note: "sem medição" }] }, { rounds: [{ persistedGaps: [REF("antiga")] }] }]);
    expect((await knownPersistentGaps(db, run({}))).map((r) => r.fingerprint)).toEqual(["antiga"]);
  });

  it("rodada que só CORREU sem reconciliar não conta como medição — ainda herda", async () => {
    const { db } = dbWith([{ rounds: [{ persistedGaps: [REF("herdado")] }] }]);
    const refs = await knownPersistentGaps(db, run({ rounds: [{ gapsPersisted: null }] }));
    expect(refs.map((r) => r.fingerprint)).toEqual(["herdado"]);
  });

  it("falha do banco degrada para vazio — nunca derruba o despacho do CTO", async () => {
    const db = { query: () => Promise.reject(new Error("relation does not exist")) } as never;
    await expect(knownPersistentGaps(db, run({}))).resolves.toEqual([]);
  });

  it("`rounds` corrompido no banco (não-array) não explode", async () => {
    const { db } = dbWith([{ rounds: "lixo" }, { rounds: null }]);
    await expect(knownPersistentGaps(db, run({}))).resolves.toEqual([]);
  });
});

/**
 * 🔴 GAP-71 — os três fatos que o LAÇO produz (o módulo `gapPersistence` só sabe calculá-los).
 *
 * O que se protege aqui é a cadeia: o despacho grava as âncoras que pediu → o apply mede quais
 * ficaram intocadas → o despacho seguinte lê essa medição DO ARQUIVO CERTO e a cruza com a
 * reincidência lida do banco. Qualquer elo frouxo faz a correção ficar inerte em silêncio, que é
 * exatamente como o GAP-68 passou 23 rodadas sem afirmar nada.
 */
describe("gapAnchorsOf", () => {
  it("guarda as âncoras do despacho, únicas e na ordem", () => {
    expect(gapAnchorsOf([{ anchor: "§8.6 (c)" }, { anchor: "§11.5" }, { anchor: "§8.6 (c)" }]))
      .toEqual(["§8.6 (c)", "§11.5"]);
  });

  it("finding SEM âncora não entra — não há trecho para medir", () => {
    expect(gapAnchorsOf([{ anchor: null }, { anchor: "  " }, {}])).toEqual([]);
  });
});

describe("lastUntouchedAnchors", () => {
  const run = (rounds: unknown[]) => ({ rounds }) as never;

  it("lê a última rodada DO MESMO arquivo, ignorando as de outros arquivos", () => {
    const r = run([
      { filePath: "modelo-dados.md", anchorsUntouched: ["§8.6 (c)"] },
      { filePath: "privacidade-lgpd.md", anchorsUntouched: ["§4.2"] },
    ]);
    expect(lastUntouchedAnchors(r, "modelo-dados.md")).toEqual(["§8.6 (c)"]);
  });

  it("a medição MAIS RECENTE do arquivo vence", () => {
    const r = run([
      { filePath: "modelo-dados.md", anchorsUntouched: ["§8.6 (c)"] },
      { filePath: "modelo-dados.md", anchorsUntouched: [] },
    ]);
    expect(lastUntouchedAnchors(r, "modelo-dados.md")).toEqual([]);
  });

  it("rodada sem medição (vetada, ou de criação) é pulada — não vira 'nada intocado'", () => {
    const r = run([
      { filePath: "modelo-dados.md", anchorsUntouched: ["§8.6 (c)"] },
      { filePath: "modelo-dados.md", applied: false, rejectedReason: "veto de crescimento" },
    ]);
    expect(lastUntouchedAnchors(r, "modelo-dados.md")).toEqual(["§8.6 (c)"]);
  });

  it("sem rodada do arquivo devolve vazio (1ª vez neste arquivo)", () => {
    expect(lastUntouchedAnchors(run([{ filePath: "outro.md", anchorsUntouched: ["x"] }]), "modelo-dados.md")).toEqual([]);
  });
});

describe("stableRecurrenceFor", () => {
  const run = { id: "run-1", projectId: "proj-1" } as never;
  const G = f({ anchor: "§8.6 (c)", title: "contradição de visibilidade" });
  const rowsWith = (n: number) => Array.from({ length: n }, () => ({
    findings: [G], stage_b_coverage: { full: ["modelo-dados.md"] },
  }));

  it("conta as validações competentes e devolve ref `stable`", async () => {
    const calls: unknown[][] = [];
    const db = { query: (sql: string, p: unknown[]) => { calls.push([sql, p]); return Promise.resolve({ rows: rowsWith(3) }); } } as never;
    const refs = await stableRecurrenceFor(db, run, "modelo-dados.md", [G]);
    expect(refs).toHaveLength(1);
    expect(refs[0].times).toBe(3);
    expect(refs[0].kind).toBe("stable");
    // Só validações CONCLUÍDAS entram: uma run em voo ainda não tem findings comparáveis.
    expect(String(calls[0][0])).toContain("status IN ('passed','failed')");
    expect(calls[0][1]).toEqual(["proj-1"]);
  });

  it("uma aparição só não é reincidência", async () => {
    const db = { query: () => Promise.resolve({ rows: rowsWith(1) }) } as never;
    expect(await stableRecurrenceFor(db, run, "modelo-dados.md", [G])).toEqual([]);
  });

  it("findings corrompidos no banco não explodem o despacho", async () => {
    const db = { query: () => Promise.resolve({ rows: [{ findings: "lixo", stage_b_coverage: null }] }) } as never;
    await expect(stableRecurrenceFor(db, run, "modelo-dados.md", [G])).resolves.toEqual([]);
  });

  it("falha do banco degrada para vazio — o fato é EXTRA, nunca pré-condição da rodada", async () => {
    const db = { query: () => Promise.reject(new Error("relation does not exist")) } as never;
    await expect(stableRecurrenceFor(db, run, "modelo-dados.md", [G])).resolves.toEqual([]);
  });
});

describe("persistentGapsFor", () => {
  const ref = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "w" }]);

  it("casa a ref com o finding que está indo ao CTO", () => {
    expect(persistentGapsFor(ref, "modelo-dados.md", [OPENED])).toHaveLength(1);
  });

  it("não afirma reincidência para GAP de outro arquivo", () => {
    const outro = f({ file: "privacidade-lgpd.md", anchor: "§6", title: "outro" });
    expect(persistentGapsFor(ref, "privacidade-lgpd.md", [outro])).toHaveLength(0);
  });

  it("caminho com caixa/espaço diferente ainda casa (o arquivo é o mesmo)", () => {
    expect(persistentGapsFor(ref, " Modelo-Dados.MD ", [OPENED])).toHaveLength(1);
  });

  it("🔴 INÉRCIA: se a âncora derivou DE NOVO, o fingerprint não casa e nada é afirmado", () => {
    // É o modo de falha esperado desta correção — e a razão de o despacho LOGAR a contagem.
    const derivou = f({ anchor: "§6.0", title: OPENED.title });
    expect(persistentGapsFor(ref, "modelo-dados.md", [derivou])).toHaveLength(0);
  });
});

describe("persistentGapFactBlock", () => {
  const ref = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "mesma contradição do CHECK" }]);

  it("sem reincidente não gasta uma linha de prompt", () => {
    expect(persistentGapFactBlock([])).toBe("");
    expect(persistentGapFactBlock(null)).toBe("");
    expect(persistentGapFactBlock(undefined)).toBe("");
  });

  it("ref com `times < 2` é descartada — 1ª aparição não é reincidência", () => {
    expect(persistentGapFactBlock([{ ...ref[0], times: 1 }])).toBe("");
  });

  it("mostra a DERIVA da âncora, que é a prova visível do rebatismo", () => {
    const b = persistentGapFactBlock(ref);
    expect(b).toContain("§6.1 → §6");
    expect(b).toContain("2ª aparição");
    expect(b).toContain("mesma contradição do CHECK");
  });

  it("declara a FONTE da afirmação — é juízo de agente, não medida de código", () => {
    expect(persistentGapFactBlock(ref)).toContain("um revisor compara");
  });

  it("pede REMOÇÃO na raiz, não reformulação — é o que ataca o crescimento (GAP-8)", () => {
    const b = persistentGapFactBlock(ref);
    expect(b).toContain("RENUMERAR, RENOMEAR OU REESCREVER A SEÇÃO NÃO FECHA");
    expect(b).toMatch(/APAGUE a outra/);
  });

  it("na 3ª aparição o aviso ESCALA (custo já pago duas vezes)", () => {
    const b = persistentGapFactBlock([{ ...ref[0], times: 3 }]);
    expect(b).toContain("3ª aparição");
    expect(b).toMatch(/ATENÇÃO/);
  });

  it("âncora ausente não vira `null` no texto entregue ao agente", () => {
    const b = persistentGapFactBlock([{ ...ref[0], anchor: null, anchorBefore: null }]);
    expect(b).not.toContain("null");
    expect(b).toContain("(sem âncora)");
  });

  // ── 🔴 GAP-71: a reincidência de âncora ESTÁVEL é outra afirmação ────────────────────────────
  //
  // Medido em prod (run `f101303f`): as 11 âncoras de `modelo-dados.md` voltaram nas 6 validações
  // seguidas SEM trocar de endereço, porque o CTO anulava o trecho por errata em vez de reescrevê-lo.
  // Dizer a ele "só mudou de endereço no documento" nesse caso é FALSO — e manda atacar o sintoma
  // errado. Estes testes travam a diferença entre as duas descrições.
  const stableRef: PersistentGapRef = {
    ...ref[0], kind: "stable", anchorBefore: "§6", anchor: "§6", why: "", times: 3,
  };

  it("`stable`: NÃO afirma deriva de âncora (ela não se moveu) e imprime uma âncora só", () => {
    const b = persistentGapFactBlock([stableRef]);
    expect(b).not.toContain("→");
    expect(b).not.toContain("só mudou de endereço");
    expect(b).not.toContain("um revisor compara");
    expect(b).toContain("MESMO endereço");
    expect(b).toContain("REESCREVER A SEÇÃO COM OUTRAS PALAVRAS NÃO FECHA");
    expect(b).toContain("3ª aparição");
  });

  it("leva MISTA descreve as duas origens sem confundi-las", () => {
    const b = persistentGapFactBlock([ref[0], stableRef]);
    expect(b).toContain("um revisor compara");
    expect(b).toContain("MESMO endereço");
    // Com rebatismo na leva, o diagnóstico da deriva volta a ser verdadeiro.
    expect(b).toContain("RENUMERAR, RENOMEAR OU REESCREVER A SEÇÃO NÃO FECHA");
    expect(b).toContain("§6.1 → §6");
  });

  it("`untouched`: marca o item E manda editar o próprio trecho, proibindo a errata", () => {
    const b = persistentGapFactBlock([{ ...stableRef, untouched: true }]);
    expect(b).toContain("a rodada anterior NÃO alterou este trecho");
    expect(b).toContain("EDITE O PRÓPRIO TRECHO");
    expect(b).toMatch(/errata/);
    expect(b).toContain("REMOVA a errata");
  });

  it("sem `untouched` o bloco NÃO acusa o agente de não ter mexido no trecho", () => {
    const b = persistentGapFactBlock([stableRef]);
    expect(b).not.toContain("NÃO alterou este trecho");
    expect(b).not.toContain("EDITE O PRÓPRIO TRECHO");
  });
});
