/**
 * specOracle.ts — 🔴 F3: o ORÁCULO EXECUTÁVEL (item 3A do Jean).
 *
 * ## Por que esta frente existe (medido, não palpite)
 *
 * O F2 (Policy Gate) derivou **119 constraints declaradas** da spec real do NVX LastMile. Distribuição
 * medida em prod: **0 `spec`, 62 `build`, 57 `runtime`** — zero julgáveis na Bancada. Não é falha de
 * prompt nem de lote: uma spec deste tipo declara **comportamento do PRODUTO**, não propriedade do
 * TEXTO. O juiz de spec não tem o que julgar porque o objeto do julgamento ainda não existe.
 *
 * ⇒ O oráculo não é melhoria do F2. É a **única rota** que decide 119 de 119.
 *
 * Dois defeitos MEDIDOS no lado da Fábrica, que este módulo existe para tornar decidíveis:
 *  * **GAP-85** — a última porta de QA (`TSK-FULL-TEST`) decidia por SUBSTRING na prosa do agente.
 *    `"NÃO APROVADO"` contém `"APROVADO"` ⇒ um relatório que REPROVA marcava a task como `DONE`.
 *  * **GAP-86** — a suíte só rodava quando havia baseline de EVOLUÇÃO. Em primeiro build o produto
 *    entregue **nunca era executado**.
 *
 * ## A lei que este módulo respeita literalmente
 *
 * O sistema é 100% LLM nas decisões: **o código nunca mapeia `exit_code` em veredicto de constraint.**
 * Quem julga é o agente, recebendo a saída real verbatim. O código faz três coisas, todas mecânicas:
 * transporta o fato, **recusa citação fabricada** (a citação do juiz tem de existir LITERALMENTE na
 * saída) e nomeia o motivo quando nada pôde ser decidido.
 *
 * `arXiv:2609.04167` (34% dos patches que passam nos testes violam constraints declaradas) é a razão
 * da regra mais importante do prompt: **suíte verde NÃO satisfaz constraint que nenhum teste
 * exercita** — isso é `indecidivel`, e é a resposta CERTA na maioria dos casos.
 *
 * ## Direção única (fail-CLOSED)
 *
 * Veredicto de oráculo só pode ACRESCENTAR impedimento. `no_tests` e `error` mantêm a constraint
 * `pending` e DECLARAM a ausência de medição — "nada a rodar" nunca vira "tudo cumprido". Executor
 * indisponível, JSON ilegível ou juiz ausente ⇒ nada muda, com o motivo dito.
 */
import { evidenceIsVerbatim } from "./crossFamilyAudit.js";
import type { Db } from "./findingTriage.js";
import { parseListResponse } from "./gapPromotionVerdict.js";
import {
  applyPolicyDecisions, callPolicyAgent, loadConstraints, normalizeKey, persistVerdicts, policyTally,
  sha256Hex, type PolicyTally, type PolicyVerdict, type SpecConstraint,
} from "./specPolicyGate.js";
import type { ValidationFinding } from "./specValidation.js";

