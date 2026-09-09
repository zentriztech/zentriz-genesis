-- 118 -- GAP-144: o RACIOCINIO ESTENDIDO do juiz deixa de ser fe e passa a ser BRACO MEDIDO.
--
-- POR QUE:
--   * `runtime.py:_thinking_extra` manda `thinking={"type":"disabled"}` para TODA chamada, inclusive o
--     refutador do estagio B. A justificativa historica e legitima e MEDIDA (achado #51 + prod
--     2026-09-05): os tokens de raciocinio contam contra `max_tokens`, e a fatia e variavel e invisivel
--     -- o refutador a 16.000 batia no teto, cortava o JSON e pagava um retry pelo mesmo resultado.
--   * Mas refutar e a tarefa onde raciocinio paga MAIS, e a saida do refutador e pequena (findings).
--     E o recall do nosso juiz foi MEDIDO em 43%..57% (migracao 109), com `sutil` em 20%..40% e
--     `fora_do_vocabulario` em 0%. Ou seja: existe cegueira de sobra para o raciocinio atacar.
--   * Ligar por convicao seria trocar uma suposicao por outra. Entao o raciocinio entra como BRACO de um
--     A/B sobre o MESMO gold set, medido pelo instrumento que ja existe (injecao de defeito), e a coluna
--     abaixo diz QUAL braco produziu cada linha.
--
-- O DESENHO, e o que ele NAO promete:
--   * `judge_thinking` entra na CHAVE de unicidade. Sem isso o segundo braco SOBRESCREVERIA o primeiro e
--     a comparacao viraria uma linha so -- exatamente o erro que a migracao 109 evita em `gold_set_version`.
--   * A comparacao e PAREADA (`ab_paired`), nao duas proporcoes independentes. Motivo medido em prod: tres
--     medicoes sobre a MESMA spec com o MESMO juiz deram 14%..29%, 43%..57% e 14%..43%. Com ~10 defeitos, o
--     intervalo de Wilson e mais largo que qualquer efeito plausivel: comparar dois recalls agregados
--     mediria a AMOSTRA, nao o braco. Pareado, cada defeito e seu proprio controle e o que se le sao os
--     DISCORDANTES (`only_baseline` / `only_thinking`).
--   * Nao decide nada sozinho: `RECALL_MIN_ELIGIBLE` (20) segue valendo como piso de DECLARACAO. Abaixo
--     dele o resultado do A/B vai com a incerteza colada e NAO autoriza virar o default.
--   * Reversivel sem deploy: `SPEC_VALIDATOR_THINKING` (env, default off) e o parametro `thinking` por
--     requisicao no `/invoke/spec_validator/async` -- o braco B nao exige recriar container (recriar
--     container no meio de uma run corta a chamada do LLM, e o A/B mediria o corte).
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

ALTER TABLE spec_judge_recall_runs
  ADD COLUMN IF NOT EXISTS judge_thinking boolean NOT NULL DEFAULT false;

ALTER TABLE spec_judge_recall_runs
  ADD COLUMN IF NOT EXISTS ab_paired jsonb NOT NULL DEFAULT '{}'::jsonb;

DROP INDEX IF EXISTS spec_judge_recall_runs_gold_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS spec_judge_recall_runs_gold_uidx
  ON spec_judge_recall_runs (project_id, spec_hash, gold_set_version, judge_model, judge_thinking);

COMMENT ON COLUMN spec_judge_recall_runs.judge_thinking IS
  'Braco do A/B do GAP-144: false = refutador com raciocinio DESLIGADO (o padrao historico, achado #51), true = raciocinio adaptativo ligado so no refutador. Entra na chave de unicidade porque as duas linhas descrevem o MESMO gold set julgado por dois juizes diferentes -- sobrescrever uma com a outra apagaria a comparacao.';

COMMENT ON COLUMN spec_judge_recall_runs.ab_paired IS
  'Comparacao PAREADA defeito a defeito entre os dois bracos, gravada na linha do braco `thinking`: both, neither, only_baseline, only_thinking, discordant, eligible. Duas proporcoes independentes sobre ~10 defeitos mediriam a amostra (em prod, a MESMA spec e o MESMO juiz deram 14%..29%, 43%..57% e 14%..43%) -- pareado, cada defeito e seu proprio controle. `{}` = o A/B nao rodou nesta linha.';
