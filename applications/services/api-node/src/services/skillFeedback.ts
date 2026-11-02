/**
 * skillFeedback.ts — ciclo de feedback de skill + hit_count de lições (plano v2, tarefas 1.1 e 1.2; ADR-025).
 *
 * Tudo atrás da flag `SKILL_FEEDBACK` = off | shadow | on (padrão off).
 *   off    → nada daqui roda; as rotas mantêm o comportamento legado byte a byte.
 *   shadow → registra o evento com chave `shadow|…` e LOGA o que faria; não altera skill nem lição.
 *   on     → aplica: score (EMA corrigida), use_count, transição de status e hit_count de lições.
 *
 * Regras (ADR-025):
 *  - Sinais FRACOS (qa_pass, qa_fail, cyborg_reject, bug_recurrence) só ajustam `quality_score`
 *    informativo. NUNCA transitam status, NUNCA incrementam use_count / hit_count. O QA é um LLM.
 *  - Sinais FORTES (oraculo: build+testes executáveis; ou humano) são os únicos que transitam
 *    shadow→trusted / trusted→deprecated e os únicos que contam acerto (use_count / hit_count).
 *  - Idempotência: a chave é projeto|task|skill|sinal (o task_id sozinho repete entre projetos).
 */

export type SkillFeedbackMode = "off" | "shadow" | "on";

export function getSkillFeedbackMode(env: NodeJS.ProcessEnv = process.env): SkillFeedbackMode {
  const raw = (env.SKILL_FEEDBACK ?? "off").trim().toLowerCase();
  return raw === "shadow" || raw === "on" ? raw : "off";
}

// ── Sinais ───────────────────────────────────────────────────────────────────

export const STRONG_POSITIVE = ["oracle_pass", "human_approve"] as const;
export const STRONG_NEGATIVE = ["oracle_fail", "human_reject", "human_fix"] as const;
export const WEAK_SIGNALS = ["qa_pass", "qa_fail", "cyborg_reject", "bug_recurrence"] as const;
export const ALL_SIGNALS = [...STRONG_POSITIVE, ...STRONG_NEGATIVE, ...WEAK_SIGNALS] as const;
export type FeedbackSignal = (typeof ALL_SIGNALS)[number];

export function isStrongPositive(s: string): boolean {
  return (STRONG_POSITIVE as readonly string[]).includes(s);
}
export function isStrongNegative(s: string): boolean {
  return (STRONG_NEGATIVE as readonly string[]).includes(s);
}
export function isStrongSignal(s: string): boolean {
  return isStrongPositive(s) || isStrongNegative(s);
}

/** Pesos legados preservados (qa_pass/human_approve +0,5; qa_fail/bug_recurrence −0,5; cyborg_reject −0,3). */
export function defaultSignalWeight(signal: string): number {
  switch (signal) {
    case "qa_pass":
    case "human_approve":
    case "oracle_pass":
      return 0.5;
    case "qa_fail":
    case "bug_recurrence":
    case "oracle_fail":
    case "human_reject":
      return -0.5;
    case "cyborg_reject":
    case "human_fix":
      return -0.3;
    default:
      return 0;
  }
}

// ── Fórmula do quality_score ─────────────────────────────────────────────────

/** Passo da média móvel (≈ janela de 20 amostras, como o comentário original da rota). */
export const EMA_ALPHA = 0.05;
export const TRUSTED_THRESHOLD = 0.7;
export const DEPRECATED_THRESHOLD = 0.3;
/** Evidência mínima (linhas de sinal FORTE distintas) para transitar estado. */
export const MIN_STRONG_FOR_TRUST = 5;
export const MIN_STRONG_FOR_DEPRECATE = 10;
/** Prior neutro: onde o score passa a viver quando chega a primeira evidência de oráculo. */
export const NEUTRAL_PRIOR = 0.5;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const round3 = (x: number): number => Math.round(x * 1000) / 1000; // coluna NUMERIC(4,3)

/**
 * Fórmula LEGADA (mantida só para a simulação "antes"): q' = 0,95·q + 0,05·(0,05·w + 0,5).
 * Ponto fixo = 0,5 + 0,05·w → com w=±0,5 fica em 0,525 / 0,475: os limiares 0,7 e 0,3 são inalcançáveis.
 */
export function legacyNextQualityScore(q: number, w: number): number {
  return round3(clamp01(q * 0.95 + (w * 0.05 + 0.5) * 0.05));
}

