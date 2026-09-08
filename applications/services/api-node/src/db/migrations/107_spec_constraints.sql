-- 107 -- F2: CONSTRAINTS DECLARADAS + POLICY GATE.
--
-- POR QUE (pesquisa, nao palpite):
--   * arXiv:2609.04167 mede que 34% dos patches que PASSAM nos testes VIOLAM constraints declaradas
--     na revisao. "passou no teste" e "cumpriu o que foi pedido" sao coisas diferentes, e a Bancada
--     nao tinha NENHUM estagio que verificasse constraint: tinha caca a GAP (espaco ABERTO, com a
--     superficie medida rotacionando a cada rodada -- GAP-76) e o juiz de promovibilidade (GAP-77).
--   * Constraint declarada e espaco FECHADO e ENUMERAVEL: "a spec declara N constraints; cada uma
--     esta satisfeita, violada, indecidivel, pendente ou dispensada". Isso da um criterio de parada
--     que a caca a GAP nunca deu -- e e a resposta ao EQUILIBRIO que o Jean exigiu (nao ignorar
--     falha grave; nao entrar em loop infinito atras de perfeicao).
--
-- DUAS REVISOES ADVERSARIAIS CROSS-FAMILY do desenho (2026-09-08, dentro do container de prod):
-- Nova Pro (5 achados) e Mistral Large 3 (7 achados). O que virou COLUNA aqui:
--   * assertion_sha (Mistral B1, grave): reusar `constraint_key` com `assertion` diferente e a
--     mesma doenca do GAP-49/50 pelo outro lado -- a identidade fica estavel e o SIGNIFICADO troca
--     em silencio. O codigo nao julga equivalencia (o sistema e 100% LLM): ele compara o sha e
--     marca `drift` quando a troca nao foi DECLARADA em `superseded_by_key`.
--   * archetype_hash (Mistral B5): mudanca no checklist do arquetipo muda a derivacao com a MESMA
--     spec. Sem este hash a idempotencia por spec_hash daria "mesma spec, constraints diferentes".
--   * verifiable_at (Mistral B2): na Bancada os artefatos do produto AINDA NAO EXISTEM. Constraint
--     verificavel so em build/runtime nao pode virar `indecidivel` eterno (ruido, nao rigor): ela e
--     `pending`, categoria propria, e quem a julga e o oraculo EXECUTAVEL da frente F3.
--   * anchor_verbatim (Mistral B5 / Context Integrity): a constraint nasce de um trecho da spec, e o
--     codigo confere que esse trecho existe LITERALMENTE. Ancora inventada = constraint recusada.
--     Isso nao e o codigo julgando merito -- e o codigo recusando premissa fabricada.
--
-- LIMITES DE DESENHO (o que este par de tabelas NAO faz):
--   1. nao muda severidade de nada. Constraint tem severidade PROPRIA; finding continua como estava
--      (limite (a) do Jean no GAP-77).
--   2. nao promove e nao libera. O gate so pode ACRESCENTAR impedimento; nenhuma rota faz um
--      candidato passar a ser promovivel por causa desta tabela (fail-CLOSED por construcao).
--   3. sem fallback burro: sem LLM, JSON invalido ou cobertura ausente => o gate nao roda e o
--      caminho antigo (todos os GAPs impeditivos) segue de pe.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

CREATE TABLE IF NOT EXISTS spec_constraints (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_hash          text NOT NULL,
  archetype_hash     text NOT NULL DEFAULT '',
  constraint_key     text NOT NULL,
  applies_to         text NOT NULL DEFAULT '',
  assertion          text NOT NULL,
  assertion_sha      text NOT NULL DEFAULT '',
  evidence_hint      text NOT NULL DEFAULT '',
  verifiable_at      text NOT NULL DEFAULT 'spec',
  severity           text NOT NULL DEFAULT 'warning',
  source_anchor      text NOT NULL DEFAULT '',
  anchor_verbatim    boolean NOT NULL DEFAULT false,
  superseded_by_key  text,
  drift              boolean NOT NULL DEFAULT false,
  declared_by_model  text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS spec_constraints_key_uidx
  ON spec_constraints (project_id, spec_hash, archetype_hash, constraint_key);

CREATE INDEX IF NOT EXISTS spec_constraints_latest_idx
  ON spec_constraints (project_id, created_at DESC);

COMMENT ON TABLE spec_constraints IS
  'F2: constraints VERIFICAVEIS derivadas da spec por agente (checklist do arquetipo e SEMENTE, nao lista fixa). Uma linha por (projeto, spec_hash, archetype_hash, chave).';
COMMENT ON COLUMN spec_constraints.assertion_sha IS
  'sha256 da assertion normalizada. Chave reusada com sha diferente e troca de SIGNIFICADO: se nao foi declarada em superseded_by_key, drift=true (Mistral B1).';
COMMENT ON COLUMN spec_constraints.verifiable_at IS
  'spec | build | runtime. Na Bancada so `spec` e julgavel. build/runtime ficam `pending` para o oraculo executavel (F3), nunca indecidivel eterno (Mistral B2).';
COMMENT ON COLUMN spec_constraints.anchor_verbatim IS
  'O codigo conferiu que source_anchor aparece LITERALMENTE na spec. false = premissa fabricada, constraint recusada.';

CREATE TABLE IF NOT EXISTS spec_policy_verdicts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_hash          text NOT NULL,
  constraint_key     text NOT NULL,
  status             text NOT NULL,
  evidence           text NOT NULL DEFAULT '',
  evidence_verbatim  boolean NOT NULL DEFAULT false,
  artifact           text NOT NULL DEFAULT '',
  reason             text NOT NULL DEFAULT '',
  waiver_kind        text NOT NULL DEFAULT '',
  audit_verdict      text NOT NULL DEFAULT '',
  blocking           boolean NOT NULL DEFAULT false,
  model              text NOT NULL DEFAULT '',
  autonomy_run_id    uuid,
  validation_run_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS spec_policy_verdicts_uidx
  ON spec_policy_verdicts (project_id, spec_hash, constraint_key, model);

CREATE INDEX IF NOT EXISTS spec_policy_verdicts_latest_idx
  ON spec_policy_verdicts (project_id, created_at DESC);

COMMENT ON TABLE spec_policy_verdicts IS
  'F2: veredicto do Policy Gate por constraint. status: satisfied | violated | indecidivel | pending | waived. Cobertura MEDIDA -- constraint sem veredicto entra como indecidivel/not_judged (licao GAP-17/18).';
COMMENT ON COLUMN spec_policy_verdicts.evidence_verbatim IS
  'O codigo conferiu que a citacao aparece LITERALMENTE no artefato nomeado. satisfied sem isso degrada para indecidivel/evidence_not_found -- evidencia inventada nao satisfaz nada (Nova A4).';
COMMENT ON COLUMN spec_policy_verdicts.waiver_kind IS
  'inapplicable = a constraint nao se aplica a este produto (dispensa valida). postponement = "nao deu tempo" -- NAO dispensa e segue bloqueando (Mistral B3).';
COMMENT ON COLUMN spec_policy_verdicts.audit_verdict IS
  'Parecer do revisor CROSS-FAMILY sobre a propria constraint (verificavel | vaga | irrelevante). `vaga` nao apaga a linha: retira o poder de BLOQUEAR, que e a perna anti-loop-infinito do equilibrio.';
COMMENT ON COLUMN spec_policy_verdicts.blocking IS
  'A unica coluna que decide: violated, nao dispensada por inaplicabilidade e nao marcada `vaga` pelo cross-family.';
