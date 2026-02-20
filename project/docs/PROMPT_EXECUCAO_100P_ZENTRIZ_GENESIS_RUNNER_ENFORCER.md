# Prompt de Execução (AGRESSIVO) — Destravar 100% Zentriz Genesis (Runner Enforcer + Agentes Funcionais)
**Data:** 2026-02-20  
**SSOT (fonte de verdade):** `PIPELINE_V2_IA_REAL_AND_PATHS.md`  
**Complemento humano:** `ACTORS_AND_RESPONSIBILITIES.md`  
**Agentes atuais:** `agents.zip` (cada agente tem `SYSTEM_PROMPT.md` + `skills.md`)

> **Use este arquivo como a instrução única** para a IA (Cursor/LLM) que vai implementar o runtime.  
> **Não é um plano “bonito”**: é um plano **executável**, com gates, DoD e checklist de PR.

---

## 0) Missão (1 frase)
Transformar o runtime em um **ENFORCER resiliente** que garante que cada agente produza **artefatos reais** nos **paths corretos**, com **contratos validados**, até `DONE`, sem depender de “boa vontade” da LLM.

---

## 1) Resultado esperado (o que deve acontecer quando rodar)
Ao executar um ciclo completo:

1) **Entrada livre do usuário** → CTO gera `docs/spec/PRODUCT_SPEC.md` no template.
2) Engineer gera `docs/engineer/*.md` e CTO valida (loop com limite).
3) PM gera `docs/pm/<squad>/BACKLOG.md` e CTO valida (loop com limite).
4) Dev gera **código real** em `apps/` (1+ arquivos por task).
5) QA valida com verdict binário `QA_PASS|QA_FAIL` + `docs/qa/QA_REPORT_<task_id>.md`.
6) Monitor mantém o ciclo vivo (state machine) até `DONE` ou escala `BLOCKED` com evidência.
7) O runtime:
   - rejeita resposta fora do envelope,
   - aplica gates,
   - executa repair/retry,
   - persiste artefatos,
   - repassa estado correto para o próximo agente.

---

## 2) Regras absolutas (NÃO NEGOCIÁVEIS)
### 2.1 O runtime é “enforcer”, não “caller”
- O runtime **não aceita** respostas fora do contrato.
- Se a resposta falhar em qualquer gate → **repair automático**.
- Se falhar após repairs → **BLOCKED** + escalonamento para Monitor/CTO.

### 2.2 Path policy (obrigatório, resiliente)
Todos os arquivos precisam ficar sob:
`PROJECT_FILES_ROOT/<project_id>/{docs,project,apps}/...`

**Proibido**
- path absoluto
- `..` / traversal
- `~`
- escrever fora de `docs/`, `project/`, `apps/`

**Regra dura**
- `artifact.path` deve começar com `docs/` ou `project/` ou `apps/` (relativo).

### 2.3 “IA sempre devolve arquivo”
Em modos de gerar/converter/validar: **artifacts[] nunca pode ser vazio**.

### 2.4 “OK exige evidência”
`status=OK` exige `evidence.length > 0`.

### 2.5 “NEEDS_INFO exige perguntas mínimas”
`status=NEEDS_INFO` exige `next_actions.questions.length > 0` (máx 7 perguntas).

---

## 3) Estrutura recomendada do repositório (para implementar sem bagunça)
> Se o repo já existe, adapte mantendo o mínimo de mudanças.

```
contracts/
  AGENT_PROTOCOL.md                # SSOT executável: contratos, gates, repair, paths, estados

runtime/
  envelope.py                      # MessageEnvelope / ResponseEnvelope (types + validation)
  validator.py                     # gates por modo/agente + path validator + schema checks
  llm_runner.py                    # call_llm + retry + repair_loop + circuit_breaker
  prompt_bundle.py                 # compõe prompt final (protocol + system + skills + envelope + context)
  storage.py                       # write_artifacts + list_existing_artifacts + atomic write + locks
  audit.py                         # AgentRunRecord (logs estruturados por chamada)
  state.py                         # TaskState model (Monitor) + transitions + limits

tests/
  test_pipeline_smoke.py           # smoke E2E
  test_validator.py                # unit: schema/paths/gates
  test_storage.py                  # unit: atomic write, traversal blocked

agents/
  <agent>/<variant>/
    SYSTEM_PROMPT.md
    skills.md
```

