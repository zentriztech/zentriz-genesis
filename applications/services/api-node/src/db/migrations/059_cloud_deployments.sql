-- Migration 059: Item 2 (corrigido) — deploy na nuvem do TENANT via pipeline GitHub.
-- Registra cada deploy disparado: qual conexão de cloud, formato, branch, run do GitHub,
-- status e tentativas (o Genesis MONITORA e AUTO-CURA até o GitHub retornar OK), e a
-- expiração (prazo com teardown p/ demo; NULL = permanente p/ produção).
--
-- Idempotente (IF NOT EXISTS). Nenhum ';' dentro de literal de string (guard do runner).

CREATE TABLE IF NOT EXISTS cloud_deployments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- connection_id nullable + ON DELETE SET NULL: uma conexão pode ser removida sem ficar
  -- eternamente presa por linhas históricas de deploy (o histórico permanece, sem a FK).
  connection_id       UUID REFERENCES tenant_cloud_connections(id) ON DELETE SET NULL,
  provider            TEXT NOT NULL CHECK (provider IN ('aws', 'azure', 'gcp')),
  deploy_format       TEXT NOT NULL CHECK (deploy_format IN ('container', 'static', 'vm', 'serverless')),
  branch              TEXT NOT NULL DEFAULT 'dev',
  repo_full_name      TEXT,
  workflow_file       TEXT NOT NULL,
  -- Estados: pending (linha criada) -> dispatching (workflow commitado, dispatch enviado)
  --   -> running (run do GitHub em progresso) -> deployed (success) | failed (esgotou tentativas)
  --   -> tearing_down (teardown de demo disparado, aguardando run) -> torn_down (teardown OK).
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'dispatching', 'running', 'deployed', 'failed', 'expired', 'tearing_down', 'torn_down')),
  run_id              BIGINT,
  -- Maior run_id do repo observado ANTES do último dispatch. Como o run_id do GitHub é
  -- monotônico crescente por repo, a correlação aceita SÓ runs com id > run_id_floor — imune
  -- a skew de relógio GitHub×DB (o time-gate por dispatched_at era só uma folga aproximada).
  run_id_floor        BIGINT,
  -- Momento do último dispatch bem-sucedido (claim atômico). Usado como fallback de correlação
  -- (quando run_id_floor é NULL) e como base do watchdog de dispatch sem run (auto-cura).
  dispatched_at       TIMESTAMPTZ,
  run_url             TEXT,
  attempts            SMALLINT NOT NULL DEFAULT 0,
  last_error          TEXT,
  -- Expiração: NULL = permanente (produção). Timestamp = demo com teardown automático.
  expires_at          TIMESTAMPTZ,
  consented_teardown  BOOLEAN NOT NULL DEFAULT false,
  torn_down_at        TIMESTAMPTZ,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_deployments_project
  ON cloud_deployments (project_id, created_at DESC);

-- O monitor varre linhas ainda não terminais e demos vencidas.
CREATE INDEX IF NOT EXISTS idx_cloud_deployments_active
  ON cloud_deployments (status)
  WHERE status IN ('pending', 'dispatching', 'running', 'tearing_down');

CREATE INDEX IF NOT EXISTS idx_cloud_deployments_expiry
  ON cloud_deployments (expires_at)
  WHERE status = 'deployed' AND expires_at IS NOT NULL;
