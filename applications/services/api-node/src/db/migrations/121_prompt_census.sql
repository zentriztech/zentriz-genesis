-- 121 -- GAP-159: o INSTRUMENTO que decide onde cortar tokens vivia so em log de container.
--
-- O QUE ACONTECEU (medido no proprio deploy do GAP-158, 2026-09-09 15:10 UTC): recriar o container da
-- api -- que e o fluxo de deploy CANONICO deste produto, executado varias vezes por dia -- apagou
-- todos os `[prompt-census]` do dia. O censo do GAP-146 foi declarado "etapa 1 e SO LOG; o corte vem
-- depois, decidido pela distribuicao MEDIDA", e o censo de cabeca do GAP-153 vive numa tabela em
-- MEMORIA do processo (`headSeen`). As duas etapas 2 -- cortar o prompt do CTO pela distribuicao e
-- marcar ponto de cache pela taxa medida -- dependem de uma serie que nao sobrevive ao proprio deploy.
--
-- E pior que perder dado: em prod o restart RESSETA `headSeen`, entao toda primeira chamada apos um
-- deploy e contada como `head_repeat=estreia` mesmo quando o prefixo passou 30 s antes e o cache do
-- PROVEDOR (TTL de 5 min, do lado dele) ainda estaria quente. O instrumento SUBESTIMA a taxa de
-- acerto sistematicamente, e a decisao "nao vale marcar cache" seria tomada com o numero errado --
-- exatamente o desfecho que o GAP-147 cobrou em dinheiro (a economia existir e o medidor mentir).
--
-- O QUE ESTA TABELA E, E O QUE ELA NAO E:
--   * Uma linha por prompt EFETIVAMENTE montado, com o tamanho ENTREGUE de cada bloco em `fields`.
--     So TAMANHOS: nenhum byte de conteudo de spec de cliente entra aqui (regra 4 do censo). `file` e
--     o caminho do arquivo da spec, que ja vive neste mesmo banco -- nao e conteudo novo exposto.
--   * `outros` pode ser NEGATIVO de proposito: negativo = contagem DUPLA no chamador. E defeito com
--     nome, nao economia, e zerar a força esconderia o bug (mesma regra do log).
--   * `head_source` diz DE ONDE veio o veredicto de repeticao da cabeca: `memoria` (a tabela do
--     processo tinha a cabeca) ou `banco` (o processo achou que era estreia e esta tabela provou que
--     o mesmo prefixo passou antes). Sem esse campo, a correcao pos-restart seria indistinguivel de
--     uma medicao do processo -- e o numero que decide o cache tem de dizer como foi obtido.
--   * NULL != 0 do ecossistema: `head_hash` NULL = o caminho NAO declarou cabeca (nao se sabe onde
--     ficaria o ponto de cache), o que e diferente de "declarou e nao repetiu".
--   * Esta migracao NAO corta nenhum bloco do prompt e NAO marca cache em lugar algum. Ela so faz o
--     instrumento sobreviver ao deploy: instrumento ANTES do comportamento (GAP-148/150).
--
-- Volume esperado: os dois caminhos medidos somam algumas centenas de chamadas por dia (o censo do
-- GAP-146 mediu 764 chamadas de `spec_cto` em 3 dias) -- ordem de 1k linhas/dia no pior caso, cada uma
-- com um jsonb de ~15 inteiros. Nao ha purga nesta etapa de proposito: a serie longa e justamente o
-- ativo que faltava, e apagar historico de medicao para economizar kilobytes seria trocar a decisao
-- de corte por espaco em disco.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

CREATE TABLE IF NOT EXISTS prompt_census (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origem text NOT NULL,
  role text,
  file text,
  total integer NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  outros integer NOT NULL,
  head_hash text,
  head_chars integer,
  head_cacheable boolean,
  head_seen integer,
  head_since_last_ms bigint,
  head_hit_within_ttl boolean,
  head_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_census_head_source_ck
    CHECK (head_source IS NULL OR head_source IN ('memoria', 'banco'))
);

CREATE INDEX IF NOT EXISTS prompt_census_origem_created_idx
  ON prompt_census (origem, created_at DESC);

CREATE INDEX IF NOT EXISTS prompt_census_head_idx
  ON prompt_census (origem, head_hash, created_at DESC)
  WHERE head_hash IS NOT NULL;

COMMENT ON TABLE prompt_census IS
  'GAP-159: o censo de prompt do GAP-146/153 passa a sobreviver ao deploy. Antes vivia so em log de container (apagado a cada recreate da api, que e o fluxo de deploy canonico) e a tabela de cabecas vivia em memoria do processo, entao toda chamada pos-restart era contada como estreia e a taxa de acerto de cache era subestimada. So tamanhos, nunca conteudo de spec.';

COMMENT ON COLUMN prompt_census.fields IS
  'Tamanho ENTREGUE (em chars) de cada bloco que entrou no prompt, ja cortado pelo orcamento do bloco. Contar o PEDIDO faria o bloco cortado aparecer como despesa que nao existe.';

COMMENT ON COLUMN prompt_census.outros IS
  'total - soma(fields): delimitadores, rotulos e instrucao final. NEGATIVO = contagem dupla no chamador (defeito com nome), nunca economia.';

COMMENT ON COLUMN prompt_census.head_source IS
  'De onde veio o veredicto de repeticao da cabeca: memoria = a tabela do processo conhecia o prefixo. banco = o processo disse estreia e esta tabela provou que o mesmo prefixo passou antes (tipicamente apos um deploy, quando o cache do PROVEDOR ainda podia estar quente). NULL = o caminho nao declarou cabeca.';
