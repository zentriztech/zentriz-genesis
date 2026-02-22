# Relatório de Análise — Pipeline de Agentes (request_id=runner-20260220172453)

**Data:** 2026-02-20  
**Escopo:** Logs (terminal agents-host, Docker runner), artefatos, contratos (AGENT_PROTOCOL, envelope), comportamento dos agentes vs expectativa “quase humanos, inteligentes”.  
**Exigência:** Validação rigorosa, critérios fortes.

---

## 1. Resumo executivo

- **O que aconteceu:** Um pipeline completo foi executado (CTO → Engineer → CTO → PM → CTO ↔ PM → Monitor Loop → Dev ↔ QA). Todos os endpoints retornaram HTTP 200 após **múltiplos repairs** por agente (JSON inválido, gates de artefatos, status QA).
- **Problemas críticos identificados:**
  1. **Path absoluto exibido como “artefatos”:** O portal mostra `projectDocsRoot` da API (path de disco completo, ex.: `/Users/mac/zentriz-files/<project_id>`) na seção “Artefatos”, em desacordo com o contrato (artifact.path sempre relativo).
  2. **Dev nunca entrega código em `apps/`:** O gate `implement_task` exige pelo menos um artefato em `apps/`. Em todas as rodadas o Dev retornou apenas `docs/dev/dev_implementation_TSK-BE-001.md`; o runner avançou a tarefa para QA mesmo com status BLOCKED e validator_pass=False.
  3. **JSON malformado recorrente:** Vários agentes (CTO, PM, Engineer, QA) produziram “Unterminated string” (linha 7/9), exigindo 1–2 repairs por chamada.
  4. **Nomes de arquivo derivados de path:** O runner grava artefatos em `docs/` usando o path “achatado” (ex.: `docs_dev_dev_implementation_TSK-BE-001_md`), gerando nomes como `dev_docs_dev_dev_implementation_TSK-BE-001_md.md` e perdendo a estrutura docs/dev/.
  5. **PM com status BLOCKED e 0 artefatos:** Runner gravou `pm_backlog.md` mesmo com `artifacts_count=0` e validator_pass=False; CTO↔PM atingiu máximo de rodadas “usando último backlog”.

---

## 2. Path absoluto “artefacts: /Users/mac/zentriz-files/…”

### 2.1 Onde aparece

- **API:** `GET /api/projects/:id/artifacts` retorna `projectDocsRoot` e `projectArtifactsRoot` como **caminhos absolutos no servidor** (`path.join(PROJECT_FILES_ROOT, id, "docs")` e `"project"`).
- **Portal (genesis-web):** Na seção “Artefatos”, quando não há documentos no manifest, o texto exibido é:  
  `Nenhum documento listado no manifest. Os artefatos podem estar em {artifacts.projectDocsRoot ?? "project/"}.`  
  Ou seja, o usuário vê o path de disco completo (ex.: `/Users/mac/zentriz-files/af4155f0-de47-4b4d-85aa-8b7206ca51cf` ou `.../docs`).

### 2.2 Contrato (AGENT_PROTOCOL §1 e §3)

- `artifact.path`: **sempre relativo**, prefixo `docs/`, `project/` ou `apps/`.
- Bloquear caminhos absolutos, `..`, `~`.

### 2.3 Conclusão e ação

- **Causa:** A API e o front usam “artefacts” para designar a resposta do GET (docs + roots de disco), e o front exibe `projectDocsRoot` cru.
- **Recomendação:** (1) No front: não exibir path absoluto; usar texto genérico (“pasta do projeto” ou “docs/”) ou um path relativo ao projeto. (2) Opcional: API retornar um campo apenas para exibição (ex.: `projectDocsLabel: "docs/"`) e não o path absoluto na UI.

---

## 3. Conformidade com contratos (por agente)

