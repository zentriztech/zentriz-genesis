-- 113 -- GAP-118: o veredicto passa a registrar SOBRE QUE PECA o juiz decidiu.
--
-- POR QUE: a rodada adversarial de promovibilidade (GAP-77) so admitia uma peca de quem vai
-- construir -- a ACUSACAO ("eu construiria este artefato errado por causa deste defeito"). O
-- PROSECUTOR_SYSTEM, no entanto, MANDA deixar o artefato vazio quando o engenheiro construiria a
-- coisa certa mesmo com o defeito no texto ("nao invente um dano"). Resultado medido em producao na
-- run 185d738a (NVX LastMile): de 8 candidatos elegiveis, 3 foram acusados e julgados, e 5 sairam da
-- rodada em SILENCIO -- a unica voz capaz de absolver era exatamente a que o codigo descartava.
-- Defeito de redacao ficava impeditivo para sempre, rodada apos rodada, que e o loop infinito que o
-- Jean proibiu ("nao podemos entrar em um loop infito em busca da perfeicao").
--
-- O QUE MUDA: artefato vazio agora vale como peca se vier DEFESA sustentada -- o construtor diz o que
-- construiria de CERTO e cita o trecho verbatim (minimo de caracteres mais ALTO que o da acusacao,
-- porque acusar erra para o lado seguro e defender erra para o lado caro). A defesa NAO libera nada:
-- ela compra o direito de ser JULGADA. O juiz decide contra o trecho, com o mesmo onus de sempre
-- (motivo minimo, teto por rodada, "na duvida e impeditivo"). Duas vozes separadas tem de concordar.
--
-- O QUE NAO MUDA: fail-CLOSED em todo degrau (sem LLM, sem JSON, sem peca sustentada, sem motivo, id
-- inventado -> nenhuma linha `nao_impeditivo`), a severidade do finding (limite (a) do Jean) e o fato
-- de que promover a Fabrica continua sendo ato HUMANO.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.
ALTER TABLE spec_gap_promotion_verdicts
  ADD COLUMN IF NOT EXISTS stance TEXT NOT NULL DEFAULT 'acusacao';

ALTER TABLE spec_gap_promotion_verdicts
  ADD COLUMN IF NOT EXISTS defense TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN spec_gap_promotion_verdicts.stance IS
  'GAP-118: sobre que PECA o juiz decidiu. acusacao = quem vai construir nomeou o artefato que sairia errado. defesa = ele afirmou que construiria certo mesmo assim, dizendo o que construiria e citando o trecho. Linhas anteriores ao GAP-118 sao todas acusacao (default), porque a defesa nem chegava ao juiz.';

COMMENT ON COLUMN spec_gap_promotion_verdicts.defense IS
  'GAP-118: a defesa sustentada, verbatim, quando a peca foi defesa. Vazia quando a peca foi acusacao. Defesa vaga ou que nao cita o trecho NAO gera linha nenhuma -- o candidato sai da rodada e segue impeditivo (fail-CLOSED).';
