> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# RFC-0008 — ADR/RFC: quem cria, quando, onde · e a hierarquia Produto › {specs, projects, assets}

| Campo | Valor |
|---|---|
| Status | **Proposto** (aguarda 1 decisão do Jean — §6) |
| Data | 2026-09-10 |
| Escopo | Genesis (Bancada + Fábrica), Deadpool, Connect |
| Origem | Backlog do Jean 2026-09-09 — "quem cria ADR/RFC, quando, onde" + "hierarquia Produto › {specs, projects, assets}" |
| Pré-requisito | §6 — identidade de produto (`products.system_id`) |
| Relacionado | RFC-0003 (splitter/decompose), RFC-0007 (N squads), ADR-013 (Connect-local), ADR-018 (Product Architect) |

---

## 1. O problema, medido (2026-09-10)

Não é uma questão de gosto de organização. As três perguntas do Jean têm hoje respostas
**contraditórias entre si**, e dá para medir cada uma.

### 1.1 "Onde?" — hoje são 5 lugares, e a numeração colide em 92%

58 ADRs distribuídos em 5 diretórios independentes:

| Escopo | Diretório | ADRs | Formato |
|---|---|---|---|
| Ecossistema | `zentriz-autonomy-suite/docs/01-ecosystem/adr/` | 21 | `ADR-NNN-CAIXA-ALTA.md` |
| Deadpool | `zentriz-deadpool-auto-care/docs/adr/` | 25 | `ADR-NNN-caixa-baixa.md` |
| Genesis | `zentriz-genesis/project/docs/adr/` | 7 | `NNNN-caixa-baixa.md` (**sem prefixo**) |
| Connect (impl-pack) | `zentriz-connect/implementation-pack/docs/adr/` | 6 | `ADR-NNN-CAIXA-ALTA.md` |
| Connect (docs) | `zentriz-connect/docs/ADR/` | 1 | — |

**23 dos 25 números de ADR em uso colidem** (92%). `ADR-013` existe três vezes com três
significados sem relação: *versioned Connect consumption* (ecossistema), *governance readiness
before promotion* (Deadpool) e *spec-connect declaration* (Connect). Pior: **`ADR-006` colide
dentro do próprio Deadpool** — `ADR-006-codeowners-and-workspace-impact.md` e
`ADR-006-yaml-policy-engine.md` são dois documentos distintos com o mesmo número e o mesmo dono.

Nos RFCs, 37 documentos, **8 números colidem**, com duas larguras de campo (Genesis usa 4 dígitos,
Deadpool usa 3) e uma colisão intra-escopo de cada lado: `RFC-0004` duas vezes no Genesis
(`BANCADA-AMBIENTE-DE-PROJETO` e `PLANO-EXECUCAO`), `RFC-027` duas vezes no Deadpool.

O CLAUDE.md global manda "numeração global e sequencial **por ecossistema**". Os fatos dizem que na
prática a numeração é **por escopo** — e ninguém garante nem isso, já que colide dentro do escopo.
Uma regra que 92% dos artefatos violam não é uma regra: é uma intenção não implementada.

### 1.2 "Quem cria?" — hoje, ninguém automaticamente. E só um caminho consome.

Varredura no código de agentes do Genesis (`applications/orchestrator`, `applications/contracts`):
**nenhum agente cria ADR ou RFC**. As ~40 ocorrências são comentários de código *citando* uma ADR
como justificativa (`connect_contracts.py`, `product_architect.py`, `verdict_seed.py`).
ADR/RFC são, hoje, artefatos **100% humanos**.

Existe exatamente **um consumo operacional**, em `runner.py:2461` (modo evolução):

> "EVOLUÇÃO: valide os critérios de aceite (Gherkin) dos RFCs em `docs/rfc/` (…) reprove com o
> motivo `SCOPE_EXPANSION_REQUIRED` (**o humano amplia o `## Impacto` do RFC**)."

Ou seja: o único ponto em que a máquina lê um RFC já pressupõe que a escrita é humana.

### 1.3 O requisito do Jean não é atendido por nada

