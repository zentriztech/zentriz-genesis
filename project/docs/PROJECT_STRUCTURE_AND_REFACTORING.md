# Estrutura do Projeto e Refatoração (project/ e applications/)

Este documento registra a **definição atual** da estrutura do repositório e o **plano de refatoração** para separar claramente artefatos do projeto (documentação, contexto, não distribuição) do produto final (aplicações, serviços, orquestrador e agentes).

---

## 1. Definição atual (antes da refatoração)

Estrutura na raiz do repositório até a data desta refatoração:

```
zentriz-genesis/
├─ .github/           # CI (workflows)
├─ .dockerignore      # Usado pelo build agents (contexto = raiz)
├─ .env.example
├─ docker-compose.yml # Stack: api, postgres, redis, agents, genesis-web
├─ deploy-docker.sh   # Script de deploy local
├─ README.md
├─ README_EN.md
├─ ARCHITECTURE_DIAGRAM.md
│
├─ spec/              # PRODUCT_SPEC.md, PRODUCT_SPEC_TEMPLATE.md (entrada do projeto)
├─ docs/              # Documentação do projeto: adr/, rfc/, guias, DEPLOYMENT, ACTORS_*, etc.
├─ context/           # Contexto para IA e devs: PROJECT_OVERVIEW, CONTEXT, QUICK_REFERENCE, etc.
├─ agents/            # Agentes por tipo/skill: cto/, pm/, dev/, qa/, devops/, monitor/
├─ contracts/         # DoD, message_envelope, response_envelope, checklists
├─ reports/           # Templates: QA_REPORT_TEMPLATE, MONITOR_HEALTH_TEMPLATE
├─ tests/             # tests/smoke/
├─ infra/             # IaC por cloud: aws/, azure/, gcp/
├─ orchestrator/      # Runner, spec_converter, agents (server Python)
├─ services/          # api-node (API Node/TypeScript)
├─ apps/              # genesis-web (Next.js)
├─ examples/          # Mensagens e outputs de exemplo
└─ scripts/           # Scripts de manutenção (validação, geração)
```

### Referências importantes na definição atual

- **Docker (agents):** build context = raiz; Dockerfile em `orchestrator/agents/Dockerfile`; copia `agents/`, `contracts/`, `docs/`, `orchestrator/`.
- **Python:** `REPO_ROOT = Path(__file__).resolve().parent.parent.parent` (raiz do repo). Paths: `spec/`, `docs/` (persistência de PROJECT_CHARTER.md), `agents/`, `orchestrator/state/`.
- **docker-compose:** `context: ./services/api-node`, `context: ./apps/genesis-web`, `context: .` para agents.
- **CI:** `working-directory: services/api-node`, `cd infra/aws`.
- **Links em Markdown:** relativos a `docs/`, `context/`, `spec/`, `contracts/`, `infra/`, `k8s/`, etc.

---

## 2. Refatoração: project/ e applications/

### Objetivo

