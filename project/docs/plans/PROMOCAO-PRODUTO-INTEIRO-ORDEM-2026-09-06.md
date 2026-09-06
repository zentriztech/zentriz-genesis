> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Promover à Fábrica = o PRODUTO TODO, na ordem de interdependência, sem iniciar

**Data:** 2026-09-06 · **Repo:** `zentriz-genesis` · **Branch de trabalho:** `dev`

Requisito do Jean (verbatim):

> "a fabrica recebi tudo os arquivos e todos os projetos que compoe o produto, mas tem que lembrar que
> quando temos projetos que dependem um do outro deve ser inserido na fabrica na ordem, por ex: um
> dashboard que tem um backend que tem databases, devemos enviar na ordem de interdependencias; eu
> acredito que a ordem de desenvolver um produtos é: Db > projetos ou camadas de acesso ao DB > Backend >
> devops; acredito que os projetos de DB e backends (microsservicoes) seja o ideal, mas pesquise os
> padroes internacionais; e os projetos devem ser promovidos a fabrica mas nao inciados automaticamente;"

---

## 1. Estado ANTES (medido, não presumido)

### 1.1 ✅ "Todos os arquivos" — JÁ FUNCIONA (diagnóstico anterior REFUTADO)

Eu havia registrado que o `LIMIT 1` de `services/runnerDispatch.ts:84` fazia a fábrica receber **só o
índice** da spec dividida. **Isso está ERRADO** e fica corrigido aqui.

O runner **não usa** o `specPath` para ler conteúdo quando há `PROJECT_ID`: `orchestrator/runner.py:4604`
chama `load_spec_all(project_id)` (`runner.py:839`), que faz `GET /api/projects/:id/spec-files`
(`routes/projects.ts:3159`, **sem `LIMIT`**, `ORDER BY created_at ASC`), lê cada `filePath` do disco e
concatena com cabeçalho `# [rel_dir/arquivo]`. O `specPath` do dispatch só serve como `spec_ref`
(rótulo) e como **fallback** se a lista vier vazia.

**Prova ao vivo em PROD (2026-09-06)** — token de máquina cunhado no container da api, consulta feita de
**dentro do container do runner** (`NVX LastMile e2a1988c`):

```
arquivos retornados: 11
OK PRIM  29990 nvx-lastmile-backend.md      OK  64402 modelo-dados.md
OK       28829 visao-escopo.md              OK  64584 contratos-erros.md
OK       49183 privacidade-lgpd.md          OK  62804 autenticacao-sessao.md
OK       33950 definicao-de-pronto.md       OK  27982 infraestrutura-deploy.md
OK       22991 observabilidade-operacao.md  OK  45320 api-entregas-entregadores.md
OK       47931 connect-interoperabilidade.md
total bytes visiveis ao runner: 477966 | ausentes: 0
```

Ou seja: os 11 arquivos (478 KB) estão visíveis ao runner nos MESMOS caminhos absolutos que a api
reporta, porque `UPLOAD_DIR == RUNNER_UPLOAD_DIR == /shared/uploads` e o volume
`zentriz-genesis_uploads` é montado nos dois (`docker-compose.yml:80,248`).

**Conclusão:** requisito 1 já está satisfeito. **Nada a corrigir** no `LIMIT 1` além de comentar o
código para o próximo leitor não repetir meu erro. Único risco remanescente (registrado, não corrigido
aqui): se algum dia `RUNNER_UPLOAD_DIR ≠ UPLOAD_DIR`, o `load_spec_all` cai silenciosamente no fallback
de 1 arquivo — a tradução de caminho existe no `runBody` e **não** existe no `load_spec_all`.

### 1.2 🔴 "Todos os projetos" — FALSO hoje

`POST /api/products/:id/promote` (`routes/products.ts:1001`) promove **só as raízes**
(`NOT EXISTS` em `project_triggers`) e **dispara** cada uma (`dispatchProjectRun` em `setImmediate`).
As ondas seguintes só entram por **cascata de `accept`**. Logo:
- projeto não-raiz **não** é promovido (fica `draft` até o predecessor ser aceito);
- o produto vira `lifecycle_status = 'running'` **mesmo que nada tenha rodado**.

### 1.3 🔴 "Não iniciar automaticamente" — FALSO hoje

Dois caminhos iniciam na hora:
- Bancada: botão **`Promover à Fábrica`** → `PATCH /api/projects/:id/spec-content {startNow:true}` →
  `dispatchProjectRun` do **projeto atual, sozinho**;
