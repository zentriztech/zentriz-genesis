-- 095 — PR-5 (F2): modo autonomo POR ARQUIVO (fila de 1 arquivo por rodada).
-- Depois da divisao da spec (PR-3) o arquivo primario e so o INDICE: o laco de hoje mandaria o
-- indice ao CTO normalizador e receberia de volta uma spec inteira — a MESMA causa do truncamento
-- de 64k tokens de saida que este epico mata. No modo por arquivo uma rodada trata UM arquivo e so
-- os GAPs daquele arquivo (specGapScope, migracao 094), e a validacao adversarial (limitada a 4/h)
-- roda UMA vez por PASSE, quando a fila de arquivos esvazia.
-- Semantica das colunas novas:
--   mode         'whole' (spec de 1 arquivo, comportamento da 090) ou 'per_file'
--   passes       ciclos de validacao concluidos — e este o contador que respeita max_rounds
--   round        no modo per_file passa a contar ARQUIVOS revisados (teto proprio no codigo)
--   current_file arquivo (rel_dir/filename) em revisao nesta rodada — o apply escreve NELE
--   files_done   arquivos ja tratados no passe corrente (zerado a cada validacao)
--   file_failures falhas consecutivas em nivel de ARQUIVO (2 seguidas param o laco)
-- NOTA runner de migrations: split ingenuo por ';' — nenhum ';' em literal, comentarios so em
-- linha propria, sem blocos DO/$$.
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'whole';
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS passes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS current_file TEXT;
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS files_done JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS file_failures INTEGER NOT NULL DEFAULT 0;
