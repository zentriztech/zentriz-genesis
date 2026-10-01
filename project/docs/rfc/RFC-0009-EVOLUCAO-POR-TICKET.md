# RFC-0009: Evolução por Ticket — o pedido ganha identidade, anexo e fila

> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

## Status

Rascunho

## Data

2026-09-11

## Resumo

Dar **identidade, anexo, tipo e fila** ao pedido de evolução que hoje existe apenas
como texto solto dentro do `extra` do projeto filho — sem criar um segundo fluxo ao
lado do que já funciona, e sem tocar no identificador de task que segura o estado da
Fábrica.

## Contexto

O estudo [ESTUDO-EVOLUCAO-POR-TICKET-2026-09-11](../analysis/ESTUDO-EVOLUCAO-POR-TICKET-2026-09-11.md)
mediu duas coisas que decidem o desenho:

**B.1 — o que dói hoje.** `projects.ts:3391` mantém o guard `EVOLUTION_IN_FLIGHT`:
uma evolução em voo por serviço, fail-closed com 409. Como **pedir e executar são a
mesma coisa** (o pedido *é* o projeto filho, com `version_number`, branch
`evolution/vN` e preferências de deploy), abrir um segundo pedido é **proibido**.

A medição do Passo 0 (2026-09-11, prod) refinou esse diagnóstico e vale registrar
aqui, porque **corrige a motivação original**: em 59 projetos houve **uma única
evolução**, e nenhum pedido foi represado — a dor não é backlog cheio. A dor medida é
outra e é pior: o único filho existente está em `blocked_cyborg`, e por isso
**evoluir o MoneyFlow V2 hoje é impossível**. Uma execução travada tranca o serviço
por tempo indeterminado. O ganho do Ticket é **separar PEDIR de EXECUTAR** para que o
pedido sobreviva à execução — não para administrar uma fila que ainda não existe.

**B.2 — o que não pode ser feito.** O sufixo `TSK-***-TK<N>` proposto é **vetado por
medição**. `runner.py:3600` usa `r'\b(TSK-[A-Z]+-\d+|TSK-\d+)\b'`; testado nesta
máquina, `'## TSK-BE-001-TK12'` casa `TSK-BE-001` e **perde o `-TK12` em silêncio**.
O ID de task é chave de estado (`task_state.py`, `_evo_register_violation`, retomada
de run) — o modo de falha seria o pior possível. O ticket vai no **campo**, não no ID;
a rastreabilidade sai melhor, porque `git log --grep=TK-0012` acha tudo.

Da Parte C do estudo, os seis princípios que este RFC obedece:

1. O ticket não é um formulário novo (A.1: o humano não sabe o que falta).
2. O original é imutável (A.3: 5% das revisões de LLM inserem erro factual).
3. Toda maturação é um diff aprovável.
4. **Quem carimba o ticket é a máquina** (A.5: confiar no humano custa ~40% dos links).
5. Não regenerar o mundo a cada ticket (A.6).
6. O Ticket é camada fina sobre a evolução que já existe (~70% já está construído).

## Proposta

### Modelo mental em uma frase

> **Ticket = o pedido.** **Projeto filho = a execução.** N tickets abertos por
> produto, 1 execução em voo — o guard `EVOLUTION_IN_FLIGHT` continua valendo, mas
> agora ele empurra o pedido para a **fila** em vez de recusá-lo.

### F1 — O Ticket como entidade (número, tipo, anexo, fila)

**Migration 128** (`128_tickets.sql`):

```
tickets
  id uuid pk · tenant_id · product_id · project_id (versão corrente do serviço)
  number int            -- sequencial POR PRODUTO → exibido como TK-0012
  title text
  body  text            -- o que o HUMANO escreveu, CRU. A máquina nunca escreve aqui.
  change_kind text      -- 'evolution' | 'fix' | 'feature'   (DECLARADO, não inferido)
  status text           -- 'open' | 'promoted' | 'delivered' | 'rejected'
  child_project_id uuid -- preenchido na promoção (o elo ticket → execução)
  created_by · promoted_at · delivered_at · extra jsonb · created_at · updated_at
  UNIQUE (product_id, number)

ticket_counters (product_id pk, last_number int)   -- alocação atômica do número
ticket_attachments (id, ticket_id fk cascade, filename, file_path, mime_type,
                    size_bytes, content_sha256, created_at)
```

