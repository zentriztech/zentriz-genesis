-- 119 -- GAP-145: o estagio B era ESTRITAMENTE SEQUENCIAL por limitacao de ESQUEMA, nao de desenho.
--
-- POR QUE (medido em prod 2026-09-09, 7 dias, 130 runs terminadas de `spec_validation_runs`):
--     lotes | runs | minutos medios | minutos max | com nao_medido | com renovacao de prazo
--         0 |  104 |            6,0 |        20,7 |              0 |                      0
--         3 |    8 |           17,1 |        20,2 |              0 |                      0
--         4 |   18 |           18,3 |        22,6 |              0 |                      2
--   Ou seja: 26 de 130 runs (20%) sao multi-lote e custam ~18 min contra ~6 min de uma chamada so.
--   Sao ~12 min de TEMPO DE PAREDE por validacao de spec grande -- exatamente as specs da rodada de
--   investimento. Nao e custo de token: e produtividade, o pedido explicito do Jean.
--
-- A CAUSA era uma coluna: `spec_validation_runs.agents_job_id` e UMA so. Como o resultado pago de um
-- lote so e recuperavel por esse id (GAP-11), sobrescreve-lo jogaria no lixo uma leitura adversarial
-- JA PAGA -- e por isso o C7 fez a coisa certa com o esquema que tinha: PARAR o despacho no primeiro
-- lote pendente. O paralelismo nao estava proibido por risco, estava proibido por falta de LUGAR onde
-- guardar um id por lote. Esta tabela e esse lugar.
--
-- O DESENHO, e o que ele NAO promete:
--   * Uma linha por lote, com `agents_job_id` PROPRIO. `UNIQUE (run_id, idx)` porque `idx` e a
--     IDENTIDADE do lote, e identidade duplicada foi a familia do GAP-102 (a ORDEM da lista decidia
--     quem reivindicava o finding). A remontagem dos achados le por `idx`, NUNCA por ordem de
--     chegada -- com concorrencia, ordem de chegada e ruido de rede, e o colapso C2 e sensivel a ordem.
--   * `findings jsonb NULL` respeita o contrato NULL != 0 do ecossistema: NULL = lote nao devolveu
--     (nao medido), `[]` = o juiz leu e nao achou nada. Sao fatos diferentes e nunca podem colapsar.
--   * `status` e o estado do LOTE, nao da run: dispatched (id gravado, esperando), done (resultado na
--     mao), error (falha definitiva), lost (agents reiniciou e perdeu o job), given_up (pendente que
--     esta etapa NAO recuperou -- declarado, nunca silencioso).
--   * Esta migracao NAO liga paralelismo. `SPEC_VALIDATION_BATCH_CONCURRENCY` nasce em 1, que e
--     byte-identico ao comportamento de hoje. A tabela passa a existir e a ser escrita mesmo em serie:
--     instrumento ANTES da mudanca de comportamento, que e a licao que o GAP-147 cobrou em dinheiro.
--   * Recuperacao multi-lote completa (varios pendentes reconciliados pelo coletor) fica para a etapa
--     2 -- ela duplica a cauda de `processValidationRun` (estagio O, colapso C2, recorrencias, auditoria
--     cross-family) e misturar as duas coisas numa entrega esconderia qual delas quebrou. Nesta etapa,
--     o lote pendente de MENOR `idx` continua indo para `spec_validation_runs.agents_job_id` (semantica
--     de recuperacao EXATAMENTE a de hoje) e os demais pendentes viram `given_up` DECLARADO.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

CREATE TABLE IF NOT EXISTS spec_validation_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES spec_validation_runs(id) ON DELETE CASCADE,
  idx integer NOT NULL,
  total integer NOT NULL,
  agents_job_id text,
  status text NOT NULL DEFAULT 'dispatched',
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  full_shas jsonb NOT NULL DEFAULT '{}'::jsonb,
  findings jsonb,
  dropped integer,
  error text,
  polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT spec_validation_batches_idx_ck CHECK (idx >= 0 AND idx < total),
  CONSTRAINT spec_validation_batches_status_ck
    CHECK (status IN ('dispatched', 'done', 'error', 'lost', 'given_up'))
);

CREATE UNIQUE INDEX IF NOT EXISTS spec_validation_batches_run_idx_uidx
  ON spec_validation_batches (run_id, idx);

CREATE INDEX IF NOT EXISTS spec_validation_batches_pendentes_idx
  ON spec_validation_batches (status, polled_at)
  WHERE agents_job_id IS NOT NULL AND status = 'dispatched';

COMMENT ON TABLE spec_validation_batches IS
  'GAP-145: um lote de estagio B por linha, com `agents_job_id` PROPRIO. Antes desta tabela o esquema tinha UMA coluna de job por run, entao o despacho era obrigatoriamente serial (C7 parava no primeiro lote pendente para nao descartar leitura adversarial ja paga -- GAP-11). Medido em prod: 26 de 130 runs sao multi-lote e custam ~18 min contra ~6 min.';

COMMENT ON COLUMN spec_validation_batches.idx IS
  'Posicao do lote no plano de `partitionValidationInput`, contada de 0. E a IDENTIDADE do lote: a remontagem dos achados le por `idx`, nunca por ordem de chegada, porque com concorrencia a ordem de chegada e ruido de rede e o colapso C2 (duplicata) depende da ordem da lista.';

COMMENT ON COLUMN spec_validation_batches.findings IS
  'Contrato NULL != 0 do ecossistema: NULL = o lote NAO devolveu resultado (nao medido), `[]` = o juiz leu o lote e nao achou nada. Colapsar os dois transformaria cegueira em aprovacao.';

COMMENT ON COLUMN spec_validation_batches.status IS
  'dispatched = id gravado e esperando. done = resultado na mao. error = falha definitiva do lote. lost = agents reiniciou e perdeu o job em memoria. given_up = resultado ficou PENDENTE e esta etapa nao o recuperou (declarado na cobertura da run como nao medido, nunca ausencia silenciosa).';
