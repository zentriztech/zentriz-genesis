// Enriquecimento determinístico da Bancada (RFC-0003 §9 — E2 Viabilidade/Prontidão + E3
// Estimativa de custo/tempo). REGRA DE OURO: tudo aqui é DETERMINÍSTICO (aritmética + SQL
// de agregação), SEM LLM — o custo/latência de um LLM mataria o "custo ~zero" da Bancada.
//
// Fonte dos sinais (o que /api/specs já tem em mãos + 2 agregados baratos):
//   • título        → coluna projects.title
//   • tech definida  → extra->>'project_type' (gravado na criação/decomposição)
//   • deps prontas   → project_triggers (predecessores) + status do predecessor
//   • estimativa     → histórico de pipeline_runs agregado por complexity_hint (E3)
//
// As funções puras (computeReadiness/buildEstimator/pickEstimate) não tocam o banco →
// são unit-testáveis isoladamente. enrichSpecs() é o orquestrador fino que roda o SQL.

// ── Tipos expostos ────────────────────────────────────────────────────────────
export type ReadinessCheckKey = "title" | "tech" | "deps" | "estimate";

export interface ReadinessCheck {
  key: ReadinessCheckKey;
  label: string;
  ok: boolean;
  hint: string; // o que fazer quando não-ok (guia a decisão de promover)
}
export interface Readiness {
  score: number; // 0..100
  level: "not_ready" | "almost" | "ready";
  checks: ReadinessCheck[];
}
export interface Estimate {
  durationSec: number;
  costUsd: number;
  basis: "history" | "default"; // history = veio de runs reais; default = chute por complexidade
  sampleSize: number;
  complexity: string;
}

// Linha de spec mínima que os enrichers precisam.
export interface SpecForEnrichment {
  id: string;
  title: string | null;
  status: string;
  extra: Record<string, unknown> | null;
  complexity_hint?: string | null;
}
// Sinal de dependência agregado de project_triggers (predecessores desta spec).
export interface DepSignal {
  total: number; // nº de predecessores
  accepted: number; // predecessores já "concluídos" — completed OU accepted (mesma regra do dependencyGate)
}
// Bucket de histórico (pipeline_runs ∪ projects) por complexidade.
export interface HistoryBucket {
  complexity: string;
  sampleSize: number;
  avgDurationSec: number;
  avgCostUsd: number;
}

// Rótulos placeholder que NÃO contam como título de verdade.
const PLACEHOLDER_TITLE_RE =
  /^(sem\s*t[ií]tulo|untitled|nova\s*spec|new\s*spec|rascunho|draft|proje[ct]+o?|teste?)\s*\.?$/i;

// Defaults determinísticos por complexidade quando não há histórico (E3 fallback).
// Números conservadores/aproximados — a UI deixa claro que é estimativa sem histórico.
const DEFAULTS: Record<string, { durationSec: number; costUsd: number }> = {
  trivial: { durationSec: 5 * 60, costUsd: 0.5 },
  low: { durationSec: 15 * 60, costUsd: 1.5 },
  medium: { durationSec: 40 * 60, costUsd: 5 },
  high: { durationSec: 120 * 60, costUsd: 15 },
};
const DEFAULT_COMPLEXITY = "medium";

function normalizeComplexity(c: string | null | undefined): string {
  const v = (c ?? "").trim().toLowerCase();
  return v in DEFAULTS ? v : DEFAULT_COMPLEXITY;
}

// ── E3: estimador ───────────────────────────────────────────────────────────
// Constrói uma função pura complexity → Estimate a partir dos buckets históricos.
// Se um bucket não tem amostra, cai no default daquela complexidade (basis="default").
export function buildEstimator(buckets: HistoryBucket[]): (complexity: string | null | undefined) => Estimate {
  const byComplexity = new Map<string, HistoryBucket>();
  for (const b of buckets) byComplexity.set(normalizeComplexity(b.complexity), b);
  return (complexityRaw) => {
    const complexity = normalizeComplexity(complexityRaw);
    const hist = byComplexity.get(complexity);
    if (hist && hist.sampleSize > 0 && hist.avgDurationSec > 0) {
      return {
        durationSec: Math.round(hist.avgDurationSec),
        costUsd: Math.round(hist.avgCostUsd * 100) / 100,
        basis: "history",
        sampleSize: hist.sampleSize,
        complexity,
      };
    }
    const def = DEFAULTS[complexity];
    return { durationSec: def.durationSec, costUsd: def.costUsd, basis: "default", sampleSize: 0, complexity };
  };
}

