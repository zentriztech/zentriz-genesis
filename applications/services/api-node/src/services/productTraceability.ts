/**
 * productTraceability.ts — o MAPEAMENTO da construção de um produto, em fatos auditáveis.
 *
 * Pedido do Jean (2026-09-07), verbatim: *"a bancada e a fabrica deve poder exportar 3 relatorios
 * sobre o produto, 1 resumido e um completo e um misto, no formato PDF, contendo informacoes do
 * mapeamento completo da construcao desses produtos (doc/spec e/ou codigo fontes) para
 * fortalecermos a rastreabilidade, gerar arquivo e iniciar download"*.
 *
 * DIVISÃO DE TRABALHO (decisão declarada): este serviço produz os **FATOS** (JSON tipado, testável,
 * com os cortes declarados); quem desenha o PDF é o cliente, na Bancada e na Fábrica. O motivo é o
 * Mermaid: os desenhos que o laço autônomo agora cria (`arquitetura-diagramas.md`) só viram figura
 * dentro de um browser, e o `genesis-web` já renderiza Mermaid → SVG na tela da spec. Gerar PDF no
 * servidor exigiria Chromium na imagem (~300 MB) para desenhar o mesmo SVG que o browser do usuário
 * já desenha de graça. Então: servidor = verdade; cliente = tinta.
 *
 * ASSUNÇÕES DECLARADAS sobre os três perfis (o Jean nomeou os três; o conteúdo é proposta minha):
 *   • `summary` — o que um executivo lê em minutos: identidade, certificado, quanto de spec existe,
 *     GAPs abertos por severidade, últimas validações, promoções, deploys e OS DESENHOS.
 *   • `full` — o mapeamento inteiro da construção: inventário arquivo a arquivo com hash, findings,
 *     vereditos, triagem, constraints, rodadas do laço, execuções da fábrica, tarefas, deploys.
 *   • `mixed` — o resumido MAIS o detalhe do que ainda está ABERTO e do que MUDOU desde a última
 *     promoção. É o relatório de revisão: some o histórico já promovido, sobra a decisão pendente.
 *
 * "Completo" é mapeamento completo, **não transcrição da spec**: a spec do NVX LastMile tem ~1,08 M
 * chars e transcrevê-la não é rastreabilidade — rastreabilidade é *quem mudou o quê, quando, com que
 * hash, e o que o juiz disse depois*. O texto integral continua na Bancada, versionado, e cada
 * arquivo aparece aqui com `contentSha256` para amarrar as duas coisas.
 *
 * CORTES: todo teto está em `LIMITS` e todo corte aplicado vira uma linha em `truncated[]` com o
 * que foi cortado e quanto ficou de fora. Cortar é aceitável; mentir sobre o corte não é.
 */
import { computeFactoryCertificates, type FactoryCertificate } from "./factoryCertificate.js";
import { computeCurrentSpecHash } from "./specValidation.js";

