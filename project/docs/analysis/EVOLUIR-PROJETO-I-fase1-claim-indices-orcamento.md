> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada — Fase 1', tarefas 1.1, 1.2 e 1.3: claim, unicidade e orçamento

Data: 2026-11-04 · Branch `evo/f1` (worktree `/home/ubuntu/workspace/current/zentriz/.worktrees/g-f1`, a partir da `dev`) · Plano [v2](../plans/EVOLUIR-PROJETO-BANCADA-plano.md) · Especificação: [H](EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md) · Defeitos: [F](EVOLUIR-PROJETO-F-fase0-reproducao.md) · Pré-checagem de produção: [E](EVOLUIR-PROJETO-E-fase0-precheck-producao.md).

Sem push, sem deploy, sem produção, sem LLM real. Tudo atrás da flag `EVOLVE_CLAIM` (`off` por padrão). Caminhos relativos a `applications/services/api-node/`.

## 1. Estado

| Item | Estado |
|---|---|
| 1.1 claim em duas etapas, lease, retomada, 200/201/409/422 | **validado** em Postgres real (45 testes novos); **não ligado** em nenhum ambiente |
| 1.2 cinco índices parciais por passo de boot em TS + 409 no `POST /api/specs` | **validado** em banco descartável; o `createProjectFromSpec` lança `VersionConflictError`, o mapeamento para 409 na rota (`routes/specs.ts:938`) foi **escrito mas não exercitado por teste de rota** |
| 1.3 orçamento herdado, Guard antes do claim, saldo livre mínimo | **validado**; o mínimo (US$ 5) é **conservador e `calibrado=falso`** |
| Flag por tenant | **preparado** (leitura por `readRuntimeNumber`, tenant do recurso primeiro); ligar por tenant é decisão da Fase 2 |
| Funcional em produção | **não**: flag `off`, nenhum deploy |

## 2. Mudanças (arquivo:linha)

