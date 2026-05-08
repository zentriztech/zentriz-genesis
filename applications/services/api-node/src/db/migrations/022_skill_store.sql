-- Migration 022: Skill Store dinâmico para agentes Dev/QA/PM/DevOps
-- Substitui SYSTEM_PROMPTs estáticos por fragmentos atômicos com cache, TTL e
-- acquisition via LLM. hard_rule=true é imune a TTL e nunca regenerado por LLM.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabela principal: skill
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identidade
  slug             TEXT        NOT NULL,
  -- ex: "python.fastapi.asyncpg.enum-native", "react-native.no-expo"
  role             TEXT        NOT NULL,
  -- dev | qa | pm | devops | engineer | cto | cyborg
  category         TEXT        NOT NULL DEFAULT 'stack',
  -- stack | domain | pattern | antipattern | contract | hard_rule
  stack_key        TEXT        NOT NULL DEFAULT 'generic',
  -- normalizado: "python-fastapi", "nodejs-express", "react-next-tailwind", "generic"
  domain           TEXT,
  -- opcional: "fiscal-br", "ecommerce", "saas" — para busca semântica por domínio

  -- Conteúdo
  title            TEXT        NOT NULL,
  body_md          TEXT        NOT NULL,
  -- fragmento completo que será concatenado no SYSTEM_PROMPT

  -- Controle
  hard_rule        BOOLEAN     NOT NULL DEFAULT FALSE,
  -- TRUE = imune a TTL, nunca regenerado por LLM, sempre injetado antes de outros
  source           TEXT        NOT NULL DEFAULT 'seed',
  -- seed | llm_generated | bug_fix | human
  origin_ref       TEXT,
  -- commit SHA, bug ID, ADR, sessão de memória que originou esta skill
  ttl_days         INT,
  -- NULL = sem expiração. Ver valores padrão por categoria no seed abaixo.

  -- Ciclo de vida
  status           TEXT        NOT NULL DEFAULT 'trusted',
  -- draft | shadow | trusted | deprecated
  -- shadow: nova skill em quarentena — runner usa mas compara com estático offline
  -- trusted: validada por N execuções com QA pass
  -- deprecated: retirada por falhas recorrentes

  -- Métricas
  use_count        INT         NOT NULL DEFAULT 0,
  last_used_at     TIMESTAMPTZ,
  quality_score    NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  -- 0..1, decai com qa_fail, cresce com qa_pass

  -- Auditoria
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT skill_slug_unique UNIQUE (slug),
  CONSTRAINT skill_role_check  CHECK (role IN ('dev','qa','pm','devops','engineer','cto','cyborg')),
  CONSTRAINT skill_status_check CHECK (status IN ('draft','shadow','trusted','deprecated')),
  CONSTRAINT skill_source_check CHECK (source IN ('seed','llm_generated','bug_fix','human')),
  CONSTRAINT skill_category_check CHECK (
    category IN ('stack','domain','pattern','antipattern','contract','hard_rule')
  ),
  CONSTRAINT skill_quality_range CHECK (quality_score BETWEEN 0 AND 1)
);

-- Índices de acesso frequente
CREATE INDEX IF NOT EXISTS idx_skill_role_stack
  ON skill (role, stack_key)
  WHERE status IN ('trusted','shadow');

CREATE INDEX IF NOT EXISTS idx_skill_hard_rule
  ON skill (role)
  WHERE hard_rule = TRUE AND status = 'trusted';

CREATE INDEX IF NOT EXISTS idx_skill_ttl_cleanup
  ON skill (last_used_at, ttl_days)
  WHERE status = 'trusted' AND ttl_days IS NOT NULL;

COMMENT ON TABLE skill IS
  'Fragmentos atomicos de conhecimento para SYSTEM_PROMPTs dinamicos. hard_rule=true sao imunes a TTL.';

COMMENT ON COLUMN skill.slug IS
  'Identificador canonico unico. Ex: dev.python-fastapi.asyncpg-enum-native, dev.react-native.no-expo';

COMMENT ON COLUMN skill.body_md IS
  'Fragmento Markdown concatenado ao SYSTEM_PROMPT. Deve ser autocontido.';

