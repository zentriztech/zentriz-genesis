-- 104 — GAP-66: o coletor do estagio B so olhava run JA MORTA, entao o laco pagava o deadline inteiro
-- de espera morta por um resultado que ja estava recuperavel.
--
-- MEDIDO EM PROD 2026-09-07 (NVX LastMile, projeto e2a1988c): um deploy da api (o do GAP-64) matou o
-- esperador em processo de uma validacao que estava `running`. O `agents_job_id` JA estava no banco
-- desde a migracao 100, e o job seguia vivo no servico agents -- ou seja, o resultado estava
-- recuperavel no instante seguinte ao restart. Mas `collectStageBResults` varre
--
--     status IN ('error', 'interrupted')
--
-- e uma run orfanada por restart continua `running` ate `expireOverdueValidationRuns` vira-la `error`
-- NO DEADLINE. Resultado: ~20 minutos de espera morta, com o laco autonomo parado a espera da
-- medicao do passe, por pura questao de rotulo. O resultado FOI recuperado depois (22 findings,
-- stage_b_ran = true) -- o defeito nao e perda, e LATENCIA.
--
-- POR QUE NAO BASTA INCLUIR 'running' NA VARREDURA: existe um esperador EM PROCESSO (`runStageB`)
-- que polla o mesmo job a cada 8 s e grava o resultado quando ele chega. Varrer `running` as cegas
-- poria dois escritores na mesma linha. O que distingue uma run orfanada nao e o STATUS, e o fato de
-- o esperador dela estar MORTO -- e isso so se sabe por sinal de vida.
--
-- Daih o lease: o esperador em processo marca `stage_b_polled_at` a cada volta do poll. O coletor
-- adota uma run `pending`/`running` apenas quando esse sinal esta VELHO (default 120 s, contra ~38 s
-- de pior caso legitimo: 8 s de espera + 30 s de timeout do HTTP). Vale com qualquer numero de
-- replicas da api, porque o criterio e o heartbeat da linha, nao a identidade do processo.
--
-- COALESCE com `started_at` cobre a janela de rollout: linha escrita por codigo ANTIGO nunca tem
-- heartbeat, e trata-la como orfa de imediato poderia roubar o job de um esperador vivo da instancia
-- que ainda nao subiu. Com o COALESCE ela so e adotada depois do mesmo lease contado do inicio.
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal/comentario.
ALTER TABLE spec_validation_runs ADD COLUMN IF NOT EXISTS stage_b_polled_at TIMESTAMPTZ;

COMMENT ON COLUMN spec_validation_runs.stage_b_polled_at IS
  'GAP-66: sinal de vida do esperador em processo do estagio B, atualizado a cada volta do poll. O coletor adota uma run pending/running como orfanada somente quando COALESCE(stage_b_polled_at, started_at) esta mais velho que o lease. Distingue "esperador vivo" de "esperador morto por restart" sem depender da identidade do processo.';

CREATE INDEX IF NOT EXISTS idx_spec_validation_runs_stage_b_lease
  ON spec_validation_runs (stage_b_polled_at)
  WHERE agents_job_id IS NOT NULL AND stage_b_collected_at IS NULL;
