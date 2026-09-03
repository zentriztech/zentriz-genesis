-- 077_spec_chat_file_scope.sql — RFC-0004 T4.3: chat de spec por-arquivo.
-- Escopa o histórico do chat por arquivo (file_path) e registra a autoria (user_id).
-- Colunas nullable + ADD COLUMN IF NOT EXISTS → seguro em bases já populadas e reexecução.
-- (Runner de migrations faz split ingênuo por ';' — sem ';' em literais e sem blocos DO/$.)

ALTER TABLE spec_chat_messages ADD COLUMN IF NOT EXISTS file_path TEXT;
ALTER TABLE spec_chat_messages ADD COLUMN IF NOT EXISTS user_id UUID;

-- Histórico filtrado por (projeto, arquivo, tempo) — leitura futura do transcript por arquivo.
CREATE INDEX IF NOT EXISTS idx_spec_chat_messages_project_file
  ON spec_chat_messages(project_id, file_path, created_at);
