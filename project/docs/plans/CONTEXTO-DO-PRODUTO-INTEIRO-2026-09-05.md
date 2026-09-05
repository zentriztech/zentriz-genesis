> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# A LLM tem que conhecer o Produto inteiro — desenho v1 (pesquisa + adversarial + GAPs)

> **Status:** pesquisa medida em PROD + revisão adversarial + GAPs → **aguardando decisões D1–D4 do
> Jean. NADA implementado.**
> **Origem (verbatim, 2026-09-05):** *"lembre-se que em um Produto de Spec com diversos projetos e
> arquivos deve existir uma maneira da LLM conhecer tudo para poder trabalhar de forma coesa e
> entregar as evoluções e correções solicitadas ou detectadas."*
> **Frente anterior (fechada):** `AGENTES-ORCAMENTO-DE-CONTEXTO-2026-09-05.md` — o montador de prompt
> já entrega a spec inteira ao CTO (cap 145.600 no Opus 5). Esta frente é o passo seguinte: o CTO
> recebe **um** documento inteiro; falta ele conhecer os **irmãos**.

---

## 1. Fatos medidos em PROD (2026-09-05, não estimativas)

### 1.1 A hierarquia real do banco

13 produtos. Distribuição de projetos por produto: **28, 9, 7, 3, 3** e **oito com 1**.

| Produto | Projetos | Arquivos de spec | Bytes legíveis |
|---|---|---|---|
| Venuxx V2 (`9c1cc97e`) | **28** | 28 | **0 — nenhum legível (§1.4)** |
| OrienteMe Demo (`cae20ef3`) | 9 | 9 | 207.492 |
| ZVoices — fatia vertical (`05cb1b40`) | 7 | 7 | 116.954 |
| Cargobox Fulfillment (`a7eb80f8`) | 3 | 3 | 119.973 |
| MoneyFlow (`e5a83f6f`) | 3 | 3 | 66.843 |
| 8 produtos de 1 projeto | 1 cada | 1 cada | 106 – 40.702 |

**Total no disco: 631.027 bytes em 58 arquivos.**

### 1.2 O mecanismo de irmãos é código morto na prática

`loadChatContext` (`routes/specChat.ts:126`) só monta o bloco de irmãos `if (current.files.length > 1)`.
Medido: **58 de 58 projetos têm exatamente 1 arquivo de spec.** A condição **nunca é verdadeira em
produção**. O bloco de irmãos existe, é testado, e **nunca rodou com dado real**.

Ao mesmo tempo, **50 dos 58 projetos têm irmãos no mesmo produto** — que é justamente o eixo que o
código não olha.

### 1.3 Os 3 defeitos já registrados, agora com número

| # | Defeito | Evidência |
|---|---|---|
| **A** | **Escopo é o PROJETO, não o PRODUTO.** `computeCurrentSpecHash` faz `WHERE project_id = $1` → "irmão" = outro arquivo do mesmo projeto (que não existe, §1.2). Specs de projetos irmãos do mesmo produto são **invisíveis**. | `specValidation.ts:119` |
| **B** | **`SIBLINGS_BUDGET = 14.000` para TODOS os irmãos somados** — 10× menor que o cap principal (145.600) liberado ontem. Corta no meio do arquivo com `…(truncado)…`. | `specChat.ts:104` |
| **C** | **`sibling_files_context` e `validation_report` são INERTES em `inputs`** — `build_user_message` nunca emitiu esses campos. Só chegam ao modelo porque a api **também** os cola dentro do `task` (`specChat.ts:291`). Mesma classe do bug do envelope aninhado. | `runtime.py` |

### 1.4 🔴 Defeito D (NOVO, achado nesta pesquisa): 28 `file_path` relativos matam o maior produto

`project_spec_files.file_path` de **28 das 58 linhas é RELATIVO** (`specs/core.md`, `specs/tms.md`, …)
— as outras 30 são absolutas (`/shared/uploads/<projectId>/…`). `readFile("specs/core.md")` resolve
contra o **CWD do container api, que é `/app`**; `/app/specs` não existe. Consequência medida:

- `computeCurrentSpecHash` retorna **`null`** (`if (buf === null) return null`) para **todos os 28
  projetos do Venuxx V2** — o maior produto do sistema.
- `POST /api/specs/:id/validate` → **422 `SPEC_FILES_MISSING`** (falha visível, ao menos).
- `checkSpecValidationGate` → **bloqueia a promoção** quando `SPEC_VALIDATION_GATE=on` (fail-closed, correto).
- `loadChatContext` → bloco de irmãos vazio **em silêncio** (o `catch` só faz `console.warn` e devolve
  `EMPTY_CTX`); os findings continuam vindo, porque são outra query.