| Agente   | Contrato (paths obrigatórios / status) | Observado nos logs (agents + runner) | Conformidade |
|----------|----------------------------------------|-------------------------------------|--------------|
| CTO      | docs/spec/, docs/cto/; status OK/REVISION/NEEDS_INFO | Vários repairs: JSON “Unterminated string”, “modo exige pelo menos um artefato”; após repair, 200 OK | Parcial: válido após repair; JSON instável |
| Engineer | docs/engineer/engineer_proposal.md, engineer_architecture.md, engineer_dependencies.md | Repairs: “artifacts.length >= 1”, “path contendo docs/engineer/engineer_proposal.md, engineer_architecture.md”; depois sucesso | Parcial: gates cumpridos após repair |
| PM       | docs/pm/<squad>/BACKLOG.md, DOD.md; status OK/REVISION | PM retornou BLOCKED, artifacts_count=0, validator_pass=False; runner gravou pm_backlog.md; “Máximo de rodadas CTO↔PM atingido” | Não conforme: 0 artefatos formais; backlog usado mesmo assim |
| Dev      | apps/... (≥1), docs/dev/dev_implementation_<task_id>.md | Sempre artifacts_paths=['docs/dev/dev_implementation_TSK-BE-001.md'], nenhum path em apps/; status BLOCKED, validator_pass=False; runner gravou docs e avançou para QA | Não conforme: gate apps/ nunca satisfeito |
| QA       | docs/qa/QA_REPORT_<task_id>.md; status QA_PASS ou QA_FAIL | Repairs: “Unterminated string”, “status BLOCKED” → corrigido para QA_FAIL; artefato docs/qa/QA_REPORT_TSK-BE-001.md; validator_pass=True | Conforme após repair; QA_FAIL correto (sem código em apps/) |

### 3.1 Path policy (envelope + runner)

- **envelope.py:** `sanitize_artifact_path` bloqueia absolutos e exige prefixos permitidos; `validate_response_envelope_for_mode` exige artefatos por modo e, para QA validate_task, status QA_PASS ou QA_FAIL.
- **runner.py:** Usa `filter_artifacts_by_path_policy` antes de persistir; grava por prefixo (apps/, project/, docs/). Nenhum path absoluto da LLM foi persistido como path de artefato; o path absoluto visto pelo usuário vem da **API/portal**, não do envelope.

---

## 4. Análise dos logs (Docker runner + terminal agents)

### 4.1 Docker (runner)

- **Fluxo:** CTO → Engineer → CTO → PM (BLOCKED, 0 artifacts) → CTO valida backlog → “Máximo de rodadas CTO↔PM atingido. Usando último backlog” → “PM concluiu. Status: BLOCKED” → Monitor Loop → Dev (BLOCKED, artifacts_count=1, validator_pass=False, paths só docs/dev/) → QA (QA_FAIL) → Dev rework (2x) → QA QA_FAIL (3/3) → “Máximo de reworks atingido; tarefa marcada como DONE (não aprovada)” → DevOps não acionado → Pipeline encerrado (SIGTERM).
- **Persistência:**  
  - `Gravado: .../docs/pm_backlog.md (criador: pm)`  
  - `Gravado: .../docs/dev_implementation.md`, `.../docs/dev_docs_dev_dev_implementation_TSK-BE-001_md.md` (criador: dev)  
  - `Gravado: .../docs/qa_report.md` (criador: qa)  
  O path interno do runner é `/project-files/<project_id>/docs/` (volume); no host pode ser `/Users/mac/zentriz-files/<project_id>/docs/` conforme PROJECT_FILES_ROOT.
- **Audit:** Vários `[Audit] agent=... validator_pass=False validation_errors=1 artifacts_paths=[...]` para PM e Dev; QA com validator_pass=True e status QA_FAIL.

### 4.2 Terminal agents (host)

- **Padrão:** Quase toda primeira resposta gerou repair: “JSON inválido: Unterminated string starting at: line 7 column 18” (ou linha 9). CTO, PM, Engineer, QA repetem isso. Engineer e Dev também: “modo exige pelo menos um artefato”, “modo implement_task exige pelo menos um artefato em apps/”, “modo generate_engineering_docs exige artefato com path contendo: docs/engineer/...”. QA: “QA em validate_task deve ter status QA_PASS ou QA_FAIL, obtido: 'BLOCKED'”.
- **Conclusão:** A LLM está produzindo JSON com strings não terminadas (quebras de linha/aspas sem escape) e, em muitos modos, artefatos vazios ou paths/status fora do contrato, sendo corrigida pelo loop de repair (até 2 tentativas).

