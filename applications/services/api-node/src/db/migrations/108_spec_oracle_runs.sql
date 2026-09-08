-- 108 -- F3: ORACULO EXECUTAVEL (item 3A do Jean).
--
-- POR QUE (medido, nao palpite):
--   * O F2 (migracao 107) derivou 119 constraints DECLARADAS da spec real do NVX LastMile.
--     Distribuicao medida: 0 `spec`, 62 `build`, 57 `runtime`. Ou seja: **zero julgaveis na Bancada**.
--     Nao e falha de prompt -- uma spec deste tipo declara comportamento do PRODUTO, nao propriedade
--     do TEXTO. O juiz de spec nao tem o que julgar porque o objeto do julgamento ainda nao existe.
--     ⇒ o oraculo executavel nao e melhoria do F2: e a UNICA rota que decide 119 de 119.
--   * arXiv:2609.04167: 34% dos patches que PASSAM nos testes VIOLAM constraints declaradas. Por isso
--     suite verde JAMAIS satisfaz constraint que nenhum teste exercita -- isso e `indecidivel`, e o
--     prompt do juiz do oraculo diz isso com todas as letras.
--   * GAP-85 (medido em `runner.py`): a ultima porta de QA da Fabrica decidia por SUBSTRING na prosa
--     do agente -- `any(w in texto.upper() for w in ["APROVADO","PASSED","QA_PASS","ALL CHECKS"])`.
--     "NAO APROVADO" contem "APROVADO" ⇒ relatorio que REPROVA marcava a task como DONE. O campo
--     estruturado `approved`, que o full-test-server devolve, era apenas logado.
--   * GAP-86 (medido em `runner.py`): `_evo_run_tests` (executor isolado do Host B, `/run-tests`) so
--     era chamado quando existia baseline de EVOLUCAO. Em PRIMEIRO build (Bancada -> Fabrica) a suite
--     nunca rodava: o produto entregue nunca era EXECUTADO.
--   * GAP-87 (revisao adversarial cross-family, Mistral Large 3 A6): idempotencia so por spec_hash
--     esconde troca de AMBIENTE de execucao. Mesmo spec_hash medido em executor diferente pode dar
--     resultado diferente, e a segunda medicao seria suprimida em silencio ⇒ `env_sha` entra na chave.
--
-- REVISAO ADVERSARIAL CROSS-FAMILY do desenho (2026-09-08, dentro do container de prod):
-- Nova Pro (4 achados) e Mistral Large 3 (8 achados). O que virou desenho aqui:
--   * ACEITO (Mistral A3, grave): quem julga a constraint contra a saida real e o AGENTE, recebendo a
--     saida verbatim. O codigo NUNCA mapeia exit_code em veredicto -- isso seria automacao fixa
--     disfarcada de decisao (Lei do Jean). O codigo transporta o fato e recusa citacao fabricada.
--   * ACEITO (Mistral A4, medio): severidade do finding do oraculo e a severidade DECLARADA da
--     constraint (que um agente declarou no F2). Severidade derivada de exit_code pelo codigo seria o
--     codigo inventando gravidade.
--   * ACEITO (Mistral A6): `env_sha` na chave de idempotencia (GAP-87 acima).
--   * ACEITO (Mistral A8, menor): o ambiente do executor fica GRAVADO na linha, senao a falha nao e
--     reproduzivel.
--   * ACEITO (Nova A4 + Mistral A2): ausencia de medicao tem de ser VISIVEL. `no_tests` e `error` sao
--     `outcome` proprios e a constraint continua `pending` -- "nada a rodar" nunca vira "cumprido".
--   * RECUSADO (Mistral A1): decidir QA com substring de "WARNING"/"LEAK" na prosa e exatamente o
--     GAP-85 que esta frente mata. O que fica: falha MEDIDA reprova sozinha, e no resto vale o campo
--     estruturado do proprio agente -- prosa deixa de ser parseada por substring.
--   * RECUSADO (Mistral A7): exigir SPEC_ORACLE=on para promover faria uma flag nova barrar entrega
--     no primeiro dia, contra a rota B (nasce OFF, unidirecional).
--   * RECUSADO (Nova A1/A2/A4): leituras invertidas dos fatos F1-F4 do briefing.
--
-- LIMITES DE DESENHO (o que esta tabela NAO faz):
--   1. nao promove e nao libera: veredicto do oraculo so pode ACRESCENTAR impedimento. Nenhuma rota
--      torna promovivel um candidato que os GAPs ja barravam.
--   2. nao muda severidade de finding (limite (a) do Jean no GAP-77).
--   3. sem fallback burro: executor indisponivel, JSON ilegivel ou juiz ausente ⇒ nada muda e o
--      motivo e DECLARADO.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

