-- 094 — PR-4: a que ARQUIVO da spec cada GAP pertence (roteamento dos findings sem arquivo).
--
-- POR QUE: depois de dividir a spec (PR-3), "Resolver GAPs" passa a rodar por ARQUIVO — uma rodada
-- toca UM arquivo e cabe folgado no teto de saida do modelo (a causa do truncamento de 64k). Para
-- isso o servidor precisa saber a que arquivo cada GAP pertence.
--
-- A MAIOR PARTE JA VEM DE GRACA: o Stage B recebe a spec com marcadores "===== <path> =====" e
-- devolve `file` em cada finding (specValidation.ts) — ou seja, um LLM ja decide isso a cada
-- validacao. Esta tabela guarda SO o resto: findings globais do Stage A (`file` vazio) e findings
-- cujo `file` aponta para um arquivo que nao existe mais (tipico logo apos a divisao). Para esses,
-- um agente decide o destino UMA vez por run de validacao e o resultado fica aqui — sem isso, o
-- laco autonomo pagaria a mesma decisao a cada rodada.
--
-- Formato de finding_routes: objeto JSON { "<fingerprint>": "<rel_dir/filename>" }. Fingerprint e
-- o mesmo do RFC-0005 (findingTriage.findingFingerprint), entao a rota sobrevive a re-triagem.
-- Consumidor SEMPRE revalida o path contra a arvore atual: arquivo removido = rota ignorada e o
-- roteamento e refeito. Por isso nao ha FK nem trigger — a verdade continua sendo a arvore.
--
-- NOTA runner de migrations: split ingenuo por ';' — nenhum ';' em literal, comentarios so em linha
-- propria, sem blocos DO/$$.

ALTER TABLE spec_validation_runs ADD COLUMN IF NOT EXISTS finding_routes JSONB;

ALTER TABLE spec_validation_runs ADD COLUMN IF NOT EXISTS finding_routes_at TIMESTAMPTZ;

ALTER TABLE spec_validation_runs ADD COLUMN IF NOT EXISTS finding_routes_model TEXT;
