> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Orçamento de contexto dos agentes — acabar com o truncamento cego de 30k

> **Status:** desenho v1 + revisão adversarial + GAPs fechados → pronto para implementar.
> **Origem:** Jean, 2026-09-05 — *"acredito não podemos limitar a quantidade de caracteres a números
> pequenos, a fábrica usa limites grandes ou não?"*
> **Achado que motivou:** [`genesis-cto-spec-raw-truncado-30k-2026-09-04`] — spec de 39.907 chars
> chegou cortada em 30.000 ao CTO, que devolveu um documento-aviso de 11.553 chars em vez da spec.

---

## 1. Fatos medidos (não estimativas)

| Camada | Teto hoje | Configurável | Arquivo |
|---|---|---|---|
| Fábrica com `pipeline_ctx` | **40.000** por campo | `AGENT_INPUT_CHARS` (não setado em prod → default) | `runner.py:1055` |
| Fábrica sem `pipeline_ctx` | **20.000** | não | `runner.py:1077` |
| Fábrica (charter) | **15.000** | não | `runner.py:1002-1006` |
| PM | **40.000** | `AGENT_INPUT_CHARS` | `runner.py:1759` |
| `PipelineContext` | **40.000** | `AGENT_INPUT_CHARS` | `pipeline_context.py:225` |
| **Montador de prompt — vale para TODOS** | **`spec_raw[:30000]`** | **não** | `runtime.py:194` |
| **Idem** | **`product_spec[:20000]`** | **não** | `runtime.py:205` |
| Idem | `engineer/charter/backlog [:15000]` | não | `runtime.py:208-214` |
| Janela real dos modelos | **200.000 tokens** (`max_output` 64.000 no Opus 5) | — | `runtime.py:87-116` |

**Consequências medidas:**

1. **`AGENT_INPUT_CHARS=40000` é parcialmente inerte.** O montador roda depois e corta em 30.000.
   Qualquer documento entre 30k e 40k perde o excedente **em silêncio, na fábrica também**.
2. **Utilização real em prod: 13,7–13,9%** da janela (log dos agents, 24h). O `SYSTEM_PROMPT.md` do
   CTO sozinho tem **77.233 chars**. Ou seja: o gargalo **não é capacidade**, é número herdado.
3. **A mesma spec entra DUAS vezes, cortada em pontos diferentes.** `runner.py:1061-1062` e
   `specChat.ts:303-304` preenchem `spec_raw` **e** `product_spec` com o mesmo conteúdo → no caso do
   Jean, 39.907 chars viraram 50.000 no prompt, em duas cópias divergentes (uma cortada em 30k, outra
   em 20k). Custo dobrado e duas versões contraditórias do "mesmo" documento.
4. **Nenhum marcador de corte** em `spec_raw`/`product_spec`/`charter`/`backlog`/`engineer` — o modelo
   não sabe que o documento está incompleto e **adivinha**. `dependency_code` (`runtime.py:187-188`) e
   `existing_artifacts` (`:257`) **já marcam** (`... [truncado]`): a inconsistência é no mesmo arquivo.

---

## 2. Restrição que manda no teto: não é a janela, é o `max_output`

O modo do CTO (`spec_intake_and_normalize` — usado tanto pela fábrica quanto pela Bancada) **reemite a
spec inteira** em `artifacts[].content`. Logo o teto útil da ENTRADA é o que o modelo consegue
DEVOLVER, não o que ele consegue LER:

```
cap_chars = (max_output_tokens − reserva) × 4 × fator_seguranca
```

- `reserva = 8.000 tokens` — `<thinking>` + envelope JSON + `summary`/`evidence`.
- `fator = 0,65` — escape de JSON, acentuação (PT-BR gasta mais tokens/char) e folga para o modelo
  expandir a spec (o CTO **enriquece**, não só copia).

| Modelo | `max_output` | cap calculado | vs. hoje |
|---|---|---|---|
| Opus 5 / Sonnet 5 / Opus 4.8 | 64.000 | **145.600** | 4,85× |
| Fable 5.1 | 32.000 | **62.400** | 2,08× |
| Haiku 4.5 | 8.192 | 499 → **piso 30.000** | 1× (sem regressão) |
| Modelo desconhecido (`_DEFAULT_LIMITS` 16.000) | 16.000 | 20.800 → **piso 30.000** | 1× |

**Piso inegociável de 30.000** = teto atual. Nenhum caminho pode ficar PIOR do que está.

Sanidade do maior caso: 145.600 chars de spec = ~36k tokens. Somando system (~25k) e o resto,
utilização vai a ~35% — bem abaixo do WARNING de 60% que `calculate_token_budget` já emite, e
`safe_max_tokens` continua entregando os 64k de saída.

---

## 3. Desenho

