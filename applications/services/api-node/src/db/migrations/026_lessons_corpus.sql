-- Migration 026: corpus de lições para RAG
-- Requer pgvector. Imagem postgres trocada para pgvector/pgvector:pg16 no docker-compose.
-- Em ambientes legados sem a extensão, esta migration FALHA-CEDO (intencional) —
-- nesses casos, ajustar a imagem ou pular a feature via RAG_ENABLED=off.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS lessons_corpus (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID,
  -- NULL = lição global do ecossistema; não-NULL = específica de projeto.

  slug         TEXT         NOT NULL UNIQUE,
  category     TEXT         NOT NULL,
  -- bug | pattern | antipattern | stack | contract | performance | security | ux

  scope        TEXT         NOT NULL,
  -- task | project | product | ecosystem

  stack_key    TEXT         NOT NULL DEFAULT 'generic',
  role         TEXT,

  title        TEXT         NOT NULL,
  body_md      TEXT         NOT NULL,

  confidence   REAL         NOT NULL DEFAULT 1.0,
  hit_count    INT          NOT NULL DEFAULT 0,
  last_hit_at  TIMESTAMPTZ,

  pii_redacted BOOLEAN      NOT NULL DEFAULT TRUE,
  tags         TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],

  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lessons_category   ON lessons_corpus(category);
CREATE INDEX IF NOT EXISTS idx_lessons_scope      ON lessons_corpus(scope);
CREATE INDEX IF NOT EXISTS idx_lessons_stack      ON lessons_corpus(stack_key);
CREATE INDEX IF NOT EXISTS idx_lessons_project    ON lessons_corpus(project_id);
CREATE INDEX IF NOT EXISTS idx_lessons_hit_score  ON lessons_corpus((hit_count * confidence) DESC);

CREATE TABLE IF NOT EXISTS lessons_embeddings (
  lesson_id   UUID         NOT NULL REFERENCES lessons_corpus(id) ON DELETE CASCADE,
  model_id    TEXT         NOT NULL,
  -- ex: all-MiniLM-L6-v2 (384 dim), bge-small-en-v1.5 (384), e5-small (384)

  embedding   vector(384)  NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lesson_id, model_id)
);

-- Índice ANN por cosine distance (ivfflat preferido para corpus pequeno;
-- migrate para hnsw quando volume > 100k registros).
CREATE INDEX IF NOT EXISTS idx_lessons_emb_cosine
  ON lessons_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Outbox: eventos para o indexer assíncrono.
CREATE TABLE IF NOT EXISTS lessons_index_outbox (
  id           BIGSERIAL    PRIMARY KEY,
  project_id   UUID         NOT NULL,
  event        TEXT         NOT NULL DEFAULT 'project_accepted',
  -- project_accepted | task_done | manual_extract

  payload      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON lessons_index_outbox(created_at)
  WHERE processed_at IS NULL;

COMMENT ON TABLE  lessons_corpus       IS 'Corpus de lições extraídas do diálogo de projetos (RAG).';
COMMENT ON TABLE  lessons_embeddings   IS 'Embeddings vetoriais das lições (pgvector).';
COMMENT ON TABLE  lessons_index_outbox IS 'Outbox para o indexer assíncrono.';
