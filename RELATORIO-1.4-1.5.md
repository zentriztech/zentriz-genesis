> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Relatório das tarefas 1.4 (telemetria de desperdício) e 1.5 (cache e prefixo de spec)

Branch `evo/p1-14` (repositório zentriz-genesis, worktree `.worktrees/g-14`), derivada de `evo/p1-13` (`24c306b`). Sem push, sem deploy, sem acesso a produção, `docker-compose*` intocado, `modelPricing.ts` intocado, nenhuma escolha de modelo mudou.

Commits (todos com o rodapé `Co-Authored-By: Claude Sonnet 5.5`):
- `8476dfe` — api-node: migration 137, flag `WASTE_TELEMETRY`, gravação no ledger, testes vitest.
- `fb01e64` — orquestrador Python: motivo da chamada, chave de idempotência, 2 consultas SQL, script de cálculo, JSON sintético, testes.
- `ab6876c` — 1.5: script de medição de cache e prefixo, JSON sintético, testes.
- `55cd318` — correção: `waste_call_kwargs` (ver §5, incidente da própria tarefa).

## 1. Tarefa 1.4 — o que mudou

### api-node (`applications/services/api-node`)
- `src/db/migrations/137_waste_telemetry_ledger.sql`: a última era 135; 136 fica com a 1.6. Só `ALTER TABLE llm_call_ledger ADD COLUMN IF NOT EXISTS call_reason TEXT` e `call_idem_key TEXT`, mais dois `CREATE INDEX IF NOT EXISTS` (motivo × data, chave × data). Sem `DO $$`, sem `;` em literais ou comentários, sem backfill, sem CHECK, sem UNIQUE. Rodei o arquivo duas vezes num Postgres 16 descartável (container `postgres:16`, porta local, removido depois): aplica e é idempotente.
- `src/lib/wasteTelemetry.ts` (novo): `wasteTelemetryMode()` (`off|shadow|on`, padrão `off`, inválido vira `off`), `normalizeCallReason()` (6 motivos; desconhecido vira NULL), `normalizeIdemKey()` (exige o separador `|`).
- `src/services/llmGuard.ts`: `RecordInput` ganha `callReason` e `callIdemKey`. Em `recordCall` (linha 419), com `off` o INSERT segue os ramos antigos, byte a byte (snapshot literal no teste). Com `shadow` ou `on`, o INSERT acrescenta as duas colunas (17 parâmetros; 20 se `LLM_ROLES_MODE` também estiver ligada). A rota `/record` já repassa o corpo inteiro, então não precisou mudar.
- Decisão de desenho sobre a idempotência: o ledger é fonte de gasto real, então **nenhuma linha paga é descartada** (nada de `ON CONFLICT DO NOTHING`, nada de UNIQUE). A chave só marca; a análise deduplica. Uma linha com a mesma `call_idem_key` de outra anterior em até 300 s é `dup_rede`: o gasto entra em `retry`, mas não conta como outra chamada de negócio.

### Orquestrador Python (`applications/orchestrator`)
- `agents/llm_guard.py` (linhas 134-170): `waste_mode()`, `normalize_reason()`, `derive_reason()`, `idem_key()`, `waste_kwargs()`, `waste_call_kwargs()`. `check()` ganha `call_reason`, `call_task`, `call_stage`, `call_attempt` e só põe `callReason` e `callIdemKey` no contexto com a flag ligada e motivo válido. `record()` espalha o contexto, então não mudou. Com `off`, nenhuma chave nova entra no payload (teste de conjunto exato de chaves).
- Chave: `projeto|task|etapa|tentativa`. Em `run_agent`: etapa `ROLE:mode`, tentativa `r{rework_attempt}.p{repair_attempt}`. Sem etapa, não há chave (melhor não deduplicar do que fundir chamadas distintas).
- Motivo derivado do contexto que já existe:

| Ponto de chamada | Motivo | Arquivo:linha |
|---|---|---|
| `run_agent`, `repair_attempt >= 1` (LEI 5) | `repair` | `agents/runtime.py:2674` |
| `run_agent`, Dev/QA com `rework_attempt >= 1` | `rework` | `agents/runtime.py:2674` |
| `run_agent`, demais | `primary` | `agents/runtime.py:2674` |
| `_run_agent_openai` | `primary` | `agents/runtime.py:2182` |
| `splitter`, `spec_split`, `/invoke/raw` principal | `primary` | `agents/server.py:677,778,1183` |
| `/invoke/raw` fallback do slot | `escalation` | `agents/server.py:1199` |
| Cyborg V3 (sessão do engenheiro) | `escalation` | `cyborg_v3.py:923` |
| `runner:backend_language`, `runner:module`, `runner:autonomous_monitor` | `support` | `runner.py:1894,2112,2660` |

  Precedência: repair vence rework (é o desperdício mais fino). O Cyborg e o fallback ficam em `escalation` (decisão de modelo, não erro) e são reportados à parte nas consultas; quem quiser contá-los como desperdício muda uma lista.
- `call_bedrock_direct` ganha o parâmetro `waste` (`runtime.py:3431`), e `waste_call_kwargs()` devolve `{}` com a flag `off`, de modo que a chamada fica com os mesmos argumentos de antes.
- **Retry de rede dentro de `run_agent`**: o laço interno de `CLAUDE_RETRY_ATTEMPTS` só grava um `record` por chamada que devolveu resposta (tentativas que falham não têm usage), então ele não gera linha extra. A chave não inclui o índice desse laço, de propósito.

### Consultas e script
- `applications/services/api-node/scripts/sql/desperdicio_pct_por_fase_semana.sql`: % do gasto em retry + repair + rework por fase × semana, com `pct_escalation`, `pct_nao_medido` (cobertura), chamadas de negócio e duplicatas de rede.
- `applications/services/api-node/scripts/sql/segundos_desperdicados_por_fase_semana.sql`: segundos (soma de `duration_ms`) por bucket. É piso do tempo de relógio: não inclui backoff, fila nem validação local.
- `scripts/waste_report.py` e `scripts/data/waste_synthetic_history.json` (215 linhas, seed fixa, **dados fictícios**).
- As duas consultas rodaram no Postgres 16 descartável sobre o mesmo JSON sintético, e o resultado bateu com o do script (USD e segundos por semana/fase). Achei e corrigi um defeito nessa conferência: divisão inteira no `%` de segundos (`100 *` virou `100.0 *`). Nada foi executado contra o banco real.

### Saída real do script (histórico sintético)
```
Linhas lidas: 215 | janela de deduplicação: 300s
semana      fase        total_usd  retry   repair  rework  desp_usd  %desp  %escal  %nao_med  seg_desp  %seg  negocio  dups
2026-10-05  bancada       1.5635  0.0000  0.2687  0.0000    0.2687  17.2    0.0    32.6      110.5  20.2       10     0
2026-10-05  fabrica      10.5749  0.0000  0.5444  2.9247    3.4691  32.8    7.2     0.0     1489.7  27.5       45     0
2026-10-12  bancada       2.0043  0.2100  0.5903  0.0000    0.8003  39.9    0.0    25.4      309.1  41.8       11     1
2026-10-12  fabrica       7.7775  0.0000  0.0000  3.3259    3.3259  42.8    0.0     0.0     1304.9  40.1       33     0
2026-10-19  bancada       1.9568  0.2100  0.5489  0.0000    0.7589  38.8    0.0    26.1      254.4  37.8       11     1
2026-10-19  fabrica      12.0431  0.0000  0.5444  4.5195    5.0639  42.0   12.6     0.0     2155.0  30.4       46     0
2026-10-26  bancada       1.7410  0.2100  0.2376  0.0000    0.4476  25.7    0.0    29.3      172.3  27.0       10     1
2026-10-26  fabrica      11.7619  0.0000  0.9512  4.6559    5.6071  47.7    0.0     0.0     2070.4  46.6       46     0
Total por fase (todas as semanas):
  bancada    gasto US$ 7.2656 | desperdício US$ 2.2755 (31.3%) | segundos desperdiçados 846.3 de 2599.2
  fabrica    gasto US$ 42.1574 | desperdício US$ 17.4660 (41.4%) | segundos desperdiçados 7020.0 de 20204.8
```
Esses percentuais vêm de dados inventados para exercitar o script. **Não são uma medição**; o teto de aceitação do 0.6 continua sem número real para comparar.

