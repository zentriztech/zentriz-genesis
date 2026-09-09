> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# RFC-0006 — Ferramentas de leitura na Bancada: o agente PEDE o contexto em vez de recebê-lo empurrado

| Campo | Valor |
|---|---|
| Status | **v1 — desenho para aprovação** (implementação NÃO iniciada; GAP-143 depende deste desenho) |
| Data | 2026-09-09 |
| Autor | Jean Ol'Bar + Claude (Genesis) |
| Estende | RFC-0003 (Bancada e splitter vivo) · RFC-0005 (controle de GAPs) |
| Fecha | **GAP-143** (o cérebro não tem ferramentas) e é a cura estrutural do **GAP-146** (o prompt do CTO é 99,4% contexto) |
| Pedido do Jean | *"a bancada deve ser tão inteligente quanto o Claude Code, tão produtiva, assertiva e realizar as entregas necessárias sem queimar tokens sem necessidade"* |

---

## 1. Problema — MEDIDO, não suposto

O censo do GAP-146 mediu em prod (9 chamadas de `spec_cto`, projeto NVX LastMile, run `9208c28c`) o
prompt que de fato SAI no caminho dominante da autonomia (`SPEC_CTO_EDIT_FORMAT=edits`, por arquivo):

| campo | chars | % |
|---|---:|---:|
| **total** | **145.291** | 100 |
| `file_content` | 85.004 | 58,5 |
| `oracles` | 31.557 | 21,7 |
| `siblings` | 18.549 | 12,8 |
| `system` | 3.144 | 2,2 |
| demais blocos (foco, contrato, histórico, GAPs persistentes) | 6.382 | 4,4 |
| **`gaps` — A TAREFA** | **828** | **0,57** |

Mais **~30.400 chars (~6.420 tokens) de prefixo de CAG** anexados no `agents` (≈16% do prompt).
Em 3 dias: **764 chamadas / 52,9 M tokens de entrada**, com razão entrada:saída de **20:1** — o custo da
Bancada é *reenviar texto*, não gerar texto.

**A causa não é falta de teto.** Já existem tetos e recortes em toda parte (digesto por arquivo, orçamento
de irmãos com seções citadas, teto de findings, orçamento de crescimento). A causa é o **modelo de
interação**: o código decide TUDO que o agente vai ler, ANTES de saber o que ele precisa, e empurra.
Toda melhoria dentro desse modelo é escolher melhor o palpite — GAP-135 (a declaração Connect lia por
ORDEM, não por relevância), GAP-75 (7 de 14 seções de irmão citadas nunca chegavam), GAP-72/73/74
(âncora perdida quando o recorte aperta) são o mesmo defeito reaparecendo em lugares diferentes.

O Claude Code não faz isso. Ele recebe um índice e **pede** o que precisa (`Read`, `Grep`, `Glob`),
lendo 2 mil chars de 3 arquivos em vez de 145 mil de doze. É a diferença entre *push* e *pull*.

## 2. Objetivo

Que o agente da Bancada **decida o que ler**, dentro de um orçamento declarado, com o código apenas
(a) transportando fatos, (b) executando a leitura pedida e (c) vetando corrupção — exatamente a LEI do
ecossistema (`feedback-genesis-100-llm-nunca-automacao-fixa`).

Critério de sucesso, medido pelo instrumento que já está em prod (`[prompt-census]`):
1. **custo**: chars de entrada por rodada cai ≥ 50% no caminho por-arquivo;
2. **não-regressão**: GAPs fechados por rodada e taxa de edição ancorada aplicada **não caem**
   (veto de não-regressão do GAP-13/14 continua valendo);
3. **assertividade**: rodadas descartadas pelo veto de crescimento caem (hoje o agente recebe 70 ordens
   de consolidação e 828 chars de tarefa na mesma chamada).

## 3. As ferramentas (contrato mínimo)

Cinco, todas **somente leitura**, todas com corte DECLARADO (`cutEvidence`/`cutList`, GAP-128/129/130):

| Ferramenta | Entrada | Devolve | Mata qual despesa |
|---|---|---|---|
| `list_spec_files` | — | por arquivo: `path`, `chars`, headings de nível 2/3 (índice, **nunca** corpo) | pré-requisito |
| `read_spec_file` | `path`, `section?`, `window?` | trecho **verbatim** + `de X a Y de Z chars` | `file_content` 85k |
| `search_spec` | `query`, `paths?` | `path:linha` + janela de contexto por casamento | `siblings` 18,5k |
| `read_oracle` | `contract_key` | regra vigente INTEGRAL + dono + quem redeclara | `oracles` 31,5k |
| `read_lesson` | `lesson_id` | corpo da lição do corpus RAG | CAG 30,4k |

O prompt passa a levar, obrigatoriamente e por inteiro: **a tarefa** (os GAPs), **o índice** (arquivos +
headings), **a identidade** dos contratos de oráculo (`contract_key → oraclePath`, sem o texto da regra —
já é o que o GAP-151 fez) e **os títulos** das lições disponíveis. Conteúdo, só por pedido.

**Nada desaparece — o que muda é quem pede.** Cada fato hoje empurrado continua alcançável por uma
ferramenta, e o bloco declara isso em texto: *"você NÃO recebeu o corpo dos arquivos; leia o que
precisar"*. Contexto que não é pedido não é contexto perdido: é contexto que o agente julgou irrelevante
— e essa é a decisão que a LEI manda deixar com ele.

