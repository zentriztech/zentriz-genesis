> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# RFC-0007 — A Fábrica entrega TODAS as squads declaradas (hoje entrega só a primeira, em silêncio)

| Campo | Valor |
|---|---|
| Status | **v2 — desenho revisado após revisão adversarial** (a v1 foi REFUTADA por medição; ver §8) |
| Data | 2026-09-10 |
| Autor | Jean Ol'Bar + Claude (Genesis) |
| Item | Backlog do Jean — *"FÁBRICA: CTO com 1+ SQUADS — tasks que se complementam, sem sobrescrever"* |
| Lei aplicada | *"Genesis/Auto Care são 100% LLM — nunca automação fixa"*: quem decide quantas squads e como dividir é o agente; o código transporta, veta contradição e **declara o corte** |
| Estende | ADR-0004 (agentes por especialidade) · ADR-0005 (fluxo monitor/PM/CTO) · RFC-0003 (splitter) |
| Depende de | hierarquia Produto › projetos (item 11.a do backlog) — este RFC **usa** essa hierarquia, não a inventa |

---

## 1. Problema — MEDIDO em prod

Censo de **27 propostas** do Engineer (`/opt/genesis-files/*/docs/engineer/engineer_proposal.md`),
26 com frontmatter `squads:`. Squads por proposta: **{1: 19, 2: 6, 3: 1}** ⇒ **7 de 26 (27%)
declararam 2+ squads**. Nos **7 de 7** só a primeira virou produto:

| projeto | declarou | `docs/pm/` | tasks em `project_tasks` |
|---|---|---|---|
| `094961d8` | backend, web | só `backend` | backend 16 · test 1 · **web 0** |
| `495cb6e4` | backend, web | só `backend` | backend 10 · test 1 · **web 0** |
| `51bba5e7` | backend, web | só `backend` | backend 11 · test 1 · **web 0** |
| `b5eeb683` | backend, web | só `backend` | backend 16 · test 1 · **web 0** |
| `de898f28` | backend, web | só `backend` | backend 27 · test 1 · **web 0** |
| `f289816b` | backend, web, **mobile** | só `backend` | backend 18 · test 1 · **web 0 · mobile 0** |
| `fd5080ee` | backend, web | só `backend` | backend 14 · test 1 · **web 0** |

Três hipóteses inocentes foram testadas e **todas refutadas**:

1. *"O código do front foi feito mesmo assim, fora do backlog."* — Varredura de `package.json` nos
   workspaces de `f289816b`, `de898f28` e `fd5080ee`: **zero** ocorrência de `next`, `react`, `vite`,
   `expo` ou `react-native`. `f289816b` declarou backend+web+mobile e entregou **só uma API NestJS**.
2. *"Um projeto irmão do mesmo produto entregou o front."* — 4 dos 7 são **filho único** do produto;
   os 3 do produto MoneyFlow (`e5a83f6f`) são **versões sucessivas** (MoneyFlow, V2, V2-evolução,
   criadas em 31/08, 01/09 e 02/09) e **todas as três são backend**. Nenhuma entregou web.
3. *"O CTO avaliou e decidiu cortar as squads."* — `docs/cto/cto_backlog_validation.md` de
   `f289816b` mostra o CTO **enxergando as 3 squads**, escrevendo *"Validação do Backlog (Squad
   Backend)"*, `pm_module_used: backend`, `coherence_verdict: OK`, `action: approve`. Ele aprovou
   porque a regra que recebeu (T03/N1) pergunta **"o módulo escolhido está entre os declarados?"** —
   pertinência —, e nunca **"todas as squads declaradas foram planejadas?"** — cobertura. O guarda é
   estruturalmente incapaz de pegar este defeito.

**A run terminou reportando sucesso.** É o pior formato de falha: entrega parcial que se apresenta
como completa.

### 1.1 Causa-raiz — uma linha

`applications/orchestrator/runner.py:1581-1587`:

```python
squads = _parse_squads_yaml(engineer_proposal or "")
if squads:
    chosen = squads[0]["module"]      # ← as demais squads morrem aqui, sem log de corte
```

O escalar `pm_module` daí resultante governa a run inteira: `_parse_tasks_from_backlog` (3513) só lê
`docs/pm/<pm_module>/BACKLOG.md`; `_seed_tasks` (3685) carimba `module`/`owner_role` de **todas** as
tasks com esse valor; `_structural_gate` (3132) e `_run_local_deploy` (3191) só olham esse módulo; o
laço CTO↔PM (6368+) roda **uma vez, para um módulo**.

### 1.2 Fatos de campo que definem o desenho

- **O executor já é polimórfico por task** (`runner.py:4249` deriva o *variant* do Dev do `owner_role`
  da própria task). O gargalo é o **planejamento**, não a execução.
- **🔴 O workspace de um projeto é MONO-APP, universalmente.** Medição em todos os workspaces de
  prod: **52 com `apps/package.json` (raiz da aplicação), 0 com `apps/<modulo>/package.json`**.
  `apps/` **é** a aplicação — não é um guarda-chuva de monorepo.
