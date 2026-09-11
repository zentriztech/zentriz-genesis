# RFC-0008 · Emenda 01 — `[Normalizar]` antes de promover

> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

- **Status:** Proposto (aguardando revisão adversarial — ver §9)
- **Data:** 2026-09-11
- **Emenda ao:** [RFC-0008 — ADR/RFC: donos e hierarquia de produto](RFC-0008-ADR-RFC-DONOS-E-HIERARQUIA-DE-PRODUTO.md)
- **Pedido do Jean (verbatim):** *"se adicionar uma etapa antes de promover (condicionado), tipo:
  [Normalizar] e ele cria/atualiza os docs(RFC e os que fizer sentido) possiveis e destrava o botao
  de promover para a fabrica"*

---

## 1. Correção de fato ao RFC-0008 (medida, não suposta)

O RFC-0008 afirma: *"Nenhum agente cria ADR ou RFC hoje — são 100% humanos."*

**Isso é falso para o caminho de EVOLUÇÃO.** Medição em
`applications/services/api-node/src/services/evolutionPlanner.ts` (672 linhas):

| artefato | quem escreve hoje | onde |
|---|---|---|
| `docs/rfc/RFC-NNNN-<slug>.md` | agente arquiteto (`/invoke/raw`) | `evolutionPlanner.ts:~430` |
| `docs/adr/ADR-NNN-<slug>.md` | agente arquiteto | idem |
| `CHANGELOG.md` (`## [Unreleased]`) | agente arquiteto | idem |
| `connect.yaml` evoluído | agente arquiteto | idem |
| numeração por PRODUTO | `products.next_rfc_seq` / `next_adr_seq` (migração 080), alocação atômica | `evolutionPlanner.ts:311-322` |

A afirmação correta é: **nenhum agente cria ADR/RFC no caminho de CRIAÇÃO** — só no de evolução.
Um produto que nasce na Bancada e vai pela primeira vez à Fábrica chega **sem RFC, sem ADR, sem
índice de navegação**. É exatamente o buraco que o `[Normalizar]` fecha.

**Consequência de desenho:** a emenda **reusa** a máquina do `evolutionPlanner` (parser, veto,
`upsertSpecFile`, alocação atômica de número, `parseRfcMarkdown` do gate). Não inventa outra.

## 2. Inversão declarada em relação ao RFC-0008

O RFC-0008 põe a criação de ADR **na Fábrica**, com gatilho estreito (o QA pedindo expansão de
escopo, ou ressalva de cobertura do CTO) — "ADR é fato consumado".

O pedido do Jean põe um passo **na Bancada, antes de promover**. Isso **não revoga** a fronteira,
refina quem a aplica:

| artefato | quem gera | quando | por quê |
|---|---|---|---|
| **RFC** (intenção) | Bancada, no `[Normalizar]` | antes de promover | a intenção existe inteira antes da Fábrica |
| **ADR** (fato consumado) na Bancada | Bancada, no `[Normalizar]` | **só quando a própria spec já consumou a decisão** (stack escolhida, modelo de dados, fronteira de serviço declarada no texto) | a decisão já foi tomada por quem escreveu a spec; não registrá-la é perdê-la |
| **ADR** na Fábrica | Fábrica (RFC-0008 F3) | quando é **forçada a divergir** da spec | continua valendo, inalterado |

Ou seja: o `[Normalizar]` **não** gera ADR para tudo. Gera quando há ≥2 opções consideradas e a
escolha já está no texto da spec (MADR 4, mesmo critério do `EVOLVE_PLAN_PROMPT.md` §3).

## 3. O botão e a trava

```
  Bancada (draft)
     │
     ├── [Normalizar] ──► agente ──► docs escritos ──► normalized_hash gravado
     │                       │
     │                       └── falha/blockers ──► 422, botão CONTINUA travado, motivo na tela
     │
     └── [Promover à Fábrica]   ← habilitado só se normalized_hash == hash atual da spec
```

- `POST /api/products/:id/normalize` — novo endpoint.
- `POST /api/products/:id/promote` — nova guarda **409 `NOT_NORMALIZED`** antes de chamar o
  `promotionPlanner` (economiza a chamada de LLM da ordenação quando a trava vai barrar).
- **Condicionado por hash:** se `products.normalized_hash` é igual ao hash canônico atual da spec do
  produto, o `[Normalizar]` **devolve verde sem regenerar nada** (`status: "already_normalized"`,
  zero tokens). Editar qualquer spec do produto invalida a normalização e a trava volta.
