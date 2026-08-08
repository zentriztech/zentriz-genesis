-- Migration 037: ciclo de vida AGREGADO do produto (ADR-018 / Cenário A, correção adversária A2).
--
-- A coluna `status` (active|archived) é o estado administrativo do produto e permanece.
-- Esta migration adiciona `lifecycle_status`: o progresso agregado das ondas de projetos.
--
-- Motivo (A2): a cascata de accept só dispara a onda seguinte quando CADA projeto da onda
-- é auto-aceito pelo Cyborg. Se o Cyborg devolver NEEDS_HUMAN (status blocked_cyborg), a
-- árvore a jusante TRAVA silenciosamente. Sem um estado agregado, o portal não consegue
-- mostrar que o produto está parado esperando humano. Este enum torna esse bloqueio visível.
--
-- Máquina de estados (recomputada a cada accept/reject de projeto do produto):
--   ingesting            → produto recém-criado, projetos ainda sendo materializados
--   running              → há projetos em andamento, nenhum aceito/bloqueado/falho ainda
--   partially_accepted   → alguns projetos aceitos, outros ainda em andamento (sem bloqueio)
--   stalled_waiting_human→ ao menos um projeto em blocked_cyborg (onda travada, exige humano)
--   accepted             → todos os projetos aceitos
--   failed               → ao menos um projeto rejeitado por humano (falha dura)
--
-- NOTA: o runner de migrations (db/init.ts) divide o SQL por ';' e NÃO suporta blocos
-- DO $$...$$. Por isso a idempotência do CHECK usa DROP IF EXISTS + ADD (2 statements).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'ingesting';

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_lifecycle_status_check;

ALTER TABLE products
  ADD CONSTRAINT products_lifecycle_status_check
  CHECK (lifecycle_status IN (
    'ingesting','running','partially_accepted','stalled_waiting_human','accepted','failed'
  ));

COMMENT ON COLUMN products.lifecycle_status IS
  'Progresso agregado das ondas de projetos (A2): ingesting|running|partially_accepted|stalled_waiting_human|accepted|failed. Recomputado a cada accept/reject.';