---

## 3bis) Mapeamento para o repositório ATUAL (implementar aqui)
> Implementar **sem** criar pasta `runtime/` nova; usar estrutura existente.

| Entregável do plano | Onde implementar no repo atual |
|---------------------|--------------------------------|
| Schemas + validator (gates por modo) | `applications/orchestrator/envelope.py` — adicionar `get_requirements_for_mode(agent, mode)` e `validate_response_envelope_for_mode(data, agent, mode)` |
| Prompt bundling + skills | `applications/orchestrator/agents/runtime.py` — em `load_system_prompt()`: após expandir PROTOCOL_SHARED, carregar `skills.md` do mesmo dir do SYSTEM_PROMPT e anexar ao conteúdo |
| Retry + repair loop + circuit breaker | `applications/orchestrator/agents/runtime.py` — em `run_agent()`: após resposta, validar com gates do modo; se falhar, até 2 repairs (user_content += repair_prompt); contador de falhas consecutivas por (project_id, agent, mode) → 3 = BLOCKED |
| MessageEnvelope completo | `applications/orchestrator/runner.py` — em cada `call_*`: montar dict com `project_id`, `agent`, `variant`, `mode`, `task_id`, `task`, `inputs`, `existing_artifacts`, `limits`; no Monitor Loop passar `task_id`, `task` (descrição) e `code_refs`/existing_artifacts para Dev e QA |
| Storage atômico + path policy | Já em `applications/orchestrator/project_storage.py`; manter |
| Audit (AgentRunRecord) | `applications/orchestrator/runner.py` — em `_audit_log()`: incluir validator_pass/fail, validation_errors, artifacts_paths; opcional: escrever em `docs/monitor/audit/` por project_id |
| Smoke tests | `applications/orchestrator/tests/test_enforcer_smoke.py` (validator gates, repair flow com mock, pipeline smoke) |

**Compatibilidade**: Runner pode continuar enviando o payload para `run_agent(message=...)`; o `message` deve ser o MessageEnvelope completo quando o runner for atualizado. O serviço HTTP (agents) recebe body e repassa como está; o runner (orchestrator) é quem monta o envelope.

---

## 4) Contratos (schemas) — IMPLEMENTAR E VALIDAR
### 4.1 MessageEnvelope (entrada)
**Campos obrigatórios**
- `project_id`
- `agent` (enum)
- `variant` (string)
- `mode` (string)
- `task` (string)
- `inputs` (dict)
- `existing_artifacts` (list)
- `limits` (dict)

**Exemplo**
```json
{
  "project_id": "my-project",
  "agent": "Dev",
  "variant": "backend",
  "mode": "implement_task",
  "task_id": "TSK-BE-001",
  "task": "Implementar endpoint POST /orders conforme FR-02 e NFR-03",
  "inputs": {
    "product_spec": "…",
    "backlog": "…",
    "constraints": ["spec-driven", "paths-resilient", "no-invent"]
  },
  "existing_artifacts": [
    {"path": "docs/spec/PRODUCT_SPEC.md", "summary": "…"},
    {"path": "docs/pm/backend/BACKLOG.md", "summary": "…"}
  ],
  "limits": {"max_rounds": 3, "max_rework": 3, "timeout_sec": 60}
}
```

### 4.2 ResponseEnvelope (saída)
**Campos obrigatórios**
- `status` (enum)
- `summary` (string)
- `artifacts[]` (list; obrigatório em modos de geração/validação)
- `evidence[]` (obrigatório quando OK)
- `next_actions.owner/items/questions`
- `meta.round/model/idempotency_key`

**Exemplo**
```json
{
  "status": "OK",
  "summary": "Implemented orders endpoint and related validation.",
  "artifacts": [
    {
      "path": "apps/backend/src/orders/orders.controller.ts",
      "content": "/* full file */",
      "format": "code",
      "purpose": "Orders controller"
    },
    {
      "path": "docs/dev/dev_implementation_TSK-BE-001.md",
      "content": "# Implementation\n…",
      "format": "markdown"
    }
  ],
  "evidence": [
    {"type": "spec_ref", "ref": "inputs.product_spec", "note": "FR-02 mapped to POST /orders"},
    {"type": "file_ref", "ref": "docs/pm/backend/BACKLOG.md", "note": "Task acceptance criteria followed"}
  ],
  "next_actions": {
    "owner": "Monitor",
    "items": ["Trigger QA validate_task for TSK-BE-001 using code_refs from artifacts."],
    "questions": []
  },
  "meta": {"round": 1, "model": "claude-…", "idempotency_key": "my-project:dev:TSK-BE-001:r1"}
}
```

