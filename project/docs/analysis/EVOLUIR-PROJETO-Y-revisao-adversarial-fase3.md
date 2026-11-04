> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO Y — Revisão adversarial independente da Fase 3 (cards na Bancada: backend, portal, contrato)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis`, branch `dev` (HEAD `603d49e`) · **Intervalo:** `git diff 4530ffc..HEAD` (K1 `eafd8f9..329e753`, K2 `74edea3..e515e96`, K3 `a06b27b..603d49e`) · **Papel:** Advisor, revisor adversarial. Só leitura de código; nenhuma alteração no repositório além deste arquivo. Sem produção, sem banco do stack de dev, sem push.
**Insumos:** plano v2 (`project/docs/plans/EVOLUIR-PROJETO-BANCADA-plano.md`), relatórios V, W e X (e H, R para contexto). Nenhuma afirmação dos relatórios foi aceita sem conferência; o que não conferi está marcado **[não verificado]**.

## 1. Veredito

**REPROVADO para o Gate F3.** A regressão com a flag desligada está boa e as suítes passam. O problema é que duas provas centrais da fase não se sustentam:

1. O **gate de RFC invariante** (princípio 6 do plano) **quebra numa corrida reproduzível**: um card foi promovido a filho **sem RFC** (Y-01).
2. A **aba Especificação do portal não opera o rascunho real**. A tela esconde o único arquivo que o rascunho tem, sugere um caminho que o backend recusa e não chama o planner de RFC. Os testes que dizem "salva e cria arquivo" usam um `spec.md` na raiz, que o backend recusa (Y-03). Portanto a "jornada card → spec → promoção" do Gate F3 não está provada pela UI.

Há ainda **quatro achados ALTOS** de integridade e autorização:

- a trava `CARD_SPEC_LOCKED`, o escopo e o orçamento são contornados por um id de projeto sem hífens ou entre chaves;
- o card sobrescreve no filho um ADR herdado da versão corrente;
- o `DELETE /api/projects/:id` apaga o rascunho de um card `ready`;
- não há distinção de papel: o papel `user` promove e gasta o orçamento.

As correções são localizadas (lista na §2). Depois delas, uma nova rodada curta de revisão basta.

| Severidade | Quantidade |
|---|---|
| BLOQUEANTE | 1 |
| ALTA | 5 |
| MÉDIA | 9 |
| BAIXA | 8 |
| **Total** | **23** |

## 2. Achados

Caminhos relativos a `applications/services/api-node/src/` (backend) e `applications/apps/genesis-web/` (portal). "Provado" significa reproduzido por sonda própria em Postgres efêmero (§4.3).

| ID | Sev. | Arquivo:linha | Cenário de falha | Correção concreta |
|---|---|---|---|---|
| Y-01 | **BLOQUEANTE** | `services/cardService.ts:364` (gate) → `:373` (hash) → `:379-383` (carimbo e transição) | **Provado (P4).** `markCardReady` avalia o gate de RFC, depois calcula o hash da spec e grava o carimbo, sem transação nem trava. Com o card em `refining`, uma escrita concorrente entre o gate e o hash fica coberta pelo carimbo. Na sonda, um `DELETE spec-file` do RFC chegou nessa janela: `ready` deu 200, o rascunho ficou só com `tickets/TK-0001/request.md` e a promoção deu **201**. O filho nasceu com `spec-evolution-v2.md`, `docs/regras.md` e `tickets/TK-0001/request.md`, **sem RFC**. Na prática, uma rodada do modo autônomo, um "Aplicar" do Chat ou uma segunda aba aberta abrem essa janela. | Calcular o hash **primeiro**, avaliar o gate sobre **esse mesmo conteúdo** (os arquivos lidos pelo `computeCurrentSpecHash`) e gravar o carimbo e a transição numa transação. A transação deve fazer `SELECT … FOR UPDATE` no ticket e recalcular o hash antes do `COMMIT` (diferiu ⇒ 409). No claim (`evolveClaim.ts`, ramo `a.card`), reavaliar `evaluateCardKindGate` e o hash dentro do lock antes do passo `card_spec`. Teste: a sonda P4 vira teste de regressão. |
| Y-02 | ALTA | `services/evolveClaim.ts:906-915` (`stepCardSpec`, `ON CONFLICT … DO UPDATE`) | **Provado (P6).** O HEAD tem `docs/adr/ADR-001-formato.md` ("BASE ORIGINAL"). O card cria `docs/adr/ADR-001-formato.md` no rascunho (POST 201, dentro do escopo), valida e promove. No filho o arquivo fica com "REESCRITO PELO CARD" e `spec_origin=card:TK-0001`. A "spec da versão corrente somente leitura" (V §2.2) vale só no rascunho; na promoção o card reescreve RFC/ADR históricos da linhagem. O teste da V confere a "árvore do pai idêntica", mas não a árvore do **filho**. | No `card_spec`, recusar (`TerminalFailure CARD_PATH_COLLIDES_WITH_BASE`) qualquer arquivo do rascunho cujo `(rel_dir, filename)` já exista no HEAD. Melhor ainda: recusar já na escrita do rascunho (`cardSpecWriteBlock` consulta `project_spec_files` do HEAD). Acrescentar ao teste de escopo a comparação da árvore do filho herdada contra o HEAD. |
| Y-03 | ALTA | `components/cards/CardSpecTab.tsx:100`, `:201`, `:229`; `e2e/cards.spec.ts:76-78`; `components/cards/CardDetailView.test.tsx:41`, `:347`, `:397`; `components/cards/CardStatusPanel.tsx:19` | A aba filtra `tickets/…`, mas um rascunho real só tem `tickets/TK-NNNN/request.md` (e anexos). Por isso mostra "sem arquivos" e o Chat fica desabilitado (`!path`). O campo "Novo arquivo" sugere `rfc/RFC-001.md`, que o backend recusa com 400 `CARD_PATH_OUT_OF_SCOPE` (só aceita `docs/rfc/`). A ação `generate_rfc` só abre a aba: **nenhuma tela chama o planner** (`/evolution-plan`) nem `rfc-from-template`. O E2E e os testes de componente salvam e criam `spec.md` na raiz, que o backend recusa (evidência `[F3-escopo]` da V). As rotas `spec-files`, `spec-file` e `spec-chat` **não estão no contrato**: os mocks são escritos à mão e provam um fluxo impossível. | Listar `tickets/<code>/**` (o `request.md` pode ser só leitura na UI), `docs/rfc/**` e `docs/adr/**`. Sugerir `docs/rfc/RFC-NNNN-<slug>.md` e validar o prefixo no cliente. Botões "Gerar RFC" (planner) e "RFC a partir do modelo". Gravar no `contract:gen` as fixtures reais de `GET spec-files`, `GET/PUT/POST spec-file` (incluindo o 400 de escopo) e `POST spec-chat`, e trocar os mocks. |
| Y-04 | ALTA | `services/cardSpecGuard.ts:55` (regex `^[0-9a-f-]{36}$`); chamadores com o id **cru** da requisição: `routes/projects.ts:3354`, `routes/specChat.ts:2491`, `services/specAutonomy.ts:783` | **Provado (P1).** O Postgres aceita UUID sem hífens e entre chaves; a guarda devolve `null` (não é rascunho) para esse formato. Card `ready`:<br>• `PATCH /api/projects/<sem hífens>/spec-content` deu **200**, e com `{uuid}` também **200**; a árvore do rascunho mudou (o id canônico dá 409);<br>• `POST /api/spec-chat {projectId:<sem hífens>}` deu **202** e chamou o agente `invoke/cto/async`, **sem a trava e sem `cardBudgetBlock`** (o canônico dá 409);<br>• `POST /api/spec-autonomy` passou da trava (parou só em `NO_VALIDATION`).<br>A promoção pegou a mudança pelo hash (409 `CARD_NOT_READY`): a integridade da promoção se manteve. Trava, escopo e pré-voo de orçamento, porém, são contornáveis. | Normalizar o id **uma vez**: usar o `proj.id` lido do banco (canônico) em todas as chamadas da guarda, ou fazer `loadCardDraftInfo` consultar `WHERE id = $1::uuid` sem o regex. Recusar com 400 o id não canônico nas rotas de projeto (`UUID_RE`, como já faz o `DELETE /api/projects/:id`). Teste com as três formas (sem hífens, chaves, maiúsculas) nos 12 escritores. |
| Y-05 | ALTA | `routes/projects.ts:2998-3060` (`DELETE /api/projects/:id`, sem caso `card_draft`); FK `draft_project_id … ON DELETE SET NULL` (`db/migrations/148_cards_expand.sql:41`) | **Provado (P2).** Um usuário do tenant faz `DELETE /api/projects/<draftId>` com o card `ready` e recebe 200 "Projeto e arquivos removidos". O card **continua `ready`** com `draft_project_id = NULL`; detalhe e jornada mostram "pronto". O `promote` responde 409 e volta o card a `refining`; depois o `ready` dá 409 `CARD_DRAFT_UNREADABLE` para sempre. A única saída é `reject`. O mesmo vale para o modo "guardado" (arquivar), que tira o status `card_draft` e desliga todas as guardas. | No `DELETE` (os dois modos) e em qualquer mudança de status: `card_draft` ⇒ 409 `USE_CARD_DELETE`, apontando para `DELETE /api/cards/:id` ou `reject`. Teste: DELETE do rascunho nos 8 estados do card. |
| Y-06 | ALTA (bloqueia ligar a flag num tenant real) | `routes/cards.ts:55-62` (`denyMutation`) | **Provado (P3).** Não há distinção entre `user` e `tenant_admin`: o papel `user` promove (201), o que materializa a versão e consome o orçamento do dono da versão (D-E10). Rejeitar, retomar e revalidar também ficam livres. O plano adia isso para a 6.1, mas a Fase 3 entrega a UI completa. | Antes de ligar `CARDS_BANCADA` num tenant: matriz mínima (criar/editar = `user`; promover/rejeitar/retomar = `tenant_admin` ou autor, decisão do Jean), aplicada no backend, com teste por papel. Enquanto isso, registrar a decisão. |
| Y-07 | MÉDIA | `services/tickets.ts:221-224` (drenagem da conversão na materialização) × `services/cardService.ts:373` (carimbo) | Por leitura de código, não sondado. O `.md` derivado de pdf/doc/docx que fica pronto **depois** do `ready` não entra no rascunho (a conversão grava em `ticket_attachments`, não em `project_spec_files` do rascunho). Ele entra no filho pelo passo `ticket`, que roda `drainTicketConversions` na promoção. Resultado: o filho recebe texto que **nenhum** Chat, GAP, validador ou carimbo viu, e que vem de documento de terceiros (vetor de injeção de prompt para a Fábrica, Fase 4). | Incluir no hash do carimbo o conjunto de anexos com o estado da conversão, ou bloquear o `ready` enquanto houver conversão `queued/pending/running`. Ao terminar uma conversão, rematerializar `tickets/TK/` no rascunho; se o card estiver `ready`, devolvê-lo a `refining` com motivo. |
| Y-08 | MÉDIA | `services/evolutionPlanner.ts:139-166` (`existingRfcs/existingAdrs` lidos do **rascunho**) | Para `card_draft`, o piso de numeração (GAP-60) e a lista "não repita" vêm do rascunho, que não tem RFC/ADR herdados. Com `next_adr_seq = 1` (medido 17/17 em produção, comentário em `:200`), o primeiro ADR do card sai `ADR-001`, colidindo com o `ADR-001` herdado. Com o mesmo slug, Y-02 o sobrescreve; com slug diferente, a numeração MADR fica duplicada. | Para rascunho, calcular `existingRfcs/existingAdrs` sobre a árvore do HEAD (`loadBaseSpecForDraft`) somada à do rascunho. |
| Y-09 | MÉDIA | `routes/runtimeConfig.ts:58`, `:60` (`CARD_BASE_SPEC_MAX_BYTES` até 50 MB e `CARD_BASE_CONTEXT_CHARS` até 400 000, **sem `adminOnly`**) | O `tenant_admin` grava o override do próprio tenant (F17 do H). Com 400 000 caracteres (cerca de 100 mil tokens) por chamada de Chat, GAP, planner ou validador, a amplificação de custo pesa no tetos globais compartilhados (`GLOBAL_*_CAP`, vizinho barulhento). Com 50 MB, `GET base-spec` monta um JSON gigante. A lista de arquivos do bloco (`cardSpecGuard.ts:225`) não entra no teto. | `adminOnly: true` nas duas chaves; teto máximo menor (ex.: 60 000 caracteres) até calibrar; contar a lista de arquivos no orçamento do bloco. |
| Y-10 | MÉDIA | `app/(dashboard)/projects/[id]/page.tsx:412`, `:1384`; `lib/cards/useCardsEnabled.ts:15` | Enquanto `capabilities` carrega, ou se falha (a falha fica em cache para a sessão inteira), `cardsEnabled = false`. Um tenant com a flag **ligada** cai no diálogo legado `/evolve`, que segue aceitando evolução sem ticket e cria filho fora do modelo de cards. | Botão desabilitado enquanto carrega; não cachear falha; no backend, `/evolve` sem `ticketId` em tenant com `CARDS_BANCADA` ligada ⇒ 409 `USE_CARDS` (decisão do Jean). |
| Y-11 | MÉDIA | `lib/cards/schemas.ts:173` (`errorBodySchema` em `passthrough`) | Mutação feita pelo subagente: renomear `expectedHead` em `promote.409-base-stale.json` não quebra a suíte (111/111). O portal lê `details`, `writable`, `missing`, `freeUsd`, `services`, `errors`, `guardCode` e `expectedHead` sem amarra. A afirmação "objetos estritos" da X vale para as respostas de sucesso, não para os erros. | Um schema por código de erro, cobrindo os campos que o portal consome. |
| Y-12 | MÉDIA | `e2e/cards.spec.ts` (medição) × `project/docs/analysis/img-x/a11y-{dark,light}.json` | A X diz "63 amostras", "9 de 9 controles" e "15 controles". O JSON tem **62** amostras, foco visível em **8 de 8** controles do `main` (9 de 14 no total) e **14** alvos. A fórmula de contraste está correta (luminância WCAG e composição de alfa), mas há limites:<br>• ignora a `opacity` de ancestrais, o empilhamento visual, `hover` e o contraste de não texto (1.4.11);<br>• o foco só reconhece `outline ≥ 2px` (box-shadow não);<br>• os alvos não contam botões MUI renderizados como `<a>`;<br>• mede um único estado e só desktop. | Corrigir os números na X; incluir `a[role=button]`/`a.MuiButton-root` nos alvos; medir quadro, diálogo e 320 px; uma rodada com axe-core para cruzar. |
| Y-13 | MÉDIA | `services/cardRevalidate.ts:77-79`; `services/cardService.ts:446-455` | Sem clone em `PROJECT_FILES_ROOT`, a revalidação devolve `ok/stale` com `REPO_UNAVAILABLE` (informativo). O `GLOB_NO_LONGER_MATCHES` nunca dispara e o portal deixa promover. Com clone, a árvore lida é a do **sistema de arquivos** (cópia de trabalho), não a do commit aceito do HEAD. É seguro só porque o gate do runner aplica `files_allowed` na execução; o custo de descobrir tarde é orçamento gasto. | Quando `REPO_UNAVAILABLE` e o HEAD andou: `result = "stale"` com `needsHumanReview` explícito, e a jornada mostra um bloqueador "globs não conferidos". Ler a árvore do ref aceito (`git ls-tree`) quando houver repositório. |
| Y-14 | MÉDIA | `routes/cards.ts:402-410` (o GET da jornada escreve via `syncCardWithChild`); `services/cardPromote.ts:208-228` | O bloqueio por orçamento só aparece numa leitura, no `resume` ou no reconciliador, que é `off` por padrão (V §4.4). Até alguém olhar, o card fica `in_factory` e o quadro mente. Um `GET` com efeito colateral, inclusive pelo token de serviço do tenant (P3: o runner lê detalhe e jornada com 200), dificulta auditoria e cache. | Ligar o reconciliador (`on`) junto com a flag, ou chamar `syncCardForChildProject` no ponto em que o pipeline já registra `stopped_by='budget'` (sem tocar no `llmGuard.ts`). Documentar o efeito do GET. |
| Y-15 | MÉDIA | `routes/cards.fase3.pg.integration.test.ts` (trava `:169-215`, escopo `:289-304`); `e2e/cards.spec.ts:40` | São testes que passam sem provar o que dizem:<br>• a trava dos 12 escritores só usa o id canônico (Y-04 escapa);<br>• o escopo confere o pai, não o filho (Y-02 escapa);<br>• não há corrida `ready × escrita` (Y-01 escapa);<br>• os agentes devolvem `"{}"`, então nenhuma saída de LLM é aplicada de fato;<br>• o E2E é 100% `page.route` sobre respostas gravadas, com mocks de spec impossíveis (Y-03);<br>• as corridas de promoção só cobrem promote × promote. | Acrescentar as sondas P1, P2, P4 e P6 desta revisão como testes; um E2E contra o `api-node` real (stack docker local) para criar card → escrever RFC → validar → promover. |
| Y-16 | BAIXA | `routes/cards.ts:88` e `:491` | `GET /api/products/abc/cards` e `GET /api/cards/:id/attachments/abc` dão **500** com `code 22P02` e a mensagem do Postgres no corpo. Isso também quebra o "flag off idêntico" para id malformado (antes da Fase 2 a rota era 404). | Validar UUID nos parâmetros e responder 404/400. |
| Y-17 | BAIXA | `services/evolveClaim.ts:266` | **Provado (P5, 6 rodadas).** Na corrida `promote × reopen × reject × revalidate × promote`, o estado final ficou sempre consistente (`rejected`, sem filho). Mas o `promote` que perde responde `409 TICKET_ALREADY_PROMOTED` ("Este pedido já foi promovido") para um card **rejeitado**. | No ramo `a.card`, mapear `status ≠ open` para `CARD_NOT_READY` com o estado real. |
| Y-18 | BAIXA | `components/cards/CardTile.tsx:51`, `CardStatusPanel.tsx:107`, `PromotePanel.tsx:57` | O `prUrl` vira `href` sem checar o esquema (o React 18 não bloqueia `javascript:`). A origem é gravada pelo servidor ou pelo `PATCH extra` do `zentriz_admin`, então o risco é XSS armazenado só com credencial de gestão. Os `target=_blank` têm `rel="noopener noreferrer"`. | Aceitar só `^https://`. |
| Y-19 | BAIXA | `lib/cards/useCardsEnabled.ts:8`; `app/(dashboard)/products/page.tsx:128` | O cache de capacidades no módulo sobrevive ao logout. A sonda da flag usa o primeiro produto, o que engana o `zentriz_admin`, que vê vários tenants. Não vaza dado (o backend autoriza por produto). | Resetar o cache no `authStore.logout`; sonda por tenant. |
| Y-20 | BAIXA | `components/cards/CardDetailView.tsx:44-52`; `CardJourneyTab.tsx` | Uma falha de recarga com o card já exibido não mostra aviso. A jornada não tem indicador de carregamento (Promover fica ativo nesse intervalo). O histórico mostra `reason` cru (`spec_write`, `budget:BUDGET_PAUSED`). | Alert não bloqueante; spinner; `blockedReasonLabel` no histórico. |
| Y-21 | BAIXA | `routes/cards.ts:103-119` | O token de serviço do runner, escopado no tenant e sem `projectId`, lê qualquer card do tenant (P3: 200) e, pelo GET da jornada, provoca transições. O token com `projectId` é barrado pelo `auth.ts` (`PROJECT_SCOPE_MISMATCH`), por leitura de código [não verificado em teste: o `authMock` substitui o middleware]. | Recusar `svc:"runner"` também nas leituras de card, ou documentar a necessidade. |
| Y-22 | BAIXA | `services/cardSpecGuard.ts:221-236` | A lista "Arquivos da versão corrente (N)" não tem teto, e o cabeçalho de cada arquivo estoura levemente o orçamento. Em spec com centenas de arquivos, o bloco passa do `CARD_BASE_CONTEXT_CHARS`. | Truncar a lista e contar os cabeçalhos. |
| Y-23 | BAIXA | `services/specAutonomy.ts:3264-3270`, `:3595-3604` | O modo autônomo checa e depois escreve: se o card vai a `ready` entre a checagem e a escrita da rodada, a escrita acontece. A promoção pega pelo hash, mas o card volta a `refining` em silêncio para o usuário ("a spec mudou depois da validação"). | Ao ir a `ready`, cancelar ou marcar `stalled` os runs ativos do rascunho, na mesma transação da Y-01. |

## 3. Verificação das citações dos relatórios

| Relatório | Afirmação | Conferido | Resultado |
|---|---|---|---|
| X §6 | api-node completo em PG 55432: **235 arquivos, 3990 passaram, 1 pulado** | rodei (§4.1) | **Confere** |
| X §6 | em 55441: 231 passaram, 4 falharam só por exigirem 55432, 3965 testes | rodei | **Confere** (4 falhas: `llm.reorder`, `llm.role-verify`, `costSource`, `skillFeedback`; o regex delas aceita só 55432) |
| V §5 | BASELINE `4530ffc` 230/3938 e `evo/k1` 234/3985 | não rodei nesses commits | **[não verificado]**; coerente com 235/3990 da HEAD (+1 arquivo e +5 testes de contrato) |
| V §5 | Suítes novas: 21 + 12 + 11 + 3 testes | contei os `it(` | **Confere** |
| V §2.2 / §5 | "trava em 12 escritores" | li o teste e sondei | **Parcial**: os 12 respondem 409 **com id canônico**; contornados por id sem hífens ou entre chaves (Y-04) e por corrida (Y-01); o `DELETE /api/projects/:id` não está entre eles (Y-05) |
| V §2.2 | "A spec da versão corrente é somente leitura" | sonda P6 | **Não confere no filho** (Y-02) |
| V §3 / X §2.5 | 56 códigos na tabela única | contei em `cardErrors.ts` | **Confere** (56) |
| X §3 | 76 arquivos de fixture (74 respostas + `error-codes` + `index`) | `ls` | **Confere** (76) |
| X §3 | `contract.test.ts` com 111 testes; portal 228/10 | rodei | **Confere** |
| X §3 | "Prova de deriva: alterei `journey.ready.json` e quebrou" | refiz nos dois lados | **Confere** para o backend (mudei a mensagem do `reopen` ⇒ 1 falha; `actions.reopen` em `refining` ⇒ 1 falha) e para o sucesso no portal; **não confere** para os corpos de erro no portal (Y-11) |
| X §3 | "Objetos estritos (campo novo = erro)" | subagente | **Parcial**: os erros são `passthrough` (Y-11) |
| X §4 | 63 amostras; 9 de 9 controles com foco; 15 controles ≥ 24 px; mínimo 5,09 (escuro) e 4,55 (claro) | li os JSON | **Parcial**: 62 amostras; 8/8 no `main` (9/14 no total); 14 alvos; os mínimos **conferem** |
| X §6 | Playwright: 11 testes passaram | rodei | **Confere** (11 passaram, 9,1 s) |
| X §2 | "Backend: nenhum erro real encontrado" | esta revisão | **Não confere** (Y-01, Y-02, Y-04, Y-05, Y-16, Y-17) |
| X §7 | O E2E usa respostas gravadas, não API viva | li o `e2e/cards.spec.ts:40` | **Confere**; o que fica sem prova está na Y-15 |
| W §2 | Aba Especificação edita a spec do card, com Chat e GAPs sobre o rascunho | código e backend | **Não confere contra o backend real** (Y-03) |
| W §3.1 | Flag = `capabilities`; erro ou 404 ⇒ falso | código | **Confere**, e é a causa da Y-10 |
| X §8 / V §6 | Estágio B com prefixo de contexto sem prova com LLM real | — | **Confere** (risco declarado; continua aberto) |

## 4. O que eu rodei (comandos e saídas reais)

### 4.1 api-node completo
```
docker run --rm -d --name rev3-pg  -e POSTGRES_PASSWORD=test -p 55441:5432 pgvector/pgvector:pg16
docker run --rm -d --name rev3-pg2 -e POSTGRES_PASSWORD=test -p 55432:5432 pgvector/pgvector:pg16
DATABASE_URL=postgres://postgres:test@localhost:<porta>/postgres npx tsx scripts/apply-migrations-test.ts   # … 160_attachment_conversions
PG_TEST_URL=postgres://postgres:test@localhost:55441/postgres npx vitest run
  → Test Files  4 failed | 231 passed (235) · Tests 3965 passed | 26 skipped (3991)
    (4 falhas: "PG_TEST_URL deve apontar para o Postgres efêmero em localhost:55432")
PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres npx vitest run   (DATABASE_URL indefinida)
  → Test Files  235 passed (235) · Tests 3990 passed | 1 skipped (3991) · 34,2 s
```
Não usei a porta 55442 sugerida porque `src/testing/evolvePg.ts:52` recusa qualquer porta fora de 55432/55440/55441.

### 4.2 Portal (worktree próprio `/tmp/rev3-wt`, `npm ci` em `applications/apps/genesis-web`)
```
npx vitest run                     → Test Files 10 passed (10) · Tests 228 passed (228)
npx vitest run lib/cards/contract.test.ts → 111 passed
  mutação journey.ready.json "headline"→"headLine"           → 2 falharam / 109 passaram
  mutação promote.409-base-stale.json "expectedHead"→"…X"     → 111 passaram (não detecta)
  mutação detail.ready.json actions.promote=false            → 111 passaram (valor não é checado)
npx tsc --noEmit                   → EXIT 0
npx next lint                      → EXIT 0, 5 avisos react-hooks/exhaustive-deps pré-existentes
npx next build && E2E_PORT=3197 CHROMIUM_PATH=…/chromium-1234/chrome-linux64/chrome npx playwright test
                                   → 11 passed (9.1s)
grep de segredos nas fixtures (eyJ|sk-|ghp_|github_pat|Bearer|password|secret|token|e-mails|UUID não normalizado|/tmp|/home)
                                   → nada; única URL: https://github.com/zentriz-demo/entregas/pull/42 (fictícia)
```

### 4.3 Sondas próprias (arquivo temporário no worktree, Postgres 55441, agents stub; removidas ao final)
| Sonda | Resultado literal |
|---|---|
| P1 id não canônico, card `ready` | `PATCH spec-content` sem hífens **200**, `{uuid}` **200**, canônico 409, maiúsculas 409; `spec-chat` sem hífens **202** (`agentsCalls: ["http://agents.local/invoke/cto/async"]`), canônico 409; `spec-autonomy` sem hífens **409 NO_VALIDATION** (passou da trava), canônico 409 `CARD_SPEC_LOCKED`; `treeChanged: true`; `promote` depois: 409 `CARD_NOT_READY` ("A spec do rascunho mudou depois da validação") |
| P2 `DELETE /api/projects/<draft>` com card `ready` | 200 `"mode":"deleted"`; card `ready`, `draft_project_id: null`; detalhe 200, jornada 200 "ready"; `promote` 409 `CARD_NOT_READY` ("não tem o carimbo"); `ready` 409 `CARD_DRAFT_UNREADABLE`; `reject` 200 |
| P3 autorização | outro tenant: detalhe, jornada, anexos, base-spec, reopen, lista e capabilities **404**; `spec-files` do rascunho 403; papel `user` promove **201**; `svc:runner`: GET 200, jornada 200, POST reject 403 |
| P4 corrida `ready` × `DELETE` do RFC | DELETE 200; `ready` **200**; árvore do rascunho `["tickets/TK-0001/request.md"]`; `promote` **201**; árvore do filho `["spec-evolution-v2.md","docs/regras.md","tickets/TK-0001/request.md"]`, **sem RFC** |
| P5 `promote × reopen × reject × revalidate × promote` (6×) | sempre final `rejected`, sem filho; o `promote` perdedor responde `409 TICKET_ALREADY_PROMOTED` |
| P6 ADR herdado | POST `docs/adr/ADR-001-formato.md` 201; `ready` 200; `promote` 201; ADR no filho `"# ADR-001 REESCRITO PELO CARD"` (`spec_origin card:TK-0001`); HEAD `"# ADR-001 BASE ORIGINAL"` |
| P7 ids malformados | `/api/cards/abc` 404; card sem hífens 404; `attachments/abc` **500 22P02**; `/api/products/abc/cards` **500 22P02** |

Também mutei o backend no worktree para provar que o teste de contrato quebra quando a resposta muda. Mensagem do `reopen` alterada: "o contrato de reopen.200 mudou: rode `npm run contract:gen`…", 1 falhou e 4 passaram. `actions.reopen` alterado: 1 falhou. Revertido nos dois casos.

### 4.4 Limpeza
Containers `rev3-pg` e `rev3-pg2` derrubados; worktree `/tmp/rev3-wt` removido (`git worktree remove --force`); nenhum arquivo do repositório alterado além deste relatório.

## 5. Respostas aos pontos de ataque (resumo)

1. **Segurança.** A autorização por tenant é sólida nas rotas novas (P3: 404 uniforme). Os furos estão em outro lugar:
   - falta autorização por papel (Y-06);
   - a guarda dos rascunhos é contornável por id não canônico (Y-04);
   - o `DELETE` genérico de projeto escapa da guarda (Y-05).

   O download tem `nosniff`, Content-Type por allowlist e Content-Disposition RFC 6266. O `safeFilename` remove separadores e pontos iniciais. Não encontrei SQL injection: os filtros vão por parâmetros e as interpolações são constantes. Não encontrei XSS fora do `prUrl` (Y-18): sem `dangerouslySetInnerHTML`, sem renderizador de markdown, conteúdo em `<pre>` ou texto. Não há rate limit específico de cards (upload, chat ou promoção); o Chat depende do Guard [não verificado o limite por minuto].
2. **CARD_SPEC_LOCKED e escopo.** Inventário por `rg -a` de `INSERT/UPDATE/DELETE project_spec_files` e de `writeFile/rename/unlink`. Escapam:
   - o id não canônico (Y-04);
   - a corrida do `ready` (Y-01);
   - o `DELETE /api/projects/:id` (Y-05);
   - o `.md` derivado da conversão, que chega ao filho sem carimbo (Y-07);
   - o modo autônomo, que checa e depois escreve (Y-23).

   `CARD_PATH_OUT_OF_SCOPE`:
   - `..`, `.`, caminho absoluto e profundidade maior que 4 são recusados pelo `parseSpecPath` e pelo `isCardWritablePath`;
   - a comparação diferencia maiúsculas e minúsculas, o que é conservador: `Docs/rfc` é recusado;
   - extensão dupla não importa, porque o escopo é por pasta;
   - unicode homógrafo cai fora das raízes e é recusado;
   - symlink: as rotas gravam pelo caminho calculado, não por link do usuário [não verificado se `resolvePhysical` segue symlinks já existentes no disco].

   O contorno real do escopo está na **promoção** (Y-02).
3. **Leitura da spec-base.**
   - Sem vazamento entre tenants: `card_target_root_id` vem da criação autorizada e o `extra` só é gravável pelo `zentriz_admin`.
   - Injeção de prompt: spec, RFC e anexos convertidos entram rotulados como "SOMENTE LEITURA", e as escritas ficam contidas pelo escopo. O agente CTO não tem ferramentas [não verificado]. O risco real é a Fase 4, com executor que tem ferramentas (Y-07).
   - Custo: 14 000 caracteres por padrão, até 400 000 pelo `tenant_admin` (Y-09).
   - Orçamento: o dono da versão é o `budget_owner_project_id`, que acompanha o `stale`. `BUDGET_MISSING` está coberto na criação (fixture `create.402-budget-missing`).
   - O validador (Estágio B) e o modo autônomo consultam o Guard por rodada? [não verificado].
4. **Promoção.**
   - As corridas entre transições terminam consistentes (P5).
   - Falha a corrida da validação com escrita (Y-01).
   - `CARD_BASE_STALE` confere o HEAD e o hash da spec do HEAD, fora e dentro do lock.
   - Com `REPO_UNAVAILABLE` a promoção é permitida, o que é seguro por causa do runner, mas não confere nada (Y-13).
   - `resume` por orçamento e `blocked ↔ filho` dependem de leitura ou do reconciliador (Y-14).
5. **Contrato.** Trava a divergência no backend (provado) e nas respostas de sucesso no portal; não trava nos erros (Y-11). As fixtures estão limpas. O que fica sem prova:
   - rotas de spec e chat;
   - autenticação real e cookies;
   - multipart real;
   - corridas;
   - LLM;
   - integração HTTP portal ↔ api.
6. **Flag off.**
   - Com a flag desligada, a resposta é o 404 "Recurso indisponível" sem `userMessage`; o hook `preSerialization` fica encapsulado no plugin `cardRoutes`, registrado sem `fastify-plugin` (`app.ts:126`). Exceção: id malformado dá 500 (Y-16).
   - O portal faz um GET a mais de `capabilities` por produto, em cache. Só revela a flag a quem já acessa o produto (outro tenant recebe 404).
   - Efeito colateral do GET: a corrida e o cache de falha da Y-10.
7. **UI.**
   - Vazio, erro e carregamento existem no quadro, com lacunas no detalhe (Y-20).
   - Não há framework de i18n no portal; o PT-BR fixo é consistente com o resto.
   - O `AppLayout` não mudou; o `CardsA11yTheme` fica restrito às telas de cards.
   - O desvio da página do projeto não tem teste de componente (W §8).
   - A falha funcional grave é a Y-03.
8. **Lacunas para a Fase 4 e para ligar a flag:** §6.
9. **Testes que cumprem sem provar:** Y-15.

## 6. Lacunas (não cobertas por esta revisão ou abertas para a Fase 4)

- **Antes de ligar `CARDS_BANCADA` num tenant real:**
  - corrigir Y-01 a Y-06 e Y-09;
  - aplicar as migrations 148–150 e 160 em produção (V §6);
  - ligar `ATTACHMENTS_STRICT` junto;
  - inventariar os leitores Python de `projects.status`/`card_draft`: orquestrador, runner, cyborg, deadpool [não verificado: o `rg card_draft` em `applications/orchestrator|agents|runner` não achou nada, o que tanto pode significar ausência de leitor quanto leitor que ignora o status];
  - ligar o reconciliador (`on`);
  - fazer uma execução real do Estágio B com prefixo de contexto.
- **Fase 4:**
  - `project_tasks.card_id` não é preenchido pelo runner;
  - `ticket_kind`/`spec_origin` não chegam aos prompts de PM/CTO;
  - falta a marcação `delivered` com PR mergeado e o `executed_*` nos arquivos e tasks;
  - falta o PR por card (`TK-NNNN`);
  - faltam as 3 execuções com LLM real e o caos (matar runner/api por etapa).
  - Riscos já visíveis:
    - o conteúdo convertido de anexos chega a um executor com ferramentas (Y-07);
    - o filho pode herdar RFC/ADR adulterado (Y-02);
    - colisão de numeração (Y-08).
- **Não verificado nesta revisão:**
  - a CI (`.github/workflows/ci-evolution.yml` roda o PG 55432 e o portal em `dev`/PR, mas nada foi enviado: 139 commits à frente de `origin/dev`);
  - leitor de tela real e ferramenta externa de contraste;
  - comportamento do agente CTO diante de injeção;
  - `resolvePhysical` com symlink preexistente;
  - limites de taxa do Chat;
  - os números da V nos commits de K1.
