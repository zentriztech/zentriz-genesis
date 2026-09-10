/**
 * specPolicyGate.ts — 🔴 F2: CONSTRAINTS DECLARADAS + POLICY GATE.
 *
 * ── POR QUE (pesquisa, não palpite) ────────────────────────────────────────────────────────────
 * `arXiv:2609.04167` mede que **34% dos patches que PASSAM nos testes violam constraints declaradas
 * na revisão**. "Passou no teste" e "cumpriu o que foi pedido" são coisas diferentes — e a Bancada
 * não tinha nenhum estágio que verificasse constraint. Tinha caça a GAP (espaço ABERTO, com a
 * superfície medida rotacionando a cada rodada — GAP-76) e o juiz de promovibilidade (GAP-77).
 *
 * Caçar GAP é busca em espaço aberto: a cada rodada nascem GAPs novos e o laço não converge.
 * Constraint declarada é espaço **FECHADO e ENUMERÁVEL**: "a spec declara N constraints; cada uma
 * está satisfeita, violada, indecidível, pendente ou dispensada". Esse é o critério de parada que a
 * caça a GAP nunca deu, e é a forma concreta do EQUILÍBRIO que o Jean exigiu (verbatim: *"não
 * podemos ignorar falhas realmente graves … também não podemos entrar em um loop infinito em busca
 * da perfeição que nunca será alcançada"*).
 *
 * ── DUAS REVISÕES ADVERSARIAIS CROSS-FAMILY DO DESENHO (2026-09-08, no container de prod) ───────
 * Nova Pro (5 achados) e Mistral Large 3 (7 achados) atacaram o desenho ANTES de existir código.
 * O que cada achado que PROCEDE virou aqui:
 *
 *  • **Mistral B1 (grave)** — reusar `constraint_key` com `assertion` diferente é o GAP-49/50 pelo
 *    avesso: a identidade fica estável e o SIGNIFICADO troca em silêncio. ⇒ `assertionSha` e
 *    `drift`. O código **não julga equivalência** (o sistema é 100% LLM): compara sha e DECLARA a
 *    troca não-declarada.
 *  • **Mistral B2 (médio)** — na Bancada os artefatos do produto AINDA NÃO EXISTEM. Constraint
 *    verificável só em build/runtime viraria `indecidivel` ETERNO, que é ruído e não rigor. ⇒
 *    `verifiableAt` e o status próprio `pending`, que a frente F3 (oráculo executável) vai julgar.
 *  • **Mistral B3 (grave)** — waiver podia ser explorado: *"não deu tempo neste sprint"* dispensaria
 *    uma constraint de segurança. ⇒ o waiver é CLASSIFICADO por agente em `inapplicable` (a
 *    constraint não se aplica a este produto ⇒ dispensa) vs `postponement` (adiamento ⇒ **continua
 *    bloqueando** e aparece no relatório). O código transporta e conta; a classificação é do LLM.
 *  • **Mistral B4 (run 1)** — resposta parcial do juiz. ⇒ cobertura MEDIDA: N constraints entram, N
 *    veredictos saem; chave desconhecida é descartada e CONTADA; chave sem veredicto vira
 *    `indecidivel/not_judged` (lição GAP-17/18: o juiz era cego a 10 de 12 e ninguém notava).
 *  • **Mistral B5 (médio)** — o cross-family auditava o veredicto e não a DERIVAÇÃO. ⇒ o auditor
 *    classifica cada constraint em `verificavel|vaga|irrelevante`, e `archetypeHash` entra na chave
 *    de idempotência (mudar o checklist do arquétipo muda a derivação com a MESMA spec).
 *  • **Nova A4 / Mistral B2** — `satisfied` com evidência inventada. ⇒ a evidência tem de ser
 *    CITAÇÃO VERBATIM de um artefato NOMEADO, e o código confere a substring. Falha ⇒
 *    `indecidivel/evidence_not_found`, contado. É Context Integrity: o código não julga mérito, ele
 *    recusa premissa fabricada.
 *
 * ── O QUE FOI REJEITADO, e por quê (revisor não é dono) ─────────────────────────────────────────
 * Nova A3 e Mistral B4/B7 pediram **teto fixo de constraints** e **limite de 10% de `indecidivel`
 * bloqueando promoção**. Rejeitado: número mágico em código é a "automação fixa disfarçada" que o
 * Jean proibiu (`feedback-genesis-100-llm-nunca-automacao-fixa`), e "a contagem tem de CAIR" foi
 * substituído em 2026-09-07 por "o JUIZ decide". ⇒ a cobertura e o crescimento são entregues ao juiz
 * como FATO, e ele decide. Mistral B3 também pediu aprovação HUMANA para waiver de severidade alta:
 * rejeitado por quebrar a autonomia; a classificação `inapplicable` vs `postponement` resolve a
 * mesma exploração sem parar o laço.
 *
 * ── LIMITES DE DESENHO (invioláveis) ───────────────────────────────────────────────────────────
 *  1. **o gate só ACRESCENTA impedimento.** Não existe rota neste arquivo que torne um candidato
 *     promovível. Fail-CLOSED por construção: sem LLM, sem JSON, sem cobertura ⇒ `ran: false` e o
 *     caminho antigo (todos os GAPs impeditivos) segue de pé.
 *  2. **não muda severidade de finding.** Constraint tem severidade própria — e `blocking` NÃO
 *     depende dela, justamente para não reabrir o limite (a) do Jean.
 *  3. **roda uma vez por candidato à promoção**, nunca por task (o Dev/QA rodam por task; um estágio
 *     novo ali multiplicaria a conta do projeto inteiro).
 */
import { createHash } from "node:crypto";

import type { Archetype } from "./archetypeCatalog.js";
import { evidenceIsVerbatim } from "./crossFamilyAudit.js";
import type { Db } from "./findingTriage.js";
import { parseCountField, parseListResponse } from "./gapPromotionVerdict.js";
import { agentsLlmFields, resolveReviewerLlmForProject } from "./tenantLlmConfig.js";

/** Onde a constraint é verificável. `spec` é o único julgável na Bancada (Mistral B2). */
export type VerifiableAt = "spec" | "build" | "runtime";
export type PolicyStatus = "satisfied" | "violated" | "indecidivel" | "pending" | "waived";
export type WaiverKind = "inapplicable" | "postponement" | "";
export type ConstraintAudit = "verificavel" | "vaga" | "irrelevante" | "";

const VERIFIABLE_AT: readonly VerifiableAt[] = ["spec", "build", "runtime"];

