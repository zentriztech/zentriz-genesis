-- 100 — GAP-11: o teto expira a ESPERA do estagio adversarial, nunca o RESULTADO.
--
-- MEDIDO EM PROD 2026-09-06 (NVX LastMile, projeto e2a1988c):
--
--   spec_validation_runs 16e467cf | error | 20:47:22 -> 21:08:02 (20m40s) | 0 findings
--
-- As validacoes reais deste projeto levam ~272-312 s. Esta bateu no teto de espera do proprio
-- codigo (SPEC_VALIDATION_DEADLINE_MIN, 20 min): `runStageB` polla o job assincrono do servico
-- agents e, quando o relogio estoura, devolve "timeout do estagio adversarial" -- e o `jobId`
-- morre na variavel local. O job do LLM continua vivo do outro lado, termina, e o resultado
-- (pago, uma leitura adversarial inteira da spec) e descartado pelo TTL em memoria dos agents.
-- A run fica `error` com 0 findings e o laco autonomo conta a rodada como "sem medicao".
--
-- E A MESMA FAMILIA do defeito do chat da Bancada (2026-09-06): lah o cliente checava o deadline
-- ANTES de pollar e descartava um job `done`. A licao repetida: prazo limita QUANTO SE ESPERA,
-- nunca a validade do que ja foi pago e produzido. Sem o `jobId` no banco nenhum outro processo
-- (tick do worker, api reiniciada) consegue voltar e buscar o resultado -- logo: persistido.
--
-- `stage_b_collected_at` fecha o assunto de uma run: coletado com sucesso, perdido no agents (404)
-- ou desistencia por teto duro. NULL + agents_job_id preenchido = ainda ha resultado a buscar, e o
-- laco autonomo ESPERA em vez de contar rodada sem progresso.
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal/comentario.
ALTER TABLE spec_validation_runs ADD COLUMN IF NOT EXISTS agents_job_id TEXT;

ALTER TABLE spec_validation_runs ADD COLUMN IF NOT EXISTS stage_b_collected_at TIMESTAMPTZ;

COMMENT ON COLUMN spec_validation_runs.agents_job_id IS
  'GAP-11: id do job assincrono do spec_validator no servico agents, gravado ANTES do poll. Permite recuperar o resultado quando a espera em processo termina (teto de deadline ou restart da api).';

COMMENT ON COLUMN spec_validation_runs.stage_b_collected_at IS
  'GAP-11: quando o coletor server-side encerrou o assunto deste job (resultado recuperado, job perdido no agents, ou desistencia por teto duro). NULL com agents_job_id preenchido = ainda coletavel.';

CREATE INDEX IF NOT EXISTS idx_spec_validation_runs_pending_collect
  ON spec_validation_runs (finished_at)
  WHERE agents_job_id IS NOT NULL AND stage_b_collected_at IS NULL;