Tudo em **um** lugar: `build_user_message()` em `runtime.py`. Ele é o gargalo mais baixo (30k < 40k da
fábrica), então corrigir ali **beneficia a Bancada E a fábrica** sem tocar no `runner.py`.

### D1 — `_prompt_budget(model, role) -> dict[str, int]`
Deriva os caps de `MODEL_LIMITS` (Claude) ou `_OPENAI_MODEL_LIMITS` (Foundry/local), com a fórmula da
§2. Devolve cap por campo, escalando os pisos atuais pelo mesmo fator:
`spec_raw` 30k · `product_spec` 20k · `engineer` / `charter` / `backlog` 15k → × k (k = cap/30.000).

### D2 — `_clip(text, cap, label) -> str`
Corta **e avisa**. Marcador **sem reticências** (ver GAP-3) e com ordem de não copiar:

```
⚠️ [CORTE DE CONTEXTO] Este documento foi cortado aqui: {mostrados} de {total} caracteres
({omitidos} omitidos). Ele está INCOMPLETO. NÃO reescreva o que você não viu e NÃO copie
esta marca para nenhum artefato.
```

Emite `logger.warning` estruturado por campo cortado (campo, total, cap, modelo) — hoje o corte é
invisível na operação.

### D3 — Deduplicação `spec_raw` × `product_spec`
Se `product_spec` for igual a `spec_raw` (ou prefixo dele, que é o resultado de cortes diferentes do
mesmo texto), **omitir** o bloco `## Product Spec Atual` e injetar uma linha dizendo que é o mesmo
documento. Economiza até 20k chars e mata as duas cópias divergentes. Quando são documentos
diferentes de verdade (`spec_raw` = upload cru, `product_spec` = `PRODUCT_SPEC.md` normalizado —
`runner.py:1465`), nada muda.

### D4 — Orçamento global com prioridade
Ordem: `spec_raw` > `product_spec` > `charter` > `backlog` > `engineer`. Cada campo recebe
`min(cap_do_campo, sobra_global)`. Global default = `int(context × 4 × 0,35)` = **280.000 chars**
(200k tokens). Impede que 5 documentos grandes somados estourem a janela.

**Desvio 1 (na implementação):** o piso do orçamento global é o **piso histórico de 30.000**, não o
`spec_cap` do modelo. Travar o global no `spec_cap` deixaria `AGENT_PROMPT_TOTAL_CHARS` **inerte**
(qualquer valor abaixo de 145.600 seria ignorado no Opus 5) — o mesmo tipo de defeito que
`AGENT_INPUT_CHARS` já tem hoje. Com o piso em 30.000, `spec_raw` nunca fica pior do que está e o
override continua valendo. Provado em `test_global_nunca_desce_abaixo_do_piso_historico`.

**Desvio 2 (na implementação):** o orçamento é **gasto** em ordem de prioridade, mas os blocos são
**emitidos** na ordem histórica (Engineer → Charter → Backlog). Reordenar o prompt seria mudança de
comportamento não pedida e quebraria a garantia de byte-identidade da flag off (GAP-8). Provado em
`test_ordem_dos_blocos_preservada`.

### D5 — Kill-switch e overrides
- `AGENT_PROMPT_BUDGET=off` → comportamento **byte-idêntico** ao de hoje (30k/20k/15k, sem marcador,
  sem dedupe). É o rollback sem redeploy.
- `AGENT_PROMPT_SPEC_CHARS` → força o cap do `spec_raw` (ignora a fórmula).
- `AGENT_PROMPT_TOTAL_CHARS` → força o orçamento global.

### D6 — `build_user_message(message, role="", model="")`
Novo parâmetro **opcional** `model`. Sem ele (testes antigos, chamadores não atualizados) → cai em
`_DEFAULT_LIMITS` → pisos → comportamento atual. Os 3 chamadores reais (`runtime.py:784`, `:994`,
`:1009`) já têm `model` em escopo e passam.

### FORA de escopo (deliberado)
- `existing_artifacts` (QA 200k / Dev 8k / `EVOLUTION_DEV_SCOPE_FULL_CHARS`) — outra frente, já tem
  orçamento próprio e marcador.
- Elevar `AGENT_INPUT_CHARS` da fábrica de 40k. **Só faz diferença para specs > 40k** e encarece
  TODA chamada do pipeline. Vira decisão do Jean depois de medir o efeito deste bloco. Registrar.
- Parar a duplicação na origem (`specChat.ts:303-304`, `runner.py:1061-1062`). A dedupe central (D3)
  já resolve o prompt; mexer na origem é churn sem ganho adicional agora.

---

## 4. Revisão adversarial — GAPs e como cada um foi fechado

