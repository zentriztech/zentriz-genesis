-- 120 -- GAP-152: o VEREDICTO do A/B do juiz existia em PROSA e morria dentro do processo.
--
-- POR QUE:
--   * `abNote()` (specJudgeRecall.ts) produz a unica leitura do A/B que um humano consegue usar: nao os
--     numeros, mas a FRASE que diz se o resultado autoriza mudar o padrao. Foi ela que, em prod
--     2026-09-09, disse "3 discordantes com ~10 defeitos = nada decidido" -- a conclusao que desligou o
--     braco B do GAP-144.
--   * Essa frase era atribuida ao objeto em memoria (`res.abNote`) e NUNCA gravada. O `gravar()` persistia
--     `ab_paired` (as contagens) e a coluna `note` (que e a nota de recall DE CADA BRACO, outra coisa).
--     Resultado: quem abrisse a rota `GET /api/specs/:id/judge-recall` no dia seguinte recebia 6 contagens
--     e tinha de reconstruir sozinho o julgamento -- e reconstruir julgamento a partir de contagem e
--     exatamente o que o GAP-149 mostrou que ninguem faz.
--   * E a MESMA familia do GAP-149 (a medicao existia e ninguem a lia) e do GAP-141 (o fato voltava e
--     nenhum consumidor o consumia): instrumento sem leitor nao muda decisao nenhuma.
--
-- O DESENHO:
--   * `ab_note` e NULL quando o A/B nao rodou naquela linha -- NULL e "nao medido", nao "sem conclusao"
--     (a mesma regra das colunas de cache da migracao 116).
--   * A prosa e gravada nas DUAS linhas do A/B (braco A e braco B) porque o veredicto e do PAR, nao de um
--     braco: ler a linha do baseline sozinha e um caminho normal na UI, e ali a conclusao tem de estar.
--   * Nao muda contagem, nao muda gate, nao muda prompt: e transporte de um fato que ja era produzido.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

ALTER TABLE spec_judge_recall_runs
  ADD COLUMN IF NOT EXISTS ab_note text;

COMMENT ON COLUMN spec_judge_recall_runs.ab_note IS
  'Veredicto em PROSA da comparacao pareada do A/B (GAP-144), gravado nas DUAS linhas do par: diz se o resultado autoriza mudar o default ou se a incerteza domina (ex.: 3 discordantes com ~10 defeitos = nada decidido). NULL = o A/B nao rodou nesta linha (nao medido), nunca "sem conclusao". Gerado por `abNote()` -- codigo, nao LLM.';
