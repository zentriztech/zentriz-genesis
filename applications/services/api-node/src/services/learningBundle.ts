/**
 * learningBundle.ts — Partilha de aprendizado LOCAL→PROD do Genesis (feature #3).
 *
 * Transporta o aprendizado ACUMULADO do Genesis — skills (Skill Store), lições (lessons_corpus)
 * e catálogo de specs (spec_catalog) — de uma instância para outra (tipicamente do enxame LOCAL/dev
 * para PRODUÇÃO), de forma DETERMINÍSTICA e IDEMPOTENTE.
 *
 * Chave natural = ``slug`` (UNIQUE nas três tabelas). Reimportar o mesmo bundle é NO-OP verdadeiro:
 * o UPSERT tem um ``WHERE`` de diferença de conteúdo, então uma linha idêntica não é reescrita (sem
 * churn de ``updated_at``, contada como ``*Unchanged``). O que NÃO é regredido pela origem:
 *   • métricas de uso (use_count/quality_score/hit_count/last_*) — locais de cada instância, jamais tocadas.
 *   • ciclo de vida ``skill.status`` — sinal derivado no DESTINO (feedback loop de prod); só o INSERT de
 *     uma skill NOVA usa o status do bundle; num conflito o status do destino vence (uma skill 'shadow'
 *     local nunca rebaixa uma 'trusted' de prod).
 *   • ``lessons_corpus.confidence`` — MONOTÔNICA: ``GREATEST(destino, origem)``; a origem eleva, nunca regride.
 *   • project_id das lições e created_by das skills — referenciam entidades que não existem no destino;
 *     exportamos apenas lições de ESCOPO GLOBAL (project_id IS NULL, o aprendizado portátil do ecossistema)
 *     e importamos com created_by/project_id nulos.
 *
 * Embeddings: diferente do Deadpool (vetores locais/determinísticos, portáteis), os embeddings do
 * Genesis são gerados via Amazon Bedrock (Titan V2) pelo lessons_indexer. Por isso NÃO transportamos
 * vetores — o indexer re-embeda no destino: ele varre lessons_corpus por lições SEM embedding
 * (LEFT JOIN lessons_embeddings) na próxima execução, então cada lição nova importada é vetorizada
 * automaticamente. ``importLearningBundle`` devolve ``reembedPending`` = nº de lições novas a embeddar.
 */

import { createHash } from "crypto";
import { pool } from "../db/client.js";
import type { PoolClient } from "pg";

export const LEARNING_SCHEMA_VERSION = "genesis-learning/1";

export interface SkillRecord {
  slug: string;
  role: string;
  category: string;
  stack_key: string;
  domain: string | null;
  title: string;
  body_md: string;
  hard_rule: boolean;
  source: string;
  origin_ref: string | null;
  ttl_days: number | null;
  status: string;
}

export interface LessonRecord {
  slug: string;
  category: string;
  scope: string;
  stack_key: string;
  role: string | null;
  title: string;
  body_md: string;
  confidence: number;
  pii_redacted: boolean;
  tags: string[];
}

export interface SpecRecord {
  slug: string;
  title: string;
  category: string;
  description: string;
  template_markdown: string;
  tags: string[];
}

export interface LearningBundle {
  schemaVersion: string;
  skills: SkillRecord[];
  lessons: LessonRecord[];
  specs: SpecRecord[];
  manifest: { skills: number; lessons: number; specs: number; contentHash: string };
}

export interface ImportCounts {
  skillsImported: number;
  skillsUpdated: number;
  skillsUnchanged: number;
  lessonsImported: number;
  lessonsUpdated: number;
  lessonsUnchanged: number;
  specsImported: number;
  specsUpdated: number;
  specsUnchanged: number;
  reembedPending: number;
}

export class LearningBundleError extends Error {}