function num(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `SPEC_ORACLE=on` liga. Nasce OFF (rota B): medir antes de gatear. */
export function oracleEnabled(): boolean {
  return (process.env.SPEC_ORACLE ?? "").trim().toLowerCase() === "on";
}

export function oracleConfig() {
  return {
    /** Vazio = modelo do tenant. Cross-family é opção, não obrigação (o fato aqui é executado, não opinado). */
    judgeModel: (process.env.SPEC_ORACLE_JUDGE_MODEL ?? "").trim(),
    /** Orçamento de saída do juiz. Um veredicto por constraint com citação verbatim não cabe em 6k. */
    maxTokens: num(process.env.SPEC_ORACLE_TOKENS, 12_000),
    /** Constraints por chamada. 119 constraints numa chamada não caberiam no orçamento de saída. */
    perPass: num(process.env.SPEC_ORACLE_PER_PASS, 30),
    /** Teto de passes: trava de fatura, o mesmo princípio do `maxJudgePasses` do F2. */
    maxPasses: num(process.env.SPEC_ORACLE_MAX_PASSES, 8),
    /** Teto do trecho de saída que vai ao juiz — e é o texto contra o qual a citação é conferida. */
    outputChars: num(process.env.SPEC_ORACLE_OUTPUT_CHARS, 60_000),
    /** Teto de findings devolvidos à spec por medição. */
    maxFindings: num(process.env.SPEC_ORACLE_MAX_FINDINGS, 40),
  };
}

// ── o FATO medido ─────────────────────────────────────────────────────────────────────────────────

export interface OracleTest { id: string; status: string; message: string }

/** O contrato normalizado do `/run-tests` do executor isolado (Host B, rota B / Lei 8). */
export interface OracleRun {
  stack: string;
  /** Comando VERBATIM. Sem ele não há execução comprovada — e payload sem prova é recusado. */
  cmd: string;
  exitCode: number | null;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  noTests: boolean;
  status: string;
  /** O executor sabe dizer teste-a-teste? `false` ⇒ só exit code e contagem são fatos. */
  testsReliable: boolean;
  tests: OracleTest[];
  output: string;
  /** Onde rodou. Entra no `env_sha` porque a mesma spec medida em outro lugar é OUTRA medição. */
  executor: string;
}

export type OracleOutcome = "green" | "red" | "no_tests" | "error";

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Aceita o payload do executor ou RECUSA com motivo.
 *
 * Recusar é o comportamento certo para payload que não prova execução: sem `cmd` e sem `exit_code`
 * não houve medição, e tratar isso como "suíte verde" seria o GAP-42/43 (métrica que dá 100% por
 * construção) na porta de entrada.
 */
export function normalizeOracleRun(raw: unknown): { ok: true; run: OracleRun } | { ok: false; why: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, why: "payload do executor não é objeto" };
  }
  const r = raw as Record<string, unknown>;
  const status = str(r.status).trim().toLowerCase();
  const noTests = r.no_tests === true || r.noTests === true;
  const cmd = str(r.cmd).trim();
  const exitRaw = r.exit_code ?? r.exitCode;
  const exitCode = exitRaw === null || exitRaw === undefined || exitRaw === "" ? null : int(exitRaw);
  const tests: OracleTest[] = Array.isArray(r.tests)
    ? (r.tests as unknown[]).filter((t) => t && typeof t === "object").map((t) => {
      const o = t as Record<string, unknown>;
      return { id: str(o.id), status: str(o.status).trim().toLowerCase(), message: str(o.message ?? o.msg) };
    }).filter((t) => t.id || t.message)
    : [];
  const run: OracleRun = {
    stack: str(r.stack).trim(),
    cmd,
    exitCode,
    passed: int(r.passed), failed: int(r.failed), skipped: int(r.skipped), total: int(r.total),
    noTests,
    status: status || (exitCode === null ? "unknown" : "ok"),
    testsReliable: r.tests_reliable !== false && r.testsReliable !== false,
    tests,
    output: str(r.output ?? r.stdout ?? r.log ?? r.error),
    executor: str(r.executor ?? r.target ?? "").trim(),
  };
  if (status === "error") return { ok: true, run };
  if (noTests) return { ok: true, run };
  if (!cmd) return { ok: false, why: "resultado sem `cmd` — execução não comprovada" };
  if (exitCode === null) return { ok: false, why: `resultado sem \`exit_code\` (cmd: ${cmd.slice(0, 80)}) — execução não comprovada` };
  return { ok: true, run };
}

/**
 * O único lugar onde o código classifica: e classifica o FATO, não a constraint.
 *
 * `exit_code` 0 com teste falhando é contradição do relatório — e contradição vale como falha, porque
 * o lado seguro aqui é o vermelho. Isso não é julgar constraint: é transportar o fato com cuidado.
 */
export function oracleOutcome(run: OracleRun): OracleOutcome {
  if (run.status === "error") return "error";
  if (run.noTests) return "no_tests";
  if (run.exitCode === null) return "error";
  if (run.exitCode === 0 && run.failed === 0) return "green";
  return "red";
}

/** A chave do AMBIENTE (GAP-87 / Mistral A6): mesma spec medida em outro lugar é OUTRA medição. */
export function oracleEnvSha(run: OracleRun): string {
  return sha256Hex(`${run.stack}\n${run.cmd}\n${run.executor}`).slice(0, 32);
}