- `src/services/evolveClaim.ts` (novo): `NS_EVOLVE=7341` (:37); `budgetPreflight` (:81); `findExisting` (:111); `respondExisting` (:154); `runEvolveWithClaim` (:173); `claim` (:299, transação curta: `BEGIN` → `SET LOCAL lock_timeout='5s'`/`statement_timeout='15s'` → `pg_advisory_xact_lock(7341, hashtext(raiz))` → idempotência → ticket `FOR UPDATE` → HEAD → guard "um filho vivo" → versão = HEAD+1 → `INSERT … 'materializing'` com `budget_owner_project_id` → `UPDATE tickets … WHERE status='open'` → `COMMIT`; conexão devolvida antes dos passos lentos); `takeOrRenewLease`/`releaseLease`/`markStep` (:420-450); `materialize` (:451, passos `spec_tree` → `code` → `ticket` → `triages` → `dialogue` → `finalize`); `failTerminal` (:584); `stepSpecTree` (:613, `ON CONFLICT … DO UPDATE` + arquivo temporário/`rename`); `stepCode` (:663, mesmo código do caminho histórico; cópia de `apps/` recomeça do zero na reexecução).
- `src/routes/projects.ts`: desvio para `runEvolveWithClaim` quando a flag está ligada (:3420, antes de qualquer outra coisa do handler); `INSERT` do filho do caminho histórico agora em `try/catch` que mapeia `23505` dos índices para 409 `EVOLUTION_IN_FLIGHT` (:3535-3566); `DELETE` recusa filho `materializing` com lease vigente, 409 `MATERIALIZING` (:3022). **Única linha histórica removida:** `const childRes = await client.query(` virou `let childRes; try { childRes = await client.query(`.
- `src/services/evolveFlags.ts` (novo): `evolveClaimEnabled` (env `on|off|1|0|true|false` vence; senão `genesis_runtime_config.EVOLVE_CLAIM` 0/1 via `readRuntimeNumber`, tenant do recurso primeiro, usuário como reserva; ausente/inválido/erro ⇒ off); `readEvolveMinFreeBudgetUsd`.
- `src/services/lineage.ts:54`: `resolveLineageHead` (maior versão `accepted`, sem `superseded_by`, **sem filho `accepted`** — fecha a janela F10).
- `src/services/evolutionUniqueness.ts` (novo): `UNIQUENESS_INDEXES` (U1–U5, DDL exato de H §3.1 + consulta de pré-checagem de cada um), `ensureEvolutionUniqueness`, contadores (`getUniquenessCounters`), `isVersionConflict`. Chamado em `src/index.ts:90-91` logo após `initDb()`, com `.catch` que só loga.
- `src/services/projectCreation.ts:24, 232`: `VersionConflictError`; o `INSERT` de `createProjectFromSpec` converte `23505` do índice de versão. `src/routes/specs.ts:9, 938`: rota devolve 409 `VERSION_CONFLICT`.
- Migrations: `src/db/migrations/141_projects_status_materializing.sql` (só o `CHECK` de `projects.status` + `'materializing'`, superconjunto da 097; sem `;` em literal, sem `DO`); `142_runtime_config_evolve_min_free_budget.sql` (semente `EVOLVE_MIN_FREE_BUDGET_USD='5'`, `WHERE NOT EXISTS`). **`card_draft` fica para a Fase 2** (H não pede agora). Nenhum índice em `.sql`.
- Testes/infra: `src/testing/evolvePg.ts` (aceita porta 55440; `createScratchDb`), `scripts/apply-migrations-test.ts` (porta 55440); `src/routes/projects.evolve.claim.pg.integration.test.ts` (novo, 45 testes); `src/services/evolutionUniqueness.pg.integration.test.ts` (novo, 8, em banco descartável); `src/services/evolveFlags.test.ts` (novo, 5); `src/routes/projects.evolve.repro.pg.integration.test.ts` (`it.fails` de (a) ×2, (b), (b') e (g) ×2 removidos; esses cenários agora rodam com `EVOLVE_CLAIM=on`; os de (d), (h), (f) seguem `it.fails`, são das tarefas 1.4 e 1.7).

Commits (todos com o rodapé `Co-Authored-By`): `e1e42bc` helpers de teste · `df200e6` flag, migrations 141/142, `resolveLineageHead` · `e17459a` índices de unicidade + 409 no `/api/specs` · `326054a` claim e orçamento · `7f92b76` retomada de pedido idêntico sem chave + teste do passo `code`.

## 3. Decisões e desvios de H

1. **Negativa do Guard = 402, não 422/409.** O padrão do produto para o gate de orçamento é o do `/run` (`routes/pipeline.ts:524-528`: 402 com o código do Guard). Usei 402 para `BUDGET_MISSING`, `BUDGET_PAUSED`, `BUDGET_INSUFFICIENT` e `BUDGET_FREE_BELOW_MIN`. H previa 422 `BUDGET_REQUIRED` (dono sem orçamento) e 409 `CARD_BUDGET_BLOCKED`; o segundo só existe com card (Fase 2).
2. **Com a flag ligada, a repetição devolve 200 `{replayed:true}`** também no `/evolve` "legado" (H reservava o 409 `TICKET_ALREADY_PROMOTED` ao legado com flag off). Com a flag off o 409 histórico é preservado (teste de regressão). `TICKET_ALREADY_PROMOTED` continua para ticket promovido sem filho vivo, `rejected` ou `delivered`.
3. **Códigos de 409:** pedido idêntico em corrida pelo mesmo ticket/chave ⇒ `MATERIALIZATION_IN_PROGRESS` + `Retry-After: 2`; pedido sem ticket/chave perdendo a corrida ⇒ `EVOLUTION_IN_FLIGHT` (código já conhecido pela UI); lock não obtido em 5 s ⇒ `EVOLUTION_BUSY` + `Retry-After`.
4. **Acréscimo a H (retomada sem chave):** pedido sem ticket e sem `Idempotency-Key` cujo claim venceu é retomado se o `sha256(pai|texto|modo)` for igual (`evolve_request_sha` agora gravado sempre). H exigia `DELETE` nesse caso (o guard (d) o recusava). Lease vigente ou pedido diferente continuam 409 `EVOLUTION_IN_FLIGHT`.
5. **Falha terminal só `HEAD_SPEC_UNREADABLE` e `HEAD_NOT_FOUND`** (422; filho `failed`; ticket `promoted → open` na mesma transação com o lock). `REPO_REQUIRED` é regra de card (Fase 2) e não foi implementada. Mudança de comportamento só com flag on: spec do HEAD com linhas no banco e zero arquivos legíveis falha (o legado criava o filho em `draft`).
6. **`recomputeProductLifecycle` no `finalize`** (H §1.3 S6 e §10 item 5, que é parte da 1.7) foi incluído no caminho novo; a correção do `/promote` e da Bancada (1.7) **não** foi feita.
7. **Erro recuperável** (exceção comum num passo) libera o lease e responde 500 `MATERIALIZATION_FAILED` com o `childProjectId`; a repetição retoma na hora. Só a morte do processo deixa o lease valer (até 10 min); o coletor de claim vencido é o reconciliador (1.8, fora).
8. **Índices sempre criados no boot, independentes da flag.** Consequência: com a flag `off` e os índices presentes, a corrida do `/evolve` histórico deixa de duplicar versão e a perdedora recebe 409 `EVOLUTION_IN_FLIGHT` (teste "rede de segurança"). É o efeito desejado de 1.2; só difere do histórico em corrida. Sem os índices (banco sujo) o catch nunca dispara.
9. **`EVOLVE_CLAIM` e `EVOLVE_MIN_FREE_BUDGET_USD` não entraram em `CONFIG_KEYS`** (`routes/runtimeConfig.ts`): hoje só se editam no banco/env. Entrar exigiria decidir antes o `adminOnly` de H §8/R2 (F17), porque `tenant_admin` poderia ligar a flag e zerar o mínimo do próprio tenant.
10. **Mínimo de saldo é inteiro em US$** (limitação de `readRuntimeNumber`), semente `5`, `0` desliga a regra extra, chave ausente/inválida ⇒ vale só a regra do Guard. Não há constante no código.
11. **Lease de 10 minutos fixo** (`LEASE_SECONDS`), `attempt` não incrementa. Confirmei o que H marcou `[não verificado]`: **`lock_timeout` interrompe a espera de advisory lock** (esperou 5004 ms e devolveu 409 `EVOLUTION_BUSY`).
12. Pré-checagem de orçamento usa o pai da URL como candidato a HEAD; se o HEAD for outro, o claim devolve `PARENT_SUPERSEDED` antes de qualquer insert.

## 4. Saídas reais dos testes

Ambiente: `pgvector/pgvector:pg16` em 55440 (e a mesma instância publicada também em 55432 só porque 4 suítes antigas têm a porta fixa), migrations 1→142 pelo mesmo `initDb`. Contêiner derrubado ao final.

```
ANTES  (dev, 140 migrations):  3528 passed + 25 (4 suítes fixas em 55432) = 3553 passed, 1 skipped · tsc limpo
DEPOIS (evo/f1, 142):          3590 passed + 25 (4 suítes fixas em 55432) = 3615 passed, 1 skipped · tsc limpo
```
(+62: 45 do claim, 8 de unicidade, 5 de flags, 4 de `migrations.test.ts` pelas duas migrations novas.) `pytest` do orquestrador **não foi executado**: nada em `applications/orchestrator/**` foi tocado.

Evidências (stdout real):
```
[F1-corrida-N8]   {"codes":[201,409,409,409,409,409,409,409],"filhos":[{"v":2,"status":"spec_submitted"}],"erros409":["EVOLUTION_IN_FLIGHT"]}
[F1-ticket-N5]    {"codes":[201,409,409,409,409],"codigos409":["MATERIALIZATION_IN_PROGRESS" ×4],"filhos":1,"ticket":"promoted"}
[F1-recusa-concorrente] {"patch":200,"evolve":409,"codigo":"TICKET_ALREADY_PROMOTED","ticket":"rejected","filhos":0}
[F1-ticket-x3]    {"codes":[201,200,200],"replayed":[false,true,true],"filhos":1}
[F1-idem-key]     {"a":201,"b":[200,true],"c":[422,"IDEMPOTENCY_KEY_REUSED"],"d":[409,"EVOLUTION_IN_FLIGHT"]}
[F1-crash-pontos] 19 pontos: before_commit, after_claim, {before, after_work, after_mark}:{spec_tree, code, ticket, triages, dialogue}, before_finalize, after_finalize
[F1-terminal]     {"status":422,"codigo":"HEAD_SPEC_UNREADABLE","filho":"failed","ticket":"open","child":null}
[F1-lock-timeout] {"status":409,"codigo":"EVOLUTION_BUSY","esperaMs":5004,"retryAfter":"2"}
[F1-orcamento-herda] {"status":201,"filho":{"budget_usd":null,"owner":"pai"},"preflightFilho":{"allow":true}}
[F1-guard-pausado]   {"status":402,"codigo":"BUDGET_PAUSED","filhos":0,"ticket":"open"}
[F1-saldo-minimo]    {"padrao":"5","orcamento":3,"status":402,"codigo":"BUDGET_FREE_BELOW_MIN","minFreeUsd":5}
[F1-code-disk-copy]  {"resumed":200,"codigo":"disk-copy","residuoRemovido":true}
[F1-indices-criados] {"primeira":{"created":5,"dirty":0},"segunda":{"created":0,"existing":5},"noBanco":5}
[F1-23505]           U1..U5 → 23505 com o nome do índice correspondente
[F1-boot-sujo]       {"threw":false,"dirty":[{"index":"uq_projects_parent_version_live","n":2}],"criados":[4 demais],"naoCriado":true,"contador":{"created":4,"dirty":1},"log":["evolution_uniqueness_dirty"]}
[F1-rede-seguranca-off] {"codes":[201,409,409,409],"codigos":["EVOLUTION_IN_FLIGHT" ×3],"filhos":1}
[F1-specs-corrida]   {"ok":1,"rejeitadas":["VersionConflictError"],"codigo":["VERSION_CONFLICT"]}
[F1-off-golden]      chaves do corpo = ok, childProjectId, parentProjectId, lineageRootId, versionNumber, workMode, evolutionSource, evolutionSourceError, inheritedFiles, title, message
[F1-off-corrida]     {"codes":[201,201,201,201],"filhos":4}   ← o defeito histórico segue presente com a flag off, como esperado
```

Cobertura dos testes pedidos: corrida N ⇒ 1 filho (N=8 com barreira no lock, N=8 sem barreira ×3, ticket N=5); repetição ⇒ 200 com o mesmo filho; crash simulado entre cada ponto (`SimulatedCrash` não é capturado pelo executor: lease e marcadores ficam como num processo morto; lease vigente ⇒ 409, lease vencido ⇒ retoma; ao final 1 filho, 3 arquivos de spec sem duplicar, 5 marcadores, `finalized_at`; única duplicação tolerada é a mensagem do diálogo no crash entre o `INSERT` e o marcador, como em H S5); ticket ×3 ⇒ 1 filho; orçamento (filho herda o dono, dono terminal em v3, Guard pausado/sem orçamento/saldo baixo ⇒ 402 sem filho, override de tenant libera, replay não é barrado); índices criados, `23505` por índice, `failed`/`archived` não bloqueiam, boot sujo sobe sem o índice e registra; `off` com corpo e `extra` idênticos ao histórico.

**Flake preexistente, não causado por esta frente:** `llm.reorder.pg.integration.test.ts` (teste do backfill 139) falhou 2 de ~7 execuções das 4 suítes fixas rodando em paralelo no mesmo banco (`expected 37 to equal 38` elementos) e passou nas demais; sozinho passou 4/4. Mexe em `tenant_llm_configs`, tabela que nenhuma mudança desta frente toca.

## 5. Riscos

- **R-flag-on:** com a flag ligada o `finalize` chama `recomputeProductLifecycle`; um crash entre o commit do `finalize` e essa chamada deixa o lifecycle do produto desatualizado até o próximo recálculo (cosmético, sem detecção automática ainda).
- **Passo `code` com repositório real não foi exercitado** (sem GitHub App/instalação no ambiente de teste): só o fallback `disk-copy` e a reexecução com resíduo. O código de `gitLinkProjectFolder`/`checkoutNewBranch` é o mesmo do histórico e H (F11) o considera reexecutável enquanto `materializing`. O branch remoto `evolution/vN` de uma tentativa `failed` colidindo no retry com o mesmo número segue `[não verificado]`.
- **Filho `materializing` visível aos 14 leitores por lista de negação (H F14):** continua a cargo da 2.1; hoje só existe com a flag on.
- **Saldo compartilhado (R1):** o mínimo reduz, mas não elimina, o risco de uma versão nova esgotar o saldo da versão em produção; o valor `5` não foi medido.
- **Crash de processo deixa o lease valendo até 10 min** (a repetição recebe 409 `MATERIALIZATION_IN_PROGRESS`); sem reconciliador (1.8) um filho `materializing` sem repetição fica parado.
- **Tabela `tickets` sem `card_state`** (Fase 2): a promoção usa só `tickets.status`.

## 6. O que ficou fora

1.4 (matriz de transições do ticket, `reopenTicketsOfChild`), 1.7 (status coerentes `/evolve` × `/promote`, Bancada), 1.8 (reconciliador `evolution_reconciler_findings` — o boot só loga/conta a duplicata), 2.x (`card_state`, `card_draft`, `adminOnly`, entrada em `CONFIG_KEYS`, ligar por tenant), erro de rota testado para `VERSION_CONFLICT` em `POST /api/specs` (só o serviço), anexos e runner Python (frente g-f2, não tocados), qualquer deploy ou ativação da flag.
