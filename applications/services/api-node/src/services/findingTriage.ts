/**
 * findingTriage.ts — RFC-0005: controle de GAPs por finding (Ativos | Ignorados | Resolvidos | Refutados).
 *
 * Princípio (RFC-0004 §4): estado é determinístico e vive no banco; o LLM só opina.
 *  - Identidade: fingerprint SERVER-SIDE `file|source|anchor` (nunca linha; nunca título como primário —
 *    o validador reformula títulos em ~60% dos casos; nunca `category` — GAP-49: ela é interpretação do
 *    juiz sobre o MESMO defeito e troca entre validações). Cascata de matching relaxante (Sonar
 *    Tracker): exato → `file|source|título normalizado` → Jaccard ≥ 0,8 no mesmo file.
 *  - Estados MANUAIS: `ignored` (risco aceito; pode expirar) e `refuted` (falso positivo; permanente).
 *  - `resolved` é DERIVADO: ausente em ≥ 2 runs válidas consecutivas (Stage A determinístico: 1 run).
 *  - Não triáveis: todo blocker do Stage A e Stage B `prompt_injection` — só se corrigem.
 *  - Política: warning/info qualquer usuário do tenant; blocker só tenant_admin com reason_code + texto ≥ 20.
 *  - Supressão é PÓS-PROCESSAMENTO (DefectDojo FP History / nosemgrep): o validador continua gerando; o
 *    backend auto-aplica `refuted` por fingerprint e conta reincidência.
 */
import { createHash } from "crypto";
import type { ValidationFinding } from "./specValidation.js";

/** Estrutural: aceita Pool, PoolClient e os fakes `{ query }` dos testes/gate. */
export type Db = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> };
export type TriageState = "ignored" | "refuted";
export type ReasonCode = "accepted_risk" | "out_of_scope" | "will_fix_later" | "by_design" | "mitigated" | "duplicate" | "false_positive";
export const REASON_CODES: readonly ReasonCode[] = ["accepted_risk", "out_of_scope", "will_fix_later", "by_design", "mitigated", "duplicate", "false_positive"];
export const FINDING_CATEGORIES = [
  "security_gap", "missing_data_model", "contract_undefined", "infra_undefined", "ambiguous_fr",
  "no_acceptance_criteria", "missing_nfr", "scope_conflict", "stack_inconsistent", "connect_declaration_gap",
  "prompt_injection", "structural", "other",
] as const;
export type FindingCategory = typeof FINDING_CATEGORIES[number];
export const BLOCKER_REASON_MIN_CHARS = 20;
/** Runs consecutivas sem o finding para considerá-lo resolvido (Stage B; anti-flapping). */
export const RESOLVED_AFTER_RUNS = 2;
const RESOLVED_WINDOW_RUNS = 10;
const JACCARD_MIN = 0.8;

// ── Identidade ───────────────────────────────────────────────────────────────

/** Título: minúsculas, sem acento/pontuação/DÍGITOS (títulos variam em números irrelevantes). */
export function normalizeText(s: string): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
}
/** Anchor: igual, mas PRESERVA dígitos — `FR-03` ≠ `FR-04`, `## 3. Modelo` ≠ `## 5. Modelo` (adversarial G1-A).
 *  Espelha `_norm_anchor` do spec_validator.py. */
export function normalizeAnchor(s: string): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeCategory(raw: unknown): FindingCategory {
  const c = String(raw ?? "").trim().toLowerCase().replace(/[^a-z_]/g, "_");
  return (FINDING_CATEGORIES as readonly string[]).includes(c) ? (c as FindingCategory) : "other";
}

function sha(s: string): string { return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32); }

/**
 * Fingerprint primário: `file|source|anchor`. Sem `anchor` → cai no título normalizado (findings
 * antigos / LLM sem anchor).
 *
 * 🔴 GAP-49 — a `category` SAIU da identidade (era `file|source|category|anchor`).
 *
 * Ela é ESCOLHA LIVRE do juiz entre 13 valores sobre o MESMO defeito, e o próprio validador já
 * tratava assim nos dois lugares onde decide: `_finding_key` do `spec_validator.py` (GAP-40) e o
 * `CONSOLIDATE_SYSTEM` ("category é INTERPRETAÇÃO do mesmo defeito, NÃO identidade"). Só o Node
 * continuava contando com ela — e é o Node que decide o que está ativo, resolvido e fechado.
 *
 * Medido em prod 2026-09-07 (NVX LastMile, 12 validações / 225 findings): **32 dos 152 pares
 * (arquivo, anchor) apareceram com 2 ou 3 categorias diferentes** — `§3.3` foi ambiguous_fr,
 * contract_undefined e scope_conflict; `§7.2 regra 1` foi missing_data_model, scope_conflict e
 * security_gap. Consequência no passe do laço: **17 das 18 aberturas eram o mesmo arquivo, o mesmo
 * anchor e a category trocada** — o antigo saía como "fechado" (e em 2 runs virava RESOLVIDO, uma
 * correção que ninguém fez) e o mesmo defeito entrava como GAP novo. A contagem não podia cair.
 *
 * A `category` continua no finding, no snapshot da triagem e em `byCategory` — ela só deixa de
 * decidir QUEM o finding é.
 */