function num(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `SPEC_POLICY_GATE=on` liga. Default OFF: medir antes de gatear (mesma disciplina do cross-family). */
export function policyGateEnabled(): boolean {
  return (process.env.SPEC_POLICY_GATE ?? "").trim().toLowerCase() === "on";
}

export function policyGateConfig() {
  return {
    /** Teto de constraints por derivação. NÃO é limite de mérito: é teto de PROMPT e de fatura. */
    maxConstraints: num(process.env.SPEC_POLICY_MAX_CONSTRAINTS, 40),
    maxTokens: num(process.env.SPEC_POLICY_MAX_TOKENS, 6_000),
    timeoutMs: num(process.env.SPEC_POLICY_TIMEOUT_MS, 180_000),
    /**
     * ⚖️ LEI 2026-09-10 — vazio de propósito: o auditor da DERIVAÇÃO sai do slot do tenant
     * (`resolveReviewerLlmForProject`), resolvido no ponto de uso. Era `amazon.nova-pro-v1:0` por
     * literal, cobrado na credencial do tenant — mesmo defeito de `crossFamilyAudit`.
     */
    auditModel: "",
    /** Teto do texto de spec que vai ao derivador. O dossiê já garante mapa de 100% dos arquivos. */
    specChars: num(process.env.SPEC_POLICY_SPEC_CHARS, 120_000),
    /**
     * Teto de artefato POR PASSE do juiz — o mesmo teto estrutural do GAP-54/61.
     *
     * A spec do NVX tem 1.067.990 chars (~275k tokens): mandar "todos os artefatos" numa chamada é
     * impossível, e a chamada não falharia num erro claro — ela devolveria 400 e o gate viveria
     * `ran: false` para sempre em toda spec grande, sem ninguém notar. Então o juiz roda em N passes
     * por lote de artefato, e o que não caber é DECLARADO (nunca cortado em silêncio).
     */
    artifactChars: num(process.env.SPEC_POLICY_ARTIFACT_CHARS, 120_000),
    /** Teto de passes do juiz. Trava de custo: spec absurda não vira fatura ilimitada. */
    maxJudgePasses: num(process.env.SPEC_POLICY_MAX_PASSES, 12),
    /**
     * Orçamento de SAÍDA da derivação e do veredicto, separados do `maxTokens` genérico.
     *
     * Pedir N itens com um orçamento que não cabe N itens é a família do GAP-61 (medir uma coisa
     * pela outra): 40 constraints com trecho ancorado verbatim não cabem em 6.000 tokens, e o guard
     * de `truncated` recusaria o parecer inteiro — corretamente, porque parecer cortado é parecer sem
     * conclusão. O orçamento tem de caber o que o prompt pede, e o PRAZO tem de caber o orçamento
     * (ver `msPerToken`, que é onde a falha realmente se manifestou em prod).
     */
    deriveTokens: num(process.env.SPEC_POLICY_DERIVE_TOKENS, 24_000),
    verdictTokens: num(process.env.SPEC_POLICY_VERDICT_TOKENS, 12_000),
    /**
     * Milissegundos de PRAZO por token de saída pedido. Medido em prod, na terceira ocorrência da
     * mesma família num só dia: `timeoutMs` fixo de 180s cobria 6.000 tokens, cobriu a raspas 24.000
     * (150s) e estourou quando o prompt cresceu — `Socket timeout after 180s`. Prazo fixo para
     * orçamento variável é medir uma coisa pela outra (GAP-61). O prazo agora ACOMPANHA o pedido.
     */
    msPerToken: num(process.env.SPEC_POLICY_MS_PER_TOKEN, 30),
    /** Teto do prazo: nem o pedido mais caro trava um worker para sempre. */
    maxTimeoutMs: num(process.env.SPEC_POLICY_MAX_TIMEOUT_MS, 900_000),
    /**
     * Passes de DERIVAÇÃO. O derivador tem o mesmo teto do juiz: 120k chars por chamada. Numa spec
     * de 1,07M chars uma chamada só lhe dava 12% do texto — e ele nunca recebia dois arquivos
     * INTEIROS, então a classe de coerência interna era invisível por construção.
     */
    maxDerivePasses: num(process.env.SPEC_POLICY_MAX_DERIVE_PASSES, 10),
    /**
     * Teto GLOBAL de constraints por spec (o `maxConstraints` é por PASSE). Trava de fatura.
     *
     * 🔴 MEDIDO EM PROD (2026-09-08): a spec do NVX LastMile encostou no teto — o número que o
     * relatório mostrava como "a política desta spec" era o TETO, não a política (mesma família do
     * GAP-61: medir uma coisa pela outra). E o efeito era pior que cosmético: a spec tem 1.068k chars
     * ⇒ **9 lotes** de 120k; com 40 constraints por passe, o teto de 120 se esgotava no 3º lote e o
     * laço fazia `break` — **6 dos 9 lotes nunca tiveram constraint derivada**, em silêncio. É
     * literalmente o GAP-54/61 outra vez: declarar política sobre um terço do texto e chamar isso de
     * política da spec.
     *
     * Subido a **360 = 9 lotes × 40** por decisão do Jean, para que o teto pare de decidir QUANTOS
     * ARQUIVOS entram na política; ele volta a ser só a trava de fatura de uma spec absurda (mais de
     * 9 lotes). O custo é medido e limitado: a derivação é memoizada por
     * `(projectId, specHash, archetypeHash)`, então isto é ~9 chamadas de ≤24k tokens de saída UMA
     * vez por spec+arquétipo, em vez de 3 — a latência por chamada não muda (`agentDeadlineMs`
     * depende só do orçamento pedido, que continua `deriveTokens`).
     *
     * Junto vem a regra 8 do `DERIVE_SYSTEM`: o derivador declara quantas constraints a spec ainda
     * sustenta além das que devolveu (`declaredNeeded`), então o próximo encosto aparece no log em vez
     * de desaparecer.
     */
    maxConstraintsTotal: num(process.env.SPEC_POLICY_MAX_CONSTRAINTS_TOTAL, 360),
  };
}

/**
 * Prazo de uma chamada, derivado do orçamento de saída que ela pede.
 *
 * `timeoutMs` é PISO (chamada curta não espera menos que isso) e `maxTimeoutMs` é TETO.
 */
export function agentDeadlineMs(outputTokens: number, cfg = policyGateConfig()): number {
  const escalado = Math.trunc(Math.max(0, outputTokens) * cfg.msPerToken);
  return Math.min(cfg.maxTimeoutMs, Math.max(cfg.timeoutMs, escalado));
}

/**
 * Divide os artefatos em lotes que CABEM numa chamada, e diz o que não caberá por inteiro.
 *
 * Artefato maior que o teto vai sozinho no lote e entra RECORTADO — com o corte anunciado ao agente e
 * o nome devolvido em `partial`. É a regra de sempre: cortar é aceitável, mentir sobre o corte não.
 * O que `partial` compra é concreto: uma acusação contra artefato que o juiz nunca viu por inteiro
 * NÃO pode bloquear a promoção.
 */
export function batchArtifacts(
  artifacts: Array<{ name: string; content: string }>, maxChars: number, maxBatches: number,
): { batches: Array<Array<{ name: string; content: string; cutFrom?: number }>>; partial: string[]; dropped: string[] } {
  const batches: Array<Array<{ name: string; content: string; cutFrom?: number }>> = [];
  const partial: string[] = [];
  const dropped: string[] = [];
  let cur: Array<{ name: string; content: string; cutFrom?: number }> = [];
  let size = 0;
  for (const a of artifacts) {
    if (a.content.length > maxChars) {
      if (cur.length) { batches.push(cur); cur = []; size = 0; }
      batches.push([{ name: a.name, content: a.content.slice(0, maxChars), cutFrom: a.content.length }]);
      partial.push(a.name);
      continue;
    }
    if (size + a.content.length > maxChars && cur.length) { batches.push(cur); cur = []; size = 0; }
    cur.push({ name: a.name, content: a.content });
    size += a.content.length;
  }
  if (cur.length) batches.push(cur);
  if (batches.length > maxBatches) {
    for (const b of batches.slice(maxBatches)) for (const a of b) dropped.push(a.name);
    return { batches: batches.slice(0, maxBatches), partial, dropped };
  }
  return { batches, partial, dropped };
}

/**
 * Escolhe, entre os veredictos de VÁRIOS passes, o que vale por chave.
 *
 * A ordem não é arbitrária: um `satisfied` com citação verbatim é PROVA de cumprimento e vale sobre
 * qualquer acusação vinda de um passe que não viu o artefato onde a prova estava. Acusação sem
 * artefato conhecido perde para qualquer coisa. Sem esta precedência, dividir em lotes criaria
 * violações falsas em massa — cada passe acusaria o que não estava no lote dele.
 */
export function pickBestRaw(
  raws: Array<Record<string, unknown>>, artifacts: Array<{ name: string; content: string }>,
): Array<Record<string, unknown>> {
  const byName = new Map(artifacts.map((a) => [a.name.toLowerCase(), a.content]));
  const rank = (r: Record<string, unknown>): number => {
    const status = String(r.status ?? "").trim().toLowerCase();
    const content = byName.get(String(r.artifact ?? "").trim().toLowerCase()) ?? "";
    if (status === "satisfied" && content && evidenceIsVerbatim(String(r.evidence ?? ""), content)) return 0;
    if (status === "violated" && content) return 1;
    if (status === "satisfied") return 2;
    return 3;
  };
  const best = new Map<string, { r: Record<string, unknown>; rank: number }>();
  for (const r of raws) {
    const k = normalizeKey(r.constraint_key ?? r.constraintKey);
    if (!k) continue;
    const cur = best.get(k);
    const rk = rank(r);
    if (!cur || rk < cur.rank) best.set(k, { r, rank: rk });
  }
  return [...best.values()].map((x) => x.r);
}

export interface SpecConstraint {
  constraintKey: string;
  appliesTo: string;
  assertion: string;
  assertionSha: string;
  evidenceHint: string;
  verifiableAt: VerifiableAt;
  severity: string;
  sourceAnchor: string;
  anchorVerbatim: boolean;
  supersededByKey: string | null;
  drift: boolean;
  declaredByModel: string;
}

export interface PolicyVerdict {
  constraintKey: string;
  status: PolicyStatus;
  evidence: string;
  evidenceVerbatim: boolean;
  artifact: string;
  reason: string;
  waiverKind: WaiverKind;
  auditVerdict: ConstraintAudit;
  blocking: boolean;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Normalização só para COMPARAR significado — o texto gravado é sempre o do agente, intacto. */
export function assertionSha(assertion: string): string {
  return sha256Hex(assertion.replace(/\s+/g, " ").trim().toLowerCase());
}

/**
 * Identidade do ARQUÉTIPO usada na chave de idempotência (Mistral B5).
 *
 * Sem ela, mudar o `checklist` do catálogo produziria constraints diferentes para a MESMA spec e a
 * derivação continuaria dizendo "já decidido neste conteúdo" — idempotência mentirosa.
 */
export function archetypeHash(a: Pick<Archetype, "id" | "checklist"> | null | undefined): string {
  if (!a) return sha256Hex("sem-arquetipo").slice(0, 16);
  return sha256Hex(`${a.id}\n${(a.checklist ?? []).join("\n")}`).slice(0, 16);
}

/** Slug conservador: a chave é a IDENTIDADE da constraint entre rodadas, não pode virar prosa. */
export function normalizeKey(raw: unknown): string {
  return String(raw ?? "")
    .trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export const DERIVE_SYSTEM = `Você DERIVA as CONSTRAINTS VERIFICÁVEIS de uma especificação técnica de software.

Uma constraint é uma afirmação que pode ser CONFERIDA contra um artefato concreto, e que, se violada,
faz o produto entregue estar ERRADO. Ela não é um desejo, não é um resumo e não é uma crítica.

REGRAS INVIOLÁVEIS:
1. Toda constraint nasce de um TRECHO da especificação. Copie esse trecho VERBATIM em "source_anchor"
   (30 a 300 caracteres, caractere por caractere como está no texto). Trecho inventado invalida a
   constraint — o código confere a citação literalmente.
2. Toda constraint precisa de "evidence_hint": QUAL artefato concreto provaria que ela foi cumprida.
   Se você não consegue nomear o artefato, NÃO declare a constraint.
3. "verifiable_at" diz ONDE ela é conferível:
   - "spec": conferível lendo a própria especificação (ex.: o contrato de erro está definido).
   - "build": exige o código/arquivo produzido (ex.: o endpoint existe e valida o campo).
   - "runtime": exige executar (ex.: a resposta volta em menos de 200ms).
   Seja honesto: marcar "spec" o que só é conferível executando produz veredicto falso.
3b. COERÊNCIA INTERNA é conferível AGORA, em "spec", e é a classe que mais defeito real produziu
   nesta plataforma: a MESMA regra reafirmada em mais de um arquivo ou seção com valor, limite,
   literal, nome de coluna, código de erro ou estado DIFERENTE. Quando a spec reafirma algo,
   declare a constraint de coerência:
   - a "assertion" enuncia a SUBSTÂNCIA que tem de ser a mesma (o valor, o limite, o literal, a
     transição), NUNCA "os dois textos são iguais". Redação diferente para a MESMA substância é
     coerente — acusar variação de palavra é falso positivo, e falso positivo aqui vira loop eterno;
   - "source_anchor" é UMA das ocorrências, verbatim;
   - "evidence_hint" NOMEIA o arquivo/seção IRMÃO onde está a outra ocorrência e o trecho que a
     localiza. "está no arquivo irmão" não serve: numa spec de 12 arquivos ninguém acha;
   - "applies_to" lista os arquivos/seções envolvidos, separados por vírgula;
   - "severity": "blocker" só se a divergência muda o PRODUTO construído (valores incompatíveis,
     estados contraditórios). Reafirmação que só está redigida de outro jeito é "warning".
4. "constraint_key" é um slug curto e ESTÁVEL em inglês (ex.: "error-envelope-declared"). Se a lista
   de chaves já existentes trouxer a MESMA constraint, REUSE a chave idêntica — a contagem entre
   rodadas só tem sentido se a identidade for estável.
5. Se você reusar uma chave existente MUDANDO o significado dela, declare a chave antiga em
   "supersedes_key" e use uma chave nova. Trocar o significado calado é proibido.
6. NÃO invente constraint que a especificação não sustenta, e NÃO deixe de declarar a que ela
   sustenta. O checklist do arquétipo é SEMENTE: adote, reescreva ou descarte cada item, e acrescente
   o que faltar.
7. "severity": "blocker" se a violação faz o produto estar errado ou impossível de construir;
   "warning" se sobra risco real de engenharia.
8. O número máximo de constraints pedido é um TETO DE ORÇAMENTO, não a sua avaliação do que a spec
   exige. Declare em "constraints_needed" quantas constraints verificáveis este lote AINDA sustenta
   ALÉM das que você devolveu (0 se devolveu todas). Declarar não corta e não acrescenta nada: é a
   única forma de o teto aparecer no relatório em vez de desaparecer. Chutar para cima é tão errado
   quanto omitir — o número tem de ser o que você de fato viu e não teve espaço para escrever.

Responda APENAS JSON, sem cercas de código:
{"constraints":[{"constraint_key":"...","applies_to":"<arquivo ou seção da spec, ou *>","assertion":"<a afirmação verificável, em português>","evidence_hint":"<que artefato prova>","verifiable_at":"spec|build|runtime","severity":"blocker|warning","source_anchor":"<trecho VERBATIM da spec>","supersedes_key":null}],"constraints_needed":0}`;

export const VERDICT_SYSTEM = `Você é o POLICY GATE: verifica, uma por uma, se as CONSTRAINTS declaradas estão cumpridas nos ARTEFATOS entregues.

Você NÃO reescreve constraint, NÃO cria constraint nova e NÃO julga se ela era boa ideia. Você só
responde, para cada uma: está cumprida nos artefatos, está violada, ou não é decidível com o que veio.

REGRAS INVIOLÁVEIS:
1. Responda UMA linha para CADA "constraint_key" que você recebeu. Nenhuma pode faltar, e não invente
   chave que não recebeu.
2. "satisfied" exige "artifact" (o nome exato de um artefato da lista) e "evidence": uma citação
   VERBATIM copiada desse artefato, caractere por caractere. Sem a citação literal, não é satisfeita
   — é "indecidivel". Citar a constraint em vez do artefato não prova nada.
3. "violated" exige "artifact" concreto e "evidence" que mostre a violação (o trecho que contradiz, ou
   a declaração de que o artefato deveria conter e não contém). Acusação sem artefato é descartada:
   o ônus da prova é de quem acusa.
4. "indecidivel" é a resposta honesta quando o artefato necessário não veio. NÃO é derrota: mantém a
   constraint de pé e é preferível a um veredicto inventado nos dois sentidos.
5. Uma constraint escrita com segurança não é prova de nada, e um artefato longo não é evidência.
   Confira o literal você mesmo.
6. Constraint de COERÊNCIA (a mesma regra reafirmada em dois lugares tem de dizer a mesma coisa):
   "violated" exige citar em "evidence" as DUAS ocorrências verbatim, uma após a outra, e dizer em
   que ponto divergem. Uma só citação não prova divergência. E divergência apenas de REDAÇÃO, com a
   mesma substância (mesmo valor, mesmo limite, mesmo literal, mesmo estado), é "satisfied", não
   "violated" — acusar sinônimo é falso positivo e falso positivo aqui não fecha nunca.

Responda APENAS JSON, sem cercas de código:
{"verdicts":[{"constraint_key":"...","status":"satisfied|violated|indecidivel","artifact":"<nome exato do artefato>","evidence":"<citação verbatim do artefato>","why":"<uma frase>"}]}`;

export const WAIVER_SYSTEM = `Você CLASSIFICA pedidos de dispensa (waiver) de constraints de um produto de software.

Existem exatamente duas classes, e a diferença decide se a constraint é dispensada ou continua bloqueando:

- "inapplicable": o motivo argumenta que a constraint NÃO SE APLICA a este produto — o recurso não
  existe neste escopo, o requisito é de outro arquétipo, a premissa da constraint é falsa aqui.
  Esta é a única classe que DISPENSA.
- "postponement": o motivo argumenta prazo, custo, esforço, prioridade, "fica para depois", "não deu
  tempo", "faremos na próxima fase". A constraint continua VÁLIDA e continua bloqueando.

Motivo vazio, genérico ou que não argumenta inaplicabilidade é "postponement". Na dúvida,
"postponement" — dispensar por engano deixa passar falha grave.

Responda APENAS JSON, sem cercas de código:
{"waivers":[{"constraint_key":"...","kind":"inapplicable|postponement","why":"<uma frase>"}]}`;

export const AUDIT_CONSTRAINT_SYSTEM = `Você AUDITA, de forma independente, constraints derivadas de uma especificação por outro modelo.

Sua única pergunta: esta constraint é VERIFICÁVEL como está escrita?

- "verificavel": a afirmação é objetiva e o artefato indicado decidiria se ela foi cumprida.
- "vaga": a afirmação não tem critério objetivo ("boas práticas", "adequado", "performático"), ou o
  artefato indicado não decidiria nada. Uma constraint vaga nunca fecha: ela viraria bloqueio eterno.
- "irrelevante": a afirmação não tem relação com o que a especificação diz.

Você NÃO reescreve a constraint, NÃO propõe nova e NÃO julga o produto. Responda uma linha por chave.

Responda APENAS JSON, sem cercas de código:
{"audits":[{"constraint_key":"...","verdict":"verificavel|vaga|irrelevante","why":"<uma frase>"}]}`;

/**
 * Aceita/recusa cada constraint que o derivador devolveu, e MEDE as recusas.
 *
 * Nada aqui julga mérito: as recusas são todas de TRANSPORTE — chave ilegível, afirmação vazia, sem
 * artefato que a prove, vocabulário fora da lista, e a âncora que não existe literalmente na spec.
 * A última é o Context Integrity aplicado à derivação (Mistral B5): constraint que nasce de trecho
 * fabricado não é rigor, é ruído com aparência de rigor.
 */
export function normalizeConstraints(
  raw: Array<Record<string, unknown>>,
  opts: { specText: string; model: string; previous?: SpecConstraint[]; max?: number },
): { accepted: SpecConstraint[]; rejected: Array<{ key: string; reason: string }> } {
  const accepted: SpecConstraint[] = [];
  const rejected: Array<{ key: string; reason: string }> = [];
  const seen = new Set<string>();
  const prevByKey = new Map((opts.previous ?? []).map((c) => [c.constraintKey, c]));
  const max = opts.max ?? policyGateConfig().maxConstraints;

  for (const r of raw) {
    const key = normalizeKey(r.constraint_key ?? r.constraintKey);
    if (!key) { rejected.push({ key: String(r.constraint_key ?? ""), reason: "chave ilegível" }); continue; }
    if (seen.has(key)) { rejected.push({ key, reason: "chave duplicada na mesma derivação" }); continue; }
    const assertion = String(r.assertion ?? "").trim();
    if (assertion.length < 12) { rejected.push({ key, reason: "afirmação vazia ou curta demais" }); continue; }
    const evidenceHint = String(r.evidence_hint ?? r.evidenceHint ?? "").trim();
    // Regra 2 do prompt em forma de código: constraint sem artefato que a prove seria `indecidivel`
    // eterno — e `indecidivel` eterno é exatamente o GAP-84 (blocker que nenhuma edição fecha).
    if (evidenceHint.length < 8) { rejected.push({ key, reason: "sem evidence_hint: nada a conferir" }); continue; }
    const at = String(r.verifiable_at ?? r.verifiableAt ?? "spec").trim().toLowerCase() as VerifiableAt;
    if (!VERIFIABLE_AT.includes(at)) { rejected.push({ key, reason: `verifiable_at fora do vocabulário: ${at}` }); continue; }
    const anchor = String(r.source_anchor ?? r.sourceAnchor ?? "").trim();
    const anchorVerbatim = evidenceIsVerbatim(anchor, opts.specText);
    if (!anchorVerbatim) { rejected.push({ key, reason: "source_anchor não existe literalmente na spec" }); continue; }
    if (accepted.length >= max) { rejected.push({ key, reason: `teto de ${max} constraints por derivação` }); continue; }

    const sha = assertionSha(assertion);
    const prev = prevByKey.get(key);
    const supersedes = normalizeKey(r.supersedes_key ?? r.supersedesKey) || null;
    // 🔴 Mistral B1: chave reusada com significado NOVO e sem declarar a supersedência. O código não
    // decide se mudou "de verdade" (isso seria julgar conteúdo) — ele DECLARA que o sha mudou e a
    // troca não foi anunciada. O juiz lê isso como fato.
    const drift = !!prev && prev.assertionSha !== sha && !supersedes;
    seen.add(key);
    accepted.push({
      constraintKey: key,
      appliesTo: String(r.applies_to ?? r.appliesTo ?? "").trim().slice(0, 300),
      assertion: assertion.slice(0, 2_000),
      assertionSha: sha,
      evidenceHint: evidenceHint.slice(0, 1_000),
      verifiableAt: at,
      severity: String(r.severity ?? "warning").trim().toLowerCase() === "blocker" ? "blocker" : "warning",
      sourceAnchor: anchor.slice(0, 1_000),
      anchorVerbatim,
      supersededByKey: supersedes,
      drift,
      declaredByModel: opts.model,
    });
  }
  return { accepted, rejected };
}

/**
 * Bloco de waiver ANCORADO na spec. Formato exigido (o código confere; o agente classifica o motivo):
 *
 *     ### WAIVER DE POLICY: <constraint-key>
 *     <motivo, em prosa>
 *
 * Por que ancorado e não uma tabela no banco: a dispensa passa a ser parte do CONTRATO que o humano
 * lê e que o cross-family audita. Waiver que vive só no banco é decisão invisível.
 */
export function parseWaivers(specText: string): Array<{ constraintKey: string; reason: string }> {
  const out: Array<{ constraintKey: string; reason: string }> = [];
  const re = /^(#{2,6})\s*WAIVER\s+DE\s+POLICY\s*:\s*(.+?)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(specText)) !== null) {
    const key = normalizeKey(m[2]);
    if (!key) continue;
    const start = m.index + m[0].length;
    const rest = specText.slice(start);
    const next = rest.search(/^#{1,6}\s/m);
    const reason = (next >= 0 ? rest.slice(0, next) : rest).trim();
    out.push({ constraintKey: key, reason: reason.slice(0, 2_000) });
  }
  return out;
}

/**
 * Casa veredictos com constraints e MEDE a cobertura (Mistral B4).
 *
 * As três degradações, todas para o lado que mantém a crítica de pé:
 *  - chave que ninguém pediu ⇒ DESCARTADA e contada (`unknownKeys`): veredicto sobre constraint
 *    inexistente é alucinação, e contá-la como cobertura inflaria o denominador;
 *  - constraint sem veredicto ⇒ `indecidivel/not_judged` — jamais ausente em silêncio (GAP-17/18);
 *  - `satisfied` cuja citação não aparece LITERALMENTE no artefato nomeado ⇒
 *    `indecidivel/evidence_not_found`. `violated` sem artefato ⇒ descartado, `no_artifact`.
 *
 * `pending` vem antes de tudo: constraint de `build`/`runtime` não é julgável na Bancada, e forçá-la
 * a um veredicto produziria número falso nos DOIS sentidos (Mistral B2).
 */
export function normalizeVerdicts(
  raw: Array<Record<string, unknown>>,
  constraints: SpecConstraint[],
  artifacts: Array<{ name: string; content: string }>,
): { verdicts: PolicyVerdict[]; unknownKeys: string[]; judged: number } {
  const byName = new Map(artifacts.map((a) => [a.name.toLowerCase(), a.content]));
  const byKey = new Map<string, Record<string, unknown>>();
  const unknownKeys: string[] = [];
  const valid = new Set(constraints.map((c) => c.constraintKey));
  for (const r of raw) {
    const k = normalizeKey(r.constraint_key ?? r.constraintKey);
    if (!k) continue;
    if (!valid.has(k)) { unknownKeys.push(k); continue; }
    if (!byKey.has(k)) byKey.set(k, r);
  }

  const verdicts: PolicyVerdict[] = [];
  let judged = 0;
  for (const c of constraints) {
    const base = {
      constraintKey: c.constraintKey, evidence: "", evidenceVerbatim: false, artifact: "",
      reason: "", waiverKind: "" as WaiverKind, auditVerdict: "" as ConstraintAudit, blocking: false,
    };
    if (c.verifiableAt !== "spec") {
      verdicts.push({ ...base, status: "pending", reason: `verificável só em ${c.verifiableAt}` });
      continue;
    }
    const r = byKey.get(c.constraintKey);
    if (!r) { verdicts.push({ ...base, status: "indecidivel", reason: "not_judged" }); continue; }

    judged++;
    const artifact = String(r.artifact ?? "").trim();
    const evidence = String(r.evidence ?? "").slice(0, 2_000);
    const content = byName.get(artifact.toLowerCase()) ?? "";
    const verbatim = !!content && evidenceIsVerbatim(evidence, content);
    const status = String(r.status ?? "").trim().toLowerCase();

    if (status === "satisfied") {
      if (!verbatim) {
        verdicts.push({ ...base, status: "indecidivel", artifact, evidence,
                        reason: content ? "evidence_not_found" : "artifact_not_found" });
        continue;
      }
      verdicts.push({ ...base, status: "satisfied", artifact, evidence, evidenceVerbatim: true });
      continue;
    }
    if (status === "violated") {
      if (!content) {
        verdicts.push({ ...base, status: "indecidivel", artifact, evidence, reason: "no_artifact" });
        continue;
      }
      verdicts.push({ ...base, status: "violated", artifact, evidence, evidenceVerbatim: verbatim,
                      blocking: true });
      continue;
    }
    verdicts.push({ ...base, status: "indecidivel", artifact, evidence,
                    reason: status && status !== "indecidivel" ? `status desconhecido: ${status}` : "" });
  }
  return { verdicts, unknownKeys, judged };
}

/**
 * Aplica os waivers CLASSIFICADOS e o parecer cross-family sobre cada constraint.
 *
 * As duas pernas do equilíbrio do Jean, uma em cada linha:
 *  • contra deixar passar — só `inapplicable` dispensa. `postponement` (*"não deu tempo"*) mantém
 *    `violated` e mantém `blocking` (Mistral B3);
 *  • contra o loop infinito — constraint que a OUTRA família chama de `vaga` perde o poder de
 *    BLOQUEAR, e a linha continua gravada. Uma constraint sem critério objetivo nunca fecha: é o
 *    GAP eterno do GAP-84 vestido de constraint. Apagar a linha seria anistia; tirar o bloqueio e
 *    declarar é medida.
 */
export function applyPolicyDecisions(
  verdicts: PolicyVerdict[],
  opts: {
    waivers?: Array<{ constraintKey: string; kind: WaiverKind }>;
    audits?: Array<{ constraintKey: string; verdict: ConstraintAudit }>;
    /** Artefatos que o juiz NUNCA viu por inteiro (recortados ou fora dos lotes que rodaram). */
    partialArtifacts?: string[];
    /** Algum passe do juiz falhou ⇒ a acusação não teve chance contra a spec toda. */
    coverageIncomplete?: boolean;
  },
): PolicyVerdict[] {
  const waiverByKey = new Map((opts.waivers ?? []).map((w) => [w.constraintKey, w.kind]));
  const auditByKey = new Map((opts.audits ?? []).map((a) => [a.constraintKey, a.verdict]));
  const parcial = new Set((opts.partialArtifacts ?? []).map((n) => n.toLowerCase()));
  return verdicts.map((v) => {
    const out = { ...v, auditVerdict: auditByKey.get(v.constraintKey) ?? "" as ConstraintAudit };
    const kind = waiverByKey.get(v.constraintKey) ?? "";
    if (kind) out.waiverKind = kind;
    if (out.status === "violated" && kind === "inapplicable") {
      return { ...out, status: "waived" as PolicyStatus, blocking: false, reason: "waiver_inapplicable" };
    }
    if (out.status === "violated" && (out.auditVerdict === "vaga" || out.auditVerdict === "irrelevante")) {
      return { ...out, blocking: false, reason: `cross_family_${out.auditVerdict}` };
    }
    // 🔴 Teto estrutural do GAP-54/61 aplicado ao gate: acusar um artefato que o juiz leu pela metade,
    // ou parar de bloquear porque um passe caiu, é acusação sem chance de defesa. A violação FICA
    // registrada (não é anistia) — só perde o poder de barrar a promoção. O gate degrada para o
    // comportamento antigo, que é a única direção segura, porque ele só existe para ACRESCENTAR.
    if (out.status === "violated" && parcial.has(out.artifact.toLowerCase())) {
      return { ...out, blocking: false, reason: "artifact_partial" };
    }
    if (out.status === "violated" && opts.coverageIncomplete) {
      return { ...out, blocking: false, reason: "judge_coverage_incomplete" };
    }
    return out;
  });
}

export interface PolicyTally {
  total: number;
  satisfied: number;
  violated: number;
  indecidivel: number;
  pending: number;
  waived: number;
  /** As violações que de fato impedem promover — a única conta que muda decisão. */
  blocking: number;
  /** Constraints de `spec` que receberam veredicto, sobre as de `spec` que existem (GAP-17/18). */
  judged: number;
  judgeable: number;
  notJudged: number;
  evidenceNotFound: number;
  postponements: number;
  vagas: number;
  drift: number;
  /** Violações sem poder de bloquear porque o juiz não leu o artefato por inteiro (teto GAP-54/61). */
  artifactPartial: number;
}

/** A contabilidade tem de poder CAIR — métrica que dá 100% por construção é o GAP-42/43. */
export function policyTally(verdicts: PolicyVerdict[], constraints: SpecConstraint[] = []): PolicyTally {
  const t: PolicyTally = {
    total: verdicts.length, satisfied: 0, violated: 0, indecidivel: 0, pending: 0, waived: 0,
    blocking: 0, judged: 0, judgeable: 0, notJudged: 0, evidenceNotFound: 0, postponements: 0,
    vagas: 0, drift: constraints.filter((c) => c.drift).length, artifactPartial: 0,
  };
  for (const v of verdicts) {
    if (v.status === "satisfied") t.satisfied++;
    else if (v.status === "violated") t.violated++;
    else if (v.status === "pending") t.pending++;
    else if (v.status === "waived") t.waived++;
    else t.indecidivel++;
    if (v.status !== "pending") t.judgeable++;
    if (v.status !== "pending" && v.reason !== "not_judged") t.judged++;
    if (v.reason === "not_judged") t.notJudged++;
    if (v.reason === "evidence_not_found" || v.reason === "artifact_not_found") t.evidenceNotFound++;
    if (v.waiverKind === "postponement") t.postponements++;
    if (v.auditVerdict === "vaga" || v.auditVerdict === "irrelevante") t.vagas++;
    if (v.reason === "artifact_partial" || v.reason === "judge_coverage_incomplete") t.artifactPartial++;
    if (v.blocking) t.blocking++;
  }
  return t;
}

/**
 * A linha em prosa que vai ao log e ao juiz. Diz os números que podem CAIR, inclusive os incômodos.
 *
 * Cobertura vem primeiro porque é a premissa: um gate que julgou 3 de 20 constraints não é um gate
 * verde, é um gate cego — e foi assim que o Estágio B do GAP-13 passou por progresso.
 */
export function policyNote(t: PolicyTally): string {
  const partes = [
    `${t.judged}/${t.judgeable} constraint(s) julgada(s) na spec`,
    `${t.satisfied} cumprida(s)`,
    `${t.blocking} violação(ões) impeditiva(s)`,
  ];
  if (t.violated > t.blocking) partes.push(`${t.violated - t.blocking} violação(ões) sem poder de bloquear`);
  // 🔴 GAP-89 — MEDIDO na 1ª prova do oráculo: o juiz da execução real devolveu **12 de 12
  // `indecidivel`** (resposta CORRETA: nenhum teste da suíte tocava aquelas constraints). Só que
  // `indecidivel` não aparecia nesta nota e `pending` desaparecia ao ser substituído — a nota ia de
  // "0/0 julgadas, 119 pendentes" para "119/119 julgadas, 0 violações impeditivas".
  //
  // Isso é anistia: quem lê a nota é o JUIZ DE PROMOVIBILIDADE (specAutonomy.ts), e ele veria
  // cobertura total com zero informação ganha. Medir e não decidir é um resultado — e tem de ser dito
  // com o nome que tem, senão o oráculo "destrava" a spec sem ter verificado nada.
  if (t.indecidivel) partes.push(`${t.indecidivel} sem decisão possível com a prova disponível`);
  if (t.pending) partes.push(`${t.pending} pendente(s) de build/runtime`);
  if (t.notJudged) partes.push(`${t.notJudged} sem veredicto`);
  if (t.evidenceNotFound) partes.push(`${t.evidenceNotFound} com evidência não conferida`);
  if (t.waived) partes.push(`${t.waived} dispensada(s) por inaplicabilidade`);
  if (t.postponements) partes.push(`${t.postponements} pedido(s) de adiamento RECUSADO(s)`);
  if (t.vagas) partes.push(`${t.vagas} declarada(s) vaga(s) pela outra família`);
  if (t.drift) partes.push(`${t.drift} com significado trocado sem declarar`);
  // Sem esta linha, "0 violação impeditiva" e "o juiz leu metade do arquivo" ficariam indistinguíveis.
  if (t.artifactPartial) partes.push(`${t.artifactPartial} acusação(ões) sem poder de barrar porque o juiz não leu o artefato por inteiro`);
  return partes.join(", ");
}

// ── persistência e orquestração ───────────────────────────────────────────────────────────────

export async function loadConstraints(
  db: Db, projectId: string, specHash: string, archHash: string,
): Promise<SpecConstraint[]> {
  const rows = (await db.query(
    `SELECT constraint_key, applies_to, assertion, assertion_sha, evidence_hint, verifiable_at,
            severity, source_anchor, anchor_verbatim, superseded_by_key, drift, declared_by_model
       FROM spec_constraints
      WHERE project_id = $1 AND spec_hash = $2 AND archetype_hash = $3
      ORDER BY created_at ASC`,
    [projectId, specHash, archHash],
  )).rows as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    constraintKey: String(r.constraint_key), appliesTo: String(r.applies_to ?? ""),
    assertion: String(r.assertion), assertionSha: String(r.assertion_sha ?? ""),
    evidenceHint: String(r.evidence_hint ?? ""), verifiableAt: String(r.verifiable_at ?? "spec") as VerifiableAt,
    severity: String(r.severity ?? "warning"), sourceAnchor: String(r.source_anchor ?? ""),
    anchorVerbatim: r.anchor_verbatim === true, supersededByKey: (r.superseded_by_key as string) ?? null,
    drift: r.drift === true, declaredByModel: String(r.declared_by_model ?? ""),
  }));
}

/** Chaves já conhecidas do projeto — a lista que o derivador recebe para REUSAR identidade (B1). */
export async function knownConstraints(db: Db, projectId: string): Promise<SpecConstraint[]> {
  const rows = (await db.query(
    `SELECT DISTINCT ON (constraint_key) constraint_key, assertion, assertion_sha
       FROM spec_constraints WHERE project_id = $1
      ORDER BY constraint_key, created_at DESC`,
    [projectId],
  )).rows as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    constraintKey: String(r.constraint_key), assertion: String(r.assertion),
    assertionSha: String(r.assertion_sha ?? ""), appliesTo: "", evidenceHint: "",
    verifiableAt: "spec" as VerifiableAt, severity: "warning", sourceAnchor: "",
    anchorVerbatim: false, supersededByKey: null, drift: false, declaredByModel: "",
  }));
}