> **"Independente de quem cria, ambos devem CONHECER os arquivos gerados pelo outro."**

Hoje o único vínculo Genesis↔Deadpool em matéria de decisão é **link de README**
(`zentriz-deadpool-auto-care/README.md:241` aponta para as próprias pastas). Não há índice comum,
não há schema, não há leitura programática de um lado pelo outro. O Connect — a camada contratual
comum, o lugar natural disso — tem schema para `product-manifest`, `spec-connect-declaration`,
`lesson-record` e `value-event`, e **nenhum schema de decisão**.

### 1.4 A hierarquia de produto existe no banco e é PLANA no disco

Em prod (`/opt/genesis-files`, 2026-09-10):

| Fato | Número |
|---|---|
| Projetos no banco | 58 — **todos** com `product_id` preenchido |
| Produtos no banco | 17 |
| Projetos cujo diretório está na **raiz** do disco, fora do produto | **57 de 58 (98%)** |
| Projetos de fato aninhados sob o produto | **1** |
| Produtos com diretório próprio no disco | 8 de 17 |
| Diretórios com `contracts/` que **não são produto nem projeto** no banco | **5 órfãos** |

O banco já modela Produto › projetos com 100% de coerência. O disco ignora isso: dois layouts
coexistem no mesmo diretório raiz, e o legado é 98% do volume. É por isso que "o produto da Bancada
e o da Fábrica são o mesmo" ainda não se sustenta na prática — no disco, não são sequer vizinhos.

---

## 2. Decisão proposta

### 2.1 Quem cria — os dois, com fronteira por natureza da decisão

Não é "Bancada ou Fábrica". É **qual decisão** está sendo tomada:

| Quem | Cria | Momento | Natureza |
|---|---|---|---|
| **Humano** (Jean) | ADR de ecossistema, RFC de plataforma | quando muda a regra do jogo | Estratégica |
| **Bancada** (spec) | **RFC de produto** | ao fechar a spec de um produto | O que o produto tem de fazer |
| **Fábrica** (build) | **ADR de projeto** | quando o agente **é forçado a divergir** do que a spec assumiu | Como foi construído, e por que não do jeito previsto |
| **Deadpool** | **ADR de sustentação** | quando uma remediação muda uma decisão de build | Como passou a operar |

A regra que separa é: **RFC é intenção, ADR é fato consumado.** A Bancada declara intenção; a
Fábrica e o Deadpool registram o que a realidade impôs. Isso já é o comportamento observado —
`runner.py:2461` faz o QA validar Gherkin **de RFC** (intenção), e as ADRs citadas no código são
todas justificativas de escolha já feita.

**Gatilho da Fábrica (o único caso automático desta proposta):** quando o QA reprova com
`SCOPE_EXPANSION_REQUIRED` ou quando o CTO aprova um backlog com **ressalva de cobertura**
(RFC-0007 §F1 — squad declarada e não entregue), há por definição uma divergência entre o que a
spec assumiu e o que o build entregou. **Essa divergência vira uma ADR de projeto** — hoje ela
morre num campo de parecer que ninguém relê.

> **LEI Genesis 100% LLM.** O conteúdo da ADR é escrito pelo agente. O código só transporta,
> numera, indexa e **veta contradição** (ADR que afirma o oposto de um RFC vigente do mesmo produto
> é recusada e volta ao agente). Nenhum template preenchido por `if`.

### 2.2 Onde — escopo no nome, um índice só

**Prefixo de escopo obrigatório**, que elimina colisão por construção e torna a origem legível sem
abrir o arquivo:

```
ECO-ADR-0001…   ecossistema (autonomy-suite)      ← humano
CNX-ADR-0001…   Connect (contratos)               ← humano
GEN-ADR-0001…   plataforma Genesis                ← humano
DPL-ADR-0001…   plataforma Deadpool               ← humano
<system_id>-ADR-0001…   ADR de um PRODUTO gerado  ← Fábrica / Deadpool
<system_id>-RFC-0001…   RFC de um PRODUTO         ← Bancada
```