## 4. Arquitetura — onde o laço de ferramentas mora

**Decisão: o laço mora na `api`, não no `agents`.** O `agents` continua um gateway fino de LLM.

Razões: (a) a api é quem já monta o prompt no caminho dominante (`buildGapFileRequest` → `/invoke/raw`);
(b) a api é quem tem o Postgres — as cinco ferramentas são consultas ao banco de specs, e mover isso para
o `agents` exigiria um canal de dados novo (rota interna + token com escopo do job) para nenhum ganho;
(c) o veto de escrita, o snapshot e a contagem de rodada já vivem na api.

O `agents` muda em TRANSPORTE apenas: `/invoke/raw` passa a aceitar `tools` e a devolver os blocos
`tool_use` com `stop_reason`, em vez de só texto. O dialeto Anthropic no Bedrock aceita `tools` no corpo
do `invoke/raw` — o mesmo caminho que hoje é o ÚNICO com entitlement dos modelos Claude 5 nesta conta
(`genesis-claude5-models-catalog-2026-09-03`: `converse` dá `AccessDenied` falso). **Famílias não-Anthropic
(`_call_converse`: Nova, Mistral, Qwen, DeepSeek, Llama) não compartilham o dialeto** ⇒ o revisor
cross-family (que é justamente quem roda nelas) **continua em modo push**, declarado por modelo. Uma
ferramenta oferecida a um modelo que não sabe pedi-la é um prompt inútil e caro.

```
api: buildGapFileRequest (índice, sem corpo)
  → /invoke/raw {tools}  → stop_reason=tool_use  → api EXECUTA (Postgres) → tool_result
  → /invoke/raw (…)      → stop_reason=end_turn  → edições ancoradas → veto → escrita
```

## 5. Os três riscos reais, e o que os contém

**R1 — custo pode SUBIR.** Cada turno reenvia a conversa inteira. Uma rodada com 6 leituras pode custar
mais do que o push de hoje. Contenção: é exatamente o caso em que o prefixo REPETE — e o GAP-142 já
entregou `cachePoint`/`cache_control` com opt-in do chamador, medido em prod (3 votos: entrada faturada
de 3N para 1,45N). O laço de ferramentas marca cache no prefixo estável **desde o primeiro turno**.
Registro honesto: no prompt de hoje esse cache seria regressão (medido: de 756 pares consecutivos da
mesma spec, só 3 compartilham os primeiros 2.000 chars) — o que muda com ferramentas é que o prefixo
passa a ser, por construção, o mesmo dentro da rodada.

**R2 — o agente pode não pedir.** É o modo de falha mais comum de tool use: o modelo responde sem ler e
alucina a âncora. Contenção em três camadas: (a) o veto de escrita já exige âncora que EXISTE no disco —
edição alucinada é rejeitada hoje e continuará sendo; (b) o bloco declara a ausência do corpo e a
obrigação de ler; (c) **medição**: uma rodada sem nenhuma chamada de `read_spec_file` é sinalizada no
censo — "não pediu" tem de ser um fato visível, não uma surpresa no resultado.

**R3 — latência.** N turnos sequenciais contra 1. Contenção: o dialeto permite VÁRIOS `tool_use` no mesmo
turno (ler 3 arquivos numa ida), teto declarado de turnos por rodada, e o paralelismo de lotes do GAP-145
(concorrência 4) já amortiza no nível do passe.

## 6. Rollout em 3 estágios (medir antes de cortar — a regra desta frente)

| Estágio | `SPEC_TOOLS` | O que acontece | O que se mede |
|---|---|---|---|
| 1 | `off` | nada muda | baseline (já em prod pelo censo) |
| 2 | **`shadow`** | ferramentas OFERECIDAS **e** o corpo continua empurrado | **o agente pede? o quê? quantas vezes?** Risco zero: nada é retirado do prompt |
| 3 | `live` | o corpo sai do prompt; só índice + tarefa | custo, GAPs fechados, âncoras aplicadas, rodadas descartadas |

O estágio 2 é o que impede este RFC de virar palpite: ele responde "o agente sabe pedir?" **antes** de
qualquer byte ser removido do prompt. Promoção de 2 para 3 exige veredicto do juiz (decisão do Jean de
2026-09-07: o laço fecha por VEREDICTO, não por contagem).

## 7. Propagação (Auto Care / Connect)

O mesmo defeito existe no cérebro da Fábrica (backlog registrado em
`genesis-backlog-fabrica-revisao-cerebro-e-multi-squad-2026-09-09`): o gerador de código recebe contexto
empurrado pelo orquestrador. As cinco ferramentas são de spec, mas o **padrão** — índice obrigatório,
conteúdo por pedido, corte declarado, estágio `shadow` antes de retirar — é transversal e deve ser
ensinado ao Deadpool/Auto Care junto com a lição no corpus (LEI do `feedback-ensinar-aprendizados-genesis-deadpool`).

## 8. Fora de escopo desta v1

- Ferramentas de ESCRITA (o agente já escreve por blocos ancorados; trocar isso mexeria no veto).
- Ferramentas para o revisor cross-family (dialeto não suporta).
- Tornar o CAG sob demanda (`read_lesson`) — desenhado aqui, mas a decisão do piso de similaridade tem
  medição própria pendente (censo do prefixo, `scores=melhor→pior`).
