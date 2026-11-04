> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (U) — Correções da Fase 2, lote B (achados S-01, S-02, S-03, S-05, S-09, S-13, S-16)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `evo/j2` (a partir de `dev` em `e27f724`, que já contém a API de cards da 2.6) · **Origem dos achados:** relatório [S](EVOLUIR-PROJETO-S-revisao-adversarial-fase2-dados.md) · **Desenho/relatórios de base:** [H](EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md), [R](EVOLUIR-PROJETO-R-fase2-api-de-cards.md).
**Escopo:** só `applications/services/api-node`. Fora de escopo, por pertencer à frente g-j1: conversão de anexos, `db/init.ts`, `cardsBackfill.ts`, migrations. **Nenhuma migration nova.** Flags continuam `off` por padrão. Sem produção, push, deploy ou PII; o Guard não foi tocado.
**Convenção:** caminhos relativos a `applications/services/api-node/src/`.

---

## 1. Resultado por achado

| ID | Sev. | Correção | Teste (reprodução / regressão) | Estado |
|---|---|---|---|---|
| **S-01** | BLOQUEANTE | `routes/runtimeConfig.ts`: toda mudança de `CARDS_BANCADA` (PUT **e** DELETE do override) roda numa transação (`changeCardsFlag`): grava/remove a linha → backfill de `card_state`/`spec_origin` dos tenants que passam a ter a flag ligada → `findCardStatusDivergences`. Se houver divergência: `ROLLBACK` de tudo (flag + backfill) e **409 `CARD_DIVERGENCE`** com a lista (`ticketId, tenantId, cardState, status, expectedStatus`, até 20). Falha do backfill também reverte (500 `CARDS_BACKFILL_FAILED`). Desligar nunca é bloqueado. Serializado por `pg_advisory_xact_lock`. Extra: o PUT **global** deixou de duplicar a linha (ver §3, D5) | `routes/cardsFlagGuard.pg.integration.test.ts` (5 testes): os três cenários do revisor com a flag ligada sem divergência; flag off idêntica ao legado; recusa 409 com reversão; DELETE que religaria a flag; global recusado por tenant divergente | **Resolvido** |
| **S-02** | ALTA | Já tratado na 2.6 (`extra.card_ticket_id`). Confirmado e coberto: `findExisting`, o reconciliador (detector (a)) e `uq_projects_ticket_live` não colidem com o rascunho | `routes/cardDraft.ticketKeys.pg.integration.test.ts` (3 testes, banco com `initDb` + `ensureEvolutionUniqueness`): `/evolve` do ticket-card ⇒ 409 `USE_CARD_PROMOTE` (não 500); promoção 201 com rascunho vivo; replay = mesmo filho; índice ainda recusa duplicata real (23505); reconciliador sem achado do rascunho; ticket legado com rascunho órfão ⇒ 201 (com e sem `EVOLVE_CLAIM`) | **Confirmado / regressão coberta** |
| **S-03** | ALTA | `routes/products.ts` (`GET /api/products/:id`): `notHiddenProjectSql("p")` no CTE `topo` (nível 0, subconsulta de predecessores, nível N) e no `WHERE` final | `services/cardDraft.readers.pg.integration.test.ts`: novo teste da rota. **Falha sem a correção** (conferido por `git stash`) e passa com ela | **Resolvido** |
| **S-05** | MÉDIA | `routes/tickets.ts`: `hydrate` monta o DTO por **lista explícita** (16 colunas legadas); as 6 chaves de card só entram quando o ticket **é card** (`card_state` não nulo) **e** a flag está ligada para o tenant. `SELECT`/`RETURNING` da rota usam `TICKET_COLUMNS_SQL` (sem `*`) | `routes/cardsOff.regression.pg.integration.test.ts`: conjunto de chaves de POST, lista, detalhe e PATCH com flag off = contrato anterior; card com flag on traz as 6; ticket legado com flag on e card com flag off, não. Guarda estática nova contra `SELECT *`/`RETURNING *` sobre `tickets` nas rotas (exceto `routes/cards.ts`) | **Resolvido** |
| **S-09** | MÉDIA | `services/cardState.ts`: pré-condições do filho sob o lock do ticket. Novo resultado `precondition_failed` com `code` (`child_not_found`, `child_wrong_scope`, `child_dead`, `child_not_accepted`, `merge_unverified`, `child_active`, `child_changed`). Detalhe em §2 | `services/cardState.pg.integration.test.ts` (+4 testes S-09; matriz 8×8×4 mantida e verde) | **Resolvido**; merge real é da Fase 4 (parametrizado) |
| **S-13** | BAIXA | `withTx`: com `Pool`, `BEGIN/COMMIT` próprio; com cliente do chamador, **`SAVEPOINT`** (falha com 25P01 fora de transação). `blocked → blocked` com motivo diferente atualiza `blocked_reason` (só `system`/`guard`/`reconciler`; auditado; mesmo motivo = `noop`) | `cardState.pg.integration.test.ts`: cliente sem `BEGIN` é denunciado e nada é escrito; reblock atualiza o motivo e grava evento `blocked>blocked` | **Resolvido** |
| **S-16** | BAIXA | Guarda **por consulta**: `services/projectsReaders.inventory.test.ts` + `testing/sqlLiterals.ts` (tokenizador de literais). Chave de exceção `arquivo:hash` (sha1 do texto da consulta); sem exceção por arquivo, sem janela de linhas; exceção órfã ou redundante falha. `cardsOff`: regex de colunas ampliado (`executed_at`, `blocked_reason`, `external_ref`) e guarda de `SELECT *`. Dois leitores novos achados e corrigidos (ver §4) | `projectsReaders.inventory.test.ts` (6 testes). **Mutação:** com `products.ts` revertido a guarda falha em 2 testes | **Resolvido** |

