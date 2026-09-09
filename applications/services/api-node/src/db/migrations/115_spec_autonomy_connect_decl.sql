-- 115 — GAP-133: a declaracao Connect (connect.yaml) passa a ter DONO no laco autonomo.
--
-- MEDIDO em prod 2026-09-09: 0 de 58 projetos com spec tinham connect.yaml. O checklist
-- "Connect-ready" da Bancada marcava o item em VERMELHO desde sempre e a dica prometia dois caminhos
-- que nao existiam (o splitter tem connect.yaml em _RESERVED_NAMES e Resolver GAPs so reescreve .md
-- ja existente). Sem a declaracao, a fabrica emite SystemPassport/ServiceManifest por HEURISTICA e
-- marca como SINTETICOS: o produto nasce fora do Connect sem ninguem dizer isso.
--
-- Molde: as colunas de aprendizado da 096 (learning_kicked_at/learning_result). Mesmo contrato:
--   * connect_decl_at    = CLAIM idempotente (uma geracao por run, com 2 replicas e apos restart);
--   * connect_decl_result = resultado DECLARADO (acao, avisos, cortes, erro + tentativas).
-- O laco nao decide o CONTEUDO da declaracao (Lei 100% LLM) — quem decide e o arquiteto; estas
-- colunas so registram que houve pedido e o que voltou.
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS connect_decl_at TIMESTAMPTZ;
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS connect_decl_result JSONB;

-- Varredura do worker: runs TERMINADAS que ainda nao pediram a declaracao (mesmo desenho do indice
-- do aprendizado — parcial, so o que a fase 1 varre).
CREATE INDEX IF NOT EXISTS sar_connect_decl_pending
  ON spec_autonomy_runs (finished_at ASC)
  WHERE connect_decl_at IS NULL AND finished_at IS NOT NULL;