// ── E2: prontidão/viabilidade (pré-flight) ────────────────────────────────────
export function computeReadiness(spec: SpecForEnrichment, dep: DepSignal, estimate: Estimate): Readiness {
  const title = (spec.title ?? "").trim();
  const titleOk = title.length >= 4 && !PLACEHOLDER_TITLE_RE.test(title);

  const projectType = typeof spec.extra?.project_type === "string" ? (spec.extra.project_type as string).trim() : "";
  const techOk = projectType.length > 0;

  // deps ok = sem predecessores OU todos os predecessores já aceitos (contrato disponível).
  const depsOk = dep.total === 0 || dep.accepted >= dep.total;

  // estimativa "presente" = temos base histórica real (não um chute por complexidade).
  const estimateOk = estimate.basis === "history";

  const checks: ReadinessCheck[] = [
    {
      key: "title",
      label: "Título definido",
      ok: titleOk,
      hint: titleOk ? "" : "Dê um título descritivo à SPEC (evite rótulos genéricos).",
    },
    {
      key: "tech",
      label: "Tecnologia/tipo definido",
      ok: techOk,
      hint: techOk ? "" : "Defina o tipo/stack do projeto (ex.: frontend, api, database).",
    },
    {
      key: "deps",
      label: dep.total === 0 ? "Sem dependências pendentes" : "Contratos das dependências prontos",
      ok: depsOk,
      hint: depsOk
        ? ""
        : `${dep.total - dep.accepted} de ${dep.total} dependência(s) ainda não concluída(s) — promova o produto inteiro ou aguarde os predecessores.`,
    },
    {
      key: "estimate",
      label: "Estimativa com histórico",
      ok: estimateOk,
      hint: estimateOk ? "" : "Ainda sem histórico de execuções similares — a estimativa é aproximada.",
    },
  ];

  const score = checks.reduce((acc, c) => acc + (c.ok ? 25 : 0), 0);
  // Nível considera os 3 gates de promoção (título/tech/deps); a estimativa é informativa.
  const level: Readiness["level"] =
    titleOk && techOk && depsOk ? "ready" : titleOk && techOk ? "almost" : "not_ready";

  return { score, level, checks };
}

// ── Orquestrador (roda o SQL) ─────────────────────────────────────────────────
// Interface mínima de query — aceita pool.connect() client ou o próprio pool.
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

// Busca predecessores agregados por spec (project_triggers → status do predecessor).
export async function fetchDepSignals(client: Queryable, specIds: string[]): Promise<Map<string, DepSignal>> {
  const out = new Map<string, DepSignal>();
  if (specIds.length === 0) return out;
  const rows = (
    await client.query(
      // "accepted" aqui = predecessor CONCLUÍDO segundo a regra (a) do dependencyGate:
      // status completed OU accepted. Contar só 'accepted' mostraria falsos pendentes
      // (predecessor completed que o gate real já libera). A regra (b) contrato-em-disco
      // não é checável em SQL barato → readiness segue advisory; o gate real ainda barra.
      `SELECT t.project_id AS id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE pr.status IN ('completed', 'accepted'))::int AS accepted
         FROM project_triggers t
         JOIN projects pr ON pr.id = t.trigger_project_id
        WHERE t.project_id = ANY($1)
        GROUP BY t.project_id`,
      [specIds],
    )
  ).rows as Array<{ id: string; total: number; accepted: number }>;
  for (const r of rows) out.set(r.id, { total: r.total, accepted: r.accepted });
  return out;
}

// Onda 3 (c) — nº de GAPs por spec = tamanho de findings da ÚLTIMA validação (mesma
// semântica do badge no editor: latestRun.findings.length). Best-effort: qualquer falha
// devolve mapa vazio → o card simplesmente não mostra o aviso de GAPs (degrada limpo).
import { enrichFindings, countFindings, type TriageRow } from "./findingTriage.js";
import type { ValidationFinding } from "./specValidation.js";

export interface GapCount { active: number; ignored: number; refuted: number }

/**
 * RFC-0005: contagens por projeto da última run — `active` (sem triagem viva), `ignored`, `refuted`.
 * Fonte única com o gate/GET (mesma função de enriquecimento). Degrada para mapa vazio em erro.
 */