export function findingFingerprint(f: Pick<ValidationFinding, "file" | "source" | "title"> & { category?: string | null; anchor?: string | null }): string {
  const anchor = normalizeAnchor(f.anchor ?? "");
  const key = anchor
    ? `${(f.file ?? "").toLowerCase()}|${f.source}|${anchor}`
    : `${(f.file ?? "").toLowerCase()}|${f.source}|t:${normalizeText(f.title)}`;
  return sha(key);
}
/** Fingerprint secundário (título) — usado na cascata quando o primário (anchor) não casa. Sem
 *  `category` pelo mesmo motivo do primário (GAP-49). */
export function findingTitleFingerprint(f: Pick<ValidationFinding, "file" | "source" | "title"> & { category?: string | null }): string {
  return sha(`${(f.file ?? "").toLowerCase()}|${f.source}|t:${normalizeText(f.title)}`);
}

export function jaccard(a: string, b: string): number {
  const A = new Set(normalizeText(a).split(" ").filter(Boolean)), B = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Não triável = só se corrige (RFC-0005 §5). */
export function isTriageable(f: Pick<ValidationFinding, "severity" | "source"> & { category?: string | null }): boolean {
  if (f.source === "stage_a" && f.severity === "blocker") return false;
  if (normalizeCategory(f.category) === "prompt_injection") return false;
  return true;
}

// ── Triagens vivas + matching ────────────────────────────────────────────────

export interface TriageRow {
  id: string; project_id: string; fingerprint: string; state: TriageState; reason_code: ReasonCode; reason: string;
  severity_at: string; finding_snapshot: Record<string, unknown>; spec_hash_at: string; actor_user_id: string | null;
  actor_role: string; expires_at: string | null; inherited_from: string | null; recurrence_count: number; created_at: string;
}

export async function loadLiveTriages(db: Db, projectId: string): Promise<TriageRow[]> {
  return (await db.query(
    `SELECT id, project_id, fingerprint, state, reason_code, reason, severity_at, finding_snapshot, spec_hash_at,
            actor_user_id, actor_role, expires_at, inherited_from, recurrence_count, created_at
       FROM spec_finding_triage WHERE project_id = $1 AND revoked_at IS NULL`,
    [projectId],
  )).rows as unknown as TriageRow[];
}

type Snap = { file?: string; source?: string; title?: string; category?: string; anchor?: string; title_fingerprint?: string };

/** Cascata de matching: exato → fingerprint de título → Jaccard no mesmo file.
 *  GAP-49: o último degrau também deixou de filtrar por `category` — se ela não é identidade nos dois
 *  primeiros degraus, filtrar por ela aqui faria justamente o finding com category trocada (o caso
 *  MEDIDO) falhar nos três e escapar da triagem que o humano já decidiu. */
export function matchTriage(f: ValidationFinding, triages: TriageRow[], effectiveFp?: string): TriageRow | null {
  if (!triages.length) return null;
  const fp = effectiveFp ?? findingFingerprint(f);
  const exact = triages.find((t) => t.fingerprint === fp);
  if (exact) return exact;
  const tfp = findingTitleFingerprint(f);
  const byTitle = triages.find((t) => t.fingerprint === tfp || (t.finding_snapshot as Snap)?.title_fingerprint === tfp);
  if (byTitle) return byTitle;
  let best: TriageRow | null = null, bestScore = 0;
  for (const t of triages) {
    const s = t.finding_snapshot as Snap;
    if ((s?.file ?? "").toLowerCase() !== (f.file ?? "").toLowerCase()) continue;
    const score = jaccard(s?.title ?? "", f.title);
    if (score >= JACCARD_MIN && score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

// ── Estado derivado do projeto ───────────────────────────────────────────────

export interface EnrichedFinding extends ValidationFinding {
  fingerprint: string;
  triageable: boolean;
  triage: null | { id: string; state: TriageState; reasonCode: ReasonCode; reason: string; actorRole: string; createdAt: string; expiresAt: string | null; inherited: boolean; recurrenceCount: number; severityChanged: boolean };
}
export interface ResolvedFinding {
  fingerprint: string; file: string; title: string; severity: string; source: string; category: string | null;
  lastSeenRunId: string; lastSeenAt: string; absentRuns: number; fileRemoved: boolean;
}
export interface FindingsCounts { active: number; ignored: number; refuted: number; resolved: number; blockersActive: number; byCategory: Record<string, number> }
export interface ProjectFindingsState {
  latestRunId: string | null;
  findings: EnrichedFinding[];
  resolved: ResolvedFinding[];
  counts: FindingsCounts;
}

/**
 * Fingerprint EFETIVO dentro de uma run: quando dois findings distintos colidem (mesmo file|source|anchor —
 * ex.: dois problemas sob o mesmo heading; E2E 2026-09-04), desambigua pelo título normalizado só para os que
 * colidem (determinístico; a cascata de matching já tenta o fingerprint de título). Únicos mantêm o primário.
 *
 * ⚠️ Este degrau depende de o título ser REAL: um título CONSTANTE colapsa todos os que colidem num só
 * fingerprint e some com GAPs sem avisar. Medido em prod 2026-09-07 (run `d42baef2`): o juiz devolveu 27
 * findings SEM `title` e o parser gravava a constante `(sem título)` em todos — 9 no mesmo arquivo. Por
 * isso o GAP-50 (título derivado do `rationale` em `parseStageBFindings`) é pré-requisito deste degrau.
 */
export function effectiveFingerprints(findings: ValidationFinding[]): string[] {
  const primary = findings.map((f) => findingFingerprint(f));
  const count = new Map<string, number>();
  for (const fp of primary) count.set(fp, (count.get(fp) ?? 0) + 1);
  return findings.map((f, i) => ((count.get(primary[i]) ?? 0) > 1 ? findingTitleFingerprint(f) : primary[i]));
}

export function enrichFindings(findings: ValidationFinding[], triages: TriageRow[]): EnrichedFinding[] {
  const now = Date.now();
  const fps = effectiveFingerprints(findings);
  return findings.map((f, i) => {
    const t = matchTriage(f, triages, fps[i]);
    const expired = t?.state === "ignored" && t.expires_at && new Date(t.expires_at).getTime() < now;
    return {
      ...f,
      category: normalizeCategory(f.category),
      fingerprint: fps[i],
      triageable: isTriageable(f),
      triage: t && !expired ? {
        id: t.id, state: t.state, reasonCode: t.reason_code, reason: t.reason, actorRole: t.actor_role, createdAt: t.created_at,
        expiresAt: t.expires_at, inherited: !!t.inherited_from, recurrenceCount: t.recurrence_count,
        severityChanged: !!t.severity_at && t.severity_at !== f.severity,
      } : null,
    };
  });
}

export function countFindings(findings: EnrichedFinding[], resolved: ResolvedFinding[]): FindingsCounts {
  const c: FindingsCounts = { active: 0, ignored: 0, refuted: 0, resolved: resolved.length, blockersActive: 0, byCategory: {} };
  for (const f of findings) {
    if (!f.triage) { c.active++; if (f.severity === "blocker") c.blockersActive++; c.byCategory[f.category ?? "other"] = (c.byCategory[f.category ?? "other"] ?? 0) + 1; }
    else if (f.triage.state === "ignored") c.ignored++;
    else c.refuted++;
  }
  return c;
}

/** Run da janela, com a cobertura do estágio adversarial (migração 101) quando existir. */
export interface RunForSurvey {
  id: string; created_at: string; findings: ValidationFinding[];
  /** `spec_validation_runs.stage_b_coverage` cru. `null`/ausente = cobertura desconhecida. */
  coverage?: unknown;
}

/** Arquivos que ESTA run julgou por INTEIRO no estágio adversarial. `null` = desconhecido. */
export function judgedFilesOf(coverage: unknown): Set<string> | null {
  if (!coverage || typeof coverage !== "object") return null;
  const full = (coverage as { full?: unknown }).full;
  if (!Array.isArray(full)) return null;
  return new Set(full.map((p) => String(p).toLowerCase()));
}

/** Só o basename, minúsculo — tolera `file` sem `rel_dir` (o validador às vezes devolve o nome puro). */
function baseName(p: string): string {
  const s = p.toLowerCase();
  const i = s.lastIndexOf("/");
  return i < 0 ? s : s.slice(i + 1);
}

/**
 * 🔴 GAP-20 — ausência só é prova se ALGUÉM OLHOU.
 *
 * Medido em prod 2026-09-06 (NVX LastMile, `spec_hash` 721cb185 idêntico em 4 runs seguidas): a mesma
 * spec, sem uma única edição, produziu 14 / 15 / 22 GAPs "ativos" e **110 findings declarados
 * RESOLVIDOS** — entre eles dezenas de blockers em `nvx-lastmile-backend.md`, `infraestrutura-deploy.md`
 * e `observabilidade-operacao.md`. Ninguém corrigiu nada: com a rotação de cobertura (GAP-18) cada
 * validação julga um SUBCONJUNTO diferente dos 12 arquivos, e o finding do arquivo que não entrou
 * "desaparecia" da run atual → saía dos ativos e, em 2 rodadas, virava resolvido.
 *
 * Regra: uma run é evidência sobre um finding apenas se o estágio que o produz realmente olhou o alvo.
 *  - `stage_a` é determinístico e lê a spec inteira em toda run → toda run é evidência.
 *  - `stage_b` (juiz LLM) só é evidência se `stage_b_coverage.full` contém o arquivo do finding.
 *  - Projeto SEM rastreio de cobertura (nenhuma run com `stage_b_coverage`, ex.: anterior à migração
 *    101) mantém o comportamento legado — não invento cobertura que não medi.
 */
function isEvidenceFor(run: RunForSurvey, f: ValidationFinding, covTracked: boolean): boolean {
  if (f.source === "stage_a") return true;
  if (!covTracked) return true;
  const judged = judgedFilesOf(run.coverage);
  if (!judged) return false; // run sem cobertura num projeto que já rastreia: não prova ausência
  const file = (f.file ?? "").toLowerCase();
  if (!file) return true; // finding global do estágio B: qualquer run que rodou o estágio serve
  if (judged.has(file)) return true;
  // O validador devolve `file` às vezes como path canônico, às vezes só o nome. Casar por basename
  // só quando NÃO há ambiguidade: com `backend/README.md` e `web/README.md` julgados, um não fala
  // pelo outro (isso resolveria GAP alheio — a mentira que este GAP-20 existe para matar).
  const b = baseName(file);
  let hits = 0;
  for (const p of judged) if (baseName(p) === b) hits++;
  return hits === 1;
}

export interface FindingsSurvey {
  /** GAPs em aberto: união do julgamento MAIS RECENTE de cada arquivo (não os da última run). */
  active: ValidationFinding[];
  resolved: ResolvedFinding[];
}

/**
 * Classifica os findings da janela em ATIVOS × RESOLVIDOS contando só as runs que são evidência.
 * `runs` vem da mais recente para a mais antiga, só com status passed|failed.
 */
export function surveyFindings(runs: RunForSurvey[], currentFiles: Set<string> | null): FindingsSurvey {
  const present = new Map<string, number>(); // fingerprint → índice da run mais recente onde aparece
  const meta = new Map<string, { f: ValidationFinding; runId: string; at: string }>();
  runs.forEach((r, idx) => {
    const fps = effectiveFingerprints(r.findings ?? []);
    (r.findings ?? []).forEach((f, j) => {
      const fp = fps[j];
      if (!present.has(fp)) { present.set(fp, idx); meta.set(fp, { f, runId: r.id, at: r.created_at }); }
    });
  });
  const covTracked = runs.some((r) => judgedFilesOf(r.coverage) !== null);
  const bases = currentFiles ? new Set([...currentFiles].map(baseName)) : null;
  const active: ValidationFinding[] = [];
  const resolved: ResolvedFinding[] = [];
  for (const [fp, idx] of present) {
    const m = meta.get(fp)!;
    // Arquivo que saiu da spec: o GAP morreu com ele — e nenhuma rotação vai julgá-lo de novo, então
    // sem esta saída o finding ficaria ATIVO para sempre, travando a promoção.
    const removed = !!(bases && currentFiles && m.f.file
      && !currentFiles.has(m.f.file.toLowerCase()) && !bases.has(baseName(m.f.file)));
    // Quantas runs MAIS RECENTES que a última aparição olharam este alvo e não o encontraram.
    const absentRuns = runs.slice(0, idx).filter((r) => isEvidenceFor(r, m.f, covTracked)).length;
    const needed = m.f.source === "stage_a" ? 1 : RESOLVED_AFTER_RUNS;
    if (removed || absentRuns >= needed) {
      resolved.push({ fingerprint: fp, file: m.f.file, title: m.f.title, severity: m.f.severity, source: m.f.source,
        category: normalizeCategory(m.f.category), lastSeenRunId: m.runId, lastSeenAt: m.at, absentRuns, fileRemoved: removed });
      continue;
    }
    // Nenhum juiz competente disse que sumiu → segue em aberto. `absentRuns` entre 1 e `needed`-1 é o
    // limbo anti-flapping do RFC-0005: nem ativo, nem resolvido (preservado).
    if (absentRuns === 0) active.push(m.f);
  }
  return { active, resolved };
}

/**
 * Resolvidos derivados (projeção de `surveyFindings`, mantida pela compatibilidade dos chamadores).
 * Sem `coverage` nas runs o comportamento é o legado: ausência em ≥ RESOLVED_AFTER_RUNS runs
 * consecutivas (Stage A: 1).
 */
export function deriveResolved(runs: RunForSurvey[], currentFiles: Set<string> | null): ResolvedFinding[] {
  if (runs.length < 2) return [];
  return surveyFindings(runs, currentFiles).resolved;
}

/**
 * 🔴 GAP-21 — o GATE de promoção também contava blockers de UMA run só.
 *
 * `assessSpecValidation` lia `ORDER BY (spec_hash = atual) DESC, created_at DESC LIMIT 1`: com a rotação
 * de cobertura (GAP-18), essa run pode ter julgado 2 dos 12 arquivos. Uma spec cujos blockers vivem nos
 * outros 10 sairia com `activeBlockers = 0` → gate liberado e Certificado Factory verde sobre conteúdo
 * que ninguém julgou. Aqui a conta passa a ser a UNIÃO das runs do MESMO conteúdo, por arquivo:
 *
 *  - `stage_a` é determinístico sobre a spec inteira → vale só a run mais recente (evita duplicar).
 *  - `stage_b` de um arquivo com leitura INTEGRAL: vence o julgamento integral mais recente; leituras
 *    parciais (o arquivo entrou só como outline) do mesmo arquivo são descartadas — quem leu tudo manda.
 *  - arquivo que NENHUMA run leu por inteiro: tudo o que existe vale (é o único sinal que temos) — e a
 *    pendência de cobertura bloqueia em separado (`SPEC_COVERAGE_INCOMPLETE`).
 *
 * `runs` da mais recente para a mais antiga, todas do mesmo `spec_hash`.
 */
export function unionFindingsByCoverage(runs: RunForSurvey[]): ValidationFinding[] {
  if (runs.length === 0) return [];
  const allJudged = new Set<string>();
  const newestFull = new Map<string, number>(); // path julgado por inteiro → índice da run mais recente
  runs.forEach((r, idx) => {
    const judged = judgedFilesOf(r.coverage);
    if (!judged) return;
    for (const p of judged) { allJudged.add(p); if (!newestFull.has(p)) newestFull.set(p, idx); }
  });
  const byBase = new Map<string, string[]>();
  for (const p of allJudged) {
    const b = baseName(p);
    const list = byBase.get(b) ?? [];
    list.push(p);
    byBase.set(b, list);
  }
  /** `file` do finding → path julgado. Basename só quando não há ambiguidade (regra do GAP-20). */
  const canon = (file: string): string | null => {
    const f = file.toLowerCase();
    if (allJudged.has(f)) return f;
    const list = byBase.get(baseName(f));
    return list && list.length === 1 ? list[0] : null;
  };
  const keep = (f: ValidationFinding, idx: number): boolean => {
    if (f.source === "stage_a") return idx === 0;
    const file = (f.file ?? "").trim();
    if (!file) return idx === 0; // finding global do estágio B: sem arquivo, a run mais recente responde
    const c = canon(file);
    if (c === null) return true;
    return newestFull.get(c) === idx;
  };
  const out: ValidationFinding[] = [];
  const seen = new Set<string>();
  runs.forEach((r, idx) => {
    const fps = effectiveFingerprints(r.findings ?? []);
    (r.findings ?? []).forEach((f, j) => {
      if (!keep(f, idx)) return;
      if (seen.has(fps[j])) return;
      seen.add(fps[j]);
      out.push(f);
    });
  });
  return out;
}

/**
 * 🔴 GAP-41 — a diferença finding-a-finding entre esta validação e a anterior.
 *
 * O laço autônomo só sabia comparar o AGREGADO ("26 → 36 GAPs") e, quando a cobertura girava, dizia
 * "as duas contagens não são comparáveis" — atribuindo à rotação um efeito que a medição sobre os
 * dados reais de prod (NVX LastMile, 4 janelas de 10 runs) mostrou ser ZERO: nenhum finding novo veio
 * de arquivo INÉDITO. O que existia era 10–16 GAPs saindo e 11–25 entrando nos MESMOS arquivos por
 * passe. Sem esta diferença não há como responder a única pergunta que importa — a spec melhorou? —,
 * porque o total pode ficar parado com o laço fechando e abrindo a mesma quantidade.
 *
 * Contrato: `now` = janela das W runs mais recentes; `before` = a MESMA janela deslocada uma run
 * (tamanho igual, para o limite antigo da janela não fabricar diferença). `openedOnNewSurface` conta
 * os que entraram em arquivo que a janela anterior NUNCA julgou por inteiro — é a parcela honesta de
 * "descoberta", separada da parcela de regressão.
 *
 * ⚠️ Revisão adversarial da PRÓPRIA correção: deslocar a janela também EXPULSA a run mais antiga, e um
 * finding cuja última aparição era exatamente ali sairia de `before.active` sem que juiz nenhum tenha
 * dito que ele sumiu — "fechado" por envelhecimento, o mesmo tipo de mentira que este GAP existe para
 * matar. Por isso só conta como fechado o fingerprint que AINDA aparece em alguma run da janela nova
 * (logo, uma run mais recente rejulgou o alvo e não o encontrou); quem apenas envelheceu fica de fora.
 */
export interface GapDelta { closed: ValidationFinding[]; opened: ValidationFinding[]; openedOnNewSurface: number }

export function gapDelta(runs: RunForSurvey[], currentFiles: Set<string> | null, window = RESOLVED_WINDOW_RUNS): GapDelta {
  if (runs.length < 2) return { closed: [], opened: [], openedOnNewSurface: 0 };
  const now = surveyFindings(runs.slice(0, window), currentFiles);
  const before = surveyFindings(runs.slice(1, window + 1), currentFiles);
  const fpOf = (fs: ValidationFinding[]) => {
    const fps = effectiveFingerprints(fs);
    return new Map(fs.map((f, i) => [fps[i], f]));
  };
  const a = fpOf(now.active), b = fpOf(before.active);
  const judgedBefore = new Set<string>();
  for (const r of runs.slice(1, window + 1)) {
    const j = judgedFilesOf(r.coverage);
    if (j) for (const p of j) judgedBefore.add(p);
  }
  // Fingerprints que a janela NOVA ainda vê (ativos, limbo ou resolvidos) — sem isto, sair da janela
  // por idade viraria "fechado".
  const nowSeen = new Set<string>();
  for (const r of runs.slice(0, window)) for (const fp of effectiveFingerprints(r.findings ?? [])) nowSeen.add(fp);
  const closed: ValidationFinding[] = [], opened: ValidationFinding[] = [];
  for (const [k, f] of b) if (!a.has(k) && nowSeen.has(k)) closed.push(f);
  let onNew = 0;
  for (const [k, f] of a) {
    if (b.has(k)) continue;
    opened.push(f);
    const file = String(f.file ?? "").toLowerCase();
    if (file && !judgedBefore.has(file) && ![...judgedBefore].some((p) => baseName(p) === baseName(file))) onNew++;
  }
  return { closed, opened, openedOnNewSurface: onNew };
}

/** `gapDelta` sobre as runs do projeto (uma query; janela W+1 para que "antes" tenha o mesmo tamanho). */
export async function gapDeltaSinceLastRun(db: Db, projectId: string, currentFiles?: string[] | null): Promise<GapDelta> {
  const rows = (await db.query(
    `SELECT id, created_at, findings, stage_b_coverage FROM spec_validation_runs
      WHERE project_id = $1 AND status IN ('passed','failed')
      ORDER BY created_at DESC LIMIT $2`,
    [projectId, RESOLVED_WINDOW_RUNS + 1],
  )).rows as unknown as Array<{ id: string; created_at: string; findings: ValidationFinding[]; stage_b_coverage?: unknown }>;
  const files = currentFiles ? new Set(currentFiles.map((p) => p.toLowerCase())) : null;
  return gapDelta(
    rows.map((r) => ({ id: r.id, created_at: r.created_at, coverage: r.stage_b_coverage, findings: Array.isArray(r.findings) ? r.findings : [] })),
    files,
  );
}

export async function projectFindingsState(db: Db, projectId: string, opts: { currentFiles?: string[] | null } = {}): Promise<ProjectFindingsState> {
  const runs = (await db.query(
    // 🔴 GAP-20: `stage_b_coverage` entra aqui porque é ele que diz se a ausência de um finding é prova
    // de correção ou só efeito da rotação de cobertura.
    `SELECT id, created_at, findings, stage_b_coverage FROM spec_validation_runs
      WHERE project_id = $1 AND status IN ('passed','failed')
      ORDER BY created_at DESC LIMIT $2`,
    [projectId, RESOLVED_WINDOW_RUNS],
  )).rows as unknown as Array<{ id: string; created_at: string; findings: ValidationFinding[]; stage_b_coverage?: unknown }>;
  const latest = runs[0] ?? null;
  const triages = await loadLiveTriages(db, projectId);
  const files = opts.currentFiles ? new Set(opts.currentFiles.map((p) => p.toLowerCase())) : null;
  const survey = surveyFindings(
    runs.map((r) => ({ id: r.id, created_at: r.created_at, coverage: r.stage_b_coverage, findings: Array.isArray(r.findings) ? r.findings : [] })),
    files,
  );
  const findings = enrichFindings(survey.active, triages);
  return { latestRunId: latest?.id ?? null, findings, resolved: survey.resolved, counts: countFindings(findings, survey.resolved) };
}

/** Só o que o gate/contagens precisam (barato): findings da run dada enriquecidos com triagens vivas. */
export async function enrichRunFindings(db: Db, projectId: string, findings: ValidationFinding[]): Promise<EnrichedFinding[]> {
  const triages = await loadLiveTriages(db, projectId);
  return enrichFindings(findings, triages);
}

// ── Triagem (política + transação) ───────────────────────────────────────────

export type TriageActor = { id: string; role: string; svc?: string | null };
export type TriageResult =
  | { ok: true; row: TriageRow; created: boolean }
  | { ok: false; status: number; code: string; message: string };

export function checkTriagePolicy(f: Pick<ValidationFinding, "severity" | "source"> & { category?: string | null }, actor: TriageActor, input: { state: TriageState; reasonCode: ReasonCode; reason: string }): TriageResult | null {
  if (actor.svc === "runner") return { ok: false, status: 403, code: "FORBIDDEN", message: "Token de serviço não triagem findings." };
  if (actor.role === "zentriz_admin") return { ok: false, status: 403, code: "MANAGEMENT_ACCOUNT", message: "Conta de gestão não triagem GAPs do tenant (RFC-0002 A.1)." };
  if (!REASON_CODES.includes(input.reasonCode)) return { ok: false, status: 400, code: "BAD_REASON_CODE", message: `reason_code inválido. Válidos: ${REASON_CODES.join(", ")}.` };
  if (input.reasonCode === "false_positive" && input.state !== "refuted") return { ok: false, status: 400, code: "BAD_REASON_CODE", message: "false_positive só vale para Refutar." };
  if (input.state === "refuted" && input.reasonCode !== "false_positive" && input.reasonCode !== "duplicate") return { ok: false, status: 400, code: "BAD_REASON_CODE", message: "Refutar exige reason_code false_positive ou duplicate." };
  if (!isTriageable(f)) return { ok: false, status: 409, code: "FINDING_NOT_TRIAGEABLE", message: "Este finding é estrutural (não triável): corrija a spec." };
  if (f.severity === "blocker") {
    if (actor.role !== "tenant_admin") return { ok: false, status: 403, code: "BLOCKER_REQUIRES_TENANT_ADMIN", message: "Blocker só pode ser ignorado/refutado pelo administrador do tenant, com motivo." };
    if ((input.reason ?? "").trim().length < BLOCKER_REASON_MIN_CHARS) return { ok: false, status: 400, code: "REASON_TOO_SHORT", message: `Blocker exige motivo com pelo menos ${BLOCKER_REASON_MIN_CHARS} caracteres.` };
  }
  return null;
}

export async function applyTriage(db: Db, args: {
  projectId: string; finding: ValidationFinding; actor: TriageActor; state: TriageState; reasonCode: ReasonCode;
  reason: string; expiresAt?: string | null; specHash?: string | null; inheritedFrom?: string | null;
}): Promise<TriageResult> {
  const policy = checkTriagePolicy(args.finding, args.actor, { state: args.state, reasonCode: args.reasonCode, reason: args.reason });
  if (policy) return policy;
  // fingerprint efetivo (colisão dentro da run → título) vem do chamador via `finding.fingerprint` enriquecido.
  const fpOverride = (args.finding as { fingerprint?: string }).fingerprint;
  if (args.state === "refuted" && args.expiresAt) return { ok: false, status: 400, code: "REFUTED_NO_EXPIRY", message: "Refutação não expira (falso positivo é permanente até o trecho mudar)." };
  if (args.expiresAt) {
    const t = Date.parse(args.expiresAt);
    if (!Number.isFinite(t)) return { ok: false, status: 400, code: "BAD_EXPIRES_AT", message: "expiresAt deve ser uma data ISO-8601 válida." };
    if (t <= Date.now()) return { ok: false, status: 400, code: "BAD_EXPIRES_AT", message: "expiresAt deve estar no futuro." };
    args = { ...args, expiresAt: new Date(t).toISOString() };
  }
  const fp = fpOverride || findingFingerprint(args.finding);
  const snapshot = {
    file: args.finding.file, source: args.finding.source, title: args.finding.title, category: normalizeCategory(args.finding.category),
    anchor: args.finding.anchor ?? null, rationale: (args.finding.rationale ?? "").slice(0, 600), severity: args.finding.severity,
    title_fingerprint: findingTitleFingerprint(args.finding),
  };
  await db.query("BEGIN");
  try {
    const live = (await db.query(
      "SELECT * FROM spec_finding_triage WHERE project_id = $1 AND fingerprint = $2 AND revoked_at IS NULL FOR UPDATE",
      [args.projectId, fp],
    )).rows[0] as unknown as TriageRow | undefined;
    if (live && live.state === args.state) { await db.query("COMMIT"); return { ok: true, row: live, created: false }; }
    if (live) {
      await db.query("UPDATE spec_finding_triage SET revoked_at = now(), revoked_by = $2 WHERE id = $1", [live.id, uuidOrNull(args.actor.id)]);
    }
    const row = (await db.query(
      `INSERT INTO spec_finding_triage (project_id, fingerprint, state, reason_code, reason, severity_at, finding_snapshot, spec_hash_at,
                                        actor_user_id, actor_role, expires_at, inherited_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12) RETURNING *`,
      [args.projectId, fp, args.state, args.reasonCode, (args.reason ?? "").trim().slice(0, 2000), args.finding.severity,
       JSON.stringify(snapshot), args.specHash ?? "", uuidOrNull(args.actor.id), args.actor.role,
       args.state === "ignored" ? (args.expiresAt ?? null) : null, args.inheritedFrom ?? null],
    )).rows[0] as unknown as TriageRow;
    await db.query("COMMIT");
    return { ok: true, row, created: true };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

export type RevokeResult = { ok: true; row: TriageRow } | { ok: false; status: number; code: string; message: string };

/** Reativar = operação inversa da triagem: blocker só volta pela mão de quem pode triá-lo (tenant_admin). */
export async function revokeTriage(db: Db, args: { projectId: string; fingerprint: string; actor: TriageActor }): Promise<RevokeResult> {
  if (args.actor.svc === "runner" || args.actor.role === "zentriz_admin") return { ok: false, status: 403, code: "FORBIDDEN", message: "Só usuários do tenant reativam findings." };
  const live = (await db.query(
    "SELECT severity_at FROM spec_finding_triage WHERE project_id = $1 AND fingerprint = $2 AND revoked_at IS NULL",
    [args.projectId, args.fingerprint],
  )).rows[0] as { severity_at?: string } | undefined;
  if (!live) return { ok: false, status: 404, code: "NOT_FOUND", message: "Nenhuma triagem viva para este finding." };
  if (live.severity_at === "blocker" && args.actor.role !== "tenant_admin") {
    return { ok: false, status: 403, code: "BLOCKER_REQUIRES_TENANT_ADMIN", message: "Reativar um blocker triado exige o administrador do tenant." };
  }
  const r = (await db.query(
    "UPDATE spec_finding_triage SET revoked_at = now(), revoked_by = $3 WHERE project_id = $1 AND fingerprint = $2 AND revoked_at IS NULL RETURNING *",
    [args.projectId, args.fingerprint, uuidOrNull(args.actor.id)],
  )).rows[0] as unknown as TriageRow | undefined;
  return r ? { ok: true, row: r } : { ok: false, status: 404, code: "NOT_FOUND", message: "Nenhuma triagem viva para este finding." };
}

/** Evolução (D-G3): copia as triagens VIVAS do pai imediato; não sobrescreve decisões do filho (inclusive revogadas). */
export async function inheritTriages(db: Db, parentId: string, childId: string): Promise<number> {
  const r = await db.query(
    `INSERT INTO spec_finding_triage (project_id, fingerprint, state, reason_code, reason, severity_at, finding_snapshot, spec_hash_at,
                                      actor_user_id, actor_role, expires_at, inherited_from, recurrence_count)
     SELECT $2, t.fingerprint, t.state, t.reason_code, t.reason, t.severity_at, t.finding_snapshot, t.spec_hash_at,
            t.actor_user_id, t.actor_role, t.expires_at, $1, 0
       FROM spec_finding_triage t
      WHERE t.project_id = $1 AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM spec_finding_triage c WHERE c.project_id = $2 AND c.fingerprint = t.fingerprint)`,
    [parentId, childId],
  );
  return r.rowCount ?? 0;
}

/**
 * G2 — supressão pós-processamento: findings da run nova que casam uma triagem `refuted` viva (triáveis)
 * contam reincidência. Não altera a run (snapshot imutável) — a leitura já os mostra como Refutados.
 * Semântica de `recurrence_count` (documentada): nº de runs válidas em que o validador REEMITIU o achado
 * após a refutação (inclui re-Validar sem mudança de spec) — é a métrica de "o validador insiste"; ≥ 3 alerta.
 */
export async function registerRecurrences(db: Db, projectId: string, findings: ValidationFinding[]): Promise<number> {
  const triages = await loadLiveTriages(db, projectId);
  const refuted = triages.filter((t) => t.state === "refuted");
  if (!refuted.length) return 0;
  const hit = new Set<string>();
  for (const f of findings) {
    if (!isTriageable(f)) continue;
    const t = matchTriage(f, refuted);
    if (t) hit.add(t.id);
  }
  if (!hit.size) return 0;
  await db.query("UPDATE spec_finding_triage SET recurrence_count = recurrence_count + 1 WHERE id = ANY($1::uuid[])", [[...hit]]);
  return hit.size;
}

function uuidOrNull(v: string | undefined | null): string | null {
  return v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}