---

## 2. Decisões

**D1 — S-01, forma da trava.** Em vez de só recusar com 409, a ligação roda *dentro da mesma transação* da gravação: o backfill vê a flag ainda não confirmada (mesmo cliente), a conferência de divergência acontece sobre o resultado do backfill e a recusa desfaz **tudo**. O tenant fica exatamente como estava (flag, `card_state` e eventos). Usei `backfillCardState`/`backfillSpecOrigin` diretamente (exportados) e não `runCardsFlagBackfill`, que abre transação própria por tenant e não enxerga a flag não confirmada; `cardsBackfill.ts` não foi editado (g-j1). Escopo da conferência: PUT/DELETE de **tenant** confere sempre aquele tenant; mudança do **padrão global** confere só os tenants que passam de desligado a ligado (não bloqueia por divergência de tenant que já estava ligado). Desligar nunca é bloqueado.

**D2 — S-09, pré-condições (todas no mesmo `UPDATE` transacional, sob `FOR UPDATE` do ticket):**
- `ready → promoted`: `childProjectId` existe, mesmo `tenant_id` e `product_id` do ticket, status diferente de `card_draft`, `failed` e `archived`.
- `blocked → in_factory`: o filho vinculado existe e está vivo.
- `in_factory → delivered`: filho `accepted`; **se o filho tem repositório** (`project_github_repos`), exige `args.mergeCheck(q, childId) === true`; sem `mergeCheck` recusa com `merge_unverified`. A verificação real de PR mergeado é da Fase 4 (tarefa 4.3): está parametrizada e documentada no cabeçalho de `cardState.ts`. Hoje ninguém chama essa aresta.
- `blocked → rejected`: filho vivo e **parado** é arquivado (CAS no status lido; `extra.card_rejected = {ticket_id, previous_status}`; `child_project_id` no evento) para não prender `EVOLUTION_IN_FLIGHT`. Filho **em execução** (`materializing`, `running`, `queued`, `cto_charter`, `pm_backlog`, `dev_qa`, `devops`, `pending_cyborg`) é recusado (`child_active`). Filho `failed`/`archived` fica intacto. Se o CAS do filho falha, o ticket também é desfeito (`TxAbort`).
- Os chamadores atuais (`evolveClaim`, reconciliador, `cardPromote`, `cards.ts`) já tratavam resultado diferente de `applied` como erro/409 e não precisaram mudar.