- **A hierarquia Produto › projetos já existe e está viva:** disco em
  `<FILES_ROOT>/<product_id>/<project_id>/` (39 pastas), **13 produtos com `contracts/`**,
  `_copy_contract_to_product` publicando o `api_contract.md` do projeto no produto, e
  `POST /api/products/:id/promote` promovendo **o produto inteiro, na ordem decidida por agente**
  (plano de ondas com arestas).
- **🔴 Defeito colateral (runner.py:3599-3606):** o override de `owner_role` por task é substring crua
  na linha do título — `if "web" in line_lower` **antes** de testar `backend`. Uma task de backend
  chamada *"Implementar endpoint de **web**hooks"* vira `DEV_WEB` e troca de módulo em silêncio.

---

## 2. A virada de chave do desenho

> **Uma squad não cabe dentro de um projeto alheio — ela é um projeto irmão do mesmo produto.**

Porque `apps/` é a raiz de UMA aplicação, duas squads na mesma run escreveriam o mesmo
`apps/package.json`: o Next.js da squad web por cima do NestJS da squad backend. Não é um risco
teórico de "sobreposição de arquivos" — é colisão garantida no primeiro arquivo.

E a plataforma **já tem** a unidade certa: o produto com N projetos, cada projeto mono-app, com
contrato publicado em `<produto>/contracts/` e ordem de promoção decidida por agente. A declaração
Connect (RFC/GAP-133/134/135) é exatamente o canal pelo qual o projeto web consome a API do projeto
backend.

Logo, **N squads declaradas num projeto é o sintoma de um produto criado com projetos de menos** — a
divisão não aconteceu na Bancada. O conserto não é fazer a run virar multi-app; é **fazer a decisão
do agente chegar ao nível do produto**.

---

## 3. Desenho

### 3.1 Princípio

> O Engineer declara as squads. O código **nunca escolhe uma delas em nome dele**: ou entrega todas
> (como projetos irmãos do produto), ou **declara alto** o que não entregou.

### 3.2 F1 — matar o silêncio (o defeito mais grave é a omissão, não a falta do front)

Hoje a run não deixa rastro do descarte. F1 muda isso **sem mudar o que é construído**:

1. `resolve_squads_from_engineer_proposal()` devolve a **lista** de squads; a run passa a registrar
   `squads_declared[]` e `squads_planned[]` no `pipeline_ctx`/checkpoint e no
   `pipeline_run_log.json`.
2. Quando `len(declared) > len(planned)`, o runner emite evento e passo visível no portal:
   *"O Engineer declarou 3 squads (backend, web, mobile). Esta run entrega **backend**. As demais
   ficam declaradas como pendentes do produto."*
3. `_structural_gate` passa a **reprovar a ACEITAÇÃO automática** de um projeto com squad declarada e
   não planejada: o projeto pode ser entregue, mas não pode se apresentar como completo. A frase do
   Jean que rege isso: *"esgotou rework → ESCALAR"*, nunca estacionar em silêncio.
4. O `extra_instruction` do CTO (T03/N1) ganha a pergunta que falta: **cobertura**, não só
   pertinência — *"o backlog cobre TODAS as squads declaradas? se não, aponte quais faltam"*.

F1 não gasta um token a mais de construção e converte uma entrega parcial silenciosa em uma entrega
parcial **declarada**. É o item de maior razão valor/risco deste RFC.

### 3.3 F2 — completar o produto: uma squad pendente vira um projeto irmão em `draft`

Para cada squad declarada e não planejada, o runner cria (via API, com o `product_id` do projeto
corrente) um **projeto irmão em `draft`**, com:

- `title` derivado do nome da squad e do produto (ex.: *"Gestão de Frota — Web"*);
- `spec_ref` da MESMA spec do produto (a spec é do produto; o recorte de escopo é da squad);
- o `variant` e o `target_tasks`/`ceiling_tasks` que **o Engineer já declarou** — o código não
  inventa nenhum desses valores;
- aresta de dependência para o projeto que publica o contrato (backend → web/mobile), consumida pelo
  plano de ondas de `POST /api/products/:id/promote`.

**`draft` é estado inerte**: nada roda, nada gasta, nada deploya até o Jean promover. Isso respeita
tanto *"o produto entra na fábrica na ordem, sem iniciar"* quanto a regra de não disparar trabalho
externo sozinho.

### 3.4 F3 — o contrato entre irmãos

O projeto backend já publica `api_contract.md` em `<produto>/contracts/` ao ser aceito
(`_copy_contract_to_product`). O projeto web/mobile irmão recebe esse caminho como oráculo de
entrada — mesmo mecanismo da declaração Connect. Nada novo a inventar: é ligar o que existe.

### 3.5 O que o código PODE decidir (vetos, não escolhas)

