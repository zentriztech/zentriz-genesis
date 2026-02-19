# Agentes (runtime + Engineer, CTO, PM, Dev, QA, Monitor, DevOps)

Runtime Python reutilizável para agentes que usam o LLM (Claude). Cada agente é definido por um `SYSTEM_PROMPT.md` em [agents/](../../agents/) e recebe/saída nos formatos message_envelope e response_envelope. O **Engineer** e os demais agentes são expostos pelo **mesmo** serviço Docker `agents` (container `zentriz-genesis-agents-1`; não há container separado por squad).

O system prompt é resolvido a partir de `applications/agents/{skill_path}/SYSTEM_PROMPT.md`. Para PM, Dev, QA, Monitor e DevOps o request pode incluir `input.context.skill_path` (ex.: `dev/backend/nodejs`, `pm/backend`); se ausente, usa-se o default do papel.

## Variáveis de ambiente

- `CLAUDE_API_KEY` (obrigatória)
- `CLAUDE_MODEL` (default: claude-sonnet-4-6)
- `REQUEST_TIMEOUT` (segundos)
- `LOG_LEVEL`

## Endpoints HTTP (serviço)

| Agente | Endpoint | Definição (SYSTEM_PROMPT) |
|--------|----------|---------------------------|
| **Engineer** | `POST /invoke/engineer` | [agents/engineer/SYSTEM_PROMPT.md](../../agents/engineer/SYSTEM_PROMPT.md) |
| CTO | `POST /invoke/cto` | [agents/cto/SYSTEM_PROMPT.md](../../agents/cto/SYSTEM_PROMPT.md) |
| PM | `POST /invoke/pm` | [agents/pm/backend/SYSTEM_PROMPT.md](../../agents/pm/backend/SYSTEM_PROMPT.md) (default); skill_path opcional |
| Dev | `POST /invoke/dev` | [agents/dev/backend/nodejs/SYSTEM_PROMPT.md](../../agents/dev/backend/nodejs/SYSTEM_PROMPT.md) (default); skill_path opcional |
| QA | `POST /invoke/qa` | [agents/qa/backend/nodejs/SYSTEM_PROMPT.md](../../agents/qa/backend/nodejs/SYSTEM_PROMPT.md) (default); skill_path opcional |
| Monitor | `POST /invoke/monitor` | [agents/monitor/backend/SYSTEM_PROMPT.md](../../agents/monitor/backend/SYSTEM_PROMPT.md) (default); skill_path opcional |
| DevOps | `POST /invoke/devops` | [agents/devops/docker/SYSTEM_PROMPT.md](../../agents/devops/docker/SYSTEM_PROMPT.md) (default); skill_path opcional |

Body: message_envelope (request_id, input com spec_ref, context, task, constraints, artifacts; opcional context.skill_path). Resposta: response_envelope.

## CLI (a partir da raiz do repo)

```bash
pip install -r orchestrator/agents/requirements.txt
```

| Agente | Comando CLI |
|--------|-------------|
| Engineer | `python -m orchestrator.agents.engineer --input message.json` |
| CTO | `python -m orchestrator.agents.cto` (stdin JSON) |
| PM | `python -m orchestrator.agents.pm --input message.json` |
| Dev | `python -m orchestrator.agents.dev --input message.json` |
| QA | `python -m orchestrator.agents.qa --input message.json` |
| Monitor | `python -m orchestrator.agents.monitor --input message.json` |
| DevOps | `python -m orchestrator.agents.devops --input message.json` |

Opção `--skill-path` (ex.: `--skill-path dev/web/react-next-materialui`) para PM, Dev, QA, Monitor e DevOps.

Exemplo (PM):
```bash
echo '{"request_id":"cli","input":{"spec_ref":"spec/PRODUCT_SPEC.md","context":{},"task":{},"constraints":{},"artifacts":[]}}' | python -m orchestrator.agents.pm
```

## Resumo por agente

- **Engineer** — Proposta técnica (squads, equipes, dependências) para o CTO; agents/engineer/
- **CTO** — Charter, contrata PM(s); definição em agents/cto/
- **PM** — Backlog da squad; default agents/pm/backend/; skill_path opcional
- **Dev** — Implementação (endpoints, testes, evidências); default agents/dev/backend/nodejs/
- **QA** — Testes, validação, QA report; default agents/qa/backend/nodejs/
- **Monitor** — Health e alertas; default agents/monitor/backend/
- **DevOps** — Docker (namespace zentriz-genesis), Terraform, k8s; default agents/devops/docker/

## Docker

O serviço **agents** expõe Engineer, CTO, PM, Dev, QA, Monitor e DevOps em uma única instância. Build a partir da raiz: `docker compose build agents`. Para subir todo o ambiente: [deploy-docker.sh](../../deploy-docker.sh) ou [docs/DEPLOYMENT.md](../../../project/docs/DEPLOYMENT.md).

---

## O que efetivamente se comunica com o LLM (Claude)?

A **única** parte do código que chama a API do Claude é a função **`run_agent()`** em [runtime.py](runtime.py). Ela usa a variável de ambiente `CLAUDE_API_KEY`, o SDK Anthropic (`client.messages.create`) e envia ao Claude: (1) o texto do `SYSTEM_PROMPT.md` do agente (system) e (2) o message_envelope em JSON (user). A resposta é tratada e devolvida no formato response_envelope.

Todos os agentes (Engineer, CTO, PM, Dev, QA, Monitor, DevOps) apenas preparam a entrada e chamam `run_agent()` — ou seja, **tudo que usa o runtime está de fato falando com o Claude**.

---

## Visão simples do que foi desenvolvido

1. **Um único “cérebro” (runtime)** — [runtime.py](runtime.py) carrega o manual do agente (SYSTEM_PROMPT), monta a pergunta e **chama o Claude**; devolve a resposta no formato combinado.

2. **Um módulo por papel** — Engineer, CTO, PM, Dev, QA, Monitor, DevOps. Cada um (a) resolve o path do SYSTEM_PROMPT em `agents/` (por skill_path ou default) e (b) chama `run_agent()`. Todos conectados ao Claude.

3. **Duas formas de uso** — **CLI** (entrada JSON por arquivo ou stdin; opcional `--skill-path`) e **HTTP** (serviço FastAPI com um endpoint por papel: /invoke/pm, /invoke/dev, etc.). Em ambos os casos a chamada real ao LLM acontece dentro de `run_agent()`.

4. **Runner** — [orchestrator/runner.py](../runner.py) orquestra em sequência: lê a spec, chama Engineer → CTO → PM (Claude) para charter e backlog e persiste o resultado. Usa `run_agent_http(agent_key, message)` com agent_key em `engineer`, `cto`, `pm`, `dev`, `qa`, `monitor`, `devops`.