/**
 * Fórmula CORRIGIDA: q' = (1−α)·q + α·t, com alvo t = clamp(0,5 + w, 0, 1) e α = 0,05.
 *
 * Por quê: o sinal w ∈ [−0,5; +0,5] é mapeado direto no alvo [0, 1] (antes era comprimido por 0,05
 * dentro do termo, o que colapsava o ponto fixo para perto de 0,5). Propriedades:
 *   • continua uma média móvel exponencial (mesmo α, mesma faixa [0,1]);
 *   • sequência constante de w=+0,5 converge a 1 e de w=−0,5 a 0 → AMBOS os limiares são alcançáveis
 *     (|q_n − t| = 0,95ⁿ·|q_0 − t|; de 0,5 a ≥0,7 em 10 passos; de 1,0 a <0,3 em 24 passos);
 *   • com sinais ±0,5 misturados, o valor esperado no regime é a TAXA de acerto p (E[t] = p),
 *     ou seja, o score vira estimador da taxa de acerto, que é o que um limiar 0,7/0,3 pressupõe.
 */
export function nextQualityScore(q: number, w: number, alpha: number = EMA_ALPHA): number {
  const target = clamp01(0.5 + w);
  return round3(clamp01((1 - alpha) * q + alpha * target));
}

// ── Chaves de idempotência ───────────────────────────────────────────────────

export function feedbackKey(projectId: string, taskRef: string, skillId: string, signal: string): string {
  return `${projectId}|${taskRef}|${skillId}|${signal}`;
}
/** Acerto de lição: uma vez por projeto, lição e sinal (conservador: não infla por nº de tasks). */
export function lessonHitKey(projectId: string, lessonSlug: string, signal: string): string {
  return `lesson|${projectId}|${lessonSlug}|${signal}`;
}
const withMode = (mode: SkillFeedbackMode, key: string): string => (mode === "shadow" ? `shadow|${key}` : key);

// ── Store (abstração do banco; implementação pg abaixo, fake em memória nos testes) ──

export interface SkillRow {
  id: string;
  quality_score: number;
  status: string;
  hard_rule: boolean;
}
export interface BundleSkillRef {
  skill_id: string;
  task_ref: string;
  bundle_id: string | null;
}
export interface FeedbackStore {
  lockSkill(id: string): Promise<SkillRow | null>;
  insertFeedback(r: {
    skillId: string; bundleId: string | null; taskId: string | null; projectId: string;
    signal: string; weight: number; notes: string | null; key: string;
  }): Promise<boolean>; // false = chave já existia (duplicado)
  countStrong(skillId: string, shadow: boolean): Promise<{ positive: number; negative: number }>;
  updateSkill(id: string, quality: number, incUse: boolean): Promise<void>;
  setStatus(id: string, status: "trusted" | "deprecated"): Promise<void>;
  listBundleSkills(projectId: string, taskId: string | null): Promise<BundleSkillRef[]>;
  listInjectedLessons(projectId: string, taskId: string | null): Promise<string[]>;
  insertLessonHit(key: string, slug: string, projectId: string, signal: string): Promise<boolean>;
  incrementLessonHit(slug: string): Promise<void>;
}

export interface SkillOutcome {
  skill_id: string;
  duplicate: boolean;
  missing?: boolean;
  quality_before?: number;
  quality_after?: number;
  counted_use?: boolean;
  transition?: "trusted" | "deprecated" | null;
}

export type Logger = (msg: string) => void;