| veto | condição | por quê |
|---|---|---|
| **Módulo duplicado** | 2 squads declaram o mesmo `module` | dois projetos irmãos idênticos; devolve ao agente |
| **Squad sem módulo** | `module` vazio no frontmatter | não há como rotear; devolve ao agente |
| **ID de task duplicado** | mesmo `TSK-ID` em 2 backlogs do mesmo projeto | corrompe o estado de tasks |

Vetar não é decidir conteúdo: é recusar um plano internamente contraditório, descrevendo a
contradição e devolvendo ao agente. Só depois de esgotar as rodadas a run falha.

### 3.6 F4 — o bug latente do substring

Trocar o override de `owner_role` por marcador explícito (`owner_role: DEV_WEB` ou `[DEV_WEB]` na
linha do cabeçalho). Palavra solta no título (*webhook*, *website*) deixa de mudar o módulo da task.

---

## 4. O que este RFC NÃO faz (e por quê)

- **Não coloca duas squads na mesma run.** Refutado pela medição de layout (§1.2): `apps/` é
  mono-app em 52 de 52 workspaces.
- **Não cria projeto irmão já iniciado.** Iniciar é decisão do Jean, via promoção.
- **Não decide o recorte de escopo entre squads.** Isso é do agente (Engineer/CTO); o código só
  transporta a declaração dele.
- **Não altera o frontmatter `squads:`** que o Engineer já emite.

---

## 5. Compatibilidade — critério de aceite mais importante

> **Com 1 squad declarada (19 de 26 propostas — 73%), a run tem de ser indistinguível da de hoje:**
> mesmo nº de chamadas de LLM, mesmos caminhos, mesmo `module`/`owner_role`, mesmo gate, mesma
> aceitação. Regressão nesse caminho é pior que o defeito que este RFC conserta.

---

## 6. Como se prova (não é "health 200")

1. **Antes:** os 7 projetos da §1 — fato consumado, medido.
2. **F1 ao vivo:** run nova com 2+ squads declaradas ⇒ o log/portal diz explicitamente quais squads
   ficaram fora e o projeto **não** é aceito como completo.
3. **F2 ao vivo:** o mesmo produto passa a ter o projeto irmão em `draft`, com aresta de dependência
   — visível em `/products/<id>/projects`, sem nenhuma run nova ter começado.
4. **Não-regressão:** run de squad única com o mesmo nº de chamadas de PM/CTO de hoje.
5. Testes: veto de módulo duplicado; squads sem frontmatter ⇒ 1 squad ⇒ caminho de hoje; checkpoint
   antigo (sem os campos novos) retomando sem erro; `TSK-FULL-TEST` única.

---

## 7. Riscos

| risco | mitigação |
|---|---|
| Projetos irmãos em `draft` acumulando sem promoção | são inertes; aparecem na tela do produto como pendência explícita — é o objetivo |
| Engineer declarar squad supérflua ⇒ projeto irmão inútil | `draft` + promoção manual: o custo de uma squad errada é um registro, não uma run |
| Regressão no caminho de 73% dos projetos | §5 é critério de aceite, com run de controle antes do deploy |
| Gate mais rígido travar projetos que hoje passam | o gate só endurece quando há squad declarada **e** não planejada — condição que hoje ocorre em 27% e sempre indicou entrega parcial |

---

## 8. Revisão adversarial — o que derrubou a v1

A v1 deste RFC propunha **N squads dentro de uma run**: um PM por squad, seed unificado e veto de
"arquivo disputado". O argumento mais forte contra, que se confirmou na medição:

> *"Você está tratando como problema de planejamento algo que também é de layout. Se `apps/` é a
> raiz de uma única aplicação, duas squads na mesma run não disputam 'alguns arquivos' — elas
> disputam o `package.json`, o `tsconfig.json`, o `Dockerfile` e a árvore inteira. O veto de
> sobreposição da §3.5 dispararia em toda run multi-squad, e o desenho entregaria um erro em vez de
> um produto."*

Medição que resolveu a disputa: **52 workspaces com `apps/package.json`, 0 com submódulos**. A v1
exigiria reescrever a convenção de caminho de Dev, QA, DevOps, gate, deploy, Dockerfile, FTS e
Cyborg — raio de explosão desproporcional, justamente sobre o caminho que hoje funciona em 73% dos
projetos.

Segundo argumento, que mudou a unidade de trabalho: a plataforma **já tem** o conceito de produto
multi-projeto (disco aninhado, `contracts/`, promoção por ondas com arestas), e o próprio código
diz isso em `_seed_tasks`: *"em produto multi-serviço, apenas o projeto 'deploy' tem
TSK-FULL-TEST"*. Inventar multi-squad dentro do projeto seria construir um segundo mecanismo para o
problema que a hierarquia do produto já resolve.

**Veredito: MUDAR** — problema confirmado e agravado (o CTO aprova o corte porque só checa
pertinência), solução substituída: de *"N squads numa run"* para *"cada squad é um projeto irmão do
produto"*, com F1 (matar o silêncio) como primeira entrega por ser a de maior valor e menor risco.
