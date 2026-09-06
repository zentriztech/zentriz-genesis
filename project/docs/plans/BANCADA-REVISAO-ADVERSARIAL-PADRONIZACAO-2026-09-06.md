> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Bancada e telas irmãs — revisão adversarial + padronização de recursos e ações

**Data:** 2026-09-06 · **Repo:** `zentriz-genesis` · **Branch de trabalho:** `dev`

Pedido do Jean (verbatim):

> "revise a bancada e suas telas adversarial e padronize o uso dos recursos e acoes, quando aacabar
> o que está fazendo... alinhar as banchs e deploy;"

Escopo revisado: `app/(dashboard)/spec/page.tsx` (Bancada, 4.255 linhas), `specs/page.tsx` (1.377),
`products/page.tsx` (514), `projects/[id]/page.tsx` (3.156) e os componentes compartilhados
(`PromotionPlanDialog`, `SpecTreePanel`, `SpecValidationPanel`, …) — mais as rotas que elas chamam.

---

## 1. Inventário medido (ação → recurso → guarda → feedback)

| Tela | Ação (rótulo atual) | Recurso | Guarda | Feedback |
|------|--------------------|---------|--------|----------|
| Bancada | `Promover à Fábrica` (`spec:1082,3823`) | `PATCH /projects/:id/spec-content` + **`POST /products/:id/promote`** *ou* `POST /projects/:id/promote` (`spec:3159-3206`) | digitar `PROMOVER` **só se** GAPs > 0 | `PromotionPlanDialog` ou mensagem no chat |
| Bancada | `Salvar rascunho` (`spec:4051`) | `PATCH /projects/:id/spec-content` (`startNow:false`) | — | chat + revalidação |
| Bancada | (morto) `handleSaveSpec(true)` / `handleUploadSubmit(e,true)` | `POST /projects/:id/run` (`spec:3134,3331`) | — | navega para o projeto |
| `/specs` | `Promover à fábrica` (spec) (`specs:621,1043`) | `POST /projects/:id/promote` | diálogo com certificado/estimativa | `notice` verde |
| `/specs` | `Promover produto inteiro` (`specs:879`) | `POST /products/:id/promote` | **nenhuma** | `notice` + plano |
| `/products` | `Promover à fábrica` (`products:368`) | `POST /products/:id/promote` | **nenhuma** | `notice` + plano |
| `/products` | `Iniciar produto` (`products:386`) | `POST /products/:id/start` | **nenhuma**, sem ver a ordem | `notice` **sempre verde** |
| `/products` | `Ver ordem` / `Devolver` | `GET /promotion` / `POST /unpromote` | nenhuma | `notice` |
| `/products` | ícone lixeira | `DELETE /products/:id` | digitar o **ID** + ciente | `notice` |
| `PromotionPlanDialog` | `Iniciar onda N` | `POST /products/:id/start` | o próprio diálogo (mostra o plano) | `describeStartResult` (severidade correta) |
| `/projects/:id` | `Iniciar` / `Reiniciar` | `POST /projects/:id/run` | nenhuma (modal só se há tasks) | `runError` |
| `/projects/:id` | `Interromper Com Segurança` | `POST /projects/:id/stop` | confirmação | recarrega |
| `/projects/:id` | `Interromper Imediatamente` | `POST /projects/:id/stop` (**a mesma**) | confirmação crítica | recarrega |
| `/projects/:id` | `Rejeitar` / `Excluir …` | `POST /reject` / `DELETE /projects/:id` | confirmação | navega |

---

## 2. Achados adversariais

### B1 🔴 A Bancada promove o PRODUTO TODO com o rótulo e a confirmação de UMA spec
`promoteToFactory` (`spec:3179`) decide o escopo **depois** do clique: se a spec pertence a um produto
real, dispara `POST /products/:id/promote` — que admite **todos** os projetos do produto em ondas. O
botão diz apenas `Promover à Fábrica` (`spec:1082,3823`) e o diálogo de confirmação
(`spec:3648-3690`) fala só dos GAPs **desta** spec. Resultado: o usuário admite N projetos (e paga o
LLM do arquiteto) acreditando estar promovendo um arquivo. **Prova:** o mesmo rótulo em `/specs:621`
promove **uma** spec — dois botões idênticos, escopos diferentes.

### B2 🔴 `Interromper Com Segurança` mente — as duas opções chamam a MESMA rota
`handleStopSafe` e `handleStopNow` (`projects/[id]:881-892`) postam `POST /projects/:id/stop` com
corpo idêntico. A rota (`routes/pipeline.ts:503`) repassa ao runner, e o runner
(`orchestrator/runner_server.py:529`) faz **SIGTERM escalando para SIGKILL**. Não existe parada
graciosa em lugar nenhum do caminho. A promessa "⏳ o pipeline aguardará a task atual finalizar" é
falsa e induz o usuário à opção *errada* quando ele quer preservar artefatos.

