/**
 * reviewerModel.test.ts — a regra do Jean (2026-09-10) virou código testável:
 * *"outra família E não mais fraco que o executor, se nao tem outra familia alertar"*.
 *
 * Os testes guardam as três coisas que, faltando, devolvem o sistema ao defeito do Grupo C:
 *   1. família reconhecida em QUALQUER provider (Bedrock, Foundry bare, Vertex, OpenAI) — se o id do
 *      Foundry (`claude-opus-5`) não for lido como anthropic, um revisor Claude passaria como
 *      "outra família" e a auditoria voltaria a ser auto-revisão;
 *   2. revisor comprovadamente mais fraco é RECUSADO — a pesquisa mede 0 respostas mudadas e o
 *      dobro do custo. "Comprovadamente" faz trabalho aqui: entre marcas diferentes o único sinal
 *      é o marcador de porte pequeno (haiku/flash/mini), porque a mesma palavra ("pro") muda de
 *      significado de fabricante para fabricante;
 *   3. sem candidato viável o retorno é ALERTA, nunca um modelo — cair no modelo do tenant era
 *      exatamente o bug silencioso de `crossFamilyAudit.ts`.
 */
import { describe, it, expect } from "vitest";

import {
  modelFamilyOf, modelPower, podeSerMaisFraco, pickReviewerModel, reviewerCandidates, servableBy,
  specializedModelFor,
} from "./reviewerModel.js";

describe("modelFamilyOf — o id de qualquer provider tem de dizer a família", () => {
  it("reconhece Claude em Bedrock, Foundry bare e Vertex", () => {
    expect(modelFamilyOf("us.anthropic.claude-opus-5")).toBe("anthropic");
    expect(modelFamilyOf("claude-opus-5")).toBe("anthropic");
    expect(modelFamilyOf("claude-sonnet-4-5@20250929")).toBe("anthropic");
  });

  it("reconhece as famílias que o crédito Google e o Bedrock revendem", () => {
    expect(modelFamilyOf("gemini-2.5-pro")).toBe("google");
    expect(modelFamilyOf("amazon.nova-pro-v1:0")).toBe("amazon");
    expect(modelFamilyOf("meta/llama-3.3-70b-instruct-maas")).toBe("meta");
    expect(modelFamilyOf("mistral.mistral-large-3-675b-instruct")).toBe("mistral");
    expect(modelFamilyOf("deepseek.v3.2")).toBe("deepseek");
    expect(modelFamilyOf("qwen.qwen3-32b-v1:0")).toBe("qwen");
    expect(modelFamilyOf("gpt-4o")).toBe("openai");
  });

  it("id que não reconhece é 'desconhecida' — nunca um palpite", () => {
    expect(modelFamilyOf("modelo-interno-v7")).toBe("desconhecida");
    expect(modelFamilyOf("")).toBe("desconhecida");
  });
});

