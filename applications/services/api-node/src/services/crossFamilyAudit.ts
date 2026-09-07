/**
 * REVISOR CROSS-FAMILY — auditoria da PREMISSA DE FATO de cada finding por um modelo NÃO-Claude.
 *
 * ── POR QUE (pesquisa, não palpite) ────────────────────────────────────────────────────────────
 * `arXiv:2609.04270` mede um pipeline executar→revisar→corrigir com o executor CONSTANTE e o
 * revisor variando: auto-revisão da MESMA família dá **zero** ganho de acurácia e rejeita **35%**
 * do que estava certo; revisor **cross-family mid-tier** dá **+12 p.p.** com **2%** de
 * falso-rejeite. O Genesis inteiro — CTO-editor, refutador, juiz de promovibilidade — é Claude,
 * com a mesma config de LLM do tenant. Somos, literalmente, a configuração medida como inútil.
 *
 * `arXiv:2609.03230` mede que o melhor modelo Anthropic acha a mediana de **47%** dos defeitos de
 * requisito (11% de falso-positivo) e erra *"almost always"* os de necessidade e correção. Logo
 * "zero GAPs" nunca significou "spec pronta", e o FP do NOSSO juiz nunca foi medido — sem isso a
 * contagem de GAPs é infalsificável.
 *
 * ── O EQUILÍBRIO QUE O JEAN EXIGIU (verbatim, 2026-09-07) ──────────────────────────────────────
 * *"não se trata apenas de deixar passar e destravar as specs, não podemos ignorar falhas
 * realmente graves de análises e escrita as specs, também não podemos entrar em um loop infinito
 * em busca da perfeição que nunca será alcançada porque a cada nova rodada é criado novos gaps,
 * precisamos de equilíbrio."*
 *
 * As duas pernas, e por que uma sem a outra não serve:
 *   • **contra deixar passar** — `presente` REFORÇA o finding. Grave pelas DUAS famílias fica fora
 *     de qualquer cota de anistia e bloqueia promoção sempre;
 *   • **contra o loop infinito** — `ausente` é a prova de que a acusação não existe no texto. É a
 *     classe do GAP-84: um `blocker` que NENHUMA edição consegue fechar, porque o defeito não está
 *     lá. Esse é o GAP eterno, e ele é o motor do loop.
 *
 * ── LIMITES DE DESENHO (o que este módulo NÃO faz) ─────────────────────────────────────────────
 *   1. **não reclassifica severidade.** `severity_claude` é gravada como estava. Campo PARALELO,
 *      mesma disciplina do limite (a) do Jean no GAP-77.
 *   2. **não promove e não triaga.** `spec_finding_triage` continua sendo só do humano; promover à
 *      Fábrica continua sendo ato humano com confirmação por digitação.
 *   3. **não decide nada nesta primeira versão** (`SPEC_CROSS_AUDIT=on` só REGISTRA). Medir antes de
 *      gatear: liberar com base em número que ainda não existe seria exatamente a anistia que o
 *      Jean proibiu.
 *   4. **sem fallback burro.** Falha de LLM, JSON inválido ou trecho vazio ⇒ nenhuma linha (ou
 *      `indecidivel`), e a crítica original continua de pé — `feedback-genesis-100-llm-nunca-automacao-fixa`.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { httpPost } from "../routes/specs.js";
import { anchoredSection } from "./gapPromotionVerdict.js";
import { findingFingerprint, type Db } from "./findingTriage.js";
import { loadSpecFiles, resolveFindingPath } from "./specGapScope.js";
import type { ValidationFinding } from "./specValidation.js";

/**
 * Família do auditor. Default `amazon.nova-pro-v1:0` — mid-tier de OUTRA família, que é exatamente
 * a configuração que o paper mede como a que ganha (+12 p.p.). Trocar por `mistral.mistral-large-3-675b-instruct`,
 * `deepseek.v3.2` ou `qwen.qwen3-32b-v1:0` não exige deploy: todas as quatro acertaram 12/12 no
 * gold set de calibração de 2026-09-07 (inclui acusação falsa-confiante e acusação fora do trecho).
 */
