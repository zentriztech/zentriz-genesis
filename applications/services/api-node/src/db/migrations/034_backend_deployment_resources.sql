-- G1-T5: backend_deployment_resources — checkpoint POR RECURSO (write-ahead + destroy-ahead).
-- Torna o teardown resumível e sem órfão (auditoria §15/§16 B4): grava 'pending' ANTES
-- de cada SDK create e 'delete-requested' ANTES de cada SDK delete; um crash no meio deixa
-- o rastro exato do que existe/foi pedido para destruir. Forward-only, idempotente.

CREATE TABLE IF NOT EXISTS backend_deployment_resources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id  uuid NOT NULL REFERENCES backend_deployments(id) ON DELETE CASCADE,
  resource_type  text NOT NULL,   -- ex.: ecr_repo | iam_role | rds_instance | ecs_service |
                                   -- task_definition | alb | target_group | listener | acm_cert |
                                   -- route53_record | secret | kms_cmk | log_group | sg | subnet_group |
                                   -- nat_gateway | eip | eni | budget | ec2_instance
  intended_name  text,            -- nome/identificador determinístico antes de ter ARN
  arn            text,            -- ARN/ID real após create
  region         text,
  status         text NOT NULL DEFAULT 'pending',  -- pending | created | delete-requested | deleted | failed
  detail         jsonb,           -- metadados (ex.: revisões de task-def, endpoint, tags)
  error_msg      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backend_deployment_resources_status_check CHECK (status = ANY (ARRAY[
    'pending'::text, 'created'::text, 'delete-requested'::text, 'deleted'::text, 'failed'::text
  ]))
);

-- Teardown/reconciliação enumeram os recursos de um deployment.
CREATE INDEX IF NOT EXISTS idx_backend_resources_deployment
  ON backend_deployment_resources (deployment_id);

-- Varredura de recursos ainda vivos (created / delete-requested) para o teardown resumível.
CREATE INDEX IF NOT EXISTS idx_backend_resources_live
  ON backend_deployment_resources (deployment_id, status)
  WHERE status IN ('pending', 'created', 'delete-requested', 'failed');

-- Idempotência: um mesmo recurso lógico (tipo + nome pretendido) aparece uma vez por deployment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_backend_resource_per_deployment
  ON backend_deployment_resources (deployment_id, resource_type, intended_name);