**D3 — S-09(c), aresta `ready → blocked`.** Decisão da 2.6 **confirmada**: não existe. Orçamento negado devolve 402 e o card segue `ready` (não há o que retomar). H §4.1 vale sobre H §6. Documentado no cabeçalho de `cardState.ts` e coberto por teste (4 atores ⇒ `invalid`).

**D4 — S-05, quando as chaves aparecem.** "Só para tenants com a flag" foi refinado para *ticket que é card* **e** flag ligada. Motivo: o teste da 2.6 "rotas antigas de ticket legado respondem igual com flag on ou off, byte a byte" continua verdadeiro; ticket legado em tenant com flag ligada não ganha chaves com `null`.

**D5 — PUT global duplicava a linha (achado novo, fora da lista S).** `genesis_runtime_config` tem `UNIQUE (key, tenant_id)` e `NULL` nunca conflita (a própria migration 131 já registra isso), então `ON CONFLICT` no PUT global **inseria uma linha nova a cada chamada**. Medido no teste: após 3 PUTs globais havia 3 linhas `tenant_id IS NULL`, e `resolveFlag` escolhia uma delas sem ordem definida (o teste S-01 do global falhou por isso). Correção mínima no PUT: para `tenant_id` nulo, `UPDATE … WHERE tenant_id IS NULL` (converge duplicatas antigas) e `INSERT` só se nada foi atualizado. Sem migration. Linhas duplicadas já existentes em produção continuam existindo até o próximo PUT global da chave.

**D6 — S-16, método.** Classes aceitas por consulta: (1) oculta o rascunho; (2) lista de permissão **sobre o status do próprio `projects`** (alias detectado, para um `status IN ('…')` de outra tabela não "limpar" a consulta; era uma falha da primeira versão da guarda, achada por mutação); (3) sem escopo (`product_id`/`tenant_id`/`created_by` não usados como filtro: busca por id, por pai, por run); (4) exceção por consulta com motivo. `WHERE` montado dinamicamente (`${where…}`) conta como escopado, porque foi exatamente assim que `routes/reports.ts` escapou do inventário.

---

## 3. Inventário por consulta (S §3 corrigido) — resultado

Extração por tokenizador de literais de `src/` (sem `migrations/` e sem testes): **260 literais** com `FROM|JOIN projects`. Destes, 20 usam `notHiddenProjectSql`/`HIDDEN_FROM_PRODUCT_STATUSES`; o restante é lista de permissão, sem escopo de produto/tenant/autor (busca por id, pai, run) ou está em **37 exceções por consulta** (`arquivo:hash` + motivo no teste). Conferência dos itens do S §3:

- **§3.2 (faltavam):** `routes/products.ts:961-1010` (S-03) **corrigido**; `uq_projects_ticket_live`, `findExisting` e detector (a) do reconciliador (S-02) **não colidem** (rascunho sem `ticket_id`), com teste; `findExisting` está na lista de exceções com esse motivo e a mudança do texto da consulta invalida a exceção.
- **Furos novos (não estavam em S §3):** `routes/reports.ts` (`GET /api/reports/type-compliance`, lista de projetos do tenant com `WHERE` dinâmico) — **corrigido** e testado; `routes/telegram.ts` `resolveProjectAny` (busca por prefixo de id no tenant) — filtrado por consistência.
- **§3.3 "devem contar o rascunho":** `dashboard.ts:313`, `tenantCostCap.ts:68/:113`, `costReconcile.ts:62`, `watchdog.ts:196`, `users.ts:246`, `products.ts:1739` (DELETE), `services/inbox.ts:154`, `routes/tenants.ts:141` (`projects_count` administrativo, reavaliar se virar métrica de plano) — mantidos fora do filtro, cada um com exceção própria.
- **§3.3 listas de permissão/por pai/por id:** confirmadas pela classificação automática; `products.ts:278` e `evolutionPromote.ts:66` (status via parâmetro) e `dashboard.ts:291` (`STATUS_IN_FACTORY`) têm exceção explícita porque a regex não vê a lista.
- **§3.4 Python:** não reexecutado nesta frente (S §3.4 já concluiu: nenhum SQL direto sobre `projects`).
- **Não verificado:** o portal (`genesis-web`) não foi lido; a correção da S-03 é no contrato da API.