### B3 🔴 `/products`: início que FALHOU aparece em alerta VERDE
`startProduct` copia a mensagem de `describeStartResult` para `notice` (`products:188`), e o alerta de
página é fixo `severity="success"` (`products:275`). É o defeito #2 da frente 097 sobrevivendo **fora**
do diálogo: com todos os projetos recusados por gate (`SPEC_NOT_VALIDATED`, medido em prod) a página
comemora em verde uma onda que não entrou.

### B4 🟠 A Bancada ignora o escopo de tenant do master
Quatro fetches de produtos na Bancada usam a string crua `"/api/products?includeInbox=1"`
(`spec:2056,3174,3959,4114`), sem `withQuery` e **sem `tenantId`**. Em `GET /api/products`
(`routes/products.ts`), `zentriz_admin` **sem** `tenantId` recebe os produtos de **todos** os tenants.
`/specs:352` e `/products:115` escopam corretamente com `withQuery(... tenantScopeStore.selectedTenantId)`.
A Bancada é a única que não — o master vê/seleciona produto de outro tenant no editor.

### B5 🟠 Caminho morto que INICIA a fábrica direto da Bancada
`handleSaveSpec(startNow)` só é chamado com `false` (`spec:2403,4051`) e `handleUploadSubmit` só com o
default `false` (`spec:4091,4215`). Logo `POST /projects/:id/run` em `spec:3134` e `spec:3331` e o
`startNow:true` do `PATCH spec-content` são **inalcançáveis** — mas continuam no arquivo, prontos para
o próximo dev religar e reabrir exatamente o requisito que a migração 097 fechou ("promover ≠ iniciar").

### B6 🟠 `Iniciar produto` mente sobre o escopo
`POST /products/:id/start` (`dispatchPromotionWave`) dispara **só a onda pendente mais baixa** — é o que
o próprio diálogo diz honestamente (`Iniciar onda N`). O botão de `/products:386` diz `Iniciar produto`
e nem mostra a ordem antes de disparar: o usuário inicia às cegas um plano que não viu.

### B7 🟠 A escada de guardas está invertida
Promover é **barato e reversível** (`unpromote` existe) e exige digitar `PROMOVER` na Bancada; iniciar
**gasta a fábrica** (LLM de todos os agentes, deploy) e não pede nada em nenhuma tela. Pior: o mesmo
`POST /products/:id/promote` é 1 clique sem confirmação em `/specs:879` e `/products:366`.

### B8 🟡 Quatro rótulos para duas ações (e um Title Case solitário)
`Promover à Fábrica` (Bancada) · `Promover à fábrica` (`/specs`, `/products`) · `Promover produto
inteiro` · `Promover agora`. E o menu de `/projects/:id` usa Title Case (`Interromper Com Segurança`,
`Excluir e Manter Arquivos`) contra o *sentence case* do resto do portal.

### B9 🟡 Recurso duplicado no cliente
`PATCH /projects/:id/spec-content` montado em dois lugares na Bancada (`spec:3054` e `spec:3159`);
`/api/products?includeInbox=1` em quatro; o texto "produto admitido… nada foi iniciado" existe em três
cópias divergentes (`spec:3198`, `specs:448`, `products:140`).

### Refutados na revisão (registro para não voltarem)
- **"`/projects/:id` iniciar um projeto `promoted` fura a ordem do plano"** — não fura:
  `dispatchProjectRun` aplica `DEPENDENCY_NOT_READY`; a barreira é o gate, não a tela.
- **"`describeStartResult` ainda adivinha motivo"** — não: usa o `reason` do servidor (frente 097).
- **"`/specs` inicia sem mostrar a ordem"** — não: o start de `/specs` só existe dentro do
  `PromotionPlanDialog`.

---

## 3. Padrão adotado (o que "padronizado" passa a significar)

1. **Um recurso por ação, um chamador por recurso.** Cada ação de fábrica tem UM helper na tela; a
   montagem do corpo do request não se repete.
2. **Rótulo = escopo real.** Fonte única em `lib/factoryActions.ts`:
   `Promover produto inteiro` · `Promover esta spec` · `Iniciar onda N` · `Ver ordem` ·
   `Devolver à Bancada` · `Interromper execução`. *Sentence case* em todo o portal.
3. **Escada de guardas por CONSEQUÊNCIA** (não por hábito da tela):
   - **N0 — sem confirmação:** leitura, salvar rascunho, navegação.
   - **N1 — confirmação simples** (`ConfirmActionDialog`): promover produto inteiro (admite N
     projetos + custo de LLM do arquiteto), devolver à Bancada, interromper execução.
   - **N2 — confirmação por digitação:** apagar produto/projeto (ID) e promover com GAPs abertos
     (palavra `PROMOVER`) — o único caso em que o risco é de **conteúdo**, não de estado.
   - **Iniciar** exige **ver a ordem primeiro**: o `PromotionPlanDialog` É a confirmação (mostra
     onda, dependências, quem decidiu). Nenhuma tela dispara `/start` às cegas.
