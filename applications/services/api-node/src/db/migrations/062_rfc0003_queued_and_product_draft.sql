-- Migration 062 (RFC-0003): reabilita 'queued' em projetos e adiciona 'draft' ao
-- ciclo de vida de produtos — pré-requisitos das etapas de decomposicao/promocao.
--
-- Gap G5: a migration 040 reconstruiu projects_status_check SEM o valor 'queued',
-- embora a 010 tenha criado queued_at + indice parcial WHERE status = 'queued' e o
-- watchdog dependa desse estado. Promover raizes quando o tenant esta no teto de
-- concorrencia seta status = 'queued' e hoje viola o CHECK, estourando 500. Aqui o
-- CHECK volta a aceitar 'queued' (lista completa da 040 + 'queued').
--
-- Gap C1/G2: products.lifecycle_status so possui estados de fabrica (default
-- 'ingesting'). Um produto decomposto na Bancada mas ainda NAO promovido nao pode
-- aparecer como 'running'/'ingesting' fantasma. Adiciona-se 'draft' como estado
-- pre-fabrica: a decomposicao (B1) grava 'draft' e a promocao (B2) transiciona
-- para 'ingesting'/'running'.
--
-- NOTA: o runner (db/init.ts) divide por ';' e NAO suporta DO. Idempotencia via
-- DROP CONSTRAINT IF EXISTS + ADD. Nenhum ';' dentro de literais/comentarios inline.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;

ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'running', 'queued', 'stopped', 'completed', 'failed', 'accepted',
  'archived', 'pending_cyborg', 'blocked_cyborg',
  'spec_validation_failed',
  'blocked_structural_gate',
  'blocked_backlog_empty_with_frs',
  'blocked_awaiting_expo_confirm'
));

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_lifecycle_status_check;

ALTER TABLE products ADD CONSTRAINT products_lifecycle_status_check CHECK (lifecycle_status IN (
  'draft','ingesting','running','partially_accepted','stalled_waiting_human','accepted','failed'
));
