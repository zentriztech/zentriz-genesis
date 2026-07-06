-- G1-T4: backend_deployments — estado durável write-ahead do provisionamento de
-- backend na conta AWS (GATE 1 = conta Zentriz). Tabela SEPARADA de
-- ephemeral_deployments (S3): NUNCA herda o auto-evict-por-idade nem o TTL de 7 dias
-- do S3, que apagaria RDS de cliente. Forward-only, idempotente.

CREATE TABLE IF NOT EXISTS backend_deployments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL,
  tenant_id             uuid,                         -- denormalizado p/ quota/reconciliação por conta
  provider              text NOT NULL DEFAULT 'aws',  -- aws | azure | gcp (GATE 1 = aws)
  runtime_target        text NOT NULL DEFAULT 'ecs_fargate', -- ecs_fargate | app_runner | ec2
  class                 text NOT NULL DEFAULT 'durable',     -- durable | demo
  lifecycle             text,                          -- livre p/ metadados de ciclo
  -- Identidade/artefato
  ecr_repo_uri          text,
  image_tag             text,
  -- Compute
  cluster_arn           text,
  task_def_arn          text,
  service_arn           text,
  migrate_task_arn      text,                          -- RunTask one-shot de migrate+seed (G1-T16)
  -- Rede / balanceador
  vpc_id                text,
  subnet_ids            text[],
  security_group_ids    text[],
  target_group_arn      text,
  alb_arn               text,
  listener_arn          text,
  -- Dados
  rds_arn               text,
  rds_endpoint          text,
  db_subnet_group       text,
  -- Segredos / cifra
  secret_arn            text,
  kms_cmk_arn           text,
  -- TLS / DNS
  acm_cert_arn          text,
  route53_record        text,
  -- IAM (descoberta/teardown por path — G1-T13)
  iam_role_path         text,                          -- /genesis/<deployment_id>/
  -- Observabilidade / custo
  log_group             text,
  budget_arn            text,
  cost_estimate_hourly  numeric,
  -- Resultado
  app_url               text,
  health_url            text,
  error_msg             text,
  -- Ciclo de vida (inclui MIGRATING, WAITING_CERT_DNS, DESTROYING/DESTROY_FAILED — auditoria §15/§16)
  status                text NOT NULL DEFAULT 'provisioning',
  expires_at            timestamptz,                   -- NULL p/ durable (nunca expira por idade)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  destroyed_at          timestamptz,
  CONSTRAINT backend_deployments_status_check CHECK (status = ANY (ARRAY[
    'provisioning'::text,
    'building'::text,
    'pushing'::text,
    'migrating'::text,
    'creating_service'::text,
    'waiting_cert_dns'::text,
    'running'::text,
    'running_degraded'::text,
    'failed'::text,
    'destroying'::text,
    'destroy_failed'::text,
    'destroyed'::text
  ])),
  CONSTRAINT backend_deployments_provider_check CHECK (provider = ANY (ARRAY['aws'::text,'azure'::text,'gcp'::text])),
  CONSTRAINT backend_deployments_runtime_check  CHECK (runtime_target = ANY (ARRAY['ecs_fargate'::text,'app_runner'::text,'ec2'::text])),
  CONSTRAINT backend_deployments_class_check    CHECK (class = ANY (ARRAY['durable'::text,'demo'::text]))
);

-- Anti-race: no máximo 1 deployment ATIVO por projeto (espelha uq_ephemeral_active_per_project).
CREATE UNIQUE INDEX IF NOT EXISTS uq_backend_active_per_project
  ON backend_deployments (project_id)
  WHERE status IN ('provisioning','building','pushing','migrating','creating_service','waiting_cert_dns','running','running_degraded');

-- Reconciliação/quota por tenant + seleção de "mais antigo ativo".
CREATE INDEX IF NOT EXISTS idx_backend_tenant_status
  ON backend_deployments (tenant_id, status, created_at ASC);

-- Resume-no-boot: pollers re-anexam fases não-terminais.
CREATE INDEX IF NOT EXISTS idx_backend_resumable_status
  ON backend_deployments (status)
  WHERE status IN ('provisioning','building','pushing','migrating','creating_service','waiting_cert_dns','destroying');