/** Aplica UM sinal a UMA skill. Sem PII: só ids opacos, sinal e números. */
export async function applySkillSignal(
  store: FeedbackStore,
  mode: Exclude<SkillFeedbackMode, "off">,
  p: {
    projectId: string; taskRef: string; skillId: string; signal: string;
    weight?: number; bundleId?: string | null; notes?: string | null;
  },
  log: Logger = () => {},
): Promise<SkillOutcome> {
  const shadow = mode === "shadow";
  const row = await store.lockSkill(p.skillId);
  if (!row) return { skill_id: p.skillId, duplicate: false, missing: true };

  const w = Math.max(-1, Math.min(1, p.weight ?? defaultSignalWeight(p.signal)));
  const key = withMode(mode, feedbackKey(p.projectId, p.taskRef, p.skillId, p.signal));
  const inserted = await store.insertFeedback({
    skillId: p.skillId, bundleId: p.bundleId ?? null,
    taskId: p.taskRef, projectId: p.projectId,
    signal: p.signal, weight: w, notes: p.notes ?? null, key,
  });
  if (!inserted) return { skill_id: p.skillId, duplicate: true };

  const strongPos = isStrongPositive(p.signal);
  const strongNeg = isStrongNegative(p.signal);

  // Contagem de evidência FORTE já inclui a linha recém-inserida (mesma transação).
  const c = strongPos || strongNeg ? await store.countStrong(p.skillId, shadow) : { positive: 0, negative: 0 };

  // Re-baseline do prior: o default do banco é quality_score=1,0 (e o legado só se movia entre 0,475 e
  // 1,0 por QA). Antes da PRIMEIRA evidência forte esse número não tem lastro de oráculo; sem rebase,
  // uma skill de 50 % de acerto nasceria "trusted" só pelo prior otimista. A 1ª evidência forte parte de 0,5.
  const firstStrong = c.positive + c.negative === 1;
  const before = firstStrong ? NEUTRAL_PRIOR : Number(row.quality_score);
  const after = nextQualityScore(before, w);

  let transition: "trusted" | "deprecated" | null = null;
  if (strongPos && row.status === "shadow" && after >= TRUSTED_THRESHOLD && c.positive >= MIN_STRONG_FOR_TRUST) {
    transition = "trusted";
  } else if (
    strongNeg && row.status === "trusted" && !row.hard_rule &&
    after < DEPRECATED_THRESHOLD && c.positive + c.negative >= MIN_STRONG_FOR_DEPRECATE
  ) {
    transition = "deprecated";
  }

  if (shadow) {
    log(
      `[SkillFeedback/shadow] skill=${p.skillId} signal=${p.signal} q ${before}->${after} ` +
      `use_count+=${strongPos ? 1 : 0} transition=${transition ?? "none"} (nada aplicado)`,
    );
    return { skill_id: p.skillId, duplicate: false, quality_before: before, quality_after: after,
             counted_use: strongPos, transition };
  }

  await store.updateSkill(p.skillId, after, strongPos);
  if (transition) {
    await store.setStatus(p.skillId, transition);
    log(`[SkillFeedback/on] skill=${p.skillId} ${row.status}->${transition} signal=${p.signal} q=${after}`);
  }
  return { skill_id: p.skillId, duplicate: false, quality_before: before, quality_after: after,
           counted_use: strongPos, transition };
}

export interface FanoutResult {
  skills: SkillOutcome[];
  lessons: { slug: string; duplicate: boolean }[];
}

/**
 * Fan-out de um desfecho de task/projeto: todas as skills dos bundles (deduplicadas) e, se o sinal
 * é de oráculo positivo, as lições injetadas. `taskId=null` = projeto inteiro.
 */
export async function applyOutcome(
  store: FeedbackStore,
  mode: Exclude<SkillFeedbackMode, "off">,
  p: { projectId: string; taskId: string | null; signal: string; notes?: string | null },
  log: Logger = () => {},
): Promise<FanoutResult> {
  const refs = await store.listBundleSkills(p.projectId, p.taskId);
  const seen = new Set<string>();
  const skills: SkillOutcome[] = [];
  for (const r of refs) {
    const k = `${r.task_ref}|${r.skill_id}`;
    if (seen.has(k)) continue; // rework gera >1 bundle por task: conta uma vez
    seen.add(k);
    skills.push(await applySkillSignal(store, mode, {
      projectId: p.projectId, taskRef: r.task_ref, skillId: r.skill_id,
      signal: p.signal, bundleId: r.bundle_id, notes: p.notes,
    }, log));
  }

  const lessons: { slug: string; duplicate: boolean }[] = [];
  if (isStrongPositive(p.signal)) {
    const slugs = await store.listInjectedLessons(p.projectId, p.taskId);
    for (const slug of [...new Set(slugs)]) {
      const key = withMode(mode, lessonHitKey(p.projectId, slug, p.signal));
      const isNew = await store.insertLessonHit(key, slug, p.projectId, p.signal);
      if (isNew && mode === "on") await store.incrementLessonHit(slug);
      if (isNew && mode === "shadow") log(`[LessonHit/shadow] lesson=${slug} signal=${p.signal} hit_count+=1 (nada aplicado)`);
      lessons.push({ slug, duplicate: !isNew });
    }
  }
  return { skills, lessons };
}

