-- 123 -- GAP-169: o FECHAMENTO de GAP era inferido por SILENCIO do juiz, e o silencio de um juiz com
-- recall ~47% fecha mentira. Esta migracao da PROPOSITO a cada linha de auditoria, para que a mesma
-- maquina cross-family possa responder duas perguntas DIFERENTES sobre o mesmo finding sem que uma
-- sobrescreva a outra.
--
-- MEDIDO EM PROD 2026-09-09 (NVX LastMile, projeto e2a1988c, 39 validacoes em 36 h):
--   * 186 ancoras (arquivo, ancora) distintas ja vistas alguma vez; apenas 70 a 77 ATIVAS a qualquer
--     instante. As outras 107 estao "resolvidas" por ausencia.
--   * 56 RESSURREICOES em 46 ancoras: o finding ficou ausente por 2 ou mais validacoes que JULGARAM
--     aquele arquivo por inteiro (logo virou `resolved` pela regra RESOLVED_AFTER_RUNS = 2 de
--     findingTriage.ts) e depois VOLTOU. Pela regua de identidade do proprio sistema
--     (sha(file|source|anchor), GAP-49) e o MESMO GAP.
--   * Piso honesto do erro: 46 de 153 ancoras que o sistema declarou resolvidas voltaram = 30% de
--     FECHAMENTO FALSO. Piso, nao teto: as 107 de agora ainda nao tiveram a mesma chance de voltar.
--   * Custo disso: 1,44 ressurreicoes por validacao contra ~6 aberturas, ou seja ~24% dos "GAPs novos"
--     sao REDESCOBERTAS -- cada uma paga um passe inteiro de Opus 5 (~140k chars) para reencontrar um
--     defeito que nunca tinha sido corrigido.
--   * A cobertura NAO explica mais a ausencia: a media e de 11,7 arquivos julgados por inteiro em 13
--     (a rotacao do GAP-18/C3 acabou). O que explica e o recall do juiz -- com p ~ 0,5, omitir o mesmo
--     defeito em 2 passadas seguidas tem chance ~25%, que e a ordem exata dos 30% medidos.
--
-- POR QUE ISSO E GRAVE, e nao um detalhe de contabilidade: a UNICA saida positiva do laco autonomo e
-- `gaps.important === 0` (specAutonomy.ts). Esse zero e calculado sobre o conjunto ATIVO -- de onde os
-- 107 fechamentos por silencio foram retirados. Ou seja a saida positiva nao era so inalcancavel
-- (nenhuma convergencia em 57 runs), ela era INSEGURA: poderia declarar "spec validada" sobre uma spec
-- com ~30% de defeito vivo escondido. O Jean foi explicito: "os agentes devem fechar ... nao podemos
-- regredir e nem criar falsos positivos".
--
-- O DESENHO (Lei 100% LLM: quem decide e o agente, o codigo transporta o fato e veta corrupcao):
--   A1 (gapOutcomes.ts) ja matou a inferencia do lado do AGENTE -- cada GAP despachado volta com um
--   verbo declarado. Do lado do JUIZ o fechamento continuava sendo inferido por silencio. Agora
--   ausencia NAO fecha: ela apenas ELEGE o finding a candidato, e o fechamento passa a exigir o
--   veredicto `ausente` de um auditor de OUTRA FAMILIA sobre o texto ATUAL, com citacao verbatim
--   conferida. Sem veredicto, ou com `indecidivel`, o finding volta a ATIVO -- fail-CLOSED.
--
-- POR QUE PODE DECIDIR (e nao apenas medir, como a versao de 2026-09-07): a assimetria. Para um
-- finding PRESENTE, deixar `ausente` liberar seria anistia -- por isso aquela versao so mede. Para um
-- finding JA TRATADO COMO FECHADO, `presente` so pode APERTAR (reabre) e `ausente` apenas confirma COM
-- PROVA o que o sistema ja fazia as cegas. Exigir prova e monotonicamente mais estrito que o status
-- quo: nao existe caminho em que esta mudanca crie um fechamento que hoje nao aconteceria.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.
ALTER TABLE spec_finding_audits
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'acusacao';

-- A chave unica passa a incluir o proposito. Sem isso, auditar o FECHAMENTO de um finding no MESMO sha
-- em que ele foi auditado como ACUSACAO sobrescreveria a primeira linha -- e esse caso nao e raro: 67%
-- das aberturas medidas acontecem em arquivo de sha IDENTICO, exatamente o cenario em que o mesmo
-- (finding, sha, modelo) e perguntado duas vezes por duas razoes diferentes.
DROP INDEX IF EXISTS sfa_one_per_content_per_model;

CREATE UNIQUE INDEX IF NOT EXISTS sfa_one_per_content_per_model
  ON spec_finding_audits (project_id, fingerprint, file_sha_at, model, purpose);

-- Leitura quente do GAP-169: "este candidato a fechamento tem prova no sha atual?"
CREATE INDEX IF NOT EXISTS sfa_closure_lookup
  ON spec_finding_audits (project_id, purpose, fingerprint, file_sha_at);

COMMENT ON COLUMN spec_finding_audits.purpose IS
  'acusacao | fechamento. Duas perguntas DIFERENTES para a mesma maquina cross-family. acusacao (2026-09-07) = "o defeito que o juiz Claude ACUSA existe no trecho?" -- instrumento de medicao do falso-positivo do juiz, que NAO libera nada. fechamento (GAP-169) = "este defeito, que o juiz PAROU de relatar, ainda existe no texto ATUAL?" -- e o unico fechamento admissivel para finding de stage_b, porque ausencia de um juiz com recall ~47% nao e prova de correcao (medido: 30% dos fechamentos por silencio ressuscitaram). ausente + citacao verbatim fecha COM PROVA. presente REABRE. indecidivel ou ausencia de linha mantem ATIVO -- fail-CLOSED.';
