-- 106 -- REVISOR CROSS-FAMILY: auditoria da PREMISSA de cada finding por um modelo NAO-Claude.
--
-- POR QUE (pesquisa, nao palpite -- memoria genesis-pesquisa-revisor-cross-family-e-limites-do-juiz):
--   * arXiv:2609.04270 mede que auto-revisao da MESMA familia da ZERO ganho de acuracia e rejeita 35%
--     do que estava certo; revisor CROSS-FAMILY mid-tier da +12 p.p. com 2% de falso-rejeite. O
--     Genesis inteiro (CTO-editor, refutador, juiz de promovibilidade) e Claude: somos exatamente a
--     configuracao medida como inutil para revisar a si mesma.
--   * arXiv:2609.03230 mede que o melhor modelo Anthropic acha a mediana de 47% dos defeitos de
--     requisito, com 11% de falso-positivo, e erra "almost always" os de necessidade e correcao.
--     Logo "zero GAPs" nunca significou "spec pronta", e o FP do NOSSO juiz nunca foi medido --
--     sem isso a contagem de GAPs e infalsificavel.
--
-- O QUE JEAN PEDIU, VERBATIM (2026-09-07): "nao se trata apenas de deixar passar e destravar as
-- specs, nao podemos ignorar falhas realmente graves de analises e escrita as specs, tambem nao
-- podemos entrar em um loop infito em busca da perfeicao que nunca sera alcancada porque a cada nova
-- rodada é criado novos gaps, precisamos de equilibrio."
--
-- O EQUILIBRIO QUE ESTA TABELA INSTRUMENTA -- e note que ela nao DECIDE nada, ela MEDE:
--   (a) contra deixar passar: um finding que as DUAS familias chamam de grave nao tem anistia. Ele
--       fica fora da cota do veredicto (SPEC_VERDICT_MAX_PER_SPEC) e bloqueia promocao sempre.
--   (b) contra o loop infinito: `verdict = ausente` e a prova de que a acusacao nao existe no texto
--       -- classe do GAP-84, um blocker que NENHUMA edicao consegue fechar porque o defeito nao esta
--       la. Esses sao os GAPs eternos, e o resto do residuo (indecidivel, cosmetica) nao bloqueia:
--       fica declarado como residuo conhecido junto ao produto.
--   (c) a parada deixa de ser "zero GAPs" e passa a ser estabilidade: a rodada nova quase sempre
--       cria GAP novo, e o que importa e se o GAP novo e grave PELAS DUAS familias.
--
-- O QUE ESTA TABELA NAO E:
--   * nao e triagem: `spec_finding_triage` e o HUMANO dizendo "risco aceito"/"falso positivo" e
--     continua sendo so dele (medido em prod 2026-09-07: 0 linhas -- nenhuma triagem humana existe);
--   * nao e reclassificacao de severidade: `severity_claude` fica registrada como estava. Igual ao
--     limite (a) do Jean no GAP-77, este e um campo PARALELO;
--   * nao e veredicto de promovibilidade: `spec_gap_promotion_verdicts` continua sendo o parecer que
--     decide. Aqui e a EVIDENCIA independente que aquele juiz passa a ler.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.
CREATE TABLE IF NOT EXISTS spec_finding_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  validation_run_id UUID,
  autonomy_run_id UUID,
  fingerprint TEXT NOT NULL,
  file_path TEXT NOT NULL,
  anchor TEXT,
  severity_claude TEXT NOT NULL DEFAULT '',
  category_claude TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL,
  gravity TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  evidence_verbatim BOOLEAN NOT NULL DEFAULT false,
  why TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  section_chars INTEGER NOT NULL DEFAULT 0,
  file_sha_at TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sfa_one_per_content_per_model
  ON spec_finding_audits (project_id, fingerprint, file_sha_at, model);

CREATE INDEX IF NOT EXISTS sfa_by_run
  ON spec_finding_audits (validation_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sfa_live
  ON spec_finding_audits (project_id, created_at DESC);

COMMENT ON TABLE spec_finding_audits IS
  'Auditoria CROSS-FAMILY (modelo nao-Claude) da PREMISSA DE FATO de cada finding: o defeito acusado existe no trecho verbatim? Instrumento de medicao (FP do proprio juiz) e de equilibrio -- NAO reclassifica severidade e NAO promove nada. Uma linha por (finding, conteudo do arquivo, modelo), para varias familias poderem votar sem se sobrescrever.';

COMMENT ON COLUMN spec_finding_audits.verdict IS
  'presente | ausente | indecidivel. "presente" REFORCA o finding (nao afrouxa nada). "ausente" exige citacao verbatim do trecho provando a CONFORMIDADE -- e a classe do GAP-84, blocker que nenhuma edicao fecha porque o defeito nao esta la. "indecidivel" e obrigatorio quando a acusacao depende de texto fora do trecho: nesse caso a critica original continua de pe.';

COMMENT ON COLUMN spec_finding_audits.gravity IS
  'grave | moderada | cosmetica, so quando verdict = presente. A regua e consequencia para a FABRICA, nao gosto de redacao. grave = a Fabrica construiria errado ou nao construiria. moderada = constroi e funciona, mas sobra risco real. cosmetica = nao muda nada do que a Fabrica constroi. Grave pelas DUAS familias nao entra em cota de anistia nenhuma.';

COMMENT ON COLUMN spec_finding_audits.evidence_verbatim IS
  'A citacao do auditor foi encontrada LITERALMENTE no trecho enviado? Checagem de TRANSPORTE, nao de conteudo: um auditor que cita o texto da ACUSACAO em vez do texto da SPEC nao provou nada, e sem esta coluna o "ausente" dele seria indistinguivel de prova real. false nao anula o veredicto -- degrada a confianca, e quem consome decide.';

COMMENT ON COLUMN spec_finding_audits.file_sha_at IS
  'SHA do conteudo do arquivo auditado. A auditoria foi sobre AQUELE texto: quando o arquivo muda, a linha deixa de valer como evidencia atual -- mesma disciplina do file_sha_at do veredicto (GAP-77), para nenhuma absolvicao sobreviver a reescrita da secao.';
