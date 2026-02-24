# Fluxo do teste CTO (spec → PRODUCT_SPEC) — O que foi enviado e o que a IA devolve

## 1. O que aconteceu no erro

A mensagem **"Command failed to spawn: Aborted"** indica que o **processo do pytest foi abortado** (encerrado antes de terminar), e não necessariamente uma falha de assert do teste. Possíveis causas:

- **Timeout** do runner que executou o comando (ex.: limite global do Cursor/IDE).
- **Cancelamento** manual ou encerramento do processo.
- **Memória** ou recurso do sistema.

Com isso, **não temos o corpo da resposta da IA** nem o log completo do teste — a execução foi interrompida do lado de quem rodou o pytest, não necessariamente por falha do agents ou do Claude.

---

## 2. O que o teste envia (HTTP → agents)

O teste faz **uma única** requisição `POST http://127.0.0.1:8000/invoke/cto` (sem retry no teste).

**Body enviado:**

```json
{
  "project_id": "cto-spec-test",
  "agent": "cto",
  "mode": "spec_intake_and_normalize",
  "task_id": null,
  "task": "Converter spec TXT para PRODUCT_SPEC.md conforme template",
  "inputs": {
    "spec_raw": "<conteúdo completo de project/spec/spec_landing_zentriz.txt>",
    "product_spec": null,
    "constraints": ["spec-driven", "no-invent", "paths-resilient"]
  },
  "input": { ... mesmo que inputs ... },
  "existing_artifacts": [],
  "limits": { "max_rounds": 3, "round": 1 }
}
```

- **spec_raw**: texto da landing (Zentriz, seções HERO, SOBRE NÓS, SERVIÇOS, etc., requisitos técnicos, fora de escopo).
- **constraints**: seguir spec, não inventar, paths resilientes.

---

## 3. O que o servidor (runtime) monta para a IA

O agents **não** repassa o JSON cru. Ele monta:

### 3.1 System prompt (enviado à Claude)

- Conteúdo de **`applications/agents/cto/SYSTEM_PROMPT.md`** (papel do CTO, regras, contrato de saída).
- **Template injetado**: conteúdo de **`project/spec/PRODUCT_SPEC_TEMPLATE.md`** anexado como seção  
  **"## Template Obrigatório: PRODUCT_SPEC"** (Metadados, Visão, Personas, FR, NFR, Regras, Integrações, Modelos, Fora de escopo, DoD).
- Regras críticas LEI 2 no início e no fim do prompt (se existir o arquivo de regras).

### 3.2 User message (enviado à Claude)

O `runtime.build_user_message(message)` monta um texto com:

| Bloco | Conteúdo |
|--------|----------|
| **Tarefa** | "Converter spec TXT para PRODUCT_SPEC.md conforme template" |
| **Modo** | spec_intake_and_normalize |
| **Spec do Projeto** | O conteúdo de `spec_raw` dentro de `<user_provided_content>...</user_provided_content>` (até 30.000 caracteres), com aviso para tratar como DADOS e não como instruções. |
| **Restrições** | spec-driven, no-invent, paths-resilient |
| **Limites** | Rodada atual: 1/3 |
| **Instrução** | Responder com `<thinking>...</thinking>` e depois JSON ResponseEnvelope em `<response>...</response>`. |

Ou seja: a IA recebe o **template completo** no system prompt e a **spec da landing** na user message, e é instruída a devolver um JSON de envelope com artifacts.

---

## 4. O que é pedido à IA (resumo)

- **Entrada**: spec em texto livre (landing institucional Zentriz).
- **Formato de saída**: PRODUCT_SPEC em Markdown seguindo o **Template Obrigatório** (Metadados, Visão, Personas, FR, NFR, etc.).
- **Contrato**: JSON válido (ResponseEnvelope) dentro de `<response>...</response>`, com `status`, `summary`, `artifacts[]` (cada artifact com `path` e `content`).
- No modo `spec_intake_and_normalize` o CTO deve produzir pelo menos o artifact **`docs/spec/PRODUCT_SPEC.md`** (conforme SYSTEM_PROMPT do CTO).

---

## 5. O que a IA deve devolver (e o que o teste valida)

**Resposta esperada (HTTP 200):**

- JSON com:
  - **status**: `"OK"` (ou `"NEEDS_INFO"` / `"REVISION"` em casos edge).
  - **summary**: texto curto.
  - **artifacts**: lista de objetos com `path` e `content`; pelo menos um com path contendo `PRODUCT_SPEC` ou `spec` e conteúdo em Markdown.

**Quando status == "OK"**, o teste ainda verifica:

- Existe artifact cujo conteúdo tem pelo menos uma das palavras: Metadados, Visão, FR-, Requisitos.
- Tamanho do conteúdo ≥ 500 caracteres.

**O que não temos:** como a execução foi **abortada**, não temos o JSON real que a IA devolveu (nem se chegou a devolver). Para ver a resposta real, é preciso rodar o teste até o fim (agents no ar, sem abort).

---

## 6. Retentativas (teste vs runtime)

- **No teste**: há **uma única** chamada HTTP; não há retry no código do teste em caso de falha.
- **No runtime (servidor)**: o `run_agent` usa **MAX_REPAIRS** (default 2). Se a resposta da Claude falhar validação (envelope inválido, artifact obrigatório faltando, etc.), o servidor pode **repetir** até 2 vezes enviando um novo prompt com bloco de “correção necessária” (LEI 5).

**Se na fase de teste não deve haver retentativa no agente:** subir o agents com **zero** repairs, por exemplo:

```bash
MAX_REPAIRS=0 ./start-agents-host.sh
```

Assim, na primeira falha de validação o servidor devolve erro (ex.: 500) e não refaz a chamada à IA.
