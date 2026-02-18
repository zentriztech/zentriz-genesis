# Orquestrador

Eventos, handlers e **runner** que coordena o fluxo spec → CTO → Charter → PM Backend → backlog.

## Runner (spec → CTO → PM → backlog)

A partir da **raiz do repositório**, com variáveis de ambiente configuradas (`.env` com `CLAUDE_API_KEY`):

```bash
# Instalar dependências dos agentes
pip install -r applications/orchestrator/agents/requirements.txt

# Executar fluxo (PYTHONPATH=applications para encontrar o módulo orchestrator)
PYTHONPATH=applications python -m orchestrator.runner --spec project/spec/PRODUCT_SPEC.md
```

**Saída:**
- Charter em `applications/orchestrator/state/PROJECT_CHARTER.md`
- Estado em `applications/orchestrator/state/current_project.json`
- Eventos em `applications/orchestrator/state/events.jsonl` (project.created, module.planned)

**Via Docker (serviço agents precisa estar no ar para chamadas HTTP; o runner usa imports locais):**
```bash
docker compose run --rm -e CLAUDE_API_KEY agents python -m orchestrator.runner --spec project/spec/PRODUCT_SPEC.md
```
(Se o runner chamar os agentes via HTTP em vez de import, use `API_AGENTS_URL=http://agents:8000` e ajuste o runner.)

Por padrão o runner chama os agentes por **import** (mesmo processo), então rode a partir do host com `python -m orchestrator.runner` após `pip install -r applications/orchestrator/agents/requirements.txt`.

## Eventos

Schemas em [orchestrator/events/schemas/](events/schemas/). Handlers em [orchestrator/handlers/](handlers/).

## Agentes

Runtime e implementações (PM Backend, Monitor Backend, CTO) em [orchestrator/agents/](agents/).
