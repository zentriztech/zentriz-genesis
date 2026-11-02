> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Relatório da tarefa 1.6 — alerta estatístico de anomalia de custo/uso de LLM

Branch `evo/p1-16` (derivada de `evo/p1-13`). Estado: **preparado** (código, migration e testes locais; nada implantado, nada em produção, sem push). A tarefa 1.7 **não foi iniciada** neste ciclo (era opcional).

## O que mudou (caminhos relativos a `applications/services/api-node/`)

| Arquivo | Papel |
|---|---|
| `src/db/migrations/136_llm_anomaly_alerts.sql` | Tabela nova aditiva `llm_anomaly_alerts` (135 era a última). Sem `DO $$`, sem `;` em literais (`migrations.test.ts` passa). Rollback por flag. |
| `src/lib/anomalyAlerts.ts` | Flag `ANOMALY_ALERTS` (`off`/`shadow`/`on`, padrão `off`, inválido vira `off`) e todos os parâmetros (`ANOMALY_<NOME>` no ambiente). |
| `src/services/anomalyDetectors.ts` | Cálculo puro: EWMA, CUSUM, MAD robusto (USD/hora e tokens/chamada por global/tenant/projeto), payload repetido (`prompt_hash`), run travada. |
| `src/services/llmAnomaly.ts` | Carga do ledger/métricas (somente SELECT), passada idempotente, gravação, notificação, listagem, worker. |
| `src/routes/llmAnomaly.ts` | `GET /api/admin/llm-anomaly/alerts` (somente leitura, `zentriz_admin`). |
| `src/app.ts` (+2 linhas), `src/index.ts` (+6) | Registro da rota e do worker (com `off` o worker nem agenda timer). |
| `src/services/anomalyScenarios.ts` | Cenários sintéticos determinísticos (PRNG com semente) e modelo simplificado do corte do Guard. |
| `scripts/replay-anomaly.ts` | Ferramenta de replay (sintético, `--history arquivo.json`, `--db` somente leitura) e relatório de falsos positivos. |
| `src/services/anomalyDetectors.test.ts`, `src/services/llmAnomaly.test.ts` | 42 testes novos. |

**`llmGuard.ts` e `routes/llmGuard.ts` não foram alterados.** Um teste confere por leitura de fonte que eles não referenciam o módulo de anomalia nem a tabela.

## Garantias de projeto
- Nenhum alerta altera o Guard: não há leitura da tabela pelo Guard, não há rota de escrita, não há ação automática.
- `off`: a passada retorna antes de qualquer consulta (teste: zero queries, zero e-mails); o worker não cria timer.
- `shadow`: grava `mode=shadow`, não notifica. `on`: grava `mode=on` e notifica pelo e-mail de operações já existente (`isSesConfigured()` e `OPS_NOTIFY_EMAIL`); sem canal, só registra.
- Falha em qualquer parte da passada é engolida (log) e não propaga.
- Sem PII: alertas guardam só `scope_hash` (SHA-256 truncado de tenant/projeto) e hash de payload truncado. A rota aceita `projectId`/`tenantId` e converte em hash no servidor. Consequência: para achar o projeto de um alerta, o operador calcula o hash dos ids candidatos (trade-off aceito para cumprir "ids hash").
- Idempotência: `dedupe_key` único (`detector:métrica:escopo:janela de cooldown`).

## Parâmetros (padrões conservadores; todos sobrescrevíveis por `ANOMALY_*`)
Impressos pelo replay:
```
parâmetros: {"baselineHours":168,"baselineLagHours":24,"minBaselineHours":48,"seasonal":true,"minSeasonalPoints":4,"relFloor":0.25,"usdSigmaFloor":1,"minUsdPerHour":3,"minCallsForTokenPoint":5,"minTokensPerCall":20000,"madZ":6,"ewmaLambda":0.3,"ewmaL":5,"cusumK":1,"cusumH":10,"zClip":6,"cooldownHours":12,"repeatMinCount":5,"repeatWindowMinutes":30,"stallMinCalls":60,"stallWindowMinutes":180,"stallPriorProgressHours":72,"progressStatuses":["QA_PASS","DONE"],"reportWindowHours":3}
```
Resumo: base de 168 h defasada 24 h, **sazonal** (mesma hora do dia ±1 h nos dias anteriores, MAD sazonal), sigma = max(1,4826·MAD, 25% da mediana, piso absoluto US$ 1/h); só alerta para CIMA e com valor mínimo (US$ 3/h; 20.000 tokens/chamada); MAD z ≥ 6; EWMA λ=0,3 com limite 5 desvios do EWMA; CUSUM k=1, h=10 (z cortado em 6); cooldown 12 h por detector e escopo; repetição: ≥5 chamadas com mesmo hash em 30 min; run travada: ≥60 chamadas em 3 h sem evento de progresso (`QA_PASS`/`DONE` em `project_agent_metrics`), só se houve progresso nas 72 h anteriores. Detectores de série só decidem ao **fechar** a hora (a hora corrente não entra).

