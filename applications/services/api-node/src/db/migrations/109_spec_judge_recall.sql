-- 109 -- F4: RECALL DO JUIZ, medido por INJECAO DE DEFEITO.
--
-- POR QUE (a metade que faltava da medicao):
--   * O FALSO POSITIVO do juiz JA foi medido em prod (2026-09-07, migracao 106): um revisor de outra
--     familia (Nova Pro) auditou 12 findings da NVX LastMile e nao achou NENHUM inventado (ausente = 0).
--   * O RECALL nunca foi medido: de todos os defeitos realmente presentes, quantos o juiz encontra?
--     arXiv:2609.03230 mede a mediana de 47% para juiz LLM em defeito de requisito, com 11% de FP.
--     Se o nosso recall for 47%, "0 GAPs ATIVOS" quer dizer "0 GAPs na metade que eu vejo" -- e o laco
--     autonomo estaria fechando por CEGUEIRA, nao por qualidade. Sem este numero o veredicto de
--     promovibilidade (migracao 105) nao e interpretavel.
--   * O juiz medido e O JUIZ: o texto mutado vai pelo MESMO `/invoke/spec_validator/async`, com o mesmo
--     prompt e o mesmo modelo do tenant. Medir uma imitacao do juiz seria medir uma coisa acreditando
--     medir outra -- o defeito mais caro desta familia.
--   * A mutacao vive SO EM MEMORIA. Nenhum arquivo persistido da spec e alterado, nunca. E esta tabela
--     nao cria linha em `spec_validation_runs`: se criasse, o laco passaria a contar GAPs INJETADOS por
--     nos como GAPs da spec.
--
-- REVISAO ADVERSARIAL CROSS-FAMILY do desenho (2026-09-08, dentro do container de prod, ANTES do
-- codigo): Nova Pro (4 achados) e Mistral Large 3 (10 achados). O que virou desenho aqui:
--   * ACEITO (Mistral A1, grave) = GAP-90: injetar so em secao nomeada mede a atencao do juiz a
--     TITULOS. `position` (secao_nomeada | corpo_sem_titulo) e obrigatorio e o recall e ESTRATIFICADO.
--   * ACEITO (Mistral A7, grave) = GAP-91: medir so as 13 categorias da triagem mede o proprio
--     vocabulario. `in_vocabulary` entra no item e o recall e separado dentro/fora dele.
--   * ACEITO (Mistral A8/A4, medio) = GAP-92: defeito distribuido exige correlacionar DOIS arquivos.
--     `scope` distribuido obriga um segundo par verbatim, e o defeito so e ELEGIVEL se os dois arquivos
--     chegaram integrais ao juiz.
--   * ACEITO (Nova A1/A2 + Mistral A3/A6, grave) = GAP-93: o CASADOR tambem erra, e o erro dele entra
--     direto no recall. O casador e de OUTRA familia que o juiz (mesma familia = limitacao declarada),
--     a citacao dele e conferida VERBATIM contra os findings, e uma AMOSTRA e recasada por um TERCEIRO
--     modelo para estimar a discordancia entre casadores.
--   * ACEITO (Mistral A2, grave) = GAP-94: gold set so com defeito obvio produz recall alto e inutil.
--     `difficulty` e declarada pelo injetor e o recall e por faixa.
--   * ACEITO (Mistral A5, medio) = GAP-95: `gold_set_version` inclui a AMOSTRA (arquivos e tamanhos),
--     nao so os defeitos. Recall que subiu porque a amostra ficou mais facil nao e recall que subiu.
--   * ACEITO (Nova A3, medio) = GAP-96: injetor e casador leem o vocabulario VERBATIM da MESMA
--     constante. Definicoes diferentes produziriam discordancia que parece recall.
--   * ACEITO (Nova A4 + Mistral A10) = GAP-97: defeito cujo arquivo nao chegou ao juiz e falha de
--     COBERTURA do harness, nao perda do juiz -- sai do DENOMINADOR e tem coluna propria (`uncovered`).
--
--   * REFUTADO pela NOSSA medicao (Mistral A3/A6, e por isso declarado): os dois modelos pediram
--     casamento ESTRITO, exigindo ancora E classe iguais. O GAP-49 mediu em prod que 32 dos 152 pares
--     (arquivo, ancora) apareceram com 2 ou 3 categorias DIFERENTES para o mesmo defeito -- a category
--     e interpretacao livre do juiz e por isso ja saiu da identidade do finding. Exigir classe exata
--     DEPRIMIRIA o recall por defeito de vocabulario, nao por cegueira do juiz. O casamento e por LUGAR
--     e SENTIDO, e `class_agreed` fica REGISTRADO no item para estratificar, nunca para casar.
--   * RECUSADO (Nova A1/A2, "revisao manual adicional"): nao ha humano no laco, e por A5 do Jean a
--     decisao e de agente. O que fica no lugar e a estimativa por TERCEIRO casador (GAP-93) -- o erro
--     do casador passa a ser MEDIDO e declarado, em vez de eliminado no papel.
--   * RECUSADO (Mistral A9, limiar de confianca do juiz): o juiz nao emite confianca. Pedir que emitisse
--     mudaria o contrato do estagio B -- mediriamos um juiz diferente do que roda em producao.
--
-- DIRECAO DO ERRO RESIDUAL: PARA BAIXO. Todo caso duvidoso (citacao que nao confere, `parcial`, casador
-- ausente) fica FORA do numerador. O numero que sai e um PISO (`recall_min`) e o teto vai publicado ao
-- lado (`recall_max`): o recall verdadeiro vive na banda. Recall inflado e o unico erro aqui que custa a
-- spec -- e ele que autoriza confiar num juiz cego.
--
-- LIMITES DE DESENHO (o que esta tabela NAO faz):
--   1. nao promove, nao barra e nao gera finding. E MEDICAO -- nada aqui entra na contagem de GAPs.
--   2. nao corrige o recall com a opiniao do terceiro casador: ESTIMA o erro de quem mediu. Corrigir
--      seria fingir que o terceiro modelo e a verdade.
--   3. nao mede defeito que dependa de persistencia, de link entre arquivos gravados ou de estado do
--      sistema -- a mutacao e so em memoria, e isso fica DECLARADO em `limitations`.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