| # | GAP | Fechamento |
|---|---|---|
| **1** | **Elevar entrada rouba a saída.** `max_tokens = min(env_max, safe_max_tokens)` e `safe_max_tokens = context − input − 1000` (`runtime.py:530`, `:1049`). Input maior ⇒ saída menor ⇒ JSON truncado ⇒ `BLOCKED`. | Cap derivado do **`max_output`** (§2), não da janela. No pior caso a utilização vai a ~35%: `safe_max_tokens` continua ≥ 64k. D4 (global 35%) é a trava dura. |
| **2** | **A spec precisa CABER NA SAÍDA.** Aceitar 400k de entrada num modo que reemite a spec garante saída truncada. | É a razão de o cap sair do `max_output`. `spec_intake_and_normalize` nunca recebe mais do que consegue devolver. |
| **3** | 🔴 **O marcador de corte pode virar falso positivo do detector de truncamento.** `envelope.py:163-224` reprova `[...]`, `"# ..."`, `"... mais"`, `"content omitted"`, `"rest of file"` e linha `.md` terminando em `...` com 5+ palavras. Se o modelo copiar o marcador para o artefato → repair de ~19 min de Opus 5 → estoura o job (foi exatamente o que aconteceu em 2026-09-04). | Marcador **sem reticências** e sem nenhuma das frases da lista, + ordem explícita "NÃO copie esta marca". Teste automatizado: `validate_response_quality` aprova um artefato que contenha o marcador. |
| **4** | **Modelo desconhecido** cai em `_DEFAULT_LIMITS` (`max_output` 16.000) → cap calculado 20.800 < 30.000 atual = **regressão**. | Piso `max(30_000, calculado)` por campo. Provado em teste. |
| **5** | **Foundry/OpenAI tem outra tabela** (`_OPENAI_MODEL_LIMITS`). Usar `MODEL_LIMITS` para um modelo Foundry devolve o default e regride o stack local. | `_prompt_budget` consulta as **duas** tabelas (Claude primeiro, OpenAI depois) antes de cair no default. |
| **6** | **`build_user_message` não conhece o modelo** hoje — assinatura `(message, role)`. Mudar a assinatura quebra chamadores/testes. | Parâmetro **opcional** `model=""` (D6). Sem ele, comportamento idêntico ao atual. Os testes existentes (`tests/test_runtime_build_user_message.py`) continuam passando sem edição. |
| **7** | **Custo.** Mais contexto = mais tokens de entrada em toda chamada. | Os caps só **prendem** documentos grandes; para spec < 30k **nada muda**. E a dedupe (D3) **reduz** ~20k chars por chamada no caminho da Bancada: para o caso comum o resultado é **mais barato**, não mais caro. |
| **8** | **Prompt é superfície de regressão de TODOS os agentes** (Dev, QA, PM, Engineer, DevOps). Um deslize degrada a fábrica inteira. | Kill-switch `AGENT_PROMPT_BUDGET=off` (D5) = rollback sem redeploy. Testes que provam prompt **byte-idêntico** com a flag off. Deploy em janela quieta + prova ao vivo. |
| **9** | **Dedupe pode esconder um documento legitimamente diferente** (`product_spec` normalizado ≠ `spec_raw` cru). | Dedupe só quando **igualdade exata ou prefixo**. Documentos diferentes seguem ambos no prompt. Teste cobre os dois casos. |
| **10** | **Contagem de tokens é estimativa** (`len//4`, `runtime.py:526`). Em PT-BR com acentuação a razão real é pior (~3,3 chars/token) → subestima a entrada. | O `fator_seguranca = 0,65` da §2 já embute essa margem. Não vamos trocar o estimador nesta frente (mexeria em `calculate_token_budget`, usado no cálculo de `max_tokens` de todos os agentes). Registrado como dívida. |
| **11** | **`[1m]` (Opus 4.8 1M de contexto)** tem `context` 1.000.000 → o global de 35% daria 1,4M chars, absurdo. | O global é `min(35% da janela, teto absoluto 400.000 chars)`. |
| **12** | Cortar no meio de uma **cerca de código** ou de uma tabela deixa markdown quebrado, o que por si só confunde o modelo. | Fora de escopo (cortar em fronteira de seção é uma melhoria futura); com o cap 4,85× maior, o corte deixa de ocorrer no caso real. Registrado. |

---

## 5. Plano de execução

1. `_prompt_budget` + `_clip` + integração em `build_user_message` (D1–D4, D6).
2. Kill-switch + overrides (D5).
3. Testes: pisos sem regressão · marcador aprovado pelo detector · dedupe (igual/prefixo/diferente) ·
   flag off ⇒ prompt byte-idêntico · orçamento global respeitado · Foundry.
4. Rodar a suíte Python inteira (não só a nova).
5. Build + push ECR + deploy `agents` em janela quieta (nada em voo) + digest conferido.
6. **Prova ao vivo em prod**: disparar o CTO na spec de 39.907 chars do Jean e provar que ele
   **recebe o documento inteiro** (log sem `[CORTE DE CONTEXTO]`, resposta sem "aviso de fidelidade").
7. Persistir memória + reportar.
