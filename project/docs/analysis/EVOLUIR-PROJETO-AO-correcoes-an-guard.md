> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# AO — Correções dos achados da revisão AN (Guard de custo C3'/C4' e Fases 5/6)

Branch `evo/f7` (base `9a01573`). Sem push, sem produção. Revisão de origem: `EVOLUIR-PROJETO-AN-revisao-guard-fase5-6.md`. Desenho: `zentriz-autonomy-suite/evolution/27-desenho-controle-de-gasto.md` §5 (nada de fail-open).
Método: para cada item, teste de reprodução primeiro, depois a correção. Todos os 12 testes novos (`services/guardAn.pg.integration.test.ts`) falham com o código anterior (mutação: fontes revertidas, 12/12 vermelhos) e passam com a correção.

## Correções (arquivo:linha em `applications/services/api-node/src`)

| Item | Correção | Onde |
|---|---|---|
| A1 | `getEffectivePolicy` deixa de engolir erro: sem linha ⇒ `null` (legado); erro ⇒ lança. Advisor: `advisor_denied_policy_error` + evento. Card: `GUARD_ERROR` (só se o projeto é card; o que não é card não é afetado). Disjuntor: em falha usa o MENOR entre o último valor lido e o setting (`effectiveBreakerCap`). Exposição informativa (`preflight`/`budgetSummary`) tolera a falha. | `services/costPolicies.ts:224,310,334`; `services/llmGuard.ts:509-530,588` |
| A2 | Gancho de rota sincroniza também `CARD_BUDGET_CAP` (throttle por projeto+origem, para um `record` não consumir o intervalo da negativa); reconciliador inclui card com `card_cap_reached` nas últimas 24 h (filho vivo na Bancada); `CARD_BUDGET_CAP` entra em `BUDGET_CODES` do runner (sem as 10 reverificações). | `routes/llmGuard.ts:38,116`; `services/cardPromote.ts:236-238`; `orchestrator/guard_denial.py:27` |
| A3 | `denyForeignTenant`: `tenant_admin` (sem `svc`) só opera projeto do próprio tenant em preflight, advisor-gate e record; outro tenant, inexistente ou id inválido ⇒ mesmo 404, sem campos do gate. Token estático, zentriz_admin e `svc` seguem como antes (runner continua amarrado ao próprio projeto). | `routes/llmGuard.ts:64,110,126,137` |
| A4 | Gate de retomada usa a mediana das chamadas do dono (próxima chamada) em vez de 0. | `services/llmGuard.ts:975` |
| M1 | Com política do Advisor e `LLM_ROLES_MODE=off` na API, o gate nega com evento (`advisor_denied_no_base`, `reason: roles_off`). | `services/llmGuard.ts:536-540` |
| M2 | Gasto do Advisor = `COALESCE(effective_role, llm_role) = 'advisor'`. | `services/llmGuard.ts:486` |
| M3 | PUT de tenant acima da global é recusado (`TENANT_POLICY_EXCEEDS_GLOBAL`); a leitura limita ao mais restritivo (pct mínimo; `abs_cap_usd` mínimo ou herdado), mesmo se a global for baixada depois. | `services/costPolicies.ts:224,241`; `routes/costPolicies.ts:88-91` |
| M4 | Pós-registro usa os mesmos tetos do preflight (`breakerCaps`). | `services/llmGuard.ts:371,691` |
| M7 | Migration `162_llm_ledger_project_index.sql` (`CREATE INDEX IF NOT EXISTS idx_llm_ledger_project`; `budget_project_id` já tinha `idx_llm_ledger_budget` desde a 131). Preflight sem política não consulta `tickets` nem o ledger do card; o dono já resolvido é reaproveitado; a política é lida uma vez (`*ViewFromPolicy`). | `db/migrations/162_*.sql`; `services/llmGuard.ts:588` |
| M8/M9 | Runbook (§3.1, tabela de papéis, A6, novas A9–A13), guia (§8 e limites) e RFC-0009 (tabela Orçamento) atualizados; afirmação falsa do gancho corrigida; `EVOLUTION_PROMOTE_BANCADA` declarada obrigatória na prática (`routes/pipeline.ts:144-162`, 409 `NOT_ON_WORKBENCH`); comentário de `index.ts:148` corrigido (o worker sempre agenda). | `project/docs/runbooks/CARDS-BANCADA-RUNBOOK.md`, `guides/GUIA-CARDS-BANCADA.md`, `rfc/RFC-0009-EVOLUCAO-POR-TICKET.md` |

Testes antigos ajustados (comportamento deliberadamente novo): `advisorGate.pg…` liga `LLM_ROLES_MODE=on` (M1); `cardBudget.f5…` usa chamadas de US$ 1 (A4) e tenant ≤ global (M3); `projectsReaders.inventory.test.ts` ganha a exceção da consulta de posse (autorização, não lista).

## Assunções e riscos aceitos (decisões do orquestrador)

- **M3 (assunção):** o mais restritivo vence; tenant nunca fica acima da global. O `ADVISOR_MAX_USD_PER_RUN=0` do operador continua ignorado em `mode:"policy"` (não tratado).
- **M5 (risco aceito):** base do teto = `budget_usd` corrente do dono, sem snapshot. Mitigação: Advisor desligado por padrão em produção, `calibrado=false`. O PUT do orçamento continua sem recusar valor abaixo do piso.
- **M6 (risco aceito):** filhos de split do filho ficam fora do teto do card; o orçamento do dono continua sendo o limite total.
- **A4 (assunção):** a folga do gate é a mediana das chamadas do dono (uma chamada), por ser a ordem de grandeza do `est` do preflight; chamada muito maior que a mediana ainda pode ser negada após a retomada (sem laço de liberação, pois o card só volta se a mediana couber).
- **A1 (resíduo):** processo recém-iniciado, sem valor de disjuntor conhecido e com `cost_policies` ilegível, cai no setting (que é um teto, nunca "sem teto"). A leitura de política ilegível nega todo card, não os demais projetos.
- **M7:** `CREATE INDEX` simples (não `CONCURRENTLY`): bloqueia escritas no ledger durante a construção. Ledger pequeno hoje; avaliar janela se crescer.
- **B2:** ordem de deploy api→agents registrada no runbook (A12). **B3/B4/B5/B6:** não tratados (baixa).

## Verificação

- API (`npx tsc --noEmit` limpo): Postgres 55440 `vitest run` = 4091 passaram, 26 skip (baseline informado 4077; +12 novos, +2 do conjunto) e as 4 suítes de porta fixa (llm.reorder, llm.role-verify, costSource, skillFeedback) em 55432 = 25 passaram.
- Python (`/tmp/pyv`): baseline em worktree limpo 23 falhas / 1230 passaram; depois 23 falhas (lista idêntica, ambiente) / 1231 passaram (+1 teste novo `test_card_budget_cap_e_negativa_de_orcamento`, que falha sem a correção).
- Não verificado: deploy, runner real contra `CARD_BUDGET_CAP` (coberto pelo classificador `is_budget_denial`, que decide o laço em `runner.py:4374`), carga/EXPLAIN do índice.