- `/promote` do produto: dispara as raízes.

### 1.4 Restrições descobertas (impactam o desenho)

- **`queued` NÃO serve** como "promovido e parado": o watchdog G39 (`services/watchdog.ts:552`) drena
  `status='queued'` chamando `/run` sozinho. Precisa de estado NOVO.
- **`deriveProductLifecycle`** (`services/productLifecycle.ts:35`) recomputa `lifecycle_status` a cada
  accept/reject; sem ensinar o estado novo, ele **sobrescreve** a promoção.
- **Canal de agente sem tocar Python:** `POST {API_AGENTS_URL}/invoke/raw` (síncrono) já é usado pela
  api (`specSemanticGate.ts`, `specGapScope.ts`) com `httpPost` (http nativo — `fetch`+`AbortController`
  aborta cedo dentro do Docker no Node 20). LLM do tenant via `resolveWorkbenchLlm` + `agentsLlmFields`.
  A resposta traz `usage`/`stop_reason` → dá para debitar em `project_agent_metrics` (fecha G5).
- **Modelo de arestas:** `project_triggers` (populado) é a fonte de dependência; `project_links` está
  VAZIA em prod.

---

## 2. Padrões internacionais (o que a literatura manda — pesquisa pedida pelo Jean)

1. **A ordem real é o GRAFO, não uma lista de camadas.** Argo CD executa por
   *phase* (PreSync → Sync → PostSync) → *sync wave* (número, ascendente) → *kind* → *name*, e
   **espera a onda ficar saudável** antes de liberar a próxima; migração de banco é o caso canônico de
   onda negativa (pré-Sync). Terraform (grafo implícito), Helm (hook weights) e o *reactor* do
   Maven/Bazel são a mesma ideia: **ordenação topológica de um DAG + barreira entre estágios**.
2. **Provider antes de consumer, para MUDANÇA.** *ParallelChange / expand–contract* (Martin Fowler):
   **expandir** o provedor (schema/API aceita o velho e o novo) → **migrar** os consumidores →
   **contrair** o provedor. É daqui que sai, de forma defensável, "DB/contrato antes de quem consome".
3. **Ordem não é a rede de segurança — compatibilidade verificada é.** Pact (`record-deployment` +
   `can-i-deploy`) **não** exige provider-antes-de-consumer no deploy: exige provar compatibilidade
   antes de cada deploy, o que libera deploys independentes. No nosso caso o equivalente é o
   **Connect** (manifests/contratos) + o gate `DEPENDENCY_NOT_READY`.

**Veredito sobre o palpite do Jean** (`DB > camada de acesso > Backend > devops`): correto no miolo, com
duas correções:
- **"devops" se divide em dois**: *provisionamento/plataforma* (rede, cluster, engine do banco) vem
  **antes** do banco; *entrega/observabilidade* (CI/CD, dashboards, alertas) vem **depois** dos apps —
  não há o que observar antes.
- **contrato vem primeiro** (API-first): é literalmente o papel do Connect no ecossistema.

**Ordem-padrão de camadas (só como critério de desempate quando o grafo não tem aresta):**

```
1 contratos (Connect/OpenAPI)      5 backend/microsserviços (provedor antes de consumidor)
2 plataforma/infra (IaC)           6 gateway/BFF/integrações
3 banco + migrações                7 frontend/dashboard/mobile
4 acesso a dados/libs/SDK          8 entrega & observabilidade (CI/CD, dashboards)
```

**Regra final adotada:** ordenação topológica do DAG real (`project_triggers` + arestas que o agente
inferir da spec) e, **para empates**, a ordem de camadas acima. Barreira entre ondas = o gate de
dependência que já existe.

---

## 3. Desenho

### 3.1 Estado novo: `promoted` ("na fábrica, aguardando início")

- `projects.status = 'promoted'` — admitido, **não** disparado. Elegível a `/run` (é assim que inicia).
- `products.lifecycle_status = 'promoted'` — todos os projetos em `{draft, promoted}` com ≥1 `promoted`.
- **Não** entra em `SPEC_EDITABLE_STATUSES`: promovido é congelado (o hash aprovado tem de valer). A
  saída é `unpromote` (volta a `draft`), para não trancar o Jean.

### 3.2 Plano de promoção decidido por AGENTE (lei do 100% LLM)

`services/promotionPlanner.ts`:
1. monta o retrato do produto: projetos (título, tipo, arquétipo, resumo do índice da spec) + arestas
   conhecidas de `project_triggers`;