---

## 5) Gates por agente e por modo (runtime deve aplicar automaticamente)
> **Obrigatório**: a validação não é “texto”. É lógica no `runtime/validator.py`.

### 5.1 Gates globais (todos)
- JSON parseável
- nenhum texto fora do JSON
- `artifact.path` permitido
- traversal bloqueado
- `status=OK` ⇒ evidence não-vazio
- `status=NEEDS_INFO` ⇒ questions não-vazio

### 5.2 CTO
**spec_intake_and_normalize**
- artifact obrigatório: `docs/spec/PRODUCT_SPEC.md`
- deve conter seções `## 0`…`## 9`
- deve conter ao menos 1 `FR-`
- deve usar `TBD/UNKNOWN` onde faltar
- evidence: 2–5 refs para `inputs.spec_raw` (se existir)

**validate_engineer_docs**
- artifact obrigatório: `docs/cto/cto_engineer_validation.md`
- se gaps: `status=REVISION` + lista objetiva

**validate_backlog**
- artifact obrigatório: `docs/cto/cto_backlog_validation.md`

### 5.3 Engineer
**generate_engineering_docs**
- artifacts obrigatórios:
  - `docs/engineer/engineer_proposal.md`
  - `docs/engineer/engineer_architecture.md`
  - `docs/engineer/engineer_dependencies.md`

### 5.4 PM
**generate_backlog**
- artifact obrigatório: `docs/pm/<squad>/BACKLOG.md`
- cada task deve ter: objetivo, escopo, critérios de aceite, teste esperado, dependências

### 5.5 Dev
**implement_task**
- deve produzir **1+ arquivos em `apps/`**
- deve produzir `docs/dev/dev_implementation_<task_id>.md`
- proibido: responder só com “explicação”
- se precisar mudar arquitetura: `status=NEEDS_INFO` e escalar para PM/CTO

### 5.6 QA
**validate_task**
- `status` deve ser `QA_PASS` ou `QA_FAIL`
- artifact obrigatório: `docs/qa/QA_REPORT_<task_id>.md`
- report deve conter: mapeamento FR/NFR, steps, evidências, severidade, recomendação acionável

### 5.7 Monitor
**orchestrate**
- artifacts obrigatórios:
  - `docs/monitor/TASK_STATE.json`
  - `docs/monitor/STATUS.md`
- deve sempre definir `next_actions.owner` + `items`
- deve aplicar `limits.max_rework` e escalar ao estourar

---

## 6) Repair/Retry/Circuit Breaker (resiliência obrigatória)
### 6.1 Retry
- 3 tentativas por chamada (backoff)
- timeout por tentativa: `limits.timeout_sec`

### 6.2 Repair loop (usar quando falhar em gates)
- no máximo 2 repairs (com prompt curto)
- repair #1: “Retorne somente JSON válido…”
- repair #2: “Corrija especificamente: (lista de falhas do validator)”

### 6.3 Circuit breaker
- 3 falhas consecutivas (mesmo mode) ⇒ `BLOCKED`
- registrar audit record + escalar para Monitor/CTO

---

## 7) Prompt bundling (para a LLM obedecer)
O runtime deve compor o prompt final assim:

1) `contracts/AGENT_PROTOCOL.md`
2) `agents/<agent>/<variant>/SYSTEM_PROMPT.md`
3) `agents/<agent>/<variant>/skills.md` (**conteúdo completo**, não link)
4) `MessageEnvelope` (inteiro, como JSON)
5) `existing_artifacts` relevantes (resumos/trechos, quando possível)

---

## 8) Auditoria (AgentRunRecord) — obrigatório para debug
A cada chamada, salvar um registro (ex.: `project/audit/` ou `docs/monitor/audit/`):

**Campos mínimos**
- timestamp
- project_id
- agent/mode/task_id
- request hash (idempotency_key)
- model
- validator result (pass/fail + reasons)
- artifacts paths gerados
- status final

---

