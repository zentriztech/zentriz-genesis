> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Auditoria da Lei 100% LLM — onde o código JULGA em vez de VETAR

**Item:** A5.2 do `PLANO-MESTRE-FECHAR-F1-F2-G7-BACKLOG-2026-09-05.md` (Onda 5)
**Data:** 2026-09-06 · **Escopo:** Bancada de spec (api-node `services/spec*`) + orquestrador
(`orchestrator/*`, `agents/runtime.py`) · **Ambiente das medições:** PRODUÇÃO (`3.220.66.113`)

> **Entrega:** este documento é um RELATÓRIO. Nenhuma correção foi aplicada por ele — cada item
> vira plano próprio, conforme o combinado ("não mexer em tudo de uma vez").

---

## 0. O critério usado

A lei (`feedback-genesis-100-llm-nunca-automacao-fixa`) diz: **estrutura, divisão e conteúdo de spec
são decisão de AGENTE; o código só transporta e veta corrupção; sem LLM a ação FALHA, não existe
fallback burro.** Daí três categorias, e só a primeira é violação:

| Categoria | Definição | Veredito |
|---|---|---|
| **JULGAMENTO** | Código decide *conteúdo* (o que vai onde, se a revisão presta, a que arquivo um GAP pertence) sem consultar agente. | ❌ viola |
| **VETO / TRANSPORTE** | Código recusa corrupção comprovável (seção perdida, JSON desbalanceado, path traversal) ou casa strings com registros reais. | ✅ conforme |
| **ORÇAMENTO** | Teto de custo, tempo, rodadas, tokens. Política do dono, não conteúdo. | ✅ conforme |

Uma quarta categoria apareceu na auditoria e é **pior que julgamento**: código que **corrompe em
silêncio** a resposta do agente (corta no primeiro fence, perde o array). Não decide nada — apenas
destrói a decisão do LLM sem avisar ninguém.

---

## 1. Sumário dos achados