2. pergunta ao agente (via `/invoke/raw`, JSON estrito): `order[]` (position, wave, layer, project_id,
   depends_on[], rationale) + `notes`;
3. **o código VETA corrupção** (não inventa ordem):
   - id inexistente / faltando / duplicado → falha;
   - ciclo no grafo declarado → falha;
   - projeto sem arquivo de spec → falha;
   - agents fora / JSON inválido / resposta cortada no teto → **falha** (sem fallback burro: a ação
     não acontece).

> **DESVIO da implementação vs. o plano original (A5) — FATO VENCE OPINIÃO, sem abortar.**
> O plano dizia "ordem que viola aresta conhecida de `project_triggers` → falha". Na implementação
> (`orderIntoWaves`) a aresta do banco é **aplicada** ao grafo efetivo e a divergência vira
> `warning` no plano, em vez de recusar a promoção. Por quê: a aresta do banco é **fato**, o
> conserto é **determinístico** (recomputar a onda por Kahn) e abortar puniria o Jean por um detalhe
> recuperável — enquanto a UI mostra exatamente o que foi ajustado ("aresta do banco não declarada
> pelo agente aplicada: X depende de Y"). O que continua sendo falha dura é o que **não** tem
> conserto determinístico: ciclo, id de fora do produto, ordem incompleta, projeto sem spec, agente
> indisponível. Provado em `services/promotionPlanner.test.ts` ("FATO vence OPINIÃO").
>
> Outros dois desvios menores, na mesma direção (falhar só quando não há verdade recuperável):
> • **produto de 1 projeto não paga LLM** — não há ordem a decidir; o plano nasce trivial com
>   `modelUsed: null` (mesma disciplina do GAP-12 do `productContext`);
> • **teto `MAX_PROJECTS = 60`** → `TOO_MANY_PROJECTS` antes de qualquer leitura de spec (o maior
>   produto real, Venuxx V2, tem 28), para um produto absurdo não estourar o contexto do arquiteto.

### 3.3 Rotas

- `POST /api/products/:id/promote` — passa a promover **todos** os projetos `draft` do produto, na ordem
  do plano, **sem disparar**. Grava `product_promotions` + `product_promotion_items`, projetos →
  `promoted`, produto → `promoted`, emite `spec_promoted`. `{start:true}` no corpo = comportamento
  antigo (promove e dispara a onda 1) para quem quiser explicitamente.
- `POST /api/products/:id/start` — dispara **só a onda 1** do plano; as seguintes entram pela cascata de
  accept, cada uma pelo gate de dependência.
- `POST /api/products/:id/unpromote` — `promoted → draft` (produto e projetos), plano `canceled`.
- `GET /api/products/:id/promotion` — plano vigente (para a UI mostrar a ordem).
- **`POST /api/projects/:id/promote` (rota NOVA, não prevista no plano)** — admite **um** projeto na
  fábrica (`draft → promoted`) sem iniciar nada. Foi preciso criá-la porque o caminho atômico (spec
  solta, App do INBOX) só tinha `/run` — e `/run` **inicia**: sem esta rota, "promovido mas não
  iniciado" seria mentira justamente no caso mais comum da Bancada. Detalhes de desenho:
  - **não** consulta LLM e **não** aplica gate de dependência — não há ordem a decidir num projeto
    só, e a dependência é verificada no **início** (`dispatchProjectRun`), não na admissão;
  - aplica o gate de conteúdo (`checkSpecContentReady`) e exige arquivo de spec;
  - **gradua o App do INBOX no ato da admissão** (`graduateFromInbox`), mantendo a invariante da
    migração 064: projeto em fábrica nunca mora no INBOX;
  - idempotente (`promoted` → 200 `alreadyPromoted`), 409 `NOT_ON_WORKBENCH` fora de `draft`;
  - recomputa o ciclo de vida do produto e emite `spec_promoted` com `started: false`.
  Provada em `routes/pipeline.promote.test.ts` (inclui "ZERO disparo do runner").

### 3.4 UI

- Bancada (`/spec`): `Promover à Fábrica` **salva a spec** (`startNow: false`) e então:
  dono é produto real → `POST /api/products/:id/promote` (o **produto todo**, em ondas) e abre o
  `PromotionPlanDialog` com a ordem; dono é o INBOX "Rascunhos" (que **não** é produto) → `POST
  /api/projects/:id/promote`, só aquela spec. Nos dois casos **nada inicia**. O dono vem do
  `GET /api/projects/:id` (autoritativo) — não do `?productId=` da URL, que é só navegação.
- `/specs`: promover individual usa `/promote` (a spec sai da lista e vai para a coluna "Promovido");
  promover produto abre o mesmo diálogo de ondas.
- `/products`: chip `Promovido — aguardando início` + ações `Iniciar produto` / `Ver ordem` /
  `Devolver`.
- `/projects/:id`: `promoted` entra em `ALLOW_RUN_STATUS` → botão `Iniciar` aparece (sem isto o único
  caminho de início seria o `/start` do produto e o projeto ficaria parado sem ação na tela dele).
- `components/PromotionPlanDialog.tsx` (compartilhado pelas três telas): **não reordena, não infere
  camada, não esconde item** — renderiza o que o servidor mandou, mostra `warnings`, `dependsOn`,
  `rationale`, a origem das arestas e o modelo, e o botão inicia **só a onda pendente mais baixa**.

### 3.5 Migração 097

`projects_status_check` + `products_lifecycle_status_check` ganham `'promoted'`; tabelas
`product_promotions` / `product_promotion_items`. Sem `;` dentro de literal (runner de migração faz split
ingênuo por `;`).

---

## 4. Revisão adversarial do próprio plano

| # | Risco | Resposta |
|---|-------|----------|
| A1 | Estado novo quebra CHECK em prod se a api subir antes da migração | Migração roda no boot da api, **antes** de qualquer UPDATE; nenhum código escreve `promoted` sem a migração aplicada |
| A2 | `deriveProductLifecycle` sobrescreve `promoted` | Ensinar a função + teste unitário dedicado |
| A3 | Watchdog "adota" projeto `promoted` e inicia sozinho | G39 só drena `queued`; `getOrphanProjects` só olha `running`. `promoted` fica inerte — asseverado por teste |
| A4 | Promoção em bloco vira gasto de LLM em cascata | Promover **não dispara**; só `start` dispara, e a onda 1 passa pelo cost cap/slot do `dispatchProjectRun` |
| A5 | Agente inventa ordem errada e a fábrica constrói fora de ordem | Veto de código: ciclo, id inválido, ordem incompleta → falha honesta. Aresta de `project_triggers` que o agente ignorou é **aplicada** e vira `warning` visível (desvio documentado em §3.2) — a ordem final **nunca** contraria o fato do banco |
| A6 | Sem agents, o produto fica sem promover | Correto e desejado (lei do Jean): falha explícita, mensagem clara, nada acontece |
| A7 | Congelar a spec no `promoted` tranca o usuário | `unpromote` devolve à Bancada |
| A8 | Teste existente espera `lifecycleStatus:"running"` no promote | Atualizar o teste — a mudança de contrato é intencional e pedida |
| A9 | Produto sem aresta nenhuma (todos raiz) | A ordem sai do desempate por camada; o plano registra `edges_source:"agent"` |
| A10 | Custo do planejador invisível | Debitar `usage` do `/invoke/raw` em `project_agent_metrics` (agent `promotion_planner`) |

## 5. Gates de entrega

**Estado dos gates (2026-09-06):** api `tsc --noEmit` ✅ · web `tsc --noEmit` ✅ · `vitest run` ✅
**1516 passed / 125 arquivos** (novos: `services/promotionPlanner.test.ts` 19 casos ·
`routes/pipeline.promote.test.ts` 8 casos · `productLifecycle.test.ts` +4 casos de `promoted` ·
`routes/products.test.ts` já reescrito para o contrato novo, A8 fechado) · `next build` ✅ ·
eslint nos arquivos tocados: **0 erros** (2 warnings pré-existentes de `exhaustive-deps`).
**A3 (watchdog inerte) é por construção, verificado no código:** `MILESTONE_STATUSES` = apenas
`cto_charter/pm_backlog/dev_qa/devops`, `getOrphanProjects` só olha `running`, o drenador G39 só
`queued` — nenhuma varredura toca `promoted`.

`tsc --noEmit` · `vitest` (novos testes: planner, veto de ciclo, lifecycle, watchdog inerte, rotas) ·
`next build` · commit em `dev` → merge `--no-ff` em `main` → push · deploy ECR (api + genesis-web) com
tag de rollback · verificar digest + prova ao vivo em prod (migração aplicada, promover produto real
**sem** disparar run) · memória (LEI 0).
