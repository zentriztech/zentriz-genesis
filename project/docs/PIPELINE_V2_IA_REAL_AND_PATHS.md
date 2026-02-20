# Extensão: Pipeline V2 — IA real e paths resilientes

> **Referência:** [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md).  
> **Objetivo:** Tornar o fluxo E2E funcional com **respostas reais da IA** em cada agente, **paths corretos e resilientes** (docs/project/apps sempre sob `<project_id>`), e **modelo de spec** ([PRODUCT_SPEC_TEMPLATE.md](../spec/PRODUCT_SPEC_TEMPLATE.md)) como entrada aceitável para desenvolvimento.

---

## 1. Problemas a resolver

| Problema | Descrição | Direção |
|----------|-----------|---------|
| **Arquivos no lugar errado** | Artefatos criados em nível acima do esperado; `./docs` fora de `<project_id>`. | Garantir que **toda** gravação use `PROJECT_FILES_ROOT / project_id / docs | project | apps`; nunca gravar em `PROJECT_FILES_ROOT/docs` ou raiz sem `project_id`. |
| **IA não produz saída utilizável** | Agentes não conseguem executar ou obter da IA resposta real (conteúdo, arquivos). | Prompts e contratos que exijam **sempre** 1+ documento/artefato (.md, .js, .ts, etc.); uso do **melhor modelo** configurável (Claude opus/sonnet); instruções claras de “realizar as tarefas relativas às suas responsabilidades”. |
| **Spec não padronizada** | Entrada do usuário pode ser livre; desenvolvimento precisa de spec no formato viável. | CTO usa [PRODUCT_SPEC_TEMPLATE.md](../spec/PRODUCT_SPEC_TEMPLATE.md) como **modelo aceitável**; IA converte/valida para esse formato; se já estiver no modelo, CTO apenas valida. |
| **Dev não grava onde o usuário espera** | Código do produto deve ir para pasta de apps do projeto. | Dev grava em `<project_id>/apps` (ou `<project_id>/project` conforme já existente); runner e storage expõem `get_apps_dir(project_id)` e usam para artefatos de código. |

---

## 2. Estrutura de paths (resiliente)

**Regra:** Todo artefato e documento gerado pelo pipeline deve ficar **sob** `PROJECT_FILES_ROOT / project_id`. Nunca usar `PROJECT_FILES_ROOT` como raiz de escrita sem `project_id`.

```
PROJECT_FILES_ROOT/
└── <project_id>/
    ├── docs/          # Documentos dos agentes (spec, cto, engineer, pm, dev, qa, monitor, devops)
    ├── project/       # Artefatos de infra (DevOps), configs, Dockerfile, etc.
    └── apps/          # Código da aplicação gerado pelo Dev (IA) — landing, web app, backend API
```