type Db = { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export type TraceabilityProfile = "summary" | "full" | "mixed";

export const TRACEABILITY_PROFILES: TraceabilityProfile[] = ["summary", "full", "mixed"];

export function isTraceabilityProfile(v: unknown): v is TraceabilityProfile {
  return typeof v === "string" && (TRACEABILITY_PROFILES as string[]).includes(v);
}

/**
 * Tetos. Existem para o relatório de um produto grande continuar sendo um relatório — e não uma
 * segunda cópia do banco. Cada um deles, quando morde, escreve em `truncated[]`.
 */
export const LIMITS = {
  /** Projetos do produto detalhados por inteiro (os demais entram só na lista de identidade). */
  projects: 40,
  /** Arquivos de spec no inventário por projeto. */
  specFiles: 200,
  /** Chars de cada documento de DESENHOS embutido (o Mermaid é pequeno; o teto é anti-abuso). */
  diagramChars: 120_000,
  /** Execuções de validação listadas: `summary` mostra as últimas, `full` o histórico. */
  validationsSummary: 3,
  validationsFull: 40,
  /** Findings/vereditos/triagem/constraints listados individualmente. */
  findings: 400,
  verdicts: 200,
  triage: 200,
  constraints: 400,
  /** Runs do laço autônomo e rodadas dentro de cada uma. */
  autonomyRuns: 20,
  autonomyRounds: 60,
  /** Execuções da fábrica, tarefas, promoções e deploys. */
  pipelineRuns: 40,
  tasks: 400,
  promotions: 20,
  deployments: 40,
} as const;

export interface TraceabilityCut {
  /** Seção cortada (`findings`, `specFiles`, …). */
  section: string;
  /** Quantos itens entraram no relatório. */
  kept: number;
  /** Quantos existiam de fato. */
  total: number;
  /** O teto que mordeu, por nome, para o leitor saber o que mudar. */
  limit: number;
}

export interface TraceabilityProject {
  id: string;
  title: string;
  status: string;
  projectType: string | null;
  versionNumber: number | null;
  parentProjectId: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  runCount: number | null;
  specFingerprint: string | null;
  /** Certificado Factory calculado sem disparar validação (custo zero de LLM). */
  certificate: FactoryCertificate | null;
  repo: {
    fullName: string | null; url: string | null; defaultBranch: string | null;
    shaDev: string | null; pushedAt: string | null;
  } | null;
  spec: {
    specHash: string | null;
    totalChars: number;
    files: Array<{
      path: string; isPrimary: boolean; chars: number; contentSha256: string;
      /** `true` quando o juiz adversarial leu ESTE conteúdo por inteiro (GAP-18). */
      judgedFullAtThisContent: boolean;
    }>;
    /** Documento de desenhos Mermaid, quando o laço já o criou (feature de 2026-09-08). */
    diagrams: { path: string; chars: number; content: string } | null;
  };
}

export interface TraceabilityReport {
  profile: TraceabilityProfile;
  generatedAt: string;
  /** Tudo que foi cortado por teto, declarado item a item. */
  truncated: TraceabilityCut[];
  /** Recorte temporal do perfil `mixed` (null nos outros): a data da última promoção. */
  changedSince: string | null;
  product: {
    id: string; name: string; description: string | null; status: string | null;
    lifecycleStatus: string | null; productHash: string | null; systemId: string | null;
    originProjectId: string | null; isInbox: boolean; soloApp: boolean;
    createdAt: string | null; tenantId: string | null;
    projectsTotal: number;
  };
  projects: TraceabilityProject[];
  gaps: {
    /** Contagem de findings ATIVOS por severidade, somando os projetos do produto. */
    counts: Record<string, number>;
    items: Array<{
      projectId: string; severity: string; title: string; file: string | null;
      anchor: string | null; fingerprint: string | null; route: string | null;
    }>;
  };
  validations: Array<{
    id: string; projectId: string; status: string; specHash: string | null;
    stageBRan: boolean | null; findings: number; findingsBySeverity: Record<string, number>;
    filesJudgedFull: number; filesTotal: number | null;
    createdAt: string | null; finishedAt: string | null;
  }>;
  verdicts: Array<{
    projectId: string; fingerprint: string; filePath: string | null; anchor: string | null;
    severityAt: string | null; title: string | null; impact: string | null; reason: string | null;
    factoryArtifact: string | null; recurrenceTimes: number | null; focusRounds: number | null;
    decidedByModel: string | null; createdAt: string | null; revokedAt: string | null;
  }>;
  triage: Array<{
    projectId: string; fingerprint: string; state: string; reasonCode: string | null;
    severityAt: string | null; recurrenceCount: number | null; actorRole: string | null;
    createdAt: string | null; revokedAt: string | null;
  }>;
  constraints: {
    counts: Record<string, number>;
    items: Array<{
      projectId: string; constraintKey: string; appliesTo: string | null; verifiableAt: string | null;
      severity: string | null; assertion: string | null; sourceAnchor: string | null;
    }>;
  };
  autonomyRuns: Array<{
    id: string; projectId: string; status: string; mode: string | null; passes: number | null;
    round: number | null; maxRounds: number | null; gapsCurrent: number | null;
    createdAt: string | null; finishedAt: string | null; lastError: string | null;
    rounds: Array<Record<string, unknown>>;
  }>;
  factory: {
    pipelineRuns: Array<{
      projectId: string; runId: string | null; trigger: string | null; startedAt: string | null;
      finishedAt: string | null; durationSec: number | null; stopReason: string | null;
      inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null;
    }>;
    tasks: Array<{
      projectId: string; taskId: string | null; module: string | null; ownerRole: string | null;
      status: string | null; artifactsRef: string | null; updatedAt: string | null;
    }>;
    tasksByStatus: Record<string, number>;
  };
  promotions: Array<{
    id: string; status: string | null; model: string | null; edgesSource: string | null;
    promotedBy: string | null; startedAt: string | null; createdAt: string | null;
    items: Array<{ projectId: string; wave: number | null; layer: string | null; dependsOn: unknown; dispatchedAt: string | null }>;
  }>;
  deployments: Array<{
    projectId: string; provider: string | null; class: string | null; lifecycle: string | null;
    status: string | null; appUrl: string | null; imageTag: string | null;
    createdAt: string | null; destroyedAt: string | null;
  }>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const DIAGRAMS_FILENAME = "arquitetura-diagramas.md";

function s(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function n(v: unknown): number | null {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}
function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}
/** Aplica o teto e DECLARA o corte (nunca corta calado). */
function cap<T>(rows: T[], limit: number, section: string, cuts: TraceabilityCut[]): T[] {
  if (rows.length <= limit) return rows;
  cuts.push({ section, kept: limit, total: rows.length, limit });
  return rows.slice(0, limit);
}
function tally(values: Array<string | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const k = (v ?? "desconhecido").toString();
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
/** Severidades que a Bancada trata como GAP importante (as demais são informativas). */
function isImportant(sev: unknown): boolean {
  const v = String(sev ?? "").toLowerCase();
  return v === "blocker" || v === "warning";
}

/** `extra.project_type` sem confiar no formato (o campo é JSONB livre). */
function projectType(extra: unknown): string | null {
  if (!extra || typeof extra !== "object") return null;
  const e = extra as Record<string, unknown>;
  return s(e.project_type ?? e.projectType ?? null);
}

// ── o relatório ──────────────────────────────────────────────────────────────

/**
 * Monta o relatório. NÃO dispara LLM, NÃO valida spec, NÃO escreve nada: é leitura.
 *
 * `full` e `mixed` leem o disco para o inventário de arquivos (via `computeCurrentSpecHash`, o mesmo
 * caminho da validação) — se um arquivo sumiu do disco, o inventário daquele projeto vem vazio com
 * `specHash: null`, porque afirmar tamanho de arquivo que não existe seria inventar rastreabilidade.
 */
export async function buildTraceabilityReport(
  db: Db,
  opts: { productId: string; profile: TraceabilityProfile },
): Promise<TraceabilityReport | null> {
  const { productId, profile } = opts;
  const cuts: TraceabilityCut[] = [];
  const detailed = profile !== "summary";

  const prod = (await db.query(
    `SELECT id, tenant_id, name, description, status, lifecycle_status, product_hash, system_id,
            origin_project_id, is_inbox, solo_app, created_at
       FROM products WHERE id = $1`,
    [productId],
  )).rows[0];
  if (!prod) return null;

  const projRows = (await db.query(
    `SELECT id, title, status, extra, version_number, parent_project_id, created_at, finished_at,
            run_count, spec_fingerprint
       FROM projects WHERE product_id = $1 ORDER BY created_at ASC`,
    [productId],
  )).rows;
  const projectsTotal = projRows.length;
  const kept = cap(projRows, LIMITS.projects, "projects", cuts);
  const ids = kept.map((r) => String(r.id));

  // `changedSince` (perfil `mixed`): a última promoção é a fronteira entre "história já entregue" e
  // "o que ainda está em decisão". Sem promoção nenhuma, o recorte não existe e o `mixed` mostra tudo
  // que o `full` mostraria — dizer "nada mudou" sobre um produto nunca promovido seria falso.
  const promoRows = ids.length
    ? (await db.query(
        `SELECT id, status, model_used, edges_source, promoted_by, started_at, created_at
           FROM product_promotions WHERE product_id = $1 ORDER BY created_at DESC`,
        [productId],
      )).rows
    : [];
  const changedSince = profile === "mixed" ? iso(promoRows[0]?.created_at ?? null) : null;
  const since = changedSince ? new Date(changedSince) : null;
  const afterCut = (v: unknown): boolean => {
    if (!since) return true;
    const d = v ? new Date(String(v)) : null;
    return !d || Number.isNaN(d.getTime()) ? true : d >= since;
  };

  // ── certificados (custo zero: nunca dispara validação) ──────────────────────
  const certs = ids.length
    ? await computeFactoryCertificates(db as never, ids).catch(() => new Map<string, FactoryCertificate>())
    : new Map<string, FactoryCertificate>();

  // ── repos da fábrica ────────────────────────────────────────────────────────
  const repoRows = ids.length
    ? (await db.query(
        `SELECT project_id, repo_full_name, repo_url, default_branch, sha_dev, pushed_at
           FROM project_github_repos WHERE project_id = ANY($1)`,
        [ids],
      )).rows
    : [];
  const repoByProject = new Map(repoRows.map((r) => [String(r.project_id), r]));

  // ── inventário de spec + desenhos ───────────────────────────────────────────
  const projects: TraceabilityProject[] = [];
  for (const r of kept) {
    const pid = String(r.id);
    const cert = certs.get(pid) ?? null;
    const repo = repoByProject.get(pid);
    let specHash: string | null = null;
    let totalChars = 0;
    let files: TraceabilityProject["spec"]["files"] = [];
    let diagrams: TraceabilityProject["spec"]["diagrams"] = null;

    const current = await computeCurrentSpecHash(db as never, pid).catch(() => null);
    if (current) {
      specHash = current.specHash;
      const judgedSha = (await db.query(
        "SELECT filename, rel_dir, is_primary, stage_b_full_sha FROM project_spec_files WHERE project_id = $1",
        [pid],
      )).rows;
      const meta = new Map(judgedSha.map((x) => [
        `${x.rel_dir ? `${String(x.rel_dir)}/` : ""}${String(x.filename)}`,
        x,
      ]));
      const all = current.files.map((f) => {
        const path = `${f.rel_dir ? `${f.rel_dir}/` : ""}${f.filename}`;
        const m = meta.get(path);
        return {
          path,
          isPrimary: m?.is_primary === true,
          chars: f.content.length,
          contentSha256: f.contentSha256,
          judgedFullAtThisContent: s(m?.stage_b_full_sha) === f.contentSha256,
        };
      });
      totalChars = all.reduce((acc, f) => acc + f.chars, 0);
      // Os desenhos entram INTEGRAIS em todos os perfis: são a única seção cuja utilidade é ser
      // vista, e é exatamente o que o Jean pediu ("desenhos que facilitem o entendimento").
      const dia = current.files.find((f) => f.filename === DIAGRAMS_FILENAME);
      if (dia) {
        const content = dia.content.slice(0, LIMITS.diagramChars);
        if (content.length < dia.content.length) {
          cuts.push({ section: `diagrams:${pid}`, kept: content.length, total: dia.content.length, limit: LIMITS.diagramChars });
        }
        diagrams = { path: `${dia.rel_dir ? `${dia.rel_dir}/` : ""}${dia.filename}`, chars: dia.content.length, content };
      }
      // No `summary` o inventário arquivo a arquivo não entra (só os totais e os desenhos).
      files = detailed ? cap(all, LIMITS.specFiles, `specFiles:${pid}`, cuts) : [];
    }

    projects.push({
      id: pid,
      title: s(r.title) ?? "",
      status: s(r.status) ?? "",
      projectType: projectType(r.extra),
      versionNumber: n(r.version_number),
      parentProjectId: s(r.parent_project_id),
      createdAt: iso(r.created_at),
      finishedAt: iso(r.finished_at),
      runCount: n(r.run_count),
      specFingerprint: s(r.spec_fingerprint),
      certificate: cert,
      repo: repo
        ? {
            fullName: s(repo.repo_full_name), url: s(repo.repo_url),
            defaultBranch: s(repo.default_branch), shaDev: s(repo.sha_dev), pushedAt: iso(repo.pushed_at),
          }
        : null,
      spec: { specHash, totalChars, files, diagrams },
    });
  }

  // ── validações ──────────────────────────────────────────────────────────────
  const valLimit = profile === "summary" ? LIMITS.validationsSummary : LIMITS.validationsFull;
  const valRows = ids.length
    ? (await db.query(
        `SELECT id, project_id, status, spec_hash, stage_b_ran, findings, stage_b_coverage,
                finding_routes, created_at, finished_at
           FROM spec_validation_runs WHERE project_id = ANY($1) ORDER BY created_at DESC`,
        [ids],
      )).rows
    : [];
  const valFiltered = valRows.filter((v) => afterCut(v.created_at));
  const validations = cap(valFiltered, valLimit, "validations", cuts).map((v) => {
    const f = Array.isArray(v.findings) ? (v.findings as Record<string, unknown>[]) : [];
    const cov = (v.stage_b_coverage ?? null) as Record<string, unknown> | null;
    const full = Array.isArray(cov?.full) ? (cov!.full as unknown[]).length : 0;
    const shas = cov?.fullShas && typeof cov.fullShas === "object" ? Object.keys(cov.fullShas as object).length : null;
    return {
      id: String(v.id), projectId: String(v.project_id), status: s(v.status) ?? "",
      specHash: s(v.spec_hash), stageBRan: v.stage_b_ran === null || v.stage_b_ran === undefined ? null : v.stage_b_ran === true,
      findings: f.length, findingsBySeverity: tally(f.map((x) => s(x.severity))),
      filesJudgedFull: full, filesTotal: shas,
      createdAt: iso(v.created_at), finishedAt: iso(v.finished_at),
    };
  });

  // ── GAPs ativos: a fonte é a validação mais recente de cada projeto ─────────
  const latestByProject = new Map<string, Record<string, unknown>>();
  for (const v of valRows) {
    const pid = String(v.project_id);
    if (!latestByProject.has(pid)) latestByProject.set(pid, v);
  }
  const gapItems: TraceabilityReport["gaps"]["items"] = [];
  const gapSeverities: Array<string | null> = [];
  for (const [pid, v] of latestByProject) {
    const f = Array.isArray(v.findings) ? (v.findings as Record<string, unknown>[]) : [];
    const routes = (v.finding_routes ?? null) as Record<string, unknown> | null;
    for (const x of f) {
      gapSeverities.push(s(x.severity));
      // No `mixed` e no `summary` só interessa o que ainda IMPEDE: o informativo vira contagem.
      if (profile !== "full" && !isImportant(x.severity)) continue;
      gapItems.push({
        projectId: pid, severity: s(x.severity) ?? "", title: s(x.title) ?? "",
        file: s(x.file), anchor: s(x.anchor ?? x.section ?? null), fingerprint: s(x.fingerprint),
        route: routes && typeof routes === "object" ? s((routes as Record<string, unknown>)[String(x.fingerprint)]) : null,
      });
    }
  }
  const gaps = {
    counts: tally(gapSeverities),
    items: detailed ? cap(gapItems, LIMITS.findings, "gaps", cuts) : [],
  };

  // ── vereditos, triagem, constraints ─────────────────────────────────────────
  const verdictRows = detailed && ids.length
    ? (await db.query(
        `SELECT project_id, fingerprint, file_path, anchor, severity_at, title, impact, reason,
                factory_artifact, recurrence_times, focus_rounds, decided_by_model, created_at, revoked_at
           FROM spec_gap_promotion_verdicts WHERE project_id = ANY($1) ORDER BY created_at DESC`,
        [ids],
      )).rows
    : [];
  const verdicts = cap(
    verdictRows.filter((v) => afterCut(v.created_at)), LIMITS.verdicts, "verdicts", cuts,
  ).map((v) => ({
    projectId: String(v.project_id), fingerprint: String(v.fingerprint), filePath: s(v.file_path),
    anchor: s(v.anchor), severityAt: s(v.severity_at), title: s(v.title), impact: s(v.impact),
    reason: s(v.reason), factoryArtifact: s(v.factory_artifact), recurrenceTimes: n(v.recurrence_times),
    focusRounds: n(v.focus_rounds), decidedByModel: s(v.decided_by_model),
    createdAt: iso(v.created_at), revokedAt: iso(v.revoked_at),
  }));

  const triageRows = detailed && ids.length
    ? (await db.query(
        `SELECT project_id, fingerprint, state, reason_code, severity_at, recurrence_count,
                actor_role, created_at, revoked_at
           FROM spec_finding_triage WHERE project_id = ANY($1) ORDER BY created_at DESC`,
        [ids],
      )).rows
    : [];
  const triage = cap(
    // No `mixed`, triagem revogada é história: sobra o que está valendo.
    triageRows.filter((t) => (profile === "mixed" ? !t.revoked_at : true) && afterCut(t.created_at)),
    LIMITS.triage, "triage", cuts,
  ).map((t) => ({
    projectId: String(t.project_id), fingerprint: String(t.fingerprint), state: s(t.state) ?? "",
    reasonCode: s(t.reason_code), severityAt: s(t.severity_at), recurrenceCount: n(t.recurrence_count),
    actorRole: s(t.actor_role), createdAt: iso(t.created_at), revokedAt: iso(t.revoked_at),
  }));

  const constraintRows = ids.length
    ? (await db.query(
        `SELECT project_id, constraint_key, applies_to, verifiable_at, severity, assertion, source_anchor
           FROM spec_constraints WHERE project_id = ANY($1) AND superseded_by_key IS NULL
           ORDER BY created_at DESC`,
        [ids],
      )).rows
    : [];
  const constraints = {
    counts: tally(constraintRows.map((c) => `${s(c.applies_to) ?? "?"}/${s(c.verifiable_at) ?? "?"}/${s(c.severity) ?? "?"}`)),
    items: detailed
      ? cap(constraintRows, LIMITS.constraints, "constraints", cuts).map((c) => ({
          projectId: String(c.project_id), constraintKey: String(c.constraint_key),
          appliesTo: s(c.applies_to), verifiableAt: s(c.verifiable_at), severity: s(c.severity),
          assertion: s(c.assertion), sourceAnchor: s(c.source_anchor),
        }))
      : [],
  };

  // ── laço autônomo (as rodadas são o diário da construção da spec) ───────────
  const autoRows = detailed && ids.length
    ? (await db.query(
        `SELECT id, project_id, status, mode, passes, round, max_rounds, gaps_current, rounds,
                created_at, finished_at, last_error
           FROM spec_autonomy_runs WHERE project_id = ANY($1) ORDER BY created_at DESC`,
        [ids],
      )).rows
    : [];
  const autonomyRuns = cap(
    autoRows.filter((a) => afterCut(a.created_at)), LIMITS.autonomyRuns, "autonomyRuns", cuts,
  ).map((a) => {
    const rounds = Array.isArray(a.rounds) ? (a.rounds as Array<Record<string, unknown>>) : [];
    const keptRounds = rounds.length > LIMITS.autonomyRounds
      ? (cuts.push({ section: `autonomyRounds:${String(a.id)}`, kept: LIMITS.autonomyRounds, total: rounds.length, limit: LIMITS.autonomyRounds }),
         rounds.slice(-LIMITS.autonomyRounds))
      : rounds;
    return {
      id: String(a.id), projectId: String(a.project_id), status: s(a.status) ?? "", mode: s(a.mode),
      passes: n(a.passes), round: n(a.round), maxRounds: n(a.max_rounds), gapsCurrent: n(a.gaps_current),
      createdAt: iso(a.created_at), finishedAt: iso(a.finished_at), lastError: s(a.last_error),
      rounds: keptRounds,
    };
  });

  // ── fábrica: execuções e tarefas ────────────────────────────────────────────
  const pipeRows = ids.length
    ? (await db.query(
        `SELECT project_id, run_id, trigger, started_at, finished_at, duration_sec, stop_reason,
                input_tokens, output_tokens, estimated_cost_usd
           FROM pipeline_runs WHERE project_id = ANY($1) ORDER BY created_at DESC`,
        [ids],
      )).rows
    : [];
  const pipelineRuns = cap(
    pipeRows.filter((p) => afterCut(p.started_at ?? p.finished_at)),
    profile === "summary" ? LIMITS.validationsSummary : LIMITS.pipelineRuns, "pipelineRuns", cuts,
  ).map((p) => ({
    projectId: String(p.project_id), runId: s(p.run_id), trigger: s(p.trigger),
    startedAt: iso(p.started_at), finishedAt: iso(p.finished_at), durationSec: n(p.duration_sec),
    stopReason: s(p.stop_reason), inputTokens: n(p.input_tokens), outputTokens: n(p.output_tokens),
    estimatedCostUsd: n(p.estimated_cost_usd),
  }));

  const taskRows = ids.length
    ? (await db.query(
        `SELECT project_id, task_id, module, owner_role, status, artifacts_ref, updated_at
           FROM project_tasks WHERE project_id = ANY($1) ORDER BY updated_at DESC NULLS LAST`,
        [ids],
      )).rows
    : [];
  const tasksByStatus = tally(taskRows.map((t) => s(t.status)));
  const tasks = detailed
    ? cap(taskRows.filter((t) => afterCut(t.updated_at)), LIMITS.tasks, "tasks", cuts).map((t) => ({
        projectId: String(t.project_id), taskId: s(t.task_id), module: s(t.module),
        ownerRole: s(t.owner_role), status: s(t.status), artifactsRef: s(t.artifacts_ref),
        updatedAt: iso(t.updated_at),
      }))
    : [];

  // ── promoções (com os itens/ondas) e deploys ────────────────────────────────
  const promoKept = cap(promoRows, LIMITS.promotions, "promotions", cuts);
  const promoIds = promoKept.map((p) => String(p.id));
  const itemRows = promoIds.length
    ? (await db.query(
        `SELECT promotion_id, project_id, wave, layer, depends_on, dispatched_at
           FROM product_promotion_items WHERE promotion_id = ANY($1) ORDER BY wave ASC, position ASC`,
        [promoIds],
      )).rows
    : [];
  const promotions = promoKept.map((p) => ({
    id: String(p.id), status: s(p.status), model: s(p.model_used), edgesSource: s(p.edges_source),
    promotedBy: s(p.promoted_by), startedAt: iso(p.started_at), createdAt: iso(p.created_at),
    items: itemRows.filter((i) => String(i.promotion_id) === String(p.id)).map((i) => ({
      projectId: String(i.project_id), wave: n(i.wave), layer: s(i.layer),
      dependsOn: i.depends_on ?? null, dispatchedAt: iso(i.dispatched_at),
    })),
  }));

  const deployRows = ids.length
    ? (await db.query(
        `SELECT project_id, provider, class, lifecycle, status, app_url, image_tag, created_at, destroyed_at
           FROM backend_deployments WHERE project_id = ANY($1) ORDER BY created_at DESC`,
        [ids],
      )).rows
    : [];
  const deployments = cap(
    deployRows.filter((d) => afterCut(d.created_at)),
    profile === "summary" ? LIMITS.validationsSummary : LIMITS.deployments, "deployments", cuts,
  ).map((d) => ({
    projectId: String(d.project_id), provider: s(d.provider), class: s(d.class),
    lifecycle: s(d.lifecycle), status: s(d.status), appUrl: s(d.app_url), imageTag: s(d.image_tag),
    createdAt: iso(d.created_at), destroyedAt: iso(d.destroyed_at),
  }));

  return {
    profile,
    generatedAt: new Date().toISOString(),
    truncated: cuts,
    changedSince,
    product: {
      id: String(prod.id), name: s(prod.name) ?? "", description: s(prod.description),
      status: s(prod.status), lifecycleStatus: s(prod.lifecycle_status),
      productHash: s(prod.product_hash), systemId: s(prod.system_id),
      originProjectId: s(prod.origin_project_id), isInbox: prod.is_inbox === true,
      soloApp: prod.solo_app === true, createdAt: iso(prod.created_at), tenantId: s(prod.tenant_id),
      projectsTotal,
    },
    projects,
    gaps,
    validations,
    verdicts,
    triage,
    constraints,
    autonomyRuns,
    factory: { pipelineRuns, tasks, tasksByStatus },
    promotions,
    deployments,
  };
}
