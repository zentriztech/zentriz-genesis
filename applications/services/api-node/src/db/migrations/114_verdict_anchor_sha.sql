-- 🔴 GAP-124 — a obsolescência do parecer de promovibilidade era medida pelo ARQUIVO INTEIRO,
-- mas o parecer é sobre uma ÂNCORA (seção). Como o laço autônomo reescreve todos os arquivos da
-- spec a cada passe, qualquer edição em QUALQUER seção matava pareceres sobre seções que ninguém
-- tocou. MEDIDO em prod (projeto NVX LastMile, 2026-09-08): 15 pareceres vivos, 13 liberações
-- acumuladas em 3 runs de veredicto, e ZERO valendo — nenhum `file_sha_at` batia com o sha atual.
-- Com isso `released` era sempre 0, o teto acumulado de 24 ("duas por arquivo") nunca acumulava
-- nada, `promotable` era falso por construção e a feature dos DESENHOS Mermaid (gatilho
-- `v.promotable`) ficava inalcançável — o mesmo arquétipo de gatilho impossível do GAP-113/116/117.
--
-- `anchor_sha_at` = sha256 do TRECHO ancorado no instante do parecer. Quando presente, é ele que
-- decide obsolescência; ausente (pareceres antigos, ou GAP sem âncora) mantém a regra do arquivo —
-- nenhuma anistia retroativa. Âncora que desapareceu do conteúdo atual segue obsoleta (fail-CLOSED).
ALTER TABLE spec_gap_promotion_verdicts
  ADD COLUMN IF NOT EXISTS anchor_sha_at text;

COMMENT ON COLUMN spec_gap_promotion_verdicts.anchor_sha_at IS
  'GAP-124: sha256 do trecho ancorado no instante do parecer. Presente decide obsolescencia por SECAO. Ausente mantem a regra antiga (arquivo inteiro).';
