# Blueprint (V2/REV2) — Zentriz Genesis: Agentes realmente funcionais, resilientes e auditáveis
**SSOT (fonte de verdade):** `PIPELINE_V2_IA_REAL_AND_PATHS.md`  
**Complemento humano (não-executável):** `ACTORS_AND_RESPONSIBILITIES.md`  
**Base atual dos agentes:** `agents.zip` (SYSTEM_PROMPT.md + skills.md por agente/variante)

> Este documento é um **plano executável** (para Cursor/LLM + runner) e deve ser tratado como **contrato operacional**.  
> Se houver conflito entre documentos, **sempre prevalece** o SSOT: `PIPELINE_V2_IA_REAL_AND_PATHS.md`.

---

## 0) O que muda quando isso for executado (resultado tangível)

Ao executar este plano, você terá:

- **Entrada do usuário em qualquer formato** (texto livre, idea dump, md, doc, pdf transcrito) → **sempre vira uma spec válida** no formato `PRODUCT_SPEC_TEMPLATE` em `docs/spec/PRODUCT_SPEC.md`.
- **CTO, Engineer, PM** geram e validam documentos em ciclos **controlados por limite** (sem loops infinitos).
- **Dev gera código real** (arquivos completos ou partes) em `apps/` — não “explicações”.
- **QA testa/contesta** com saída binária (`QA_PASS`/`QA_FAIL`) e report acionável.
- **Monitor mantém o ciclo vivo** com máquina de estados, snapshots e escalonamento com evidências até `DONE`.
- **Runner resiliente**: valida JSON, aplica gates, repara respostas, faz retry, controla timeouts, registra audit trail.

---

## 1) Princípios inegociáveis (sem isso vira “chat bonito”)

### 1.1 Path policy (resiliente, obrigatório)
**Regra:** qualquer escrita deve ocorrer **sob** `PROJECT_FILES_ROOT / <project_id>`.  
Nunca escrever em `PROJECT_FILES_ROOT` sem `project_id`.

```
PROJECT_FILES_ROOT/
└── <project_id>/
    ├── docs/          # Documentos (spec, cto, engineer, pm, dev, qa, monitor, devops)
    ├── project/       # Infra/DevOps, configs, docker-compose, scripts, IaC
    └── apps/          # Código fonte gerado pelo Dev (IA) — web, backend, landing, etc.
```

**Regras duras**
- Bloquear `..`, caminhos absolutos, `~`, e qualquer tentativa de path traversal.
- `artifact.path` sempre relativo e iniciando com `docs/` **OU** `project/` **OU** `apps/`.
- Se `project_id` estiver vazio e storage ativo: **não escrever** fora do projeto. Use fallback controlado (`default`) **ou** retorne `BLOCKED` explicitando o problema.

### 1.2 Premissa do SSOT: “IA sempre devolve documento(s)”
Sempre que o pipeline pedir “criar/converter/gerar/validar”, a IA deve devolver **artefatos** com `path` + `content`.  
**Texto livre sem artefatos não é aceitável**.

### 1.3 LLM como “motor de build” (não como “consultor”)
- **Dev**: LLM deve produzir **código** (artefatos em `apps/`) — parcial ou completo por task.
- **CTO/Engineer/PM**: LLM deve produzir **documentos** (artefatos em `docs/`).
- **QA**: LLM deve produzir **relatórios** + verdict (`QA_PASS`/`QA_FAIL`) (artefatos em `docs/qa/`).
- **Monitor**: LLM deve produzir **snapshots de estado** + next action (artefatos em `docs/monitor/`).

### 1.4 Gatekeeping é obrigatório (sem validação não há avanço)
O runner deve **validar**:
- JSON parseável (ResponseEnvelope)
- schema mínimo (campos obrigatórios, enums)
- paths válidos
- gates por modo/agente (artefatos obrigatórios)
- limites de loops (rounds/rework)
Se falhar → **repair/retry**; se persistir → `FAIL/BLOCKED` com evidência.

---

## 2) Contratos formais (MessageEnvelope / ResponseEnvelope)

> Objetivo: tornar a comunicação **determinística**, **validável** e **reexecutável**.

### 2.1 MessageEnvelope (entrada padronizada)
Todo agente recebe este envelope (mesmo que o usuário mande texto solto):