export async function persistConstraints(
  db: Db, projectId: string, specHash: string, archHash: string, list: SpecConstraint[],
): Promise<number> {
  let n = 0;
  for (const c of list) {
    try {
      await db.query(
        `INSERT INTO spec_constraints
           (project_id, spec_hash, archetype_hash, constraint_key, applies_to, assertion,
            assertion_sha, evidence_hint, verifiable_at, severity, source_anchor, anchor_verbatim,
            superseded_by_key, drift, declared_by_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (project_id, spec_hash, archetype_hash, constraint_key) DO UPDATE SET
           applies_to = EXCLUDED.applies_to, assertion = EXCLUDED.assertion,
           assertion_sha = EXCLUDED.assertion_sha, evidence_hint = EXCLUDED.evidence_hint,
           verifiable_at = EXCLUDED.verifiable_at, severity = EXCLUDED.severity,
           source_anchor = EXCLUDED.source_anchor, anchor_verbatim = EXCLUDED.anchor_verbatim,
           superseded_by_key = EXCLUDED.superseded_by_key, drift = EXCLUDED.drift,
           declared_by_model = EXCLUDED.declared_by_model`,
        [projectId, specHash, archHash, c.constraintKey, c.appliesTo, c.assertion, c.assertionSha,
         c.evidenceHint, c.verifiableAt, c.severity, c.sourceAnchor, c.anchorVerbatim,
         c.supersededByKey, c.drift, c.declaredByModel],
      );
      n++;
    } catch (err) {
      // Persistir é ACESSÓRIO ao laço: nunca derruba a validação que produziu a derivação.
      console.warn(`[specPolicyGate] persistência de constraint falhou (${c.constraintKey}): ${String(err)}`);
    }
  }
  return n;
}