- **Nunca promove sem docs.** Falha de LLM não destrava por "best effort" — a LEI
  (`feedback-genesis-100-llm-nunca-automacao-fixa`) proíbe fallback heurístico, e aqui a
  consequência de um fallback seria promover um produto sem documentação nenhuma.

### 3.1 Hash de normalização (fórmula canônica)

```
linhas = para cada projeto não-arquivado do produto, ordenado por projectId (comparação BINÁRIA UTF-8):
           projectId + "\0" + specTreeHash(projeto) + "\n"
normalizationHash = sha256hex( productId + "\0" + system_id + "\0" + name + "\n" + concat(linhas) )
```

- `specTreeHash(projeto)` = `computeCurrentSpecHash()` (`services/specValidation.ts:167`) — **a mesma
  fórmula do gate SPEC-APPROVED do runner**, não uma paralela. Lê o **disco**.
  > ⚠️ A primeira versão desta emenda propunha derivar o hash de `project_spec_files.content_sha256`
  > (barato, sem I/O). **Refutado por medição em prod (2026-09-11): 28 de 71 spec files têm
  > `content_sha256` NULL (39%)** — a coluna nasceu opcional na migração 071. Um hash sobre campo
  > nulo em 39% dos casos é instável. A mesma medição mostrou que o caminho caro **não é caro**:
  > são **71 spec files no banco de prod inteiro** (~1,2 por projeto), então ler o disco de um
  > produto custa dezenas de leituras, não milhares.
- Ordenação por `Buffer.compare`, **nunca** `localeCompare` (regra já estabelecida em
  `lib/specTreeHash.ts`).
- Se `computeCurrentSpecHash` devolver `null` para qualquer projeto (arquivo sumiu do disco) ⇒
  **422 `SPEC_FILES_MISSING`** com a lista. Não normaliza por cima de árvore quebrada.
- `system_id` e `name` entram no hash **de propósito**: renomear o produto muda a identidade que os
  documentos citam, então a normalização tem de ser refeita.

## 4. O agente (1 chamada por produto)

- **Prompt:** `applications/services/api-node/src/assets/NORMALIZE_PRODUCT_PROMPT.md` (novo).
- **Modelo:** `const NORMALIZE_MODEL = "";` — vazio por LEI; resolvido por
  `resolveWorkbenchLlm` + `agentsLlmFields` (slot do tenant). Sem slot ⇒ falha alto.
- **Chamada fora de transação** (é LLM, dezenas de segundos — segurar client do pool esgota o pool).
- **Entrada:** identidade do produto · lista de projetos (id, título, papel) · head da spec primária
  de cada projeto (cap por projeto **e** teto global, com o que foi cortado declarado em
  `truncated[]`) · RFCs/ADRs já existentes em cada projeto (não duplicar) · `connect.yaml` herdado.
- **Saída JSON:**

```json
{
  "summary": "1-3 frases PT-BR",
  "ready": true,
  "blockers": ["o que impede normalizar, se ready=false"],
  "rfcs":  [{ "target": "product" | "<projectId>", "slug": "...", "title": "...", "content": "# ..." }],
  "adrs":  [{ "target": "product" | "<projectId>", "slug": "...", "title": "...", "content": "# ..." }],
  "decisions": [ { ...decision-record do Connect... } ]
}
```

### 4.1 Veto (saída de LLM nunca entra crua)

| condição | resposta |
|---|---|
| não é JSON | 422 `PLAN_NOT_JSON` |
| `rfcs` vazio | 422 `PLAN_WITHOUT_RFC` |
| `ready: false` | 422 `NOT_READY`, com `blockers[]` na tela |
| `target` desconhecido | item **descartado** + warning declarado (nunca grava em projeto de outro produto) |
| RFC reprova em `parseRfcMarkdown` | **grava** e devolve os problemas como **aviso** (mesma política do `evolutionPlanner`: o gate/Stage A barram de novo depois se persistirem) |
| `decision` não valida no schema Connect | item descartado + warning (o `.md` continua sendo a verdade legível) |
| `content` < 40 chars ou sem `title` | item descartado (regra já existente em `docList`) |

**Nenhum veto destrava o botão.** Qualquer 4xx deixa `normalized_hash` inalterado.

## 5. Onde cada arquivo é gravado

