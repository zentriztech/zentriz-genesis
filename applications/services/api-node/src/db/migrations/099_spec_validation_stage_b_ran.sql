-- 099 — GAP-13: registrar SE o estagio adversarial (B) rodou nesta validacao.
--
-- MEDIDO EM PROD 2026-09-06 (NVX LastMile, run de autonomia c3757985):
--
--   spec_validation_runs 8e3286b2 | failed | 21:25:32.733 -> 21:25:32.963 | 1 finding
--   spec_autonomy_runs.rounds[4].note = "Validacao failed: 21 -> 1 GAP(s) importante(s)"
--   spec_autonomy_runs.rounds[5].note = "Validacao failed: 1 -> 21 GAP(s) importante(s)"
--
-- A validacao durou 230 ms (as reais levam ~5 min) porque o Estagio A achou um BLOCKER estrutural
-- (`archetype_unknown`, ver GAP-14) e, por desenho, o Estagio B NAO roda em spec quebrada -- nao se
-- gasta LLM adversarial num documento que a fabrica nem sabe rotear. Logo aquele "1" nao era a spec
-- com 1 GAP: era 1 GAP medido sobre uma superficie COMPLETAMENTE DIFERENTE da que produziu o "21".
--
-- O laco autonomo comparou os dois numeros como se fossem a mesma medida: registrou "21 -> 1" como
-- PROGRESSO (zerando `no_progress_streak`) e, na validacao seguinte, "1 -> 21" como REGRESSAO. As
-- duas leituras sao ficcao, e a primeira e a perigosa: com o teto de passes proximo, o laco poderia
-- anunciar convergencia com 21 GAPs reais em aberto.
--
-- Por que a coluna: "quantos findings do Estagio B vieram" NAO responde a pergunta -- zero findings
-- de B tambem e o resultado legitimo de um B que rodou e nao achou nada. Derivar seria opiniao. O
-- fato nasce em processValidationRun (specValidation.ts) e e consumido depois, noutro processo, pelo
-- tick do modo autonomo (checkValidation). Logo: persistido.
--
-- NULL = run anterior a esta migracao -> comparacao INTACTA (so `false` explicito marca parcial).
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal/comentario.
ALTER TABLE spec_validation_runs ADD COLUMN IF NOT EXISTS stage_b_ran BOOLEAN;

COMMENT ON COLUMN spec_validation_runs.stage_b_ran IS
  'GAP-13: true = estagio adversarial (LLM) rodou e devolveu. false = pulado (blocker do Estagio A / sem arquivos) ou falhou -- contagem de GAPs NAO comparavel com a de uma validacao completa. NULL = run anterior a migracao 099.';