4. **Feedback:** mensagem e severidade vêm sempre do servidor (`describeStartResult`, `ApiError`).
   Nenhum alerta verde para resultado que não aconteceu; nenhum texto de resultado duplicado.
5. **Escopo de tenant:** todo `GET` de lista usa `withQuery` + `tenantScopeStore.selectedTenantId`.

---

## 4. Mudanças de código (todas nesta frente)

| # | Arquivo | Mudança |
|---|---------|---------|
| 1 | `lib/factoryActions.ts` (**novo**) | rótulos/tooltips/copy canônicos + `promoteProductConfirm()` + `promotedNotice()` |
| 2 | `components/ConfirmActionDialog.tsx` (**novo**) | confirmação padrão N1/N2 (simples ou por digitação) |
| 3 | `app/(dashboard)/spec/page.tsx` | B1 (rótulo/confirmação com escopo real vindo de `/api/projects/:id`), B4 (`withQuery`+tenant, um `reloadProducts`), B5 (mata `startNow:true` e os dois `/run`), B9 (`persistSpecMarkdown` único), B8 |
| 4 | `app/(dashboard)/specs/page.tsx` | B7 (confirmação N1 no promover produto), B8 |
| 5 | `app/(dashboard)/products/page.tsx` | B3 (severidade honesta), B6 (`Ver ordem e iniciar` → plano), B7 (N1 em promover/devolver), B8 |
| 6 | `app/(dashboard)/projects/[id]/page.tsx` | B2 (um único `Interromper execução`, texto verdadeiro), B8 (sentence case) |
| 7 | `components/PromotionPlanDialog.tsx` | rótulos do módulo compartilhado |

**Trade-off assumido (B6):** `/products` perde o start de 1 clique — passa a abrir o plano e iniciar de
dentro dele. Um clique a mais em troca de nunca iniciar às cegas um plano que o usuário não viu.

**Risco residual (B1):** o rótulo/confirmação usa o dono conhecido no carregamento; a promoção relê o
dono na **fonte autoritativa** no ato. Se o vínculo mudar entre as duas coisas (outra aba), a
confirmação pode falar de "spec" e o servidor promover o produto — o `PromotionPlanDialog` que abre em
seguida mostra exatamente o que foi admitido. Aceito e registrado.

---

## 5. Gates de entrega

`tsc --noEmit` (api + web) · `vitest run` (api) · `next build` · eslint nos arquivos tocados ·
commit em `dev` → merge `--no-ff` em `main` → push · deploy ECR (`genesis-web`; `api` só se mudar) com
tag de rollback e **digest verificado** · prova ao vivo em prod · memória (LEI 0).

> `genesis-web` **não tem test runner** (`scripts`: dev/build/start/lint) — os helpers novos são
> puros e cobertos por `tsc` + `next build` + prova ao vivo.

---

## 6. Execução — o que foi feito (2026-09-06)

Todas as sete mudanças da §4 estão implementadas. Detalhes que só apareceram ao escrever o código:

- **B4 tinha uma corrida escondida:** o `useEffect` do `app/(dashboard)/layout.tsx` (que chama
  `tenantScopeStore.hydrate()`) roda **depois** dos efeitos dos filhos. `/products` sobrevive porque é
  `observer` e refaz o fetch quando o escopo muda; `/spec` **não é** `observer` → a primeira carga
  sairia sem `tenantId` mesmo com `withQuery`. `reloadProducts` chama `hydrate()` (idempotente) antes
  de ler o escopo.
- **B1 ficou em duas camadas:** `promoteScope` (rótulo/tooltip/confirmação) vem de
  `GET /api/projects/:id` — a MESMA rota autoritativa que `promoteToFactory` relê no clique — e não do
  `?productId=` da URL. Enquanto o escopo é desconhecido (`null`), o rótulo é o genérico
  "Promover à fábrica" e a guarda **sobe** para confirmação: a Bancada não afirma escopo que não sabe.
- **B7 mudou o gatilho da guarda:** promover uma spec do INBOX sem GAPs segue direto (N0, reversível);
  produto inteiro **ou escopo desconhecido** pede N1; GAPs abertos pedem N2 (`PROMOVER`).
- **B5 removeu 2 `POST /run` e 1 parâmetro:** `handleSaveSpec(startNow)` → `handleSaveSpec()` e
  `handleUploadSubmit(e, startNow)` → `handleUploadSubmit(e)`. O upload agora sempre marca
  `draft=true` (antes o `draft` era condicional a um `startNow` que nunca chegava `true`).
- **B9:** `persistSpecMarkdown()` é o único `PATCH /spec-content` da Bancada (salvar e promover
  usam-no) e os quatro fetches de produto viraram um `reloadProducts()`.

**Gates executados:** `tsc --noEmit` limpo (web + api) · `vitest run` da api **125 arquivos /
1519 testes passando** · `next build` OK (`/spec` 57,8 kB) · `next lint` nos 7 arquivos: nenhum erro,
só 2 avisos `exhaustive-deps` **pré-existentes**.
