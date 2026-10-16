-- 133_runtime_config_spec_chat_max_tokens.sql
-- Teto de saida do chat livre da Bancada (edicao por arquivo), editavel em /settings/runtime-config.
--
-- Medido em prod em 16/10/2026: modelo-dados.md (19.325 chars) recebeu max_tokens=8902 pela formula
-- chars/2,8+2000 e o modelo cortou nesse teto com 16,4-16,7 mil chars emitidos (~1,87 chars/token),
-- sem nem terminar de copiar o arquivo de volta. max_tokens e teto e nao gasto: o default global passa
-- a ser 32000 (o mesmo limite seguro do caminho Resolver GAPs). Para voltar ao calculo por tamanho,
-- remova a linha global e os overrides.
--
-- NOTA runner de migrations: sem ponto e virgula em literais, sem blocos DO.
-- NOTA: UNIQUE(key, tenant_id) trata NULL como distinto, entao a idempotencia vem do WHERE NOT EXISTS.

INSERT INTO genesis_runtime_config (key, value, description)
SELECT v.key, v.value, v.description
FROM (VALUES
  ('SPEC_CHAT_MAX_TOKENS', '32000', 'Teto de tokens de saida do chat livre da Bancada por arquivo (o modelo devolve o arquivo inteiro). Faixa 8000 a 32000. Teto baixo trunca arquivos densos e a rodada e descartada.')
) AS v(key, value, description)
WHERE NOT EXISTS (
  SELECT 1 FROM genesis_runtime_config g
  WHERE g.key = v.key AND g.tenant_id IS NULL
);