O número é alocado por `INSERT … ON CONFLICT DO UPDATE SET last_number =
ticket_counters.last_number + 1 RETURNING last_number` — atômico sob concorrência,
sem advisory lock e sem sequence global (o número precisa ser **por produto**, para
que o humano diga "o TK-12 do LastMile").

**Rotas novas** (`src/routes/tickets.ts`):

| Método | Rota | Papel |
|---|---|---|
| `POST` | `/api/products/:productId/tickets` | cria (multipart: `title`, `body`, `changeKind`, `projectId` + arquivos) |
| `GET` | `/api/products/:productId/tickets` | lista a fila do produto (filtro por `status`) |
| `GET` | `/api/tickets/:id` | detalhe + anexos |
| `PATCH` | `/api/tickets/:id` | edita enquanto `open`; após `promoted`, **409** |
| `DELETE` | `/api/tickets/:id` | só enquanto `open` |
| `GET` | `/api/tickets/:id/attachments/:attId` | download do anexo |

Anexos herdam os limites já registrados em `app.ts:78` (`@fastify/multipart`: 10
arquivos, 10 MB cada) — **não inventar outra política de upload**.

**Não há rota de promoção nova.** Promover é o `/api/projects/:id/evolve` que já
existe, agora aceitando `ticketId` no body. Quando presente, ele usa o corpo do
ticket como `request`, grava `ticket_id`/`ticket_number`/`ticket_kind` no `extra` do
filho e marca o ticket como `promoted` com `child_project_id`. É isso que impede o
fluxo paralelo (princípio 6): o Ticket **é** a porta de entrada da evolução que já
existe, não um irmão dela.

**UI.** O diálogo "🔄 Evoluir projeto" (`projects/[id]/page.tsx`) ganha **anexo** e
**tipo de mudança**, e passa a criar um Ticket. Em seguida:

- sem evolução em voo → oferece **"Promover agora"** (um clique, mesmo caminho de hoje);
- com evolução em voo → informa **"ficou na fila como TK-0012"** em vez do 409 seco.

Abaixo, uma seção **Tickets** lista a fila do produto com estado e link para a
execução. Facilitar o trabalho do humano é o critério: pedir, ver a fila e promover
acontecem no mesmo lugar, sem tela nova para aprender.

### F2 — A pasta `tickets/TK-NNNN/` na árvore da spec

`project_spec_files` já tem a coluna **`rel_dir`** (migration `071_spec_files_tree.sql`),
que é exatamente o mecanismo de pastas nativas da Bancada. No `/evolve` com
`ticketId`, logo após a herança dos arquivos do pai (`projects.ts:3475-3520`),
gravamos:

```
tickets/TK-0012/request.md          ← frontmatter (ticket, tipo, autor, data) +
                                      o corpo CRU do humano + índice de anexos
tickets/TK-0012/anexos/<arquivo>    ← os anexos, registrados na árvore
```

`request.md` é **imutável** (princípio 2). Hoje o texto livre do humano é substituído
pelo sintetizado dos RFCs e só sobrevive numa coluna JSON (`evolutionGate.ts:214-215`
grava `evolution_request_original`) — ninguém consegue ler. Com a pasta, o que foi
pedido fica ao lado do que virou, para sempre, no mesmo repositório de spec do
produto (casa com o RFC-0008).

O cabeçalho do arquivo primário passa de `# EVOLUTION REQUEST — v3` para
`# EVOLUTION REQUEST — v3 (TK-0012 · recurso novo)`, de modo que o arquiteto da
Bancada e o CTO da Fábrica leiam o **tipo declarado** em vez de inferi-lo.

### F3 — O ticket atravessa até o git (carimbado pela máquina)

Medido: a Fábrica **não commita por task** — o push de evolução faz um commit em lote
em `github.ts:587` (`batchMsg`). São três pontos determinísticos, todos em TypeScript
e todos testáveis:

| Ponto | Hoje | Depois |
|---|---|---|
| `github.ts:587` | `feat: Genesis — push N generated files` | `… (TK-0012)` |
| `githubPush.ts:677` (título do PR) | `Evolução v3 — LastMile` | `TK-0012 · Evolução v3 — LastMile` |
| `evolutionAccept.ts:154` (`buildPullRequestBody`) | Resumo, compat, RFCs, CHANGELOG | **+ linha `**Ticket:** TK-0012 (recurso novo)`** |

