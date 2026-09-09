/**
 * Testes do F4 (recall do juiz por injeção de defeito). Cada um guarda um jeito medido de o número
 * sair errado — e todos os oito achados da revisão adversarial cross-family que viraram desenho:
 *
 *  * GAP-90/91/92/94 — o agregado esconde por ONDE o recall foi obtido (posição, vocabulário, escopo,
 *    dificuldade), e gold set faltando uma dessas faixas é LIMITAÇÃO declarada, não silêncio;
 *  * GAP-93 — o casador também erra: citação não conferida nunca conta como achado, e mesma família
 *    entre casador e juiz é declarada;
 *  * GAP-95 — a versão do gold set inclui a AMOSTRA: recall de amostras diferentes não é comparável;
 *  * GAP-97 — defeito que não chegou ao juiz sai do DENOMINADOR (é cobertura, não cegueira);
 *  * GAP-49 (nosso, refutando os revisores) — classe divergente NÃO impede o casamento.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  abNote, applyInjections, AUDIT_MIN_SAMPLE, goldSetVersion, modelFamily, normalizeMatches,
  pairedComparison, parseInjections, recallConfig, recallLimitations, RECALL_MIN_ELIGIBLE, recallNote,
  recallTally, sameFamily, wilson95,
  type GoldDefect,
} from "./specJudgeRecall.js";
import type { ValidationFinding } from "./specValidation.js";

const ARQUIVO_A = "01-visao.md\n\n## Escopo\nO sistema processa até 500 pedidos por minuto.\n\n## Metas\nDisponibilidade de 99,9%.\n";
const ARQUIVO_B = "02-nfr.md\n\n## Capacidade\nO sistema processa até 500 pedidos por minuto.\n";

function files() {
  return [
    { path: "01-visao.md", content: ARQUIVO_A },
    { path: "02-nfr.md", content: ARQUIVO_B },
  ];
}

function defect(over: Partial<GoldDefect> = {}): GoldDefect {
  return {
    id: "D01", file: "01-visao.md", anchor: "## Escopo", position: "secao_nomeada",
    defectClass: "ambiguous_fr", inVocabulary: true, difficulty: "obvia", scope: "local",
    description: "o teto de vazão ficou ambíguo",
    original: "O sistema processa até 500 pedidos por minuto.",
    mutated: "O sistema processa pedidos rapidamente.",
    file2: null, original2: null, mutated2: null, ...over,
  };
}

function finding(over: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    file: "01-visao.md", line: null, severity: "blocker", title: "Vazão sem número",
    rationale: "A seção Escopo diz apenas que processa pedidos rapidamente, sem teto medido.",
    source: "stage_b", category: "missing_nfr", anchor: "## Escopo", ...over,
  };
}

describe("parseInjections — mutação que não é verbatim é RECUSADA (senão mediríamos uma reescrita)", () => {
  it("recusa trecho original que não existe literalmente no arquivo", () => {
    const r = parseInjections([{
      file: "01-visao.md", anchor: "## Escopo", original: "O sistema processa até 500 pedidos/min.",
      mutated: "algo", description: "x",
    }], files());
    expect(r.defects).toHaveLength(0);
    expect(r.rejected[0]?.reason).toContain("verbatim");
  });

  it("recusa mutação idêntica ao original — nada foi injetado", () => {
    const t = "O sistema processa até 500 pedidos por minuto.";
    const r = parseInjections([{ file: "01-visao.md", anchor: "## Escopo", original: t, mutated: t }], files());
    expect(r.defects).toHaveLength(0);
    expect(r.rejected[0]?.reason).toContain("idêntico");
  });

  it("recusa arquivo que não é da spec — premissa fabricada não vira gold set", () => {
    const r = parseInjections([{ file: "99-inventado.md", anchor: "x", original: "a", mutated: "b" }], files());
    expect(r.rejected[0]?.reason).toContain("não é arquivo real");
  });

  it("recusa segunda injeção na MESMA âncora — dois defeitos no mesmo lugar se contaminam", () => {
    const base = {
      file: "01-visao.md", anchor: "## Escopo", original: "Disponibilidade de 99,9%.",
      mutated: "Disponibilidade alta.", description: "x",
    };
    const r = parseInjections([
      { ...base, original: "O sistema processa até 500 pedidos por minuto.", mutated: "processa pedidos." },
      base,
    ], files());
    expect(r.defects).toHaveLength(1);
    expect(r.rejected[0]?.reason).toContain("mesma âncora");
  });

  it("GAP-92: escopo distribuído sem o segundo par é recusado", () => {
    const r = parseInjections([{
      file: "01-visao.md", anchor: "## Escopo", scope: "distribuido",
      original: "O sistema processa até 500 pedidos por minuto.", mutated: "processa até 900 por minuto.",
    }], files());
    expect(r.defects).toHaveLength(0);
    expect(r.rejected[0]?.reason).toContain("segundo par");
  });

  it("GAP-92: distribuído com os dois trechos verbatim é aceito", () => {
    const r = parseInjections([{
      file: "01-visao.md", anchor: "## Escopo", scope: "distribuido",
      original: "O sistema processa até 500 pedidos por minuto.", mutated: "processa até 900 por minuto.",
      file2: "02-nfr.md", original2: "O sistema processa até 500 pedidos por minuto.",
      mutated2: "O sistema processa até 500 pedidos por minuto (teto rígido).",
    }], files());
    expect(r.defects).toHaveLength(1);
    expect(r.defects[0]?.scope).toBe("distribuido");
  });

  it("GAP-91: declarar `in_vocabulary` para classe que não existe na lista não passa", () => {
    const r = parseInjections([{
      file: "01-visao.md", anchor: "## Escopo", class: "classe_que_nao_existe", in_vocabulary: true,
      original: "O sistema processa até 500 pedidos por minuto.", mutated: "processa pedidos.",
    }], files());
    expect(r.defects[0]?.inVocabulary).toBe(false);
  });
});

describe("applyInjections — nada fora do trecho declarado muda, e nada toca o disco", () => {
  it("muta só o trecho e deixa o resto do arquivo byte-a-byte igual", () => {
    const original = files();
    const r = applyInjections(original, [defect()]);
    const mutado = r.files.find((f) => f.path === "01-visao.md")!.content;
    expect(mutado).toContain("O sistema processa pedidos rapidamente.");
    expect(mutado).toContain("## Metas\nDisponibilidade de 99,9%.");
    expect(mutado).not.toBe(ARQUIVO_A);
    // O corpus de entrada segue intacto: quem chamou continua com a spec do projeto na mão.
    expect(original[0]?.content).toBe(ARQUIVO_A);
    expect(r.files.find((f) => f.path === "02-nfr.md")?.content).toBe(ARQUIVO_B);
  });

  it("GAP-92: distribuído entra INTEIRO ou não entra — metade seria outro defeito", () => {
    const d = defect({
      scope: "distribuido", file2: "02-nfr.md",
      original2: "trecho que não existe em nenhum arquivo", mutated2: "x",
    });
    const r = applyInjections(files(), [d]);
    expect(r.applied).toHaveLength(0);
    expect(r.files.find((f) => f.path === "01-visao.md")?.content).toBe(ARQUIVO_A);
    expect(r.rejected[0]?.reason).toContain("não encontrado");
  });

  it("recusa o defeito cujo trecho uma mutação anterior consumiu", () => {
    const d1 = defect();
    const d2 = defect({ id: "D02", anchor: "## Escopo (2)" });
    const r = applyInjections(files(), [d1, d2]);
    expect(r.applied.map((d) => d.id)).toEqual(["D01"]);
    expect(r.rejected[0]?.reason).toContain("consumiu");
  });
});

describe("goldSetVersion — GAP-95: recall de amostras diferentes não é comparável", () => {
  it("muda quando a AMOSTRA muda, mesmo com os mesmos defeitos", () => {
    const a = goldSetVersion(files(), [defect()]);
    const b = goldSetVersion([files()[0]!], [defect()]);
    expect(a).not.toBe(b);
  });

  it("não muda com a ordem de arquivos nem de defeitos", () => {
    const d = [defect(), defect({ id: "D02", anchor: "## Metas", original: "Disponibilidade de 99,9%.", mutated: "Alta disponibilidade." })];
    expect(goldSetVersion(files(), d)).toBe(goldSetVersion([...files()].reverse(), [...d].reverse()));
  });

  it("muda quando o trecho MUTADO muda — outro defeito é outro gold set", () => {
    const a = goldSetVersion(files(), [defect()]);
    const b = goldSetVersion(files(), [defect({ mutated: "O sistema processa até 900 pedidos por minuto." })]);
    expect(a).not.toBe(b);
  });
});

describe("normalizeMatches — GAP-93: o erro do casador é empurrado para BAIXO, nunca para cima", () => {
  const f = [finding()];
  const cobertos = ["01-visao.md", "02-nfr.md"];

  it("`encontrado` com citação verbatim conta como achado", () => {
    const items = normalizeMatches([{
      defect_id: "D01", verdict: "encontrado", finding_ref: "Vazão sem número",
      citation: "sem teto medido", class_agreed: false,
    }], [defect()], f, cobertos);
    expect(items[0]?.verdict).toBe("encontrado");
    expect(items[0]?.citationVerbatim).toBe(true);
  });

  it("`encontrado` com citação que NÃO está nos findings vira indecidível — não achado", () => {
    const items = normalizeMatches([{
      defect_id: "D01", verdict: "encontrado", citation: "o juiz disse que a vazão está errada",
    }], [defect()], f, cobertos);
    expect(items[0]?.verdict).toBe("indecidivel");
    expect(items[0]?.reason).toBe("citacao_nao_confere");
  });

  it("casador silencioso sobre um defeito vira indecidível declarado, nunca achado", () => {
    const items = normalizeMatches([], [defect()], f, cobertos);
    expect(items[0]?.verdict).toBe("indecidivel");
    expect(items[0]?.reason).toBe("sem_parecer");
  });

  it("`nao_encontrado` é veredicto legítimo e fica como está", () => {
    const items = normalizeMatches([{ defect_id: "D01", verdict: "nao_encontrado", reason: "nenhum finding cita a seção" }],
      [defect()], f, cobertos);
    expect(items[0]?.verdict).toBe("nao_encontrado");
  });

  it("GAP-49 (refuta os revisores): classe divergente NÃO impede o casamento", () => {
    const items = normalizeMatches([{
      defect_id: "D01", verdict: "encontrado", citation: "sem teto medido", class_agreed: false,
    }], [defect({ defectClass: "missing_nfr" })], f, cobertos);
    expect(items[0]?.verdict).toBe("encontrado");
    expect(items[0]?.classAgreed).toBe(false);
  });

  it("um finding não pode ser o achado de dois defeitos", () => {
    const items = normalizeMatches([
      { defect_id: "D01", verdict: "encontrado", finding_ref: "Vazão sem número", citation: "sem teto medido" },
      { defect_id: "D02", verdict: "encontrado", finding_ref: "Vazão sem número", citation: "sem teto medido" },
    ], [defect(), defect({ id: "D02", anchor: "## Metas" })], f, cobertos);
    expect(items[0]?.verdict).toBe("encontrado");
    expect(items[1]?.verdict).toBe("nao_encontrado");
    expect(items[1]?.reason).toContain("já casado");
  });

  it("GAP-97: defeito cujo arquivo não chegou ao juiz fica FORA do denominador", () => {
    const items = normalizeMatches([{ defect_id: "D01", verdict: "nao_encontrado" }], [defect()], f, ["02-nfr.md"]);
    expect(items[0]?.covered).toBe(false);
    const t = recallTally(items);
    expect(t.eligible).toBe(0);
    expect(t.uncovered).toBe(1);
    expect(t.recallMin).toBe(0);
  });

  it("GAP-92 + GAP-97: distribuído só é elegível se OS DOIS arquivos chegaram ao juiz", () => {
    const d = defect({ scope: "distribuido", file2: "02-nfr.md", original2: "x", mutated2: "y" });
    const items = normalizeMatches([{ defect_id: "D01", verdict: "nao_encontrado" }], [d], f, ["01-visao.md"]);
    expect(items[0]?.covered).toBe(false);
  });
});

describe("recallTally — a banda, e o agregado que esconde por onde o recall foi obtido", () => {
  function item(over: Record<string, unknown> = {}) {
    return {
      defectId: "D", file: "01-visao.md", anchor: "a", defectClass: "ambiguous_fr", inVocabulary: true,
      difficulty: "obvia" as const, position: "secao_nomeada" as const, scope: "local" as const,
      covered: true, verdict: "encontrado" as const, findingRef: "", citation: "", citationVerbatim: true,
      classAgreed: true, reason: "", ...over,
    };
  }

  it("publica PISO e TETO — o duvidoso conta no teto, nunca no piso", () => {
    const t = recallTally([
      item({ verdict: "encontrado" }), item({ verdict: "nao_encontrado" }),
      item({ verdict: "parcial" }), item({ verdict: "indecidivel" }),
    ]);
    expect(t.eligible).toBe(4);
    expect(t.recallMin).toBeCloseTo(0.25);
    expect(t.recallMax).toBeCloseTo(0.75);
  });

  it("GAP-90: 100% em seção nomeada e 0% em corpo sem título dá agregado de 50% — e a faixa denuncia", () => {
    const t = recallTally([
      item({ position: "secao_nomeada", verdict: "encontrado" }),
      item({ position: "corpo_sem_titulo", verdict: "nao_encontrado" }),
    ]);
    expect(t.recallMin).toBeCloseTo(0.5);
    expect(t.byPosition.secao_nomeada?.recallMin).toBe(1);
    expect(t.byPosition.corpo_sem_titulo?.recallMin).toBe(0);
    expect(recallNote(t)).toContain("corpo_sem_titulo 0%");
  });

  it("GAP-91: recall dentro e fora do vocabulário são números separados", () => {
    const t = recallTally([
      item({ inVocabulary: true, verdict: "encontrado" }),
      item({ inVocabulary: false, verdict: "nao_encontrado" }),
    ]);
    expect(t.byVocabulary.no_vocabulario?.recallMin).toBe(1);
    expect(t.byVocabulary.fora_do_vocabulario?.recallMin).toBe(0);
  });

  it("defeito fora de cobertura não entra na faixa como perda do juiz", () => {
    const t = recallTally([item({ verdict: "encontrado" }), item({ covered: false, verdict: "nao_encontrado" })]);
    expect(t.eligible).toBe(1);
    expect(t.recallMin).toBe(1);
    expect(t.uncovered).toBe(1);
  });
});

describe("recallNote / recallLimitations — nenhum limite fica escondido", () => {
  function base(over: Record<string, unknown> = {}) {
    return {
      defectId: "D", file: "f", anchor: "a", defectClass: "ambiguous_fr", inVocabulary: true,
      difficulty: "obvia" as const, position: "secao_nomeada" as const, scope: "local" as const,
      covered: true, verdict: "encontrado" as const, findingRef: "", citation: "", citationVerbatim: true,
      classAgreed: true, reason: "", ...over,
    };
  }

  it("zero defeito elegível NÃO é recall zero — é falha de cobertura, e a nota diz isso", () => {
    const t = recallTally([base({ covered: false, verdict: "nao_encontrado" })]);
    const nota = recallNote(t);
    expect(nota).toContain("falha de cobertura");
    expect(nota).not.toContain("recall do juiz entre");
  });

  it("declara gold set sem `sutil`, sem distribuído, sem corpo sem título e fora do vocabulário", () => {
    const t = recallTally([base()]);
    const lim = recallLimitations({
      tally: t, sameFamily: false, judgeModel: "us.anthropic.claude-opus-4-8",
      matchModel: "amazon.nova-pro-v1:0", matcherDisagreement: null, auditSample: 0, rejected: 0,
    });
    expect(lim.join(" | ")).toContain("GAP-90");
    expect(lim.join(" | ")).toContain("GAP-91");
    expect(lim.join(" | ")).toContain("GAP-92");
    expect(lim.join(" | ")).toContain("GAP-94");
    expect(lim.join(" | ")).toContain("memória");
  });

  it("GAP-93: casador da MESMA família do juiz é limitação declarada, não bloqueio", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: true, judgeModel: "us.anthropic.claude-opus-4-8",
      matchModel: "us.anthropic.claude-sonnet-4-6", matcherDisagreement: 0.2, auditSample: 3, rejected: 0,
    });
    expect(lim.join(" | ")).toContain("MESMA família");
    expect(lim.join(" | ")).toContain("20% de discordância");
  });

  it("GAP-93: juiz de modelo desconhecido NÃO vira garantia de cross-family", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "", matchModel: "amazon.nova-pro-v1:0",
      matcherDisagreement: 0.1, auditSample: 2, rejected: 0,
    });
    expect(lim.join(" | ")).toContain("NÃO se pode afirmar que é de outra família");
    expect(lim.join(" | ")).not.toContain("MESMA família");
  });

  it("GAP-99: gold set inteiro em `corpo_sem_titulo` declara que o número é PISO do lado difícil", () => {
    // Medido em prod: os 7 defeitos caíram todos no corpo sem título e a checagem, de um lado só,
    // não declarou nada — 14% foi publicado como se descrevesse o juiz em qualquer posição.
    const t = recallTally([base({ position: "corpo_sem_titulo", verdict: "nao_encontrado" })]);
    const lim = recallLimitations({
      tally: t, sameFamily: false, judgeModel: "us.anthropic.claude-opus-5",
      matchModel: "amazon.nova-pro-v1:0", matcherDisagreement: null, auditSample: 0, rejected: 0,
    }).join(" | ");
    expect(lim).toContain("sem defeito em `secao_nomeada`");
    expect(lim).toContain("GAP-99");
    expect(lim).not.toContain("GAP-90");
  });

  it("GAP-99: faixa de escopo e de dificuldade também declaram o lado que falta", () => {
    const lim = recallLimitations({
      tally: recallTally([base({ scope: "distribuido", difficulty: "sutil", inVocabulary: false })]),
      sameFamily: false, judgeModel: "j", matchModel: "m", matcherDisagreement: null,
      auditSample: 0, rejected: 0,
    }).join(" | ");
    expect(lim).toContain("só com defeito distribuído");
    expect(lim).toContain("só com defeito `sutil`");
    expect(lim).toContain("inteiro FORA do vocabulário");
  });

  it("GAP-100: discordância sobre amostra abaixo do piso é INDICAÇÃO, não estimativa", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "j",
      matchModel: "amazon.nova-pro-v1:0", matcherDisagreement: 0.5, auditSample: 2, rejected: 0,
    }).join(" | ");
    expect(lim).toContain("50% de discordância");
    expect(lim).toContain("ABAIXO do piso");
    expect(lim).toContain("GAP-100");
  });

  it("GAP-100: amostra no piso é estimativa e não ganha a ressalva", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "j",
      matchModel: "amazon.nova-pro-v1:0", matcherDisagreement: 0.5, auditSample: AUDIT_MIN_SAMPLE,
      rejected: 0,
    }).join(" | ");
    expect(lim).not.toContain("ABAIXO do piso");
  });

  it("GAP-98: terceiro casador da MESMA família do casador é declarado", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "us.anthropic.claude-opus-5",
      matchModel: "amazon.nova-pro-v1:0", auditModel: "amazon.nova-lite-v1:0",
      matcherDisagreement: 0.1, auditSample: 3, rejected: 0,
    }).join(" | ");
    expect(lim).toContain("MESMA família do casador");
  });

  it("GAP-98: auditor de outra família não gera a ressalva do auditor", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "us.anthropic.claude-opus-5",
      matchModel: "amazon.nova-pro-v1:0", auditModel: "mistral.mistral-large-3-675b-instruct",
      matcherDisagreement: 0.1, auditSample: 3, rejected: 0,
    }).join(" | ");
    expect(lim).not.toContain("MESMA família do casador");
  });

  it("GAP-101: discordância que é SÓ silêncio é declarada como silêncio, não como desacordo", () => {
    // Medido em prod na 2ª prova: "100% de discordância sobre 3" sem dizer de que tipo. Silêncio do
    // terceiro casador e opinião contrária têm significados opostos; somados, o número não é legível.
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "us.anthropic.claude-opus-5",
      matchModel: "amazon.nova-pro-v1:0", auditModel: "mistral.mistral-large-3-675b-instruct",
      matcherDisagreement: 1, matcherNoOpinion: 1, auditSample: 3, rejected: 0,
    }).join(" | ");
    expect(lim).toContain("NÃO OPINANDO");
    expect(lim).toContain("GAP-101");
  });

  it("GAP-101: silêncio PARCIAL diz que a incerteza sobe, e o recall não", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "j",
      matchModel: "amazon.nova-pro-v1:0", matcherDisagreement: 0.6, matcherNoOpinion: 0.2,
      auditSample: 5, rejected: 0,
    }).join(" | ");
    expect(lim).toContain("20% da amostra ficou sem parecer");
    expect(lim).toContain("nunca o recall");
  });

  it("GAP-101: sem silêncio nenhum, a ressalva não aparece (não inventa ruído)", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "j",
      matchModel: "amazon.nova-pro-v1:0", matcherDisagreement: 0.4, matcherNoOpinion: 0,
      auditSample: 5, rejected: 0,
    }).join(" | ");
    expect(lim).not.toContain("GAP-101");
  });

  it("GAP-102: defeito que perdeu o finding para outro por ORDEM da lista é contado e declarado", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "j", matchModel: "m",
      matcherDisagreement: null, auditSample: 0, rejected: 0, priorClaim: 1,
    }).join(" | ");
    expect(lim).toContain("1 defeito(s) recusado(s) porque outro reivindicou o MESMO finding antes");
    expect(lim).toContain("GAP-102");
  });

  it("GAP-102: sem disputa de finding, nada é declarado", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "j", matchModel: "m",
      matcherDisagreement: null, auditSample: 0, rejected: 0, priorClaim: 0,
    }).join(" | ");
    expect(lim).not.toContain("GAP-102");
  });

  it("GAP-104: 'terceiro casador respondeu lixo' não pode virar a frase de 'auditoria desligada'", () => {
    // Medido na prova 4 em prod: o Mistral FOI chamado, respondeu, e o que voltou não era JSON legível.
    // A limitação dizia só "nenhuma amostra recasada", indistinguível de auditoria desligada.
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "j", matchModel: "m",
      matcherDisagreement: null, auditSample: 0, rejected: 0,
      matcherWhy: "terceiro casador (mistral.mistral-large-3-675b-instruct) respondeu, mas sem JSON legível — foi CHAMADO, não estava desligado",
    }).join(" | ");
    expect(lim).toContain("sem JSON legível");
    expect(lim).toContain("foi CHAMADO");
    expect(lim).toContain("GAP-104");
  });

  it("GAP-104: sem motivo conhecido, a frase antiga fica inteira e sem invenção", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "j", matchModel: "m",
      matcherDisagreement: null, auditSample: 0, rejected: 0,
    }).join(" | ");
    expect(lim).toContain("sem estimativa (GAP-93)");
    expect(lim).not.toContain("GAP-104");
  });

  it("sem amostra recasada, a nota diz que o erro do casador entra SEM estimativa", () => {
    const lim = recallLimitations({
      tally: recallTally([base()]), sameFamily: false, judgeModel: "j", matchModel: "m",
      matcherDisagreement: null, auditSample: 0, rejected: 2,
    });
    expect(lim.join(" | ")).toContain("sem estimativa");
    expect(lim.join(" | ")).toContain("2 injeção(ões) recusada(s)");
  });
});

describe("wilson95 / GAP-103 — a banda do casamento não sabe que `n` é 7", () => {
  it("nunca devolve limite impossível, mesmo com proporção em 0 ou em 1", () => {
    const zero = wilson95(0, 7);
    expect(zero.low).toBe(0);
    expect(zero.high).toBeGreaterThan(0);
    const cheio = wilson95(7, 7);
    expect(cheio.high).toBe(1);
    expect(cheio.low).toBeLessThan(1);
  });

  it("aperta quando `n` cresce com a MESMA proporção — é isso que a declaração compra", () => {
    const pequeno = wilson95(1, 7);
    const grande = wilson95(20, 140);
    expect(grande.high - grande.low).toBeLessThan(pequeno.high - pequeno.low);
  });

  it("amostra vazia não vira intervalo inventado", () => {
    expect(wilson95(0, 0)).toEqual({ low: 0, high: 0 });
  });

  it("GAP-103: amostra pequena declara que comparar rodadas compara AMOSTRAS", () => {
    // Medido em prod: três medições sobre a MESMA spec e o MESMO juiz deram 14%..29% (casador quebrado),
    // 43%..57% e 14%..43%. Com n = 7, um acerto a mais move o piso 14 pontos.
    const t = recallTally(Array.from({ length: 7 }, (_, k) => ({
      defectId: `D${k}`, file: "f", anchor: "a", defectClass: "ambiguous_fr", inVocabulary: true,
      difficulty: "sutil" as const, position: "corpo_sem_titulo" as const, scope: "local" as const,
      covered: true, verdict: (k === 0 ? "encontrado" : "nao_encontrado") as "encontrado" | "nao_encontrado",
      findingRef: "", citation: "", citationVerbatim: true, classAgreed: true, reason: "",
    })));
    expect(t.eligible).toBe(7);
    expect(t.recallMin).toBeCloseTo(1 / 7);
    // O IC95 é MAIS LARGO que a banda do casamento (aqui a banda é degenerada: min = max).
    expect(t.ciHigh - t.ciLow).toBeGreaterThan(t.recallMax - t.recallMin);
    const lim = recallLimitations({
      tally: t, sameFamily: false, judgeModel: "j", matchModel: "amazon.nova-pro-v1:0",
      matcherDisagreement: null, auditSample: 0, rejected: 0,
    }).join(" | ");
    expect(lim).toContain("GAP-103");
    expect(lim).toContain("MAIS LARGO");
    expect(recallNote(t)).toContain("IC95 do piso");
  });

  it("GAP-103: amostra no piso de declaração não ganha a ressalva", () => {
    const t = recallTally(Array.from({ length: RECALL_MIN_ELIGIBLE }, (_, k) => ({
      defectId: `D${k}`, file: "f", anchor: "a", defectClass: "ambiguous_fr", inVocabulary: true,
      difficulty: "sutil" as const, position: "corpo_sem_titulo" as const, scope: "local" as const,
      covered: true, verdict: "encontrado" as const, findingRef: "", citation: "",
      citationVerbatim: true, classAgreed: true, reason: "",
    })));
    const lim = recallLimitations({
      tally: t, sameFamily: false, judgeModel: "j", matchModel: "amazon.nova-pro-v1:0",
      matcherDisagreement: null, auditSample: 0, rejected: 0,
    }).join(" | ");
    expect(lim).not.toContain("GAP-103");
  });
});

describe("sameFamily — GAP-93: casador e juiz da mesma família são a mesma opinião duas vezes", () => {
  it("ignora o prefixo de região do Bedrock", () => {
    expect(modelFamily("us.anthropic.claude-opus-4-8")).toBe("anthropic");
    expect(sameFamily("us.anthropic.claude-opus-4-8", "us.anthropic.claude-sonnet-4-6")).toBe(true);
  });

  it("Claude contra Nova/Mistral é família diferente", () => {
    expect(sameFamily("us.anthropic.claude-opus-4-8", "amazon.nova-pro-v1:0")).toBe(false);
    expect(sameFamily("us.anthropic.claude-opus-4-8", "mistral.mistral-large-3-675b-instruct")).toBe(false);
  });

  it("modelo desconhecido nunca é declarado como mesma família (não inventa garantia)", () => {
    expect(sameFamily("", "")).toBe(false);
  });
});

describe("GAP-144 — A/B do raciocínio: pareado, e recusando concluir quando a amostra não permite", () => {
  const it0 = (defectId: string, verdict: "encontrado" | "parcial" | "nao_encontrado" | "indecidivel",
               covered = true) => ({
    defectId, file: "01-visao.md", anchor: "## Escopo", defectClass: "ambiguous_fr",
    inVocabulary: true, difficulty: "sutil" as const, position: "secao_nomeada" as const,
    scope: "local" as const, covered, verdict, findingRef: "", citation: "",
    citationVerbatim: verdict === "encontrado", classAgreed: true, reason: "",
  });

  it("classifica cada defeito como ambos / nenhum / só um dos braços", () => {
    const p = pairedComparison(
      [it0("D1", "encontrado"), it0("D2", "nao_encontrado"), it0("D3", "encontrado"), it0("D4", "nao_encontrado")],
      [it0("D1", "encontrado"), it0("D2", "encontrado"), it0("D3", "nao_encontrado"), it0("D4", "nao_encontrado")],
    );
    expect(p).toMatchObject({
      eligible: 4, both: 1, neither: 1, only_baseline: 1, only_thinking: 1, discordant: 2, unpaired: 0,
    });
  });

  it("`parcial` e `indecidivel` não contam para nenhum lado (mesmo critério do piso)", () => {
    const p = pairedComparison(
      [it0("D1", "parcial"), it0("D2", "indecidivel")],
      [it0("D1", "encontrado"), it0("D2", "parcial")],
    );
    expect(p).toMatchObject({ eligible: 2, both: 0, neither: 1, only_baseline: 0, only_thinking: 1 });
  });

  it("GAP-97 nos dois lados: defeito sem cobertura em UM braço sai do pareamento, não vira derrota", () => {
    const p = pairedComparison(
      [it0("D1", "encontrado"), it0("D2", "nao_encontrado", false)],
      [it0("D1", "encontrado"), it0("D2", "encontrado")],
    );
    expect(p).toMatchObject({ eligible: 1, both: 1, only_thinking: 0, unpaired: 1 });
  });

  it("defeito que só existe em um dos braços é cobertura instável, nunca par", () => {
    const p = pairedComparison([it0("D1", "encontrado")], [it0("D1", "encontrado"), it0("D9", "encontrado")]);
    expect(p).toMatchObject({ eligible: 1, both: 1, unpaired: 1 });
  });

  it("com menos de 2 discordantes a prosa RECUSA decidir (não autoriza virar o padrão)", () => {
    const nota = abNote({ eligible: 8, both: 3, neither: 4, only_baseline: 0, only_thinking: 1, discordant: 1, unpaired: 0 }, 0.375, 0.5);
    expect(nota).toContain("NÃO decide nada");
    expect(nota).not.toContain("vantagem aparente");
  });

  it("com discordância legível a prosa dá INDICAÇÃO com o lado, nunca veredicto", () => {
    const nota = abNote({ eligible: 10, both: 2, neither: 4, only_baseline: 1, only_thinking: 3, discordant: 4, unpaired: 0 }, 0.3, 0.5);
    expect(nota).toContain("vantagem aparente: com raciocínio");
    expect(nota).toContain("INDICAÇÃO, não veredicto");
    expect(nota).toContain(`RECALL_MIN_ELIGIBLE = ${RECALL_MIN_ELIGIBLE}`);
  });

  it("A/B vem DESLIGADO por padrão — medir dois braços dobra o custo do estágio B", () => {
    const antes = process.env.SPEC_JUDGE_RECALL_THINKING_AB;
    delete process.env.SPEC_JUDGE_RECALL_THINKING_AB;
    expect(recallConfig().thinkingAb).toBe(false);
    process.env.SPEC_JUDGE_RECALL_THINKING_AB = "on";
    expect(recallConfig().thinkingAb).toBe(true);
    if (antes === undefined) delete process.env.SPEC_JUDGE_RECALL_THINKING_AB;
    else process.env.SPEC_JUDGE_RECALL_THINKING_AB = antes;
  });
});

describe("GAP-149 — o instrumento ganha CHAMADOR (e não mede duas vezes a mesma spec)", () => {
  type Q = { sql: string; params: unknown[] };

  function fakeDb(handler: (sql: string, params: unknown[]) => unknown[]) {
    const seen: Q[] = [];
    return {
      seen,
      db: {
        query: async (sql: string, params: unknown[] = []) => {
          seen.push({ sql, params });
          return { rows: handler(sql, params) as Record<string, unknown>[], rowCount: 0 };
        },
      },
    };
  }

  const RUN = { id: "run-1", project_id: "proj-1", tenant_id: "tnt-1" };

  it("desligado por padrão: não varre nada (medir é um estágio B pago)", async () => {
    const antes = process.env.SPEC_JUDGE_RECALL;
    delete process.env.SPEC_JUDGE_RECALL;
    const { judgeRecallTick } = await import("./specJudgeRecall.js");
    const { seen, db } = fakeDb(() => [RUN]);
    expect(await judgeRecallTick(db as never)).toEqual({ scanned: 0, started: 0, skipped: 0, busy: false });
    expect(seen).toHaveLength(0);
    if (antes === undefined) delete process.env.SPEC_JUDGE_RECALL;
    else process.env.SPEC_JUDGE_RECALL = antes;
  });

  it("só olha laços TERMINADOS — medir com o laço em voo mediria a disputa por orçamento", async () => {
    process.env.SPEC_JUDGE_RECALL = "on";
    const { judgeRecallTick } = await import("./specJudgeRecall.js");
    const { seen, db } = fakeDb((sql) => (/spec_autonomy_runs/.test(sql) ? [RUN] : []));
    const out = await judgeRecallTick(db as never);
    expect(seen[0].sql).toContain("finished_at IS NOT NULL");
    // spec ilegível (nenhum arquivo) ⇒ dispensada, e NADA é medido às cegas
    expect(out).toMatchObject({ scanned: 1, started: 0, skipped: 1 });
    delete process.env.SPEC_JUDGE_RECALL;
  });

  it("spec já medida encerra o assunto (GAP-95: outro gold set daria número incomparável)", async () => {
    process.env.SPEC_JUDGE_RECALL = "on";
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "recall-tick-"));
    const arquivo = join(dir, "01-visao.md");
    await writeFile(arquivo, ARQUIVO_A, "utf-8");
    const { judgeRecallTick } = await import("./specJudgeRecall.js");
    const { seen, db } = fakeDb((sql) => {
      if (/spec_autonomy_runs/.test(sql)) return [RUN];
      if (/project_spec_files/.test(sql)) return [{ filename: "01-visao.md", file_path: arquivo, rel_dir: "" }];
      if (/spec_judge_recall_runs/.test(sql)) return [{ "1": 1 }];   // JÁ medida
      return [];
    });
    const out = await judgeRecallTick(db as never);
    expect(out).toMatchObject({ scanned: 1, started: 0, skipped: 1 });
    // a checagem é por (projeto, spec_hash) — não por run, senão cada laço remediria a MESMA spec
    const dedupe = seen.find((q) => /FROM spec_judge_recall_runs/.test(q.sql))!;
    expect(dedupe.sql).toContain("project_id = $1 AND spec_hash = $2");
    expect(dedupe.params[0]).toBe("proj-1");
    delete process.env.SPEC_JUDGE_RECALL;
  });
});

// 🔴 GAP-152: o veredicto em PROSA do A/B (`abNote`) era a ÚNICA leitura humana do experimento — e
// era atribuída em memória, nunca gravada. Estes testes olham o INSERT de `gravar()` na fonte porque
// é lá que o fato passa (ou não) do processo para o banco: exercitar `runJudgeRecall` inteiro exigiria
// dois braços de LLM, e o defeito não estava no julgamento, estava no TRANSPORTE.
describe("GAP-152 — a prosa do A/B chega ao banco (instrumento com leitor)", () => {
  const FONTE = readFileSync(fileURLToPath(new URL("./specJudgeRecall.ts", import.meta.url)), "utf-8");

  const insert = FONTE.slice(
    FONTE.indexOf("INSERT INTO spec_judge_recall_runs"),
    FONTE.indexOf("ON CONFLICT (project_id, spec_hash"),
  );

  it("`ab_note` está na lista de colunas do INSERT (senão a prosa morre com o processo)", () => {
    expect(insert).toContain("ab_note");
  });

  it("colunas e placeholders batem — a classe de bug que faz o gravar falhar em SILÊNCIO", () => {
    // `gravar()` engole o erro de propósito (persistir é acessório à medição). Logo, uma coluna a mais
    // sem o `$N` correspondente não derrubaria nada: só apagaria a gravação. Aqui o desalinhamento
    // aparece em teste, não em prod.
    const colunas = insert
      .slice(insert.indexOf("(", insert.indexOf("spec_judge_recall_runs")) + 1, insert.indexOf("VALUES"))
      .replace(/\)\s*$/, "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const values = insert.slice(insert.indexOf("VALUES"));
    const maiorPlaceholder = Math.max(
      ...(values.match(/\$\d+/g) ?? []).map((p) => Number(p.slice(1))),
    );
    expect(colunas).toContain("ab_note");
    expect(maiorPlaceholder).toBe(colunas.length);
  });

  it("o UPSERT também atualiza `ab_note` (a 2ª medição da mesma spec não pode voltar a mentir)", () => {
    const upsert = FONTE.slice(FONTE.indexOf("DO UPDATE SET"), FONTE.indexOf("created_at = now()`"));
    expect(upsert).toContain("ab_note = EXCLUDED.ab_note");
  });

  it("a prosa vai nas DUAS linhas do par — ler só a linha do baseline é caminho normal na UI", () => {
    const bloco = FONTE.slice(FONTE.indexOf("if (cfg.thinkingAb)"));
    expect(bloco).toContain("res.abNote = prosa");
    expect(bloco).toContain("braco.abNote = prosa");
  });

  it("sem A/B o valor é NULL — `null` é 'não medido', nunca 'deu empate'", () => {
    expect(FONTE).toContain("res.abNote ?? null");
  });
});