- **docs/** — Já implementado em `project_storage.py` (`get_docs_dir`, `write_doc`). Garantir que `project_id` seja **sempre** não vazio quando houver escrita (runner invocado pela API deve receber `PROJECT_ID`; fluxo sem API pode usar `project_id` default ou não gravar em disco).
- **project/** — Já implementado (`get_project_dir`, `write_project_artifact`). Usado para Dockerfile, docker-compose, scripts e, se desejado, parte do código.
- **apps/** — Novo. Código fonte da aplicação (Landing Page, Web App, Backend API) gerado pelo Dev com a IA. Implementar `get_apps_dir(project_id)` e opção no runner/Dev para gravar artefatos com `path` em `apps/` (ex.: `src/index.js` → `<project_id>/apps/src/index.js`).

**Resiliência:**

- Se `PROJECT_ID` estiver vazio e o storage estiver ativo, **não** gravar em `PROJECT_FILES_ROOT/docs`; usar um `project_id` fallback (ex.: `default`) ou desabilitar escrita.
- Logar claramente: `[ProjectStorage] root=<path>, project_id=<id>, docs=<path>, apps=<path>` na primeira escrita por projeto.

---

## 3. Fluxo por agente (IA real)

Cada agente **pede à IA** que execute as tarefas das suas responsabilidades e **devolva um ou mais documentos/artefatos** (.md, .js, .ts, .json, etc.). A premissa é: *“Se eu entregar um arquivo de spec no chat e pedir para a IA fazer tudo (ou em partes), ela faz”* — os agentes orquestram esse mesmo tipo de pedido e consomem a saída.

### 3.1 CTO — Spec review e modelo aceitável

1. **Entrada:** Spec do portal (arquivo anexado; pode ser .md, .txt, .doc, .pdf).
2. **Responsabilidade da IA (CTO):**
   - Analisar e **converter** o conteúdo para um formato viável para desenvolvimento de qualquer tipo de aplicação (Landing Page, Web App, Backend API ou conjunto).
   - O formato de saída aceitável é o **[PRODUCT_SPEC_TEMPLATE.md](../spec/PRODUCT_SPEC_TEMPLATE.md)** (Metadados, Visão, Personas, FR, NFR, Regras de negócio, Integrações, Modelos de dados, Fora de escopo, DoD).
3. **Comportamento:**
   - Se a spec **já estiver** no modelo do template (CTO valida via IA): não precisa enviar para a IA converter; usa como está e grava em `docs/` como spec aceita.
   - Caso contrário: envia para a IA **converter e melhorar** conforme o template; a IA devolve **um documento .md** no formato do template; CTO grava em `docs/` (ex.: `cto_spec_review.md` ou `spec_product_spec.md`).
4. **Saída:** Um único documento .md (spec no formato do template), gravado em `<project_id>/docs/`. Esse documento é a **entrada aceitável** para o restante do pipeline.

### 3.2 CTO → Engineer — Documentos para o próximo passo

1. **Entrada:** Spec no formato do template (saída do passo 3.1).
2. **Responsabilidade da IA (Engineer):**
   - Gerar/melhorar **um ou mais documentos .md** para ajudar no próximo passo (ex.: proposta técnica, squads, dependências, arquitetura de alto nível).
3. **Comportamento:** CTO envia a spec ao Engineer; o Engineer **pede à IA** que realize essas tarefas e devolve **1+ .md** ao CTO.
4. **Saída:** 1 ou mais arquivos .md (proposta técnica, squads, etc.), gravados em `<project_id>/docs/` (ex.: `engineer_proposal.md`, `engineer_architecture.md`).

### 3.3 CTO — Validação dos documentos do Engineer

1. **Entrada:** Os documentos gerados pelo Engineer.
2. **Responsabilidade da IA (CTO):** Validar os documento(s); decidir **OK** (segue para o PM) ou **não OK** (devolve questionamentos ao Engineer).
3. **Comportamento:**
   - CTO pede à IA que valide; se resposta for OK/aprovado → segue para o PM.
   - Caso contrário → volta para o Engineer (repetir fluxo do Engineer); limite de rodadas (ex.: 3); após o limite, considerar última versão e seguir.
4. **Saída:** Decisão (OK ou questionamentos) e, se OK, Charter ou consolidação gravada em `docs/`.

### 3.4 PM — Backlog e validação pelo CTO

1. **Entrada:** Charter + proposta do Engineer (e spec quando necessário).
2. **Responsabilidade da IA (PM):** Gerar backlog do módulo (tarefas, prioridades, critérios de aceite).
3. **Comportamento:** PM pede à IA que gere o backlog; envia ao CTO para **validar**; se CTO (IA) validar como OK → PM aciona a squad (cria tasks, Monitor passa a orquestrar Dev/QA). Se não → PM repete o fluxo (refina backlog); limite de rodadas.
4. **Saída:** Backlog em .md (e opcionalmente artefatos estruturados), gravado em `docs/`; tasks criadas na API.

### 3.5 Dev — Código real na pasta apps

1. **Entrada:** Spec (template), charter, backlog, task atual.
2. **Responsabilidade da IA (Dev):** Criar os **arquivos** relativos ao projeto (ou à parte do projeto) da tarefa (código fonte, configs, etc.). O Dev é um “programador que gerencia tarefas e a IA desenvolve”.
3. **Comportamento:**
   - Tarefa **pequena:** Dev pede à IA tudo de uma vez; recebe artefatos com `path` e `content`; grava em **`<project_id>/apps/`** (ex.: `apps/src/index.js`, `apps/package.json`).
   - Tarefa **grande:** Dev vai pedindo à IA em partes, checando um checklist; ao finalizar, avisa o Monitor que aciona o QA.
4. **Saída:** Arquivos gravados em `<project_id>/apps/` (e resumo em `docs/dev_implementation.md`). Contrato: lista de artefatos com `path` (relativo a `apps/`) e `content`.

### 3.6 QA — Validação do código gerado

1. **Entrada:** Tarefa finalizada pelo Dev + artefatos (código em `apps/` ou referência).
2. **Responsabilidade da IA (QA):** Validar se o **código gerado condiz com a tarefa** pedida.
3. **Comportamento:** QA lê a tarefa e o código; **aciona a IA** para validar; se não condiz → aciona o Monitor com **block** (ou QA_FAIL); se condiz → aciona o Monitor com **OK/done** (QA_PASS → task DONE).
4. **Saída:** Relatório em `docs/`; decisão (QA_PASS / QA_FAIL) para o Monitor.

### 3.7 Monitor — Orquestração contínua

1. **Responsabilidade:** Ver tudo o tempo todo; orquestrar com base nos **status** (voltar para Dev, enviar para QA, informar PM); realizar as tarefas relativas às suas responsabilidades.
2. **Comportamento:** Orientado por estados (ASSIGNED, IN_PROGRESS, WAITING_REVIEW, QA_FAIL, DONE); decide próximo agente (Dev, QA ou DevOps); não aciona DevOps se houver task DONE por max QA rework; informa PM quando relevante.

---

## 4. Premissa: IA sempre devolve documento(s)

- **Contexto IA:** Sempre que for pedido à IA **criar** algo (especificar, converter, gerar código, validar), ela deve devolver **um ou mais documentos/artefatos** (.md, .js, .ts, .package, etc.), não apenas texto livre.
- **Contratos (response_envelope):** Os agentes devem exigir no prompt que a IA preencha `artifacts[]` com itens que tenham `path` e `content` (e opcionalmente `purpose`) quando o resultado for arquivo; o runner persiste esses artefatos em `docs/`, `project/` ou `apps/` conforme o agente e o tipo.

---

## 5. Melhor IA e resiliência

- **Modelo:** Usar a **melhor IA** configurável para o contexto (ex.: Claude Opus para spec/charter/validação, Sonnet para código quando houver limite de custo). Variável de ambiente (ex.: `CLAUDE_MODEL` ou `PIPELINE_LLM_MODEL`) para escolher o modelo.
- **Resiliência:** Retry com backoff nas chamadas à IA; timeout configurável; se a IA não devolver artefatos válidos, o agente pode devolver status REVISION e mensagem clara para o runner/portal; logs estruturados para diagnóstico.

---

## 6. Checklist de implementação (extensão)

- [x] **P1** Garantir que **nenhuma** escrita em disco use raiz sem `project_id`; validar `project_id` antes de `write_doc` / `write_project_artifact`; se vazio e storage ativo, usar fallback ou skip. (`get_project_root` retorna `None` se `project_id` vazio.)
- [x] **P2** Implementar `get_apps_dir(project_id)` e `write_apps_artifact(project_id, relative_path, content)` em `project_storage.py`; runner grava artefatos do Dev em `<project_id>/apps/`.
- [ ] **P3** CTO: carregar [PRODUCT_SPEC_TEMPLATE.md](../spec/PRODUCT_SPEC_TEMPLATE.md) e enviar ao prompt da IA; instruir “converter/validar spec para este modelo; se já estiver no modelo, validar e devolver OK”; gravar spec aceita em `docs/`.
- [ ] **P4** Engineer: prompt que exija 1+ .md como saída (proposta técnica, squads, etc.); runner grava cada artefato em `docs/` com nome adequado.
- [ ] **P5** CTO validação: após receber documentos do Engineer, CTO (IA) valida; se não OK, devolve questionamentos e runner repete Engineer (max rodadas); se OK, segue para PM.
- [ ] **P6** PM: gera backlog com IA; CTO (IA) valida; se OK, acionar squad; senão PM repete (max rodadas).
- [ ] **P7** Dev: instruir IA a devolver artefatos com `path` (relativo a `apps/`) e `content`; runner grava em `<project_id>/apps/<path>`; tarefas grandes = múltiplas chamadas + checklist.
- [ ] **P8** QA: instruir IA a validar se código condiz com a tarefa; saída QA_PASS/QA_FAIL; Monitor reage (block/rework ou OK/done).
- [ ] **P9** Configuração do modelo: suporte a `CLAUDE_MODEL` (ou similar) para escolher o modelo da IA; documentar em CONTEXT e .env.example.

---

## 7. Referências

- [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md) — Plano base.
- [PRODUCT_SPEC_TEMPLATE.md](../spec/PRODUCT_SPEC_TEMPLATE.md) — Modelo aceitável de spec para desenvolvimento.
- [PIPELINE_V2_HANDOFF_CONTRACTS.md](PIPELINE_V2_HANDOFF_CONTRACTS.md) — Contratos entre agentes.
- `applications/orchestrator/project_storage.py` — Paths e escrita em disco.
- `applications/orchestrator/runner.py` — Fluxo e chamadas aos agentes.

---

*Extensão criada em 2026-02-19. Implementar itens P1–P9 para fluxo E2E funcional com IA real e paths corretos.*