O corpo do PR é reaproveitado como mensagem do merge commit
(`evolutionMerge.ts:354`), então o carimbo chega ao histórico de `dev` **sem nenhum
código novo** nesse caminho. Resultado verificável: `git log --grep=TK-0012` devolve
o commit do branch, o PR e o merge.

### F4 e F5 — especificados, **fora desta entrega**

- **F4 — o ticket alimenta o `[Normalizar]`.** O normalizador do RFC-0008 emenda 01
  passa a receber os tickets promovidos e **localizar** onde acrescentar/atualizar,
  em vez de regenerar (A.6). Fica de fora agora porque exige decidir a política de
  diff aprovável (princípio 3), que merece emenda própria.
- **F5 — completude assistida.** O sistema pergunta o que falta no pedido (A.1), em
  vez de exibir um formulário maior. Fora agora pelo mesmo motivo: sem F1 medido em
  uso real, não há base para saber o que perguntar.

Declarar o que fica fora é parte da entrega — não é escopo silenciosamente cortado.

## Alternativas Consideradas

1. **Sufixo no ID da task (`TSK-BE-001-TK12`)** — o pedido literal do Jean.
   **Rejeitada por medição** (B.2): o regex do runner trunca o sufixo em silêncio e o
   ID é chave de estado. O campo entrega a mesma rastreabilidade com `git log --grep`.
2. **Relaxar o `EVOLUTION_IN_FLIGHT` e listar os filhos em `draft` como "fila"** — a
   alternativa mais barata, e o argumento mais forte contra este RFC (ver abaixo).
   Rejeitada porque o projeto filho carrega semântica de **execução**; N pedidos
   virariam N `version_number` e N branches `evolution/vN` para coisas que talvez
   nunca rodem. O próprio comentário de `projects.ts:3391` registra que o guard nasceu
   justamente disso.
3. **Motor de tickets completo (workflow, SLA, prioridade, comentários)** — rejeitada:
   é um segundo produto dentro do Genesis. O ticket aqui é linha leve; a spec madura
   continua sendo a spec.
4. **Ticket como arquivo markdown na árvore, sem tabela** — rejeitada: sem tabela não
   há fila consultável nem numeração atômica, e a listagem dependeria de varrer disco.

## Impacto

- **Agentes afetados**: nenhum agente muda de contrato. O arquiteto da Bancada e o
  CTO da Fábrica passam a **ler** o tipo declarado no cabeçalho do arquivo primário e
  a pasta `tickets/` na árvore — informação a mais, nenhum campo obrigatório novo.
- **Contratos afetados**: nenhum contrato Connect muda. `extra` do projeto ganha
  `ticket_id`, `ticket_number`, `ticket_kind` (aditivo, opcional).
- **Banco**: migration 128 (aditiva — três tabelas novas, nenhuma alterada).
- **Documentação**: este RFC, o índice `project/docs/rfc/README.md` e um ADR na
  Fábrica quando a primeira evolução por ticket for entregue (RFC-0008: ADR = fato
  consumado).
- **Riscos**:
  - **Caminho paralelo** (o erro clássico do Genesis) — mitigado por não criar rota de
    promoção: o ticket entra pelo `/evolve` que já existe.
  - **Fila vira lixeira** — N tickets abertos sem critério acumulam. Mitigado
    parcialmente: a fila é por produto e ordenada por entrada. Priorização explícita
    fica para F4+ (não inventar requisito agora).
  - **Anexo como superfície de ataque** — herdamos os limites do multipart já
    registrado; nada de política nova.
  - **Ticket vira mini-spec mal feita** — mitigado pelo `request.md` imutável e cru: a
    maturação acontece na Bancada, sobre a spec, como hoje.

## Revisão adversarial (`/devil`)

### Tese em avaliação (steelman)

Separar pedido de execução destrava o backlog que hoje é proibido pelo
`EVOLUTION_IN_FLIGHT`, e um ticket com número estável dá ao humano a rastreabilidade
que o ID de task não daria. Como ~70% do caminho já existe, a entrega é uma camada
fina: três tabelas, seis rotas, um parâmetro a mais no `/evolve` e três carimbos.

### Premissas críticas

