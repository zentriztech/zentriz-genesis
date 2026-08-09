-- Migration 039: eleva timeouts default dos agentes (regulagem da fatia vertical, 2026-08-09).
--
-- Achado ao rodar a fábrica de verdade: o Dev gera respostas grandes (100-148KB por task)
-- e o repair loop pode fazer até 3 chamadas LLM. Com AGENT_TIMEOUT_DEV=600s (seed original,
-- migration 020), uma geração legítima estourava o timeout → retry (tentativa 2/2) que DOBRA
-- custo e tempo sem necessidade. Elevamos os defaults para acomodar gerações grandes.
--
-- Idempotente: só atualiza linhas que ainda estão no valor antigo (600) — respeita overrides
-- que o operador tenha feito manualmente para outros valores.

UPDATE genesis_runtime_config SET value = '1200'
  WHERE key = 'AGENT_TIMEOUT_DEV'      AND value = '600';
UPDATE genesis_runtime_config SET value = '1200'
  WHERE key = 'AGENT_TIMEOUT_ENGINEER' AND value = '600';
UPDATE genesis_runtime_config SET value = '1200'
  WHERE key = 'REQUEST_TIMEOUT'        AND value = '600';
UPDATE genesis_runtime_config SET value = '900'
  WHERE key = 'AGENT_TIMEOUT_QA'       AND value = '600';
UPDATE genesis_runtime_config SET value = '900'
  WHERE key = 'AGENT_TIMEOUT_CTO'      AND value = '600';
UPDATE genesis_runtime_config SET value = '900'
  WHERE key = 'AGENT_TIMEOUT_PM'       AND value = '600';
