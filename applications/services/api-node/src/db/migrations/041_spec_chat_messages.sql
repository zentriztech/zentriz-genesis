-- Migration 041: histórico do chat de edição de spec (Feature #63).
--
-- Cada turno do chat de refinamento de spec (usuário <-> CTO) é persistido aqui,
-- associado ao projeto em edição. Quando a edição ocorre ANTES de existir um projeto
-- (fluxo de criação), o histórico fica só no cliente e nada é gravado aqui.
-- Idempotente (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS spec_chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id  UUID REFERENCES tenants(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spec_chat_messages_project ON spec_chat_messages(project_id, created_at);
