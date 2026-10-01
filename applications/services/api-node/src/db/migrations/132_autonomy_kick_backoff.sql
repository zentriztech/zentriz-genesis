-- 132 - recuo PERSISTIDO do disparo de validacao do laco autonomo (ponto fraco 1 do post-mortem 30/09/2026).
--
-- kickValidation tentava de novo a cada tick (20 s) quando startValidation lancava, e o freio de
-- 4 validacoes/h por spec vivia so em memoria (zerava a cada restart da api). Agora a falha conta
-- no banco, com espera crescente e desistencia apos N tentativas. O freio de 4/h passa a contar
-- tambem as linhas de spec_validation_runs (indice svr_by_project da 074 ja cobre a consulta).

ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS kick_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS kick_next_at TIMESTAMPTZ;
