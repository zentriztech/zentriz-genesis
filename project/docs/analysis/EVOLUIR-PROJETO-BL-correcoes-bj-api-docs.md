> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO BL — Correções do parecer BJ (api-node, docs e runbooks)

Data: 2026-11-05 · Branch `evo/x2` · Base: [BJ](EVOLUIR-PROJETO-BJ-parecer-final-atualizado.md). Escopo: `applications/services/api-node/**` e `project/docs/**`. Sem push; nada tocado em orchestrator, scripts, checkout principal, containers do dev ou GitHub.

## Correções de código (cada uma com teste em Postgres real que falha sem ela)

| Id | Correção | Onde |
|---|---|---|
| A-N2 | O `/run` usa o `tenant_id` do **projeto** (não o de quem disparou) para o token de run, o slot de LLM e o claim de concorrência; token leva `tenantId` e `projectId` do projeto | `src/routes/pipeline.ts` (SELECT do projeto inclui `tenant_id`; `const tenantId = project.tenant_id ?? user.tenantId`; `tenantId: tenantId \|\| null` no `signToken`) |
| W5 | `POST /api/internal/cyborg-token` recusa (403) qualquer token com `svc`, seja qual for a role — antes só recusava role ≠ zentriz_admin, e o token de run de um `zentriz_admin` (`svc:"runner"` + role admin) cunhava tokens de qualquer projeto/tenant e renovava o próprio TTL | `src/routes/internalLlm.ts` (guarda do cyborg-token) |
| W5 | `POST /api/admin/zentriz-llm-config` recusa (401) token `svc` (M-N4 do BJ) | `src/routes/internalLlm.ts` |

Outras rotas que emitem token foram varridas (`signToken`/`signTokenWithExpiry`/`jwt.sign`): `auth.ts` (login), `telegram.ts` (2 min, usuário já autenticado por código), `watchdog.ts`/`runnerDispatch.ts` (já usam o tenant do projeto), `signDeployCallbackToken` (escopado a deployment). Só o `cyborg-token` cunha token de projeto a partir de entrada do chamador. Não existe `executor_bridge` no api-node (ele está no orchestrator, frente evo/x1).

Teste: `src/routes/runnerTokenTenant.pg.integration.test.ts` (5 casos, servidor HTTP local como runner, kill switch do Guard desligado no banco descartável):
1. A-N2: `zentriz_admin` do tenant A roda projeto do tenant B; o token entregue ao runner tem `tenantId=B` e `projectId=B`, e o Guard autoriza (`allow:true`).
2. `tenant_admin` de A consultando o projeto de B no Guard continua com 404 `PROJECT_NOT_FOUND`.
3. W5: o token de run do admin não cunha cyborg-token (cross-tenant, outro projeto e o próprio): 403.
4. W5: o token de run não altera `zentriz-llm-config` (401), o `zentriz_admin` humano sim (200).
5. Caminhos legítimos seguem: token estático e `zentriz_admin` sem `svc` cunham (200, token `svc:runner` com tenant/projeto do projeto, role rebaixada); o token cunhado não cunha de novo (403).

**Mutação** (reverter `pipeline.ts`/`internalLlm.ts`): sem A-N2 falha o caso 1 (`tenantId` = tenant de A); sem W5-cyborg falha o caso 3 (200 em vez de 403); sem W5-llm-config falha o caso 4 (200 em vez de 401). Os casos 2 e 5 são controles e passam nos dois estados.

## Documentos

- `project/docs/runbooks/CARDS-BANCADA-ROLLOUT.md`: C10 (card nasce com `budget_usd=0`, 201, e só para no refino com `402 BUDGET_PAUSED`); Z1 **Feito** (A-1); Z3–Z9 reverificados contra o BJ (Z6 não atendido, 0/10 e n=1; Z7 parcial; Z4 parcial; Z5 feito no dev; Z9 agravado por B-N1); §10.3 item 1 (`bce3f50` já está em `origin/dev`; push/CI já aconteceram); §5.4 ordem de rollback única (inversa do deploy, api por último); nota no §7.3 sobre a contradição com §7.4; **novas §10.6** (condições para promover o código com cards desligados: `CYBORG_TREE_GATE=off`, `tenant_max_usd_per_hour` explícito, `EFFECTIVE_FLAGS_FAIL_CLOSED=off`, dump novo, teste de rollback, ordem de deploy) e **§10.7** (condições para ligar na ZFactory: decisões J1–J6 do Jean, trabalho W1–W6, riscos aceitos R1–R4).
- `project/docs/runbooks/CARDS-BANCADA-RUNBOOK.md`: §7 ordem única de rollback e teste de rollback obrigatório; §8 item 6 e tabela §11 (402 × 409 `BUDGET_MISSING`); nova §11.5 (D-18: FTS do dev não recebe `GENESIS_API_TOKEN`; filho de card não usa a ponte do engenheiro, implementado pela evo/x1).

## Verificação

Postgres efêmero (`pgvector/pgvector:pg16`, portas 55440 e 55432), derrubado ao final.
- `npx tsc --noEmit`: exit 0.
- vitest (55440, excluindo as 4 suítes de porta fixa): **255 arquivos, 4172 passaram, 1 skip, 0 falhas** (inclui os 5 casos novos).
- 4 suítes de porta fixa (55432): **7 arquivos, 69 passaram**. Em paralelo uma vez falhou o caso de backfill da migration 139 do `llm.reorder` (as suítes compartilham o banco da porta fixa); com `--no-file-parallelism` passam 69/69, e `llm.reorder` isolado passa.

## Riscos e pendências

- O Guard (`checkTenantBudget` do cap mensal e o rate limit do `/run`) continua usando o tenant de quem disparou; só o token, o slot de LLM e o claim de slot passaram ao tenant do projeto. Para `zentriz_admin` o cap mensal do tenant do projeto não é checado no `/run` (comportamento anterior).
- O token de run ainda copia a role do dono (zentriz_admin continua poderoso se vazar, 24 h); agora ele não cunha mais tokens nem altera a config global, mas rebaixar a role do token de run é decisão separada.
- W1–W3 (fail-closed do build remoto, ponte do engenheiro, aceite com `build_rc=-1`/erro de tsc novo) pertencem à evo/x1; o runbook §11.5 só documenta.
- Os itens de §10.6 e §10.7 marcados como decisão do Jean ou operação (SSH, PEM, backup, Host B, teste de rollback, dump) não foram executados.