Calibração: ajustei os padrões em duas rodadas contra o próprio gerador sintético (a 1ª configuração, não sazonal, dava ~314 alertas por 35 dias de plataforma em tráfego normal). **Risco de sobreajuste ao gerador**: os números abaixo não dizem nada sobre produção.

## Replay por cenário (saída real de `npx tsx scripts/replay-anomaly.ts --fp-seeds 200`, determinística: duas execuções idênticas)
```
== Cenários sintéticos (35 dias, anomalia no dia 14; latência = início da anomalia até o 1º alerta) ==

[normal_ruido] tráfego normal com ciclo diário, fim de semana, ruído e retries ocasionais
  chamadas=17617
  alertas (todos são falsos positivos): total=0 {}

[custo_gradual] um projeto sobe de ~0 até +US$ 30/h ao longo de 10 dias a partir do dia 14 (hashes distintos)
  chamadas=40619
  mad            qualquer métrica: 2026-01-19 07:00Z (+7.0 h) project:tokens_per_call
                 só usd_per_hour:  2026-01-20 00:00Z (+1.0 d) global:usd_per_hour
  ewma           qualquer métrica: 2026-01-19 07:00Z (+7.0 h) tenant:tokens_per_call
                 só usd_per_hour:  2026-01-19 16:00Z (+16.0 h) project:usd_per_hour
  cusum          qualquer métrica: 2026-01-19 08:00Z (+8.0 h) tenant:tokens_per_call
                 só usd_per_hour:  2026-01-19 19:00Z (+19.0 h) project:usd_per_hour
  repeat_payload qualquer métrica: não alertou
  stalled_run    qualquer métrica: 2026-01-22 03:35Z (+3.1 d) project:calls_without_progress
  alertas ANTES do início (falsos positivos no mesmo cenário): 0
  corte simulado do Guard: 2026-01-21 12:06Z (+2.5 d) por teto global/24h

[pico] pico de 2 horas com ~15x o normal em um projeto no dia 14 (hashes distintos)
  chamadas=19417
  mad            qualquer métrica: 2026-01-19 11:00Z (+11.0 h) project:tokens_per_call
                 só usd_per_hour:  2026-01-19 11:00Z (+11.0 h) project:usd_per_hour
  ewma           qualquer métrica: 2026-01-19 11:00Z (+11.0 h) project:tokens_per_call
                 só usd_per_hour:  2026-01-19 11:00Z (+11.0 h) project:usd_per_hour
  cusum          qualquer métrica: 2026-01-19 12:00Z (+12.0 h) project:tokens_per_call
                 só usd_per_hour:  2026-01-19 12:00Z (+12.0 h) project:usd_per_hour
  repeat_payload qualquer métrica: não alertou
  stalled_run    qualquer métrica: 2026-01-19 10:02Z (+10.0 h) project:calls_without_progress
  alertas ANTES do início (falsos positivos no mesmo cenário): 0
  corte simulado do Guard: 2026-01-19 10:09Z (+10.2 h) por teto global/hora

[loop_mesmo_hash] 1 chamada/min com payload byte-idêntico (assinatura do incidente de 30/09) a partir do dia 14
  chamadas=47857
  mad            qualquer métrica: 2026-01-19 01:00Z (+1.0 h) project:tokens_per_call
                 só usd_per_hour:  2026-01-19 01:00Z (+1.0 h) project:usd_per_hour
  ewma           qualquer métrica: 2026-01-19 01:00Z (+1.0 h) project:tokens_per_call
                 só usd_per_hour:  2026-01-19 01:00Z (+1.0 h) project:usd_per_hour
  cusum          qualquer métrica: 2026-01-19 02:00Z (+2.0 h) project:tokens_per_call
                 só usd_per_hour:  2026-01-19 02:00Z (+2.0 h) project:usd_per_hour
  repeat_payload qualquer métrica: 2026-01-19 00:04Z (+0.1 h) project:same_hash_calls
  stalled_run    qualquer métrica: 2026-01-19 01:08Z (+1.1 h) project:calls_without_progress
  alertas ANTES do início (falsos positivos no mesmo cenário): 0
  corte simulado do Guard: 2026-01-19 00:04Z (+0.1 h) por payload repetido (6h)

[run_travada] projeto passa a fazer ~30 chamadas/h variadas sem nenhum progresso a partir do dia 14
  chamadas=32737
  mad            qualquer métrica: 2026-01-19 01:00Z (+1.0 h) global:usd_per_hour
                 só usd_per_hour:  2026-01-19 01:00Z (+1.0 h) global:usd_per_hour
  ewma           qualquer métrica: 2026-01-19 02:00Z (+2.0 h) project:usd_per_hour
                 só usd_per_hour:  2026-01-19 02:00Z (+2.0 h) project:usd_per_hour
  cusum          qualquer métrica: 2026-01-19 03:00Z (+3.0 h) project:usd_per_hour
                 só usd_per_hour:  2026-01-19 03:00Z (+3.0 h) project:usd_per_hour
  repeat_payload qualquer métrica: não alertou
  stalled_run    qualquer métrica: 2026-01-19 01:46Z (+1.8 h) project:calls_without_progress
  alertas ANTES do início (falsos positivos no mesmo cenário): 0
  corte simulado do Guard: 2026-01-21 03:45Z (+2.2 d) por teto global/24h

== Falsos positivos em tráfego normal sintético (200 sementes x 35 dias, 5 projetos / 3 tenants) ==
  alertas totais=76 por detector={"ewma":21,"mad":26,"stalled_run":29}
  taxa: 0.380 alertas por 35 dias de plataforma; 0.076 por semana de plataforma; 0.00844 por série-semana
  fração de sementes com >=1 alerta: 22.5% (45/200)
  (limite aceitável NÃO fixado aqui: é do pré-registro; esta é só a taxa medida em dados sintéticos)
```

