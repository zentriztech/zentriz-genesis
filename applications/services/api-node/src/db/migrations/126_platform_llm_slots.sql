-- 126_platform_llm_slots.sql
--
-- ⚖️ Jean, 2026-09-10: *"quando eu falo na conta da Zentriz é a conta de GERENCIAMENTO, não o
-- tenant ZFactory; é na conta de gerenciamento que deve ter uma config de LLM para os agentes
-- internos, que serão custeados pela Zentriz, não pelos tenants"*.
--
-- A LEI dos slots (2026-09-10) proíbe o LLM que ninguém escolheu: nada de `.env`, nada de
-- hard-code. O que ela NÃO proíbe é um pagador DECLARADO. Trabalho de tenant sai do slot do
-- tenant; trabalho interno da Zentriz (operar a plataforma) sai daqui — explicitamente, com
-- credencial própria, e sem jamais virar fallback de tenant nenhum.
--
-- A tabela `zentriz_llm_config` (migration 016) já era esse lugar, mas era um SINGLETON sem
-- fila, sem fallback e sem verificação: um único slot, e se ele estivesse morto não havia
-- contingência. Aqui ela vira a mesma estrutura de slots de `tenant_llm_configs`.
--
-- Estado medido em prod (2026-09-10): a tabela tem UMA linha, de 2026-07-02 —
-- `provider=bedrock`, `model_id=us.anthropic.claude-sonnet-4-6`, **`credentials` VAZIO**. Ou seja,
-- ela funcionava pela instance role da EC2: o pagador silencioso que a LEI veio matar.
--
-- Ela NÃO é apagada aqui, de propósito. Sob o código novo `platformSlotUsable` a recusa por falta de
-- credencial própria, e a tela mostra "sem credenciais — este slot não roda": o operador vê a linha
-- e preenche a credencial no lugar. Apagar em silêncio esconderia do operador que a config existia.
-- Como ela cai em `priority` 0 pelo DEFAULT, o índice único abaixo não conflita.

-- 1) O índice `((TRUE))` é o que impede o 2º slot existir.
--    ⚠️ Quem escrevia com `ON CONFLICT ((TRUE))` (routes/internalLlm.ts) foi reescrito na mesma
--    entrega para `ON CONFLICT (priority)`; dropar o índice sem isso quebraria aquele endpoint.
DROP INDEX IF EXISTS zentriz_llm_config_singleton;

-- 2) Fila de contingência, igual à do tenant: 0 = principal, 1..3 = contingências.
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS model_id_fallback VARCHAR(200);
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS label TEXT;

-- ⚠️ NADA de bloco `DO $$ ... $$` aqui: o runner faz split ingênuo por ponto-e-vírgula
-- (`db/init.ts:35`) e partiria o bloco ao meio. Idempotência = DROP IF EXISTS + ADD.
ALTER TABLE zentriz_llm_config DROP CONSTRAINT IF EXISTS zentriz_llm_config_priority_range;
ALTER TABLE zentriz_llm_config
  ADD CONSTRAINT zentriz_llm_config_priority_range CHECK (priority BETWEEN 0 AND 3);

CREATE UNIQUE INDEX IF NOT EXISTS zentriz_llm_config_priority_key
  ON zentriz_llm_config (priority);

-- 3) ⚖️ LEI: config NUNCA é fabricada por omissão. A 016 nascia com `DEFAULT 'anthropic'` e
--    `DEFAULT 'us.anthropic.claude-sonnet-4-6'` — um INSERT parcial gravava um provider e um
--    modelo que ninguém escolheu, e depois isso apareceria como "escolha da Zentriz".
ALTER TABLE zentriz_llm_config ALTER COLUMN provider DROP DEFAULT;
ALTER TABLE zentriz_llm_config ALTER COLUMN model_id DROP DEFAULT;

-- 4) Mesma verificação por invocação real dos slots de tenant (migration 125).
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_status TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_error TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_model TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_latency_ms INTEGER;

COMMENT ON TABLE zentriz_llm_config IS
  'Slots de LLM da CONTA DE GESTAO (zentriz_admin). Custeados pela Zentriz e usados so por trabalho interno da plataforma. Nunca sao fallback de tenant.';
COMMENT ON COLUMN zentriz_llm_config.priority IS
  '0 = principal, 1..3 = contingencias. Leitura SEMPRE com ORDER BY priority ASC.';

-- 5) Auditoria do agente interno de operacoes. Toda pergunta, toda ferramenta chamada e todo
--    resultado ficam registrados: um agente que le o banco de producao sem rastro nao e auditavel.
CREATE TABLE IF NOT EXISTS ops_agent_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID,
  user_email     TEXT,
  question       TEXT NOT NULL,
  answer         TEXT,
  provider       TEXT,
  model_id       TEXT,
  steps          INTEGER NOT NULL DEFAULT 0,
  trace          JSONB NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'ok',
  error          TEXT,
  duration_ms    INTEGER,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ops_agent_runs_created_idx ON ops_agent_runs (created_at DESC);

COMMENT ON TABLE ops_agent_runs IS
  'Auditoria do agente interno de operacoes: pergunta, trace de ferramentas, modelo usado e custo.';
COMMENT ON COLUMN ops_agent_runs.trace IS
  'Lista ordenada de passos: tool, input, resumo do resultado e se a guarda recusou a consulta.';
