-- 111 -- GAP-101/102: o que a SEGUNDA medicao de recall descobriu sobre si mesma.
--
-- A segunda prova ao vivo (2026-09-08, projeto NVX LastMile, gold set 0356133ad6a3b2412fa3046de374f32c)
-- rodou DEPOIS do fix do GAP-98 -- ou seja, foi a primeira medicao em que o casador realmente rodou em
-- outra familia (`amazon.nova-pro-v1:0`, confirmado por `model_used`, nao pelo pedido). O numero MUDOU
-- de lugar: recall entre 43% e 57%, e nao os 14%..29% que a auto-revisao havia produzido. Ler essa prova
-- expos dois defeitos NOVOS, os dois da mesma linhagem de sempre (o relatorio afirmando mais do que mediu):
--
--   * GAP-101 (medio, corrigido em `auditMatches`): a auditoria devolveu "100% de discordancia sobre 3"
--     sem dizer DE QUE TIPO. `auditMatches` contava como discordancia tanto o terceiro casador dizendo o
--     contrario quanto o terceiro casador NAO DIZENDO NADA (ausente da resposta, ou `indecidivel` com
--     motivo `sem_parecer`). Silencio e desacordo tem significados opostos: um mede incerteza do
--     instrumento, o outro mede desacordo real entre familias. Somados, "100%" nao e interpretavel --
--     e a leitura natural (a mais alarmante) e justamente a errada. E o mesmo defeito do GAP-89 e do
--     GAP-63 num lugar novo: colapsar ausencia de opiniao em opiniao negativa.
--     ⇒ `no_opinion` passa a ser medido e gravado SEPARADO. A discordancia continua incluindo o silencio
--     (a direcao do erro desenhada e para CIMA na incerteza, nunca para cima no recall), mas agora quem
--     le sabe quanto dela e silencio.
--   * GAP-102 (baixo, declarado): um finding so pode ser o achado de UM defeito -- senao o casador fecha
--     dois defeitos do gold set com uma frase e o recall infla. Mas QUEM fica com o finding e decidido
--     pela ORDEM da lista que o casador devolveu, nao pela forca da evidencia. Medido: D06 perdeu para
--     D03 o finding do payload `delivery.created` e virou `nao_encontrado` sem nenhuma contagem propria.
--     A direcao do erro e a desenhada (deprime o recall, nunca infla), e por isso a REGRA FICA -- o que
--     nao pode ficar e o numero sem nome. ⇒ vai como limitacao declarada, com contagem.
--
-- POR QUE COLUNA NOVA E NAO EDITAR A 110: a migracao 110 ja esta APLICADA em prod. Editar migracao
-- aplicada e mentir sobre o historico do schema -- o runner nao reaplica, e o proximo ambiente ganharia
-- um schema diferente do de prod com o mesmo numero.
--
-- ESTA MIGRACAO NAO ALTERA DADO NENHUM. As linhas ja gravadas ficam com `matcher_no_opinion` NULL, que
-- e a verdade: naquelas medicoes o silencio nao foi separado da discordancia. NULL aqui significa "nao
-- medido", nunca "zero".
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

ALTER TABLE spec_judge_recall_runs
  ADD COLUMN IF NOT EXISTS matcher_no_opinion numeric;

COMMENT ON COLUMN spec_judge_recall_runs.matcher_no_opinion IS
  'Fracao da amostra recasada em que o terceiro casador NAO OPINOU (ausente da resposta, ou indecidivel por sem_parecer) -- GAP-101. Esta fracao esta INCLUIDA em `matcher_disagreement`: silencio empurra a incerteza para cima, nunca o recall. NULL = nao medido (medicoes anteriores a esta migracao, ou auditoria que nao rodou), jamais zero.';
