# Plano de Correção — Testes E2E Pipeline

> **Fonte**: [E2E_TEST_DIAGNOSIS.md](../analysis/E2E_TEST_DIAGNOSIS.md)  
> **Objetivo**: Corrigir as 5 causas identificadas para que os testes E2E passem (ou falhem com erro claro, não timeout).

---

## Visão geral

| # | Problema | Severidade | Ação |
|---|----------|------------|------|
| 1 | Agents não responde (ReadTimeout 20 min) | CRÍTICA | Timeout + max_tokens no runtime; validar mode no server |
| 2 | Payload do teste ≠ esperado pelo server | ALTA | Adicionar `agent`, `task_id`; alinhar com server |
| 3 | Endpoints Dev/QA errados no teste | MÉDIA | Usar `/invoke/dev-backend` e `/invoke/qa-backend` se for o caso |
| 4 | conftest.py report sempre 0/0/0 | BAIXA | Corrigir leitura de resultados (ou ler do junit.xml) |
| 5 | Spec file path/nome | MÉDIA | Confirmar path e nome do arquivo |

---

## Fase 1 — Verificação (antes de alterar código)

### 1.1 Endpoints reais do agents

Confirmar no código quais rotas existem:

- **Arquivo:** `applications/orchestrator/agents/server.py`
- **Ação:** Listar todos os `@app.post("/invoke/...")`.
- **Decisão:** Se existir `/invoke/dev-backend` e `/invoke/qa-backend`, o teste deve usar esses nomes na URL; se existir apenas `/invoke/dev` e `/invoke/qa`, deixar como está.

```bash
grep -n 'post\|invoke' applications/orchestrator/agents/server.py
```

### 1.2 Runtime: timeout e max_tokens na chamada Claude

- **Arquivo:** `applications/orchestrator/agents/runtime.py`
- **Ação:** Verificar se `client.messages.create()` recebe `timeout` e qual `max_tokens` é usado para o CTO / spec_intake.
- **Meta:** Garantir timeout ≤ 180 s na API e max_tokens ≤ 8000–12000 para spec_intake.

```bash
grep -n "messages.create\|max_tokens\|timeout" applications/orchestrator/agents/runtime.py
```

### 1.3 Payload esperado pelo server

- **Arquivo:** `applications/orchestrator/agents/server.py` (e onde monta `message` para `run_agent`)
- **Ação:** Ver de onde o server lê `project_id`, `mode`, `task`, `inputs` (ou `input`). Verificar se usa `agent` ou `task_id`.
- **Arquivo:** `applications/orchestrator/agents/runtime.py` — `build_user_message(message)` e `run_agent(..., message)`.
- **Meta:** Alinhar o body que o teste envia com o que o server/runtime de fato usa.

---

## Fase 2 — Correções no agents (runtime)

### 2.1 Timeout na chamada à API Claude

- **Arquivo:** `applications/orchestrator/agents/runtime.py`
- **Onde:** Na chamada `client.messages.create(...)`.
- **Alteração:** Garantir que existe um `timeout` (em segundos), por exemplo `timeout=180`, para evitar que uma única chamada rode indefinidamente.
- **Nota:** Se já existir `timeout` vindo de variável de ambiente (ex.: `REQUEST_TIMEOUT`), conferir o valor; 120–180 s é razoável para spec_intake.

### 2.2 max_tokens por modo/agente

- **Arquivo:** `applications/orchestrator/agents/runtime.py`
- **Onde:** Onde é definido `max_tokens` passado para `messages.create()`.
- **Alteração:** Para o modo `spec_intake_and_normalize` (CTO), usar um limite menor (ex.: 8000 ou 12000), não 16000+, para reduzir tempo de geração e risco de timeout.
- **Nota:** Manter valores maiores para Dev/PM se o documento de análise assim recomendar; o diagnóstico aponta especificamente o CTO/spec_intake.

---

## Fase 3 — Correções no teste E2E

### 3.1 Payload: campos `agent` e `task_id`

- **Arquivo:** `tests/e2e/test_pipeline_landing.py`
- **Onde:** Em todos os `body` usados em `call_agent(...)` (CTO, Engineer, PM, Dev, QA).
- **Alteração:**
  - Incluir `"agent": "<nome>"` (ex.: `"cto"`, `"engineer"`) quando o server ou o runtime usarem esse campo.
  - Incluir `"task_id": None` (ou o id da task quando houver) se o server/runtime acessarem `task_id`.
- **Fonte:** E2E_TEST_DIAGNOSIS.md §3 — guia sugere esses campos; validar no server antes.

### 3.2 Campo `input` duplicado

- **Arquivo:** `tests/e2e/test_pipeline_landing.py`
- **Decisão:** O diagnóstico recomenda **remover** o duplicata `input` se o server usar apenas `inputs`. Se o runtime ler de `message.get("input") or message.get("inputs")`, manter ambos com o mesmo conteúdo é seguro; caso contrário, remover `input` e deixar só `inputs` conforme o que o server espera.
- **Ação:** Confirmar no server/runtime qual chave é lida; depois deixar apenas a necessária ou as duas iguais, de forma consistente.

### 3.3 Endpoints Dev e QA

- **Arquivo:** `tests/e2e/test_pipeline_landing.py`
- **Onde:** Em `call_agent()` — construção da URL (ex.: `AGENTS_URL + "/invoke/" + agent_name`).
- **Verificação:** Em `applications/orchestrator/agents/server.py` as rotas atuais são `/invoke/dev` e `/invoke/qa` (não `dev-backend`/`qa-backend`). O teste que usa `call_agent("dev", ...)` e `call_agent("qa", ...)` já está correto para esse server. Se em outro ambiente existir `dev-backend`/`qa-backend`, usar o mapeamento abaixo. Exemplo de mapeamento:

