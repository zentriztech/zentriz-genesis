# Agentes (runtime + CTO, PM, Monitor, Dev, QA, DevOps Docker)

Runtime Python reutilizável para agentes que usam o LLM (Claude). Cada agente é definido por um `SYSTEM_PROMPT.md` em [agents/](../../agents/) e recebe/saída nos formatos message_envelope e response_envelope.

## Variáveis de ambiente

- `CLAUDE_API_KEY` (obrigatória)
- `CLAUDE_MODEL` (default: claude-3-5-sonnet-20241022)
- `REQUEST_TIMEOUT` (segundos)
- `LOG_LEVEL`

## Endpoints HTTP (serviço)

| Agente | Endpoint | Definição (SYSTEM_PROMPT) |
|--------|----------|---------------------------|
| PM Backend | `POST /invoke` | [agents/pm/backend/SYSTEM_PROMPT.md](../../agents/pm/backend/SYSTEM_PROMPT.md) |
| CTO | `POST /invoke/cto` | [agents/cto/SYSTEM_PROMPT.md](../../agents/cto/SYSTEM_PROMPT.md) |
| Monitor Backend | `POST /invoke/monitor` | [agents/monitor/backend/SYSTEM_PROMPT.md](../../agents/monitor/backend/SYSTEM_PROMPT.md) |
| Dev Backend | `POST /invoke/dev-backend` | [agents/dev/backend/nodejs/SYSTEM_PROMPT.md](../../agents/dev/backend/nodejs/SYSTEM_PROMPT.md) |
| QA Backend | `POST /invoke/qa-backend` | [agents/qa/backend/nodejs/SYSTEM_PROMPT.md](../../agents/qa/backend/nodejs/SYSTEM_PROMPT.md) |
| DevOps Docker | `POST /invoke/devops-docker` | [agents/devops/docker/SYSTEM_PROMPT.md](../../agents/devops/docker/SYSTEM_PROMPT.md) |

Body: message_envelope (request_id, input com spec_ref, context, task, constraints, artifacts). Resposta: response_envelope.

## CLI (a partir da raiz do repo)

```bash
pip install -r orchestrator/agents/requirements.txt
```

| Agente | Comando CLI |
|--------|-------------|
| PM Backend | `python -m orchestrator.agents.pm_backend --input message.json` |
| CTO | `python -m orchestrator.agents.cto_agent` (stdin JSON) |
| Monitor Backend | `python -m orchestrator.agents.monitor_backend --input message.json` |
| Dev Backend | `python -m orchestrator.agents.dev_backend --input message.json` |
| QA Backend | `python -m orchestrator.agents.qa_backend --input message.json` |
| DevOps Docker | `python -m orchestrator.agents.devops_docker --input message.json` |

Exemplo (PM Backend):
```bash
echo '{"request_id":"cli","input":{"spec_ref":"spec/PRODUCT_SPEC.md","context":{},"task":{},"constraints":{},"artifacts":[]}}' | python -m orchestrator.agents.pm_backend
```

## Resumo por agente

- **CTO** — Charter, contrata PM(s); definição em agents/cto/
- **PM Backend** — Backlog da stack Backend; agents/pm/backend/
- **Monitor Backend** — Health e alertas da stack Backend; agents/monitor/backend/
- **Dev Backend** — Implementação (endpoints, testes, evidências); agents/dev/backend/nodejs/
- **QA Backend** — Testes, validação, QA report; agents/qa/backend/nodejs/
- **DevOps Docker** — Docker (namespace zentriz-genesis), Terraform, k8s; agents/devops/docker/

## Docker

O serviço **agents-backend** (stack Backend) expõe os seis agentes em uma única instância. Build a partir da raiz: `docker compose build agents-backend`. Para subir todo o ambiente: [deploy-docker.sh](../../deploy-docker.sh) ou [docs/DEPLOYMENT.md](../../../project/docs/DEPLOYMENT.md).

---

## O que efetivamente se comunica com o LLM (Claude)?

A **única** parte do código que chama a API do Claude é a função **`run_agent()`** em [runtime.py](runtime.py). Ela usa a variável de ambiente `CLAUDE_API_KEY`, o SDK Anthropic (`client.messages.create`) e envia ao Claude: (1) o texto do `SYSTEM_PROMPT.md` do agente (system) e (2) o message_envelope em JSON (user). A resposta é tratada e devolvida no formato response_envelope.

Todos os seis agentes (CTO, PM, Monitor, Dev, QA, DevOps Docker) apenas preparam a entrada e chamam `run_agent()` — ou seja, **tudo que usa o runtime está de fato falando com o Claude**.

---

## Visão simples do que foi desenvolvido

1. **Um único “cérebro” (runtime)** — [runtime.py](runtime.py) carrega o manual do agente (SYSTEM_PROMPT), monta a pergunta e **chama o Claude**; devolve a resposta no formato combinado.

2. **Seis agentes** — Cada um é: (a) um “manual” em texto em `agents/` (SYSTEM_PROMPT.md) e (b) um módulo Python aqui que só indica qual manual usar e chama `run_agent()`. Os seis já conectados ao Claude: CTO, PM Backend, Monitor Backend, Dev Backend, QA Backend, DevOps Docker.

3. **Duas formas de uso** — **CLI** (entrada JSON por arquivo ou stdin) e **HTTP** (serviço FastAPI com um endpoint por agente). Em ambos os casos a chamada real ao LLM acontece dentro de `run_agent()`.

4. **Runner** — [orchestrator/runner.py](../runner.py) orquestra em sequência: lê a spec, chama CTO (Claude) para Charter, chama PM Backend (Claude) para backlog e persiste o resultado. Também usa o mesmo `run_agent()` para falar com o Claude.
