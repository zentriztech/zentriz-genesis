> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (K) — Fase 1': tarefas 1.4 (transições de ticket) e 1.7 (promoção do filho de evolução na Bancada)

**Data:** 2026-11-04 · **Branch:** `evo/f3` (worktree `.worktrees/g-f3`, a partir da `dev` com a merge da Fase 1' 1.1–1.3/1.5–1.6) · **Commits:** `226c8ca` (1.4), `4399f1c` (1.7 api), `70e54b7` (1.7 portal) · **Sem push, sem deploy, sem produção, Guard intocado.**
**Convenção:** caminhos relativos a `applications/services/api-node/src/` salvo indicação. Estado: **preparado e validado em Postgres efêmero (55440); não é funcional em produção** (flags `off`, nada implantado).

## 1. Mudanças

### 1.4 — flag `TICKET_TRANSITIONS` (`off` padrão)
| Arquivo | O que mudou |
|---|---|
| `services/ticketTransitions.ts` (novo) | flag (env → `genesis_runtime_config` por tenant → `off`), tabela de transições por ator, `applyTicketTransition` (CAS `UPDATE … WHERE status = <esperado>`), `recordTicketEvent` |
| `db/migrations/144_ticket_events.sql` (nova, aditiva; última era 143) | tabela `ticket_events` (ticket, de→para, `actor_kind`, `actor_id` UUID, `reason`, `child_project_id`); sem `DO $$`, sem `;` em literais/comentários |
| `routes/tickets.ts:294-372` | PATCH com a flag `on`: transição inválida ⇒ 409 `TICKET_INVALID_TRANSITION {from,to,allowed}`; repetição da mesma transição ⇒ 200 sem efeito nem evento; CAS e evento na mesma transação; edição de conteúdo + status no mesmo `UPDATE`. Com `off` o caminho antigo segue intacto |
| `services/tickets.ts:310` | `reopenTicketsOfChild(db, child, {strict, reason})`: `strict` reabre **somente** `promoted` e audita; sem `strict`, SQL histórico idêntico |
| `routes/projects.ts` (DELETE/arquivar do filho) | resolve a flag e passa `strict`/`reason` (`child_archived`/`child_deleted`) |
| `services/evolveClaim.ts:420, :622` (único toque, 2 blocos pequenos) | eventos `open→promoted` (claim) e `promoted→open` (falha terminal) quando a flag está `on` |

Tabela (legado `tickets.status`): `open→promoted` (sistema), `open→rejected` (humano), `promoted→delivered|rejected` (humano), `promoted→open` (**só** sistema), `rejected→open` (humano, só sem filho vinculado), `delivered` terminal. `open→delivered` e `rejected→delivered` não existem (mantêm o código histórico `NOT_PROMOTED` quando não há filho).

### 1.7 — flag `EVOLUTION_PROMOTE_BANCADA` (`off` padrão)
| Arquivo | O que mudou |
|---|---|
| `services/evolutionPromote.ts` (novo) | flag, `listPromotableEvolutionChildren` (`extra.evolution='true'`, status `draft|spec_submitted`) |
| `services/promotability.ts:305-390` | `assessEvolutionReadiness` (RFC → connect.yaml/validação → orçamento), `decideEvolutionPromotability`, `evaluateEvolutionProductPromotability` (usada por `evaluateProductPromotability`), `isEvolutionPromotable`; novas razões `EVOLUTION_RFC`/`BUDGET_BLOCKED`; campo `evolution:true` só no veredito de evolução |
| `services/evolutionGate.ts:183` | `evaluateEvolutionGate(..., {readOnly})`: mesmo gate, sem gravar o carimbo (veredito de tela não escreve). O gate de RFC segue **único** |
| `routes/pipeline.ts:143-260` | `POST /api/projects/:id/promote` aceita `spec_submitted` (e `draft`) para evolução; sem trava de normalização; prontidão de evolução; `UPDATE … status IN ('draft','spec_submitted') RETURNING` com tratamento de `rowCount` 0 (idempotente/409, D-L6). `GET /api/projects/:id/normalized` devolve o veredito de evolução |
| `routes/products.ts:1330-1375` | `POST /api/products/:id/promote` com produto fora de `draft`: se há filho de evolução promovível, avalia todos os gates e promove numa transação; senão o 409 `NOT_ON_WORKBENCH` histórico |
| `routes/specs.ts` (listagem) | "Minhas SPECs" devolve o veredito de evolução para filhos de evolução |
| `routes/projects.ts:3751` | `/evolve` legado (claim `off`) passa a recomputar o lifecycle quando a flag está `on` |
| portal `lib/factoryJourney.ts`, `lib/factoryActions.ts`, `app/(dashboard)/spec/page.tsx` | jornada **RFC → Validar → Revisar GAPs → Promover** (sem Normalizar) quando `evolution:true`; `/spec` promove o projeto, não o produto inteiro |

### Estado agregado do produto (defeito extra)
Evidência medida (legado, flag `off`): `lifecycleAposEvolve = "accepted"` e `lifecycleAposRecompute = "partially_accepted"`. Causa: o `/evolve` legado nunca chamava `recomputeProductLifecycle` (o claim de 1.1 já chamava no finalize). Correto por `productLifecycle.ts`: `deriveProductLifecycle(['accepted','spec_submitted'])` ⇒ `partially_accepted` (há `accepted` e há projeto em `IN_PROGRESS`); após promover (`accepted`+`promoted`) continua `partially_accepted`. Decisão: o agregado correto é `partially_accepted`; corrigido atrás da flag com recompute no legado; testado nos dois caminhos.

## 2. Desvios de H
1. **Auditoria**: tabela `ticket_events` (144) em vez de `ticket_card_events` de H §4.2 (que é da 2.1/`card_state`); colunas equivalentes. A 2.1 pode estendê-la ou migrar.
2. **`rejected→open` só sem filho vinculado** (H não detalha): evita ticket `open` com `child_project_id` preenchido (violaria o inverso de U5/D-L1).
3. **Evolução promove sem plano de ordem (LLM)**: `POST /api/products/:id/promote` para evolução não grava `product_promotions`; cada evolução é incremento independente de serviço aceito. Se houver evolução em vários serviços do mesmo produto, a ordem entre elas não é decidida (limitação).
4. **Orçamento no `/promote` de evolução** (H §10.3 manda; o `/promote` histórico não tem): com o claim `off` o filho nasce sem orçamento ⇒ `BUDGET_BLOCKED` (`BUDGET_MISSING`), coerente com o Guard no dispatch, mas é uma barreira nova para o legado com a flag `on`.
5. H manda o portal chamar o `/promote` do projeto: feito em `/spec`; o `POST /api/products/:id/promote` também aceita evolução (exigido pelo teste (h)).

## 3. Saídas reais
Postgres efêmero `pgvector/pgvector:pg16` em `55440`, migrations aplicadas até `144_ticket_events`.
- Baseline (dev, antes): `207 arquivos`; **203 passaram, 4 falharam**, 3613 testes passaram, 26 pulados. As 4 falhas são `llm.reorder`, `llm.role-verify`, `costSource`, `skillFeedback`: elas **exigem `localhost:55432`** (porta ocupada pelo container `g4-pg` de outra frente), então falham na 55440 por design do helper. Não executei contra a 55432 para não tocar o banco da outra frente. A contagem "207/3638/1 pulado" da instrução vale para a 55432.
- Depois: `209 arquivos`; **205 passaram, 4 falharam (as mesmas 4)**; **3653 testes passaram, 26 pulados** (+40: 26 de `tickets.transitions`, 12 de `projects.evolve.promote`, 2 puros). `tsc --noEmit` limpo.
- `it.fails` (d), (f) ×5, (h) ×2 removidos: `projects.evolve.repro.pg.integration.test.ts` 26/26 verdes. O restante desse arquivo não foi alterado.
- `off` byte-idêntico: blocos "flag OFF" nos dois testes novos (PATCH permissivo sem evento; `reopenTicketsOfChild` histórico reabre `delivered`; DELETE do filho reabre `delivered`; `/promote` e `/products/:id/promote` ⇒ 409 `NOT_ON_WORKBENCH`; veredito sem o campo `evolution`; agregado `accepted`) + `tickets.test.ts` unitário intacto.
- Matriz exaustiva 4×3 do PATCH, corrida `rejected × delivered` (exatamente 1 vence, 1 evento), 6 `/promote` simultâneos (1 transição, 6×200), flag por tenant (outro tenant não afetado), gates preservados (RFC ausente/inválido, `connect.yaml`, orçamento), projeto não-evolução continua `NOT_NORMALIZED`/`NOT_ON_WORKBENCH`.
- Portal: `lib/factoryJourney.test.ts` 9/9 (rodado com o vitest do api-node e config mínima em `/tmp`, porque `genesis-web` não tem `vitest` instalado no checkout); `tsc` do portal sem erros nos arquivos tocados.
- Observação: o aviso "client.query() when already executing" vem de `specEnrichment.ts:197` (pré-existente). `evolutionUniqueness.pg.integration.test.ts` emite "Unhandled Errors" intermitentes (`57P01`, `DROP DATABASE … FORCE` com cliente ocioso) **também na árvore sem minhas mudanças** (verificado com `git stash`); é flake pré-existente do teste da 1.2.

## 4. Riscos
- Flags por tenant não estão em `CONFIG_KEYS` (ninguém liga pela UI); ligar é decisão de rollout. `TICKET_TRANSITIONS=on` muda contratos do PATCH (novos 409) que o portal atual pode não tratar com mensagem própria.
- Custo de leitura: `evaluateProductPromotability` ganha 1–2 consultas de configuração por produto fora de `draft` na listagem (nenhuma com env definida); medir antes de ligar em escala.
- A promoção do produto para evolução não passa pelo agente de ordem (desvio 3).
- `promoted→open` do sistema só reabre `promoted`: tickets `delivered` cujo filho é descartado ficam `delivered` apontando para filho apagado (intencional, D-A3; a FK do filho hoje não tem cascade, vale a conferência do reconciliador g-f4).

## 5. Fora do escopo / pendências
`card_state` e `ticket_card_events` (2.1/2.4); aceite automático `delivered` (4.3); PR/branch do filho e `/run` real do filho promovido (não exercitado: o runner não participa dos testes); ordem de promoção entre várias evoluções; chamada do portal ao PATCH de ticket com mensagens para `TICKET_INVALID_TRANSITION`; reconciliador (g-f4).
