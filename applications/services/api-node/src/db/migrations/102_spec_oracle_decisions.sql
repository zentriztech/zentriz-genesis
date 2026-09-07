-- 102 -- GAP-22: registro de ORACULOS (qual arquivo e a FONTE UNICA de cada contrato em disputa).
--
-- MEDIDO EM PROD 2026-09-07 (NVX LastMile - Backend, projeto e2a1988c, 8 runs de autonomia):
--
--   26 blockers ativos, 24 deles do MESMO tipo: "contrato X contraditorio entre arquivos que se
--   autodeclaram fonte unica". O contrato de PAGINACAO sozinho aparece em 5 rodadas diferentes,
--   MIGRANDO de arquivo: nvx-lastmile-backend.md -> definicao-de-pronto.md -> infraestrutura-deploy.md.
--   Idem derivacao do IP do cliente (3 arquivos), envelope de erro, inventario de rotas,
--   METRICS_UNAUTHORIZED vs UNAUTHORIZED, bcrypt vs Argon2id.
--
--   E a serie de tamanhos por rodada nunca encolhe UMA vez:
--     modelo-dados.md        94.792 -> 100.907 -> 126.742 -> 149.393 -> 167.737 -> 172.323
--     definicao-de-pronto.md 35.050 ->  43.380 ->  49.362 ->  56.692 ->  79.929 ->  96.062
--     README.md (indice!)         0 ->   6.387 ->  11.724 ->  19.392 ->  31.969 ->  61.784
--
-- CAUSA (GAP-8 tem motor, nao e "o modelo gosta de escrever"): a unidade de trabalho do laco e o
-- ARQUIVO, mas a unidade do defeito e um CONTRATO ENTRE ARQUIVOS. Editando UM arquivo nao existe
-- correcao possivel: escolher um valor deixa o irmao dizendo o outro. O que o CTO-editor pode fazer
-- e ACRESCENTAR um paragrafo normativo ("este arquivo e a fonte unica de X") -- e ai a spec cresce, a
-- contradicao renasce com outro titulo em outro arquivo, e a rodada seguinte a empurra de volta.
-- O contexto so-leitura dos irmaos (A5.5/A5.6) melhorou o sinal mas NAO fecha o ciclo: cada rodada
-- RE-DECIDE quem manda, e duas rodadas seguidas decidem diferente.
--
-- O QUE ESTA TABELA E: a decisao "quem e o oraculo de <contrato>" tomada por um AGENTE (lei 100% LLM)
-- e PERSISTIDA, para deixar de ser re-decidida a cada rodada. O codigo nao escolhe oraculo -- ele
-- transporta o fato para o prompt das rodadas seguintes ("o oraculo de paginacao e `contratos-erros.md`
-- -- neste arquivo, SUBSTITUA a redeclaracao por uma citacao") e veta o que contradiz o fato.
--
-- POR QUE NAO E CHAVEADA SO POR spec_hash: durabilidade e o mecanismo. Se a decisao morresse a cada
-- edicao da spec, a oscilacao voltaria na rodada seguinte -- que e exatamente o defeito medido. O
-- spec_hash fica como PROVENIENCIA (em que conteudo a decisao nasceu) e como chave de idempotencia da
-- chamada de LLM. A leitura pega a decisao mais RECENTE por contrato, de qualquer hash.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.
CREATE TABLE IF NOT EXISTS spec_oracle_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_hash TEXT NOT NULL,
  contract_key TEXT NOT NULL,
  oracle_path TEXT NOT NULL,
  rule_summary TEXT NOT NULL DEFAULT '',
  restated_in JSONB NOT NULL DEFAULT '[]'::jsonb,
  decided_by_model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sod_one_per_hash
  ON spec_oracle_decisions (project_id, spec_hash, contract_key);

CREATE INDEX IF NOT EXISTS sod_latest
  ON spec_oracle_decisions (project_id, contract_key, created_at DESC);

COMMENT ON TABLE spec_oracle_decisions IS
  'GAP-22: fonte unica decidida por AGENTE para cada contrato que a validacao acusou de contraditorio entre arquivos. Durabilidade e o ponto: sem ela cada rodada re-decide quem manda e a contradicao migra de arquivo para sempre (medido em prod, 5 rodadas com o contrato de paginacao). O codigo so transporta a decisao para o prompt e veta o que a contradiz.';

COMMENT ON COLUMN spec_oracle_decisions.contract_key IS
  'Slug curto do contrato em disputa, escolhido pelo agente (ex.: paginacao, envelope-erro, derivacao-ip). E a chave de estabilidade entre rodadas -- nao um enum do codigo.';

COMMENT ON COLUMN spec_oracle_decisions.restated_in IS
  'Paths que REDECLARAM a regra e portanto devem passar a CITAR o oraculo em vez de redefinir. Alimenta o veto de crescimento: consolidar e remover a redeclaracao, nao acrescentar mais um paragrafo normativo.';
