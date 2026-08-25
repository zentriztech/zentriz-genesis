> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# RFC-0003: Spec como Bancada pré-fábrica e Splitter vivo dentro de Specs

## Status

Rascunho — **fechamento pendente de aprovação do Jean.** Nenhuma linha de código deve ser escrita antes do "ship".

## Data

2026-08-25

## Resumo

Reposicionar a **Spec** como uma **Bancada de desenho que vive ANTES da fábrica** (o pipeline CTO→PM→Dev→QA→DevOps): o usuário desenha e rascunha à vontade, a custo ~zero, e só **promove para a fábrica** os projetos que julgar viáveis. O **Splitter deixa de ser um menu/etapa separada e passa a ser um recurso VIVO da Spec** — decompor um documento em N projetos interdependentes vira uma ação sobre a spec, e a decomposição é **salva como rascunhos na Bancada** (não mais efêmera em memória). O portal ganha uma separação limpa por ciclo de vida: **Bancada** (pré-fábrica) × **Meus Projetos / Meus Produtos** (fábrica). Inclui o redesign de menu correlato (remover "Projetos"/"Splitter", renomear "Deadpool"→"Auto Care", agrupar "Configuração").

Este RFC nasce de mapeamento profundo do código (3 agentes de exploração) seguido de **quatro revisões adversariais em paralelo** (modelo de dados, API, UX e enriquecimento). As seções **§7 (Gaps confirmados)** e **§8 (Refutados)** são o coração do documento: descrevem exatamente onde o modelo ingênuo quebra no código atual e como corrigir cada ponto antes de desenvolver.

## Contexto

O Genesis já opera em produção como fábrica autônoma multi-tenant. Hoje, três peças se relacionam de forma implícita e um tanto acidental:

### C.1 — "Spec" já É pré-fábrica, mas o modelo não é explícito

Uma **spec não é uma tabela separada** — é uma **linha da tabela `projects`** em status inicial. A migration `042_specs_as_drafts.sql` documenta a decisão: "reusamos `status='draft'`; a promoção reusa `POST /api/projects/:id/run`". A fronteira pré-fábrica ⇄ fábrica é puramente o **status**:

- **Pré-fábrica (Bancada):** `draft`, `spec_submitted`, `pending_conversion` — o conjunto `SPEC_LISTING_STATUSES` (`routes/specs.ts:19`). Aparece em `/specs`.
- **Fábrica:** `cto_charter` em diante — aparece em `/projects`, não em `/specs`.

**Consequência favorável:** promover é **barato** — uma transição de status na **mesma linha**, sem migração de dados. O markdown da spec já vive em disco (`UPLOAD_DIR/<projectId>/`, rastreado em `project_spec_files`), e `projects.extra` (JSONB) guarda `project_type`/`delivery_mode`/prefs de deploy/`spec_approved`. Isto é a fundação sobre a qual o modelo do Jean se apoia — e as revisões confirmaram que ela aguenta o peso (ver §8, refutação de "save-then-promote viola CHECK/lineage").

### C.2 — O Splitter é poderoso, mas efêmero e desconectado

O Splitter (`app/(dashboard)/splitter/page.tsx`, 527 linhas) pega **um documento em prosa** e, via LLM (agente "Product Architect" em modo SPLITTER, Bedrock/Sonnet), **decompõe em 1 produto + N projetos interdependentes** com um DAG de execução (`project_triggers`) em ondas topológicas. Ele **propõe, nunca executa** (`needs_human` sempre true — ADR-018).

O problema estrutural: **a proposta vive só em memória** (`_proposeJobs` Map em `routes/products.ts`, GC de 30 min). Se o usuário não aprovar em 30 minutos, perde tudo. E ao aprovar (`POST /api/products/ingest-proposal`), `decomposeProduct` (`services/productDecomposer.ts`) cria o produto + N projetos **e imediatamente dispara a onda 0** — ou seja, aprovar = entrar na fábrica agora. Não existe o meio-termo "salvei o desenho, promovo depois".

### C.3 — O pivô do Jean (verbatim)

