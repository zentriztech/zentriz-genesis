-- Migration 042: seção "SPECs" (Feature #64) — DECISÃO DE MODELAGEM.
--
-- ESCOLHA: NÃO adicionamos uma coluna is_spec_draft. Reusamos o status='draft' já
-- existente em projects. Justificativa: uma SPEC é apenas uma IDEIA ainda não iniciada,
-- e o estado 'draft' já significa exatamente isso (rascunho aguardando início manual,
-- run-elegível via ALLOWED_STATUS_FOR_RUN). Introduzir uma coluna nova duplicaria a
-- semântica e exigiria migrar/telar dados existentes, quebrando telas que já filtram
-- por status. A promoção spec->projeto reusa POST /api/projects/:id/run; o vínculo a
-- um produto reusa PATCH /api/projects/:id/product (product_id existente).
--
-- Esta migration apenas cria um índice parcial para acelerar GET /api/specs (listagem
-- de rascunhos por tenant). Idempotente.

CREATE INDEX IF NOT EXISTS idx_projects_tenant_draft
  ON projects (tenant_id, updated_at DESC)
  WHERE status = 'draft';
