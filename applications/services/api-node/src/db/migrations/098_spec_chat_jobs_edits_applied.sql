-- 098 — GAP-12: registrar QUANTAS edicoes ANCORADAS produziram o conteudo do job.
--
-- MEDIDO EM PROD 2026-09-06 (NVX LastMile, run de autonomia c3757985, passe 1, rodada 1):
--
--   [SpecChat] job=439b9e24 DONE (edits) - 6 aplicadas, 0 descartadas, 34531->28232 chars
--   spec_autonomy_runs.rounds[0].note = "revisao recusada (secoes desaparecidas): a revisao tem
--   6 secoes contra 9 da spec atual - sumiram, entre outras: 'contrato minimo de rotas de negocio
--   (substitui api-entregas-entregadores.md enquanto ausente)', ..."
--
-- Isto e: o laco finalmente REMOVEU as quatro secoes-fantasma que o proprio sistema havia escrito na
-- spec do cliente por causa do GAP-10 (o validador julgava 27% da spec e declarava o resto ausente),
-- e `assessRevisionIntegrity` jogou fora a rodada PAGA (in=46907 / out=21190 tokens) porque a
-- contagem de `##` caiu. A heuristica de "secoes desaparecidas" existe para pegar TRUNCAMENTO no
-- formato de arquivo inteiro; aplicada a uma resposta em EDICOES ela veta a unica operacao capaz de
-- encolher a spec -- e e a explicacao mecanica do GAP-8 (a spec so cresce, ~18% por rodada).
--
-- Por que a coluna: no formato `edits` uma secao so desaparece por um bloco SEARCH/REPLACE COMPLETO
-- e ancorado byte a byte (bloco incompleto e descartado antes de tocar o disco), ou seja, remocao e
-- DECISAO do agente, nao perda. Mas "eu PEDI edicoes" nao prova "a resposta VEIO em edicoes" -- o
-- modelo pode reemitir o arquivo inteiro e cair no gate historico. O guard precisa do FATO, e o fato
-- nasce em routes/specChat.ts (applySpecEditResponse) e e consumido depois, noutro processo, pelo
-- tick do modo autonomo. Logo: persistido.
--
-- NULL = job anterior a esta migracao ou resposta de arquivo inteiro -> guard de secoes INTACTO.
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal/comentario.
ALTER TABLE spec_chat_jobs ADD COLUMN IF NOT EXISTS edits_applied INTEGER;

COMMENT ON COLUMN spec_chat_jobs.edits_applied IS
  'GAP-12: numero de blocos SEARCH/REPLACE ancorados aplicados para gerar spec_markdown. NULL = arquivo inteiro.';