> "quero um plano focado no Splitter e Specs, acredito muito que Splitter deva ser um recurso vivo de Specs, analise profundamente e encontre uma melhor solucao para isso, a spec como fazer anterior a fabrica, posso specificar centenas de projetos e apenas promover para a fabrica quando achar viavel. analise adversariais completas em loop até o entendimento de melhorias ficar 100% claro."

E, sobre o processo:

> "Opcao 2 + Revisao Adversarial + Busca e Correcao de GAPs + Sugestoes para enriquecer ainda mais. depois de tudo fechado vamos desenvolver."

---

## 1. Objetivos

1. **Bancada pré-fábrica de custo ~zero:** especificar centenas de specs/projetos em rascunho sem consumir a fábrica (nenhum agente LLM roda até promover).
2. **Splitter vivo dentro da Spec:** decompor é uma ação sobre uma spec; a decomposição é **persistida como rascunhos** (mata o proposal efêmero de 30 min).
3. **Promoção deliberada e segura:** promover à fábrica é um ato explícito; "promover produto inteiro" dispara as raízes e cascateia pelo DAG, sem furar concorrência nem gates de dependência/contrato.
4. **Separação limpa por ciclo de vida no portal:** Bancada (pré-fábrica) × Meus Projetos/Produtos (fábrica), com menu reorganizado.
5. **Zero regressão de governança:** master (`zentriz_admin`) permanece somente-leitura na autoria (RFC-0002); promover é operação de ciclo de vida (ver Decisão §6, D3).

## 2. Não-objetivos

- Não criar tabela `specs` nem coluna de conteúdo de spec (o modelo `projects`-row + arquivos em disco fica).
- Não trocar o motor de decomposição (Product Architect / `buildProductSketch`).
- Não introduzir avaliação de viabilidade por LLM (os scores de enriquecimento são **determinísticos** — §9).
- Não fazer deploy: este RFC é o entregável; desenvolvimento só após o Jean fechar.

## 3. Decisões travadas com o Jean (2026-08-25, via AskUserQuestion)

- **D1 — Aprovar decomposição do Splitter = SÓ salvar na Bancada** (N projetos como rascunhos sob um produto, **sem dispatch**). Promover é ato deliberado posterior.
  *Por quê:* alinha 100% com "especificar centenas, promover só o viável".
- **D2 — Rascunhos (soltos ou de produto) vivem SÓ na Bancada.** "Meus Projetos" e "Meus Produtos" mostram apenas itens **promovidos** (fábrica).
  *Por quê:* não misturar rascunho e fábrica na mesma tela. *Consequência aceita:* um produto pode ter parte dos projetos em rascunho (na Bancada, sob o produto) e parte promovidos (em Meus Produtos) — migra onda a onda.
- **D3 — Promoção:** "Promover produto inteiro" (dispara raízes/onda 0, cascateia pelo DAG) **+** promoção individual apenas de projetos cujas dependências já estejam `accepted` (evita o 409 do gate de dependência).

## 4. Modelo final

- **Bancada (`/specs`)** = TODO o pré-fábrica (`draft`/`spec_submitted`/`pending_conversion`): specs soltas + rascunhos de produto (decomposições). **Splitter embutido** — botão "Decompor" alimenta o `/propose` com o markdown da spec salva (que já está em disco). Ações por item: Editar · Melhorar com IA · **Decompor** · Vincular a produto · **Promover à fábrica**. Aba "Catálogo" mantida.
- **Meus Projetos (`/projects`)** = projetos **soltos** (`product_id IS NULL`) e **promovidos** (status fora do conjunto pré-fábrica).
- **Meus Produtos (`/products`, novo)** = cards de produto (só a parte promovida dentro) → `/:productId/projects`.
- O atalho atual "Salvar e iniciar pipeline" (express) permanece válido — não quebrar a via rápida.

## 5. Eixos ortogonais (mapa mental)

O modelo tem **dois eixos independentes**, e boa parte da confusão do código atual vem de tratá-los como um só:

