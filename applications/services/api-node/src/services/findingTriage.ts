/**
 * findingTriage.ts — RFC-0005: controle de GAPs por finding (Ativos | Ignorados | Resolvidos | Refutados).
 *
 * Princípio (RFC-0004 §4): estado é determinístico e vive no banco; o LLM só opina.
 *  - Identidade: fingerprint SERVER-SIDE `file|source|category|anchor` (nunca linha, nunca título como
 *    primário — o validador reformula títulos em ~60% dos casos). Cascata de matching relaxante (Sonar
 *    Tracker): exato → `file|source|category|título normalizado` → Jaccard ≥ 0,8 no mesmo file+category.
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

export function normalizeText(s: string): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeCategory(raw: unknown): FindingCategory {
  const c = String(raw ?? "").trim().toLowerCase().replace(/[^a-z_]/g, "_");
  return (FINDING_CATEGORIES as readonly string[]).includes(c) ? (c as FindingCategory) : "other";
}

function sha(s: string): string { return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32); }

/** Fingerprint primário. Sem `anchor` → cai no título normalizado (findings antigos / LLM sem anchor). */
export function findingFingerprint(f: Pick<ValidationFinding, "file" | "source" | "title"> & { category?: string | null; anchor?: string | null }): string {
  const cat = normalizeCategory(f.category);
  const anchor = normalizeText(f.anchor ?? "");
  const key = anchor
    ? `${(f.file ?? "").toLowerCase()}|${f.source}|${cat}|${anchor}`
    : `${(f.file ?? "").toLowerCase()}|${f.source}|${cat}|t:${normalizeText(f.title)}`;
  return sha(key);
}
/** Fingerprint secundário (título) — usado na cascata quando o primário (anchor) não casa. */
export function findingTitleFingerprint(f: Pick<ValidationFinding, "file" | "source" | "title"> & { category?: string | null }): string {
  return sha(`${(f.file ?? "").toLowerCase()}|${f.source}|${normalizeCategory(f.category)}|t:${normalizeText(f.title)}`);
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

/** Cascata de matching: exato → fingerprint de título → Jaccard no mesmo file+category. */
export function matchTriage(f: ValidationFinding, triages: TriageRow[]): TriageRow | null {
  if (!triages.length) return null;
  const fp = findingFingerprint(f);
  const exact = triages.find((t) => t.fingerprint === fp);
  if (exact) return exact;
  const tfp = findingTitleFingerprint(f);
  const byTitle = triages.find((t) => t.fingerprint === tfp || (t.finding_snapshot as Snap)?.title_fingerprint === tfp);
  if (byTitle) return byTitle;
  const cat = normalizeCategory(f.category);
  let best: TriageRow | null = null, bestScore = 0;
  for (const t of triages) {
    const s = t.finding_snapshot as Snap;
    if ((s?.file ?? "").toLowerCase() !== (f.file ?? "").toLowerCase()) continue;
    if (normalizeCategory(s?.category) !== cat) continue;
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

export function enrichFindings(findings: ValidationFinding[], triages: TriageRow[]): EnrichedFinding[] {
  const now = Date.now();
  return findings.map((f) => {
    const t = matchTriage(f, triages);
    const expired = t?.state === "ignored" && t.expires_at && new Date(t.expires_at).getTime() < now;
    return {
      ...f,
      category: normalizeCategory(f.category),
      fingerprint: findingFingerprint(f),
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

/**
 * Resolvidos derivados: findings de runs anteriores (janela) ausentes na run atual há ≥ RESOLVED_AFTER_RUNS
 * runs válidas consecutivas (Stage A: 1). `runs` deve vir ordenado da mais recente para a mais antiga e
 * conter só status passed|failed. Arquivo que não existe mais na spec → fileRemoved.
 */
export function deriveResolved(
  runs: Array<{ id: string; created_at: string; findings: ValidationFinding[] }>,
  currentFiles: Set<string> | null,
): ResolvedFinding[] {
  if (runs.length < 2) return [];
  const present = new Map<string, number>(); // fingerprint → índice da run mais recente onde aparece
  const meta = new Map<string, { f: ValidationFinding; runId: string; at: string }>();
  runs.forEach((r, idx) => {
    for (const f of r.findings ?? []) {
      const fp = findingFingerprint(f);
      if (!present.has(fp)) { present.set(fp, idx); meta.set(fp, { f, runId: r.id, at: r.created_at }); }
    }
  });
  const out: ResolvedFinding[] = [];
  for (const [fp, idx] of present) {
    if (idx === 0) continue; // está na run atual → não resolvido
    const m = meta.get(fp)!;
    const absentRuns = idx; // runs mais recentes sem o finding
    const needed = m.f.source === "stage_a" ? 1 : RESOLVED_AFTER_RUNS;
    if (absentRuns < needed) continue;
    const fileRemoved = !!(currentFiles && m.f.file && !currentFiles.has(m.f.file.toLowerCase()));
    out.push({ fingerprint: fp, file: m.f.file, title: m.f.title, severity: m.f.severity, source: m.f.source,
      category: normalizeCategory(m.f.category), lastSeenRunId: m.runId, lastSeenAt: m.at, absentRuns, fileRemoved });
  }
  return out;
}

export async function projectFindingsState(db: Db, projectId: string, opts: { currentFiles?: string[] | null } = {}): Promise<ProjectFindingsState> {
  const runs = (await db.query(
    `SELECT id, created_at, findings FROM spec_validation_runs
      WHERE project_id = $1 AND status IN ('passed','failed')
      ORDER BY created_at DESC LIMIT $2`,
    [projectId, RESOLVED_WINDOW_RUNS],
  )).rows as unknown as Array<{ id: string; created_at: string; findings: ValidationFinding[] }>;
  const latest = runs[0] ?? null;
  const triages = await loadLiveTriages(db, projectId);
  const findings = enrichFindings((latest?.findings ?? []) as ValidationFinding[], triages);
  const files = opts.currentFiles ? new Set(opts.currentFiles.map((p) => p.toLowerCase())) : null;
  const resolved = deriveResolved(runs.map((r) => ({ ...r, findings: Array.isArray(r.findings) ? r.findings : [] })), files);
  return { latestRunId: latest?.id ?? null, findings, resolved, counts: countFindings(findings, resolved) };
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
  if (args.state === "refuted" && args.expiresAt) return { ok: false, status: 400, code: "REFUTED_NO_EXPIRY", message: "Refutação não expira (falso positivo é permanente até o trecho mudar)." };
  const fp = findingFingerprint(args.finding);
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

export async function revokeTriage(db: Db, args: { projectId: string; fingerprint: string; actor: TriageActor }): Promise<TriageRow | null> {
  if (args.actor.svc === "runner" || args.actor.role === "zentriz_admin") return null;
  const r = (await db.query(
    "UPDATE spec_finding_triage SET revoked_at = now(), revoked_by = $3 WHERE project_id = $1 AND fingerprint = $2 AND revoked_at IS NULL RETURNING *",
    [args.projectId, args.fingerprint, uuidOrNull(args.actor.id)],
  )).rows[0] as unknown as TriageRow | undefined;
  return r ?? null;
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