CREATE TABLE IF NOT EXISTS spec_judge_recall_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_hash             text NOT NULL,
  gold_set_version      text NOT NULL,
  judge_model           text NOT NULL DEFAULT '',
  match_model           text NOT NULL DEFAULT '',
  same_family           boolean NOT NULL DEFAULT false,
  injected              integer NOT NULL DEFAULT 0,
  eligible              integer NOT NULL DEFAULT 0,
  found                 integer NOT NULL DEFAULT 0,
  partial_matches       integer NOT NULL DEFAULT 0,
  missed                integer NOT NULL DEFAULT 0,
  undecided             integer NOT NULL DEFAULT 0,
  uncovered             integer NOT NULL DEFAULT 0,
  recall_min            double precision NOT NULL DEFAULT 0,
  recall_max            double precision NOT NULL DEFAULT 0,
  findings_count        integer NOT NULL DEFAULT 0,
  matcher_sample        integer NOT NULL DEFAULT 0,
  matcher_disagreement  double precision,
  note                  text NOT NULL DEFAULT '',
  limitations           jsonb NOT NULL DEFAULT '[]'::jsonb,
  defects               jsonb NOT NULL DEFAULT '[]'::jsonb,
  items                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  strata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  autonomy_run_id       uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS spec_judge_recall_runs_gold_uidx
  ON spec_judge_recall_runs (project_id, spec_hash, gold_set_version, judge_model);

CREATE INDEX IF NOT EXISTS spec_judge_recall_runs_latest_idx
  ON spec_judge_recall_runs (project_id, created_at DESC);

COMMENT ON TABLE spec_judge_recall_runs IS
  'F4: o RECALL do juiz de spec, medido por injecao de defeito em memoria. Uma linha por (projeto, spec_hash, versao do gold set, juiz). Complementa a migracao 106, que mediu o falso positivo -- juntas, as duas descrevem o juiz.';
COMMENT ON COLUMN spec_judge_recall_runs.gold_set_version IS
  'sha256 da AMOSTRA (arquivos e tamanhos) mais os defeitos (classe, ancora, hash do trecho mutado). Recall de versoes diferentes NAO e comparavel: subir porque a amostra ficou mais facil nao e subir (GAP-95).';
COMMENT ON COLUMN spec_judge_recall_runs.same_family IS
  'Casador da MESMA familia do juiz. arXiv:2609.04270 mede ZERO ganho em auto-revisao ⇒ true e o cenario mais fragil, e vira limitacao declarada em vez de bloqueio (GAP-93).';
COMMENT ON COLUMN spec_judge_recall_runs.eligible IS
  'Defeitos cujo arquivo (ou OS DOIS, se distribuido) chegou INTEGRAL ao juiz. E o denominador do recall. Defeito fora da cobertura nao foi perdido pelo juiz -- vai para `uncovered` (GAP-97).';
COMMENT ON COLUMN spec_judge_recall_runs.recall_min IS
  'PISO: apenas `encontrado` com citacao conferida verbatim. Todo caso duvidoso fica fora do numerador -- errar para baixo custa rodada, errar para cima custa a spec.';
COMMENT ON COLUMN spec_judge_recall_runs.recall_max IS
  'TETO: `encontrado` mais `parcial` mais os sem casamento conferido. O recall verdadeiro vive na banda [recall_min, recall_max], e publicar um ponto so seria esconder a incerteza.';
COMMENT ON COLUMN spec_judge_recall_runs.matcher_disagreement IS
  'Fracao da amostra em que um TERCEIRO modelo discordou do casador. NAO corrige o recall: estima o erro de quem o mediu (GAP-93). NULL = amostra nenhuma foi recasada, e isso e uma limitacao declarada.';
COMMENT ON COLUMN spec_judge_recall_runs.strata IS
  'Recall por classe, dificuldade, posicao, escopo e dentro/fora do vocabulario. O agregado e o numero MENOS informativo: 60% global com 100% em secao nomeada e 20% em corpo sem titulo nao descreve um juiz razoavel -- descreve um juiz que le titulos (mesma licao do GAP-76).';
COMMENT ON COLUMN spec_judge_recall_runs.limitations IS
  'O que esta medicao NAO mede, em prosa: gold set sem defeito sutil, sem distribuido, sem corpo_sem_titulo, casador da mesma familia, injecoes recusadas por nao serem verbatim, e o limite da mutacao em memoria. Quem le o recall precisa ler isto junto.';