/** O texto contra o qual a citação do juiz é conferida: saída + mensagens de teste, tudo verbatim. */
export function oracleEvidenceText(run: OracleRun, cfg = oracleConfig()): string {
  const falhas = run.tests
    .filter((t) => t.status === "failed" || t.status === "error")
    .map((t) => `${t.id} :: ${t.message}`)
    .join("\n");
  return [run.output.slice(0, cfg.outputChars), falhas].filter(Boolean).join("\n");
}

/** O relatório verbatim que vai ao juiz. Nada aqui é interpretação — são os campos do executor. */
export function oracleReport(run: OracleRun, cfg = oracleConfig()): string {
  const falhas = run.tests.filter((t) => t.status === "failed" || t.status === "error");
  const corte = run.output.length > cfg.outputChars
    ? ` (RECORTADA: ${cfg.outputChars} de ${run.output.length} chars)`
    : "";
  return [
    "=== EXECUÇÃO REAL NO EXECUTOR ISOLADO ===",
    `executor: ${run.executor || "não declarado"}`,
    `stack: ${run.stack || "não declarada"}`,
    `comando: ${run.cmd || "não declarado"}`,
    `exit_code: ${run.exitCode === null ? "ausente" : run.exitCode}`,
    `contagem: ${run.passed} passando, ${run.failed} falhando, ${run.skipped} pulado(s), total ${run.total}`,
    `resultado por teste é confiável: ${run.testsReliable ? "sim" : "NÃO — só exit code e contagem são fatos"}`,
    run.noTests ? "SEM SUÍTE EXECUTÁVEL neste produto." : "",
    falhas.length ? `\n--- TESTES QUE FALHARAM (verbatim) ---\n${falhas.map((t) => `- ${t.id} :: ${t.message}`).join("\n")}` : "",
    `\n--- SAÍDA${corte} (verbatim) ---\n${run.output.slice(0, cfg.outputChars)}`,
  ].filter(Boolean).join("\n");
}

// ── o juiz (LLM) ──────────────────────────────────────────────────────────────────────────────────

export const ORACLE_SYSTEM = `Você julga CONSTRAINTS DECLARADAS de uma especificação contra a EXECUÇÃO REAL do produto construído.

Responda SOMENTE com JSON:
{"verdicts":[{"constraint_key":"...","status":"satisfied|violated|indecidivel","evidence":"citação VERBATIM da saída da execução","reason":"por que"}]}

REGRAS (a ordem importa):
1. "satisfied" só quando a SAÍDA REAL prova o cumprimento, e a prova é citada VERBATIM da saída
   (nome do teste que passou, linha de log, mensagem). Sem citação literal, não é satisfied.
2. "violated" também exige citação VERBATIM da saída (o teste que falhou, a mensagem de erro, a linha
   do log). Acusação sem citação da execução é acusação sem prova.
3. "indecidivel" quando a execução NÃO TOCA a constraint. Esta é a resposta CERTA na maioria dos
   casos, e não é falha sua: significa que nenhum teste exercitou aquela regra.
4. SUÍTE VERDE NÃO SATISFAZ CONSTRAINT QUE NENHUM TESTE EXERCITA. Está medido em pesquisa que 34% dos
   patches que passam nos testes violam constraints declaradas. "Tudo passou" ⇒ "indecidivel" para
   toda constraint que a suíte não exercita, jamais "satisfied".
5. NUNCA deduza veredicto do exit_code global. Exit code é sobre a suíte, não sobre a constraint.
6. Quando o relatório disser que o resultado por teste NÃO é confiável, só exit code e contagem são
   fatos — nomear um teste que você não viu na saída é fabricar prova.
7. Uma linha de resposta para CADA constraint_key recebida. Não invente chave.`;

