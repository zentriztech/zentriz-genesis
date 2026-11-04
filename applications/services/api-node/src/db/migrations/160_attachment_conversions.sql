-- 160 — Tarefa Q (EVOLUIR-PROJETO-BANCADA): fila DURAVEL e idempotente da conversao automatica pdf/doc/docx para .md.
-- Aditiva e idempotente. Nada e gravado aqui com ATTACHMENT_CONVERSION=off (padrao): a tabela fica vazia.
--
--   * Uma linha por (anexo, sha256 do conteudo): repetir o enfileiramento nao duplica (UNIQUE) e a fila sobrevive
--     a reinicio (status pending/running com locked_until vencido sao retomados).
--   * status: pending | running | done (derivado criado) | empty (sem camada de texto: NO_TEXT_LAYER, nenhum derivado)
--             | failed (erro claro em error_code/error_message; o anexo original segue guardado no card).
--   * Indice unico parcial em ticket_attachments(derived_from_attachment_id, filename): no maximo UM derivado por
--     (original, nome), mesmo com dois workers concorrentes.
-- NOTA runner de migrations: sem ponto e virgula em literais, sem blocos DO.

CREATE TABLE IF NOT EXISTS attachment_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id UUID NOT NULL REFERENCES ticket_attachments(id) ON DELETE CASCADE,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  derived_attachment_id UUID REFERENCES ticket_attachments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attachment_conversions_status_chk CHECK (status IN ('pending', 'running', 'done', 'empty', 'failed')),
  CONSTRAINT attachment_conversions_key UNIQUE (attachment_id, content_sha256)
);

CREATE INDEX IF NOT EXISTS idx_attachment_conversions_open
  ON attachment_conversions (next_attempt_at) WHERE status IN ('pending', 'running');

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_attachments_derived_name
  ON ticket_attachments (derived_from_attachment_id, filename) WHERE derived_from_attachment_id IS NOT NULL;