Leitura honesta:
- Em **loop de mesmo hash** o corte do Guard (payload repetido em 6 h) já age em ~6 min; o alerta chega no mesmo patamar (repeat_payload +0,1 h) e os de série em 1–2 h. O ganho do alerta aqui é só redundância.
- Em **custo gradual** e **run travada** (hashes distintos, sem repetição) o Guard só corta pelo teto global/24 h (+2,5 d e +2,2 d). EWMA/CUSUM em USD/hora alertam em +16 h a +19 h (gradual) e +2 h a +3 h (run travada).
- Em **pico** o Guard (teto global/hora) corta antes (+10,2 h) do que os detectores de série fecham a hora (+11 h): o alerta não ajuda se o pico já ultrapassa o teto.
- O modelo do corte do Guard é simplificado (tetos globais padrão 40/hora, 250/24 h, 4 repetições em 6 h e um orçamento de US$ 2.500 no projeto). Não é o Guard real. Não modela o disjuntor que liga a chave geral.
- "tokens_per_call" nos cenários gradual/pico/loop alerta cedo porque os eventos sintéticos injetados têm mais tokens que o normal (artefato do gerador); por isso o relatório mostra também o 1º alerta só em `usd_per_hour`.
- O incidente real (22 dias, BRL 90.305,78) não foi reproduzido com dados reais: sem acesso a produção. Os cenários são sintéticos.

## Falsos positivos medidos (tráfego normal sintético, sem anomalia)
200 sementes x 35 dias, 5 projetos / 3 tenants, ciclo diário, fim de semana, retries ocasionais (2% de duplicatas):
- 76 alertas no total (ewma 21, mad 26, stalled_run 29, **cusum 0**, repeat_payload 0).
- 0,076 por semana de plataforma; 0,0084 por série-semana; **22,5 % das sementes (45/200) tiveram ao menos um alerta** em 35 dias.
- Sem aceite declarado: o limite aceitável será fixado no pré-registro (0.6). O detector de run travada responde por 38 % dos falsos alertas.

## Testes (saída real)
Base antes: 184 arquivos, 3321 passaram, 1 pulado. Depois (`npx vitest run`):
```
 Test Files  186 passed (186)
      Tests  3363 passed | 1 skipped (3364)
```
`npx tsc --noEmit`: sem erros. Cobertura dos testes novos: flag e parâmetros, estatística, privacidade, degrau/queda/piso/buracos, repetição, determinismo, falso positivo (guarda de regressão, não limite de aceite), pico, gradual (alerta antes do corte simulado), loop, run travada, `off` sem nenhuma query, worker `off` sem timer, shadow/on/sem canal, idempotência, janela recente, falha de banco, listagem parametrizada e, para `off|shadow|on`, Guard negando por chave geral e por banco fora (fail-closed) sem tocar na tabela de alertas.

## Riscos e pendências
- Parâmetros calibrados só em sintético; precisam de janela de coleta real em `shadow` (3–6 semanas, conforme o plano) antes de qualquer decisão.
- Falso positivo de run travada depende da definição de "progresso" (`QA_PASS`/`DONE` em `project_agent_metrics`); validar com dados reais. Projetos que nunca tiveram progresso nas 72 h anteriores não geram alerta de run travada (de propósito, para não alertar planejamento inicial).
- A passada lê até 500.000 linhas do ledger por execução (janela de ~8 dias); revisar custo da consulta em volume real (índice `idx_llm_ledger_created` existe).
- A série por tenant usa `COALESCE(l.tenant_id, projects.tenant_id)`; chamadas sem projeto nem tenant entram só na série global.
- Migration 136 e o endpoint não foram aplicados em nenhum banco real (só testados com banco fake e o teste de sanidade de migrations).
- 1.7 (estimador com IC95) não foi feita.
