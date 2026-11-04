> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AB — Reverificação adversarial da Fase 3 após as correções L1 (backend) e L2 (portal/contrato/E2E)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis`, `dev` @ `1511930` (merge de `evo/l1` + `evo/l2`) · **Leitura:** worktree `~/workspace/current/zentriz/.worktrees/g-chk3` · **Intervalo revisado:** `git diff bd56caf..1511930` (162 arquivos, +6053/−282) · **Papel:** Advisor, revisor adversarial independente. Só leitura de código; o único arquivo gravado é este relatório (sem commit). Sem produção, sem banco do stack de dev, sem push.
**Insumos:** relatório Y (achados), relatórios Z e AA (correções, **não aceitos sem conferência**), plano `project/docs/plans/EVOLUIR-PROJETO-BANCADA-plano.md` (D-E1..D-E10). Caminhos do backend relativos a `applications/services/api-node/src/`; do portal, a `applications/apps/genesis-web/`.

## 1. Veredito

**APROVADO COM CORREÇÕES.** Não há mais bloqueante. Conferi no código os 23 achados de Y: o bloqueante Y-01 e as cinco altas (Y-02 a Y-06) estão corrigidos, e cada um tem teste que reproduz a sonda original. A jornada card → RFC → validar → promover está provada pela UI e contra o `api-node` real (E2E-real da L2).

Ficam condições **antes de ligar `CARDS_BANCADA` num tenant real e antes da Fase 4**:

1. **AB-01 (ALTA, novo).** O planner de RFC assíncrono ainda escreve no rascunho depois do `ready` e até depois da promoção. Ele não reconfere a trava, e o passo `card_spec` copia o rascunho sem conferir o hash do carimbo. O filho pode receber RFC/ADR que ninguém validou.
2. **Ratificação do Jean da matriz de papéis** (Y-06/AB-03). Hoje o `zentriz_admin` promove e cria versão como autor, o que contradiz a RFC-0002 A.1.
3. Correções médias: AB-02 (Y-10 parcial), AB-04 (contrato dos códigos novos sem fixture), AB-05 (Y-08 parcial no portal) e AB-06 (`ready` preso por conversão "queued" sem fila).

| Severidade | Novos (AB) |
|---|---|
| BLOQUEANTE | 0 |
| ALTA | 1 |
| MÉDIA | 5 |
| BAIXA | 4 |
| **Total** | **10** |

## 2. Achados de Y × estado no código

Legenda: **Corrigido**: a correção existe no código e há teste que falharia sem ela, por desenho (reproduz a sonda de Y). **Parcial**: a correção existe, mas fica um caminho aberto. **Não corrigido**: não há correção.

| Y | Sev. Y | Estado | Evidência (arquivo:linha) | Teste |
|---|---|---|---|---|
| Y-01 | BLOQ. | **Corrigido** | `services/cardService.ts:385-476`: leitura única `computeCurrentSpecHash` (:396), gate sobre `snap.files` (:398-400), transação com `FOR UPDATE` do ticket e releitura do hash e dos anexos (:427-435), carimbo + `→ready` + `stalled` dos runs (:436-452), conferência pós-COMMIT (:463-474). `services/evolutionGate.ts` (`PreloadedSpecFile`, gate sem reler o disco). Promoção: `services/evolveClaim.ts:371-403` (`verifyCardStampUnderLock`: hash, anexos, gate e colisão sobre a mesma leitura, sob advisory lock + `FOR UPDATE`), chamada em `:451-458`; volta a `refining` por `revertToRefining`, removido do corpo antes de ir ao cliente (`services/cardPromote.ts:115-120`) | `routes/cards.fase3.correcoes.pg.integration.test.ts`: 50× corrida `ready × DELETE RFC`; ganchos determinísticos `cardReadyTestHooks` (janela exata da sonda P4); carimbo forjado ⇒ 409, nenhum filho. **Rodado: verde.** Resíduo de outro escritor: AB-01 |
| Y-02 | ALTA | **Corrigido** | Escrita: `services/cardSpecGuard.ts:200-225` (`findBaseCollision`, sem diferenciar caixa, :147-160). `ready`: `cardService.ts:404-409`. Claim: `evolveClaim.ts:395-401`. Defesa final no passo: `evolveClaim.ts:961-973` (`TerminalFailure CARD_PATH_COLLIDES_WITH_BASE`) | `Y-02 (P6)`: escrita 409, `ready` 409, promoção 201 e **árvore do filho** igual ao HEAD byte a byte (`[Z-P6] adrFilhoIntacto:true`) |
| Y-03 | ALTA | **Corrigido** (ver AB-05) | `components/cards/CardSpecTab.tsx` passa a usar `spec-tree`, mostra `tickets/TK/**` só para leitura, `docs/rfc/**` e `docs/adr/**`; botões do planner e do modelo (:167-186); validação no cliente `lib/cards/specApi.ts:13-28` (espelho de `cardWritableRoots`); rotas de spec no contrato: `routes/cards.contract.spec.pg.integration.test.ts` + 29 fixtures `lib/cards/__contract__/spec/` | Portal 299/299; `cards.contract.spec…` (modo comparação) **verde depois do merge**: o backend L1 produz as mesmas fixtures |
| Y-04 | ALTA | **Corrigido** | `lib/uuid.ts` (`toCanonicalUuid`, hook `INVALID_ID`); `cardSpecGuard.ts:60-80` (canonicaliza, `WHERE p.id = $1::uuid`, devolve o id do banco). Hook registrado (plugins encapsulados) em `projects`, `specFiles`, `specChat`, `specAutonomy`, `evolutionPlan`, `pipeline`, `specSplit`, `connectDeclaration` | `Y-04 (P1)`: 3 formas × 8 escritores = 24 respostas 400; maiúsculas ⇒ 409 da trava; guarda com texto cru resolve a linha |
| Y-05 | ALTA | **Corrigido** | `routes/projects.ts` DELETE (os dois modos) ⇒ 409 `USE_CARD_DELETE` (bloco após o `canAccessProjectRow`, ~:3028-3039); `PATCH status` ⇒ 409 (~:366-369); `routes/pipeline.ts:887-890` (`stop`) | `Y-05 (P2)`: 8 estados × 4 portas = 32 respostas 409 |
| Y-06 | ALTA | **Corrigido no código; decisão pendente** | `routes/cards.ts:68-85` (`OPERATOR_ROLES`, `denyOperate`), aplicado em promote, reject, resume, revalidate, reopen e delete | `Y-06`: 6 ações negadas a `user` não autor; autor opera; outro `tenant_admin` promove 201. Ver AB-03 (o `zentriz_admin` promove; a matriz não foi decidida pelo Jean) |
| Y-07 | MÉDIA | **Corrigido** (ver AB-06) | `services/cardAttachments.ts:93-113` (`cardAttachmentsSnapshot`); `ready` recusa conversão aberta (`cardService.ts:392-393`); `attachments_hash` no carimbo e conferido no claim (`evolveClaim.ts:384-387`); `syncCardAfterConversion` (`cardService.ts:486-505`) acionado pela fila (`attachmentConversionQueue.ts:190-221`) | `Y-07` (2 testes) |
| Y-08 | MÉDIA | **Parcial** | Planner: `services/evolutionPlanner.ts:164-171` (HEAD + rascunho), `:347-360` (`nextRfcNumber`), `:465-476` (`upsertCardAware`). **Aberto:** a sugestão de caminho do portal e a escrita manual (AB-05) | `Y-08` |
| Y-09 | MÉDIA | **Corrigido** | `routes/runtimeConfig.ts:58-61` (`adminOnly`, máximo 200 000); `cardSpecGuard.ts:37-38`, `:318` | `Y-09`: 403 `ADMIN_ONLY_KEY`; legado de 400 000 ignorado (log `IGNORADO` visto na execução) |
| Y-10 | MÉDIA | **Parcial** | Portal: `lib/cards/capabilitiesCache.ts` (sem cachear falha), `components/cards/EvolveButton.tsx`. Backend: `routes/projects.ts:3482-3489` (409 `USE_CARDS` **só sem `ticketId`**). Aberto: AB-02 | `useCardsEnabled.test`, `EvolveButton.test`, `Y-10` (api) |
| Y-11 | MÉDIA | **Parcial** | `lib/cards/schemas.ts:177-207`: schema estrito por código para os 26 códigos que já existiam. Os códigos novos da L1 ficaram com o schema básico ou sem schema e sem fixture (AB-04) | `contract.test.ts` |
| Y-12 | MÉDIA | **Corrigido** | `e2e/cards.spec.ts` (harness por tela, tema e 320 px, com axe-core); `project/docs/analysis/img-aa/axe-*.json`: **0 violações nas 14 execuções** (somei `violacoes` dos JSON) | Não reexecutei o Playwright (ver AB-10) |
| Y-13 | MÉDIA | **Corrigido** (ver AB-07) | `services/cardRevalidate.ts` (`git ls-tree` só com SHA hexadecimal, `execFile` sem shell, `globsUnverified`); `cardJourney.ts:135-139`, `:157-159`; persistência em `cardService.ts:586-598` | `Y-13` (2 testes, com repositório git real em `/tmp`) |
| Y-14 | MÉDIA | **Corrigido** | `routes/llmGuard.ts:28-45`, `:89`, `:102` (`scheduleCardSync`, throttle de 15 s); o GET da jornada continua escrevendo (documentado) | `Y-14` |
| Y-15 | MÉDIA | **Corrigido, com limites** | Sondas P1, P2, P4, P5 e P6 viraram testes (23 em `cards.fase3.correcoes…`); E2E-real em `e2e-real/cards-real.spec.ts` + `scripts/e2e-real/serve.ts` (bind em 127.0.0.1, recusa banco fora de 55432/55440/55441). Limites: LLM é stub; o E2E roda só como `tenant_admin` (a matriz de papéis não é exercitada de ponta a ponta) | Não reexecutei o E2E-real depois do merge (AB-10) |
| Y-16 | BAIXA | **Corrigido** | `routes/cards.ts` (`productGuard` com `isCanonicalUuid`; `attachmentId` ~:540); `cardService.ts:66` | `Y-16`: 5 URLs ⇒ 404 sem `22P02` |
| Y-17 | BAIXA | **Corrigido** | `evolveClaim.ts:266-271` (pré-checagem) e `:425-429` (sob lock) ⇒ `CARD_NOT_READY` com o estado real | `Y-17 (P5)`: `{"CARD_NOT_READY":6}` |
| Y-18 | BAIXA | **Corrigido** | `lib/cards/safeUrl.ts` (só `https://`); usado em `CardTile.tsx:19`, `CardStatusPanel.tsx:82`, `PromotePanel.tsx:54` | `specApi.test`, `PromotePanel.test` |
| Y-19 | BAIXA | **Corrigido** | `stores/authStore.ts` chama `resetCardsCapabilitiesCache()` no logout; o cache por tenant tem época contra consultas em voo | `useCardsEnabled.test` |
| Y-20 | BAIXA | **Corrigido** | `CardDetailView.tsx`, `CardJourneyTab.tsx` (aviso, spinner, `eventReasonLabel`) | `CardDetailView.test` (3) |
| Y-21 | BAIXA | **Corrigido** | `routes/cards.ts` (`productGuard`/`cardGuard` ⇒ 403 para `user.svc`) | `Y-21`: 9 rotas ⇒ 403 |
| Y-22 | BAIXA | **Corrigido** | `cardSpecGuard.ts:320-329` (teto da lista; cabeçalhos contados) | `Y-22` |
| Y-23 | BAIXA | **Corrigido** para o modo autônomo | `cardService.ts:446-451` (`spec_autonomy_runs → stalled`; o status `stalled` existe no CHECK da `090_spec_autonomy_runs.sql:16`). Os jobs do planner não estão cobertos (AB-01) | `Y-01 … laço autônomo` |

Placar Y: **19 corrigidos** (dos quais Y-06 com decisão pendente) · **4 parciais** (Y-08, Y-10, Y-11 e Y-15, este com limites) · **0 não corrigidos**. Contei Y-15 como "corrigido com limites" na tabela; o placar o conta como parcial por prudência.

## 3. Achados novos

| ID | Sev. | Arquivo:linha | Cenário de falha | Correção concreta |
|---|---|---|---|---|
| AB-01 | **ALTA** | Rota: `routes/evolutionPlan.ts:47` (trava conferida **só ao enfileirar**). Job: `services/evolutionPlanner.ts:704-725` (`runEvolutionPlan` → `applyEvolutionPlan`). Escrita: `:465-476` (`upsertCardAware` confere **só** a colisão com o HEAD, não o estado do card). `ready` encerra só `spec_autonomy_runs` (`cardService.ts:446-451`), não `evolution_plan_jobs`. Cópia: `evolveClaim.ts:718-739` (ordem `spec_tree → code → ticket → card_spec`) e `:946-989` (`stepCardSpec` relê o rascunho do disco **sem comparar com `draft_spec_hash`**). Portal: `planBusy` é local à aba (`CardSpecTab.tsx:167`); "Validar" (`CardActionsBar.tsx:24`) não fica desabilitado com o planner em curso | **Por leitura de código, não sondado.** 1) O usuário clica "Gerar RFC com a IA": job 202, LLM de 30 a 120 s. 2) Valida (o pós-COMMIT passa, o planner ainda não escreveu) e promove (o claim confere o hash e passa). 3) O planner termina durante o passo `code` (clone git) e grava `docs/rfc/RFC-000N-…` no rascunho já `promoted`. O `noteCardSpecWrite` não age em `promoted`. 4) O `card_spec` copia esse RFC para o filho com `spec_origin=card:TK`, **sem validação, sem carimbo e sem gate**. Se o job termina depois da materialização, o rascunho "histórico" muda depois da promoção. Não quebra o invariante "filho tem RFC", mas é a mesma classe de Y-01: conteúdo não validado chega à Fábrica (Fase 4, executor com ferramentas). Também consome orçamento e numeração do produto | (a) Em `upsertCardAware`/`applyEvolutionPlan`, chamar `cardSpecWriteBlock` (estado) imediatamente antes de cada gravação de rascunho de card; se travado ⇒ job `error` "card validado/promovido; nada gravado". (b) No `ready`, recusar com 409 (ex.: `CARD_PLAN_RUNNING`) ou marcar `interrupted` os `evolution_plan_jobs` `pending/running` do rascunho, na mesma transação do carimbo. (c) Defesa final: no `stepCardSpec`, calcular o hash do conjunto lido e compará-lo com `extra.card_ready.draft_spec_hash` do rascunho; se diferir ⇒ `TerminalFailure CARD_DRAFT_CHANGED` (ou copiar só o snapshot carimbado). Teste com gancho: job do planner liberado entre o claim e o `card_spec` ⇒ o filho não contém o arquivo |
| AB-02 | MÉDIA | `routes/projects.ts:3482-3489` (condição `!ticketId`); `routes/tickets.ts:117` + `:222` (`POST /api/products/:productId/tickets` ainda cria ticket **legado**, sem `card_state`, com a flag ligada) | Com `CARDS_BANCADA` ligada: cria um ticket pela rota legada e chama `POST /api/projects/:head/evolve {ticketId}`. `legacyEvolveBlockedByCard` só barra ticket que é card, então o filho nasce fora do modelo de cards (sem rascunho, carimbo nem RFC maturado). O Y-10 do backend só fechou a porta "sem ticket" | Com a flag ligada no tenant do produto: `POST …/tickets` ⇒ 409 `USE_CARDS` (ou cria o card pela máquina), e `/evolve` com ticket legado ⇒ 409 `USE_CARDS`. Use o tenant do **projeto/produto**, não `user.tenantId`. Teste nos dois caminhos |
| AB-03 | MÉDIA (decisão) | `routes/cards.ts:68` (`OPERATOR_ROLES` inclui `zentriz_admin`); claim cria o filho com `created_by = a.user.id` (`evolveClaim.ts:526-535`); compare com `routes/projects.ts:3460-3462` (`/evolve`: "RFC-0002 A.1: conta de gestão não cria/evolui projeto") | A matriz foi escolhida pela frente L1 ("decisão sua, reversível"), não pelo Jean, e o plano mantém 6.1 pendente. A escolha permite que a conta de gestão **promova**: materializa uma versão de um tenant como autora e gasta o orçamento do dono (D-E10). É uma regressão da regra A.1, que vale no `/evolve`. Além disso, as `actions` do detalhe não consideram o papel (`routes/cards.ts:312-322`): o `user` não autor vê "Promover" habilitado e recebe 403 (UX) | Jean decide a matriz e a registra (DECISIONS/ADR). Recomendação: `zentriz_admin` só **rejeita**/revalida, sem promover. `actions` calculadas com o papel (`promote: st==="ready" && podeOperar`), e teste de papel incluindo o `zentriz_admin` em promote |
| AB-04 | MÉDIA | `lib/cards/schemas.ts:208-211` (`ERROR_SCHEMAS_PREPARED` = schema **básico** `E(code)`); `lib/cards/__contract__/`: o merge `1511930` regravou só `error-codes.json` (tabela de mensagens) | Os corpos reais dos códigos novos não batem com o schema preparado: `CARD_PATH_COLLIDES_WITH_BASE` traz `path` (escrita) ou `paths` + `state` (ready/promote); `USE_CARD_DELETE` traz `cardId`/`hint`. `CARD_SPEC_CHANGED`, `CARD_ATTACHMENT_CONVERSION_PENDING` (`pending[]`), `CARD_ACTION_NOT_ALLOWED`, `INVALID_ID`, `USE_CARDS` e o bloqueador `GLOBS_UNVERIFIED` **não têm fixture**. O teste "estrito por código" passa porque não há o que comparar, o mesmo padrão "passa sem provar" que motivou Y-11/Y-15. O portal em tempo de execução usa o `passthrough` (`schemas.ts:214`), por isso não quebra a UI | Gravar no `contract:gen` as respostas reais: `ready` 409 (colisão, conversão pendente, spec mudou), `promote` 409 com volta a `refining`, 403 de papel, `INVALID_ID`, `USE_CARD_DELETE`, `USE_CARDS`, jornada com `GLOBS_UNVERIFIED`. Depois, schemas estritos com os campos reais |
| AB-05 | MÉDIA | `lib/cards/specApi.ts:33-37` (`suggestRfcPath` usa só os arquivos do **rascunho**); `components/cards/CardSpecTab.tsx:115`; colisão do backend só por nome exato (`cardSpecGuard.ts:155-158`) | HEAD com `docs/rfc/RFC-0001-exportar.md`: o portal sugere `docs/rfc/RFC-0001-<slug>.md` e o backend aceita (nome diferente). O filho fica com dois `RFC-0001`. A numeração MADR duplicada que Y-08 queria evitar volta pela escrita manual, embora o planner e o modelo estejam corrigidos | Sugerir a partir da base (`GET /api/cards/:id/base-spec`, já carregado na aba) + rascunho. No backend, recusar (409 `CARD_PATH_COLLIDES_WITH_BASE`) RFC/ADR cujo **número** (`RFC-\d{4}` / `ADR-\d{3}`) já exista no HEAD |
| AB-06 | MÉDIA | `services/cardAttachments.ts:69-72` (sem linha de conversão e com a flag ligada ⇒ `queued`); `cardService.ts:392-393` (`ready` recusa); enfileiramento só em `kickTicketConversions` (upload) e `drainTicketConversions` (materialização), `attachmentConversionQueue.ts:223-253`; o worker periódico só processa linhas existentes | Anexo pdf/doc/docx enviado com a conversão desligada (ou com falha no `kick`, que é best-effort) e conversão ligada depois: o anexo aparece `queued` sem linha na fila. O `ready` responde `CARD_ATTACHMENT_CONVERSION_PENDING` ("aguarde") **para sempre**. Nada enfileira, a não ser uma edição de texto que rematerialize o card | No `ready` (ou no worker), chamar `enqueueTicketConversions` para anexos `queued` sem linha e disparar `runConversionTick`; ou tratar "sem linha" como estado próprio (`not_enqueued`) com ação explícita. Teste: flag de conversão ligada depois do upload ⇒ o `ready` sai do bloqueio |
| AB-07 | BAIXA | `cardJourney.ts:135-139`; `cardService.ts:586-598`; `components/cards/PromotePanel.tsx:29` | `GLOBS_UNVERIFIED` é bloqueador só do portal; o `promote` do backend não o considera. A segunda revalidação (base já rebaseada ⇒ `moved=false` ⇒ `ok`) o limpa sem que ninguém confira nada: "revisão humana" equivale a dois cliques | Persistir uma confirmação explícita (`POST …/revalidate {globsReviewed:true}` com ator) e conferi-la no `promote`, ou rebaixar o texto para "aviso" |
| AB-08 | BAIXA | `routes/cards.ts` (`productGuard`/`cardGuard`: `svc` ⇒ 403 **antes** da flag); `lib/uuid.ts:43-60` (hook em todas as rotas `/api/projects/:id`, de qualquer tenant) | "Flag off idêntico" deixa de valer em dois pontos: token de serviço recebe 403, não o 404 "Recurso indisponível", o que revela as rotas; e ids não canônicos passam a dar 400 também em projetos comuns de tenants sem cards. O efeito colateral é baixo | Conferir a flag antes do 403 do `svc`; registrar no CHANGELOG a mudança de contrato do `INVALID_ID` |
| AB-09 | BAIXA | `routes/specChat.ts:2493` e `services/specAutonomy.ts:3262-3270`, `:3593-3600` (checam a trava e depois escrevem, sem `noteCardSpecWrite`) | Resíduo declarado no Z §5: uma escrita tardia do modo autônomo deixa o card **mostrado** como `ready` com carimbo vencido até a promoção dar 409 e devolvê-lo a `refining`. A integridade é mantida pelo hash no claim; a UX mente nesse intervalo | Chamar `noteCardSpecWrite` nos dois escritores após gravar |
| AB-10 | BAIXA (processo) | worktree `g-chk3` | O worktree "limpo" tem **15 PNG modificados** em `project/docs/analysis/img-aa/` (inclusive `real-card-*`): alguém rodou o E2E mock e o real nele depois do merge, e não conheço o resultado. Não reexecutei o Playwright (exige `next build`) | Reexecutar `npm run test:e2e` e `test:e2e:real` sobre `1511930` e anexar a saída; descartar ou commitar os PNG de forma consciente |