Numeração **sequencial dentro do prefixo** — que é o que já acontece de fato, agora dito em voz alta
e verificável. Os 58 ADRs e 37 RFCs existentes **não são renomeados** (§4).

Localização:
- decisões **de plataforma** ficam onde já estão (um diretório por escopo);
- decisões **de produto** ficam sob o produto: `<produto>/decisions/` — irmã de `contracts/`, que
  já existe em 13 diretórios e é o precedente desta forma.

### 2.3 O canal que faz um lado ler o outro (o requisito do Jean)

Um **`decision-record`** no Connect — schema novo, irmão de `lesson-record`, com o mínimo:
`id`, `scope`, `kind` (adr|rfc), `product_system_id`, `title`, `status`, `supersedes[]`,
`origin` (bancada|fabrica|deadpool|humano), `evidence_ref`, `created_at`.

O arquivo `.md` continua sendo a verdade legível; o `decision-record` é o **índice** que atravessa
o polirepo. Publicar no Connect é o que já se faz com contrato (`_copy_contract_to_product`), então
o transporte existe e não precisa ser inventado.

Com isso, "ambos conhecem os arquivos do outro" vira uma consulta, não um acordo de cavalheiros:
a Bancada, ao especificar a rodada seguinte, lê as ADRs de origem `fabrica`/`deadpool` do mesmo
`product_system_id`; a Fábrica, ao planejar, lê os RFCs de origem `bancada`.

### 2.4 Hierarquia de produto

```
<FILES_ROOT>/<product_id>/
├── specs/<spec_id>/          ← Bancada ou upload
├── projects/<project_id>/    ← código gerado (o layout de projeto de hoje, intacto)
├── contracts/                ← já existe (13 produtos)
├── decisions/                ← §2.2
└── assets/
```

Repos: **um repo de código por projeto** (como hoje, sem mudança) e **um repo de spec por produto**,
com sufixo `-spec` (ex.: `nvx-lastmile-spec`) — regra já fixada pelo Jean.

---

## 3. Como migrar sem parar a fábrica

O risco real aqui não é desenhar errado: é mover 57 diretórios de projeto que estão em uso.

**F1 — escrita nova no lugar novo, leitura nos dois.** Todo produto/projeto criado a partir do
deploy nasce em `<product_id>/{specs,projects}/`. A resolução de caminho passa a tentar o layout
novo e cair no legado quando não achar. Nada se move. Reversível apagando o fallback.

**F2 — `decisions/` + schema `decision-record` no Connect**, e as duas leituras do §2.3.
Independente de F1 (pendura em `<product_id>/`, que já existe para 8 produtos).

**F3 — gatilho da Fábrica**: `SCOPE_EXPANSION_REQUIRED` e ressalva de cobertura do CTO passam a
emitir ADR de projeto. Depende de F2.

**F4 — migração do legado**: mover os 57 diretórios para `<product_id>/projects/`, com os 5 órfãos
com `contracts/` resolvidos antes (são lixo ou são produto perdido — precisa olhar um a um).
**Só depois de F1 estar em prod e provado**, e em janela sem run em voo.

---

## 4. O que este RFC NÃO faz

- **Não renomeia os 58 ADRs e 37 RFCs existentes.** Renomear quebraria as ~40 citações em
  comentários de código, os links de README e as referências cruzadas entre documentos — em troca
  de estética. O prefixo vale para o que nascer daqui em diante; o legado fica lido pelo escopo do
  diretório, que é o que já se faz na prática.
- **Não faz o agente escrever ADR de plataforma.** Decisão de plataforma é do Jean.
- **Não move nada no disco** (isso é F4, e depende de decisão explícita).
- **Não resolve `ADR-006` duplicado no Deadpool** — é um conserto de 1 arquivo, fora do escopo aqui.

---

## 5. Revisão adversarial (o que quase derrubou esta proposta)