```python
AGENT_ENDPOINTS = {
    "cto": "cto",
    "engineer": "engineer",
    "pm": "pm",
    "dev": "dev-backend",   # só se for o nome real da rota
    "qa": "qa-backend",     # só se for o nome real da rota
    "monitor": "monitor",
}
# Em call_agent: endpoint = AGENT_ENDPOINTS.get(agent_name, agent_name)
# url = "%s/invoke/%s" % (AGENTS_URL.rstrip("/"), endpoint)
```

- **Ação prévia:** Confirmar em `server.py` os nomes exatos das rotas antes de alterar.

---

## Fase 4 — Relatórios (conftest)

### 4.1 Corrigir summary no conftest

- **Arquivo:** `tests/e2e/conftest.py`
- **Problema:** `session.session.results` não existe no pytest; por isso o resumo sai 0/0/0.
- **Alteração:** Obter totais de outra forma, por exemplo:
  - Ler o `junit.xml` gerado na mesma pasta e contar `<testcase>` com `status` passed/failed/skipped, ou
  - Usar atributos corretos da session (ex.: `session.testsfailed`, `session.testscollected`) se disponíveis na versão do pytest em uso.
- **Referência:** E2E_TEST_DIAGNOSIS.md §5 — exemplo usando `session.testscollected` e `session.testsfailed`; ajustar conforme API do pytest instalado.

---

## Fase 5 — Spec file (path/nome)

### 5.1 Confirmar local e nome da spec

- **Path usado no teste:** `_repo_root / "project" / "spec" / "spec_landing_zentriz.txt"`
- **Ação:** Confirmar que o arquivo existe nesse path e que o nome está correto (ex.: `spec_landing_zentriz.txt` vs `spec-landing-zentriz.txt`).
- **Se não existir:** Criar o arquivo ou apontar `SPEC_FILE` para o path/nome corretos em `test_pipeline_landing.py`.

---

## Ordem sugerida de execução

1. **Fase 1** — Verificações (endpoints, runtime, payload). Anotar o que está diferente do esperado.
2. **Fase 2** — Ajustar runtime (timeout + max_tokens). Rodar teste manual com `curl` (ex.: diagnóstico Passo 1) e ver se o CTO responde em até ~3 min.
3. **Fase 3** — Ajustar payload e endpoints no teste. Rodar só `test_01` com pytest.
4. **Fase 4** — Corrigir conftest para o report. Rodar suite e checar `summary_*.txt`.
5. **Fase 5** — Validar spec path/nome se ainda houver `FileNotFoundError`.

---

## Comandos úteis após as correções

```bash
# Teste manual CTO (diagnóstico)
curl -v -X POST http://127.0.0.1:8000/invoke/cto \
  -H "Content-Type: application/json" \
  -d '{"project_id":"diag","agent":"cto","mode":"spec_intake_and_normalize","task_id":null,"task":"Converter spec","inputs":{"spec_raw":"Landing simples: hero, sobre, contato."},"limits":{"max_rounds":1,"round":1}}' \
  --max-time 180

# Só primeiro teste
pytest tests/e2e/test_pipeline_landing.py -v -s -k "test_01"

# Até PM (sem Dev/QA)
pytest tests/e2e/test_pipeline_landing.py -v -s -k "not test_06 and not test_07"

# Suite completa
pytest tests/e2e/test_pipeline_landing.py -v -s --junitxml=tests/e2e/reports/junit.xml
```

---

## Referências

- **Diagnóstico completo:** [E2E_TEST_DIAGNOSIS.md](../analysis/E2E_TEST_DIAGNOSIS.md)
- **Guia E2E:** [E2E_PIPELINE_TEST_GUIDE.md](../guides/E2E_PIPELINE_TEST_GUIDE.md)
- **Relatórios e ajuda externa:** [tests/e2e/reports/E2E_REPORTS_GUIDE.md](../../tests/e2e/reports/E2E_REPORTS_GUIDE.md)

---

## Checklist (execução do plano)

| Item | Descrição | Feito |
|------|-----------|-------|
| Fase 1 | Verificações (endpoints, runtime, payload) | [x] |
| Fase 2.1 | Timeout na chamada Claude (runtime) | [x] |
| Fase 2.2 | max_tokens para spec_intake (runtime) | [x] |
| Fase 3.1 | Payload: `agent` e `task_id` em todos os bodies (test_pipeline_landing.py) | [x] |
| Fase 3.2 | Campo `input`/`inputs` (mantidos ambos; runtime usa ambos) | [x] |
| Fase 3.3 | Endpoints Dev/QA (confirmado: `/invoke/dev`, `/invoke/qa`) | [x] |
| Fase 4.1 | Resumo no conftest (leitura do junit.xml) | [x] |
| Fase 5.1 | Spec path/nome (project/spec/spec_landing_zentriz.txt) | [x] |
| Deploy | `./deploy-docker.sh --host-agents --force-recreate` | [x] |
| Agents | `./start-agents-host.sh` | [x] |
| Testes | Execução E2E e relatórios em tests/e2e/reports/ | [x] |

**Nota:** Na execução dos testes, todas as 7 falhas foram causadas por **crédito Anthropic insuficiente** (HTTP 500 no test_01); as demais falharam em cascata por dependerem de `product_spec`. O plano de correção (timeout, payload, conftest) foi aplicado com sucesso; para ver os testes passando é necessário crédito na API Anthropic.