// Valores aceitos pelos CHECKs da tabela skill (migration 022) — validação FALHA-FECHADA no parse.
const SKILL_ROLES = new Set(["dev", "qa", "pm", "devops", "engineer", "cto", "cyborg"]);
const SKILL_STATUSES = new Set(["draft", "shadow", "trusted", "deprecated"]);
const SKILL_SOURCES = new Set(["seed", "llm_generated", "bug_fix", "human"]);
const SKILL_CATEGORIES = new Set(["stack", "domain", "pattern", "antipattern", "contract", "hard_rule"]);

/** Hash de conteúdo estável (ordenado por slug, campos ordenados) — igual entre ambientes. */
function contentHash(skills: SkillRecord[], lessons: LessonRecord[], specs: SpecRecord[]): string {
  const canonical = JSON.stringify({
    skills: [...skills].sort((a, b) => a.slug.localeCompare(b.slug)),
    lessons: [...lessons].sort((a, b) => a.slug.localeCompare(b.slug)),
    specs: [...specs].sort((a, b) => a.slug.localeCompare(b.slug)),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export async function exportLearningBundle(): Promise<LearningBundle> {
  const [skillsRes, lessonsRes, specsRes] = await Promise.all([
    pool.query(
      `SELECT slug, role, category, stack_key, domain, title, body_md,
              hard_rule, source, origin_ref, ttl_days, status
         FROM skill ORDER BY slug ASC`,
    ),
    pool.query(
      `SELECT slug, category, scope, stack_key, role, title, body_md,
              confidence, pii_redacted, tags
         FROM lessons_corpus WHERE project_id IS NULL ORDER BY slug ASC`,
    ),
    pool.query(
      `SELECT slug, title, category, description, template_markdown, tags
         FROM spec_catalog ORDER BY slug ASC`,
    ),
  ]);
  const skills = skillsRes.rows as SkillRecord[];
  const lessons = lessonsRes.rows as LessonRecord[];
  const specs = specsRes.rows as SpecRecord[];
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    skills,
    lessons,
    specs,
    manifest: {
      skills: skills.length,
      lessons: lessons.length,
      specs: specs.length,
      contentHash: contentHash(skills, lessons, specs),
    },
  };
}

function reqStr(rec: Record<string, unknown>, field: string, kind: string, idx: number): string {
  const v = rec[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new LearningBundleError(`${kind}[${idx}]: campo obrigatório ausente ou vazio: ${field}`);
  }
  return v;
}

function inSet(rec: Record<string, unknown>, field: string, allowed: Set<string>, kind: string, idx: number): void {
  const v = rec[field];
  if (v !== undefined && v !== null && (typeof v !== "string" || !allowed.has(v))) {
    throw new LearningBundleError(`${kind}[${idx}]: valor inválido para ${field}: ${String(v)}`);
  }
}

/**
 * Valida o envelope E cada registro (FALHA-FECHADA). Rejeitar aqui (→ 400) em vez de deixar o pg
 * abortar a transação com um 500 que pode vazar detalhe de constraint/coluna. Só validamos o que
 * os CHECKs/NOT NULL exigem — o resto é normalizado com defaults no UPSERT.
 */
function parseBundle(bundle: unknown): { skills: SkillRecord[]; lessons: LessonRecord[]; specs: SpecRecord[] } {
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    throw new LearningBundleError("bundle deve ser um objeto JSON");
  }
  const b = bundle as Record<string, unknown>;
  if (b.schemaVersion !== LEARNING_SCHEMA_VERSION) {
    throw new LearningBundleError(
      `schemaVersion incompatível: esperado ${LEARNING_SCHEMA_VERSION}, recebido ${String(b.schemaVersion)}`,
    );
  }
  const asArray = (v: unknown, name: string): Record<string, unknown>[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new LearningBundleError(`${name} deve ser uma lista`);
    return v as Record<string, unknown>[];
  };

  const skills = asArray(b.skills, "skills");
  skills.forEach((s, i) => {
    reqStr(s, "slug", "skill", i); reqStr(s, "title", "skill", i); reqStr(s, "body_md", "skill", i);
    reqStr(s, "role", "skill", i);
    inSet(s, "role", SKILL_ROLES, "skill", i);
    inSet(s, "status", SKILL_STATUSES, "skill", i);
    inSet(s, "source", SKILL_SOURCES, "skill", i);
    inSet(s, "category", SKILL_CATEGORIES, "skill", i);
  });

  const lessons = asArray(b.lessons, "lessons");
  lessons.forEach((l, i) => {
    reqStr(l, "slug", "lesson", i); reqStr(l, "title", "lesson", i);
    reqStr(l, "body_md", "lesson", i); reqStr(l, "category", "lesson", i); reqStr(l, "scope", "lesson", i);
  });

  const specs = asArray(b.specs, "specs");
  specs.forEach((sp, i) => {
    reqStr(sp, "slug", "spec", i); reqStr(sp, "title", "spec", i);
    reqStr(sp, "category", "spec", i); reqStr(sp, "template_markdown", "spec", i);
  });

  return {
    skills: skills as unknown as SkillRecord[],
    lessons: lessons as unknown as LessonRecord[],
    specs: specs as unknown as SpecRecord[],
  };
}

export async function importLearningBundle(bundle: unknown): Promise<ImportCounts> {
  const { skills, lessons, specs } = parseBundle(bundle);
  const counts: ImportCounts = {
    skillsImported: 0, skillsUpdated: 0, skillsUnchanged: 0,
    lessonsImported: 0, lessonsUpdated: 0, lessonsUnchanged: 0,
    specsImported: 0, specsUpdated: 0, specsUnchanged: 0,
    reembedPending: 0,
  };

  // Classifica o resultado de um UPSERT com WHERE de conteúdo:
  //   sem linha → nada mudou (WHERE falso; re-import idêntico é NO-OP real);
  //   xmax=0    → INSERT novo; caso contrário → UPDATE de conteúdo.
  type Outcome = "imported" | "updated" | "unchanged";
  const classify = (rows: Array<{ inserted?: boolean }>): Outcome =>
    rows.length === 0 ? "unchanged" : rows[0].inserted ? "imported" : "updated";

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const s of skills) {
      // UPSERT por slug: atualiza CONTEÚDO, preserva métricas (use_count/quality_score/last_used_at)
      // E o ciclo de vida (status) do DESTINO — status é sinal derivado localmente pelo feedback loop
      // de prod; a origem NUNCA o regride (uma skill 'shadow' local não deve rebaixar 'trusted' de prod).
      // created_by fica NULL (o user da origem não existe no destino). O WHERE torna o re-import idêntico
      // um NO-OP verdadeiro (sem churn de updated_at, contado como unchanged).
      const res = await client.query(
        `INSERT INTO skill (slug, role, category, stack_key, domain, title, body_md,
                            hard_rule, source, origin_ref, ttl_days, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (slug) DO UPDATE SET
           role = EXCLUDED.role, category = EXCLUDED.category, stack_key = EXCLUDED.stack_key,
           domain = EXCLUDED.domain, title = EXCLUDED.title, body_md = EXCLUDED.body_md,
           hard_rule = EXCLUDED.hard_rule, source = EXCLUDED.source, origin_ref = EXCLUDED.origin_ref,
           ttl_days = EXCLUDED.ttl_days, updated_at = now()
         WHERE skill.role       IS DISTINCT FROM EXCLUDED.role
            OR skill.category   IS DISTINCT FROM EXCLUDED.category
            OR skill.stack_key  IS DISTINCT FROM EXCLUDED.stack_key
            OR skill.domain     IS DISTINCT FROM EXCLUDED.domain
            OR skill.title      IS DISTINCT FROM EXCLUDED.title
            OR skill.body_md    IS DISTINCT FROM EXCLUDED.body_md
            OR skill.hard_rule  IS DISTINCT FROM EXCLUDED.hard_rule
            OR skill.source     IS DISTINCT FROM EXCLUDED.source
            OR skill.origin_ref IS DISTINCT FROM EXCLUDED.origin_ref
            OR skill.ttl_days   IS DISTINCT FROM EXCLUDED.ttl_days
         RETURNING (xmax = 0) AS inserted`,
        [s.slug, s.role, s.category ?? "stack", s.stack_key ?? "generic", s.domain ?? null, s.title, s.body_md,
         s.hard_rule ?? false, s.source ?? "human", s.origin_ref ?? null, s.ttl_days ?? null, s.status ?? "trusted"],
      );
      const out = classify(res.rows);
      if (out === "imported") counts.skillsImported++;
      else if (out === "updated") counts.skillsUpdated++;
      else counts.skillsUnchanged++;
    }

    for (const l of lessons) {
      // Importadas como GLOBAIS (project_id NULL). Preserva hit_count/last_hit_at do destino.
      // confidence é MONOTÔNICA (GREATEST): a origem pode elevar, nunca regredir uma confiança
      // que subiu com hit_count em prod. WHERE inclui a subida de confidence como "mudança".
      const res = await client.query(
        `INSERT INTO lessons_corpus (project_id, slug, category, scope, stack_key, role,
                                     title, body_md, confidence, pii_redacted, tags)
         VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (slug) DO UPDATE SET
           category = EXCLUDED.category, scope = EXCLUDED.scope, stack_key = EXCLUDED.stack_key,
           role = EXCLUDED.role, title = EXCLUDED.title, body_md = EXCLUDED.body_md,
           confidence = GREATEST(lessons_corpus.confidence, EXCLUDED.confidence),
           pii_redacted = EXCLUDED.pii_redacted, tags = EXCLUDED.tags, updated_at = now()
         WHERE lessons_corpus.category     IS DISTINCT FROM EXCLUDED.category
            OR lessons_corpus.scope        IS DISTINCT FROM EXCLUDED.scope
            OR lessons_corpus.stack_key    IS DISTINCT FROM EXCLUDED.stack_key
            OR lessons_corpus.role         IS DISTINCT FROM EXCLUDED.role
            OR lessons_corpus.title        IS DISTINCT FROM EXCLUDED.title
            OR lessons_corpus.body_md      IS DISTINCT FROM EXCLUDED.body_md
            OR lessons_corpus.pii_redacted IS DISTINCT FROM EXCLUDED.pii_redacted
            OR lessons_corpus.tags         IS DISTINCT FROM EXCLUDED.tags
            OR EXCLUDED.confidence > lessons_corpus.confidence
         RETURNING (xmax = 0) AS inserted`,
        [l.slug, l.category, l.scope ?? "ecosystem", l.stack_key ?? "generic", l.role ?? null,
         l.title, l.body_md, l.confidence ?? 1.0, l.pii_redacted ?? true, l.tags ?? []],
      );
      const out = classify(res.rows);
      if (out === "imported") { counts.lessonsImported++; counts.reembedPending++; }
      else if (out === "updated") counts.lessonsUpdated++;
      else counts.lessonsUnchanged++;
    }

    for (const sp of specs) {
      const res = await client.query(
        `INSERT INTO spec_catalog (slug, title, category, description, template_markdown, tags)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (slug) DO UPDATE SET
           title = EXCLUDED.title, category = EXCLUDED.category, description = EXCLUDED.description,
           template_markdown = EXCLUDED.template_markdown, tags = EXCLUDED.tags
         WHERE spec_catalog.title             IS DISTINCT FROM EXCLUDED.title
            OR spec_catalog.category          IS DISTINCT FROM EXCLUDED.category
            OR spec_catalog.description       IS DISTINCT FROM EXCLUDED.description
            OR spec_catalog.template_markdown IS DISTINCT FROM EXCLUDED.template_markdown
            OR spec_catalog.tags              IS DISTINCT FROM EXCLUDED.tags
         RETURNING (xmax = 0) AS inserted`,
        [sp.slug, sp.title, sp.category, sp.description ?? "", sp.template_markdown, sp.tags ?? []],
      );
      const out = classify(res.rows);
      if (out === "imported") counts.specsImported++;
      else if (out === "updated") counts.specsUpdated++;
      else counts.specsUnchanged++;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Re-embed é passivo: o lessons_indexer varre lições sem embedding na próxima execução.
  // reembedPending informa quantas lições NOVAS aguardam vetorização (as atualizadas mantêm o vetor).
  return counts;
}