```json
{
  "project_id": "<string>",
  "agent": "CTO|Engineer|PM|Dev|QA|DevOps|Monitor",
  "variant": "web|backend|mobile|aws|azure|gcp|docker|...",
  "mode": "<string>",
  "task_id": "<string|null>",
  "task": "<string>",
  "inputs": {
    "spec_raw": "<string|null>",
    "product_spec": "<string|null>",
    "charter": "<string|null>",
    "engineer_docs": ["<string>"],
    "backlog": "<string|null>",
    "code_refs": ["apps/..."],
    "constraints": ["spec-driven", "no-invent", "paths-resilient"]
  },
  "existing_artifacts": [
    { "path": "docs/...", "summary": "..." }
  ],
  "limits": {
    "max_rounds": 3,
    "max_rework": 3,
    "timeout_sec": 60
  }
}
```

### 2.2 ResponseEnvelope (saída padronizada)
**Nada** fora do JSON.

```json
{
  "status": "OK|FAIL|BLOCKED|NEEDS_INFO|REVISION|QA_PASS|QA_FAIL",
  "summary": "string curta",
  "artifacts": [
    {
      "path": "docs/...|project/...|apps/...",
      "content": "string",
      "format": "markdown|json|text|code",
      "purpose": "string opcional"
    }
  ],
  "evidence": [
    { "type": "spec_ref|file_ref|test|log", "ref": "string", "note": "string" }
  ],
  "next_actions": {
    "owner": "SPEC|CTO|Engineer|PM|Dev|QA|DevOps|Monitor",
    "items": ["string"],
    "questions": ["string"]
  },
  "meta": {
    "round": 1,
    "model": "claude-...",
    "idempotency_key": "..."
  }
}
```

**Validações obrigatórias**
- `status=OK` ⇒ `evidence.length > 0`
- `status=NEEDS_INFO` ⇒ `next_actions.questions.length > 0`
- Se o modo exigir geração ⇒ `artifacts.length >= 1`
- `artifacts[].path` deve ser permitido e respeitar path policy

---

## 3) Regras básicas e itens mandatórios por agente (MUST / MUST NOT)

> A partir daqui, cada agente tem “mínimo funcional obrigatório”.  
> Se algum MUST falhar, o runner deve retornar `REVISION`/`FAIL` (e iniciar repair loop).

---

## 3.1 CTO (produto / gatekeeper)

### MUST (obrigatório)
- Converter/validar spec para `PRODUCT_SPEC_TEMPLATE` e gravar como artefato.
- Gerar Project Charter e validar docs do Engineer.
- Validar backlog do PM antes de acionar squad.
- Comunicar-se apenas com **SPEC**, **Engineer** e **PM** (conforme hierarquia).

### MUST NOT (proibido)
- Não inventar requisitos quando faltar informação.
- Não “pular” validação do Engineer/PM em modos que exigem gate.

### Artefatos mínimos (obrigatórios)
- `docs/spec/PRODUCT_SPEC.md` (sempre que receber spec do usuário, mesmo incompleta)
- `docs/cto/PROJECT_CHARTER.md` (quando o projeto avança para execução)
- `docs/cto/cto_engineer_validation.md` (quando Engineer entregar docs)
- `docs/cto/cto_backlog_validation.md` (quando PM entregar backlog)
- `docs/cto/cto_status.md` (snapshot do ponto atual e decisões)

---

## 3.2 Engineer (técnico / arquiteto)

### MUST
- Falar **apenas com CTO**.
- Produzir proposta técnica com stacks/squads, arquitetura, dependências, riscos e trade-offs.
- Referenciar FR/NFR impactados (mapeamento mínimo).
- Se algo crítico estiver faltando: `NEEDS_INFO` com perguntas objetivas.

### MUST NOT
- Não contratar PM, não distribuir tasks, não falar com Dev/QA/DevOps/Monitor.

### Artefatos mínimos
- `docs/engineer/engineer_proposal.md`
- `docs/engineer/engineer_architecture.md`
- `docs/engineer/engineer_dependencies.md`
- (quando aplicável) `docs/engineer/adr/ADR-00x.md`

---

## 3.3 PM (por squad: web/backend/mobile)

### MUST
- Gerar backlog executável: tasks pequenas, testáveis, com critérios de aceite e DoD.
- “Contratar” (selecionar) Dev(s), QA(s), DevOps e Monitor da squad (conforme agents.zip/skills).
- Distribuir atividades para Dev/QA/DevOps.
- Reportar apenas via Monitor (o PM recebe status do Monitor).
- Submeter backlog ao CTO para validação (não iniciar execução sem aprovação).

