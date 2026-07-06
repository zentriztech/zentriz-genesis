-- G1-T6 (seam GATE 2): colunas cross-account em tenant_cloud_connections.
-- Dão onde guardar a role assumível do tenant (role_arn + external_id) e a versão
-- da chave de cifra (key_version, para a rotação dual-key da G1-T3). Usadas SÓ no
-- GATE 2 (provisão na conta do tenant via AssumeRole). No GATE 1 (conta Zentriz)
-- ficam NULL e o path S3 legado (chave estática) segue inalterado. Forward-only.

ALTER TABLE tenant_cloud_connections
  ADD COLUMN IF NOT EXISTS role_arn     text,
  ADD COLUMN IF NOT EXISTS external_id  uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS key_version  integer;