COMMENT ON COLUMN skill.ttl_days IS
  'Dias de vida desde last_used_at. NULL=sem expiracao. hard_rule=NULL, domain=365, stack=180, pattern=90, llm=30.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tabela: skill_bundle — conjunto montado para uma task específica
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_bundle (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID        REFERENCES projects(id) ON DELETE CASCADE,
  task_id          TEXT,
  -- ID da task (project_tasks.task_id — texto, não UUID)
  role             TEXT        NOT NULL,
  stack_key        TEXT        NOT NULL,
  skill_ids        UUID[]      NOT NULL DEFAULT '{}',
  bundle_hash      TEXT        NOT NULL,
  -- sha256(sorted skill_ids concatenados) — para rastrear exatamente qual bundle foi usado
  assembled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assembled_by     TEXT        NOT NULL DEFAULT 'runner',
  -- cto | engineer | runner | cyborg
  llm_model        TEXT,
  result_status    TEXT,
  -- success | qa_failed | blocked | human_fixed — preenchido ao fechar a task

  CONSTRAINT skill_bundle_result_check CHECK (
    result_status IS NULL OR
    result_status IN ('success','qa_failed','blocked','human_fixed')
  )
);

CREATE INDEX IF NOT EXISTS idx_skill_bundle_project
  ON skill_bundle (project_id, role);

CREATE INDEX IF NOT EXISTS idx_skill_bundle_hash
  ON skill_bundle (bundle_hash);

COMMENT ON TABLE skill_bundle IS
  'Conjunto de skills usadas por task. bundle_hash reproduz o SYSTEM_PROMPT. result_status=DONE/BLOCKED.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Tabela: skill_feedback — telemetria de qualidade para promoção/expiração
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_feedback (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id         UUID        NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  bundle_id        UUID        REFERENCES skill_bundle(id) ON DELETE SET NULL,
  task_id          TEXT,
  project_id       UUID        REFERENCES projects(id) ON DELETE CASCADE,
  signal           TEXT        NOT NULL,
  -- qa_pass | qa_fail | cyborg_reject | bug_recurrence | human_fix | human_approve
  weight           NUMERIC(4,3) NOT NULL DEFAULT 0,
  -- -1.0 (pior) a +1.0 (melhor). Acumula em skill.quality_score via job periódico.
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT skill_feedback_signal_check CHECK (
    signal IN ('qa_pass','qa_fail','cyborg_reject','bug_recurrence','human_fix','human_approve')
  ),
  CONSTRAINT skill_feedback_weight_range CHECK (weight BETWEEN -1 AND 1)
);

CREATE INDEX IF NOT EXISTS idx_skill_feedback_skill
  ON skill_feedback (skill_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_feedback_project
  ON skill_feedback (project_id, created_at DESC);

COMMENT ON TABLE skill_feedback IS
  'Telemetria de qualidade por skill. quality_score < 0.4 por N amostras depreca a skill.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Seed inicial: executado pelo skill_store_seed.py após a migration
-- (removido do SQL para evitar conflito com o splitter de statements por ';')
-- ─────────────────────────────────────────────────────────────────────────────

-- Seeds executadas pelo skill_store_seed.py — não incluir aqui (strings E'...' com
-- ponto-e-vírgula quebram o splitter do migration runner que divide por ';').
-- Executar após a migration: python orchestrator/skill_store_seed.py --api-url <url>

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Coluna bundle_hash em project_tasks (auditoria de qual skill foi usada)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS skill_bundle_id UUID REFERENCES skill_bundle(id) ON DELETE SET NULL;

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS origin_actor TEXT DEFAULT 'runner';
-- runner | cyborg | human — quem executou esta task

COMMENT ON COLUMN project_tasks.skill_bundle_id IS
  'Bundle de skills usado para esta task. NULL = task anterior ao skill store ou não-LLM.';

COMMENT ON COLUMN project_tasks.origin_actor IS
  'Quem executou a task: runner (pipeline normal), cyborg (intervenção autônoma), human (manual).';