### MUST NOT
- Não bypassar CTO em mudanças de escopo.
- Não aceitar “task sem aceite/DoD”.

### Artefatos mínimos
- `docs/pm/<squad>/BACKLOG.md`
- `docs/pm/<squad>/DOD.md` (ou referência global)
- `docs/pm/<squad>/TASKS.json` (opcional recomendado para Monitor)

---

## 3.4 Dev (por stack: web/backend/mobile)

### MUST
- **Gerar código real** usando a LLM, devolvendo arquivos com `path`+`content`.
- Escrever **somente** em `apps/` (código) e, no máximo, documentação em `docs/dev/`.
- Se tarefa for grande: dividir em partes, mantendo checklist e consistência.
- Entregar evidências mínimas (ex.: lista de arquivos gerados, como rodar, como testar).

### MUST NOT
- Não responder com “explicação sem arquivos”.
- Não escrever em `docs/` para código fonte (exceto documentação).
- Não mudar arquitetura sem sinalizar/ADR (via PM→CTO→Engineer quando necessário).

### Artefatos mínimos
- `apps/...` (1+ arquivos de código/config por tarefa)
- `docs/dev/dev_implementation_<task_id>.md` (resumo + como rodar/testar)

---

## 3.5 QA (por stack)

### MUST
- Validar task vs FR/NFR e contestar quando não cumprir.
- Produzir saída binária e acionável: `QA_PASS` ou `QA_FAIL`.
- Sempre gerar QA Report com evidências e severidade.
- Bloquear regressões.

### MUST NOT
- Não “aprovar sem evidência”.
- Não mandar feedback vago (“não gostei”); precisa ser reproduzível.

### Artefatos mínimos
- `docs/qa/QA_REPORT_<task_id>.md`
- (quando aplicável) `docs/qa/TEST_PLAN_<task_id>.md` (opcional recomendado)

---

## 3.6 DevOps (por cloud + docker)

### MUST
- Provisionar infra e ferramentas de execução (Docker, scripts, IaC), sempre como artefatos.
- Fornecer runbook mínimo (subir, baixar, testar, rollback).
- Não vazar segredos (nunca imprimir secrets).

### MUST NOT
- Não colocar chaves/segredos em arquivos.
- Não alterar envs sem registro.

### Artefatos mínimos
- `project/docker/Dockerfile` e/ou `project/docker-compose.yml` (se aplicável)
- `project/infra/<cloud>/...` (IaC quando aplicável)
- `docs/devops/RUNBOOK.md`

---

## 3.7 Monitor (peça chave / motor do ciclo)

### MUST
- Ser orientado por máquina de estados e sempre decidir **próximo passo**.
- Acompanhar Dev/QA e acionar QA quando Dev terminar; acionar DevOps quando necessário.
- Informar PM com status e alertas.
- Controlar loops (max rework) e escalar quando estourar.

### MUST NOT
- Não deixar task “sem dono”.
- Não permitir loop infinito Dev↔QA.
- Não “ocultar bloqueios”; sempre registrar.

### Artefatos mínimos
- `docs/monitor/TASK_STATE.json` (snapshot)
- `docs/monitor/STATUS.md` (status humano curto)
- `docs/monitor/DECISIONS.md` (escalonamentos/aceite de risco)

---

## 4) Fluxo por agente (IA real) — execução E2E

> Implementar conforme o SSOT, com gates e limites.

---

## Spec Intake & Normalization Policy (MANDATORY)

Se o usuário fornecer uma ideia em texto livre, print, áudio transcrito, ou qualquer formato não-padronizado:

1) Você **DEVE** converter para o formato padrão do `PRODUCT_SPEC` (mesmas seções do template 0..9).
2) Você **DEVE** gerar o artefato: `docs/spec/PRODUCT_SPEC.md`.
3) Você **NÃO PODE** inventar requisitos. Onde faltar informação: marque `TBD:` / `UNKNOWN:` e explicite **assunções** separadamente.
4) Você **DEVE** produzir uma lista de **perguntas mínimas** (apenas bloqueadores de alto impacto) quando necessário.
5) Você **DEVE** incluir `evidence[]` com 2–5 referências ao texto bruto (`spec_raw`) que justificam os principais FR/NFR.