export async function persistVerdicts(
  db: Db, args: {
    projectId: string; specHash: string; model: string;
    autonomyRunId?: string | null; validationRunId?: string | null; verdicts: PolicyVerdict[];
  },
): Promise<number> {
  let n = 0;
  for (const v of args.verdicts) {
    try {
      await db.query(
        `INSERT INTO spec_policy_verdicts
           (project_id, spec_hash, constraint_key, status, evidence, evidence_verbatim, artifact,
            reason, waiver_kind, audit_verdict, blocking, model, autonomy_run_id, validation_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (project_id, spec_hash, constraint_key, model) DO UPDATE SET
           status = EXCLUDED.status, evidence = EXCLUDED.evidence,
           evidence_verbatim = EXCLUDED.evidence_verbatim, artifact = EXCLUDED.artifact,
           reason = EXCLUDED.reason, waiver_kind = EXCLUDED.waiver_kind,
           audit_verdict = EXCLUDED.audit_verdict, blocking = EXCLUDED.blocking,
           autonomy_run_id = EXCLUDED.autonomy_run_id, validation_run_id = EXCLUDED.validation_run_id,
           created_at = now()`,
        [args.projectId, args.specHash, v.constraintKey, v.status, v.evidence, v.evidenceVerbatim,
         v.artifact, v.reason, v.waiverKind, v.auditVerdict, v.blocking, args.model,
         args.autonomyRunId ?? null, args.validationRunId ?? null],
      );
      n++;
    } catch (err) {
      console.warn(`[specPolicyGate] persistência de veredicto falhou (${v.constraintKey}): ${String(err)}`);
    }
  }
  return n;
}