/** Uma resposta por lote de constraints, com o mesmo relatório de execução em todas. */
export async function judgeOracleConstraints(args: {
  pending: SpecConstraint[];
  run: OracleRun;
  llm?: Record<string, unknown> | null;
  cfg?: ReturnType<typeof oracleConfig>;
}): Promise<{ raw: Array<Record<string, unknown>>; passes: number; passesFailed: number; why: string[]; model: string }> {
  const cfg = args.cfg ?? oracleConfig();
  const report = oracleReport(args.run, cfg);
  const lotes: SpecConstraint[][] = [];
  for (let i = 0; i < args.pending.length && lotes.length < cfg.maxPasses; i += cfg.perPass) {
    lotes.push(args.pending.slice(i, i + cfg.perPass));
  }
  const raw: Array<Record<string, unknown>> = [];
  const why: string[] = [];
  let passes = 0;
  let passesFailed = 0;
  let model = "";
  for (const [i, lote] of lotes.entries()) {
    const user = [
      report,
      "",
      `CONSTRAINTS A JULGAR (lote ${i + 1} de ${lotes.length}, uma linha de resposta para CADA constraint_key):`,
      ...lote.map((c) => `- ${c.constraintKey} [${c.verifiableAt}]: ${c.assertion} [prova esperada: ${c.evidenceHint}]`),
      "",
      "Julgue cada constraint contra a execução real acima.",
    ].join("\n");
    passes++;
    const res = await callPolicyAgent({
      system: ORACLE_SYSTEM, user, maxTokens: cfg.maxTokens,
      ...(cfg.judgeModel ? { modelId: cfg.judgeModel } : {}),
      llm: args.llm,
    });
    if (!res.ok) { passesFailed++; why.push(`lote ${i + 1}: ${res.why}`); continue; }
    const parsed = parseListResponse(res.text, "verdicts");
    if (!parsed || parsed.length === 0) { passesFailed++; why.push(`lote ${i + 1}: parecer sem JSON legível`); continue; }
    raw.push(...parsed);
    model = res.model || model;
  }
  return { raw, passes, passesFailed, why, model };
}

/**
 * Do parecer do agente para veredicto gravável — conferindo a citação contra a saída REAL.
 *
 * É o mesmo guard do F2 (`evidence_verbatim`) aplicado à execução: `satisfied` sem citação literal
 * degrada para `indecidivel`, e `violated` sem citação literal também. Evidência inventada não
 * satisfaz nada e não acusa ninguém — e a constraint que ninguém julgou entra como `not_judged`,
 * nunca como aprovada (lição GAP-17/18).
 */
export function normalizeOracleVerdicts(
  raw: Array<Record<string, unknown>>, pending: SpecConstraint[], run: OracleRun,
  cfg = oracleConfig(),
): { verdicts: PolicyVerdict[]; unknownKeys: string[]; judged: number } {
  const evidencia = oracleEvidenceText(run, cfg);
  const porChave = new Map<string, Record<string, unknown>>();
  const conhecidas = new Set(pending.map((c) => c.constraintKey));
  const unknownKeys: string[] = [];
  for (const r of raw) {
    const k = normalizeKey(r.constraint_key ?? r.constraintKey);
    if (!k) continue;
    if (!conhecidas.has(k)) { if (!unknownKeys.includes(k)) unknownKeys.push(k); continue; }
    if (!porChave.has(k)) porChave.set(k, r);
  }
  let judged = 0;
  const verdicts: PolicyVerdict[] = pending.map((c) => {
    const base: PolicyVerdict = {
      constraintKey: c.constraintKey, status: "indecidivel", evidence: "", evidenceVerbatim: false,
      artifact: run.cmd, reason: "not_judged", waiverKind: "", auditVerdict: "", blocking: false,
    };
    const r = porChave.get(c.constraintKey);
    if (!r) return base;
    const status = String(r.status ?? "").trim().toLowerCase();
    const evidence = String(r.evidence ?? "").trim();
    const reason = String(r.reason ?? "").trim().slice(0, 500);
    const verbatim = evidence.length > 0 && evidenceIsVerbatim(evidence, evidencia);
    judged++;
    if (status === "satisfied") {
      return verbatim
        ? { ...base, status: "satisfied", evidence, evidenceVerbatim: true, reason }
        : { ...base, status: "indecidivel", evidence, reason: "evidence_not_found" };
    }
    if (status === "violated") {
      return verbatim
        ? { ...base, status: "violated", evidence, evidenceVerbatim: true, reason, blocking: true }
        : { ...base, status: "indecidivel", evidence, reason: "evidence_not_found" };
    }
    return { ...base, status: "indecidivel", evidence, reason: reason || "indecidivel" };
  });
  return { verdicts, unknownKeys, judged };
}

