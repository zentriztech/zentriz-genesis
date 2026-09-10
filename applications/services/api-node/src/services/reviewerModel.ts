/**
 * reviewerModel.ts — QUEM pode revisar quem.
 *
 * ── A REGRA (Jean, 2026-09-10, verbatim) ───────────────────────────────────────────────────────
 * *"outra família E não mais fraco que o executor, se nao tem outra familia alertar"*
 *
 * As duas condições vêm de medição, não de gosto (`arXiv:2609.04270`, o mesmo paper que motivou o
 * `crossFamilyAudit`):
 *   • **outra família** — auto-revisão da MESMA família dá **zero** ganho de acurácia e rejeita
 *     **35%** do que estava certo. Revisar-se é confirmar o próprio viés duas vezes.
 *   • **não mais fraco** — revisor abaixo do executor mudou **0** respostas e dobrou o custo de
 *     token. Um revisor fraco não é "revisão barata": é fatura sem sinal.
 *   • **alertar** — quando nenhum candidato satisfaz as duas, o certo NÃO é cair no modelo do
 *     tenant (que é exatamente a auto-revisão medida como inútil, e foi o defeito do Grupo C):
 *     é **não rodar** e dizer por quê, com o que configurar para destravar.
 *
 * ── LIMITE DECLARADO ───────────────────────────────────────────────────────────────────────────
 * Família e "poder" saem do NOME do modelo — é a única informação que um id carrega, e ela é
 * heurística. Por isso id que não dá para ranquear NÃO é aceito em silêncio: vira alerta. Preferimos
 * uma auditoria a menos com motivo escrito do que uma auditoria que finge medir.
 */

/** 0 = não sei ranquear · 1 = pequeno · 2 = médio · 3 = topo de linha. */
export type PowerTier = 0 | 1 | 2 | 3;

/**
 * Família do modelo pelo id, em QUALQUER provider — Bedrock (`us.anthropic.claude-opus-5`),
 * Foundry bare (`claude-opus-5`), Vertex Model Garden (`claude-sonnet-4-5@20250929`,
 * `meta/llama-3.3-70b-instruct-maas`), OpenAI/Azure (`gpt-4o`).
 *
 * `specJudgeRecall.modelFamily` corta no prefixo do id do Bedrock e por isso responde
 * "claude-opus-5" para o id bare do Foundry — serve ao relatório de recall, não a esta decisão.
 */
export function modelFamilyOf(modelId: string): string {
  const id = (modelId || "").trim().toLowerCase();
  if (!id) return "desconhecida";
  const tabela: Array<[RegExp, string]> = [
    [/claude|anthropic/, "anthropic"],
    [/gemini|gemma|palm|bison/, "google"],
    [/nova|titan|^amazon[./]/, "amazon"],
    [/llama|^meta[./]/, "meta"],
    [/mistral|mixtral|ministral|magistral|codestral|devstral/, "mistral"],
    [/deepseek/, "deepseek"],
    [/qwen/, "qwen"],
    [/gpt-|^o[1-9](-|$)|davinci/, "openai"],
    [/command|^cohere[./]/, "cohere"],
    [/jamba|^ai21[./]/, "ai21"],
    [/grok/, "xai"],
  ];
  for (const [re, fam] of tabela) if (re.test(id)) return fam;
  return "desconhecida";
}

/**
 * Marcador EXPLÍCITO de porte pequeno no id. É o único sinal de potência que atravessa fabricantes:
 * `haiku`, `flash`, `mini`, `lite`, `nano` significam "a versão menor desta linha" em qualquer marca.
 *
 * ⚠️ `\b` é obrigatório porque "ge**mini**" contém "mini": sem a borda, todo Gemini seria lido como
 * modelo pequeno e nenhum passaria na regra "não mais fraco".
 */
export function isSmallModel(modelId: string): boolean {
  const id = (modelId || "").trim().toLowerCase();
  if (!id) return false;
  return /\b(haiku|flash|mini|nano|lite|micro|small|tiny|phi)\b|[^0-9](1|2|3|4|7|8|9)b([^0-9]|$)/.test(id);
}

/**
 * Faixa de poder pelo nome, **dentro do fabricante**. Comparar faixas de marcas diferentes NÃO é
 * suportado — ver `podeSerMaisFraco`.
 *
 * 🔴 Defeito corrigido em 2026-09-10: `-pro` estava numa lista única de "faixa 2", herdada do
 * `amazon.nova-pro` (que é meio de linha na Amazon). **No Google, `pro` é o TOPO** (flash < pro).
 * Com a lista única, `gemini-3-pro` virava faixa 2 e era recusado como "MAIS FRACO" que
 * `claude-opus-5` — ou seja, o slot Google não destravaria revisor nenhum. O mesmo sufixo
 * significa coisas diferentes por marca; a tabela agora é POR FAMÍLIA.
 */