## 9) Smoke tests (DoD objetivo — se falhar, não terminou)
Criar testes que provam que o sistema funciona **sem depender do modelo** (use mocks/stubs quando necessário):

1) **Spec livre → PRODUCT_SPEC**
2) **Dev implement_task → apps/**
3) **QA validate_task → verdict**
4) **Monitor orchestrate → next_actions**
5) **Traversal blocked**

---

## 10) Tarefas (Execução incremental — NÃO refatorar tudo)
### Step 1 — Schemas + validator
- Em `envelope.py`: função `get_requirements_for_mode(agent: str, mode: str) -> tuple[bool, bool]` (require_artifacts, require_evidence_when_ok); função `validate_response_envelope_for_mode(data, agent, mode) -> tuple[bool, list[str]]` que chama `validate_response_envelope` com esses flags e valida artefatos obrigatórios por modo (paths mínimos).
### Step 2 — Prompt bundling + skills injection
- Em `agents/runtime.py` `load_system_prompt()`: resolver dir do SYSTEM_PROMPT; se existir `skills.md` no mesmo dir, ler e anexar `\n\n## Competências (skills.md)\n\n` + conteúdo.
### Step 3 — LLM runner (retry + repair + breaker)
- Em `run_agent()`: aceitar parâmetro opcional `mode` (ou extrair de message); após obter raw_text, parse + validate com `validate_response_envelope_for_mode` (ou `parse_response_envelope` com flags do modo); se houver erros, até 2 repairs: reenviar user_content + repair_prompt() ou repair com lista de erros; se após repairs ainda falhar, retornar envelope com status BLOCKED e summary com erros. Circuit breaker: dict global ou por request `_circuit_failures[(project_id, agent, mode)]`; em falha de validação ou exceção incrementar; em sucesso zerar; se >= 3 retornar BLOCKED.
### Step 4 — Storage (atomic write + locks + listing)
- Já implementado em `project_storage.py`. Garantir que runner usa `filter_artifacts_by_path_policy` antes de escrever (já faz).
### Step 5 — Audit
- Em `runner.py` `_audit_log()`: além de agent/request_id/response, registrar `validator_pass`, `validation_errors` (lista), `artifacts_paths` (lista de paths).
### Step 6 — Smoke E2E com mocks
- `orchestrator/tests/test_enforcer_smoke.py`: (1) validator rejeita JSON inválido, artifacts vazios quando require_artifacts, path inválido, traversal; (2) repair_prompt() não vazio; (3) get_requirements_for_mode retorna (True, True) para implement_task e validate_task; (4) opcional: mock run_agent e verificar que repair é chamado quando resposta inválida.

---

## 11) Checklist de PR (obrigatório — não aprovar sem isso)
- [ ] unit + smoke tests passam
- [ ] validator rejeita: JSON inválido, artifacts vazios, evidence vazio, path inválido, traversal
- [ ] repair loop funciona
- [ ] skills.md injetado de verdade
- [ ] Dev → QA handoff com code_refs reais
- [ ] Monitor sempre aponta próximo dono
- [ ] nenhuma escrita fora de `<project_id>/...`

---

## 12) Prompt final para IA executar (copiar e colar)
```md
# EXECUTE AGORA — Zentriz Genesis Runner Enforcer (100%)

SSOT: PIPELINE_V2_IA_REAL_AND_PATHS.md é a única fonte de verdade.

Implemente runtime resiliente (enforcer) com:
- MessageEnvelope completo em todas as chamadas
- ResponseEnvelope validado por schema e gates
- repair loop + retry + circuit breaker
- storage com path policy e escrita atômica
- audit trail por chamada
- state handoff Dev -> QA -> Monitor
- smoke tests E2E

Entregáveis:
- contracts/AGENT_PROTOCOL.md
- runtime/envelope.py
- runtime/validator.py
- runtime/prompt_bundle.py
- runtime/llm_runner.py
- runtime/storage.py
- runtime/audit.py
- tests/test_pipeline_smoke.py (+ unit tests)

Gates:
Rejeite e repare respostas que:
- não sejam JSON ResponseEnvelope
- tenham artifacts vazios em modos de geração/validação
- tenham status=OK com evidence vazio
- tenham path fora de docs/project/apps
- tenham traversal

DoD:
- smoke tests passam
- QA valida code_refs reais do Dev
- Monitor mantém ciclo vivo até DONE
```

---

**Fim.**
