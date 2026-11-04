-- 141 — Fase 1' do plano EVOLUIR-PROJETO-BANCADA (tarefa 1.1): novo status 'materializing' em projects.
--
-- O /evolve passa a ser feito em duas etapas (EVOLVE_CLAIM=on): um claim curto e transacional cria o filho
-- JA em 'materializing' (junto da promocao do ticket) e so depois os passos lentos (copia da spec, clone git)
-- rodam e o filho sai de 'materializing' para 'spec_submitted' ou 'draft'. 'materializing' nunca e adotado pelo
-- /run, pelo /promote nem pelo watchdog (listas de permissao de status).
--
-- A regra e um SUPERCONJUNTO da 097: nenhum dado existente viola e o codigo antigo continua valido.
-- 'card_draft' (rascunho de card) fica para a Fase 2 (tarefa 2.1).
-- Os indices de unicidade NAO vao aqui: o runner de migrations nao usa transacao e a api para em falha, entao
-- eles sao criados por passo de boot em TypeScript com pre-checagem (services/evolutionUniqueness.ts).
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' e sem DO — nenhum ';' em literal ou comentario.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;

ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'running', 'queued', 'stopped', 'completed', 'failed', 'accepted',
  'archived', 'pending_cyborg', 'blocked_cyborg',
  'spec_validation_failed',
  'blocked_structural_gate',
  'blocked_backlog_empty_with_frs',
  'blocked_awaiting_expo_confirm',
  'needs_spec_input',
  'promoted',
  'materializing'
));