**Quality Gates**
- Se `mode=spec_intake_and_normalize` e `docs/spec/PRODUCT_SPEC.md` não existir ⇒ `FAIL`
- Se `docs/spec/PRODUCT_SPEC.md` não contiver todas as seções `## 0`…`## 9` ⇒ `FAIL`
- Se não existir nenhum `FR-*` ⇒ `NEEDS_INFO`
- Se `status=OK` e `evidence` estiver vazio ⇒ `FAIL`

---

### 4.1 CTO — Spec review e modelo aceitável
- Entrada: spec do portal (md/txt/doc/pdf transcrito) **ou** texto livre.
- Saída: `docs/spec/PRODUCT_SPEC.md` conforme template.
- Depois: CTO aciona Engineer com a spec normalizada.

### 4.2 CTO → Engineer — Documentos para o próximo passo
- Entrada: spec normalizada.
- Saída: docs do Engineer em `docs/engineer/`.
- CTO valida (loop com `max_rounds`).

### 4.3 CTO — Validação dos docs do Engineer (loop resiliente)
- Se OK: segue para PM.
- Se revisão: lista gaps e repete Engineer.
- Limite: `max_rounds` (ex.: 3). Estourou: registrar risco e seguir.

### 4.4 PM — Backlog e validação pelo CTO
- PM gera `docs/pm/<squad>/BACKLOG.md`.
- CTO valida (loop com `max_rounds`).
- Só após OK: PM distribui tasks.

### 4.5 Dev — Código real na pasta apps
- Dev recebe task do PM.
- Dev gera arquivos em `apps/` (chunking se necessário).
- Dev reporta “done” ao Monitor com evidências.

### 4.6 QA — Validação do código gerado
- Monitor aciona QA com task + referências de código.
- QA retorna `QA_PASS` ou `QA_FAIL` + `docs/qa/QA_REPORT_<task_id>.md`.

### 4.7 Monitor — Orquestração contínua (máquina de estados)
- Monitor move o estado e define o próximo owner.
- Controla `max_rework`.
- Escala PM/CTO quando necessário.

---

## 5) Máquina de estados do Monitor (obrigatória)

### 5.1 Estados mínimos
- `ASSIGNED`
- `IN_PROGRESS`
- `WAITING_QA`
- `QA_FAIL`
- `DONE`
- `BLOCKED`

### 5.2 Transições
- PM atribui → `ASSIGNED`
- Dev inicia → `IN_PROGRESS`
- Dev finaliza → `WAITING_QA`
- QA falha → `QA_FAIL` → volta `IN_PROGRESS` (com lista de correções)
- QA passa → `DONE`
- Sem dados/impedimento → `BLOCKED` (com perguntas e owner)

### 5.3 Limites e escalonamento
- `max_rework=3` por task (ajustável)
- Estourou: Monitor grava decisão + escala PM e CTO com evidências.

---

## 6) Resiliência do sistema (LLM + storage + fluxo)

### 6.1 Resiliência de LLM (Claude)
Obrigatório:
- Retry com backoff (ex.: 3 tentativas)
- Timeout por chamada (ex.: 60s)
- Repair loop:
  - JSON inválido → repair prompt
  - artifacts vazios → repair prompt
  - paths inválidos → repair prompt
- Seleção de modelo por env:
  - `PIPELINE_LLM_MODEL` (default)
  - `CLAUDE_MODEL_SPEC` (spec/charter/validação)
  - `CLAUDE_MODEL_CODE` (código)
- Circuit breaker simples:
  - 3 falhas seguidas ⇒ `BLOCKED` e exige intervenção humana (SPEC/CTO)

### 6.2 Resiliência de storage
Obrigatório:
- Escrita atômica (temp + rename)
- Sanitização de path
- Lock por `project_id`
- Histórico mínimo:
  - snapshots do Monitor versionados por timestamp
  - opcional: manter `*_prev.md` em validações

### 6.3 Resiliência de fluxo
Obrigatório:
- loops com `max_rounds` (CTO↔Engineer, CTO↔PM)
- loops com `max_rework` (Dev↔QA)
- escalonamento quando estourar

---

## 7) Como adaptar `agents.zip` sem reescrever tudo (evitar drift)

### 7.1 Manter “2 arquivos por agente”, mas mudar a composição do prompt
Você continuará com:
- `skills.md`
- `SYSTEM_PROMPT.md`