/**
 * Uma chamada ao agente. Parecer CORTADO é parecer sem conclusão ⇒ falha (família T1/T2).
 *
 * Devolve SEMPRE o motivo da falha. "Indisponível" sem motivo é a família do GAP-45/46 (log
 * mentiroso): rede caída, 400 por prompt grande e parecer truncado exigem correções OPOSTAS, e um
 * `null` mudo faz as três parecerem a mesma coisa. Foi exatamente o que custou uma prova em prod.
 */
export type PolicyAgentOutcome =
  // `model` é a frase para humano ("usado (pedido X)"); `modelUsedRaw` é o id NU do modelo que de fato
  // respondeu. GAP-98: quem afirma "outra família" precisa comparar com o que RODOU, não com o pedido —
  // um pedido silenciosamente ignorado é exatamente como a garantia cross-family se perde sem aviso.
  | { ok: true; text: string; model: string; modelUsedRaw: string }
  | { ok: false; why: string };

/**
 * GAP-88 — QUEM julgou, medido em prod: 157 de 157 veredictos gravados com `model='desconhecido'`
 * e 199 constraints com `declared_by_model` vazio.
 *
 * Duas causas, ambas nesta função:
 *
 *  1. o `/invoke/raw` publica **`model_used`** (e `model_requested`); esta camada lia `data.model`,
 *     campo que o endpoint nunca teve. Todo o resto da api já lia `model_used` — só o Policy Gate não.
 *  2. quando o chamador pedia um modelo, gravava-se o **pedido** e não o usado. Foi exatamente o caso
 *     da primeira prova do oráculo: `opus-4-8` deu 403, a cascata caiu para `sonnet-4-6` e o veredicto
 *     não registrou nada disso.
 *
 * Por que importa além da estética: o índice único é `(project_id, spec_hash, constraint_key, model)`.
 * É ele que deixa o juiz de spec e o oráculo coexistirem na mesma linha de constraint. Com todo mundo
 * gravando `desconhecido`, um segundo juiz (o revisor cross-family) **sobrescreveria** o primeiro em
 * vez de somar — a medição que a frente cross-family existe para fazer morreria calada.
 *
 * O fallback é DECLARADO no próprio valor (`usado (pedido X)`): rebaixar de família é fato de
 * auditoria, não detalhe de infra.
 */