## 2. Tarefa 1.5 — medição (item a) e o que já existia (item b)

- `scripts/cache_prefix_report.py` calcula, por ponto de chamada: hit-rate `read/(input+read)` (definição do pedido) e `read/(input+read+write)` (definição do doc 08a E13); identidade de prefixo entre chamadas consecutivas do mesmo projeto (inteira e restrita ao TTL de 300 s); multa de escrita 1,25×; economia de leitura; líquido do cache atual; simulação de `votes=1` com cache ligado; grade de ganho com `votes` 1, 2, 3 e 5; ponto de equilíbrio. Preços são parâmetro: `--precos oficial|repo|ambos|arquivo.json`.
- Divergência de preço registrada (e impressa pelo script com `--precos ambos`): oficial Opus 5.5 = 4/20 com leitura 0,05×; repositório = 5/25 com leitura 0,1×. Sonnet 5.5 confere em 2/10, mas a leitura oficial é 0,05× e o repositório usa 0,1×. `modelPricing.ts` não foi alterado.
- Fórmulas derivadas, independentes de dado: cache com `votes=1` só compensa se a identidade de prefixo dentro do TTL passar de `(w-1)/(w-r)`, ou seja 20,8 % (r=0,05) a 21,7 % (r=0,1); com `votes>=2` compensa sempre (custo da entrada `w+(v-1)r` contra `v`). Isso confirma a leitura de GAP-142: `votes=1` é multa.
- Item (b): não refiz nada. `usar_cache = votes > 1` está intacto (`spec_validator.py:512`) e há um teste que trava isso; `_cache_read_tokens_total` (GAP-148) não foi tocado.
- **Identidade de prefixo no ledger real: não medida.** O ledger só guarda `prompt_hash` do prompt inteiro. Medir a identidade exige capturar hash e tokens por bloco (system, tarefa, spec, charter...) no ponto de chamada, que é instrumentação de produção e ficou fora do escopo. O script aceita `segments` e traz `segmentar()` para prompts capturados localmente.

### Saída real da sonda estrutural (ordem do prompt no código, conteúdo sintético)
```
Sonda estrutural (build_user_message real; conteúdo sintético; mede ORDEM, não produção):
  DEV tarefa 1 -> 2 (spec/charter/backlog iguais): prefixo comum 27/44378 chars = 0.1%
  CTO mesma spec, 2ª chamada idêntica: 100.0%
  CTO spec com 1 edição no meio (50%): 42.4%
```

### Saída real do script de cache (sintético, tabela `oficial`, resumo; completo com `--precos ambos`)
```
spec_validator  : identidade (votes=1) 19.6% (no TTL 14.3%, 9 pares) | equilíbrio 20.8% | líquido do cache atual US$ 6.79 | sim votes=1 com cache: US$ -1.15
DEV:implement_task: identidade 11.2% (no TTL 11.2%) | equilíbrio 20.8% | sim votes=1 com cache: US$ -0.88
CTO:spec_intake : identidade 98.2% mas nenhum par dentro do TTL de 300s => cache só como multa
grade (spec_validator, entrada por run): v=1 ganho -0.0645 | v=2 +0.1806 | v=3 +0.4257 | v=5 +0.9159
divergência de preço (custo de entrada sem cache): spec_validator 18.58 (oficial) vs 23.22 (repo); DEV igual; CTO 2.76 vs 3.45
```
Tudo isso é sintético, exceto a sonda estrutural, que lê o código real.