**"Prefixo é burocracia; a colisão nunca causou dano real."**
Parcialmente verdade — ninguém foi acordado de madrugada por causa de `ADR-013`. Mas o dano é
específico e já está contratado: o §2.3 propõe um índice **cross-repo**. No momento em que ADRs de
três repos entram na mesma tabela, `ADR-013` deixa de ser ambíguo para humanos e passa a ser
**chave duplicada**. O prefixo não é enfeite: é o que torna o §2.3 possível. Se o §2.3 for
recusado, o prefixo perde a maior parte da justificativa — e deve cair junto.

**"A Fábrica gerando ADR vai virar spam."**
Risco real, e é por isso que o gatilho do §2.1 é estreito de propósito: só
`SCOPE_EXPANSION_REQUIRED` e ressalva de cobertura do CTO. Pela taxa medida no RFC-0007 (7 de 26
propostas com squad não coberta), a ordem de grandeza é **uma ADR a cada ~4 runs** — não uma por
task. Se na prática passar disso, o gatilho aperta antes de o volume virar ruído.

**"O `decision-record` duplica o `lesson-record`, que já existe."**
Foi a objeção mais forte, e obrigou a delimitar: `lesson-record` responde *"o que aprendemos a não
repetir"* e alimenta o CAG/`verdict_seed`; `decision-record` responde *"o que decidimos e passa a
valer"*. Uma lição é estatística e pode ser revogada por evidência nova; uma decisão é normativa e
só é revogada por outra decisão (`supersedes[]`). Se fossem o mesmo registro, revogar uma lição
apagaria uma decisão. **Sinal de que eu errei aqui:** se em 3 meses `supersedes[]` estiver sempre
vazio e ninguém consultar o índice, o `decision-record` era mesmo `lesson-record` com outro nome.

**"A hierarquia nova não resolve nada enquanto 98% do disco estiver no layout velho."**
Correto, e é a razão de F1 escrever no lugar novo sem mover o legado. Enquanto a migração F4 não
rodar, o ganho é só para produto novo. **Isto é uma limitação assumida, não um efeito colateral
escondido.**

**Teste que resolveria a disputa, mais barato que o debate:** implementar F2 sozinha (schema +
`decisions/` + as duas leituras) e medir, em 10 runs, quantas vezes a Bancada de fato leu uma ADR
gerada pela Fábrica. **Se a resposta for zero, o canal do §2.3 não vale o custo** e o RFC inteiro
encolhe para "prefixo de escopo e mais nada".

---

## 6. A decisão que falta (bloqueia F1 e F4)

Toda esta hierarquia pendura em `<product_id>` e o repo de spec é nomeado por `system_id`. Hoje:

- **8 dos 17 produtos têm `system_id` VAZIO** (incluindo `VNX LastMile`, `OrienteMe Demo` com
  9 projetos, e `Cargobox Fulfillment` com 3);
- **3 têm auto-slug com acento quebrado**: `gest-o-de-frota`, `gestao-de-frota-a-ores-manual`,
  `spec-sem-t-tulo`.

Sem `system_id` canônico não existe nome de repo de spec nem chave de `product_system_id`.
Preencher os vazios com auto-slug é mecânico — **exceto `VNX LastMile`**, cuja identidade já está
publicada como `nvx-` no Deadpool e no `connect.yaml`
(ver `genesis-identidade-vnx-vs-nvx-divergencia-dados-2026-09-09`). Escolher `vnx-lastmile`
renomeia identidade viva; escolher `nvx-lastmile` contradiz o nome do produto na tela.

**Esta é decisão do Jean, não do desenho.** As demais podem ser preenchidas sem consulta.

---

## 7. Provas exigidas antes de promover cada fase

| Fase | Prova |
|---|---|
| F1 | produto novo nasce em `<product_id>/projects/<project_id>/`; **os 57 legados continuam abrindo** (regressão medida, não presumida) |
| F2 | `decision-record` valida contra o schema; Bancada lê ADR criada pela Fábrica em run real |
| F3 | uma ressalva de cobertura do CTO produz exatamente **uma** ADR, com evidência apontando o run_id |
| F4 | contagem disco×banco fecha em 100% (hoje: 57 fora do lugar, 5 órfãos, 9 produtos sem diretório) |