**O conteúdo NÃO está perdido** — está no disco, em dois lugares verificados:
`/project-files/<projectId>/docs/spec_<filename>` (por projeto) e
`/opt/genesis-files/cced9045…/apps/docs/packages/<filename>.md` (o projeto de origem da decomposição).
Logo o reparo é um **backfill determinístico de `file_path`**, não uma reingestão.

### 1.5 Defeito E (NOVO): o chat por-arquivo roda com contexto ZERO

`specChat.ts:633`: `const ctx = projectId && !filePath ? await loadChatContext(...) : EMPTY_CTX`.
Quando o Jean abre um **arquivo específico** na Bancada, o modelo recebe **nada** — sem irmãos, sem
findings, sem mapa do produto (e ainda com o teto `MAX_FILE_CHAT_CHARS = 20.000`). É o caminho mais
usado para "corrigir uma coisa pontual" e é o mais cego.

### 1.6 O que JÁ EXISTE e serve de alicerce (não precisa inventar)

- **`connect.yaml` por projeto** é um arquivo de spec de verdade (`rel_dir = ''`) e o
  `evolutionPlanner.ts:129` **já o lê** (cap 16.000) — ele traz interfaces/eventos, ou seja, é a
  fronteira contratual entre irmãos.
- **`PRODUCT.json`** (`PRODUCT_MANIFEST_NAME`, `routes/specs.ts`) traz `projects[{id, spec, type, dependsOn}]`
  — um **DAG de dependências** entre os projetos do produto.
- **`products.next_rfc_seq` / `next_adr_seq`**, `projects.parent_project_id`, `superseded_by`,
  `status` — dá para montar o mapa do produto **sem** ler um único byte de spec.
- **Um único ponto de entrada:** "Resolver GAPs" usa o MESMO `buildChatMessage`/`loadChatContext`
  (`specChat.ts:187` `resolveGaps`) → consertar o contexto conserta chat **e** Resolver GAPs de uma vez.

### 1.7 Dimensionamento de custo (o que um despejo integral custaria)

| Produto | Despejo integral | ~tokens | Cabe? |
|---|---|---|---|
| OrienteMe Demo (9 proj.) | 207.492 chars | ~52k | **estoura** o cap de campo (145.600), cabe no global (280.000) |
| ZVoices (7 proj.) | 116.954 | ~29k | cabe |
| Venuxx V2 (28 proj.) | ~9,5 KB (stubs pequenos) | ~2,4k | cabe |
| Produto realista futuro (28 proj. × 40 KB) | ~1,1 MB | ~280k | **impossível** |

Ou seja: **despejo integral funciona para o parque de hoje e não escala.** Um produto grande de
verdade estoura, e cada turno de chat pagaria ~52k tokens de entrada só de contexto — no Opus 5 isso é
ordem de **US$ 0,80 por mensagem**, em toda mensagem, inclusive nas triviais.

---

## 2. Desenho proposto

Princípio: **índice sempre, corpo por necessidade.** O modelo precisa *saber que o irmão existe e o
que ele cobre* em 100% dos turnos; precisa do *corpo* do irmão só quando o assunto o toca.

### P0 — Reparar o defeito D (pré-requisito, sem ele o resto é teoria)

`services/specFilePathBackfill.ts` + rota admin `POST /api/admin/spec-files/repair?dryRun=1`:

1. Seleciona linhas cujo `file_path` **não** é absoluto **ou** não é legível.
2. Candidatos determinísticos, na ordem: `/project-files/<projectId>/docs/spec_<filename>` ·
   `/project-files/<projectId>/<rel_dir>/<filename>` · `/shared/uploads/<projectId>/<filename>`.
3. **Só grava** se o candidato existe E (quando `content_sha256` está preenchido) o sha do arquivo
   **casa**. Sem casamento → não toca, reporta.
4. `dryRun` por padrão; relatório linha a linha (project, antes, depois, sha ok?).

### P1 — Mapa do Produto (índice determinístico, custo O(projetos), sempre no prompt)

Novo `services/productContext.ts` → `buildProductMap(db, projectId)`:

```
## MAPA DO PRODUTO — Venuxx V2 (28 projetos) — você está editando: [identity-svc]
| projeto | tipo | depende de | spec | status | seções |
| core             | library | —              | 12,3 KB | accepted | Contexto · Modelo · Eventos |
| identity-svc ←   | service | core           | 18,1 KB | on_bench | Contexto · API · RN |
| tms              | service | core, identity | 31,7 KB | accepted | Contexto · API · Fluxos |
```