const AUDIT_MODEL = (process.env.SPEC_CROSS_AUDIT_MODEL ?? "amazon.nova-pro-v1:0").trim();
const AUDIT_TIMEOUT_MS = num(process.env.SPEC_CROSS_AUDIT_TIMEOUT_MS, 90_000);
/** Teto por validação. Auditar 25 findings custa centavos, mas teto explícito > surpresa na fatura. */
const AUDIT_MAX_PER_RUN = num(process.env.SPEC_CROSS_AUDIT_MAX, 40);
/** Quantos chars do trecho ancorado vão ao auditor. Recorte curto foi o defeito do GAP-72/74. */
const SECTION_CHARS = num(process.env.SPEC_CROSS_AUDIT_SECTION_CHARS, 14_000);
const AUDIT_MAX_TOKENS = num(process.env.SPEC_CROSS_AUDIT_MAX_TOKENS, 900);

function num(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type AuditVerdict = "presente" | "ausente" | "indecidivel";
export type AuditGravity = "grave" | "moderada" | "cosmetica" | "";

export interface FindingAudit {
  fingerprint: string;
  file: string;
  anchor: string | null;
  severityClaude: string;
  categoryClaude: string;
  title: string;
  verdict: AuditVerdict;
  gravity: AuditGravity;
  evidence: string;
  evidenceVerbatim: boolean;
  why: string;
  model: string;
  sectionChars: number;
  fileShaAt: string;
}

export interface CrossFamilyAuditResult {
  ran: boolean;
  audits: FindingAudit[];
  /** Por que NÃO rodou (flag off, sem agents, sem finding ancorado). Nunca silencioso. */
  reason?: string;
  skipped: number;
  failed: number;
  model: string;
}

/**
 * O prompt do auditor. Escrito para responder UMA pergunta factual e nada mais.
 *
 * Cada regra abaixo fecha um modo de falha medido, não é enfeite:
 *  - regra 1/2: sem elas o auditor "conclui" a partir de conhecimento geral e diz `ausente` para
 *    acusação que ele simplesmente não podia verificar (o trecho não veio) — isso APAGARIA crítica
 *    legítima, que é a falha grave que o Jean proibiu;
 *  - regra 5: modelos citam o texto da ACUSAÇÃO em vez do texto da SPEC. A citação é a única prova
 *    do `ausente`; sem esta regra o veredicto é indistinguível de opinião;
 *  - regra 6: é o caso GAP-84 literal — o acusador confessou no próprio `rationale` que não havia
 *    divergência e ainda assim marcou `blocker`;
 *  - regra 7: acusação escrita com segurança não é prova. Medido: 4 famílias diferentes só
 *    acertaram o caso "falsa e confiante" com esta linha presente;
 *  - a régua de gravidade é CONSEQUÊNCIA PARA A FÁBRICA, não gosto de redação. É o que permite
 *    equilíbrio: sem ela, "grave" viraria sinônimo de "eu me incomodei".
 */
export const AUDIT_SYSTEM = `Você é AUDITOR INDEPENDENTE de uma ACUSAÇÃO feita por outro revisor sobre um trecho de especificação técnica.

Sua ÚNICA pergunta é factual: o defeito ACUSADO existe no TRECHO abaixo, tal como está escrito?

Você NÃO julga se o defeito é elegante, NÃO propõe correção e NÃO acrescenta defeitos novos.
Você só verifica a PREMISSA DE FATO da acusação e, se ela existe, o TAMANHO da consequência.

REGRAS INVIOLÁVEIS:
1. A única prova admissível é o próprio TRECHO. Não presuma nada fora dele.
2. Se a acusação depende de texto que NÃO está no TRECHO (outro arquivo, outra seção não incluída),
   o veredicto é "indecidivel" — NUNCA "ausente". Nesse caso a crítica original continua de pé.
3. "presente" exige que você cite VERBATIM o pedaço do TRECHO que exibe o defeito.
4. "ausente" exige que você cite VERBATIM o pedaço do TRECHO que prova a CONFORMIDADE.
5. A citação (campo "evidence") tem de ser copiada do TRECHO, caractere por caractere — NUNCA do
   texto da acusação. Citar a acusação não prova nada.
6. Se o próprio texto da acusação declara que não há divergência / que está conforme / que é
   reportado só "para preservar continuidade", isso é "ausente" por confissão do acusador.
7. Uma acusação escrita com segurança não é prova de nada. Confira o literal você mesmo.

GRAVIDADE (só quando o veredicto é "presente"). A régua é a CONSEQUÊNCIA PARA QUEM VAI CONSTRUIR o
software a partir desta spec — não é gosto de redação:
- "grave": quem construir a partir deste texto produz algo ERRADO, ou não consegue construir —
  contrato/dado/interface indefinido ou contraditório, requisito impossível, ambiguidade que muda o
  produto entregue.
- "moderada": constrói e funciona, mas sobra risco real — lacuna que exige decisão de engenharia,
  critério de aceite não verificável.
- "cosmetica": forma, redação, redundância, ordem, nomenclatura. Não muda NADA do que será construído.

Responda APENAS com um objeto JSON, sem cercas de código, exatamente neste formato:
{"verdict":"presente|ausente|indecidivel","gravity":"grave|moderada|cosmetica","evidence":"<citacao verbatim curta do TRECHO>","why":"<uma ou duas frases>"}`;

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Normaliza espaços para a checagem de TRANSPORTE da citação (quebra de linha não é divergência). */
function flat(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A citação do auditor está LITERALMENTE no trecho enviado?
 *
 * Checagem de transporte, não de conteúdo: um auditor que cita o texto da ACUSAÇÃO em vez do texto
 * da SPEC não provou nada. Isto NÃO anula o veredicto (o LLM continua decidindo) — degrada a
 * confiança, e quem consome a linha decide o que fazer com ela.
 */
export function evidenceIsVerbatim(evidence: string, section: string): boolean {
  const e = flat(evidence);
  if (e.length < 12) return false;          // citação curta demais casa por acidente
  return flat(section).includes(e);
}

/** Extrai o objeto JSON de uma resposta que pode vir cercada por ```json (3 das 4 famílias cercam). */
export function parseAuditJson(raw: string): { verdict: string; gravity?: string; evidence?: string; why?: string } | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const noFence = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(noFence.slice(start, end + 1)) as Record<string, unknown>;
    const verdict = String(obj.verdict ?? "").trim().toLowerCase();
    if (!verdict) return null;
    return {
      verdict,
      gravity: String(obj.gravity ?? "").trim().toLowerCase(),
      evidence: String(obj.evidence ?? ""),
      why: String(obj.why ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * `verdict` e `gravity` só existem no vocabulário fechado. Fora dele ⇒ `indecidivel`.
 *
 * Fail-para-o-lado-seguro: um veredicto que não entendemos NÃO pode virar `ausente` (absolvição por
 * ruído de parsing seria a anistia silenciosa que o Jean proibiu). Vira `indecidivel`, que mantém a
 * crítica original de pé.
 */
export function normalizeVerdict(v: string): AuditVerdict {
  if (v === "presente" || v === "ausente" || v === "indecidivel") return v;
  if (v === "indecidível") return "indecidivel";
  return "indecidivel";
}

export function normalizeGravity(g: string | undefined, verdict: AuditVerdict): AuditGravity {
  if (verdict !== "presente") return "";
  const v = (g ?? "").trim().toLowerCase();
  if (v === "grave" || v === "moderada" || v === "cosmetica") return v;
  if (v === "cosmética") return "cosmetica";
  // Defeito confirmado sem gravidade legível: NÃO pode virar "cosmetica" por omissão — o silêncio
  // do auditor não absolve. `grave` é o lado seguro para um defeito que ele mesmo diz existir.
  return "grave";
}

/** Monta a mensagem do auditor. Trecho primeiro, acusação depois — a ordem que o gold set validou. */
export function buildAuditMessage(f: ValidationFinding, section: string): string {
  return [
    `TRECHO (verbatim, âncora ${f.anchor ?? "(sem âncora)"} do arquivo ${f.file}):`,
    "<<<INICIO>>>",
    section,
    "<<<FIM>>>",
    "",
    "ACUSAÇÃO do outro revisor:",
    `- severidade declarada: ${f.severity}`,
    `- categoria: ${f.category ?? "(sem categoria)"}`,
    `- título: ${f.title}`,
    `- justificativa: ${f.rationale}`,
    "",
    "O defeito acusado existe no TRECHO?",
  ].join("\n");
}

/**
 * Audita os findings ANCORADOS de uma validação com um modelo de outra família.
 *
 * Só finding ancorado entra: sem âncora não existe trecho verbatim, e auditar sem o texto seria
 * pedir opinião — exatamente o que a pesquisa diz que não funciona. Finding sem âncora continua
 * valendo integralmente, apenas não é auditável aqui (e isso vai declarado em `skipped`).
 */
export async function auditFindings(db: Db, args: {
  projectId: string;
  findings: ValidationFinding[];
  validationRunId?: string | null;
  autonomyRunId?: string | null;
  llm?: Record<string, unknown> | null;
}): Promise<CrossFamilyAuditResult> {
  const empty = (reason: string): CrossFamilyAuditResult =>
    ({ ran: false, audits: [], reason, skipped: 0, failed: 0, model: AUDIT_MODEL });

  if ((process.env.SPEC_CROSS_AUDIT ?? "").trim().toLowerCase() !== "on") {
    return empty("SPEC_CROSS_AUDIT != on");
  }
  const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim().replace(/\/$/, "");
  if (!agentsUrl) return empty("API_AGENTS_URL ausente");

  // Só o que tem âncora E severidade importante: `info` não conta na contagem nem trava promoção,
  // então auditar `info` gastaria LLM sem mudar decisão nenhuma.
  const alvo = args.findings.filter((f) => (f.anchor ?? "").trim() && f.severity !== "info");
  const skipped = args.findings.length - alvo.length;
  if (alvo.length === 0) return { ...empty("nenhum finding ancorado importante"), skipped };

  const refs = await loadSpecFiles(db, args.projectId).catch(() => []);
  if (refs.length === 0) return { ...empty("projeto sem arquivos de spec"), skipped };
  const byPath = new Map(refs.map((r) => [r.path.toLowerCase(), r]));

  // Conteúdo lido UMA vez por arquivo (a mesma âncora costuma repetir no mesmo arquivo).
  const cache = new Map<string, { content: string; sha: string } | null>();
  const loadFile = async (canon: string) => {
    if (cache.has(canon)) return cache.get(canon) ?? null;
    const ref = byPath.get(canon);
    const buf = ref ? await readFile(ref.filePath).catch(() => null) : null;
    const entry = buf ? { content: buf.toString("utf8"), sha: sha256Hex(buf) } : null;
    cache.set(canon, entry);
    return entry;
  };

  const audits: FindingAudit[] = [];
  let failed = 0;
  let extraSkipped = 0;

  for (const f of alvo.slice(0, AUDIT_MAX_PER_RUN)) {
    const canon = resolveFindingPath(f.file ?? "", refs.map((r) => r.path));
    const file = canon ? await loadFile(canon.toLowerCase()) : null;
    if (!file) { extraSkipped++; continue; }

    const section = anchoredSection(file.content, f.anchor ?? "").slice(0, SECTION_CHARS);
    // Sem trecho não há auditoria possível: âncora que o recorte não alcança é problema de outro GAP
    // (72/73/74/75). Absolver aqui transformaria cegueira do recorte em "defeito inexistente".
    if (!section.trim()) { extraSkipped++; continue; }

    let raw = "";
    try {
      const body = await httpPost(`${agentsUrl}/invoke/raw`, JSON.stringify({
        prompt_override: AUDIT_SYSTEM,
        user_message: buildAuditMessage(f, section),
        max_tokens: AUDIT_MAX_TOKENS,
        temperature: 0,
        model_id: AUDIT_MODEL,
        ...(args.llm ?? {}),
      }), AUDIT_TIMEOUT_MS);
      const data = JSON.parse(body) as { response?: string; truncated?: boolean };
      // Parecer CORTADO é parecer sem conclusão — a família T1/T2 nasceu de aplicar o mutilado.
      if (data.truncated === true) { failed++; continue; }
      raw = data.response ?? "";
    } catch (err) {
      console.warn(`[crossFamilyAudit] auditor falhou em ${f.file} ${f.anchor}: ${String(err)}`);
      failed++;
      continue;
    }

    const parsed = parseAuditJson(raw);
    if (!parsed) { failed++; continue; }

    const verdict = normalizeVerdict(parsed.verdict);
    const evidence = (parsed.evidence ?? "").slice(0, 2_000);
    audits.push({
      fingerprint: findingFingerprint(f),
      file: canon ?? f.file,
      anchor: f.anchor ?? null,
      severityClaude: f.severity,
      categoryClaude: f.category ?? "",
      title: f.title ?? "",
      verdict,
      gravity: normalizeGravity(parsed.gravity, verdict),
      evidence,
      evidenceVerbatim: evidenceIsVerbatim(evidence, section),
      why: (parsed.why ?? "").slice(0, 2_000),
      model: AUDIT_MODEL,
      sectionChars: section.length,
      fileShaAt: file.sha,
    });
  }

  await persistAudits(db, args.projectId, args.validationRunId ?? null, args.autonomyRunId ?? null, audits);
  return { ran: true, audits, skipped: skipped + extraSkipped, failed, model: AUDIT_MODEL };
}

/** Grava as auditorias. Conflito no mesmo (finding, conteúdo, modelo) ⇒ reescreve: é reauditoria. */
export async function persistAudits(
  db: Db, projectId: string, validationRunId: string | null, autonomyRunId: string | null,
  audits: FindingAudit[],
): Promise<number> {
  let n = 0;
  for (const a of audits) {
    try {
      await db.query(
        `INSERT INTO spec_finding_audits
           (project_id, validation_run_id, autonomy_run_id, fingerprint, file_path, anchor,
            severity_claude, category_claude, title, verdict, gravity, evidence, evidence_verbatim,
            why, model, section_chars, file_sha_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (project_id, fingerprint, file_sha_at, model) DO UPDATE SET
           verdict = EXCLUDED.verdict, gravity = EXCLUDED.gravity, evidence = EXCLUDED.evidence,
           evidence_verbatim = EXCLUDED.evidence_verbatim, why = EXCLUDED.why,
           section_chars = EXCLUDED.section_chars, validation_run_id = EXCLUDED.validation_run_id,
           autonomy_run_id = EXCLUDED.autonomy_run_id, created_at = now()`,
        [projectId, validationRunId, autonomyRunId, a.fingerprint, a.file, a.anchor,
         a.severityClaude, a.categoryClaude, a.title, a.verdict, a.gravity, a.evidence,
         a.evidenceVerbatim, a.why, a.model, a.sectionChars, a.fileShaAt],
      );
      n++;
    } catch (err) {
      // Registrar auditoria é ACESSÓRIO: nunca derruba a validação que a produziu.
      console.warn(`[crossFamilyAudit] persistência falhou (${a.file} ${a.anchor}): ${String(err)}`);
    }
  }
  return n;
}

export interface AuditTally {
  total: number;
  presente: number;
  ausente: number;
  indecidivel: number;
  grave: number;
  moderada: number;
  cosmetica: number;
  /** `ausente` COM citação verbatim conferida — a estimativa honesta de falso-positivo do juiz. */
  ausenteComProva: number;
}

/**
 * O número que faltava: quanto do que o NOSSO juiz chama de importante uma segunda família diz que
 * não existe no texto. Sem isto a contagem de GAPs era infalsificável.
 */
export function tally(audits: FindingAudit[]): AuditTally {
  const t: AuditTally = { total: audits.length, presente: 0, ausente: 0, indecidivel: 0,
                          grave: 0, moderada: 0, cosmetica: 0, ausenteComProva: 0 };
  for (const a of audits) {
    if (a.verdict === "presente") t.presente++;
    else if (a.verdict === "ausente") { t.ausente++; if (a.evidenceVerbatim) t.ausenteComProva++; }
    else t.indecidivel++;
    if (a.gravity === "grave") t.grave++;
    else if (a.gravity === "moderada") t.moderada++;
    else if (a.gravity === "cosmetica") t.cosmetica++;
  }
  return t;
}
