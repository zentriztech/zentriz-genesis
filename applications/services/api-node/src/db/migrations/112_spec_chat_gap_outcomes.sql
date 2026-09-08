-- 112 -- A1: o DESFECHO NOMEADO de cada GAP despachado ao CTO-editor.
--
-- PROBLEMA: o que aconteceu com cada GAP de uma rodada era sempre INFERIDO pela validacao seguinte
-- ("reapareceu" = nao fechou). Duas leituras erradas nascem dai: (a) um GAP que o agente NAO
-- conseguiu fechar -- e sabia -- so e descoberto um passe inteiro de Opus 5 depois, e sem o motivo a
-- rodada seguinte repete o mesmo pedido; (b) um GAP que o agente considera INEXISTENTE nao tem canal
-- nenhum, entao ele escreve uma errata no arquivo declarando o trecho nulo: o arquivo cresce, o juiz
-- rele o texto original e reabre o mesmo GAP (o GAP-8 pela porta dos fundos).
--
-- DESENHO: quem declara e o AGENTE, em vocabulario FECHADO (corrigido / permanece_aberto /
-- nao_e_deste_arquivo / nao_e_defeito), por NUMERO do GAP na lista despachada. O codigo so transporta
-- e veta corrupcao (numero fora da lista, numero repetido, verbo inventado, e a unica contradicao
-- verificavel: `corrigido` com ZERO edicao ancorada aplicada). GAP despachado sem desfecho fica
-- `nao_declarado` -- "ninguem disse" e diferente de "esta fechado" (mesma lei do C7/notMeasured).
--
-- `nao_e_defeito` NAO apaga GAP: e a POSICAO do agente, e o argumento vai ao juiz na validacao
-- seguinte. Quem decide promovibilidade continua sendo o juiz (decisao do Jean 2026-09-07).
--
-- Coluna nova, `null` para todo job anterior -- e `null` significa exatamente "esta rodada nao pediu
-- prestacao de contas", nao "o agente ficou calado".
ALTER TABLE spec_chat_jobs ADD COLUMN IF NOT EXISTS gap_outcomes jsonb;

COMMENT ON COLUMN spec_chat_jobs.gap_outcomes IS
  'A1: desfecho declarado pelo agente para cada GAP despachado neste job (array de {index,file,anchor,title,severity,verb,note,contested}). null = rodada sem prestacao de contas.';