### 3.1 Pontos de ataque pedidos, sem achado novo

- **TOCTOU de `ready`/promoção:** leitura única, `FOR UPDATE`, pós-COMMIT e reverificação no claim estão corretos (§2 Y-01). O resíduo está no planner assíncrono (AB-01) e na UX (AB-09).
- **Idempotência da promoção:** `findExisting` antes de qualquer checagem (`evolveClaim.ts:263-264`) e de novo sob o lock (`:418-419`). Repetição ⇒ 200 `replayed`. A corrida `promote × reject` responde `CARD_NOT_READY` (6/6). Sem regressão.
- **`CARD_BASE_STALE`:** conferido sob o lock **depois** do carimbo (`evolveClaim.ts:471-475`) e volta a `refining` (`cardPromote.ts`). Sem regressão.
- **Vazamento de token/PII em erros:** os corpos novos trazem só ids, caminhos relativos e nomes de anexo do próprio card; `revertToRefining` é removido antes da resposta; Y-16 tirou a mensagem do Postgres. O harness E2E-real assina o token com o segredo do processo e escuta só em 127.0.0.1. Nada encontrado.
- **Conversão em processo filho:** não foi alterada nesta rodada (`attachmentConversionRunner.ts`, `spawn` com limites). A integração com o card (`syncCardAfterConversion`) roda no processo da API depois da conversão; só AB-06 é novo.
- **Migrations 141–160 no executor:** nenhuma migration foi alterada nesta rodada (`git diff --stat` vazio em `src/db`). O executor (`db/init.ts:39-82`) continua dividindo por `;` e sem transação por migration. Conferi as 10 de 141 a 160: nenhuma tem `$$`, `;` em literal ou comentário com `;`, e todas são idempotentes (`IF [NOT] EXISTS`/`WHERE NOT EXISTS`). Risco pré-existente (BAIXA, fora do escopo): a 141 faz `DROP CONSTRAINT` + `ADD CONSTRAINT` sem atomicidade, com varredura de `projects` sob `lock_timeout` de 5 s.
- **Flags por tenant:** `/evolve` usa `user.tenantId`. Como a conta de gestão é barrada antes, isso coincide com o tenant do projeto, mas o certo é usar o do projeto (AB-02). O gancho do Guard (`llmGuard.ts`) alinha cards mesmo com a flag desligada depois (sem efeito prático: só age em card existente).