CREATE TABLE IF NOT EXISTS spec_oracle_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_hash           text NOT NULL,
  env_sha             text NOT NULL DEFAULT '',
  outcome             text NOT NULL,
  stack               text NOT NULL DEFAULT '',
  cmd                 text NOT NULL DEFAULT '',
  exit_code           integer,
  passed              integer NOT NULL DEFAULT 0,
  failed              integer NOT NULL DEFAULT 0,
  skipped             integer NOT NULL DEFAULT 0,
  total               integer NOT NULL DEFAULT 0,
  no_tests            boolean NOT NULL DEFAULT false,
  tests_reliable      boolean NOT NULL DEFAULT false,
  executor            text NOT NULL DEFAULT '',
  output_excerpt      text NOT NULL DEFAULT '',
  constraints_pending integer NOT NULL DEFAULT 0,
  judged              integer NOT NULL DEFAULT 0,
  violated            integer NOT NULL DEFAULT 0,
  blocking            integer NOT NULL DEFAULT 0,
  passes              integer NOT NULL DEFAULT 0,
  passes_failed       integer NOT NULL DEFAULT 0,
  model               text NOT NULL DEFAULT '',
  note                text NOT NULL DEFAULT '',
  findings            jsonb NOT NULL DEFAULT '[]'::jsonb,
  autonomy_run_id     uuid,
  validation_run_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS spec_oracle_runs_env_uidx
  ON spec_oracle_runs (project_id, spec_hash, env_sha);

CREATE INDEX IF NOT EXISTS spec_oracle_runs_latest_idx
  ON spec_oracle_runs (project_id, created_at DESC);

COMMENT ON TABLE spec_oracle_runs IS
  'F3: o FATO da execucao real no executor isolado (Host B), uma linha por (projeto, spec_hash, ambiente). E a unica fonte que pode decidir constraint verifiable_at build/runtime.';
COMMENT ON COLUMN spec_oracle_runs.env_sha IS
  'sha256 de stack + cmd + executor. Entra na chave porque a MESMA spec medida em ambiente diferente e outra medicao -- sem isso a segunda seria suprimida em silencio (GAP-87, Mistral A6).';
COMMENT ON COLUMN spec_oracle_runs.outcome IS
  'green = exit_code 0 e nenhum teste falhando. red = falha MEDIDA. no_tests = sem suite executavel. error = a medicao nao pode ser feita. Nos dois ultimos a constraint segue pending -- nada a rodar nunca vira cumprido.';
COMMENT ON COLUMN spec_oracle_runs.cmd IS
  'Comando VERBATIM que o executor rodou. Sem ele nao ha execucao comprovada, e o payload e recusado.';
COMMENT ON COLUMN spec_oracle_runs.output_excerpt IS
  'Trecho VERBATIM da saida. E contra ESTE texto que o codigo confere se a citacao do juiz existe -- citacao fabricada nao satisfaz e nao acusa nada (Context Integrity aplicado a execucao).';
COMMENT ON COLUMN spec_oracle_runs.findings IS
  'Os GAPs que a EXECUCAO REAL provou, no formato de ValidationFinding com source=oracle. A validacao seguinte os une aos estagios A e B -- uniao pura, o oraculo so ADICIONA. Guardados aqui porque a run de validacao e snapshot imutavel: reescrever run passada seria falsificar historico.';
COMMENT ON COLUMN spec_oracle_runs.judged IS
  'Constraints pending que receberam veredicto DECIDIDO por este oraculo. judged 0 com outcome green nao e sucesso -- e cobertura zero, e a nota diz isso.';
