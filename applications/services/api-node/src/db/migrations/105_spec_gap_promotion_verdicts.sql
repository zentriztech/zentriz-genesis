-- 105 -- GAP-77: o JUIZ ganha autoridade para dizer se um GAP REINCIDENTE impede promover a spec
-- para a Fabrica. Decisao do Jean em 2026-09-07 (memoria genesis-decisao-juiz-promovibilidade).
--
-- POR QUE: o criterio de fechamento do laco era "a contagem de GAPs importantes tem de CAIR", e o
-- GAP-76 provou com dados de producao que essa contagem sobe e desce sozinha por rotacao de
-- cobertura (192b8dc4 -> 9edcb54e: 23 -> 20 no agregado, 20 -> 20 no subconjunto comparavel, zero
-- fechado). Sem veredicto, um GAP que ninguem consegue fechar trava o laco para sempre e o produto
-- nunca chega a Fabrica -- ou chega por cansaco do humano, que e pior.
--
-- LIMITES QUE O JEAN IMPOS (verbatim: "nao devemos mudar a severidade dos processos, mas sim dar ao
-- juiz o poder de julgar depois de resolver N gaps, mas lembrando que essa autoridade nao deve baixar
-- a qualidade da entrega a fabrica"):
--
--   (a) A SEVERIDADE NAO MUDA. Esta tabela e um campo PARALELO. `blocker`/`warning` continuam
--       significando o mesmo em todo o codigo, e a aba GAPs continua mostrando os mesmos 🔴/🟡.
--       Nada aqui reclassifica um finding -- o veredicto responde outra pergunta ("isso impede
--       promover?"), nao a mesma pergunta com outra resposta.
--   (b) SO DEPOIS DE TRABALHO FEITO. Ver `SPEC_VERDICT_MIN_GAPS_RESOLVED` (0 = desligado) e
--       `SPEC_VERDICT_MIN_RECURRENCE`: sem GAPs fechados de verdade (reconciliados, GAP-67) e sem
--       reincidencia medida em validacoes COMPETENTES, nenhum candidato existe.
--   (c) A AUTORIDADE NAO PODE BAIXAR A QUALIDADE. As guardas viram colunas obrigatorias aqui:
--       `file_path` e `anchor` (nada de veredicto em bloco), `recurrence_times` e `focus_rounds`
--       (prova de que o defeito insistiu DEPOIS de foco individual pago), `file_sha_at` (o veredicto
--       morre quando o texto julgado muda) e `accusation` (o promotor tinha de nomear o artefato que
--       a Fabrica construiria errado -- sem acusacao concreta o GAP segue impeditivo).
--
-- O QUE ESTA TABELA NAO E: nao e triagem (`spec_finding_triage` e o humano dizendo "risco aceito") e
-- nao e promocao. Promover a Fabrica continua sendo ato HUMANO com confirmacao por digitacao. Isto e
-- o parecer auditavel que o humano le antes de decidir -- e o que o laco usa para parar de queimar
-- LLM num defeito que ele nao consegue fechar.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.
CREATE TABLE IF NOT EXISTS spec_gap_promotion_verdicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  file_path TEXT NOT NULL,
  anchor TEXT,
  severity_at TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  factory_artifact TEXT NOT NULL DEFAULT '',
  accusation TEXT NOT NULL DEFAULT '',
  recurrence_times INTEGER NOT NULL DEFAULT 0,
  focus_rounds INTEGER NOT NULL DEFAULT 0,
  file_sha_at TEXT NOT NULL DEFAULT '',
  validation_run_id UUID,
  autonomy_run_id UUID,
  decided_by_model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS sgpv_one_per_content
  ON spec_gap_promotion_verdicts (project_id, fingerprint, file_sha_at);

CREATE INDEX IF NOT EXISTS sgpv_live
  ON spec_gap_promotion_verdicts (project_id, created_at DESC);

COMMENT ON TABLE spec_gap_promotion_verdicts IS
  'GAP-77: parecer de um AGENTE sobre se um GAP REINCIDENTE impede promover a spec para a Fabrica. Campo PARALELO a severidade, nunca reclassificacao (limite (a) do Jean). Cada linha carrega a prova de elegibilidade (reincidencia + rodadas de foco pagas) e a acusacao concreta que o promotor teve de sustentar -- sem elas o GAP segue impeditivo por padrao (fail-CLOSED).';

COMMENT ON COLUMN spec_gap_promotion_verdicts.impact IS
  'impeditivo | nao_impeditivo. Fail-CLOSED: erro de LLM, resposta nao-JSON, acusacao vazia ou ausencia de cobertura competente NAO produzem linha nenhuma -- e a falta de veredicto significa impeditivo.';

COMMENT ON COLUMN spec_gap_promotion_verdicts.file_sha_at IS
  'SHA do conteudo do arquivo no momento do veredicto. O parecer foi sobre AQUELE texto: quando o arquivo muda, o veredicto fica obsoleto e deixa de contar como liberado. E o que impede uma anistia acumulada sobreviver a reescrita da secao.';

COMMENT ON COLUMN spec_gap_promotion_verdicts.accusation IS
  'O que o promotor afirmou que a Fabrica construiria ERRADO por causa deste GAP (artefato concreto: rota, tabela, tela, job). O juiz decide contra esta acusacao. Acusacao generica ou vazia descarta o candidato -- nao absolve.';

COMMENT ON COLUMN spec_gap_promotion_verdicts.focus_rounds IS
  'Rodadas de autonomia que ja despacharam ESTE arquivo ao CTO-editor. E a prova de que o defeito insistiu DEPOIS de foco individual pago -- o gatilho que o Jean exigiu (verbatim: "focamos neles individualmente algumas vezes, se insistir a reaparecer ai sim o juiz usa o novo poder").';