### Achados lógicos (do código, não de produção)
1. **Fábrica (Dev):** `build_user_message` emite `## Tarefa` e o código de dependência **antes** da spec, do charter e do backlog. Entre duas tasks do mesmo projeto o prefixo comum é ~0,1 % do prompt, embora ~88 % do prompt seja estável. Reordenar elevaria a identidade muito acima do equilíbrio de ~21 %.
2. **CTO (Bancada):** o prefixo é estável, mas o repair leva ~10 min (comentário em `runtime.py`), fora do TTL de 5 min. Cache de 5 min não pega; o de 1 h custa 2× na escrita.
3. **Refutador (B05):** já resolvido pelo GAP-142 para `votes>1`. Com `votes=1` o cache continua sendo multa, e a spec muda a cada rodada.
4. `run_agent` (caminho de Dev, QA, CTO) **não marca cache de prompt** hoje: só `call_bedrock_direct` marca. Então qualquer ganho em Dev/CTO exige mais que reordenar.

### Item (c): ajuste de prefixo — decisão
**Não implementei `SPEC_PREFIX_CACHE`.** O achado 1 mostra ganho lógico possível no Dev, mas o ajuste não é "mínimo" nem seguro: exige (i) reordenar o prompt de Dev na função mais usada do pipeline (a entrada do modelo muda; o plano pede não-inferioridade de qualidade, que não está medida), e (ii) passar a marcar cache em `run_agent`, onde hoje não existe, com a multa de 1,25× em toda chamada sem reuso. Sem a medição real da Fábrica (doc 06 §8 item 3 diz que não há) não dá para prever se as tasks chegam dentro de 5 min. Fica como **proposta, estado "preparado"**:
1. Capturar `segments` (hash e tokens por bloco) no ponto de chamada de Dev, QA, CTO e refutador, atrás de flag, por 1 a 2 semanas em shadow.
2. Rodar `cache_prefix_report.py` no resultado: só avançar se a identidade no TTL ficar acima do equilíbrio do modelo real.
3. Aí sim, `SPEC_PREFIX_CACHE=off|shadow|on` com a reordenação (estável antes do variável) e `cache_control` em `run_agent`, em canário por projeto, com não-inferioridade de QA_PASS e rework.
4. Trocar de modelo invalida o cache (cache é por modelo): rework escalado para o Advisor perde a economia; o custo-modelo da 2.6 precisa dessa penalidade.

## 3. Testes (saída real)
- Vitest base (antes de editar, comando `npx vitest run` em `applications/services/api-node`): `Test Files 184 passed (184)`, `Tests 3321 passed | 1 skipped (3322)`.
- Vitest depois: `Test Files 185 passed (185)`, `Tests 3333 passed | 1 skipped (3334)` (+12: 10 em `src/services/llmGuard.waste.test.ts` e 2 que `src/db/migrations.test.ts` gera sozinho para a migration 137).
- `npx tsc --noEmit -p .`: sem erros, antes e depois.
- Pytest base (`24c306b` num worktree temporário, removido): `23 failed, 899 passed, 2 skipped`.
- Pytest depois (`/home/ubuntu/.venvs/genesis-py/bin/python -m pytest orchestrator -q`): `23 failed, 928 passed, 2 skipped`. As 23 falhas são o mesmo conjunto de ambiente (`test_spec_validator` 13, `test_prompt_census_invoke_raw_gap146` 4, `test_connect_contracts` 2, `test_thinking_arm_gap144` 2, `test_spec_dossier_downstream` 1, `test_workbench_llm_config` 1), nenhum em arquivo que eu tenha tocado de forma relevante.
- Novos: `test_waste_telemetry.py` (15 testes: flag, `off` com conjunto exato de chaves do payload, `shadow`, derivação primary/repair/rework via `run_agent` real com repair forçado, chave estável entre retries, motivo inválido, negativa do guard sem record, coexistência com papéis, regressão do `waste_call_kwargs`), `test_waste_report.py` (4, resultado calculado à mão), `test_cache_prefix_report.py` (10, fórmulas e contas à mão, trava de `usar_cache = votes > 1`, sonda estrutural).