export function modelPower(modelId: string): PowerTier {
  const id = (modelId || "").trim().toLowerCase();
  if (!id) return 0;
  if (isSmallModel(id)) return 1;
  const fam = modelFamilyOf(id);
  // Topo e meio por fabricante. Onde não há nomenclatura conhecida, devolvemos 0 (não sei) em vez de
  // chutar — 0 é tratado como "não afirmável", nunca como "fraco".
  const porFamilia: Record<string, [RegExp, RegExp]> = {
    //          topo (3)                          meio (2)
    anthropic: [/opus/,                           /sonnet/],
    google:    [/\bpro\b|-pro|_pro|ultra/,        /\bmedium\b/],
    amazon:    [/premier/,                        /-pro|_pro|\blite\b/],
    openai:    [/gpt-5(?!-mini)|gpt-4\.5|^o[1-9]/, /gpt-4/],
    mistral:   [/large/,                          /medium|codestral|devstral/],
    meta:      [/405b|70b-.*maas|\bmaverick\b/,   /70b|72b/],
    deepseek:  [/-r1|671b|675b|\bv3/,             /\bv2/],
    qwen:      [/max|235b|480b/,                  /32b|72b|110b/],
    xai:       [/grok-[0-9]+(?!-fast)/,           /grok-[0-9]+-fast/],
  };
  const par = porFamilia[fam];
  if (!par) return 0;
  if (par[0].test(id)) return 3;
  if (par[1].test(id)) return 2;
  return 0;
}

/**
 * O candidato é comprovadamente MAIS FRACO que o executor?
 *
 * A pesquisa (`arXiv:2609.04270`) põe um piso, não um teto: revisor **estritamente mais fraco**
 * muda 0 respostas e dobra o custo; revisor mais forte nunca foi medido como problema, e o melhor
 * revisor medido era *mid-tier*. Logo só precisamos detectar o piso.
 *
 * · Mesma família ⇒ a nomenclatura é comparável, compara-se a faixa.
 * · Famílias diferentes ⇒ **não há dado** que ordene `gemini-3-pro` contra `claude-opus-5`; afirmar
 *   ordem aí seria inventar precisão. Só o marcador explícito de porte pequeno é observável — ele
 *   fala do modelo em relação à PRÓPRIA linha, não à do concorrente.
 */
export function podeSerMaisFraco(candidato: string, executor: string): boolean {
  if (modelFamilyOf(candidato) === modelFamilyOf(executor)) {
    const pc = modelPower(candidato), pe = modelPower(executor);
    return pc !== 0 && pe !== 0 && pc < pe;
  }
  return isSmallModel(candidato) && !isSmallModel(executor);
}

/**
 * Entre N ids, quais NÃO são comprovadamente mais fracos que algum outro?
 *
 * ⚖️ Regra do Jean (2026-09-10): *"cyborg usa sempre o melhor modelo entre os cadastrados nos slots"*.
 * O Cyborg é o engenheiro final — corrige o que o pipeline não conseguiu — então rodá-lo no slot de
 * prioridade 0 só porque é o primeiro da lista era escolher pelo lugar na fila, não pela capacidade.
 *
 * ── POR QUE "não dominado" e não "o maior de uma nota" ────────────────────────────────────────
 * Ordenar por `modelPower` exigiria uma escala ÚNICA entre fabricantes, que não existe: não há dado
 * que ordene `gemini-3-pro` contra `claude-opus-5` (é o mesmo limite que `podeSerMaisFraco` já
 * declara). Inventar essa ordem faria o Cyborg trocar de modelo por causa de uma tabela nossa — e,
 * como cada slot tem provider e credencial próprios, trocaria também de FATURA.
 *
 * Então usamos só a relação MEDIDA: eliminamos quem é comprovadamente mais fraco que outro
 * candidato (mesma família com faixa menor, ou a variante pequena da linha contra uma não-pequena).
 * Sobram os incomparáveis — e aí quem desempata é a ordem do TENANT, que é dado real dele, não
 * palpite nosso. Id que não sabemos ranquear sobrevive: "não sei" nunca vira "é fraco".
 */
export function strongestByDomination(candidates: string[]): { winners: string[]; eliminados: string[] } {
  const ids = candidates.map((c) => (c || "").trim()).filter(Boolean);
  const winners: string[] = [];
  const eliminados: string[] = [];
  for (const cand of ids) {
    const dominador = ids.find((outro) => outro !== cand && podeSerMaisFraco(cand, outro));
    if (dominador) eliminados.push(`${cand}: comprovadamente mais fraco que ${dominador}`);
    else winners.push(cand);
  }
  return { winners, eliminados };
}

/**
 * O provider do tenant consegue servir este id?
 *
 * Só codificamos a restrição que já MEDIMOS: o Foundry desta conta só tem Claude (deployments
 * opus-5/sonnet-5/haiku-4-5, ids bare), então pedir `amazon.nova-pro-v1:0` ali é 404 garantido —
 * e é por isso que a auditoria cross-family está `off` em prod. Para os demais providers não
 * afirmamos nada: preferimos deixar passar e falhar na chamada real a inventar um catálogo.
 */
export function servableBy(provider: string, modelId: string): boolean {
  const p = (provider || "").trim().toLowerCase();
  const id = (modelId || "").trim().toLowerCase();
  if (p === "foundry") return /^claude-/.test(id);
  if (p === "anthropic") return modelFamilyOf(id) === "anthropic";
  return true;
}