| artefato | caminho | quem escreve |
|---|---|---|
| RFC de projeto | `<projeto>/docs/rfc/RFC-NNNN-<slug>.md` | agente |
| RFC de produto (`target:"product"`) | `<projeto âncora>/docs/rfc/RFC-NNNN-<slug>.md` | agente |
| ADR | `<projeto>/docs/adr/ADR-NNN-<slug>.md` | agente |
| decision-record (índice Connect) | `<projeto>/docs/decisions/<id>.json` | código (serializa o objeto validado) |
| `README.md` de cada pasta tocada | `<projeto>/docs/rfc/README.md`, `docs/adr/README.md`, `docs/decisions/README.md` | **código** |
| `README.md` da raiz do projeto | `<projeto>/README.md` | **código** |
| índice do PRODUTO | `products.normalization_md` (coluna nova) | **código** |

**Por que o README é escrito por código e não pelo agente:** índice é **transporte** (lista de
arquivos + links relativos), não conteúdo. A LEI do 100% LLM governa *estrutura, divisão e conteúdo
da spec* — um índice gerado por LLM só introduz risco de link quebrado sem nenhum ganho de juízo.
Todos os links são **relativos** (`./`, `../`), para funcionarem tanto no portal quanto no repo de
spec quando ele existir.

**Projeto âncora:** o não-arquivado de menor `created_at` (desempate por `id` binário). A escolha é
**declarada** na resposta do endpoint e no `README` do produto — não é escondida.

**Por que isso chega à Fábrica sem tocar no runner:** `load_spec_all` (`runner.py:915`) concatena
**todos** os `project_spec_files` com cabeçalho `---\n# [relDir/filename]\n\n`, **excluindo apenas
`.yaml`/`.yml`**. Qualquer `.md` gravado como spec file chega ao agente da Fábrica. O `.json` do
decision-record também. Zero mudança no runner.

**Por que `products.manifest_md` NÃO é reusado:** medido — a coluna é escrita uma única vez pelo
`productDecomposer.ts:200` e **nunca lida por nada** (grep em `applications/`, 3 ocorrências, todas
de escrita/comentário). Sobrescrevê-la apagaria o manifesto do decomposer sem ganho. Coluna nova.

## 6. Numeração — GAP-60 estendido de projeto para PRODUTO

O `evolutionPlanner` calcula o piso local varrendo os RFCs/ADRs **de um projeto**. O `[Normalizar]`
opera sobre **N projetos do mesmo produto** que compartilham a mesma sequência (migração 080), então
o piso tem de ser o **máximo entre todos os projetos do produto**:

```sql
UPDATE products
   SET next_rfc_seq = GREATEST(next_rfc_seq, $piso_rfc) + $n_rfc,
       next_adr_seq = GREATEST(next_adr_seq, $piso_adr) + $n_adr
 WHERE id = $1
 RETURNING next_rfc_seq, next_adr_seq
```

Sem o piso por produto, um produto com `ADR-001` herdado no projeto B receberia outro `ADR-001` ao
normalizar pelo projeto A — a mesma classe de defeito do GAP-60, um nível acima.

## 7. Re-carimbo seguro do `spec_hash` (regra anti-lavagem)

**O bloqueio real:** escrever um arquivo novo num projeto com `extra.spec_approved = true` muda o
tree hash. O gate SPEC-APPROVED (`runner.py:5791-5806`) compara e, divergindo, marca
`status = spec_validation_failed` e **aborta a run**. Normalizar sem tratar isso quebraria toda
promoção de produto já aprovado.

Regra, espelhando `specHashBackfill.ts:25` (nunca "lavar" spec editada depois da aprovação):

```
para cada projeto alvo com extra.spec_approved = true:
    antes  = computeCurrentSpecHash(projeto)
    se antes.specHash != extra.spec_hash:
        → NÃO escreve nesse projeto
        → warning SPEC_EDITED_AFTER_APPROVAL (o humano reaprova; a normalização não lava a edição)
    senão:
        escreve os artefatos
        depois = computeCurrentSpecHash(projeto)
        extra.spec_hash = depois.specHash
        extra.spec_hash_renormalized_at = now()
```

Projetos em `draft` sem `spec_approved` não passam por nada disso.

## 8. Contrato Connect — `decision-record`

Novo schema `contract-kit/schemas/products/decision-record.schema.json` (draft 2020-12), irmão do
`lesson-record`, conforme o RFC-0008 §F2. É o **índice** que faz um lado conhecer os arquivos do
outro; o `.md` continua sendo a verdade legível.

