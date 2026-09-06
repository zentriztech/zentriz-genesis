-- 101 -- GAP-18/GAP-19: COBERTURA do estagio adversarial (quais arquivos foram julgados por INTEIRO).
--
-- MEDIDO EM PROD 2026-09-06 (NVX LastMile - Backend, projeto e2a1988c, run de validacao 6d9d4c9d):
--
--   spec: 12 arquivos / 950.965 chars
--   estagio B: 2 arquivos INTEGRAIS, 10 so em SUMARIO de cabecalhos
--   findings: 14 -- 13 ancorados, TODOS nos MESMOS 2 arquivos integrais
--
-- Ou seja: o laco autonomo vinha "convergindo" (21 -> 14) sobre 2/12 da spec, e os 10 arquivos
-- restantes -- entre eles `modelo-dados.md` (172.323 chars) -- nunca foram lidos por um juiz. Com o
-- teto de janela em 200.000 CHARS e a promocao a integral sempre do MENOR para o maior, a escolha era
-- DETERMINISTICA: os mesmos 2 arquivinhos em toda rodada, para sempre. "GAPs = 0" nesse regime nao
-- significa spec sem GAP -- significa spec sem GAP NA PARTE QUE FOI OLHADA.
--
-- Duas colunas, dois fatos distintos:
--
--   spec_validation_runs.stage_b_coverage  = o que ESTA run mediu (full/outlineOnly/cap/totalChars).
--     E o fato que faltava para o consumidor (tick do modo autonomo, noutro processo) saber que a
--     contagem cobre parte da superficie. Mesma licao do `stage_b_ran` (099): derivar seria opiniao.
--
--   project_spec_files.stage_b_full_sha/_at = a ultima vez que ESTE arquivo foi julgado INTEGRALMENTE
--     e com QUAL conteudo. E isso que permite a rotacao honesta: a rodada seguinte promove primeiro
--     quem ainda nao foi julgado no conteudo atual, ate a spec inteira ter passado por um juiz. O sha
--     e obrigatorio porque arquivo editado depois do julgamento volta a ser nao-julgado -- guardar so
--     um timestamp faria o laco declarar cobertura sobre texto que ninguem leu.
--
-- NULL nas tres colunas = run/arquivo anterior a esta migracao -> comportamento legado INTACTO.
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal/comentario.
ALTER TABLE spec_validation_runs ADD COLUMN IF NOT EXISTS stage_b_coverage JSONB;

COMMENT ON COLUMN spec_validation_runs.stage_b_coverage IS
  'GAP-18: cobertura do estagio adversarial nesta run -- {full:[paths integrais], outlineOnly:[paths so em sumario], totalChars, cap}. outlineOnly nao vazio = contagem de GAPs cobre PARTE da spec (o laco autonomo nao pode declarar sucesso). NULL = run anterior a migracao 101.';

ALTER TABLE project_spec_files ADD COLUMN IF NOT EXISTS stage_b_full_sha TEXT;

ALTER TABLE project_spec_files ADD COLUMN IF NOT EXISTS stage_b_full_at TIMESTAMPTZ;

COMMENT ON COLUMN project_spec_files.stage_b_full_sha IS
  'GAP-18: sha256 do conteudo que o estagio adversarial julgou INTEGRALMENTE por ultimo. Diferente do sha atual (ou NULL) = arquivo ainda nao julgado no conteudo de agora -> tem prioridade na proxima validacao.';

COMMENT ON COLUMN project_spec_files.stage_b_full_at IS
  'GAP-18: quando este arquivo foi julgado integralmente pelo estagio adversarial (par de stage_b_full_sha -- so para leitura humana/diagnostico).';

-- 🔴 O indice UNICO `svr_dedupe_passed` (migracao 074) proibia DUAS runs 'passed' com o mesmo
-- spec_hash. Isso era coerente enquanto uma validacao 'passed' significava "a spec inteira foi
-- julgada e passou" -- mas com o teto de janela ela pode significar "os 2 de 12 arquivos que couberam
-- passaram". A rotacao de cobertura (GAP-18) EXIGE revalidar o MESMO conteudo julgando arquivos
-- diferentes, e o UPDATE final da 2a run bateria em 23505 dentro do setImmediate: a run ficaria presa
-- em 'running' ate o reaper marcar 'interrupted', e o laco autonomo esperaria um resultado que nunca
-- vem. O dedupe continua existindo -- agora como REGRA, em startValidation, que sabe ler a cobertura
-- (reaproveita a run verde so quando nao ha nada novo a julgar). O indice virou NAO-unico
-- porque a consulta do dedupe (project_id, spec_hash, mais recente primeiro) continua valendo.
-- Concorrencia segue impossivel por outro caminho: `svr_one_flight` ja limita a 1 run viva por alvo.
DROP INDEX IF EXISTS svr_dedupe_passed;

CREATE INDEX IF NOT EXISTS svr_passed_by_hash
  ON spec_validation_runs (project_id, spec_hash, created_at DESC)
  WHERE status = 'passed' AND project_id IS NOT NULL;
