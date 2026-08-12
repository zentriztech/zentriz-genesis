-- Migration 040: status de bloqueio terminal estendidos (fix de raiz — achado #42)
-- Gaps #37 (blocked_structural_gate), #39 (blocked_backlog_empty_with_frs) e a
-- política de Expo (#44, blocked_awaiting_expo_confirm) introduziram gates que
-- fazem _patch_project({"status": <blocked_*>}) no runner. Porém NEM o CHECK
-- constraint do banco NEM o VALID_PROJECT_STATUS da API conheciam esses valores:
-- o PATCH retornava 400 (Status inválido), o status NÃO persistia e o projeto
-- ficava 'running' com processo morto → o watchdog relançava em loop (o próprio
-- zumbi que #39 pretendia matar). #39 só "passou" no re-run porque o backlog
-- tinha 31 tasks e o caminho de bloqueio nunca foi exercido de fato.
--
-- Fix de raiz: promover os 3 a status terminais de primeira classe. O watchdog
-- só toca 'running' (relança) e 'failed' (autoRescue); qualquer outro status é
-- deixado intacto → terminal. blocked_awaiting_expo_confirm é "aguardando
-- confirmação humana de Expo": o humano pode setar extra.expo_confirmed=true e
-- re-rodar (usar Expo), ou reclassificar para React Native CLI.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'running', 'stopped', 'completed', 'failed', 'accepted',
  'archived', 'pending_cyborg', 'blocked_cyborg',
  'spec_validation_failed',
  -- novos status terminais de bloqueio (achado #42):
  'blocked_structural_gate',        -- #37: gate estrutural determinístico
  'blocked_backlog_empty_with_frs', -- #39: backlog vazio apesar de FRs presentes
  'blocked_awaiting_expo_confirm'   -- #44: Expo detectado, aguarda confirmação humana
));