/**
 * O que o Jean pediu no item 3A: **falha REAL volta como GAP na spec.**
 *
 * A severidade é a DECLARADA da constraint (um agente a declarou no F2) — o código não inventa
 * gravidade (Mistral A4). O arquivo tem de ser um arquivo REAL da spec: constraint que aponta para
 * arquivo inexistente não gera finding, e a recusa é declarada (premissa fabricada não vira GAP).
 * O `anchor` é a CHAVE da constraint, porque identidade estável é a lição do GAP-49/50.
 */
export function oracleFindings(
  verdicts: PolicyVerdict[], constraints: SpecConstraint[], specFiles: string[], run: OracleRun,
  cfg = oracleConfig(),
): { findings: ValidationFinding[]; dropped: Array<{ key: string; reason: string }> } {
  const porChave = new Map(constraints.map((c) => [c.constraintKey, c]));
  const arquivos = specFiles.map((f) => ({ raw: f, low: f.toLowerCase() }));
  const findings: ValidationFinding[] = [];
  const dropped: Array<{ key: string; reason: string }> = [];
  for (const v of verdicts) {
    if (v.status !== "violated" || !v.blocking) continue;
    if (findings.length >= cfg.maxFindings) {
      dropped.push({ key: v.constraintKey, reason: `teto de ${cfg.maxFindings} findings por medição` });
      continue;
    }
    const c = porChave.get(v.constraintKey);
    if (!c) { dropped.push({ key: v.constraintKey, reason: "constraint desconhecida" }); continue; }
    const alvo = String(c.appliesTo ?? "").toLowerCase();
    const arquivo = arquivos.find((f) => alvo.includes(f.low) || alvo.includes(f.low.replace(/\.md$/, "")));
    if (!arquivo) {
      dropped.push({ key: v.constraintKey, reason: `applies_to não nomeia arquivo real da spec ("${String(c.appliesTo).slice(0, 80)}")` });
      continue;
    }
    const sev = String(c.severity ?? "").trim().toLowerCase();
    if (sev !== "blocker" && sev !== "warning" && sev !== "info") {
      dropped.push({ key: v.constraintKey, reason: `severidade declarada inválida ("${sev}")` });
      continue;
    }
    findings.push({
      file: arquivo.raw,
      line: null,
      severity: sev,
      title: `Constraint declarada violada na execução real: ${c.constraintKey}`,
      rationale: [
        `A spec declara: ${c.assertion}`,
        `Trecho da spec: ${c.sourceAnchor}`,
        `A execução real contradiz isso. Comando: \`${run.cmd}\` — exit_code ${run.exitCode}, `
        + `${run.passed} passando, ${run.failed} falhando.`,
        `Prova (verbatim da saída): ${v.evidence.slice(0, 800)}`,
        v.reason ? `Parecer do oráculo: ${v.reason}` : "",
      ].filter(Boolean).join("\n"),
      source: "oracle",
      category: "oracle_execution",
      anchor: c.constraintKey,
    });
  }
  return { findings, dropped };
}

// ── persistência e orquestração ───────────────────────────────────────────────────────────────────

/** O modelo é gravado prefixado: veredicto de oráculo coexiste com o `pending` do juiz de spec. */
export function oracleModelTag(model: string): string {
  return `oracle:${(model || "desconhecido").trim()}`;
}

export async function loadOracleVerdicts(
  db: Db, projectId: string, specHash: string,
): Promise<Map<string, PolicyVerdict>> {
  const rows = (await db.query(
    `SELECT DISTINCT ON (constraint_key) constraint_key, status, evidence, evidence_verbatim,
            artifact, reason, waiver_kind, audit_verdict, blocking
       FROM spec_policy_verdicts
      WHERE project_id = $1 AND spec_hash = $2 AND model LIKE 'oracle:%' AND status <> 'pending'
      ORDER BY constraint_key, created_at DESC`,
    [projectId, specHash],
  )).rows as Array<Record<string, unknown>>;
  const out = new Map<string, PolicyVerdict>();
  for (const r of rows) {
    const key = String(r.constraint_key ?? "");
    if (!key) continue;
    out.set(key, {
      constraintKey: key,
      status: String(r.status ?? "indecidivel") as PolicyVerdict["status"],
      evidence: String(r.evidence ?? ""), evidenceVerbatim: r.evidence_verbatim === true,
      artifact: String(r.artifact ?? ""), reason: String(r.reason ?? ""),
      waiverKind: (String(r.waiver_kind ?? "") || "") as PolicyVerdict["waiverKind"],
      auditVerdict: (String(r.audit_verdict ?? "") || "") as PolicyVerdict["auditVerdict"],
      blocking: r.blocking === true,
    });
  }
  return out;
}