export function agentModelUsed(
  data: { model_used?: string; model_requested?: string; model?: string },
  requested?: string,
): string {
  const usado = String(data.model_used ?? data.model ?? "").trim();
  const pedido = String(data.model_requested ?? requested ?? "").trim();
  if (!usado) return pedido || "desconhecido";
  if (pedido && pedido !== usado) return `${usado} (pedido ${pedido})`;
  return usado;
}

export async function callPolicyAgent(args: {
  system: string; user: string; maxTokens?: number; modelId?: string;
  llm?: Record<string, unknown> | null;
}): Promise<PolicyAgentOutcome> {
  const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim().replace(/\/$/, "");
  if (!agentsUrl) return { ok: false, why: "API_AGENTS_URL vazia" };
  const cfg = policyGateConfig();
  const budget = args.maxTokens ?? cfg.maxTokens;
  try {
    const { httpPost } = await import("../routes/specs.js");
    const body = await httpPost(`${agentsUrl}/invoke/raw`, JSON.stringify({
      prompt_override: args.system,
      user_message: args.user,
      max_tokens: budget,
      temperature: 0,
      ...(args.llm ?? {}),
      // GAP-98: `model_id` EXPLÍCITO vence o do tenant, e por isso vem DEPOIS do spread de `llm`.
      // Medido em prod (F4, 2026-09-08): com a ordem invertida, o casador pedido em outra família
      // (`amazon.nova-pro-v1:0`) rodava em `us.anthropic.claude-opus-5` — o modelo do PRÓPRIO juiz.
      // A medição virava auto-revisão (que a pesquisa mede como ZERO ganho) sem nada avisar. O
      // `llm_config` do tenant continua valendo: só o modelo é trocado, não as credenciais.
      ...(args.modelId ? { model_id: args.modelId } : {}),
    }), agentDeadlineMs(budget, cfg));
    const data = JSON.parse(body) as {
      response?: string; truncated?: boolean; model?: string;
      model_used?: string; model_requested?: string;
    };
    if (data.truncated === true) {
      const why = `parecer CORTADO em ${budget} tokens de saída (prompt ${args.user.length} chars)`;
      console.warn(`[specPolicyGate] ${why}`);
      return { ok: false, why };
    }
    const text = data.response ?? "";
    if (!text.trim()) return { ok: false, why: `resposta vazia (prompt ${args.user.length} chars)` };
    return {
      ok: true, text, model: agentModelUsed(data, args.modelId),
      modelUsedRaw: String(data.model_used ?? data.model ?? "").trim(),
    };
  } catch (err) {
    const why = `chamada falhou: ${String(err).slice(0, 200)} (prompt ${args.user.length} chars, `
      + `orçamento ${budget} tokens, prazo ${Math.round(agentDeadlineMs(budget, cfg) / 1000)}s)`;
    console.warn(`[specPolicyGate] ${why}`);
    return { ok: false, why };
  }
}

export interface PolicyGateResult {
  ran: boolean;
  reason?: string;
  constraints: SpecConstraint[];
  rejected: Array<{ key: string; reason: string }>;
  verdicts: PolicyVerdict[];
  tally: PolicyTally;
  unknownKeys: string[];
  model: string;
  derived: number;
  /** Passes do juiz que rodaram / falharam, e o que ele nunca leu por inteiro. Fatos do log. */
  judgePasses: number;
  passesFailed: number;
  /** Passes de DERIVAÇÃO que rodaram / falharam. `0` com constraints = derivação veio do banco. */
  derivePasses: number;
  derivePassesFailed: number;
  partialArtifacts: string[];
  /**
   * F3: quantas constraints `pending` (build/runtime) saíram do limbo porque a EXECUÇÃO REAL do
   * produto no executor isolado já as decidiu. `0` significa que ninguém rodou o produto ainda —
   * e a spec do NVX LastMile tem 119 constraints das quais 119 são exatamente destas.
   */
  oracleApplied: number;
  /**
   * Quantas constraints o DERIVADOR declarou que a spec ainda sustenta além das que ele devolveu
   * (soma dos passes; ver regra 8 do `DERIVE_SYSTEM`). É a declaração do agente sobre o tamanho do
   * seu próprio corte — o teto de orçamento passa a aparecer no relatório em vez de desaparecer.
   * `0` = ele declarou que devolveu tudo. Aqui `0` e "não declarou" são a MESMA coisa de propósito:
   * o número é advisory, não porta; quem declara ou não é o agente, e `declaredNeededMissing` conta
   * os passes que ficaram calados.
   */
  declaredNeeded: number;
  declaredNeededMissing: number;
}