| Premissa | Confiança | O que a derruba |
|---|---|---|
| O humano quer mais de um pedido em aberto por serviço | **Baixa** — **REFUTADA pela medição** (59 projetos, 1 evolução, 0 represamentos); ver o teste no fim desta seção | Já derrubada: a fila deixa de ser a justificativa e vira subproduto da tabela |
| O `request.md` imutável é lido por alguém | **Média** | Se nem o arquiteto nem o humano abrirem a pasta, é arquivo morto na árvore |
| Carimbar o ticket no commit/PR basta para rastrear | **Alta** | Só falha se o push de evolução deixar de ser o ponto único de commit (hoje é — medido em `github.ts:587`) |
| O `/evolve` com `ticketId` não duplica caminho | **Alta** | Falha se alguém acrescentar depois uma segunda porta de promoção |
| Migration aditiva não afeta prod | **Alta** | Falha se o runner de migrations quebrar no split ingênuo por `;` — mitigável evitando `;` em literais |

### O argumento mais forte CONTRA

**"Você está construindo uma fila para um usuário único."** O Genesis hoje é operado
essencialmente por uma pessoa, que já consegue guardar um pedido de cabeça ou num
`.md`. A fila só paga se houver **concorrência de pedidos** — vários solicitantes,
ou um solicitante com backlog real. Sem isso, o que sobra de valor mensurável é
`anexo + tipo declarado + request.md imutável`, e isso seria entregue com **duas
colunas e um upload**, sem três tabelas, sem numeração por produto, sem seis rotas.
Toda a estrutura de fila seria custo de manutenção pago adiantado por uma hipótese
não verificada.

Um defensor honesto dessa posição assinaria: *"faça F0 (anexo + tipo + mostrar o
original), meça em duas semanas quantos pedidos ficaram represados pelo 409, e só
então construa a fila."*

### Hipótese alternativa que explica os mesmos fatos

O incômodo do Jean não é "não consigo enfileirar" — é **"não consigo anexar um print
e não sei em que pé está o que pedi"**. Os mesmos sintomas (pedido some, virou texto
sintetizado, não sei o que já pedi) são explicados por **falta de visibilidade**, não
por falta de fila. Nesse caso a cura é a pasta `tickets/` + a listagem, e o `status`
seria suficiente sem numeração atômica nem contador por produto.

### Evidência fraca · lacunas · não discriminante

- **Não discriminante:** "o guard proíbe o segundo pedido" é igualmente compatível com
  "a fila é necessária" e com "o guard nunca incomodou porque nunca houve segundo
  pedido". A evidência não separa as hipóteses.
- **Lacuna medida:** não sei quantos 409 `EVOLUTION_IN_FLIGHT` prod devolveu. Esse
  número decide a disputa e **é consultável** (ver teste abaixo).
- **Evidência forte de fato:** o veto ao sufixo (B.2) é reprodutível e independe de
  qualquer hipótese sobre uso.

### Visão do adversário (1ª pessoa)

*Como operador que herda este sistema:* "ganhei três tabelas, um contador e uma
máquina de estados de ticket para manter. Se o status ficar dessincronizado do
projeto filho — o filho é descartado e o ticket segue `promoted` — passo a ter dois
lugares dizendo coisas diferentes sobre a mesma verdade. Isso é dívida, não feature."

**Esse ataque é válido e muda o desenho:** o `status` do ticket não pode ser fonte
independente da verdade. Mitigação adotada — o ticket guarda `child_project_id` e a
listagem **deriva** o estado de execução do projeto filho por join; o campo `status`
é só o estado do *pedido* (aberto/promovido/recusado), nunca o da execução. E se o
filho for excluído, o ticket volta a `open` (o pedido continua válido; a execução é
que morreu).

### Veredito: **SÓLIDA COM RESSALVAS**

A parte **estrutural** (ticket como linha com número, anexo, tipo declarado,
`request.md` imutável, carimbo no git) é sólida e sustentada por medição. A parte
**fila** repousa numa premissa de uso ainda não verificada — mas o custo incremental
dela, dado que a tabela já vai existir, é um `UNIQUE` e um contador. **O que muda por
causa desta revisão:** (a) `status` do ticket nunca representa execução; (b) exclusão
do filho devolve o ticket à fila; (c) F4/F5 ficam explicitamente fora até haver dado
de uso.

### Teste que resolveria a disputa — **EXECUTADO em 2026-09-11, prod, leitura apenas**

Consulta em `zentriz_genesis`:

```
filhos | pais_evoluidos        total | com evolution_request
-------+---------------        ------+----------------------
     1 |              1           59 |                     1

pais com mais de um filho: 0 linhas
```

