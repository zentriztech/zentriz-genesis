# Contexto — Estado Atual do Projeto (Zentriz Genesis)

> **Uso**: Ponto único de contexto sobre o que foi realizado, como rodar e onde está documentado. Para visão geral do produto e atores, use [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).

---

## 1. Atividades já realizadas

### Documentação (Fase 0)
- **[docs/SPEC_SUBMISSION_AND_FORMATS.md](../docs/SPEC_SUBMISSION_AND_FORMATS.md)**: envio de spec ao CTO, formatos aceitos (.md preferencial, .txt, .doc/.docx, .pdf), múltiplos arquivos, conversor para Markdown, fluxo e boas práticas.
- Atualizados: PORTAL_TENANTS_AND_PLANS, ORCHESTRATION_GUIDE, API_CONTRACT, GENESIS_WEB_CONTEXT, PLAN_PORTAL_GENESIS com referências a spec multi-arquivo e ao conversor.

### API (services/api-node) — Fase 1
- **Banco**: PostgreSQL (tabelas `plans`, `tenants`, `users`, `projects`, `project_spec_files`). Schema em `src/db/schema.sql`; `initDb()` na subida; `seedIfEmpty()` + `ensureZentrizAdmin()` + `ensureTenantDemoUsers()` garantem usuários com senhas hasheadas.
- **Auth**: `POST /api/auth/login` (email, password) → `{ token, user, tenant? }`. Middleware Bearer; JWT + bcrypt.
- **Rotas**: `GET/POST/PATCH /api/projects`, `GET/POST/PATCH /api/projects/:id/tasks` (tarefas do pipeline; PATCH por task_id), `POST /api/projects/:id/accept` (marca projeto como aceito pelo usuário; status `accepted`), `GET /api/projects/:id/artifacts` (documentos quando `PROJECT_FILES_ROOT` definido), `POST /api/specs` (multipart, multi-arquivo .md/.txt/.doc/.docx/.pdf), `GET/POST /api/users`, `GET /api/tenants`. PATCH projects aceita `started_at`, `completed_at`, `status`, `charter_summary`; PATCH não permite alterar para `accepted` (apenas via POST accept).
- **Segurança**: cadastro de usuário (`POST /api/users`) com senha mínimo 8 e máximo 128 caracteres, validação de e-mail, hash bcrypt; apenas tenant_admin ou zentriz_admin podem criar usuários.
- **CORS**: `credentials: true` e `allowedHeaders` para o portal em localhost:3001.

