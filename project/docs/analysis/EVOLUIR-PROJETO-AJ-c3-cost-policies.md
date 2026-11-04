> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# C3' — `cost_policies` versionada, lida pelo Guard (branch `evo/c3`, base `ec5ca7c`)

Desenho: `zentriz-autonomy-suite/evolution/27-desenho-controle-de-gasto.md` §3.4 e §4 (linha C3'). Aceite: **alterar a linha muda o comportamento da próxima chamada**.

## O que foi entregue
- **Migration `161_cost_policies.sql`** (próximo número livre; a última era `160`): tabelas `cost_policies` (escopo `global`/`tenant`, `policy_key`, `pct`, `base`, `floor_usd`, `abs_cap_usd`, `value_usd`, `calibrated` default `false`, `calibrated_at`, `source`, `version`, `author`) e `cost_policy_history` (antes/depois por versão, ação `create|update|delete`, autor). CHECKs no banco: `pct` 1–100; piso, teto e valor > 0. Sem transação, sem `DO $$`, idempotente (`IF NOT EXISTS`).
- **Serviço `services/costPolicies.ts`**: validação, upsert e exclusão **atômicos** (linha + histórico numa única instrução), versão monotônica por (escopo, chave) inclusive após exclusão/recriação, leitura efetiva (tenant vence global), `advisorPolicyView`, `breakerOverrides`.
- **Rotas `routes/costPolicies.ts`** (registradas em `app.ts`): `GET /api/cost-policies`, `GET /api/cost-policies/history`, `PUT` e `DELETE /api/cost-policies`. Cada escrita grava também `llm_guard_events` (`cost_policy_changed|deleted`).
- **Guard (`services/llmGuard.ts`) lê da tabela**, sem cache, a cada chamada:
  - `advisor_pct`: `preflight` (decisão `allow`) e `budgetSummary` expõem `advisorPolicy` = {pct, baseUsd (orçamento total do projeto-dono), capUsd = pct % da base limitado por `abs_cap_usd`, piso, calibrado, versão, escopo}. **Só exposição**: a aplicação do teto do Advisor é a C4' (não implementada).
  - `breaker_hour_usd` / `breaker_day_usd`: quando existe linha global, vence `llm_guard_settings`/env no disjuntor.
- **Sem política, nada muda**: o campo `advisorPolicy` nem aparece; `BUDGET_MISSING`, kill switch, pausa, cota diária etc. intactos. Falha ao ler a política (ex.: tabela ausente) nunca nega nem endurece a chamada: volta ao comportamento anterior.

## Regras
- Validação: `advisor_pct` 1–100; piso, teto absoluto e disjuntor **0 recusado** (API e banco); piso ≤ teto; disjuntor só escopo global; escopo tenant exige UUID.
- Autorização de escrita: pessoa apenas. Token de serviço (`user.svc`) é negado (como o PUT de orçamento). `zentriz_admin`: qualquer política e único que pode marcar `calibrated`. `tenant_admin`: apenas `advisor_pct` do próprio tenant, sempre `calibrated=false`. `user` comum: negado. Leitura isolada por tenant.
- Percentuais iniciais são conservadores e `calibrated=false`; nenhum dólar fixo em código.

## Testes
`src/routes/costPolicies.pg.integration.test.ts` (6 testes, Postgres real): sem política = comportamento antigo; CRUD + versionamento + histórico + auditoria; validação (percentuais, zeros, escopo, CHECKs do banco); autorização (serviço, tenant_admin, user, isolamento entre tenants); **aceite** (mudar a linha muda `preflight`/`budgetSummary` na chamada seguinte, teto absoluto, tenant vence global, exclusão volta ao antigo); disjuntor por política e `BUDGET_MISSING` preservado. Sem a mudança em `llmGuard.ts`, o teste de aceite e o do disjuntor **falham** (verificado).

## Pendências / fora de escopo
- **C4'**: aplicar o teto do Advisor (`advisor_denied_no_base`, snapshot, unificar a reserva em memória); `ADVISOR_MAX_USD_PER_RUN` (orchestrator, `llm_roles.py:304`) permanece até lá.
- **C7**: UI. A rota PUT existente de `/api/admin/llm-guard/settings` ainda aceita `0` nos tetos globais (comportamento antigo preservado); a recusa de 0 vale para as políticas `breaker_*`. Unificar é decisão do Jean.
- `before_state` do histórico vem do último `after_state` registrado (sem `FOR UPDATE`): sob escritas simultâneas na mesma chave pode repetir o antes. A versão é sempre correta (lock da linha).
- Piso "calculado" (tokens típicos × preços) do Advisor e recusa de orçamento abaixo do piso são C4'. Calibração por quantis do ledger: não implementada.
