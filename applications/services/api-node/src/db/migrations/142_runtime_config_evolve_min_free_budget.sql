-- 142 — Fase 1' (tarefa 1.3): saldo livre minimo para abrir uma nova versao (EVOLVE_CLAIM=on).
--
-- O filho de evolucao DIVIDE o orcamento do dono da versao corrente (budget_owner_project_id). Se o saldo livre
-- for menor que o minimo configurado aqui, o /evolve responde 402 BUDGET_FREE_BELOW_MIN e NAO cria o filho: um
-- filho que esgotasse o saldo pausaria tambem a versao em producao (risco R1 do desenho do Advisor).
--
-- PADRAO CONSERVADOR, calibrado=falso: US$ 5 foi escolhido por prudencia, NAO medido. A unica medida disponivel e a
-- do proprio Guard (minNextActivityUsd = max(0,10 ; 3 x mediana das chamadas)), que e bem menor. Calibrar com o
-- gasto real de uma evolucao completa (Bancada + Fabrica) antes de ligar EVOLVE_CLAIM em producao.
-- Valor inteiro em US$. 0 desliga a regra extra (sobra so a regra do Guard).
-- Override por tenant: linha com tenant_id (o leitor readRuntimeNumber prefere a do tenant).
--
-- NOTA runner de migrations: sem ponto e virgula em literais, sem blocos DO.
-- NOTA: UNIQUE(key, tenant_id) trata NULL como distinto, entao a idempotencia vem do WHERE NOT EXISTS.

INSERT INTO genesis_runtime_config (key, value, description)
SELECT v.key, v.value, v.description
FROM (VALUES
  ('EVOLVE_MIN_FREE_BUDGET_USD', '5', 'Saldo livre minimo (US$ inteiro) do dono do orcamento para abrir uma nova versao via /evolve com EVOLVE_CLAIM=on. calibrado=falso - padrao conservador nao medido. 0 desliga a regra extra.')
) AS v(key, value, description)
WHERE NOT EXISTS (
  SELECT 1 FROM genesis_runtime_config g
  WHERE g.key = v.key AND g.tenant_id IS NULL
);