## 4. O que eu rodei (saídas reais)

```
docker run --rm -d --name ab-pg -e POSTGRES_PASSWORD=test -p 55440:5432 pgvector/pgvector:pg16
DATABASE_URL=postgres://postgres:test@localhost:55440/postgres npx tsx scripts/apply-migrations-test.ts
  → … 148_cards_expand · 149_project_spec_files_origin · 150_project_tasks_card · 160_attachment_conversions

PG_TEST_URL=…:55440 npx vitest run src/routes/cards
  → Test Files 7 passed (7) · Tests 83 passed (83)
    [Z-P6] {"escrita":409,"ready":409,"promocao":201,"adrFilhoIntacto":true}
    [Z-P5] {"CARD_NOT_READY":6}
    [Z-papeis] {"negados":{"promote":403,"reject":403,"resume":403,"revalidate":403,"reopen":403,"delete":403},"promocaoPorOutroTenantAdmin":201}
    cards.contract.pg (5) e cards.contract.spec.pg (2) verdes em modo comparação (fixtures do portal batem com o backend mesclado)

PG_TEST_URL=…:55440 npx vitest run          (api-node completo)
  → Test Files 4 failed | 233 passed (237) · Tests 3990 passed | 26 skipped (4016)
    as 4 falhas são as conhecidas que exigem a porta 55432 (llm.reorder, llm.role-verify, costSource, skillFeedback)

applications/apps/genesis-web: npx vitest run → Test Files 12 passed · Tests 299 passed ; npx tsc --noEmit → exit 0
axe-core (JSON da AA): soma de `violacoes` nas 14 execuções = 0
docker stop ab-pg
```

**Não executado:** Playwright mock e real depois do merge (AB-10); mutações nos testes novos (não gravei fora de `/tmp`), por isso "falharia sem a correção" vem da leitura dos testes, que reproduzem as sondas de Y; sondas próprias para AB-01, AB-02 e AB-06 (achados por leitura de código).

## 5. Próximos passos sugeridos (ordem)

1. AB-01 (a)+(b)+(c), com teste por gancho. É a única ALTA.
2. Decisão do Jean sobre a matriz (AB-03) e `actions` com o papel.
3. AB-04: regravar o contrato com os códigos novos.
4. AB-02, AB-05 e AB-06.
5. Reexecutar o E2E mock e o real sobre o HEAD (AB-10).

Depois disso, uma conferência curta (sem nova rodada completa) basta para o Gate F3.
