-- 031_runtime_config_token_caps.sql
-- Corrige a classe de bug que travou OrienteMe V13: o passo spec_intake_and_normalize
-- do CTO re-emite a PRODUCT_SPEC inteira em artifacts[].content (JSON). Com specs grandes
-- (ex.: OrienteMe v2.2 ~39KB) + thinking do Opus 4.8, o cap antigo (12000) truncava o JSON
-- (stop_reason=max_tokens → JSON inválido → BLOCKED), cascateando: Engineer sem spec →
-- CTO escala regeneração → PM BLOCKED → Dev nunca acionado.
--
-- Adiciona defaults globais para os novos knobs (editáveis via /settings/runtime-config):
--   CLAUDE_MAX_TOKENS_SPEC_INTAKE — teto do intake do CTO (default = teto do modelo)
--   CLAUDE_MAX_TOKENS_QA          — teto do QA (validate_task)
-- E eleva o teto padrão CLAUDE_MAX_TOKENS de 16000 → 32000 (Opus produz artefatos maiores).

-- NOTA: a UNIQUE(key, tenant_id) trata NULL como distinto, então ON CONFLICT DO NOTHING
-- NÃO deduplica linhas globais (tenant_id IS NULL). Usamos WHERE NOT EXISTS para idempotência.
INSERT INTO genesis_runtime_config (key, value, description)
SELECT v.key, v.value, v.description
FROM (VALUES
  ('CLAUDE_MAX_TOKENS_SPEC_INTAKE', '64000', 'Teto de tokens para o intake/normalização de spec do CTO (spec re-emitida inteira no output). Cap baixo trunca specs grandes.'),
  ('CLAUDE_MAX_TOKENS_QA',          '16000', 'Teto de tokens para agente QA (validate_task)')
) AS v(key, value, description)
WHERE NOT EXISTS (
  SELECT 1 FROM genesis_runtime_config g
  WHERE g.key = v.key AND g.tenant_id IS NULL
);

-- Elevar o teto padrão global (16000 é insuficiente para Opus em charter/spec/backlog).
UPDATE genesis_runtime_config
   SET value = '32000', updated_at = NOW()
 WHERE key = 'CLAUDE_MAX_TOKENS' AND tenant_id IS NULL AND value = '16000';
