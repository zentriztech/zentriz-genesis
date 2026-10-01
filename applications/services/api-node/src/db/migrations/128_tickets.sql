-- 128 — RFC-0009: Evolucao por Ticket. O PEDIDO ganha identidade, anexo, tipo e estado,
-- separado da EXECUCAO (o projeto filho). Medido em prod 2026-09-11: 59 projetos, 1 unica
-- evolucao, e ela travada em blocked_cyborg — enquanto travar, o guard EVOLUTION_IN_FLIGHT
-- impede qualquer novo pedido naquele servico. O ticket existe para o pedido sobreviver a isso.
--
-- INVARIANTES (revisao adversarial do RFC-0009):
--   * `body` e o texto CRU do humano. A maquina NUNCA escreve nele (5% das revisoes de LLM
--     inserem erro factual — o original tem de ser recuperavel para sempre).
--   * `status` e o estado do PEDIDO (open/promoted/delivered/rejected), NUNCA o da execucao.
--     O estado de execucao se deriva por join em projects via child_project_id.
--   * numero e POR PRODUTO (TK-0012 do LastMile), alocado atomicamente em products.next_ticket_seq
--     — MESMO padrao de products.next_rfc_seq/next_adr_seq (migration 080). Sem tabela de contador.
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  product_id UUID NOT NULL,
  project_id UUID,
  number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  change_kind TEXT NOT NULL DEFAULT 'evolution',
  status TEXT NOT NULL DEFAULT 'open',
  child_project_id UUID,
  created_by UUID,
  promoted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_product_number ON tickets (product_id, number);
CREATE INDEX IF NOT EXISTS idx_tickets_product_status ON tickets (product_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant ON tickets (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tickets_child ON tickets (child_project_id);

-- Contador por produto (mesmo padrao de next_rfc_seq): UPDATE .. RETURNING trava a linha do
-- produto ate o commit, entao dois pedidos simultaneos recebem numeros distintos sem advisory
-- lock. `max(number)+1` seria condicao de corrida (duas transacoes leem o mesmo maximo).
ALTER TABLE products ADD COLUMN IF NOT EXISTS next_ticket_seq INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  content_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket ON ticket_attachments (ticket_id);