// ── Implementação pg do Store ────────────────────────────────────────────────

export interface PgLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export function pgFeedbackStore(db: PgLike): FeedbackStore {
  return {
    async lockSkill(id) {
      const r = await db.query(
        `SELECT id, quality_score, status, hard_rule FROM skill WHERE id = $1 FOR UPDATE`, [id]);
      const x = r.rows[0];
      return x ? { id: x.id, quality_score: Number(x.quality_score), status: x.status, hard_rule: !!x.hard_rule } : null;
    },
    async insertFeedback(r) {
      const res = await db.query(
        `INSERT INTO skill_feedback
           (skill_id, bundle_id, task_id, project_id, signal, weight, notes, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [r.skillId, r.bundleId, r.taskId, r.projectId, r.signal, r.weight, r.notes, r.key]);
      return res.rows.length > 0;
    },
    async countStrong(skillId, shadow) {
      const r = await db.query(
        `SELECT COUNT(*) FILTER (WHERE signal = ANY($2::text[]))::int AS positive,
                COUNT(*) FILTER (WHERE signal = ANY($3::text[]))::int AS negative
           FROM skill_feedback
          WHERE skill_id = $1 AND idempotency_key IS NOT NULL
            AND (idempotency_key LIKE 'shadow|%') = $4`,
        [skillId, [...STRONG_POSITIVE], [...STRONG_NEGATIVE], shadow]);
      return { positive: r.rows[0]?.positive ?? 0, negative: r.rows[0]?.negative ?? 0 };
    },
    async updateSkill(id, quality, incUse) {
      await db.query(
        `UPDATE skill SET quality_score = $1,
                          use_count = use_count + $2::int,
                          updated_at = NOW()
          WHERE id = $3`, [quality, incUse ? 1 : 0, id]);
    },
    async setStatus(id, status) {
      await db.query(`UPDATE skill SET status = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
    },
    async listBundleSkills(projectId, taskId) {
      const r = await db.query(
        `SELECT DISTINCT unnest(sb.skill_ids)::text AS skill_id,
                COALESCE(sb.task_id, '~project') AS task_ref
           FROM skill_bundle sb
          WHERE sb.project_id = $1 AND ($2::text IS NULL OR sb.task_id = $2)`,
        [projectId, taskId]);
      return r.rows.map((x) => ({ skill_id: x.skill_id, task_ref: x.task_ref, bundle_id: null }));
    },
    async listInjectedLessons(projectId, taskId) {
      const r = await db.query(
        `SELECT DISTINCT lesson_slug FROM lesson_injection
          WHERE project_id = $1 AND ($2::text IS NULL OR task_id = $2)`, [projectId, taskId]);
      return r.rows.map((x) => x.lesson_slug as string);
    },
    async insertLessonHit(key, slug, projectId, signal) {
      const r = await db.query(
        `INSERT INTO lesson_hit_event (idempotency_key, lesson_slug, project_id, signal)
         VALUES ($1,$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
        [key, slug, projectId, signal]);
      return r.rows.length > 0;
    },
    async incrementLessonHit(slug) {
      await db.query(
        `UPDATE lessons_corpus SET hit_count = hit_count + 1, last_hit_at = NOW(), updated_at = NOW()
          WHERE slug = $1`, [slug]);
    },
  };
}

/** Executa `fn` numa transação (BEGIN/COMMIT/ROLLBACK) usando um client do pool. */
export async function withTransaction<T>(
  pool: { connect(): Promise<PgLike & { release(): void }> },
  fn: (db: PgLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignora */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Gancho de desfecho de projeto (aceite/rejeição) chamado por projects.ts. Fire-and-forget:
 * nunca lança. Com a flag off é no-op ANTES de tocar o banco (byte-idêntico ao legado).
 */
export async function recordProjectOutcome(
  pool: { connect(): Promise<PgLike & { release(): void }> },
  projectId: string,
  signal: FeedbackSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const mode = getSkillFeedbackMode(env);
  if (mode === "off") return;
  try {
    await withTransaction(pool, async (db) => {
      await applyOutcome(pgFeedbackStore(db), mode, { projectId, taskId: null, signal }, (m) => console.info(m));
    });
  } catch (e) {
    console.warn(`[SkillFeedback] desfecho de projeto não registrado (não crítico): ${(e as Error).message}`);
  }
}
