> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# C4' — Teto do Advisor = X % do orçamento total do projeto-dono, aplicado pelo Guard (branch `evo/c4`, base `b929c32`)

Desenho: `zentriz-autonomy-suite/evolution/27-desenho-controle-de-gasto.md` §1, §3.1–3.2, §4 (C4'). Depende da C3' (`cost_policies`, migration 161; ver `EVOLUIR-PROJETO-AJ-c3-cost-policies.md`). Sem migration nova.

## O que foi entregue
- **Guard aplica o teto** (`api-node/src/services/llmGuard.ts`, `advisorGate`, linha 471; `advisorSpentUsd`, 453). Teto = `advisor_pct` % × `budget_usd` do projeto-dono (limitado por `abs_cap_usd`, via `advisorPolicyView`); gasto = `SUM(cost_usd)` de `llm_call_ledger` com `llm_role='advisor'` e `budget_project_id` = dono, mais as reservas em voo do chamador e a chamada projetada. Fail-closed **só para o Advisor**.
- **Rota** `POST /api/internal/llm-guard/advisor-gate` (`routes/llmGuard.ts:96`), mesma autenticação interna do `preflight`.
- **Eventos persistidos em `llm_guard_events`** (visíveis em `GET /api/admin/llm-guard/events`): `advisor_denied_no_base` (detalhe `reason`: `budget_missing` | `project_not_found` | `invalid_pct` | `cap_below_floor`) e `advisor_cap_reached` (com `capUsd`, `spentUsd`, `inflightUsd`, `projectedUsd`). O detalhe leva o **snapshot da configuração**: `policyVersion`, `policyAuthor`, `policyUpdatedAt`, `pct`, `baseUsd`. A resposta do gate (decisão de permitir) também leva esse snapshot. `AdvisorPolicyView` ganhou `author` e `updatedAt`.
- **Piso** (`api-node/src/lib/advisorFloor.ts`): piso = 1 chamada típica (40.000 tokens de entrada + 16.000 de saída) × preço `opus` da `modelPricing.ts` = **US$ 0,60**. Constantes nomeadas. A gravação de `advisor_pct` (`PUT /api/cost-policies`) aceita `baseBudgetUsd` e recusa com `ADVISOR_BELOW_FLOOR` (400) se `pct % × base` < max(piso calculado, `floor_usd` da política). Em runtime, teto abaixo do piso = base inválida (`advisor_denied_no_base`, `reason: cap_below_floor`).
- **Orchestrator Python**: `llm_guard.advisor_gate` (`llm_guard.py:277`) consulta o Guard; `AdvisorBudget.reserve(..., project_id, gate)` (`llm_roles.py:402`) delega o teto ao Guard quando há projeto; `plan_attempt(project_id=...)` (`llm_roles.py:497`); `runtime.py:2698` passa o projeto e `runtime.py:2712` trata as quatro notas (`ESCALATION_DENIED_NOTES`, `llm_roles.py:322`) como "escalada não feita, segue no Orchestrator do slot" (`_escalation_note` já sai no envelope). A task nunca vira `failed`/BLOCKED por causa do Advisor.
- **Reserva em memória unificada com o Guard**: com política, a memória só guarda a idempotência da chave e as reservas **em voo** (enviadas ao Guard em `inflightUsd`); o gasto liquidado vem do ledger. Reinício do `agents` não zera nada. `ADVISOR_MAX_USD_PER_RUN` + gasto em memória permanecem **somente como fallback legado** (comentário em `llm_roles.py:~304`).

## Regras atendidas
1. `BUDGET_MISSING` do `preflight` intocado (testado).
2. Base ausente/inválida ⇒ nega só o Advisor, evento `advisor_denied_no_base`, chamada segue no Orchestrator.
3. Teto estourado ⇒ `advisor_cap_reached` (evento + nota), nunca erro da task.
4. Env removida ⇒ teto vale; reinício não zera (ledger). Sem política ⇒ `mode:"legacy"` = comportamento anterior (env, default US$ 5 só nesse caminho).
5. Piso simples, constante e testado. Defaults de flags e Advisor desligado em produção: **não alterados**.

## Testes (cada novo falha sem a implementação: verificado por `git stash` dos arquivos de produção)
- `api-node/src/services/advisorGate.pg.integration.test.ts` (7, Postgres real): legado sem política; teto % com env removida + eventos + em voo; nova instância/pool lê o mesmo ledger; gasto real via `recordCall` (`llm_role='advisor'`); sem base (orçamento nulo, projeto inexistente, teto < piso, sem política e sem orçamento) + `BUDGET_MISSING` inalterado; falha de leitura nega o Advisor; piso na gravação (`ADVISOR_BELOW_FLOOR`, `baseBudgetUsd`, `floorUsd`).
- `orchestrator/tests/test_llm_roles_c4_advisor_gate.py` (7): env removida; reinício (novo `AdvisorBudget`) com contraste do legado; sem base; fallback legado; dedupe; Guard inalcançável (fail-closed); `run_agent` ponta a ponta (base ausente, teto estourado, liberado) contra o Guard fake HTTP.
- `test_llm_roles.py`: o Guard fake passou a responder `/advisor-gate` (padrão `legacy`, ajustável por `advisor_verdict`).

| Suíte | Antes | Depois |
|---|---|---|
| vitest, 55440 (sem as 4 de porta fixa) | 4065 | **4072** passam (+7); 4 falham só por porta fixa |
| vitest, 4 de porta fixa em 55432 | 25 | 25 passam |
| pytest | 23 falhas / 1223 passam | 23 falhas (lista idêntica) / **1230** passam |
| `tsc --noEmit` | ok | ok |

## Assunções (explícitas) e pendências
- **Piso `calibrado=false`**: saída 16.000 = default `CLAUDE_MAX_TOKENS_QA`; entrada 40.000 é estimativa sem medição; preço = linha `opus` (5/25 por MTok). Substituir por quantis do ledger na C9'. O piso só barra configuração inútil; nunca libera gasto.
- **Interpretação "sem política"**: o enunciado pede negar sem base "sem política ou orçamento" e, ao mesmo tempo, manter a env como fallback sem política. Adotado: **sem orçamento** ⇒ `advisor_denied_no_base` (com ou sem política); **com orçamento e sem política** ⇒ `mode:"legacy"` (env). Se o Jean quiser fechar o legado, basta o gate negar quando `!p` (mudança de uma linha) — decisão dele.
- **Piso na gravação** usa `baseBudgetUsd` informado (a política é global/tenant, não por projeto); sem ele a gravação não checa (compatível com a C3'). A defesa por projeto é o gate em runtime.
- **Snapshot** = versão/autor/data da política vigente na decisão, registrados no evento; não há coluna de base congelada por projeto (a base é o `budget_usd` vivo do dono).
- **Corrida**: duas escaladas simultâneas na mesma réplica veem o em voo; em duas réplicas ambas podem passar (reserva no Postgres é a C2'). Reserva em voo é por processo.
- **Aplicação só no gate**: o `preflight` comum não nega Advisor (negar lá viraria `LlmGuardDenied`, que falha a task — contra a regra 3). Um cliente que não chame o gate não é barrado por ele; hoje o único chamador é o `runtime.py`.
- **Ordem de deploy**: api (rota `advisor-gate`) antes de `agents`. Com `agents` novo e api antiga o gate dá 404 ⇒ Advisor negado (`advisor_guard_unreachable`, fail-closed; Advisor segue desligado por padrão).
- Estimativa do `settle` no Python usa preço de lista; o gasto autoritativo é o do ledger (custo real do `record`). Há uma janela curta entre `settle` e o `record` em que a chamada não está em nenhum dos dois.
- Fora de escopo: UI (C7), teto macio/duro (C5'), quantis (C9').