const inflight = new Map<string, Promise<PolicyGateResult>>();

/**
 * O gate completo: deriva (uma vez por spec+arquétipo), julga, classifica waivers, audita
 * cross-family e persiste. Devolve SEMPRE a contabilidade — inclusive quando não roda, e aí com
 * `reason`, nunca em silêncio.
 *
 * Idempotência por `(projectId, specHash, archetypeHash)`: a derivação é a chamada caro, e uma spec
 * inalterada não pode gastá-la duas vezes. O julgamento é refeito porque os ARTEFATOS mudam.
 */
export async function runPolicyGate(db: Db, args: {
  projectId: string;
  specHash: string;
  archetype?: Pick<Archetype, "id" | "checklist"> | null;
  /** Artefatos conferíveis. Na Bancada são os ARQUIVOS DA SPEC — o produto ainda não existe (B2). */
  artifacts: Array<{ name: string; content: string }>;
  autonomyRunId?: string | null;
  validationRunId?: string | null;
  llm?: Record<string, unknown> | null;
}): Promise<PolicyGateResult> {
  const empty = (reason: string, extra: Partial<PolicyGateResult> = {}): PolicyGateResult => ({
    ran: false, reason, constraints: [], rejected: [], verdicts: [],
    tally: policyTally([]), unknownKeys: [], model: "", derived: 0,
    judgePasses: 0, passesFailed: 0, derivePasses: 0, derivePassesFailed: 0,
    partialArtifacts: [], oracleApplied: 0, declaredNeeded: 0, declaredNeededMissing: 0, ...extra,
  });
  if (!policyGateEnabled()) return empty("SPEC_POLICY_GATE != on");
  if (!args.specHash) return empty("spec sem hash");
  if (args.artifacts.length === 0) return empty("nenhum artefato conferível");

  const archHash = archetypeHash(args.archetype);
  const memo = `${args.projectId}:${args.specHash}:${archHash}`;
  const running = inflight.get(memo);
  if (running) return running;
  const p = policyGateOnce(db, args, archHash).finally(() => inflight.delete(memo));
  inflight.set(memo, p);
  return p;
}