---

## 5. Comportamento dos agentes vs expectativa (“quase humanos, inteligentes”)

### 5.1 O que os SYSTEM_PROMPTs definem

- **CTO:** Decisões de produto; spec review; Charter; validação Engineer/PM; output apenas JSON válido; evidence quando OK; paths docs/ ou project/.
- **Engineer:** Proposta técnica (stacks, squads, dependências); 3 docs em docs/engineer/; não inventar requisitos.
- **PM:** Backlog executável; BACKLOG.md e DOD.md em docs/pm/; submeter ao CTO.
- **Dev:** Entregar **código em apps/** + docs/dev/dev_implementation_<task_id>.md; “never explanation-only”; “Must return code files in artifacts[] (path under apps/)”.
- **QA:** Veredito binário QA_PASS/QA_FAIL; QA_REPORT_<task_id>.md; evidência reproduzível.

### 5.2 O que foi observado

- **Raciocínio / qualidade:** Não é possível avaliar “inteligência” apenas pelos logs; o que se vê é **conformidade técnica** falhando na primeira tentativa (JSON, gates).
- **JSON:** Repetida falha de “Unterminated string” indica que o modelo não está escapando quebras de linha/aspas em strings JSON ou está cortando o bloco — **não é comportamento “quase humano”** no sentido de produzir JSON robusto de primeira.
- **Gates:** Engineer e CTO passam após repair (artefatos/paths corrigidos). PM devolve BLOCKED sem artefatos formais. **Dev nunca entrega apps/:** apenas documento de implementação; o gate é explícito no prompt e no envelope, mas a saída não o atende e o runner ainda avança a tarefa.
- **Runner:** Ao receber resposta BLOCKED com validator_pass=False, o runner **grava os artefatos que passam no path policy** e **marca a tarefa como WAITING_REVIEW**, em vez de não avançar ou reacionar o Dev até haver artefato em apps/. Isso enfraquece o gate.

### 5.3 Critérios fortes (desvios)

| Critério | Esperado | Observado | Severidade |
|----------|----------|-----------|------------|
| artifact.path sempre relativo (docs/, project/, apps/) | Nunca absoluto no envelope/UI como “path do artefato” | Path absoluto exibido no portal (projectDocsRoot) | Alta (UX/contrato) |
| JSON ResponseEnvelope válido na 1ª resposta | Raro repair por JSON | Repairs por “Unterminated string” em CTO, PM, Engineer, QA | Alta |
| Dev implement_task: ≥1 artefato em apps/ | Código em apps/ | Nenhum; só docs/dev/; status BLOCKED | Crítica |
| Runner não avançar quando gate falha | Não colocar em WAITING_REVIEW se validator_pass=False ou status=BLOCKED para implement_task | Coloca em WAITING_REVIEW e aciona QA | Alta |
| Estrutura de docs preservada em disco | docs/dev/..., docs/qa/... | Nomes achatados (dev_docs_dev_..._md.md) | Média |
| PM generate_backlog: artefatos formais | BACKLOG.md, DOD.md em docs/pm/ | 0 artefatos; BLOCKED; runner usa “último backlog” e grava pm_backlog.md | Alta |

---

## 6. Ações recomendadas (priorizadas)

1. **Path absoluto na UI**  
   - Front: não exibir `projectDocsRoot` (path de disco); mostrar apenas “docs/” ou “pasta do projeto”.  
   - Opcional: API enviar campo de rótulo para exibição em vez do path absoluto.

2. **Dev e gate apps/**  
   - Reforçar no SYSTEM_PROMPT do Dev (e no repair) que `implement_task` **obriga** pelo menos um arquivo com `path` começando por `apps/` (ex.: apps/src/index.js), com conteúdo de código.  
   - Incluir exemplo concreto no prompt (path + trecho de content).  
   - **Runner:** Se agente=Dev, mode=implement_task e (validator_pass=False ou status=BLOCKED) e não existir nenhum artefato com path em apps/, **não** atualizar tarefa para WAITING_REVIEW; reacionar Dev ou marcar como BLOCKED e reportar.

3. **JSON estável**  
   - Nos SYSTEM_PROMPTs (e no repair global): instruir explicitamente a **não** incluir quebras de linha literais ou aspas não escapadas dentro de strings JSON; usar \n e \”.  
   - Considerar exemplos de ResponseEnvelope com strings longas (content) mostrando escape correto.

4. **PM e artefatos formais**  
   - Garantir que o modo generate_backlog exija e receba paths docs/pm/.../BACKLOG.md e DOD.md; se a resposta vier BLOCKED com 0 artefatos, o runner não deveria “usar último backlog” sem evidência de artefatos válidos (ou deveria reacionar PM com repair).

5. **Estrutura docs/**  
   - Ao gravar artefatos com path começando por docs/, persistir em `project_id/docs/<resto_do_path>` (respeitando path policy e sem traversal), em vez de achar o path a um único nome de arquivo; assim evita-se `dev_docs_dev_..._md.md` e preserva docs/dev/, docs/qa/, etc.

6. **Deprecation**  
   - Corrigir `datetime.utcnow()` para `datetime.now(datetime.UTC)` (log do runner) para remover DeprecationWarning.

---

## 7. Conclusão

- **O que aconteceu:** O pipeline executou ponta a ponta com muitos repairs (JSON e gates). O Dev nunca entregou código em apps/; o QA corretamente reprovou (QA_FAIL); o runner avançou a tarefa mesmo com Dev em BLOCKED e sem artefato em apps/. O path absoluto que o usuário vê como “artefatos” vem da API/portal (projectDocsRoot), não do envelope.
- **O que é esperado (contratos e objetivo):** artifact.path sempre relativo e nunca exposto como path de disco na UI; JSON válido na primeira resposta; Dev entregar pelo menos um arquivo em apps/ em implement_task; runner não considerar tarefa pronta para QA quando o gate implement_task falhar; artefatos em docs/ com estrutura de pastas preservada; agentes que atendam aos gates e produzam JSON estável (“quase humanos” em confiabilidade de formato e conteúdo).
- **Validação:** Os critérios fortes acima foram aplicados; os desvios estão listados na tabela da seção 5.3 e as ações na seção 6.

---

## 8. Incidente: loop infinito Dev (projeto 470f4ae5-1cde-4421-8f09-b4fbf98080d1)

### 8.1 O que ocorreu

Para o projeto `470f4ae5-1cde-4421-8f09-b4fbf98080d1`, o **Monitor Loop** passou a acionar o Dev centenas/milhares de vezes em sequência, gerando volume de log que o terminal não consegue exibir. Em todos os casos:

- **Agents (runtime):** Circuit breaker já estava aberto para `(project_id, DEV, implement_task)` (≥3 falhas consecutivas). O runtime **não chama a LLM**; devolve imediatamente um envelope com `status=BLOCKED`, `summary="Circuit breaker: 3 falhas consecutivas..."`, `artifacts=[]`.
- **Runner:** Continua vendo `need_dev = True` (existe tarefa em ASSIGNED/IN_PROGRESS/QA_FAIL/**BLOCKED**). Chama o Dev → recebe 200 OK com BLOCKED e sem artefato em apps/ → define a tarefa como **BLOCKED** e posta "Dev não entregou artefato em apps/. Task mantida para rework." → `time.sleep(2)` e nova iteração → escolhe de novo a mesma tarefa (BLOCKED) → chama o Dev de novo → repete indefinidamente.

### 8.2 Causa raiz

1. **Circuit breaker no runtime** protege a API (não fica chamando a LLM após 3 falhas), mas a resposta é um envelope “normal” (BLOCKED, sem artefatos). O runner não sabe que é circuit breaker; trata como “Dev respondeu BLOCKED sem apps/” e mantém a tarefa em BLOCKED para rework.
2. **Runner** não limita tentativas: qualquer tarefa em BLOCKED (ou ASSIGNED, QA_FAIL) é candidata a acionar o Dev de novo. Não há contagem de “vezes seguidas que o Dev retornou BLOCKED sem apps/” nem detecção de circuit breaker, então o loop nunca para.

### 8.3 Impacto

- Carga desnecessária no serviço de agentes (milhares de POST /invoke/dev).
- Logs gigantes (terminal 14 com centenas de linhas repetidas).
- Pipeline não progride: a tarefa nunca é marcada como DONE nem removida do conjunto “precisa de Dev”, e o loop continua até parada manual (SIGTERM) ou timeout.

---

## 9. Correções pós-incidente (implementadas)

### 9.1 Runtime (agents)

- Na resposta **early-return** do circuit breaker, o envelope passa a incluir:
  - `circuit_breaker_open: true`
  - `validator_pass: False`
- Assim o runner (e qualquer cliente) pode identificar que a falha é do circuit breaker e não “mais uma resposta BLOCKED” do modelo.

### 9.2 Runner (Monitor Loop)

1. **Detecção de circuit breaker**  
   Após a resposta do Dev, se `dev_response.get("circuit_breaker_open")` ou se `"Circuit breaker"` estiver em `dev_response.get("summary", "")`:
   - A tarefa é atualizada para **DONE** (não aprovada).
   - O `task_id` é colocado em um conjunto **dev_gave_up_tasks**.
   - Posta: *"Circuit breaker do Dev aberto. Tarefa marcada como DONE (não aprovada). Intervenção humana necessária."*
   - Na próxima iteração, tarefas em `dev_gave_up_tasks` **não** são mais escolhidas para acionar o Dev.

2. **Limite de tentativas Dev BLOCKED sem apps/**  
   - Contador por tarefa: **consecutive_dev_blocked[task_id]**.
   - Quando o Dev retorna **sem** artefato em apps/ (e não for circuit breaker), o contador é incrementado.
   - Quando o Dev retorna **com** artefato em apps/, o contador é zerado.
   - Se `consecutive_dev_blocked[task_id] >= MAX_CONSECUTIVE_DEV_BLOCKED` (env: **MAX_CONSECUTIVE_DEV_BLOCKED**, padrão 5):
     - A tarefa é marcada como **DONE** (não aprovada).
     - O `task_id` é adicionado a **dev_gave_up_tasks**.
     - Posta: *"Máximo de tentativas do Dev atingido (Nx sem artefato em apps/). Tarefa marcada como DONE (não aprovada)."*
   - Assim, mesmo sem circuit breaker, o runner para de chamar o Dev para essa tarefa após N falhas seguidas.

3. **Seleção de tarefa para Dev**  
   - Ao escolher `dev_task`, são ignoradas tarefas cujo `task_id` está em **dev_gave_up_tasks**.

### 9.3 Comportamento esperado após as correções

- **Circuit breaker aberto:** Na primeira resposta com circuit breaker, a tarefa vai para DONE e entra em `dev_gave_up_tasks`; o loop deixa de acionar o Dev para essa tarefa.
- **Dev sempre BLOCKED sem apps/:** Após 5 tentativas (configurável), a tarefa vai para DONE e entra em `dev_gave_up_tasks`; o loop para.
- O pipeline pode seguir para “todas as tarefas DONE” (incluindo as não aprovadas) e, se aplicável, para a mensagem de que o DevOps não será acionado ou para encerramento normal.

---

*Documento gerado a partir dos logs do terminal 14 (agents-host), logs Docker do runner e do código em applications/orchestrator, applications/contracts, applications/agents e applications/apps/genesis-web. Seção 8–9 adicionada após incidente de loop infinito no projeto 470f4ae5-1cde-4421-8f09-b4fbf98080d1.*
