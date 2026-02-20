# AGENT_PROTOCOL — Contrato operacional (SSOT executável)

**Fonte de verdade:** `project/docs/PIPELINE_V2_IA_REAL_AND_PATHS.md`  
**Blueprint:** `project/docs/BLUEPRINT_ZENTRIZ_GENESIS_AGENTS_FUNCTIONAL_PIPELINE_V2_REV2.md`  
Em conflito, prevalece o SSOT.

---

## 1. Path policy (obrigatório)

- Toda escrita sob `PROJECT_FILES_ROOT / <project_id>`.
- Nunca escrever sem `project_id`. Se vazio e storage ativo: fallback controlado ou `BLOCKED`.
- `artifact.path`: sempre relativo, prefixo `docs/` OU `project/` OU `apps/`.
- Bloquear: `..`, caminhos absolutos, `~`, path traversal.

Estrutura:
```
<project_id>/
├── docs/     # Documentos (spec, cto, engineer, pm, dev, qa, monitor, devops)
├── project/  # Infra/DevOps, Dockerfile, IaC
└── apps/     # Código fonte gerado pelo Dev
```

---

## 2. Premissa: IA sempre devolve documento(s)

Ao pedir criar/converter/gerar/validar, a IA deve devolver **artefatos** com `path` + `content`. Texto livre sem artefatos não é aceitável.

---

## 3. ResponseEnvelope (saída padronizada)

Apenas JSON. Campos:

- **status**: `OK` | `FAIL` | `BLOCKED` | `NEEDS_INFO` | `REVISION` | `QA_PASS` | `QA_FAIL`
- **summary**: string
- **artifacts**: lista de `{ "path": "docs/...|project/...|apps/...", "content": string, "format"?: "markdown"|"json"|"text"|"code", "purpose"?: string }`
- **evidence**: lista de `{ "type"?, "ref"?, "note"?: string }`
- **next_actions**: `{ "owner"?, "items"?: [], "questions"?: [] }`
- **meta** (opcional): `{ "round"?, "model"?, "idempotency_key"?: string }`

Validações:
- `status=OK` ⇒ `evidence` não vazio (ou summary com evidência)
- `status=NEEDS_INFO` ⇒ `next_actions.questions` não vazio
- Modo que exige geração ⇒ `artifacts.length >= 1`
- `artifacts[].path` deve respeitar path policy (sanitização no runner)

---

## 4. MessageEnvelope (entrada padronizada)

- **project_id**, **agent**, **variant**?, **mode**?, **task_id**?, **task**?
- **inputs**: spec_raw, product_spec, charter, engineer_docs, backlog, code_refs, constraints
- **existing_artifacts**?, **limits**? (max_rounds, max_rework, timeout_sec)

---

## 5. Gatekeeping

O runner deve: validar JSON (ResponseEnvelope), schema mínimo, paths válidos, gates por agente (artefatos obrigatórios), limites de loops. Se falhar → repair/retry; se persistir → FAIL/BLOCKED com evidência.

---

## 6. Prompt de reparo (runner)

Quando a IA falhar em JSON/gates:

"Retorne **apenas** JSON válido no formato ResponseEnvelope. Não inclua texto fora do JSON. Em strings JSON use \\n para quebras de linha e \\\" para aspas; não deixe strings não terminadas. Preencha `status`, `artifacts[]` (com `path` e `content`), `evidence[]` e `next_actions`. `artifact.path` deve começar com `docs/` ou `project/` ou `apps/` (sempre relativo, sem path absoluto)."

---

## 7. Artefatos mínimos por agente

| Agente   | Paths obrigatórios (quando aplicável) |
|----------|----------------------------------------|
| CTO      | docs/spec/PRODUCT_SPEC.md, docs/cto/PROJECT_CHARTER.md, docs/cto/cto_engineer_validation.md, docs/cto/cto_backlog_validation.md, docs/cto/cto_status.md |
| Engineer | docs/engineer/engineer_proposal.md, docs/engineer/engineer_architecture.md, docs/engineer/engineer_dependencies.md |
| PM       | docs/pm/<squad>/BACKLOG.md, docs/pm/<squad>/DOD.md |
| Dev      | apps/... (1+ arquivos), docs/dev/dev_implementation_<task_id>.md |
| QA       | docs/qa/QA_REPORT_<task_id>.md |
| DevOps   | project/docker/Dockerfile ou project/docker-compose.yml, docs/devops/RUNBOOK.md |
| Monitor  | docs/monitor/TASK_STATE.json, docs/monitor/STATUS.md, docs/monitor/DECISIONS.md |

---

*Referência: BLUEPRINT_ZENTRIZ_GENESIS_AGENTS_FUNCTIONAL_PIPELINE_V2_REV2.md — Fase 1.*