async function policyGateOnce(
  db: Db,
  args: Parameters<typeof runPolicyGate>[1],
  archHash: string,
): Promise<PolicyGateResult> {
  const cfg = policyGateConfig();
  const specText = args.artifacts.map((a) => `--- ${a.name} ---\n${a.content}`).join("\n\n");
  const empty = (reason: string, extra: Partial<PolicyGateResult> = {}): PolicyGateResult => ({
    ran: false, reason, constraints: [], rejected: [], verdicts: [],
    tally: policyTally([]), unknownKeys: [], model: "", derived: 0,
    judgePasses: 0, passesFailed: 0, derivePasses: 0, derivePassesFailed: 0,
    partialArtifacts: [], oracleApplied: 0, declaredNeeded: 0, declaredNeededMissing: 0, ...extra,
  });

  // ── 1. derivação (idempotente por spec+arquétipo) ──────────────────────────
  let constraints = await loadConstraints(db, args.projectId, args.specHash, archHash).catch(() => []);
  let rejected: Array<{ key: string; reason: string }> = [];
  let model = constraints[0]?.declaredByModel ?? "";
  let derived = 0;
  let derivePasses = 0;
  let derivePassesFailed = 0;
  // A DECLARAÇÃO do agente sobre o próprio corte (regra 8 do `DERIVE_SYSTEM`). Advisory: não abre
  // nem fecha porta nenhuma — existe para o teto de orçamento aparecer no relatório.
  let declaredNeeded = 0;
  let declaredNeededMissing = 0;
  const deriveWhy: string[] = [];
  if (constraints.length === 0) {
    const conhecidas = await knownConstraints(db, args.projectId).catch(() => []);
    const seed = (args.archetype?.checklist ?? []).map((c) => `- ${c}`).join("\n");
    // 🔴 MEDIDO EM PROD: com UMA chamada o derivador recebia `specText.slice(0, 120_000)` — 12% de
    // uma spec de 1,07M chars. Ele declarava constraint só do que viu e, pior, NÃO conseguia ver a
    // classe de coerência interna (a mesma regra reafirmada em outro arquivo), porque nunca recebia
    // dois arquivos INTEIROS. É o teto do GAP-54/61 na DERIVAÇÃO: o gate declarava política para um
    // oitavo da spec e chamava isso de política da spec.
    const { batches, partial, dropped } = batchArtifacts(args.artifacts, cfg.specChars, cfg.maxDerivePasses);
    const acumuladas: SpecConstraint[] = [];
    const recusadas: Array<{ key: string; reason: string }> = [];
    for (const [i, lote] of batches.entries()) {
      const restante = cfg.maxConstraintsTotal - acumuladas.length;
      if (restante <= 0) {
        deriveWhy.push(`passe ${i + 1}: teto global de ${cfg.maxConstraintsTotal} constraints já atingido`);
        break;
      }
      const loteTexto = lote
        .map((a) => `--- ${a.name}${a.cutFrom ? ` (RECORTADO: ${cfg.specChars} de ${a.cutFrom} chars)` : ""} ---\n${a.content}`)
        .join("\n\n");
      // As chaves já aceitas nos passes anteriores entram como "existentes": é assim que a MESMA
      // constraint vista em dois lotes reusa a chave em vez de virar duas identidades (GAP-49/50).
      const previous = [...conhecidas, ...acumuladas];
      const user = [
        batches.length > 1
          ? `LOTE ${i + 1} de ${batches.length} dos arquivos da especificação. Declare constraint APENAS do que está neste lote — o trecho ancorado tem de existir no texto abaixo. Os outros lotes são derivados em passes próprios.`
          : "ESPECIFICAÇÃO (verbatim, arquivo por arquivo):",
        "<<<INICIO>>>",
        loteTexto,
        "<<<FIM>>>",
        "",
        seed ? `SEMENTE — checklist do arquétipo "${args.archetype?.id}" (adote, reescreva ou descarte):\n${seed}` : "",
        "",
        previous.length
          ? `CHAVES JÁ EXISTENTES neste projeto (REUSE a chave quando a constraint for a MESMA):\n${previous.map((c) => `- ${c.constraintKey}: ${c.assertion.slice(0, 200)}`).join("\n")}`
          : "",
        "",
        `Derive as constraints verificáveis destes arquivos (no máximo ${Math.min(cfg.maxConstraints, restante)}).`,
      ].filter(Boolean).join("\n");

      derivePasses++;
      const res = await callPolicyAgent({ system: DERIVE_SYSTEM, user, maxTokens: cfg.deriveTokens, llm: args.llm });
      if (!res.ok) { derivePassesFailed++; deriveWhy.push(`passe ${i + 1}: ${res.why}`); continue; }
      const raw = parseListResponse(res.text, "constraints");
      if (!raw) { derivePassesFailed++; deriveWhy.push(`passe ${i + 1}: sem JSON legível`); continue; }
      const faltam = parseCountField(res.text, "constraints_needed");
      if (faltam === null) declaredNeededMissing++; else declaredNeeded += faltam;
      // A âncora é conferida contra o LOTE, não contra a spec inteira: citar trecho de arquivo que
      // este passe não recebeu é exatamente a alucinação que o guard existe para pegar.
      const norm = normalizeConstraints(raw, {
        specText: loteTexto, model: res.model, previous,
        max: Math.min(cfg.maxConstraints, restante),
      });
      acumuladas.push(...norm.accepted);
      recusadas.push(...norm.rejected);
      if (norm.accepted.length > 0) model = res.model;
    }
    if (acumuladas.length === 0) {
      const motivo = derivePassesFailed >= derivePasses && derivePasses > 0
        ? `derivador indisponível em ${derivePassesFailed} de ${derivePasses} passe(s) — ${deriveWhy.join(" | ")}`
        : `nenhuma constraint aceita na derivação (${derivePasses} passe(s))`;
      return empty(motivo, { rejected: recusadas, derivePasses, derivePassesFailed,
        partialArtifacts: [...partial, ...dropped], declaredNeeded, declaredNeededMissing });
    }
    constraints = acumuladas;
    rejected = recusadas;
    derived = await persistConstraints(db, args.projectId, args.specHash, archHash, constraints);
    if (deriveWhy.length) console.warn(`[specPolicyGate] derivação parcial: ${deriveWhy.join(" | ")}`);
    // O teto de orçamento deixa de ser invisível: o agente diz quantas ficaram de fora, e isso vai
    // ao log e ao resultado. Continua sendo decisão do Jean subir o teto — o número é a evidência.
    if (declaredNeeded > 0 || declaredNeededMissing > 0) {
      console.warn(
        `[specPolicyGate] o derivador declarou ${declaredNeeded} constraint(s) que a spec ainda sustenta ` +
        `além das ${constraints.length} devolvidas (teto por passe ${cfg.maxConstraints}, teto global ` +
        `${cfg.maxConstraintsTotal}); ${declaredNeededMissing} de ${derivePasses} passe(s) não declararam`,
      );
    }
  }

  // ── 2. veredicto por constraint (só as de `spec` são julgáveis aqui) ───────
  const judgeable = constraints.filter((c) => c.verifiableAt === "spec");
  let verdictRaw: Array<Record<string, unknown>> = [];
  let judgeModel = model;
  // 🔴 N passes por LOTE de artefato: a spec inteira não cabe numa chamada (1,07M chars ≈ 275k tokens
  // no NVX). Numa só chamada o gate viveria `ran: false` para sempre nas specs grandes — o mesmo teto
  // estrutural do GAP-54/61, e igualmente invisível.
  const { batches, partial, dropped } = batchArtifacts(args.artifacts, cfg.artifactChars, cfg.maxJudgePasses);
  let passesFailed = 0;
  const passWhy: string[] = [];
  if (judgeable.length > 0) {
    const lista = judgeable.map((c) => `- ${c.constraintKey}: ${c.assertion} [prova esperada: ${c.evidenceHint}]`);
    for (const [i, lote] of batches.entries()) {
      const user = [
        batches.length > 1
          ? `LOTE ${i + 1} de ${batches.length} dos artefatos entregues. Julgue com o que está AQUI: se a prova de uma constraint estaria em artefato que não veio neste lote, responda "indecidivel" — outro lote a verificará.`
          : "ARTEFATOS ENTREGUES (verbatim):",
        ...lote.map((a) => `\n=== ARTEFATO: ${a.name}${a.cutFrom ? ` (RECORTADO: ${cfg.artifactChars} de ${a.cutFrom} chars)` : ""} ===\n${a.content}`),
        "",
        "CONSTRAINTS A VERIFICAR (uma linha de resposta para CADA constraint_key):",
        ...lista,
        "",
        "Verifique cada constraint contra os artefatos acima.",
      ].join("\n");
      const res = await callPolicyAgent({ system: VERDICT_SYSTEM, user, maxTokens: cfg.verdictTokens, llm: args.llm });
      if (!res.ok) { passesFailed++; passWhy.push(`lote ${i + 1}: ${res.why}`); continue; }
      const raw = parseListResponse(res.text, "verdicts");
      if (!raw || raw.length === 0) {
        passesFailed++; passWhy.push(`lote ${i + 1}: parecer sem JSON legível`); continue;
      }
      verdictRaw.push(...raw);
      judgeModel = res.model || judgeModel;
    }
    // Sem NENHUM passe o gate não roda: inventar "satisfeito" seria anistia silenciosa e inventar
    // "violado" seria o GAP eterno. Fail-CLOSED devolve o laço ao caminho antigo, mais estrito.
    if (verdictRaw.length === 0) {
      return empty(
        `juiz de policy indisponível (${passesFailed} de ${batches.length} passe(s) falharam) — ${passWhy.join(" | ")}`,
        { constraints, rejected, judgePasses: batches.length, passesFailed, derivePasses,
          derivePassesFailed, partialArtifacts: [...partial, ...dropped] },
      );
    }
    verdictRaw = pickBestRaw(verdictRaw, args.artifacts);
  }
  const { verdicts: base0, unknownKeys, judged } = normalizeVerdicts(verdictRaw, constraints, args.artifacts);
  // Tudo que o juiz não pôde ler por inteiro perde poder de BLOQUEAR — e é nomeado no log.
  const naoLidos = [...partial, ...dropped];
  const base = applyPolicyDecisions(base0, { partialArtifacts: naoLidos, coverageIncomplete: passesFailed > 0 });

  // ── 3. waivers ancorados na spec, CLASSIFICADOS por agente ────────────────
  const pedidos = parseWaivers(specText).filter((w) => constraints.some((c) => c.constraintKey === w.constraintKey));
  let waivers: Array<{ constraintKey: string; kind: WaiverKind }> = [];
  if (pedidos.length > 0) {
    const res = await callPolicyAgent({
      system: WAIVER_SYSTEM,
      user: pedidos.map((w) => `- ${w.constraintKey}: ${w.reason}`).join("\n"),
      maxTokens: 1_500, llm: args.llm,
    });
    const raw = res.ok ? parseListResponse(res.text, "waivers") ?? [] : [];
    // Waiver que o classificador não conseguiu ler NÃO dispensa: `postponement` é o lado seguro.
    const kindByKey = new Map(raw.map((r) => [normalizeKey(r.constraint_key ?? r.constraintKey),
      String(r.kind ?? "").trim().toLowerCase() === "inapplicable" ? "inapplicable" : "postponement"] as [string, WaiverKind]));
    waivers = pedidos.map((w) => ({ constraintKey: w.constraintKey, kind: kindByKey.get(w.constraintKey) ?? "postponement" }));
  }

  // ── 4. auditoria CROSS-FAMILY da própria constraint (Mistral B5) ───────────
  let audits: Array<{ constraintKey: string; verdict: ConstraintAudit }> = [];
  const acusadas = base.filter((v) => v.status === "violated").map((v) => v.constraintKey);
  if (acusadas.length > 0) {
    const alvo = constraints.filter((c) => acusadas.includes(c.constraintKey));
    // ⚖️ LEI 2026-09-10: o auditor é um SLOT do tenant de outra família que o juiz — com o envelope
    // dele (provider + credencial), porque o revisor pode morar em outro provider. Sem slot viável a
    // auditoria simplesmente não roda, e o comentário abaixo já diz o que isso significa.
    const revisor = await resolveReviewerLlmForProject({ projectId: args.projectId, executorModel: judgeModel });
    if (!revisor.ok) console.warn(`[specPolicyGate] auditoria de constraint não roda — ${revisor.alert}`);
    const res = revisor.ok
      ? await callPolicyAgent({
          system: AUDIT_CONSTRAINT_SYSTEM,
          user: alvo.map((c) => `- ${c.constraintKey}: ${c.assertion}\n  prova esperada: ${c.evidenceHint}\n  trecho da spec: ${c.sourceAnchor}`).join("\n\n"),
          maxTokens: 2_000, modelId: revisor.model, llm: agentsLlmFields(revisor.llm),
        })
      : { ok: false as const, why: revisor.alert };
    const raw = res.ok ? parseListResponse(res.text, "audits") ?? [] : [];
    // Auditor ausente NÃO absolve e NÃO condena: sem parecer a constraint segue com poder de
    // bloquear, que é o estado anterior a esta frente.
    audits = raw.map((r) => {
      const v = String(r.verdict ?? "").trim().toLowerCase();
      return {
        constraintKey: normalizeKey(r.constraint_key ?? r.constraintKey),
        verdict: (v === "vaga" || v === "irrelevante" || v === "verificavel" ? v : "") as ConstraintAudit,
      };
    }).filter((a) => a.constraintKey);
  }

  const decididos = applyPolicyDecisions(base, {
    waivers, audits, partialArtifacts: naoLidos, coverageIncomplete: passesFailed > 0,
  });

  // ── 5. F3: o que só a EXECUÇÃO REAL sabe ───────────────────────────────────
  // A spec real do NVX LastMile deu 119 constraints: 0 `spec`, 62 `build`, 57 `runtime`. O juiz de
  // spec não tem o que julgar porque o objeto do julgamento ainda não existe — as 119 ficam `pending`
  // por natureza, não por falha. Aqui elas recebem o veredicto que o produto RODANDO já produziu.
  // Direção única: só substitui `pending`, e o `import` é dinâmico porque o oráculo importa este
  // módulo (ciclo estático quebraria o boot da api).
  let verdicts = decididos;
  let oracleApplied = 0;
  try {
    const { loadOracleVerdicts, applyOracleVerdicts } = await import("./specOracle.js");
    const oracle = await loadOracleVerdicts(db, args.projectId, args.specHash);
    if (oracle.size > 0) {
      verdicts = applyOracleVerdicts(decididos, oracle);
      oracleApplied = verdicts.filter((v, i) => decididos[i]?.status === "pending" && v.status !== "pending").length;
    }
  } catch (err) {
    // Oráculo ilegível NÃO muda nada: o gate segue com o que o juiz de spec decidiu (fail-CLOSED).
    console.warn(`[specPolicyGate] veredictos do oráculo indisponíveis: ${String(err).slice(0, 200)}`);
  }

  const tally = { ...policyTally(verdicts, constraints), judged };
  await persistVerdicts(db, {
    projectId: args.projectId, specHash: args.specHash, model: judgeModel || "desconhecido",
    autonomyRunId: args.autonomyRunId, validationRunId: args.validationRunId, verdicts: decididos,
  });
  return {
    ran: true, constraints, rejected, verdicts, tally, unknownKeys, model: judgeModel, derived,
    judgePasses: batches.length, passesFailed, derivePasses, derivePassesFailed,
    partialArtifacts: naoLidos, oracleApplied, declaredNeeded, declaredNeededMissing,
  };
}