- **project/** — Tudo relacionado ao *projeto* de criação do zentriz-genesis: documentação, contexto para IA e devs, specs de exemplo, scripts, IaC e config de deploy do próprio projeto. **Não** faz parte da distribuição/imagem do produto final.
- **applications/** — Tudo que é o **produto final** produzido: orchestrator, agents, contracts (runtime), services (api-node), apps (genesis-web).

### Mapeamento (onde cada pasta vai)

| Pasta atual (raiz) | Destino        | Motivo |
|--------------------|----------------|--------|
| docs/              | project/docs/ | Documentação do projeto (ADR, RFC, guias). Não é runtime. |
| context/           | project/context/ | Contexto para novos chats e onboarding. |
| spec/              | project/spec/ | Specs de exemplo e template; entrada por execução pode vir da API. |
| scripts/           | project/scripts/ | Scripts de manutenção. |
| examples/          | project/examples/ | Exemplos e referência. |
| reports/           | project/reports/ | Templates de relatório (referência). |
| tests/             | project/tests/ | Testes do projeto (smoke, etc.). |
| infra/             | project/infra/ | IaC do projeto (aws, azure, gcp). |
| k8s/               | project/k8s/  | Manifests Kubernetes do projeto. |
| agents/            | applications/agents/ | Produto. |
| orchestrator/      | applications/orchestrator/ | Produto. |
| contracts/         | applications/contracts/ | Usado em runtime pelos agentes. |
| services/          | applications/services/ | API (produto). |
| apps/              | applications/apps/ | Portal genesis-web (produto). |

Ficam na raiz: `.github/`, `.dockerignore`, `.env.example`, `docker-compose.yml`, `deploy-docker.sh`, `README.md`, `README_EN.md`, `ARCHITECTURE_DIAGRAM.md` (e arquivos de config da raiz).

### Ajustes técnicos da refatoração

1. **Docker (agents)**  
   - Context pode permanecer raiz; Dockerfile em `applications/orchestrator/agents/Dockerfile`.  
   - COPY: `applications/agents/` → `agents/`, `applications/contracts/` → `contracts/`, `applications/orchestrator/` → `orchestrator/`.  
   - **Remover** `COPY docs/ docs/` (doc do projeto não entra na imagem).  
   - Runner passa a persistir Charter em `orchestrator/state/` (ou `artifacts/`) em vez de `docs/`.

2. **docker-compose.yml**  
   - `api`: context `./applications/services/api-node`.  
   - `genesis-web`: context `./applications/apps/genesis-web`.  
   - `agents`: context `.`, dockerfile `applications/orchestrator/agents/Dockerfile`.

3. **Python (REPO_ROOT e paths)**  
   - Manter REPO_ROOT = raiz do repositório.  
   - Paths que apontam para aplicação: `applications/agents/`, `applications/contracts/`, `applications/orchestrator/`, spec default `project/spec/PRODUCT_SPEC.md` (ou configurável).  
   - Charter: persistir em `applications/orchestrator/state/PROJECT_CHARTER.md` (ou `STATE_DIR / "PROJECT_CHARTER.md"`).

4. **CI (.github/workflows/ci.yml)**  
   - `working-directory: applications/services/api-node`.  
   - Terraform: `cd project/infra/aws` (ou `infra/aws` se infra permanecer acessível a partir da raiz; como infra vai para project/, usar `project/infra/aws`).

5. **.dockerignore**  
   - Incluir apenas o necessário para o build do agents (applications/agents, applications/contracts, applications/orchestrator).  
   - Excluir project/ e demais pastas não usadas no build.

6. **Links em Markdown**  
   - Atualizar referências: `docs/` → `project/docs/`, `context/` → `project/context/`, `spec/` → `project/spec/`, `contracts/` → `applications/contracts/`, `infra/` → `project/infra/`, `k8s/` → `project/k8s/`, `services/` → `applications/services/`, `apps/` → `applications/apps/`, `agents/` → `applications/agents/`, `orchestrator/` → `applications/orchestrator/`, `reports/` → `project/reports/`, `scripts/` → `project/scripts/`, `examples/` → `project/examples/`, `tests/` → `project/tests/`.

---

## 3. Checklist da refatoração (aplicada)

### Estrutura e movimentação

- [x] Criar pastas `project/` e `applications/` na raiz.
- [x] Mover para `project/`: `docs/`, `context/`, `spec/`, `scripts/`, `examples/`, `reports/`, `tests/`, `infra/`, `k8s/`.
- [x] Mover para `applications/`: `agents/`, `orchestrator/`, `contracts/`, `services/`, `apps/`.

### Docker e deploy

- [x] Atualizar `applications/orchestrator/agents/Dockerfile`: COPY de `applications/agents/`, `applications/contracts/`, `applications/orchestrator/`; remover `COPY docs/`.
- [x] Atualizar `docker-compose.yml`: context api → `./applications/services/api-node`, genesis-web → `./applications/apps/genesis-web`, agents dockerfile → `applications/orchestrator/agents/Dockerfile`.
- [x] Atualizar `.dockerignore`: incluir apenas conteúdo de `applications/` necessário ao agents; excluir `project/`, `applications/apps/`, `applications/services/`.

### Python (orchestrator e agentes)

- [x] Atualizar `applications/orchestrator/runner.py`: REPO_ROOT/APPLICATIONS_ROOT; spec padrão `project/spec/PRODUCT_SPEC.md`; Charter persistido em `STATE_DIR/PROJECT_CHARTER.md` (orchestrator/state/).
- [x] Atualizar `applications/orchestrator/agents/runtime.py`: APPLICATIONS_ROOT para resolução de paths relativos.

### CI e config

- [x] Atualizar `.github/workflows/ci.yml`: `working-directory: applications/services/api-node`; Terraform `cd project/infra/aws`.
- [x] Atualizar `.env.example`: referência a `project/docs/SECRETS_AND_ENV.md`.
- [x] Atualizar `applications/contracts/message_envelope.json`: `spec_ref` exemplo `project/spec/PRODUCT_SPEC.md`.

### Documentação e links

- [x] Atualizar `README.md` e `README_EN.md`: árvore do projeto, links para `project/` e `applications/`.
- [x] Atualizar links em `project/docs/` (DEPLOYMENT.md, PLAN_PORTAL_GENESIS, SECRETS_AND_ENV, etc.): paths para raiz, applications, project.
- [x] Atualizar links em `project/context/` (CONTEXT.md, QUICK_REFERENCE, PROJECT_OVERVIEW, GENESIS_WEB_CONTEXT, README).
- [x] Atualizar `project/docs/DEPLOYMENT.md`: comandos pip, runner (PYTHONPATH, spec), kubectl (project/k8s/).
- [x] Atualizar `project/k8s/README.md`: referência a `project/k8s/` e `project/infra/`.
- [x] Atualizar READMEs em `applications/`: `applications/services/api-node/README.md`, `applications/orchestrator/README.md`, `applications/orchestrator/agents/README.md` (paths para project/docs, deploy-docker, tests).
- [x] Atualizar `applications/orchestrator/spec_converter/__init__.py`: referência a `project/docs/SPEC_SUBMISSION_AND_FORMATS.md`.

### Executar runner a partir da raiz do repo

Na raiz do repositório, use `PYTHONPATH=applications` para que o módulo `orchestrator` seja encontrado:

```bash
PYTHONPATH=applications python -m orchestrator.runner --spec project/spec/PRODUCT_SPEC.md
```

Ou, a partir da pasta `applications/`:

```bash
cd applications && python -m orchestrator.runner --spec ../project/spec/PRODUCT_SPEC.md
```

---

*Documento criado na refatoração project/ e applications/. Definição atual registrada em 2025-02; refatoração aplicada em seguida.*