```
                     PRÉ-FÁBRICA (Bancada)        FÁBRICA (promovido)
                     draft/spec_submitted/         cto_charter+ …
                     pending_conversion
  SOLTO   (product   rascunho solto               Meus Projetos
  _id NULL)          → /specs                      → /projects

  PRODUTO (product   rascunho de produto          Meus Produtos
  _id != NULL)       (decomposição) → /specs,      → /products/:id/projects
                     agrupado sob o produto
```

Regras derivadas: (a) `/specs` filtra por **status ∈ pré-fábrica** (ambas as colunas de baixo); (b) `/projects` filtra por **solto E promovido**; (c) `/products/:id/projects` filtra por **produto E promovido**.

---

## 6. Escopo de mudança (visão)

### Backend (`api-node`)
- **B1 — Decomposição sem disparo:** flag em `POST /api/products/ingest-proposal` (e `decomposeProduct`) para **não** chamar `dispatchProjectRun`; cria N drafts. *(Ver correções G1/G2 em §7 — esta mudança tem armadilhas.)*
- **B2 — Promoção de produto/onda:** endpoint dedicado que dispara as **raízes** (onda 0) via caminho de `/run` endurecido; individual só se deps `accepted`. *(Ver G1/G3/G5.)*
- **B3 — FIX `GET /api/products` honrar `?tenantId` do master** (hoje retorna `[]`); espelhar o branch de `/projects` e `/specs`. *(Ampliado por C5 — ver §7.)*
- **B4 — Endpoint "decompor spec salva":** aceita `projectId` da spec, lê markdown de disco, chama `/propose`; vincula o produto resultante à spec de origem. *(Ver C7/G-UX#4.)*

### Frontend (`genesis-web`)
- **F1 — `/specs` vira Bancada:** botões "Decompor" (embute a UI do splitter atual) e "Promover à fábrica"; agrupa rascunhos de produto sob header de produto. Remove o menu "Splitter".
- **F2 — `/projects` (Meus Projetos):** filtra só soltos + só promovidos.
- **F3 — `/products` (novo) + `/products/:id/projects` (novo).**
- **F4 — `AppLayout.tsx`:** remove "Projetos" (`/tenant/projects`) e "Splitter"; renomeia Deadpool→"Auto Care" (`/autocare`); grupo colapsável "Configuração" (settings/*); nova ordem Bancada→Projetos→Produtos→Notificações→Auto Care→Configuração. Ajusta `HIDE_WHEN_NO_TENANT` e `navTenantAdmin`/`navZentriz`.
- **F5 — Rota `/autocare`** (redirect de `/deadpool`; rótulo externo — "Deadpool" é codinome interno).

---

## 7. GAPS CONFIRMADOS (adversarial) — corrigir ANTES de desenvolver

> Achados verificados por quatro revisões independentes com evidência `arquivo:linha`. Prefixos: **G**=data-model, **C**=API, **U**=UX. HIGH em negrito.

### 7.1 — Promoção e dispatch (o núcleo do B1/B2)

- **🔴 G1 (HIGH) — "re-decompor para promover" NÃO dispara nada.** `productDecomposer.ts:85-91` reusa por `product_hash`; `buildReuseResult` (`:49-71`) hardcoda `dispatched:[], idempotentReuse:true`; os callers só disparam quando `!idempotentReuse` (`products.ts:239-254`/`:342-356`). Se B2 implementar "promover produto" reusando o path de decompose, a 2ª chamada tem o mesmo hash → no-op 200 silencioso; **a onda 0 nunca é disparada.**
  **Fix:** promover é um caminho **dispatch-only** sobre as linhas já criadas — buscar as raízes do produto (projetos **sem** `project_triggers` de entrada dentro do produto) e chamar o caminho de `/run` endurecido em cada. **Nunca** re-rotear por `decomposeProduct`.

- **🔴 C2 (HIGH) — TOCTOU no slot de concorrência.** `hasConcurrencySlot` (`tenantLlmConfig.ts:189-224`) é read-then-decide não-atômico. "Promover produto inteiro" dispara N raízes quase simultâneas → todas leem "há slot" → o `max_concurrent_projects` é furado.
  **Fix:** claim atômico espelhando o padrão de `cloudDeploy.ts:154-162` (`UPDATE … SET status='<claiming>' WHERE status='<prev>' RETURNING …`); só quem ganhar a linha dispara.

- **🔴 G3 / C3 (HIGH) — a cascata de ondas BYPASSA os gates que o design promete.** O `/run` manual valida `DEPENDENCY_NOT_READY` + `CONTRACT_MISSING` (api_contract.md em disco) — `pipeline.ts:126-204`. Mas a cascata automática de ondas usa `dispatchProjectRun` (`projects.ts:681-701`), e `runnerDispatch.ts:22-72` só checa `RUNNABLE_STATUSES` + existência do spec file — **sem** checar predecessor completo nem contrato. Onda-1+ pode iniciar antes do `api_contract.md` do predecessor estar em disco.
  **Fix:** mover o gate dependência+contrato para dentro de `dispatchProjectRun` (ou fazer a cascata chamar o `/run` endurecido), unificando o invariante nos dois caminhos. **Obs:** o contract check em `pipeline.ts:152-153` é no-op quando `PROJECT_FILES_ROOT`/`HOST_PROJECT_FILES_ROOT` está unset — validar env em prod.

- **G5 (MED) — `status='queued'` VIOLA o CHECK → promover muitas raízes dá 500.** `enqueueOrStart` (`tenantLlmConfig.ts:219-223`) seta `'queued'`, mas esse valor foi dropado na migration 010 e **nunca re-adicionado** (018/036/040 o omitem). Se as raízes excederem `max_concurrent_projects`, o UPDATE para `'queued'` viola o CHECK → 500, e o projeto fica no status anterior; o drainer do watchdog (`watchdog.ts:461-467`) nunca vê. Como "promover produto inteiro" torna estourar o teto o caso comum, isto morde imediatamente.
  **Fix:** nova migration re-adiciona `'queued'` ao `projects_status_check` (DROP IF EXISTS + ADD, idempotente).

- **C4 (MED) — sem claim atômico/idempotência no `/run`.** Double-dispatch possível; 409 é tratado como `dispatched:true` (`runnerDispatch.ts:67`), inconsistente com o 409→500 do enqueue. **Fix:** claim atômico (mesmo padrão de C2) + idempotência por projeto.

- **G7 (LOW) — cascata exige ACCEPT, não COMPLETE.** Decompose cria edges com `trigger_status='accepted'` (`productDecomposer.ts:138-143`); o branch `completed` (`projects.ts:340-344`) nunca dispara para DAGs decompostos — só o accept-cascade (`:683-687`) avança ondas. Se o Cyborg retornar NEEDS_HUMAN ou `specApproved=false`, o produto estaciona a cada fronteira de onda.
  **Fix (UX):** a tela de produto deve mostrar "aguardando aceite" por onda (não é bug de dados; é expectativa a comunicar). Ver U#8 (jargão "onda").

### 7.2 — Ciclo de vida do produto e listagens

- **🔴 C1 / G2 (HIGH→MED) — produto salvo-sem-promover mostra `lifecycle_status='running'` fantasma.** `productDecomposer.ts:150-153` seta `'running'` incondicionalmente; recomputar não resolve porque `deriveProductLifecycle` (`productLifecycle.ts:25-28`) coloca `draft` no conjunto IN_PROGRESS → um produto all-draft lê `running`. O CHECK da migration 037 **não tem** valor para "bancada/rascunho". Resultado: no fluxo B1 (no-dispatch), "Meus Produtos" exibiria o produto como *running* com zero pipelines ativos — invertendo a garantia de visibilidade de stall.
  **Fix:** no caminho no-dispatch, setar `lifecycle_status='ingesting'` **ou** (preferível) adicionar um valor `draft`/`bancada` via nova migration (widen do CHECK 037 primeiro) e tratar all-draft explicitamente em `deriveProductLifecycle`.

- **🔴 U#3 / C5 / G-tenant (HIGH) — "Meus Produtos" fica VAZIO perpétuo para o master.** `GET /api/products` (`routes/products.ts:147-163`) ignora `?tenantId` e retorna `[]` quando `!user.tenantId`. Pior: `GET /api/products/:id` (`:369-378`) e as mutations hardcodam `tenant_id = user.tenantId ?? ''` → master recebe 404. `UUID_RE` não está importado em `products.ts`.
  **Fix (B3 ampliado):** honrar `?tenantId` no LIST **e** no `:id` **e** nas mutations, com guard `UUID_RE` + gate de papel, espelhando `/projects` (`projects.ts:70`) e `/specs` (`specs.ts:466`).

- **G4 / U#1 (MED) — "Meus Projetos só promovidos (status ≥ cto_charter)" NÃO é expressável como escrito, e hoje vaza drafts.** `GET /api/projects` **não tem filtro de status** em nenhum dos três branches (`projects.ts:130/154/178`) e ainda ordena drafts soltos no topo (`product_id IS NULL THEN 0`). Como `status` é `TEXT`+CHECK (migration 040), **não** um enum ordenado, `status >= 'cto_charter'` seria uma comparação **lexicográfica errada** (incluiria `completed`/`devops`, etc.).
  **Fix:** predicado **explícito por conjunto**, `status NOT IN ('draft','spec_submitted','pending_conversion')` (espelhando `SPEC_LISTING_STATUSES`), aplicado aos três branches. Idem para `/products/:id/projects`.

- **U#2 (MED) — falta a view "produto inteiro" só-promovidos.** A página de produto hoje mostraria também os drafts. **Fix:** `/products/:id/projects` aplica o mesmo predicado de promovido de G4.

### 7.3 — Splitter embutido, origem e navegação

- **U#4 / C7 (MED) — "Decompor" numa spec salva cria produto órfão/duplicado.** Não há back-link da decomposição para a spec de origem, e a spec-fonte **nunca é consumida** (fica na Bancada ao lado do produto que ela gerou). **Fix (B4):** ao decompor uma spec salva, (a) checar ownership do tenant sobre a spec-fonte, (b) vincular o produto resultante à spec de origem (via `extra.decomposed_from` / lineage), (c) definir o destino da spec-fonte (arquivar? marcar "decomposta em <produto>"?), (d) tratar **múltiplos** arquivos .md da spec (spec pode ter vários em disco), (e) passthrough de 503 do serviço de propose.

- **U#5 (MED) — remover o menu Splitter perde a porta de entrada "ideia crua / sem spec".** Hoje o Splitter aceita colar um texto do zero. Se ele só existir dentro de uma spec salva, essa via some. **Fix:** manter uma entrada "Decompor uma ideia" na Bancada que **primeiro cria uma spec-rascunho** com o texto colado e então decompõe (mantendo o vínculo de origem de B4). Assim a via rápida continua, mas coerente com o modelo.

- **U#6 (MED) — drilldown de produto no dashboard vira beco-sem-saída** se apontar para uma rota/estado removido. **Fix:** redirecionar o `onFilter → /projects?product=X` do dashboard (`dashboard/page.tsx:387`) para `/products/:id/projects`.

- **U#7 (LOW) — referências mortas:** rotas `/splitter` e `/tenant/projects` continuam vivas mesmo após sair do menu. **Fix:** remover as rotas (ou redirecionar) além de tirar do menu.

- **U#8 (LOW) — não existe endpoint product-promote + jargão "onda" vaza para usuário não-técnico.** **Fix:** criar o endpoint (B2) e, na UI, traduzir "onda 0 / DAG / cascata" para linguagem de negócio ("primeiros módulos", "libera os dependentes ao concluir").

### 7.4 — Migrations e coerência de UI

- **G6 (LOW) — o runner de migrations corrompe uma migration ingênua.** `init.ts:28-41` faz split ingênuo por `;`, sem transação por migration, e grava a versão só após tudo passar.
  **Fix:** qualquer migration nova de B1/B2/B3 usa `IF NOT EXISTS`/`DROP … IF EXISTS` + `ADD`, **sem** `DO $$`, **sem** `;` dentro de string literal ou comentário inline, um statement por `;`. (Ver a lição durável [[genesis-migration-runner-split-semicolon-gotcha]].)

- **U#9/#10/#11 (P2) — polimento:** (#9) meio-estado da proposta efêmera desaparece quando persistirmos os drafts (B1 resolve); (#10) fluxo "nova versão" cruza os dois planos (bancada×fábrica) — decidir se nova versão nasce sempre na Bancada; (#11) coerência de nomes/ícones: "Bancada"/"SPECs"/"Catálogo"; "Projetos" e "Produtos" diferem por uma letra e hoje compartilham `FolderIcon`/cor âmbar → usar ícones e cores distintos.

---

## 8. Concerns REFUTADOS (verificados como seguros)

Registrados porque a intuição sugeria risco, mas o código prova o contrário — **a favor do modelo do Jean**:

1. **Drafts não-disparados NÃO auto-rodam.** Raízes (sem `dependsOn`) não recebem `project_triggers` de entrada, logo não são alvo de cascata; ondas 1+ só disparam quando um predecessor atinge `accepted`, o que não ocorre enquanto nada roda. Nenhum worker pega `draft` (`watchdog` age só em `running`/`queued`/`failed`; `hasConcurrencySlot` conta só `running`). **Salvar centenas de drafts não roda nada.**
2. **`spec_fingerprint` NÃO colapsa em escala.** `projectCreation.ts:138-163` só grava uma referência de proveniência (`extra.reused_from`); o `INSERT` sempre executa; a dup-lookup exige `status IN ('accepted','completed')`, que drafts nunca têm. Centenas de drafts similares não se fundem nem se pulam.
3. **Re-ingest de doc duplicado NÃO cria produtos duplicados** (unique `product_hash` + catch 23505). *(O lado dispatch dessa idempotência é o G1 — corrigido lá.)*
4. **Save-then-promote NÃO viola CHECK nem lineage.** Decompose não passa `parentProjectId` → `version_number=1`, sem contagem de lineage; `draft` é status válido em todo revisão de CHECK, é run-eligible e listável; promover é transição same-row. **Nenhuma constraint violada.** *(Esta é a confirmação-chave de que a fundação aguenta o modelo.)*
5. **Não-dispatch NÃO corrompe `system_id`/Deadpool.** A ligação com o Auto Care usa `products.system_id` no push/accept do GitHub, nunca `lifecycle_status`. Um `lifecycle_status` errado (G2) é defeito de **display**, não de integração.
6. **Master read-only na Bancada funciona; troca de tenant recarrega; atalho express intacto** (UX).

---

## 9. Enriquecimentos propostos (priorizados)

Alavanca comum: **`projects.extra` (JSONB) = zero-migration.** **Regra de ouro:** viabilidade e estimativa são **determinísticas (regex + SQL), sem LLM** — o custo/latência de LLM mataria o "custo ~zero" da Bancada.

| # | Enriquecimento | Valor | Prio / Esforço |
|---|---|---|---|
| E1 | **Triage board** em "Minhas SPECs" (colunas: rascunho · pronto p/ promover · promovido) | Organiza centenas de specs; materializa o "promover só o viável" | P1 / M |
| E2 | **Score de Viabilidade/Prontidão + pré-flight** (tem título? tech definida? contrato p/ deps? estimativa presente?) — determinístico | Sinaliza o que falta antes de queimar fábrica; guia a decisão de promover | P1 / M |
| E3 | **Estimativa de custo/tempo antes de promover** (usa métricas históricas de `pipeline_runs`) | Decisão de promoção informada | P1 / S–M |
| E4 | **Persistir propostas do Splitter como drafts editáveis** (a **alma** do pivô — elimina o proposal efêmero de 30 min) | Desbloqueia o desenho durável; já é B1 | P1 / M–L |
| E5 | **Portfolio / roadmap de ondas por produto** (o que já promoveu, o que falta, quem depende de quem) | Visão de portfólio para escala | P2 / M |

E4 já está no escopo core (B1). E1–E3 e E5 podem ser fases incrementais pós-core.

---

## 10. Sequência de implementação sugerida (após "ship")

Ordem por dependência e risco (fix-first):

1. **B3** (fix `?tenantId` em products — LIST + `:id` + mutations, com `UUID_RE`) — rápido, desbloqueia "Meus Produtos" para o master. *(U#3/C5)*
2. **Migration de constraint** (re-adicionar `'queued'`; opcional widen do lifecycle CHECK para valor draft/bancada) — idempotente, sem `;` em literais. *(G5/G2)*
3. **Endurecer dispatch:** claim atômico + gate dependência/contrato dentro de `dispatchProjectRun` (unifica com `/run`). *(C2/C3/C4/G3)*
4. **B1** (decomposição no-dispatch) + fix do `lifecycle_status` no path no-dispatch. *(G1/G2/C1)*
5. **B2** (endpoint promover-produto, dispatch-only sobre raízes; individual só se deps `accepted`). *(G1/D3)*
6. **B4** (decompor spec salva, com vínculo de origem + ownership + multi-md + 503 passthrough). *(U#4/U#5/C7)*
7. **F4** (menu) → **F1** (Bancada + Splitter embutido) → **F2/F3** (Meus Projetos / Meus Produtos + drilldown) → **F5** (`/autocare`). *(U#1/#2/#6/#7/#8/#11)*
8. **E1–E3, E5** (enriquecimentos) como fases incrementais.

Cada frente: rodar gates (`vitest` + `build`) e uma passada adversarial fix-first antes de considerar pronto. **Deploy é prod outward-facing → exige OK explícito do Jean** (ver [[genesis-prod-deploy-compose-build-based-gotcha]] para rollback ECR + backup DB). Ensinar o aprendizado ao Genesis e ao Deadpool depois (ver [[feedback-ensinar-aprendizados-genesis-deadpool]]).

## 11. Governança / decisão em aberto para o Jean

- **C6 — Promover é "operação" ou "autoria"?** O `POST /api/projects/:id/run` é intencionalmente **não** coberto pelo `denyCreationForManagement` (RFC-0002 §A.1: o watchdog cunha token `zentriz_admin` e chama `/run`; um 403 cego mataria a promoção da fila). Logo, hoje o master **pode** promover.
  **Recomendação deste RFC:** tratar promover como **operação de ciclo de vida** (master pode, desde que com tenant selecionado e ownership válido) — coerente com RFC-0002, que já classifica `/run` como alavanca operacional. Se o Jean quiser que o master **não** promova, isso exige separar a promoção via UI (autoria) do `/run` interno (máquina) — provavelmente via role de serviço dedicada (`sub:"watchdog" → role:"service"`), nunca bloqueando `/run` por papel. **Preciso da decisão do Jean antes de codificar B2.**

## 12. Riscos e mitigação (resumo)

| Risco | Mitigação |
|---|---|
| Promoção silenciosamente no-op (G1) | Path dispatch-only sobre linhas existentes; nunca re-decompor |
| Concorrência furada em massa (C2) | Claim atômico estilo `cloudDeploy` |
| Onda 1+ sem contrato do predecessor (G3/C3) | Gate unificado dentro de `dispatchProjectRun` |
| 500 ao promover muitas raízes (G5) | Migration re-adiciona `'queued'` ao CHECK |
| Produto "running" fantasma (C1/G2) | `ingesting`/valor `draft` no path no-dispatch |
| "Meus Produtos" vazio p/ master (U#3/C5) | B3 completo (LIST+:id+mutations, `UUID_RE`) |
| Drafts vazando em Meus Projetos (G4) | Predicado explícito `status NOT IN (pré-fábrica)` |
| Migration corrompida pelo split ingênuo (G6) | `IF NOT EXISTS`, sem `DO $$`, sem `;` em literais |

---

*Próximo passo: revisão e fechamento pelo Jean. Nenhum desenvolvimento inicia antes do "ship" explícito.*