describe("modelPower — a faixa sai do nome, e o nome só é comparável DENTRO do fabricante", () => {
  it("'gemini' contém 'mini': o Gemini Pro NÃO pode cair na faixa pequena", () => {
    expect(modelPower("gemini-2.5-flash")).toBe(1);
    expect(modelPower("gpt-4o-mini")).toBe(1);
  });

  // 🔴 O defeito de 2026-09-10: `-pro` estava numa lista única, herdada do `amazon.nova-pro`.
  // No Google `pro` é o TOPO da linha (flash < pro); na Amazon é o meio (lite < pro < premier).
  // Com a lista única, `gemini-3-pro` virava faixa 2 e o slot Google do Jean não destravaria revisor.
  it("o MESMO sufixo '-pro' vale coisas diferentes por marca", () => {
    expect(modelPower("gemini-3-pro")).toBe(3);        // topo no Google
    expect(modelPower("gemini-2.5-pro")).toBe(3);
    expect(modelPower("amazon.nova-pro-v1:0")).toBe(2); // meio na Amazon
    expect(modelPower("amazon.nova-premier-v1:0")).toBe(3);
  });

  it("ranqueia as faixas que usamos hoje", () => {
    expect(modelPower("us.anthropic.claude-opus-5")).toBe(3);
    expect(modelPower("mistral.mistral-large-3-675b-instruct")).toBe(3);
    expect(modelPower("claude-sonnet-5")).toBe(2);
    expect(modelPower("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(1);
    expect(modelPower("modelo-interno-v7")).toBe(0);
  });
});

describe("podeSerMaisFraco — o piso medido, sem inventar ordem entre marcas", () => {
  it("mesma família: a nomenclatura é comparável, então a faixa decide", () => {
    expect(podeSerMaisFraco("claude-sonnet-5", "claude-opus-5")).toBe(true);
    expect(podeSerMaisFraco("claude-opus-5", "claude-sonnet-5")).toBe(false);
  });

  it("famílias diferentes: só o marcador EXPLÍCITO de porte pequeno é observável", () => {
    // Não há dado que ordene Gemini 3 Pro contra Opus 5 — afirmar ordem aqui seria inventar precisão.
    expect(podeSerMaisFraco("gemini-3-pro", "claude-opus-5")).toBe(false);
    expect(podeSerMaisFraco("gemini-2.5-flash", "claude-opus-5")).toBe(true);
    // Executor já pequeno ⇒ o candidato pequeno não é "mais fraco".
    expect(podeSerMaisFraco("gemini-2.5-flash", "claude-haiku-4-5")).toBe(false);
  });
});

describe("pickReviewerModel — outra família E não mais fraco", () => {
  it("recusa a MESMA família mesmo quando o modelo é excelente", () => {
    const r = pickReviewerModel({ executorModel: "claude-opus-5", candidates: ["us.anthropic.claude-opus-4-8"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alert).toContain("MESMA família");
  });

  // ⚠️ CORREÇÃO de 2026-09-10 — a regra anterior recusava este caso por "MAIS FRACO", e recusava
  // justamente a configuração que o paper mediu como a MELHOR: cross-family **mid-tier**, +12 p.p.
  // de defeitos encontrados. A linha "mudou 0 respostas" é a do revisor PEQUENO, não a do mid-tier.
  it("aceita cross-family mid-tier (é a linha de +12 p.p. do paper, não a linha inerte)", () => {
    const r = pickReviewerModel({ executorModel: "claude-opus-5", candidates: ["amazon.nova-pro-v1:0"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model).toBe("amazon.nova-pro-v1:0");
  });

  it("recusa a variante PEQUENA da linha quando o executor não é pequeno", () => {
    const r = pickReviewerModel({ executorModel: "claude-opus-5", candidates: ["gemini-2.5-flash"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alert).toContain("PEQUENA");
  });

  it("aceita outra família de poder igual ou maior e diz por quê", () => {
    const r = pickReviewerModel({ executorModel: "claude-sonnet-5", candidates: ["amazon.nova-pro-v1:0"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model).toBe("amazon.nova-pro-v1:0");
      expect(r.family).toBe("amazon");
      expect(r.why).toContain("poder");
    }
  });

  it("percorre a lista na ordem e fica no primeiro que serve", () => {
    const r = pickReviewerModel({
      executorModel: "claude-opus-5",
      candidates: ["us.anthropic.claude-opus-4-8", "gemini-2.5-flash", "mistral.mistral-large-3-675b-instruct"],
    });
    expect(r.ok).toBe(true);
    // 1º recusado por MESMA família, 2º pelo porte pequeno ⇒ fica o 3º.
    if (r.ok) expect(r.model).toBe("mistral.mistral-large-3-675b-instruct");
  });

  it("recusa id que o provider do tenant não serve — o Foundry desta conta só tem Claude", () => {
    const r = pickReviewerModel({
      executorModel: "claude-opus-5", provider: "foundry",
      candidates: ["mistral.mistral-large-3-675b-instruct"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alert).toContain("não serve este id");
  });

  // Id sem faixa reconhecível de OUTRA família passa a ser ACEITO: não ter marcador de porte
  // pequeno é uma observação; "é mais fraco que Opus 5" seria uma afirmação sem dado.
  it("id de outra família sem faixa reconhecível é aceito — o que não sabemos não vira acusação", () => {
    const r = pickReviewerModel({ executorModel: "claude-opus-5", candidates: ["mistral-modelo-x"] });
    expect(r.ok).toBe(true);
  });

  it("família desconhecida continua barrada — sem família não dá para afirmar 'cross-family'", () => {
    const r = pickReviewerModel({ executorModel: "claude-opus-5", candidates: ["modelo-interno-v7"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alert).toContain("não sei a família");
  });

  it("sem candidato nenhum o retorno continua sendo alerta, nunca um modelo", () => {
    const r = pickReviewerModel({ executorModel: "claude-opus-5", candidates: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alert).toContain("nenhum candidato configurado");
  });

  it("o alerta diz o que fazer — alerta sem ação é ruído", () => {
    const r = pickReviewerModel({ executorModel: "claude-opus-5", candidates: ["us.anthropic.claude-opus-4-8"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alert).toContain("OUTRA família");
  });
});

describe("reviewerCandidates — a env aceita lista, e um id só continua valendo", () => {
  it("quebra por vírgula preservando a ordem de preferência", () => {
    expect(reviewerCandidates("a, b ,c")).toEqual(["a", "b", "c"]);
  });
  it("env vazia cai no fallback; nenhum dos dois ⇒ lista vazia", () => {
    expect(reviewerCandidates(undefined, "amazon.nova-pro-v1:0")).toEqual(["amazon.nova-pro-v1:0"]);
    expect(reviewerCandidates(undefined, "")).toEqual([]);
  });
});

describe("servableBy / specializedModelFor — modelo barato não pode virar 400", () => {
  it("Foundry só serve Claude bare (medido: os deployments desta conta são Claude)", () => {
    expect(servableBy("foundry", "claude-haiku-4-5")).toBe(true);
    expect(servableBy("foundry", "us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(false);
    expect(servableBy("foundry", "amazon.nova-pro-v1:0")).toBe(false);
  });

  it("provider desconhecido não é chutado: deixamos passar e falhamos na chamada real", () => {
    expect(servableBy("bedrock", "amazon.nova-pro-v1:0")).toBe(true);
    expect(servableBy("", "qualquer-coisa")).toBe(true);
  });

  it("id do Bedrock sob tenant Foundry ⇒ null (o modelo do tenant vale) com motivo escrito", () => {
    const r = specializedModelFor({ provider: "foundry", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
    expect(r.model).toBeNull();
    expect(r.why).toContain("não é servível");
  });

  it("servível ⇒ o modelo especializado vence (é o ponto da env existir)", () => {
    expect(specializedModelFor({ provider: "bedrock", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }).model)
      .toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });
});
