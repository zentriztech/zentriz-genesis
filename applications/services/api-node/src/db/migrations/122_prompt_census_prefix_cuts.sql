-- 122 -- GAP-167: o instrumento do cache media um prefixo que era POR ARQUIVO por construcao.
--
-- O QUE FOI MEDIDO (tabela `prompt_census` em prod, 2026-09-09): 57 chamadas de `api-gapfile`, e delas
-- **0 com `head_seen > 1` e 0 com acerto dentro do TTL**. Cabeca media de 44.604 chars num total medio
-- de 134.992. A leitura facil desse numero seria "cache nao paga no escritor da Bancada" -- e ela
-- estaria errada pelo mesmo motivo do GAP-14: a conta nao olhou a premissa.
--
-- A cabeca declarada por aquele caminho (`cabecaEstavel` em routes/specChat.ts) contem, por desenho,
-- `ARQUIVO: <path>` e os blocos de irmaos, manifesto, indice e remissoes mortas -- todos POR ARQUIVO.
-- O hash EXATO dela so poderia repetir numa retentativa do mesmo arquivo com todo o resto identico.
-- Ou seja: o instrumento confirmou a hipotese do GAP-153 ("a cabeca so repete entre retentativas") por
-- CONSTRUCAO, nao por evidencia. Um medidor que nao pode observar o fenomeno que ele veio medir e pior
-- que nenhum, porque produz um numero que parece resposta.
--
-- O QUE ESTA MIGRACAO ACRESCENTA: a pergunta certa nao e "a cabeca inteira repetiu?", e sim "ATE QUE
-- PONTO os primeiros bytes sao os mesmos?". O censo passa a medir cortes fixos de prefixo (4k, 8k,
-- 16k, 32k, 64k chars), cada um com hash proprio na tabela do processo, e a gravar o MAIOR corte que
-- repetiu dentro do TTL de 5 min do provedor.
--
--   * `head_prefix_hit_chars` = 0 significa que nem os primeiros 4.096 chars (o piso do provedor)
--     repetem. Nesse caso o problema NAO e o cache: e a ORDEM dos blocos no prompt, e a decisao passa
--     a ser "reordenar para existir um prefixo invariante" em vez de "marcar cache".
--   * > 0 e o endereco exato de onde marcar hoje, sem reordenar nada.
--   * NULL = o caminho nao declarou cabeca (mesma regra de `head_hash`): "nao declarado" nao e "nao
--     repete". Zero e MEDICAO, NULL e AUSENCIA de medicao.
--
-- Esta migracao NAO marca ponto de cache em lugar algum e NAO corta bloco nenhum do prompt: a lei do
-- GAP-153/159 e medir antes de marcar, e prefixo que nao repete pagaria 1,25x de escrita por nada.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

ALTER TABLE prompt_census
  ADD COLUMN IF NOT EXISTS head_prefix_hit_chars integer;

ALTER TABLE prompt_census
  ADD COLUMN IF NOT EXISTS head_prefix_cuts jsonb;

COMMENT ON COLUMN prompt_census.head_prefix_hit_chars IS
  'GAP-167: o MAIOR corte de prefixo (chars) que repetiu dentro do TTL de 5 min do provedor. 0 = nem o piso de 4096 chars repete, e ai o defeito e a ORDEM dos blocos, nao o cache. NULL = o caminho nao declarou cabeca (ausencia de medicao, nao medicao de ausencia).';

COMMENT ON COLUMN prompt_census.head_prefix_cuts IS
  'GAP-167: cada corte medido, na forma [{chars, seen, hitWithinTtl}]. Guardar a serie inteira (e nao so o maior acerto) e o que permite ver o prefixo invariante ENCOLHER quando um bloco novo entra no inicio do prompt.';