/**
 * Onde o F3 devolve ao F2 o que só a execução sabe: a constraint `pending` passa a ter veredicto.
 *
 * Só substitui `pending`. Veredicto que o juiz de spec já decidiu NÃO é sobrescrito — o oráculo
 * acrescenta o que faltava, não revisa o que já foi julgado. Direção única, como todo degrau desta
 * família: nada aqui pode transformar violação em cumprimento.
 */
export function applyOracleVerdicts(
  verdicts: PolicyVerdict[], oracle: Map<string, PolicyVerdict>,
): PolicyVerdict[] {
  if (oracle.size === 0) return verdicts;
  return verdicts.map((v) => {
    if (v.status !== "pending") return v;
    const o = oracle.get(v.constraintKey);
    if (!o) return v;
    return { ...o, waiverKind: v.waiverKind, auditVerdict: v.auditVerdict };
  });
}

/**
 * Os GAPs que a execução real provou, para a validação SEGUINTE uni-los aos estágios A e B.
 *
 * Só devolve medição da MESMA versão da spec (`spec_hash`), porque falha medida em outra versão é
 * fato sobre outro produto — e reaproveitá-la seria o GAP-76 (progresso medido com a superfície
 * rotacionada). Só de arquivos que ainda existem: GAP sobre arquivo apagado é GAP preso no índice
 * (J1). E só ADICIONA — a run de validação passada é snapshot imutável e não é reescrita aqui.
 */
export async function loadOracleFindings(
  db: Db, projectId: string, specHash: string, currentFiles?: string[],
): Promise<ValidationFinding[]> {
  if (!projectId || !specHash) return [];
  const rows = (await db.query(
    `SELECT findings FROM spec_oracle_runs
      WHERE project_id = $1 AND spec_hash = $2 AND jsonb_array_length(findings) > 0
      ORDER BY created_at DESC`,
    [projectId, specHash],
  )).rows as Array<{ findings?: unknown }>;
  const vivos = currentFiles ? new Set(currentFiles) : null;
  const porChave = new Map<string, ValidationFinding>();
  for (const r of rows) {
    const lista = Array.isArray(r.findings) ? r.findings : [];
    for (const raw of lista) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as ValidationFinding;
      if (!f.file || !f.title || f.source !== "oracle") continue;
      if (vivos && !vivos.has(f.file)) continue;
      // Duas medições em ambientes diferentes podem acusar a MESMA constraint: uma identidade, um
      // GAP (lição GAP-49/50 — a contagem não pode inflar por onde a medição rodou).
      const chave = `${f.file}::${f.anchor ?? f.title}`;
      if (!porChave.has(chave)) porChave.set(chave, f);
    }
  }
  return [...porChave.values()];
}

export interface SpecOracleResult {
  ran: boolean;
  reason?: string;
  outcome: OracleOutcome | null;
  envSha: string;
  verdicts: PolicyVerdict[];
  tally: PolicyTally;
  findings: ValidationFinding[];
  droppedFindings: Array<{ key: string; reason: string }>;
  unknownKeys: string[];
  pending: number;
  judged: number;
  passes: number;
  passesFailed: number;
  model: string;
  note: string;
}

/**
 * A nota em prosa. Diz PRIMEIRO a cobertura, porque um oráculo que julgou 3 de 119 constraints não é
 * um oráculo verde — é um oráculo cego, e foi assim que a contagem do GAP-13 passou por progresso.
 */