Campos mínimos: `decisionId` · `kind` (`rfc` | `adr`) · `number` · `title` · `status`
(`proposed`|`accepted`|`superseded`) · `scope` (`product`|`project`) · `systemId` · `serviceId?` ·
`productId` · `projectId?` · `path` (caminho relativo do `.md`) · `createdBy`
(`workbench`|`factory`|`sustainment`|`human`) · `createdAt` · `supersedes?` · `relatedTo?`.

Entra também: `examples/products/decision-record.example.json` + as atualizações de catálogo que os
validadores do contract-kit exigem (`validate-schemas`, `validate-examples`,
`validate-compatibility`). Sem exemplo válido, o CI do Connect reprova.

## 9. O que esta emenda **não** entrega (declarado, não omitido)

- **F1/F4 do RFC-0008** — montagem do repositório de spec por produto com pastas por projeto. Os
  artefatos ficam prontos para essa montagem (caminhos relativos, README por pasta), mas o repo em
  si não é criado aqui.
- **F3 do RFC-0008** — gatilho de ADR dentro da Fábrica.
- **Migração dos 57 ADR/RFC legados** e o prefixo de escopo.
- **Auto Care lendo o `decision-record`** — o schema é publicado; o consumo pelo Deadpool é outra
  frente.

## 10. UI

1. Botão **`[Normalizar]`** no card do produto em `draft` (`products/page.tsx`).
2. **`Promover à Fábrica` desabilitado** enquanto não normalizado, com tooltip dizendo o porquê.
3. Falha ⇒ diálogo com `blockers[]` / warnings; botão segue travado.
4. **Requisito do Jean (2026-09-11):** *"quando aparecer na fabrica e ainda nao foi inicado, o
   produto deve aparecer com status 'na bancada'"*. Medido: em `projects/page.tsx:89`, o
   `STATUS_LABELS` **não tem a chave `promoted`** — a Fábrica exibe hoje o literal cru `promoted`.
   Correção: `promoted: "Na Bancada"`, `statusColor → "default"`, `STATUS_PHASE_PCT.promoted = 0`.
   Não há ambiguidade com `draft`, que nessa tela é rotulado "Rascunho".

## 11. Migração 127

```sql
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalized_hash TEXT
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalized_at TIMESTAMPTZ
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalized_by UUID
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalization_model TEXT
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalization_md TEXT
```

Regra do runner de migrations: **nenhum `;` dentro de literal**, sem blocos `DO`/`$$`.

## 12. Revisão adversarial do próprio plano (`/devil`, 2026-09-11)

Rodada **antes** de escrever código, com as premissas frágeis **medidas**, não supostas.

### 12.1 Premissas críticas

| # | premissa | confiança | o que a derrubaria | resultado da medição |
|---|---|---|---|---|
| P1 | o hash pode sair do banco (`content_sha256`), sem I/O | **baixa** | a coluna ser nula em parte da base | 🔴 **DERRUBADA — 28/71 (39%) NULL em prod.** Corrigido no §3.1: hash vem do disco |
| P2 | ler o disco de um produto inteiro é caro | **média** | a base ser pequena | 🔴 **DERRUBADA — 71 spec files em TODA a prod.** O caminho "caro" é trivial |
| P3 | escrever RFC num projeto de CRIAÇÃO não muda o comportamento de nenhum gate | **média** | o gate de evolução ou o Stage A reagirem a `docs/rfc/` sempre | ✅ **CONFIRMADA** — `evolutionGate.ts:184` sai cedo se `extra.evolution !== true`; `specValidation.ts:196` usa `rfcSev = opts.evolution ? "blocker" : "warning"`. Em criação, problema de RFC é **aviso**, nunca bloqueio |
| P4 | o gate SPEC-APPROVED do runner aborta a run se a árvore mudar | **alta** | — | ✅ confirmada (`runner.py:5791-5806`) — é o que justifica o §7 |
| P5 | o Fábrica lê qualquer `.md` gravado como spec file | **alta** | `load_spec_all` filtrar por pasta | ✅ confirmada (`runner.py:915`, exclui só `.yaml`/`.yml`) |

### 12.2 O argumento mais forte CONTRA (um oponente honesto assinaria)