- Fonte: `projects` + `project_spec_files` + `PRODUCT.json.dependsOn` (quando existe) + os **H2** de
  cada arquivo (uma leitura por arquivo; 58 arquivos = 631 KB de I/O local, irrelevante).
- **Filtra linhagem morta:** `status <> 'archived'` e `superseded_by IS NULL` — senão v1/v2/v3 do mesmo
  projeto aparecem como três irmãos (GAP-8).
- Tamanho: ~120 chars/projeto + linha de seções → **28 projetos ≈ 6–10 KB**. É o teto do índice, sempre.

### P2 — Corpo dos irmãos por relevância (heurística, sem round-trip extra)

Ordem de prioridade para gastar o orçamento de corpo:
1. `connect.yaml` dos irmãos **diretamente dependentes** (`dependsOn` em qualquer direção) — é o
   contrato, é pequeno e é onde a divergência acontece.
2. Specs de irmãos **citados nos findings ATIVOS** da última validação.
3. Specs de irmãos citados **na mensagem do humano** (match por título/slug).
4. O resto: só no índice.

**Nunca cortar `connect.yaml` no meio** (YAML pela metade é contrato ilegível): entra inteiro ou não
entra (GAP-7).

### P3 — Orçamento derivado, não constante; e fechar o defeito C

- `SIBLINGS_BUDGET`/`FINDINGS_BUDGET` deixam de ser 14.000/6.000 fixos e passam a sair do
  `_prompt_budget` do modelo (o mesmo que já dá 145.600 ao `spec_raw`), com **piso nos valores de
  hoje** — nada regride, mesma disciplina da frente anterior.
- `build_user_message` passa a **emitir** `product_map`, `sibling_files_context` e `validation_report`
  como blocos próprios (fecha **C**) — e a api **para** de colá-los no `task` (hoje vão **duas vezes**:
  `specChat.ts:291` e `:307-308`).
- Marcador de corte **sem reticências**, igual ao `[CORTE DE CONTEXTO]` do runtime (a marca atual da api
  é `…(truncado)…`, que o `validate_response_quality` pode ler como truncamento se o modelo a copiar).

### P4 — Chat por-arquivo deixa de ser cego (defeito E)

`buildRawFileRequest` recebe o **Mapa do Produto** + os findings do arquivo. Sem corpo de irmãos (é
edição pontual), mas com consciência de onde aquele arquivo vive.

### FORA de escopo (deliberado)

- **Escrever em arquivo de irmão.** Hoje o chat devolve **um** `specMarkdown` e o portal salva **um**
  arquivo — o modelo é fisicamente incapaz de corromper um irmão. Manter assim nesta frente: o irmão é
  **somente leitura**, e divergência detectada sai como **finding/GAP**, não como edição. Ver **D4**.
- Round-trip de "pedir contexto" (o modelo solicitar o corpo de um irmão e a api reinvocar). Fica atrás
  de flag numa fase 2, se a heurística do P2 não bastar.
- Índice materializado em tabela/cache. Medido: ler 58 arquivos é barato; cache é otimização prematura.

---

## 3. Revisão adversarial — GAPs e fechamento