| # | Onde | O que o código decide | Classe | Sev. |
|---|---|---|---|---|
| **J1** | `services/specGapScope.ts:183` | Que um GAP pertence ao arquivo cujo NOME casou — mesmo quando aquele arquivo virou índice na divisão | JULGAMENTO | 🔴 |
| **J2** | `services/specAutonomy.ts:80` (`MIN_SHRINK_RATIO = 0.7`) | Que encolher >30% é perda de conteúdo (e que encolher 29% não é) | JULGAMENTO (veto com régua errada) | 🟡 |
| **J3** | `services/specAutonomy.ts:82` (`MAX_NO_PROGRESS = 2`) | Que a rodada foi inútil porque a CONTAGEM de GAPs não caiu | JULGAMENTO | 🟡 |
| **C1** | `orchestrator/lesson_extractor.py:142` | — (corta a resposta no primeiro ``` interno) | CORRUPÇÃO SILENCIOSA | 🔴 |
| **C2** | `orchestrator/agents/runtime.py:1337-1338` e `:1774-1775` | — (`split("```json")[1].split("```")[0]`) | CORRUPÇÃO SILENCIOSA | 🟡 |
| **C3** | `orchestrator/envelope.py:313-321` e `:332-340` | — (mesmo `split`, no caminho do envelope) | CORRUPÇÃO SILENCIOSA | 🟡 |
| **P1** | `services/specSemanticGate.ts:41` (`MAX_CONTENT_CHARS = 12_000`) | Manda 3,5% de uma spec de 346k ao juiz e usa o veredito para barrar intake | JULGAMENTO por amostra | 🟡 |
| **P2** | `services/specChatJobs.ts:471` (`SALVAGE_MIN_CHARS = 1_500`) | Que artefato <1.500 chars "não é spec" e não vale nem ser oferecido | JULGAMENTO (sem escrita) | 🟢 |
| **P3** | `orchestrator/product_architect.py:57-66`, `:450` | O `kind` Connect de cada arquivo temático, por mapa de nome fixo | JULGAMENTO degradado em silêncio | 🟢 |
| **O1** | `spec_finding_triage` (prod) | — (0 linhas no banco inteiro) | GAP OPERACIONAL | 🟡 |

**Conformes exemplares** (padrão a copiar, §4): `resolveFindingPath` (recusa ambiguidade → roteador
LLM), o aviso "<50%" do `spec_file_splitter` (avisa o humano, não veta), `routeUnroutedFindings`
(sem LLM não inventa rota), `assessRevisionIntegrity` (veta por INVENTÁRIO de seções, não por régua).

---

## 2. Achados de JULGAMENTO

### J1 🔴 — depois da divisão, o GAP continua "sendo" do arquivo antigo (MEDIDO em prod)

**Código:** `applications/services/api-node/src/services/specGapScope.ts:182-196`

```ts
let target = resolveFindingPath(f.file, paths);
if (!target && routes[f.fingerprint]) { … }        // roteador LLM só entra se NÃO resolveu
if (!target && paths.length === 1) target = paths[0];
```

**O defeito.** O roteador agêntico existe exatamente para decidir "de qual arquivo é este GAP" — e o
próprio módulo documenta que deve tratar "paths obsoletos de antes da divisão" (`specGapScope.ts:21`).
Mas ele só é acionado quando `resolveFindingPath` devolve `null`. Ora: na divisão o arquivo primário
**mantém o nome da spec monolítica** e passa a ser o ÍNDICE. Então todo finding da validação anterior
casa por nome exato com o índice, `unrouted` fica vazio, e o roteador **nunca é chamado**. O código
decidiu — por casamento de string — algo que ele mesmo classifica como decisão de agente.

**Medição ao vivo (2026-09-06, projeto NVX LastMile `e2a1988c…`, logo após aplicar a divisão):**

```
GET /api/specs/e2a1988c-…/gap-scope
{"fileCount":11,"totalActive":17,"unrouted":1,
 "files":[{"path":"nvx-lastmile-backend.md","isPrimary":true,"active":16,"blockers":6,"warnings":8,"routed":0},
          {"path":"api-entregas-entregadores.md","active":0}, …9 arquivos com active:0…],
 "queue":["nvx-lastmile-backend.md"]}
```

Onze arquivos, 346.851 chars de conteúdo temático — e a fila do modo autônomo por arquivo tem **um
item só: o índice de 10.517 chars**. Os 16 GAPs de modelo de dados, contratos, LGPD e DoD foram
todos atribuídos a um arquivo que não contém nenhuma dessas seções.

**Consequência prática (é o que anula a F2):** o laço `per_file` mandaria 16 GAPs ao CTO-editor com
o índice como material. Ou ele falha por não achar o que corrigir, ou infla o índice com conteúdo
que pertence aos temáticos — desfazendo a divisão que acabou de ser feita.

**Direção de correção (plano próprio).** A verdade não é o nome, é a árvore no momento da validação.
Duas saídas, ambas 100% LLM:
1. Marcar a run de validação com a assinatura da árvore (`spec_hash` já existe). Se a árvore mudou
   depois da run, **todo** finding vai ao roteador — path antigo não é evidência.
2. Ou: revalidar após a divisão (o que foi feito à mão hoje) e tornar isso o caminho oficial —
   `applySplit` marca a validação anterior como estruturalmente vencida.
Sem LLM disponível, a fila fica vazia e a Bancada diz "GAPs não roteados", nunca "todos do índice".

---

### J2 🟡 — `MIN_SHRINK_RATIO = 0.7`: régua de chars julgando conteúdo

**Código:** `specAutonomy.ts:80` · comentário do próprio arquivo: *"Abaixo disto a 'revisão' perdeu
conteúdo"*.

O espírito é veto de corrupção — legítimo. A régua é que erra, **nos dois sentidos**, e isso já foi
medido:
- **Falso negativo:** um documento truncado que preserva 85% dos chars passa a guarda. Foi
  exatamente o que aconteceu no run `1b6eec3b` (spec de 14 → 7 seções com o teto de 64k), e por isso
  o `assessRevisionIntegrity` (inventário de seções) precisou ser criado na Onda de guardas.
- **Falso positivo:** na spec dividida, um redator que corretamente troca material duplicado por
  `ver contratos.md` encolhe o arquivo de propósito — e é reprovado por um número.

**Direção:** manter o veto, trocar o critério — quem manda é o inventário estrutural
(`assessRevisionIntegrity`, já implementado e em prod), com o ratio de chars rebaixado a **sinal de
log**, não a veto. O código continua vetando corrupção; só para de medi-la com a régua errada.

---

### J3 🟡 — "sem progresso" medido por contagem de GAP

**Código:** `specAutonomy.ts:82` (`MAX_NO_PROGRESS = 2`) — duas rodadas sem derrubar GAP importante
encerram o laço como `stalled`.

Como teto de custo seria conforme. O problema é o proxy: **a contagem de GAPs não é a medida do
trabalho**. Uma rodada que fecha um blocker e revela dois warnings novos (que existiam e estavam
escondidos) aparece como piora; uma rodada que enriquece um arquivo sem fechar finding aparece como
inútil. No run `1b6eec3b` os blockers foram de 1 → 6 justamente porque a spec ficou mais concreta.

**Direção:** manter o teto (é orçamento), mas quem decide "isto convergiu / isto empacou" tem de ser
o validador (que já vê antes/depois) e não uma subtração de inteiros. Enquanto não houver esse
veredito, `MAX_NO_PROGRESS` deve encerrar com o rótulo honesto — "teto de rodadas sem queda de
contagem" — e não com "sem progresso", que afirma algo que o código não sabe.

---

## 3. Achados de CORRUPÇÃO SILENCIOSA (a família dos dois bugs corrigidos hoje)

A Onda 5 já pagou por dois desses ao vivo: `_extract_json` cortava no primeiro fence interno
(`a483604`) e o envelope JSON do redator estourava com uma aspa não escapada em 29,5 kB
(`4f45475`). **O padrão sobrevive em mais quatro lugares.** Nenhum deles julga conteúdo — todos
destroem a resposta do agente e seguem em frente.

### C1 🔴 `lesson_extractor.py:140-148` — provável causa raiz do G7 (`lessons_corpus` = 0 linhas)

```python
if "```" in txt:
    m = _re.search(r"```(?:json)?\s*(.+?)```", txt, _re.DOTALL)   # NON-GREEDY
    if m: txt = m.group(1).strip()
lb, rb = txt.find("["), txt.rfind("]")                            # isola no texto JÁ CORTADO
```

Lição extraída de episódio real cita código — e código vem em cerca. O `(.+?)` fecha no primeiro
``` de dentro do array; o `rfind("]")` então acha um `]` aninhado do pedaço que sobrou → `json.loads`
falha → **zero lições**, silenciosamente. Isso é coerente com o G7 medido em prod (`lessons_corpus`
com 0 linhas, nenhum aprendizado saindo da Bancada), mas **não está confirmado como a única causa** —
o `RAG_ENABLED` ausente no agents é candidato concorrente. Correção é a mesma de hoje: varredura
balanceada de `[`/`{` respeitando strings, ou marcador.

### C2 🟡 `agents/runtime.py:1337-1338` e `:1774-1775`

```python
text = text.split("```json")[1].split("```")[0].strip()
```

Fallback do parser de envelope. Mesmo corte no primeiro fence interno — e como é *fallback*, ele só
roda quando algo já deu errado, ou seja, justamente quando não se pode perder informação. O `except`
seguinte transforma o prejuízo em `status: "FAIL"` com `summary` truncado em 500 chars: o motivo real
morre ali.

### C3 🟡 `envelope.py:313-321` e `:332-340`

Mesmo `split("```")[1].split("```")[0]` no caminho principal do envelope. Mitigado em parte porque
`inner.startswith("{")` tem precedência (comentário explícito no código), mas o caminho de cerca
segue vivo para toda resposta que não comece com `{`.

**Direção (um plano só para os três):** extrair a varredura balanceada já escrita e testada em
`product_architect._json_object_candidates` para um módulo de transporte único
(`orchestrator/json_transport.py`) e passar C1/C2/C3 a usá-lo, com teste de regressão por caso real
(cerca dentro do conteúdo, marcador ecoado, resposta truncada). Zero mudança de comportamento
agêntico — só para de perder o que o agente disse.

---

## 4. Políticas de fronteira (documentar, não necessariamente mudar)

### P1 🟡 `specSemanticGate.ts:41` — o juiz vê 12k de 346k

`MAX_CONTENT_CHARS = 12_000` corta a spec antes de mandar ao gate de admissão. Para a spec dividida
de hoje, o juiz decide sobre **3,5%** do documento. Mitigado por ser fail-open
(`MIN_CONFIDENCE = 0.75`, dúvida deixa passar), e o corte é de custo — legítimo. O que **não** é
legítimo é o gate não saber que viu uma amostra: o prompt afirma "recebe o CONTEÚDO". Correção
barata: dizer ao agente que é amostra de N chars de um total de M, e amostrar início+meio+fim em vez
do prefixo.

### P2 🟢 `specChatJobs.ts:471` — `SALVAGE_MIN_CHARS = 1_500`

Suprime a OFERTA de recuperação de artefatos minúsculos. Não escreve nada, não descarta o dado (a
run fica no banco), protege o usuário de sobrescrever a spec real por um esqueleto. Fica como
política declarada; se algum dia gerar reclamação, o caminho é oferecer com aviso em vez de esconder.

### P3 🟢 `product_architect.py:57-66`, `:450` — `kind` por mapa de nome

`FILE_KIND_BY_NAME` mapeia 5 nomes que o **próprio prompt** (`SPLIT_PROJECT_FILES_PROMPT.md`)
prescreve → transporte, não julgamento. O detalhe ruim é o `default`: nome fora do mapa cai em
`"other"` **em silêncio**. Se o agente criar um temático legítimo (`observabilidade.md`), o
ProductManifest recebe `kind: other` sem que ninguém saiba. Correção mínima: o arquiteto emite o
`kind` (enum Connect) no plano e o código só veta valor fora do enum; ou, mais barato, avisar quando
cair no default.

### O1 🟡 `spec_finding_triage` — 0 linhas em produção

A triagem da RFC-0005 (Ativos | Ignorados | Resolvidos | Refutados) está implementada, deployada e
**nunca foi usada**: `SELECT count(*)` = 0 no banco de prod inteiro. Efeito colateral silencioso:
"GAP ativo" hoje é sinônimo de "todo finding da última run", e portanto o gate do modo autônomo e a
contagem de blockers nunca sofreram o teste de um humano dizendo "este é refutado". Não é violação
de lei — é uma feature paga e inerte, e um risco de que o laço autônomo persiga GAP que o dono do
produto já descartaria.

---

## 5. O que NÃO é violação (padrão de referência)

Vale registrar, porque a auditoria confirma que a Bancada já sabe fazer isso certo:

| Onde | Por que é exemplar |
|---|---|
| `specGapScope.ts:95-113` `resolveFindingPath` | Cascata exato → ci → basename → sufixo e, **na ambiguidade, devolve `null`** em vez de "pega o primeiro". O comentário diz a razão: escolher seria julgar. |
| `specGapScope.ts:406-423` roteador | Falha de LLM **não inventa rota**; finding continua `unrouted` e a UI diz isso. Path inexistente devolvido pelo modelo é descartado ("não grava lixo"). |
| `spec_file_splitter` aviso "<50%" | Encolhimento vira **aviso ao humano**, não veto — e existe teste que garante que continua sendo aviso. |
| `spec_file_splitter` recusas de nome/cobertura | Seção órfã volta como **feedback ao arquiteto** antes de virar veto: o agente ganha uma segunda chance com o defeito na mão. |
| `assessRevisionIntegrity` | Veta por inventário de seções perdidas — evidência de corrupção, não régua de tamanho. |
| `validate_response_quality` (pós PR-0/F1) | O bug de reprovar todo artefato `format:"edits"` é o precedente perfeito desta auditoria: o código vetava um formato que o agente tinha o direito de usar. Já corrigido. |

---

## 6. Fila sugerida de correção (cada linha = um plano)

| Ordem | Item | Por que primeiro |
|---|---|---|
| 1 | **J1** rota de GAP após divisão | Sem isso a F2 (revisar por arquivo) não entrega: a fila aponta para o índice. Bloqueia o valor da Onda 5. |
| 2 | **C1** transporte de JSON único (fecha C1/C2/C3) | Código já escrito e testado hoje; muito barato e possivelmente destrava o G7 (aprendizado). |
| 3 | **J2/J3** trocar régua por inventário/veredito | Deixa o laço autônomo parar pelo motivo certo e com o rótulo honesto. |
| 4 | **P1** gate ciente de amostra | Barato, tira uma afirmação falsa do prompt. |
| 5 | **O1** usar (ou aposentar) a triagem | Decisão do dono: feature paga inerte. |
| 6 | **P3** `kind` pelo agente | Cosmético hoje; vira dívida quando o Connect apertar `kind`. |

---

## 7. Rastro das medições

- `GET /api/specs/e2a1988c-bb4b-437b-a7b3-96192b837717/gap-scope` em prod, 2026-09-06 — J1.
- `spec_validation_runs` do LastMile: `0aa0495c` (`failed`, 17 findings, spec monolítica,
  `spec_hash bec0d8dc…`) → divisão aplicada → `e4ba0dbe` (spec dividida, `spec_hash 187cee38…`).
- `spec_autonomy_runs` `1b6eec3b` (`exhausted`, `whole`, 5 rodadas, `gaps_initial 15 → gaps_current 15`) — J2/J3.
- `SELECT count(*) FROM spec_finding_triage` = 0 (prod) — O1.
- Commits que fecham a família de C1–C3 no `spec_file_splitter`/`product_architect`: `a483604`, `4f45475`.