export async function fetchGapCounts(client: Queryable, specIds: string[]): Promise<Map<string, GapCount>> {
  const out = new Map<string, GapCount>();
  if (specIds.length === 0) return out;
  try {
    const rows = (
      await client.query(
        // DISTINCT ON (project_id) + ORDER created_at DESC → 1 linha (a última run) por projeto.
        `SELECT DISTINCT ON (project_id) project_id AS id, findings
           FROM spec_validation_runs
          WHERE project_id = ANY($1)
          ORDER BY project_id, created_at DESC`,
        [specIds],
      )
    ).rows as Array<{ id: string; findings: unknown }>;
    const withFindings = rows.filter((r) => Array.isArray(r.findings) && (r.findings as unknown[]).length > 0);
    let triagesByProject = new Map<string, TriageRow[]>();
    if (withFindings.length) {
      const tr = (await client.query(
        `SELECT id, project_id, fingerprint, state, reason_code, reason, severity_at, finding_snapshot, spec_hash_at,
                actor_user_id, actor_role, expires_at, inherited_from, recurrence_count, created_at
           FROM spec_finding_triage WHERE project_id = ANY($1) AND revoked_at IS NULL`,
        [withFindings.map((r) => r.id)],
      ).catch(() => ({ rows: [] as unknown[] }))).rows as unknown as TriageRow[];
      triagesByProject = tr.reduce((m, t) => { (m.get(t.project_id) ?? m.set(t.project_id, []).get(t.project_id)!).push(t); return m; }, new Map<string, TriageRow[]>());
    }
    for (const r of rows) {
      const findings = Array.isArray(r.findings) ? (r.findings as ValidationFinding[]) : [];
      const enriched = enrichFindings(findings, triagesByProject.get(r.id) ?? []);
      const c = countFindings(enriched, []);
      out.set(r.id, { active: c.active, ignored: c.ignored, refuted: c.refuted });
    }
  } catch {
    return new Map();
  }
  return out;
}

// Busca o histórico de execuções bem-sucedidas agregado por complexidade (E3).
// Global (todos os tenants) para maximizar amostra — custo/tempo por complexidade é
// razoavelmente independente de tenant (mesmo pipeline). Só runs concluídas contam.
export async function fetchHistoryBuckets(client: Queryable): Promise<HistoryBucket[]> {
  const rows = (
    await client.query(
      `SELECT COALESCE(p.complexity_hint, 'medium') AS complexity,
              COUNT(*)::int AS sample_size,
              AVG(r.duration_sec)::float AS avg_duration_sec,
              AVG(r.estimated_cost_usd)::float AS avg_cost_usd
         FROM pipeline_runs r
         JOIN projects p ON p.id = r.project_id
        WHERE r.duration_sec IS NOT NULL
          AND r.stop_reason IN ('completed', 'accepted')
        GROUP BY COALESCE(p.complexity_hint, 'medium')`,
    )
  ).rows as Array<{ complexity: string; sample_size: number; avg_duration_sec: number; avg_cost_usd: number }>;
  return rows.map((r) => ({
    complexity: r.complexity,
    sampleSize: r.sample_size,
    avgDurationSec: r.avg_duration_sec ?? 0,
    avgCostUsd: r.avg_cost_usd ?? 0,
  }));
}

// Anexa { readiness, estimate } a cada spec. NÃO lança: em falha, devolve as specs cruas
// (o chamador deve envolver em try/catch mesmo assim, mas aqui já degradamos por sinal).
export async function enrichSpecs<T extends SpecForEnrichment>(
  client: Queryable,
  specs: T[],
): Promise<Array<T & { readiness: Readiness; estimate: Estimate; gapCount: number | null; gapCountIgnored: number; gapCountRefuted: number }>> {
  const ids = specs.map((s) => s.id);
  const [deps, buckets, gaps] = await Promise.all([
    fetchDepSignals(client, ids),
    fetchHistoryBuckets(client),
    fetchGapCounts(client, ids),
  ]);
  const estimator = buildEstimator(buckets);
  return specs.map((s) => {
    const estimate = estimator(s.complexity_hint);
    const dep = deps.get(s.id) ?? { total: 0, accepted: 0 };
    const readiness = computeReadiness(s, dep, estimate);
    // RFC-0005: gapCount = findings ATIVOS da última validação (ignorados/refutados à parte);
    // null = spec nunca validada (sem aviso no card).
    const g = gaps.get(s.id);
    const gapCount = g ? g.active : null;
    return { ...s, readiness, estimate, gapCount, gapCountIgnored: g?.ignored ?? 0, gapCountRefuted: g?.refuted ?? 0 };
  });
}