export function oracleNote(res: Pick<SpecOracleResult, "outcome" | "judged" | "pending" | "tally" | "passesFailed">): string {
  if (res.outcome === "no_tests") return "o produto não tem suíte executável — nenhuma constraint de build/runtime pôde ser medida (segue pendente, não cumprida)";
  if (res.outcome === "error") return "a execução não pôde ser medida — nenhuma constraint de build/runtime foi decidida (segue pendente, não cumprida)";
  const partes = [
    `${res.judged}/${res.pending} constraint(s) de build/runtime julgada(s) na execução real`,
    `${res.tally.satisfied} cumprida(s)`,
    `${res.tally.blocking} violação(ões) impeditiva(s)`,
  ];
  if (res.outcome === "red") partes.unshift("a suíte FALHOU na execução real");
  if (res.tally.indecidivel) partes.push(`${res.tally.indecidivel} que a execução não exercita`);
  if (res.tally.evidenceNotFound) partes.push(`${res.tally.evidenceNotFound} com citação não conferida na saída`);
  if (res.passesFailed) partes.push(`${res.passesFailed} passe(s) do juiz falharam`);
  return partes.join(", ");
}

async function latestArchetypeHash(db: Db, projectId: string, specHash: string): Promise<string | null> {
  const rows = (await db.query(
    `SELECT archetype_hash FROM spec_constraints
      WHERE project_id = $1 AND spec_hash = $2
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, specHash],
  )).rows as Array<{ archetype_hash?: string }>;
  const h = rows[0]?.archetype_hash;
  return h === undefined || h === null ? null : String(h);
}

/**
 * O oráculo completo: recebe o fato do executor, julga as constraints `pending` contra ele, grava e
 * devolve os GAPs que a execução REAL provou.
 *
 * Idempotente por `(projectId, specHash, envSha)`: a mesma spec medida no MESMO ambiente não paga a
 * conta duas vezes — e medida em ambiente DIFERENTE é outra medição, que roda (GAP-87).
 */
export async function runSpecOracle(db: Db, args: {
  projectId: string;
  specHash: string;
  /** O JSON cru do `/run-tests` do executor. */
  raw: unknown;
  specFiles?: string[];
  autonomyRunId?: string | null;
  validationRunId?: string | null;
  llm?: Record<string, unknown> | null;
}): Promise<SpecOracleResult> {
  const cfg = oracleConfig();
  const empty = (reason: string, extra: Partial<SpecOracleResult> = {}): SpecOracleResult => ({
    ran: false, reason, outcome: null, envSha: "", verdicts: [], tally: policyTally([]),
    findings: [], droppedFindings: [], unknownKeys: [], pending: 0, judged: 0, passes: 0,
    passesFailed: 0, model: "", note: reason, ...extra,
  });
  if (!oracleEnabled()) return empty("SPEC_ORACLE != on");
  if (!args.projectId || !args.specHash) return empty("projeto ou spec sem hash");

  const norm = normalizeOracleRun(args.raw);
  if (!norm.ok) return empty(`resultado do executor recusado: ${norm.why}`);
  const run = norm.run;
  const outcome = oracleOutcome(run);
  const envSha = oracleEnvSha(run);

  // Já medido neste ambiente? A derivação e o julgamento são as chamadas caras.
  const jaMedido = (await db.query(
    "SELECT judged, outcome FROM spec_oracle_runs WHERE project_id = $1 AND spec_hash = $2 AND env_sha = $3",
    [args.projectId, args.specHash, envSha],
  ).catch(() => ({ rows: [] as Array<{ judged?: number; outcome?: string }> }))).rows[0];
  if (jaMedido && Number(jaMedido.judged ?? 0) > 0) {
    return empty(`spec já medida neste ambiente (env ${envSha.slice(0, 8)}, ${jaMedido.judged} constraint(s) julgada(s))`,
      { outcome, envSha });
  }

  const archHash = await latestArchetypeHash(db, args.projectId, args.specHash).catch(() => null);
  if (archHash === null) {
    return empty("nenhuma constraint declarada para esta spec — o Policy Gate (F2) não rodou ainda", { outcome, envSha });
  }
  const constraints = await loadConstraints(db, args.projectId, args.specHash, archHash).catch(() => []);
  const pending = constraints.filter((c) => c.verifiableAt === "build" || c.verifiableAt === "runtime");
  if (pending.length === 0) {
    return empty("nenhuma constraint de build/runtime nesta spec", { outcome, envSha });
  }

  const gravar = async (res: SpecOracleResult): Promise<void> => {
    try {
      await db.query(
        `INSERT INTO spec_oracle_runs
           (project_id, spec_hash, env_sha, outcome, stack, cmd, exit_code, passed, failed, skipped,
            total, no_tests, tests_reliable, executor, output_excerpt, constraints_pending, judged,
            violated, blocking, passes, passes_failed, model, note, autonomy_run_id, validation_run_id,
            findings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb)
         ON CONFLICT (project_id, spec_hash, env_sha) DO UPDATE SET
           findings = EXCLUDED.findings,
           outcome = EXCLUDED.outcome, exit_code = EXCLUDED.exit_code, passed = EXCLUDED.passed,
           failed = EXCLUDED.failed, skipped = EXCLUDED.skipped, total = EXCLUDED.total,
           no_tests = EXCLUDED.no_tests, tests_reliable = EXCLUDED.tests_reliable,
           output_excerpt = EXCLUDED.output_excerpt, constraints_pending = EXCLUDED.constraints_pending,
           judged = EXCLUDED.judged, violated = EXCLUDED.violated, blocking = EXCLUDED.blocking,
           passes = EXCLUDED.passes, passes_failed = EXCLUDED.passes_failed, model = EXCLUDED.model,
           note = EXCLUDED.note, created_at = now()`,
        [args.projectId, args.specHash, envSha, res.outcome ?? outcome, run.stack, run.cmd,
         run.exitCode, run.passed, run.failed, run.skipped, run.total, run.noTests, run.testsReliable,
         run.executor, run.output.slice(0, cfg.outputChars), res.pending, res.judged,
         res.tally.violated, res.tally.blocking, res.passes, res.passesFailed, res.model, res.note,
         args.autonomyRunId ?? null, args.validationRunId ?? null, JSON.stringify(res.findings)],
      );
    } catch (err) {
      // Gravar o fato é ACESSÓRIO ao veredicto: nunca derruba a medição que acabou de ser feita.
      console.warn(`[specOracle] persistência da medição falhou: ${String(err).slice(0, 300)}`);
    }
  };

  // `no_tests` e `error`: a AUSÊNCIA de medição é gravada e declarada. A constraint segue `pending`.
  if (outcome !== "green" && outcome !== "red") {
    const res: SpecOracleResult = {
      ran: true, outcome, envSha, verdicts: [], tally: policyTally([]), findings: [],
      droppedFindings: [], unknownKeys: [], pending: pending.length, judged: 0, passes: 0,
      passesFailed: 0, model: "", note: "",
    };
    res.note = oracleNote(res);
    await gravar(res);
    return res;
  }

  const juiz = await judgeOracleConstraints({ pending, run, llm: args.llm, cfg });
  if (juiz.raw.length === 0) {
    const reason = juiz.passes === 0
      ? "nenhum lote de constraint a julgar"
      : `juiz do oráculo indisponível (${juiz.passesFailed} de ${juiz.passes} passe(s)) — ${juiz.why.join(" | ")}`;
    const res = empty(reason, {
      outcome, envSha, pending: pending.length, passes: juiz.passes, passesFailed: juiz.passesFailed,
    });
    await gravar({ ...res, ran: false, note: reason });
    return res;
  }

  const { verdicts: base, unknownKeys, judged } = normalizeOracleVerdicts(juiz.raw, pending, run, cfg);
  const verdicts = applyPolicyDecisions(base, {});
  const tally = policyTally(verdicts, pending);
  const especs = args.specFiles ?? [];
  const { findings, dropped } = oracleFindings(verdicts, pending, especs, run, cfg);
  const model = oracleModelTag(juiz.model);

  const res: SpecOracleResult = {
    ran: true, outcome, envSha, verdicts, tally, findings, droppedFindings: dropped, unknownKeys,
    pending: pending.length, judged, passes: juiz.passes, passesFailed: juiz.passesFailed, model,
    note: "",
  };
  res.note = oracleNote(res);

  await persistVerdicts(db, {
    projectId: args.projectId, specHash: args.specHash, model,
    autonomyRunId: args.autonomyRunId, validationRunId: args.validationRunId, verdicts,
  }).catch((err) => {
    console.warn(`[specOracle] persistência de veredictos falhou: ${String(err).slice(0, 300)}`);
    return 0;
  });
  await gravar(res);
  if (juiz.why.length) console.warn(`[specOracle] julgamento parcial: ${juiz.why.join(" | ")}`);
  return res;
}