### Conversor de spec (orchestrator) — Fase 2
- **orchestrator/spec_converter/**: converte .txt, .doc/.docx, .pdf → Markdown (python-docx, PyMuPDF). Função `convert_to_markdown(input_path, output_path=None)`. Testes em `test_converter.py`.

### Portal genesis-web — Fase 3
- **Auth**: login via `POST /api/auth/login`; token e user/tenant em localStorage; header `Authorization: Bearer` em todas as requisições.
- **Projetos**: listagem e detalhe via API; tipos com `startedAt`/`completedAt`.
- **Três telas de login** com discriminação por role: `/login` (user), `/login/tenant` (tenant_admin), `/login/genesis` (zentriz_admin). Após login, se o role não corresponder à tela, exibe mensagem orientando a usar a tela correta.
- **Tela "Enviar spec ao CTO"**: upload de um ou mais arquivos (.md, .txt, .doc, .docx, .pdf), título opcional, envio multipart para `POST /api/specs`; feedback com link para o projeto e aviso quando `pending_conversion`.
- **Erros da API**: exibição apenas do campo `message` (não JSON bruto).

### Runner e pipeline — Fase 4 (fluxo V2)
- **Runner** ([orchestrator/runner.py](../../applications/orchestrator/runner.py)): com API e `PROJECT_ID`, executa **fluxo V2**. (1) **CTO spec review**: usa [PRODUCT_SPEC_TEMPLATE](../spec/PRODUCT_SPEC_TEMPLATE.md), converte/valida a spec e grava em docs. (2) **Loop CTO↔Engineer** (max `MAX_CTO_ENGINEER_ROUNDS`): Engineer devolve 1+ .md; CTO valida; saída = Charter. (3) **Loop CTO↔PM** (max `MAX_CTO_PM_ROUNDS`): PM gera backlog; CTO valida; se OK, seed de tarefas e **Monitor Loop**. (4) **Monitor Loop**: aciona Dev, QA ou DevOps; Dev grava código em `<project_id>/apps/`; DevOps em `<project_id>/project/`; não aciona DevOps se task DONE por max QA rework. **Parada**: usuário aceita ou SIGTERM. Sem API: fluxo sequencial. Ver [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](../docs/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md), [PIPELINE_V2_IA_REAL_AND_PATHS.md](../docs/PIPELINE_V2_IA_REAL_AND_PATHS.md), [AGENTS_AND_LLM_FLOW.md](../docs/AGENTS_AND_LLM_FLOW.md).
- **Blueprint V2 REV2** ([BLUEPRINT_ZENTRIZ_GENESIS_AGENTS_FUNCTIONAL_PIPELINE_V2_REV2.md](../docs/BLUEPRINT_ZENTRIZ_GENESIS_AGENTS_FUNCTIONAL_PIPELINE_V2_REV2.md)): contratos ([AGENT_PROTOCOL.md](../../applications/contracts/AGENT_PROTOCOL.md)), validação/repair/path policy ([envelope.py](../../applications/orchestrator/envelope.py)), storage resiliente (project_id obrigatório, atômico, locks, [project_storage.py](../../applications/orchestrator/project_storage.py)), prompts executáveis (Spec Intake CTO, artefatos mínimos por agente), runner com audit trail e modelo por contexto, testes em [orchestrator/tests/test_envelope.py](../../applications/orchestrator/tests/test_envelope.py) e [test_project_storage.py](../../applications/orchestrator/tests/test_project_storage.py).
- **Testes**: API (Vitest); conversor (pytest); smoke test em [tests/smoke/api_smoke_test.sh](../../project/tests/smoke/api_smoke_test.sh); unit envelope e project_storage (pytest a partir de `applications/`).
- **Docs**: DEPLOYMENT e API_CONTRACT atualizados com fluxo de spec e referência a SPEC_SUBMISSION_AND_FORMATS.

---

## 2. Stack e serviços (Docker)

| Serviço        | Porta | Descrição |
|----------------|-------|-----------|
| api            | 3000  | API Node (Fastify, Postgres, auth, projects, specs, artifacts, users, tenants) |
| genesis-web    | 3001  | Portal Next.js + MUI + MobX |
| runner         | 8001  | Orquestrador: fluxo V2 (CTO spec review + CTO↔Engineer + CTO↔PM) + Monitor Loop; docs/apps/project em PROJECT_FILES_ROOT/<project_id>/ |
| agents         | 8000  | Agentes (Engineer, CTO, PM, Dev, QA, DevOps, Monitor; futuramente Web, Mobile) — LLM |
| postgres       | 5432  | PostgreSQL |
| redis          | 6379  | Cache / sessões |

Deploy local: na raiz, `./deploy-docker.sh` ou `docker compose up -d --build`. Ver [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

---

## 3. Usuários padrão e credenciais

Criados/atualizados pelo seed da API na subida. **Alterar senhas em produção.**

| Tela            | E-mail             | Senha         | Role          |
|-----------------|--------------------|---------------|---------------|
| `/login/genesis`| admin@zentriz.com  | #Jean@2026!   | zentriz_admin |
| `/login/tenant` | admin@tenant.com  | #Tenant@2026! | tenant_admin  |
| `/login`        | user@tenant.com   | #User@2026!   | user          |

`user@tenant.com` e `admin@tenant.com` pertencem ao mesmo tenant (Tenant Demo). Detalhes: [services/api-node/README.md](../../applications/services/api-node/README.md), [docs/SECRETS_AND_ENV.md](../docs/SECRETS_AND_ENV.md).

---

## 4. Como rodar

```bash
# Na raiz do repositório
./deploy-docker.sh          # ou: docker compose up -d --build

# Portal
open http://localhost:3001  # login conforme role (use uma das três URLs de login)

# API
curl http://localhost:3000/health
```

Variáveis: [.env](../../.env) (copiar de [.env.example](../../.env.example)); ver [docs/SECRETS_AND_ENV.md](../docs/SECRETS_AND_ENV.md).

---

## 5. Documentos relacionados

| Assunto              | Documento |
|----------------------|-----------|
| Visão geral do projeto | [context/PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) |
| Portal genesis-web   | [context/GENESIS_WEB_CONTEXT.md](GENESIS_WEB_CONTEXT.md) |
| Pipeline e agentes (fluxo LLM) | [docs/AGENTS_AND_LLM_FLOW.md](../docs/AGENTS_AND_LLM_FLOW.md) |
| Pipeline squad completa e storage | [docs/PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md](../docs/PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md) |
| Prontidão E2E e código em project/ | [docs/PIPELINE_E2E_AND_SOURCE_CODE_READINESS.md](../docs/PIPELINE_E2E_AND_SOURCE_CODE_READINESS.md) |
| **Plano Pipeline V2 (fluxo autônomo)** | [docs/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](../docs/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md) |
| **Extensão: IA real e paths (spec template, apps/)** | [docs/PIPELINE_V2_IA_REAL_AND_PATHS.md](../docs/PIPELINE_V2_IA_REAL_AND_PATHS.md) |
| **Blueprint V2 REV2 (agentes funcionais, contratos, resiliência)** | [docs/BLUEPRINT_ZENTRIZ_GENESIS_AGENTS_FUNCTIONAL_PIPELINE_V2_REV2.md](../docs/BLUEPRINT_ZENTRIZ_GENESIS_AGENTS_FUNCTIONAL_PIPELINE_V2_REV2.md) |
| **Contrato operacional (SSOT executável)** | [contracts/AGENT_PROTOCOL.md](../../applications/contracts/AGENT_PROTOCOL.md) |
| Relatório análise pipeline (2026-02-20) | [docs/RELATORIO_ANALISE_PIPELINE_AGENTES_20260220.md](../docs/RELATORIO_ANALISE_PIPELINE_AGENTES_20260220.md) |
| DE-PARA API Web ↔ Backend agentes | [docs/DE-PARA_API_WEB_BACKEND_AGENTES.md](../docs/DE-PARA_API_WEB_BACKEND_AGENTES.md) |
| Prompt execução 100% Runner/Enforcer | [docs/PROMPT_EXECUCAO_100P_ZENTRIZ_GENESIS_RUNNER_ENFORCER.md](../docs/PROMPT_EXECUCAO_100P_ZENTRIZ_GENESIS_RUNNER_ENFORCER.md) |
| Template SYSTEM_PROMPT (protocolo) | [docs/SYSTEM_PROMPT_TEMPLATE_AGENT_PROTOCOL.md](../docs/SYSTEM_PROMPT_TEMPLATE_AGENT_PROTOCOL.md) |
| Troubleshooting pipeline | [docs/PIPELINE_TROUBLESHOOTING.md](../docs/PIPELINE_TROUBLESHOOTING.md) |
| API e usuários       | [services/api-node/README.md](../../applications/services/api-node/README.md) |
| Contrato da API      | [docs/API_CONTRACT.md](../docs/API_CONTRACT.md) |
| Deploy               | [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) |
| Envio de spec        | [docs/SPEC_SUBMISSION_AND_FORMATS.md](../docs/SPEC_SUBMISSION_AND_FORMATS.md) |
| Plano do portal      | [docs/PLAN_PORTAL_GENESIS.md](../docs/PLAN_PORTAL_GENESIS.md) |
| Referência rápida    | [context/QUICK_REFERENCE.md](QUICK_REFERENCE.md) |

---

## 6. Contexto de sessão (últimas alterações)

### Deploy e agents
- **Modo host-agents** (`./deploy-docker.sh --host-agents --force-recreate`): o serviço **agents** não sobe no Docker; sobe apenas api, genesis-web, runner. Após o deploy, rodar no host `./start-agents-host.sh` (porta 8000). O runner no Docker usa `API_AGENTS_URL=http://host.docker.internal:8000`. O script foi corrigido para não subir o container agents e para dar `stop agents` quando em modo host-agents.
- **CORS**: API trata OPTIONS (preflight) com 204 e `methods`/`allowedHeaders` explícitos em `app.ts`; evita 404 no portal ao chamar login/projects.

### Pipeline: Iniciar / Reiniciar
- **POST /run** retorna no 202 `{ ok, message, status: "running" }` para o frontend atualizar a UI sem depender do GET do projeto.
- **Frontend**: ao receber 202 com `status: "running"`, chama `projectsStore.setProjectStatus(id, "running")` para mostrar "Em execução" imediatamente; Alert em destaque para erro ao iniciar/reiniciar; quando status é "running", exibe dica com `docker compose logs runner --tail=100`.
- **Store**: `projectsStore.setProjectStatus(id, status)` para atualização otimista.
- **API e runner**: logs de diagnóstico em `[Pipeline]` e `[Runner]` (POST /run, spec path, chamada ao runner, erro se houver). Runner valida se o arquivo de spec existe no path antes de iniciar o subprocess; se não existir, retorna 400 com mensagem clara (volume de uploads deve ser compartilhado entre API e runner).

### Seed tasks e banco (corrigido 2026-02-19)
- **Erro "Falha ao criar tarefas iniciais na API"**: era violação do CHECK `project_tasks_owner_role_check`. O runner enviava `owner_role: "DEV"` e o schema só aceitava `DEV_BACKEND`, `QA_BACKEND`, etc.
- **Correção**: (1) Migration em `schema.sql` — CHECK ampliado para aceitar também `DEV`, `QA`, `DEVOPS`, `MONITOR`, `ENGINEER`, `CTO`, `PM`. (2) `_seed_tasks` no runner passou a enviar `owner_role: "DEV_BACKEND"` (valor válido).
- **Resiliência**: quando `_seed_tasks` falha, o runner marca o projeto como `status: "failed"` na API (`_patch_project`) e registra o erro no diálogo, permitindo ao usuário reiniciar pelo portal.

### QA e Monitor Loop
- **QA pass**: `_is_qa_pass(qa_response)` considera aprovado se status ou summary contiver "pass", "ok", "aprovado", "success", "done" ou trechos no texto; evita QA_FAIL infinito por variação da resposta do LLM.
- **MAX_QA_REWORK** (env, default 3): após N vezes QA_FAIL na mesma tarefa, a tarefa é marcada DONE e o loop segue.
- **Reiniciar** = novo processo do zero: **fluxo V2** (CTO spec review → loop CTO↔Engineer → PM → seed de tarefas → **Monitor Loop** até aceitar ou parar). O "Monitor" é o loop no runner, não um serviço separado.

### Portal: loading e diálogo
- **agent_working**: antes de cada chamada ao LLM, o runner envia evento de diálogo `agent_working` com mensagem descritiva. O portal usa a última entrada `agent_working` para mostrar CircularProgress no passo correspondente do Stepper e a mensagem abaixo do stepper.

### Artefatos em disco (corrigido 2026-02-19)
- **Bind mount no compose**: dentro do container `PROJECT_FILES_ROOT` é sempre `/project-files` (fixo no docker-compose.yml). O compose monta `${HOST_PROJECT_FILES_ROOT:-./zentriz-files}:/project-files` em api e runner — assim os artefatos gravados pelo runner aparecem no host (ex. `/Users/mac/zentriz-files/<project_id>/docs/`).
- **.env**: usar `HOST_PROJECT_FILES_ROOT=/Users/mac/zentriz-files` (pasta no host). Não usar mais `PROJECT_FILES_ROOT` no .env para Docker.
- **Deploy**: `deploy-docker.sh` garante que o diretório de artefatos no host exista (`mkdir -p`) antes do up.
- **Estrutura de artefatos**: `<project_id>/docs/` (documentos dos agentes), `<project_id>/apps/` (código gerado pelo Dev), `<project_id>/project/` (infra/DevOps). Path policy (Blueprint): `artifact.path` com prefixo `docs/`, `project/` ou `apps/`; bloqueio de path traversal. Runner chama `ensure_project_dirs(project_id)` no início; storage exige `project_id`, escrita atômica e lock por projeto. Ver [PIPELINE_V2_IA_REAL_AND_PATHS.md](../docs/PIPELINE_V2_IA_REAL_AND_PATHS.md) e [AGENT_PROTOCOL.md](../../applications/contracts/AGENT_PROTOCOL.md).

### Troubleshooting
- **[docs/PIPELINE_TROUBLESHOOTING.md](../docs/PIPELINE_TROUBLESHOOTING.md)**: fluxo esperado, cenários (botão não aparece, sem spec, runner não configurado, 202 mas sem diálogo), comandos de logs, seção "Reiniciar/Iniciar sem movimentação", checklist por projeto.

### Agentes (rename e endpoints)
- Módulos renomeados: `dev_backend`→`dev`, `pm_backend`→`pm`, `qa_backend`→`qa`, `monitor_backend`→`monitor`, `devops_docker`→`devops`; `cto_agent`→`cto`, `engineer_agent`→`engineer`.
- Endpoints no serviço agents: `POST /invoke/engineer`, `/invoke/cto`, `/invoke/pm`, `/invoke/dev`, `/invoke/qa`, `/invoke/monitor`, `/invoke/devops`. System prompt por `skill_path` ou default.

### Blueprint V2 REV2 — Agentes realmente funcionais (2026-02-20)
- **Contratos e validação**: [contracts/AGENT_PROTOCOL.md](../../applications/contracts/AGENT_PROTOCOL.md) centraliza path policy, ResponseEnvelope e artefatos mínimos por agente. [orchestrator/envelope.py](../../applications/orchestrator/envelope.py): `sanitize_artifact_path` (bloqueia `..`, absolutos, `~`), `validate_response_envelope`, `parse_response_envelope`, `repair_prompt()`, `filter_artifacts_by_path_policy`.
- **Storage resiliente**: [orchestrator/project_storage.py](../../applications/orchestrator/project_storage.py) exige `project_id` em `write_doc`/`write_project_artifact`/`write_apps_artifact`; escrita atômica (temp + rename); lock por `project_id`; `ensure_project_dirs(project_id)` garante docs/, project/, apps/; **path policy**: artefatos Dev em `apps/`, DevOps em `project/` (bloqueio de path traversal).
- **Prompts executáveis**: Todos os SYSTEM_PROMPT seguem o template com (1) **seção 0 AGENT CONTRACT** (YAML: name, variant, mission, communicates_with, paths, quality_gates_global, required_artifacts_by_mode); (2) **protocolo compartilhado** incluído via `<!-- INCLUDE: SYSTEM_PROMPT_PROTOCOL_SHARED -->` (contracts/SYSTEM_PROMPT_PROTOCOL_SHARED.md: ROLE, INPUT/OUTPUT contract, path policy, anti-prompt-injection, failure behavior); (3) **MODE SPECS** por agente (modos, artefatos obrigatórios, gates); (4) **GOLDEN EXAMPLES**. CTO com Spec Intake; Engineer 3 docs em `docs/engineer/`; PM backlog em `docs/pm/<squad>/`; Dev artefatos em `apps/`; QA QA_PASS/QA_FAIL e `docs/qa/QA_REPORT_<task_id>.md`; Monitor state machine em `docs/monitor/`; DevOps em `project/` e `docs/devops/RUNBOOK.md`.
- **Runner E2E**: no início chama `ensure_project_dirs(project_id)`; persiste artefatos do Dev/DevOps após `filter_artifacts_by_path_policy` (prefixos `apps/` e `project/` tratados); **audit trail** `_audit_log(agent, request_id, response)` após cada agente; [agents/runtime.py](../../applications/orchestrator/agents/runtime.py) usa `parse_response_envelope` e seleção de modelo por contexto (`CLAUDE_MODEL_SPEC`, `CLAUDE_MODEL_CODE`, `PIPELINE_LLM_MODEL`).
- **Circuit breaker e gate Dev**: O runtime inclui na resposta `circuit_breaker_open: true` quando o circuit breaker está aberto; o runner detecta esse sinal e **interrompe o loop** (não continua chamando agentes). **Gate Dev sem apps/**: se a tarefa é do Dev e ainda não existe `apps/` no projeto, o runner marca BLOCKED e conta tentativas; após um limite de tentativas BLOCKED sem apps/, o loop para (evita loop infinito). Ver [PIPELINE_TROUBLESHOOTING.md](../docs/PIPELINE_TROUBLESHOOTING.md).
- **Testes**: [orchestrator/tests/test_envelope.py](../../applications/orchestrator/tests/test_envelope.py) (validator, sanitizer, parse, filter, repair_prompt); [orchestrator/tests/test_project_storage.py](../../applications/orchestrator/tests/test_project_storage.py) (project_id obrigatório, ensure_project_dirs, path traversal bloqueado); [orchestrator/tests/test_enforcer_smoke.py](../../applications/orchestrator/tests/test_enforcer_smoke.py). Rodar de `applications/`: `python -m pytest orchestrator/tests/test_envelope.py orchestrator/tests/test_project_storage.py -v`.

### Arquivos principais
- API pipeline: `applications/services/api-node/src/routes/pipeline.ts`
- Schema e migration owner_role: `applications/services/api-node/src/db/schema.sql`
- Runner: `applications/orchestrator/runner.py` (fluxo V2 + Monitor Loop, ensure_project_dirs, audit trail, path policy na persistência)
- Envelope e validação: `applications/orchestrator/envelope.py`
- Contrato operacional: `applications/contracts/AGENT_PROTOCOL.md`
- Runner service: `applications/orchestrator/runner_server.py` (POST /run, valida spec path)
- Frontend projeto: `applications/apps/genesis-web/app/(dashboard)/projects/[id]/page.tsx`
- Store: `applications/apps/genesis-web/stores/projectsStore.ts`
- Deploy: `deploy-docker.sh` (--host-agents exclui agents do up e dá stop agents; garante dir artefatos no host)

### Pipeline V2 e extensão IA real (2026-02-19)
- **Fluxo V2**: CTO spec review (com [PRODUCT_SPEC_TEMPLATE](../spec/PRODUCT_SPEC_TEMPLATE.md)) → loop CTO↔Engineer (max `MAX_CTO_ENGINEER_ROUNDS`) → Charter → **loop CTO↔PM** (max `MAX_CTO_PM_ROUNDS`, CTO valida backlog) → seed tasks → Monitor Loop. Artefatos do **Dev** com `path` em `<project_id>/apps/`; **DevOps** em `<project_id>/project/`. Contratos em [PIPELINE_V2_HANDOFF_CONTRACTS.md](../docs/PIPELINE_V2_HANDOFF_CONTRACTS.md).
- **Extensão [PIPELINE_V2_IA_REAL_AND_PATHS.md](../docs/PIPELINE_V2_IA_REAL_AND_PATHS.md):** CTO converte/valida spec para o template; Engineer devolve 1+ .md; CTO valida backlog do PM; Dev/QA prompts exigem artefatos e QA_PASS/QA_FAIL. Checklist P1–P9 implementado.

### Artefatos: conteúdo legível e DevOps só com QA aprovado (2026-02-19)
- **Artefatos .md com JSON**: A LLM às vezes devolve no `summary` um JSON (envelope). O runner passou a usar `_content_for_doc(response)` para extrair só o texto legível ao gravar em docs/ (engineer, cto, pm, dev, qa, devops).
- **DevOps após QA_FAIL**: Se uma tarefa foi marcada DONE por "máximo de reworks" do QA (não aprovada), o Monitor **não** aciona mais o DevOps; publica no diálogo o motivo e encerra essa linha. Ver [PIPELINE_TROUBLESHOOTING.md](../docs/PIPELINE_TROUBLESHOOTING.md) §6.

### Repo
- **Último estado**: Blueprint V2 REV2 implementado (Fases 1–5): contratos (AGENT_PROTOCOL, envelope validator/repair/path policy), storage resiliente (project_id obrigatório, atômico, locks, ensure_project_dirs, path policy apps/ e project/), prompts executáveis com Spec Intake no CTO e artefatos mínimos por agente, runner com audit trail e modelo por contexto. **Circuit breaker**: runtime sinaliza `circuit_breaker_open`; runner interrompe o loop ao detectar. **Gate Dev**: limite de tentativas BLOCKED sem `apps/` para evitar loop infinito. Testes: envelope, project_storage, enforcer smoke. Documentação: [RELATORIO_ANALISE_PIPELINE_AGENTES_20260220.md](../docs/RELATORIO_ANALISE_PIPELINE_AGENTES_20260220.md), DE-PARA, PROMPT_EXECUCAO_100P, SYSTEM_PROMPT_TEMPLATE. Variáveis: `MAX_CTO_ENGINEER_ROUNDS`, `MAX_CTO_PM_ROUNDS`, `CLAUDE_MODEL`, `CLAUDE_MODEL_SPEC`, `CLAUDE_MODEL_CODE`, `PIPELINE_LLM_MODEL`.

---

*Criado em 2026-02-17 — Zentriz Genesis. Atualize quando houver mudanças relevantes no estado do projeto. Seção 6 atualizada em 2026-02-20 (circuit breaker, gate Dev, relatório e docs).*