> *"Você não adicionou um passo de documentação. Você inseriu um agente não supervisionado no
> caminho crítico de construção. `load_spec_all` concatena **tudo** — então o RFC que o normalizador
> inventar entra no prompt do CTO e do PM como se fosse requisito do cliente. Antes, um produto sem
> RFC era construído a partir da spec que o humano escreveu. Agora ele é construído a partir da spec
> **mais** o que um LLM achou que a spec queria dizer. Um passo que o Jean espera ser burocrático
> ganhou poder de mudar o que é entregue — e o botão travado dá a ele a aparência de ser obrigatório
> e, portanto, confiável."*

Isso é real e não se resolve com boa intenção. **Mitigação estrutural adotada:**

1. **O prompt PROÍBE requisito novo.** O normalizador documenta o que a spec **já diz**. O que falta
   vai para `blockers[]` e para a seção "Questões em aberto" do RFC — **nunca** vira um `MUST`.
   Um `MUST` sem âncora no texto da spec é violação de contrato do agente, não licença criativa.
2. **Cabeçalho de proveniência** em todo arquivo gerado (mesma política do `evolutionPlanner`):
   `> Gerado pela Bancada ([Normalizar]) a partir da spec vigente — revise antes de promover.`
3. **A trava É o ponto de revisão.** O botão não destrava sozinho: destrava depois que o humano viu
   o resultado. Se a revisão humana não acontecer na prática, o §13 mede isso.
4. **`ready: false`** quando a spec não sustenta um RFC honesto — melhor travar do que inventar.

### 12.3 Hipótese alternativa que explica os mesmos fatos

*"O problema do Jean não é ausência de RFC — é que os documentos estão espalhados e sem navegação."*
Ela explica as mesmas observações (57 de 58 projetos na raiz, 92% dos números de ADR colidindo,
nenhum índice). Se ela for a verdadeira, a solução certa é **README por código + repo de spec por
produto (F1/F4)** — custo zero de tokens — e o RFC gerado é ruído.

**O que discrimina:** o Jean nomeou o artefato — *"ele cria/atualiza os docs (**RFC** e os que fizer
sentido)"*. Isso pesa a favor da proposta. Mas a hipótese alternativa **não foi eliminada**, e é
exatamente ela que o teste do §13 mede.

### 12.4 Ressalvas que entram na implementação

- **R1 — re-carimbo é "lavagem autorizada".** O §7 reescreve `extra.spec_hash`, que é o mecanismo que
  detecta spec editada após aprovação. É defensável (a escrita foi do próprio sistema, no ato), mas
  **tem de ser auditável**: gravar `extra.spec_hash_prev` + `spec_hash_renormalized_at` e emitir
  evento de auditoria. Sem rastro, é indistinguível de lavagem.
- **R2 — teto na listagem.** Computar o hash na lista de produtos é barato **hoje** (P2). Com
  > 200 spec files num produto, o `GET` devolve `normalized: null` (= "verificar ao promover") em vez
  de fazer I/O ilimitado num endpoint de listagem. A trava do `/promote` continua sendo a autoridade.
- **R3 — testes existentes de `/promote` vão quebrar.** Ajustar teste para passar é suspeito: o
  correto é semear `normalized_hash` válido nos testes que exercitam promoção **e** adicionar um
  teste novo que prova que sem normalização a promoção é recusada com 409.
- **R4 — custo de contexto.** Um produto com 28 projetos não cabe em um prompt com `SPEC_CAP` de 40k
  por projeto. Teto **global** rígido, cap por projeto = teto/N, e o que foi cortado declarado em
  `truncated[]` (mesma política do GAP-135: cortar o menos relevante e dizer por quê).

### 12.5 Veredito

**SÓLIDA COM RESSALVAS.** O passo tem base medida (nenhum agente cria RFC no caminho de criação) e
não quebra nenhum gate (P3, P4, P5 confirmadas). Duas premissas de desempenho foram derrubadas pela
medição e o desenho foi corrigido antes de virar código. O risco que **permanece** é o do §12.2 — o
normalizador virar autor de requisito — e ele é contido por contrato de prompt, não eliminado.

## 13. O teste barato que derruba esta emenda

Se, em 10 promoções reais, o agente da Fábrica **nunca citar** um RFC gerado pelo `[Normalizar]` na
sua saída (charter/backlog), então o `[Normalizar]` é cerimônia: gastou tokens, criou arquivos e não
mudou o que foi construído. Nesse caso a emenda encolhe para "gerar o README de navegação por código
e mais nada" — que custa zero tokens e resolve o problema de índice que o Jean levantou.