Porém, o runner deve compor assim:
1) **AGENT_PROTOCOL.md** (novo, central, SSOT executável)
2) `agents/<...>/SYSTEM_PROMPT.md` (curto, por agente/variante)
3) `agents/<...>/skills.md`
4) `MessageEnvelope` + artefatos existentes

### 7.2 O que cada SYSTEM_PROMPT deve conter (mínimo)
- Mission
- Modes aceitos
- Required artifacts (paths)
- Quality gates (FAIL/REVISION/NEEDS_INFO)
- Allowed communications (hierarquia)
- Reminder: ResponseEnvelope obrigatório; nada fora do JSON

### 7.3 Golden examples (obrigatório)
Cada SYSTEM_PROMPT deve incluir:
- 1 exemplo de MessageEnvelope
- 1 exemplo de ResponseEnvelope real com `artifacts[]`

> Isso reduz drasticamente resposta solta.

---

## 8) Plano de implementação (faseado, executável)

### Fase 1 — Contratos e validação (fundação)
- [x] Criar `contracts/AGENT_PROTOCOL.md` (centralizar regras deste blueprint + SSOT)
- [x] Implementar parser/validator do ResponseEnvelope
- [x] Implementar repair loop (JSON/paths/artifacts)
- [x] Implementar sanitização de path + bloqueio traversal

### Fase 2 — Storage resiliente
- [x] Garantir que `write_doc/write_project_artifact/write_apps_artifact` exigem `project_id`
- [x] Escrita atômica + locks por projeto
- [x] Diretórios garantidos: docs/project/apps

### Fase 3 — Prompts “executáveis”
- [x] Atualizar SYSTEM_PROMPT do CTO com o bloco **Spec Intake & Normalization Policy (MANDATORY)**
- [x] Atualizar Engineer para obrigar 3 docs mínimos
- [x] Atualizar PM para obrigar backlog + submissão ao CTO
- [x] Atualizar Dev para obrigar artifacts em `apps/`
- [x] Atualizar QA para QA_PASS/QA_FAIL + report
- [x] Atualizar Monitor para state machine + snapshots

### Fase 4 — Runner E2E
- [x] Implementar sequência do Pipeline V2
- [x] Implementar loops com limites e escalonamento
- [x] Implementar logs estruturados (audit trail por chamada)
- [x] Implementar seleção de modelo por contexto

### Fase 5 — Testes e “prova de funcionalidade”
- [x] Unit: validator de ResponseEnvelope (`orchestrator/tests/test_envelope.py`)
- [x] Unit: sanitizer de path (`test_envelope.py`, `test_project_storage.py`)
- [ ] Integration: spec livre → PRODUCT_SPEC.md (manual/CI)
- [ ] Integration: Dev gera arquivos em apps/ (fluxo runner+storage)
- [ ] E2E: fluxo completo → DONE (manual: deploy+portal+pipeline)
- [ ] Failure: JSON inválido → repair (parse+repair_prompt implementados)
- [ ] Loop: QA_FAIL 3x → escalonamento (Monitor Loop já implementa; teste opcional)

---

## 9) Critérios de aceite (objetivos, verificáveis)

Um projeto está “OK” quando, ao final do run, existe:

- `docs/spec/PRODUCT_SPEC.md`
- `docs/cto/PROJECT_CHARTER.md`
- `docs/engineer/engineer_proposal.md`
- `docs/pm/<squad>/BACKLOG.md`
- `apps/...` (código real)
- `docs/qa/QA_REPORT_<task_id>.md`
- `docs/monitor/TASK_STATE.json` e `docs/monitor/STATUS.md`

E, adicionalmente:
- nenhuma escrita fora de `<project_id>/...`
- o Monitor sempre aponta próximo owner e ação
- loops respeitam limites e escalam com evidências

---

## 10) Apêndice: “prompt de reparo” padrão (use no runner)
Use quando a IA falhar em JSON/gates:

- “Retorne **apenas** JSON válido no formato ResponseEnvelope.  
  Não inclua texto fora do JSON.  
  Preencha `status`, `artifacts[]` (com `path` e `content`), `evidence[]` e `next_actions`.  
  `artifact.path` deve começar com `docs/` ou `project/` ou `apps/` e respeitar `project_id`.”

---

**Data:** 2026-02-20  
**Versão:** REV2 (mais exigente, com MUSTs por agente e resiliência)