## 4. Estado
- **Criado:** migration 137 (não aplicada em banco real), flag `WASTE_TELEMETRY`, propagação do motivo, consultas, scripts.
- **Validado:** testes unitários e de contrato; migration e consultas em Postgres 16 descartável com dados sintéticos; script e SQL concordam.
- **Funcional:** ainda não. Com `WASTE_TELEMETRY=off` (padrão) o comportamento é idêntico. Para produzir série real: aplicar a migration (boot da api) e ligar `WASTE_TELEMETRY=shadow` **nos dois lados** (api e orquestrador; flag de um lado só grava NULL ou descarta o motivo).
- **1.5:** medição criada e validada em sintético; ajuste de prefixo **preparado (proposta)**, não implementado.

## 5. Riscos e incidente
- **Incidente corrigido:** minha primeira versão passava `waste=...` sempre ao `call_bedrock_direct`, o que quebrava dublês de teste (`TypeError`, 4 testes novos falhando: 27 em vez de 23) e não era byte-idêntico em `off`. Corrigi com `waste_call_kwargs` (`{}` em `off`), commit `55cd318`, e o conjunto de falhas voltou a ser idêntico ao da base.
- O motivo `primary` vale para qualquer chamada sem contexto de repair ou rework; chamadas que o runner repete por conta própria (nova tentativa da task com os mesmos `rework_attempt`) repetem a chave, e a janela de 300 s é o que separa retry de rede de reexecução real. Se a reexecução ocorrer em menos de 5 min, ela será tratada como duplicata de rede (gasto vai a `retry`, chamada de negócio não conta). Parâmetro ajustável nas duas consultas e no script.
- `duration_ms` é piso do tempo desperdiçado.
- `ALTER TABLE ... ADD COLUMN` em `llm_call_ledger` grande tem lock curto no boot da api; rollback é por flag.
- Descartar o motivo no ledger não corrige o custo: a 1.4 só mede. O teto de aceitação do 0.6 precisa de dado real.

## 6. Pontos de chamada NÃO cobertos (motivo NULL = "não medido")
- `call_bedrock_direct` em `spec_validator.py` (refutador, triagem e consolidação, inclusive o retry por truncamento, que seria `retry`), `lesson_extractor.py` e `probe_slot`. São os mesmos que a 1.3 deixou sem papel.
- Deadpool (outro repositório).
- `project_agent_metrics`: não ganhou `call_reason`, porque cada linha agrega várias chamadas (original e repairs) e um único motivo seria falso. Os outros 4 INSERTs dessa tabela (`products.ts`, `productNormalizer.ts`, `specChatJobs.ts`, `promotionPlanner.ts`) também não.
- O laço interno de retry de rede de `run_agent` e do Cyborg não gera linha própria (tentativas sem resposta não têm usage); se a API do provedor cobrar tentativas que falham, esse gasto não aparece em nenhuma linha.
- A chamada principal descartada do `/invoke/raw` (resposta vazia antes do fallback) não é reclassificada como desperdício; só o fallback é `escalation`.
- Reexecuções do runner que mudam o `request_id` mas não o `rework_attempt` dependem da janela de deduplicação (ver §5).
- Staff ainda não existe, então nenhum motivo `support` vem de Staff: os 3 `runner:*` são classificadores no modelo principal.

## 7. Branch e hashes
`evo/p1-14`: `8476dfe`, `fb01e64`, `ab6876c`, `55cd318` (mais o commit deste relatório).