| # | GAP | Fechamento |
|---|---|---|
| **1** | **Custo explode** num produto de 28 projetos reais (~1,1 MB). | Índice (O(projetos), ~10 KB) sempre; corpo só por relevância (P2) e dentro do orçamento derivado (P3). Despejo integral **nunca** é o default. |
| **2** | **Vazamento cross-tenant** — passar a consultar por `product_id` amplia a superfície. Já queimou: `genesis-autocare-tenant-leak-cloud-upsert-2026-09-03`. | Toda query do mapa **join com `projects.tenant_id`** e escopo do JWT (`loadAccessibleProject` como porta única). Fail-closed: sem tenant resolvido → mapa vazio, não mapa do vizinho. Teste dedicado. |
| **3** | **O backfill do P0 pode gravar caminho errado** e apontar a spec de A para o arquivo de B. | Só grava com candidato existente **e** sha casando com `content_sha256`; `dryRun` obrigatório antes; relatório linha a linha; nada é sobrescrito no disco (só a coluna). |
| **4** | **Linhagem de evolução poluindo o mapa** — v1/v2/v3 do mesmo projeto aparecem como 3 irmãos e o modelo "harmoniza" contra uma versão morta. | Filtro `status <> 'archived' AND superseded_by IS NULL`; a versão vigente é marcada `←` no mapa. |
| **5** | **`PRODUCT.json` ausente** (produto criado por upload de spec única) → sem `dependsOn`. | Degradação graciosa: mapa só com DB (título, tipo, tamanho, seções) e prioridade do P2 cai para "citados nos findings / na mensagem". |
| **6** | **Entrada maior rouba a saída** — o modo `spec_intake_and_normalize` reemite a spec. | Irmãos são **somente leitura**: aumentam a ENTRADA e não a SAÍDA. Ainda assim a prioridade de gasto é `spec_raw` > findings > mapa > corpos de irmãos, e o global do `_prompt_budget` é a trava dura. |
| **7** | **`connect.yaml` cortado no meio** = contrato ilegível, pior que ausente. | Whole-file-or-nothing para `connect.yaml`/YAML. |
| **8** | **O modelo passa a "consertar" o irmão** dentro do documento que está editando (duplicando spec alheia). | Bloco marcado `SOMENTE LEITURA — NÃO reescreva, NÃO copie` + instrução de reportar divergência como GAP. Reforçado por construção: o retorno é um único documento. |
| **9** | **Regressão em TODOS os caminhos de spec** (chat, Resolver GAPs, validador, evolução). | Flag `SPEC_CONTEXT_PRODUCT_SCOPE=off` por default; ligar em dev, provar ao vivo, depois prod. Rollback sem redeploy. |
| **10** | **`loadChatContext` engole erro** (`catch` → `EMPTY_CTX` com `console.warn`) — se o mapa falhar, ninguém vê. | Falha do mapa vira evento em `project_dialogue`/campo `context_warnings` no job, visível no portal — mesma lição de `githubPush.ts`. |
| **11** | **O índice mente se o disco divergir do banco** (é o defeito D em outra roupa). | O mapa reporta `spec ILEGÍVEL` explicitamente por projeto em vez de omitir a linha — o modelo (e o Jean) veem o furo. |
| **12** | **Produto com 1 projeto** (8 de 13 hoje) não pode ficar mais caro por nada. | Mapa é omitido quando o produto tem 1 projeto vigente. Custo zero no caso mais comum. |

---

## 4. Decisões do Jean — TOMADAS em 2026-09-05

| # | Decisão | Resposta do Jean |
|---|---|---|
| **D1** | Reparar agora os 28 `file_path` do Venuxx V2 (P0)? | ⏸️ **ADIADO** — *"anote isso para depois me lembre"*. **Consequência aceita:** o Venuxx V2 (28 projetos) continua sem validar, sem promover (gate ON) e sem contexto de irmãos. A prova ao vivo usa o **OrienteMe** (9 projetos, arquivos legíveis). Pendência registrada em memória. |
| **D2** | Corpo dos irmãos por heurística ou round-trip? | ✅ **Heurística, sem round-trip** (`dependsOn` → findings ativos → citados na mensagem). |
| **D3** | Ligar direto em prod ou flag OFF + prova ao vivo? | ✅ **Flag OFF em prod**, ON no dev, prova ao vivo no OrienteMe, depois ligar. |
| **D4** | O modelo pode propor edição em spec de irmão (multi-arquivo)? | ✅ **SIM — frente aberta.** Deixa de ser "fora de escopo": vira a **Fase 2** deste desenho (§6), com pesquisa+adversarial próprios ANTES do código. A Fase 1 (consciência) é pré-requisito duro: não se edita com segurança um irmão que o modelo não consegue ver. |

---

## 5. Plano de execução — Fase 1 (consciência), aprovada

1. P0 backfill + rota admin + `dryRun` → relatório ao Jean → gravar.
2. `services/productContext.ts` (mapa + seleção de corpos) com testes de tenant-scope e linhagem.
3. `loadChatContext` passa a usar o mapa; `buildChatMessage` para de duplicar contexto no `task`.
4. `build_user_message` emite `product_map`/`sibling_files_context`/`validation_report` (fecha C).
5. Orçamentos derivados do `_prompt_budget`, com piso nos valores atuais.
6. P4 (chat por-arquivo recebe o mapa).
7. Suítes: api (baseline atual) + orchestrator; teste de tenant-scope obrigatório.
8. Deploy em janela quieta, flag OFF, digest conferido; prova ao vivo no OrienteMe (9 projetos):
   o CTO tem que **citar corretamente um irmão que ele nunca viu antes**.
9. Memória + relatório.