**O resultado contraria a ênfase original deste RFC e ele foi corrigido ao dado.** Em
59 projetos, a evolução foi usada **uma única vez**; nunca houve dois pedidos
disputando o mesmo serviço, logo o `EVOLUTION_IN_FLIGHT` **nunca represou nada**. A
fila não pode ser vendida como o ganho principal — a premissa "o humano quer mais de
um pedido em aberto" segue **não verificada**.

O mesmo dado, porém, produziu uma prova que não estava no plano: o único filho
existente (`MoneyFlow V2 — Evolução v2`) está em **`blocked_cyborg`**. Como o guard
recusa quando há filho com status fora de `('accepted','archived','failed')`,
**evoluir o MoneyFlow V2 hoje é impossível** — uma execução travada tranca a porta do
serviço por tempo indeterminado. Não é um problema hipotético de fila: é o estado
atual de produção. Separar pedido de execução resolve exatamente isso, porque o
pedido passa a existir mesmo quando a execução está presa.

**Consequência para o escopo:** F1 é entregue pelo que a medição sustenta
independentemente de uso — anexo, tipo declarado, `request.md` imutável, carimbo no
git e o pedido que sobrevive à execução travada. A numeração por produto e a
listagem vêm junto porque são um `UNIQUE` e um contador sobre a tabela que já
precisa existir, não uma frente separada. Nenhuma priorização, SLA ou workflow de
fila é construído agora.

## Plano de Implementação

**Passo 0 — teste que resolve a disputa (antes de escrever código).**
Medir em prod a frequência de `EVOLUTION_IN_FLIGHT`. Leitura apenas. Registrar o
número, seja ele qual for, e seguir o desenho ajustado a ele.

**Passo 1 — baseline.** `vitest` do api-node e `pytest` do orchestrator verdes antes
de tocar em qualquer arquivo (baseline já medido: 3153 testes e 875 passed).

**Passo 2 — F1 banco + API.** Migration 128 (sem `;` em literais — gotcha do runner
de migrations); `src/routes/tickets.ts`; registro em `app.ts`; `ticketId` no
`/evolve`. Testes: numeração atômica sob concorrência, imutabilidade após `promoted`,
403 cross-tenant, ticket volta a `open` quando o filho é excluído.

**Passo 3 — F2 materialização.** `tickets/TK-NNNN/request.md` + anexos na árvore via
`rel_dir`; cabeçalho do arquivo primário com ticket e tipo. Teste: árvore do filho
contém a pasta e o conteúdo bate com o corpo do ticket byte a byte.

**Passo 4 — F3 carimbo.** `batchMsg`, título do PR e `buildPullRequestBody`. Testes
unitários dos três (sem rede).

**Passo 5 — F1 UI.** Anexo + tipo no diálogo de evolução; seção Tickets com a fila.
Build do Next (lembrar: `no-unused-vars` é **erro** no build).

**Passo 6 — validação.** Suítes verdes; `npm run build` do web; revisão adversarial
do resultado (não só do plano).

**Passo 7 — deploy.** Fluxo ECR canônico: build → `ecr-push.sh` → prod (api primeiro,
migration no boot; depois genesis-web) → **conferir digest do container** → verificar
ao vivo com dados reais. Tag de rollback antes de recriar. Janela quieta (nenhum run
em voo) antes de recriar api/agents.

**Passo 8 — memória e e-mail.** Persistir o aprendido (LEI 0) e reportar.

## Referências

- [Estudo — Evolução por Ticket](../analysis/ESTUDO-EVOLUCAO-POR-TICKET-2026-09-11.md) (fontes e medições)
- [RFC-0008 — ADR/RFC: donos e hierarquia de produto](RFC-0008-ADR-RFC-DONOS-E-HIERARQUIA-DE-PRODUTO.md)
- [RFC-0008 emenda 01 — Normalizar antes de promover](RFC-0008-EMENDA-01-NORMALIZAR-ANTES-DE-PROMOVER.md)
- [RFC-0004 — Bancada: ambiente de projeto](RFC-0004-BANCADA-AMBIENTE-DE-PROJETO.md)
- Código citado: `projects.ts:3352-3600` (`/evolve`), `evolutionGate.ts:214`,
  `evolutionAccept.ts:154`, `evolutionMerge.ts:354`, `github.ts:587`,
  `githubPush.ts:677`, `runner.py:3600`, `071_spec_files_tree.sql`
