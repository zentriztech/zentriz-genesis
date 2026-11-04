-- 143 — Tarefa 1.5 (EVOLUIR-PROJETO-BANCADA, Fase 1'): anexos do card tipados + limites parametrizados.
-- Aditiva e idempotente. Comportamento so muda com ATTACHMENTS_STRICT=on (padrao off).
--
--   * kind: 'legacy' (linha anterior a esta migration ou criada com a flag off), 'spec_text' (txt/md que segue
--     para a arvore de spec) ou 'card_only' (pdf/doc/docx: ficam guardados no card, FORA da pasta de texto da spec).
--   * origin / derived_from_attachment_id: ponto de extensao da conversao automatica para .md (tarefa posterior).
--     'upload' = enviado pelo humano. Um conversor futuro grava a linha derivada com origin 'converted:<id do conversor>'
--     e aponta para o original. Hoje o unico conversor registrado e o NULO: nenhuma linha derivada e criada.
--   * Limites por card em genesis_runtime_config (NAO constantes). Padroes CONSERVADORES e NAO CALIBRADOS
--     (calibrado=falso): nao ha medicao de anexos reais em producao. Recalibrar quando houver dado.
-- NOTA runner de migrations: sem ponto e virgula em literais, sem blocos DO.

ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS derived_from_attachment_id UUID REFERENCES ticket_attachments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_derived ON ticket_attachments (derived_from_attachment_id);

INSERT INTO genesis_runtime_config (key, value, description)
SELECT v.key, v.value, v.description
FROM (VALUES
  ('ATTACHMENT_MAX_FILES', '10', 'Maximo de arquivos por card (pedido de evolucao). calibrado=falso. Faixa 1 a 50. So vale com ATTACHMENTS_STRICT=on.'),
  ('ATTACHMENT_MAX_TOTAL_BYTES', '20971520', 'Maximo de bytes somados dos anexos de um card (20 MiB). calibrado=falso. Faixa 1024 a 209715200. So vale com ATTACHMENTS_STRICT=on.'),
  ('ATTACHMENT_MAX_FILE_BYTES', '10485760', 'Maximo de bytes de UM anexo (10 MiB, igual ao teto do multipart). calibrado=falso. Faixa 1024 a 52428800. So vale com ATTACHMENTS_STRICT=on.')
) AS v(key, value, description)
WHERE NOT EXISTS (
  SELECT 1 FROM genesis_runtime_config g
  WHERE g.key = v.key AND g.tenant_id IS NULL
);