/**
 * O modelo ESPECIALIZADO (barato/rápido) de um papel — planejador de promoção, gate semântico —
 * só pode ser imposto se o provider do tenant conseguir servi-lo.
 *
 * Aqui NÃO vale a regra cross-family: estes papéis não revisam ninguém, escolhem o modelo barato de
 * propósito. O risco é outro e é real — os defaults nasceram com id do Bedrock
 * (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) e o tenant pode estar no Foundry/Google/OpenAI,
 * onde esse id não existe. Quando não dá para servir, devolvemos `null` e o chamador deixa o modelo
 * do TENANT valer: um papel barato rodando no modelo do tenant custa mais, mas roda; pedir um id
 * inexistente é 400 — e no gate semântico, que é fail-open, um 400 vira "passou sem juiz nenhum".
 */
export function specializedModelFor(args: { provider?: string | null; model: string }): { model: string | null; why: string } {
  const model = (args.model || "").trim();
  const provider = (args.provider || "").trim();
  if (!model) return { model: null, why: "nenhum modelo especializado declarado" };
  if (provider && !servableBy(provider, model)) {
    return {
      model: null,
      why: `o modelo especializado '${model}' não é servível pelo provider '${provider}' do tenant — ` +
           "usando o modelo do próprio tenant para não pedir um id inexistente",
    };
  }
  return { model, why: `modelo especializado '${model}' servível por '${provider || "(provider do env)"}'` };
}

export type ReviewerPick =
  | { ok: true; model: string; family: string; why: string }
  // `recusados` é a MESMA lista que o `alert` já resume, exposta em separado para quem chama em
  // laço (um slot por vez): concatenar N alertas inteiros repetiria N vezes o parágrafo da pesquisa.
  | { ok: false; alert: string; recusados: string[] };

/**
 * Candidatos declarados numa env (aceita lista separada por vírgula — a ordem é a preferência).
 * Um id só por env continua funcionando: é uma lista de um.
 */
export function reviewerCandidates(raw: string | undefined, fallback = ""): string[] {
  return (raw ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Escolhe o revisor. Devolve o PRIMEIRO candidato que satisfaz as duas condições, ou um alerta
 * que nomeia cada candidato recusado e o motivo — o alerta é o produto quando não há revisor,
 * porque "não auditamos" sem motivo escrito é indistinguível de "auditamos e estava tudo certo".
 */
export function pickReviewerModel(args: {
  executorModel: string;
  candidates: string[];
  provider?: string | null;
}): ReviewerPick {
  const executor = (args.executorModel || "").trim();
  const provider = (args.provider || "").trim();
  const execFam = modelFamilyOf(executor);
  const execPow = modelPower(executor);
  const recusados: string[] = [];

  for (const cand of args.candidates) {
    const fam = modelFamilyOf(cand);
    const pow = modelPower(cand);
    if (fam === "desconhecida") {
      recusados.push(`${cand}: não sei a família deste id`);
      continue;
    }
    if (execFam === "desconhecida") {
      recusados.push(`${cand}: não sei a família do executor (${executor || "não declarado"}) — "outra família" não pode ser afirmado`);
      continue;
    }
    if (fam === execFam) {
      recusados.push(`${cand}: MESMA família do executor (${fam})`);
      continue;
    }
    if (provider && !servableBy(provider, cand)) {
      recusados.push(`${cand}: o provider '${provider}' do tenant não serve este id`);
      continue;
    }
    // Só o PISO medido barra — e cross-vendor o único sinal observável é o marcador de porte
    // pequeno. Antes exigíamos ranquear os dois ids numa escala única: isso recusava
    // `gemini-3-pro` contra `claude-opus-5` afirmando "mais fraco" sem nenhum dado que o sustente.
    if (podeSerMaisFraco(cand, executor)) {
      recusados.push(
        fam === execFam
          ? `${cand}: MAIS FRACO que o executor (${pow} < ${execPow})`
          : `${cand}: é a variante PEQUENA da própria linha e o executor não é — revisor mais fraco muda 0 respostas`,
      );
      continue;
    }
    return {
      ok: true,
      model: cand,
      family: fam,
      why: `${cand} (${fam}, poder ${pow}) revisa ${executor || "(executor não declarado)"} (${execFam}, poder ${execPow})`,
    };
  }

  const detalhe = recusados.length ? recusados.join(" | ") : "nenhum candidato configurado";
  return {
    ok: false,
    recusados: recusados.length ? recusados : ["nenhum candidato configurado"],
    alert:
      `sem revisor cross-family viável para o executor '${executor || "(não declarado)"}' ` +
      `(família ${execFam}, poder ${execPow}, provider ${provider || "(do env)"}): ${detalhe}. ` +
      "A auditoria NÃO roda: revisor da MESMA família mede zero ganho e rejeita 35% do que está " +
      "certo, e revisor mais fraco muda 0 respostas pelo dobro do custo. Para destravar, declare " +
      "um id de OUTRA família, não mais fraco, servível por este provider.",
  };
}