---

## 4. Saídas reais

Ambiente: `pgvector/pgvector:pg16` efêmero em 55440 (desenvolvimento) e 55432 (suíte completa; instância própria, fresca, com as migrations aplicadas por `scripts/apply-migrations-test.ts`); containers removidos ao final.

```
[F2-B-tres-cenarios] {"divergencias":0,"estados":["rejected/rejected","open/draft","open/ready"]}      # PATCH rejected, /evolve legado (409 USE_CARD_PROMOTE), reopenTicketsOfChild
[F2-B-recusa]        {"status":409,"body":{"code":"CARD_DIVERGENCE","message":"CARDS_BANCADA não foi alterada: …",
                       "divergences":[{"ticketId":"5bcd5f46-…","cardState":"draft","status":"rejected","expectedStatus":"open","tenantId":"cebf7307-…"}]}}
[F2-B-delete-recusa] {"status":409,"divergencias":1}
[F2-B-S02]           {"legacy":409,"promote":201,"replay":200,"achadosDoRascunho":0}
[F2-S05]             chaves com a flag off: attachments, attachments_count, body, change_kind, child_project_id, code, created_at, created_by,
                       delivered_at, execution_status, execution_title, extra, id, number, product_id, project_id, promoted_at, status,
                       tenant_id, title, updated_at          (nenhuma das 6 chaves de card)
[F2-produto-detalhe] {"status":["accepted"]}                                                              # S-03: antes ["accepted","card_draft"]
```

Suíte completa (`PG_TEST_URL=…:55432 npx vitest run`, sempre em instância fresca):

| | Arquivos | Testes |
|---|---|---|
| Base `dev` (`e27f724`, worktree temporário, medido por mim) | 225 passaram | 3895 passaram, 1 pulado |
| `evo/j2` (HEAD) | **228 passaram** | **3917 passaram**, 1 pulado |

`npx tsc --noEmit`: sem erros (exit 0). Três arquivos de teste novos (`cardsFlagGuard`, `cardDraft.ticketKeys`, `projectsReaders.inventory`); +22 testes líquidos.

Reprodução invertida (as correções fazem falhar o que antes passava): S-03/reports — 2 testes vermelhos com `products.ts`/`reports.ts` revertidos; guarda por consulta — 2 vermelhos com `products.ts` revertido.

---

## 5. Pontos de atenção e pendências

- **Não resolvido nesta frente (fora do escopo definido):** S-04, S-14, S-15 (conversão/dependências), S-07 e S-08 (`db/init.ts`/migrations), S-06, S-11, S-12 (backfill e env da flag), S-10. Todos continuam abertos, na frente g-j1 ou no lote seguinte.
- **S-11 interage com a trava:** a corrida do backfill (PATCH concorrente no meio do CTE) agora seria *detectada* pela conferência de divergência (e reverteria a ligação), mas a causa só some quando `cardsBackfill.ts` ganhar o `AND t.status = <lido>` (g-j1).
- **S-06 (env):** `CARDS_BANCADA=1` por variável de ambiente continua ligando a flag sem passar pela trava. Recomendação: ignorar o env para essa chave ou rodar a mesma conferência no boot. Não alterei `featureFlags.ts` porque a decisão afeta o runbook de deploy.
- **Duplicatas de linha global em `genesis_runtime_config` (D5):** produção pode já ter linhas globais duplicadas de qualquer chave alterada pelo PUT; vale uma consulta de verificação antes de ligar flags por padrão global.
- **Merge de PR (S-09):** `mergeCheck` fica sem implementação até a 4.3; hoje a aresta `in_factory → delivered` não tem chamador.
- **Efeito de `blocked → rejected`:** passa a arquivar o filho parado. O portal ainda não mostra esse arquivamento; vale um aviso na UI da Fase 3.
