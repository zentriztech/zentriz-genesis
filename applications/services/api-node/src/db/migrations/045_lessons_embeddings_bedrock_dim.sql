-- Migration 045: alinhar lessons_embeddings à dimensão do Amazon Bedrock
-- Titan Text Embeddings V2 (amazon.titan-embed-text-v2:0 → 1024 dims).
--
-- A migration 026 criou `embedding vector(384)`, dimensão de modelos
-- sentence-transformers LOCAIS (all-MiniLM-L6-v2 / bge-small). Mas o ecossistema
-- é Bedrock-native (sem ML local, sem chave em disco — Bedrock via role da
-- instância), então o indexer (lessons_indexer.py) usa Titan V2 (1024 dims).
-- pgvector NÃO permite mudar a dimensão de uma coluna vector via ALTER TYPE, e a
-- tabela nunca foi populada (o indexer não existia até agora → 0 linhas). Logo é
-- seguro recriar. Idempotente: só recria; o corpus (lessons_corpus) é preservado.
--
-- Requer pgvector (já garantido pela migration 026). O model_id continua na PK
-- para SEGREGAR provedores: vetores 'hash-1024' (testes/CI offline) nunca se
-- misturam com vetores Bedrock reais nas consultas de similaridade.

DROP INDEX IF EXISTS idx_lessons_emb_cosine;
DROP TABLE IF EXISTS lessons_embeddings;

CREATE TABLE lessons_embeddings (
  lesson_id   UUID          NOT NULL REFERENCES lessons_corpus(id) ON DELETE CASCADE,
  model_id    TEXT          NOT NULL,
  -- ex: amazon.titan-embed-text-v2:0 (1024 dims) | hash-1024 (offline/testes)

  embedding   vector(1024)  NOT NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lesson_id, model_id)
);

-- Índice ANN por cosine distance (ivfflat para corpus pequeno;
-- migrar para hnsw quando volume > 100k registros).
CREATE INDEX IF NOT EXISTS idx_lessons_emb_cosine
  ON lessons_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

COMMENT ON TABLE lessons_embeddings IS
  'Embeddings vetoriais das lições (pgvector, 1024 dims — Bedrock Titan V2). Populado pelo lessons_indexer.';
