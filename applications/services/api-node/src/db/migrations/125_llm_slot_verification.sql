-- 125_llm_slot_verification.sql
--
-- ⚖️ Jean, 2026-09-10: *"sempre testando se funciona e em caso de nao funcionar testa o proximo,
-- o ideal é testar no momento que é adicionado"*.
--
-- Até aqui um slot só era descoberto ruim no meio de um run: a tela dizia "credenciais
-- configuradas" olhando apenas se os CAMPOS estavam preenchidos — nunca se a chave era aceita, se
-- a conta tinha direito ao modelo ou se a cota estava viva. Estas colunas guardam o resultado da
-- ÚLTIMA chamada real feita com o slot (probe em POST /llm/probe nos agents).
--
-- verify_status: ok | auth | model | quota | network | config | other  (NULL = nunca testado)
-- verify_error:  mensagem JÁ SEM CREDENCIAL (o probe higieniza antes de devolver).

ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_status TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_error TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_model TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_latency_ms INTEGER;

COMMENT ON COLUMN tenant_llm_configs.verify_status IS
  'Resultado do ultimo probe real do slot: ok|auth|model|quota|network|config|other. NULL = nunca testado.';
COMMENT ON COLUMN tenant_llm_configs.verify_error IS
  'Mensagem do ultimo probe, ja higienizada (nenhum valor de credencial).';
