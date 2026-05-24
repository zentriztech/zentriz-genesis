-- Migration 025: Context cache para CAG (Context-Aware Generation)
-- Armazena pacotes de contexto pré-montados que serão injetados como prefixo do
-- SYSTEM_PROMPT antes da chamada ao LLM, reduzindo latência e melhorando
-- consistência. Não substitui o skill_store (migration 022); complementa.

CREATE TABLE IF NOT EXISTS context_cache (
  id              BIGSERIAL    PRIMARY KEY,
  cache_key       TEXT         NOT NULL UNIQUE,
  -- ex: "cag:dev:python-fastapi:checklist-bugs", "cag:cto:generic:contracts"

  role            TEXT         NOT NULL,
  -- cto | engineer | pm | pm_web | dev | qa | devops | monitor | cyborg

  connect_version TEXT         NOT NULL DEFAULT '1.0.0',
  -- versão pinada do schema Connect consumido

  project_id      UUID,
  -- opcional: contexto específico de projeto (NULL = global/template)

  stack_key       TEXT         NOT NULL DEFAULT 'generic',
  -- ex: "python-fastapi", "nodejs-drizzle", "react-next-tailwind"

  category        TEXT         NOT NULL DEFAULT 'package',
  -- package | checklist | contract | lesson_seed

  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- conforme schema cache/context-package.schema.json (Connect)

  payload_tokens  INT          NOT NULL DEFAULT 0,
  -- estimativa de tokens (1 token ~= 4 chars) para budget no LLM

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ  NOT NULL,
  -- TTL: registros expirados são ignorados; cleanup via job cron

  hits            INT          NOT NULL DEFAULT 0,
  last_hit_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cc_expires    ON context_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_cc_role_proj  ON context_cache(role, project_id);
CREATE INDEX IF NOT EXISTS idx_cc_role_stack ON context_cache(role, stack_key);
CREATE INDEX IF NOT EXISTS idx_cc_category   ON context_cache(category);

COMMENT ON TABLE context_cache IS
  'Cache de pacotes CAG (Context-Aware Generation). Lido por ContextLoader antes de chamar LLM.';
COMMENT ON COLUMN context_cache.cache_key IS
  'Chave estável "cag:<role>:<stack>:<category>[:<project>]". UNIQUE para upsert idempotente.';
COMMENT ON COLUMN context_cache.payload IS
  'Conforme cache/context-package.schema.json (Connect 1.1+).';
