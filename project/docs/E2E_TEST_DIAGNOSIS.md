# Diagnóstico Completo — Falhas E2E Pipeline Tests

> **Data**: 2026-02-21  
> **Status**: 7 testes, 0 passaram, 1 falhou (timeout), 6 nem executaram (dependiam do primeiro)

---

## 1. Resumo Executivo

O pipeline E2E **nunca passou do primeiro teste** (`test_01_cto_spec_intake`). A falha é um `httpx.ReadTimeout` após **1200 segundos** (20 minutos). Os relatórios em `reports/` mostram `Total: 0` por um bug no `conftest.py`. O `run_phased.py` tentou auto-corrigir aumentando timeouts, mas **timeout NÃO é a causa raiz** — é apenas o sintoma.

Existem **5 problemas distintos**, classificados por severidade:

| # | Problema | Severidade | Impacto |
|---|----------|------------|---------|
| 1 | Agents service travando/não respondendo na chamada CTO | **CRÍTICA** | Bloqueia 100% dos testes |
| 2 | Payload do teste não bate com o que o agents server espera | **ALTA** | Pode causar o problema #1 |
| 3 | Endpoints dos agentes Dev/QA incorretos no teste | **MÉDIA** | Testes 6+ falhariam mesmo se 1-5 passassem |
| 4 | `conftest.py` com bug no report — sempre mostra 0/0/0 | **BAIXA** | Relatórios inúteis (JUnit XML funciona) |
| 5 | Spec file path aponta para local errado | **MÉDIA** | Pode causar FileNotFoundError |

---

## 2. Problema #1 — CRÍTICO: Agents Service Não Responde (ReadTimeout)

### O que acontece

```
test_01_cto_spec_intake → POST http://127.0.0.1:8000/invoke/cto
→ aguarda 1200 segundos
→ httpx.ReadTimeout
```

O teste envia o request, o agents service **recebe** (senão seria `ConnectError`, não `ReadTimeout`), mas **nunca retorna a resposta**.

### Causas prováveis (verificar na ordem)

#### 2a. O agents server não reconhece o `mode` e trava

O teste envia `mode: "spec_intake_and_normalize"`. O agents service (`server.py`) provavelmente:
- Recebe o body JSON inteiro
- Passa para `runtime.run_agent()` que constrói system prompt + user message
- Chama `client.messages.create()` na API Claude

**Se o server não mapeia o `mode` para um prompt template específico**, ele pode:
- Enviar um prompt genérico/vazio ao Claude → Claude gera resposta enorme → timeout
- Ignorar o mode e processar como CTO genérico → loop interno → nunca retorna
- Falhar silenciosamente sem retornar HTTP response

**COMO VERIFICAR:**
```bash
# 1. Ver logs do agents service durante o teste
# No terminal do start-agents-host.sh, procurar por:
#   - "mode=spec_intake_and_normalize" ou similar
#   - "Calling Claude..." ou "run_agent"
#   - Qualquer traceback ou erro

# 2. Teste manual mínimo (SEM o teste pytest):
curl -X POST http://127.0.0.1:8000/invoke/cto \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "test-manual",
    "mode": "spec_intake_and_normalize",
    "task": "Converter spec",
    "inputs": {"spec_raw": "Landing page simples com hero, sobre nos, contato."},
    "limits": {"max_rounds": 1, "round": 1}
  }' \
  --max-time 120

# Se não retornar em 120s, o problema é no agents server, não no teste.
```

#### 2b. O runtime do agents faz retry infinito na API Claude

Olhar em `applications/orchestrator/agents/runtime.py`:
- Se o `run_agent()` tem retry em exceções da API Claude (rate limit, overloaded, etc.)
- Se o retry NÃO tem limite de tentativas
- Se há um timeout na chamada ao `client.messages.create()`

**COMO VERIFICAR:**
```bash
# Procurar no código do runtime:
grep -rn "retry\|max_retries\|timeout\|max_tokens" applications/orchestrator/agents/runtime.py
grep -rn "client.messages.create" applications/orchestrator/agents/runtime.py
```

**CORREÇÃO:**
```python
# Em runtime.py, garantir que a chamada ao Claude tem timeout:
response = client.messages.create(
    model=CLAUDE_MODEL,
    max_tokens=8000,       # NÃO usar 16000+ para spec_intake
    timeout=120,           # Timeout de 2 minutos na API
    messages=[...],
)
```

#### 2c. `max_tokens` muito alto no system prompt do CTO

Se o CTO agent usa `max_tokens=16000` ou mais, e o prompt pede um documento muito detalhado, Claude pode levar 5-10 minutos gerando. Com retry, são 10-20 minutos.

**COMO VERIFICAR:**
```bash
grep -rn "max_tokens" applications/orchestrator/agents/
```

**CORREÇÃO:** Para `spec_intake_and_normalize`, usar `max_tokens=8000` (suficiente para um PRODUCT_SPEC).

---

## 3. Problema #2 — ALTA: Payload Mismatch

### O que o teste envia vs. o que o server provavelmente espera

O teste **implementado** (`test_pipeline_landing.py`) envia:

```json
{
    "project_id": "e2e-landing-test",
    "mode": "spec_intake_and_normalize",
    "task": "Converter spec TXT para formato PRODUCT_SPEC",
    "inputs": {
        "spec_raw": "<conteúdo da spec>",
        "product_spec": null,
        "constraints": ["spec-driven", "no-invent", "paths-resilient"]
    },
    "input": { ... mesmo conteúdo ... },
    "existing_artifacts": [],
    "limits": {"max_rounds": 3, "round": 1}
}
```

O **guia** (`E2E_PIPELINE_TEST_GUIDE.md`) diz para enviar:

```json
{
    "project_id": "e2e-landing-test",
    "agent": "cto",                         ← campo "agent" presente no guia
    "mode": "spec_intake_and_normalize",
    "task_id": null,                         ← campo "task_id" presente no guia
    "task": "Converter spec TXT para formato PRODUCT_SPEC",
    "inputs": {
        "spec_raw": "<conteúdo da spec>",
        "product_spec": null,
        "constraints": ["spec-driven", "no-invent", "paths-resilient"]
    },
    "existing_artifacts": [],
    "limits": {"max_rounds": 3, "round": 1}
}
```

### Diferenças importantes:

| Campo | Teste implementado | Guia | Impacto |
|-------|-------------------|------|---------|
| `agent` | ausente | `"cto"` | Server pode não saber qual agente invocar |
| `task_id` | ausente | `null` | Pode causar KeyError no server |
| `input` (duplicado) | presente | ausente | Campo extra, improvável causar problema |

**COMO VERIFICAR:**
```bash
# Ver o schema que o server espera:
grep -rn "class.*Request\|class.*Body\|class.*Input" applications/orchestrator/agents/server.py
# Ou:
grep -rn "body\[" applications/orchestrator/agents/server.py
grep -rn "request\." applications/orchestrator/agents/server.py
```

**CORREÇÃO no teste:**
```python
body = {
    "project_id": "e2e-landing-test",
    "agent": "cto",                    # ADICIONAR
    "mode": "spec_intake_and_normalize",
    "task_id": None,                   # ADICIONAR
    "task": "Converter spec TXT para formato PRODUCT_SPEC",
    "inputs": {
        "spec_raw": ctx.spec_raw,
        "product_spec": None,
        "constraints": ["spec-driven", "no-invent", "paths-resilient"],
    },
    "existing_artifacts": [],
    "limits": {"max_rounds": 3, "round": 1},
}
# REMOVER o campo "input" duplicado
```

---

## 4. Problema #3 — MÉDIA: Endpoints Dev/QA Incorretos

O `AGENTS_AND_LLM_FLOW.md` documenta os endpoints reais:

| Agente | Endpoint REAL | Endpoint no TESTE |
|--------|---------------|-------------------|
| CTO | `/invoke/cto` | `/invoke/cto` ✅ |
| Engineer | `/invoke/engineer` | `/invoke/engineer` ✅ |
| PM | `/invoke/pm` | `/invoke/pm` ✅ |
| Dev | **`/invoke/dev-backend`** | `/invoke/dev` ❌ |
| QA | **`/invoke/qa-backend`** | `/invoke/qa` ❌ |

O teste `test_06_dev_qa_loop` chama `call_agent("dev", ...)` que faz `POST /invoke/dev`. Mas o endpoint real é `/invoke/dev-backend`.

**COMO VERIFICAR:**
```bash
# Listar endpoints registrados no server:
grep -rn "invoke\|route\|endpoint" applications/orchestrator/agents/server.py | head -30
# Ou testar:
curl -s http://127.0.0.1:8000/invoke/dev -X POST -H "Content-Type: application/json" -d '{}' --max-time 5
# Se retornar 404, o endpoint correto é /invoke/dev-backend
```

**CORREÇÃO no teste:**
```python
# Mapear nomes de agentes para endpoints reais
AGENT_ENDPOINTS = {
    "cto": "cto",
    "engineer": "engineer",
    "pm": "pm",
    "dev": "dev-backend",       # endpoint real
    "qa": "qa-backend",         # endpoint real
    "monitor": "monitor",
    "devops": "devops-docker",
}

async def call_agent(agent_name: str, body: dict) -> dict:
    endpoint = AGENT_ENDPOINTS.get(agent_name, agent_name)
    url = "%s/invoke/%s" % (AGENTS_URL.rstrip("/"), endpoint)
    # ...
```

---

## 5. Problema #4 — BAIXA: conftest.py Report Bug

O `pytest_sessionfinish` tenta acessar `session.session.results` que não existe no pytest:

```python
# conftest.py, linha 31-39
if hasattr(session, "session") and hasattr(session.session, "results"):
    for r in session.session.results.values():
        # ...
```

`session` já É o `Session` object no pytest. `session.session` não existe. Por isso todos os reports mostram `Total: 0 | Passed: 0 | Failed: 0 | Skipped: 0`.

**CORREÇÃO:**
```python
def pytest_sessionfinish(session, exitstatus):
    try:
        from pathlib import Path
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = Path(REPORTS_DIR) / ("summary_%s.txt" % ts)

        # Usar TestReport da session corretamente
        stats = session.config._store.get(pytest.StashKey[dict](), {})
        # Ou, mais simples: ler do JUnit XML que já foi gerado
        
        # Forma mais confiável: contar via exitstatus
        total = session.testscollected
        failed = session.testsfailed
        passed = total - failed  # aproximação
        
        with open(path, "w", encoding="utf-8") as f:
            f.write("E2E Pipeline Landing — Resumo\n")
            f.write("=" * 40 + "\n")
            f.write("Data: %s\n" % datetime.now().isoformat())
            f.write("Exit status: %s\n" % exitstatus)
            f.write("Total: %d | Failed: %d\n" % (total, failed))
            f.write("JUnit: %s\n" % os.path.join(REPORTS_DIR, "junit.xml"))
    except Exception:
        pass
```

---

## 6. Problema #5 — MÉDIA: Spec File Path

O teste procura a spec em:
```python
SPEC_FILE = _repo_root / "project" / "spec" / "spec_landing_zentriz.txt"
```

Mas o nome do arquivo original é `spec_landing_zentriz.txt` e o guia diz para salvar como `spec-landing-zentriz.txt` (com hífens). Se o arquivo existe com o nome correto no path indicado, não há problema. Mas se não existe, dá `FileNotFoundError` antes mesmo do HTTP call.

**COMO VERIFICAR:**
```bash
ls -la project/spec/spec_landing_zentriz.txt
ls -la project/spec/spec-landing-zentriz.txt
ls -la tests/e2e/spec_landing_zentriz.txt
```

O fato de o teste **chegar** ao `ReadTimeout` (e não `FileNotFoundError`) indica que o arquivo existe. Mas vale confirmar.

---

## 7. Plano de Ação (Ordem de Execução)

### Passo 1: Diagnóstico do agents server (5 minutos)

```bash
# Terminal 1: Subir agents com log verbose
SHOW_TRACEBACK=true ./start-agents-host.sh

# Terminal 2: Teste manual simples
curl -v -X POST http://127.0.0.1:8000/invoke/cto \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "diag-test",
    "agent": "cto",
    "mode": "spec_intake_and_normalize",
    "task_id": null,
    "task": "Converter spec",
    "inputs": {"spec_raw": "Landing page simples: hero, sobre nos, servicos, contato, footer. Estatica, sem backend."},
    "existing_artifacts": [],
    "limits": {"max_rounds": 1, "round": 1}
  }' \
  --max-time 180

# OBSERVAR no Terminal 1:
# - O server recebeu o request?
# - Chamou o Claude?
# - Quanto tempo demorou?
# - Houve erro/traceback?
```

### Passo 2: Verificar runtime.py (2 minutos)

```bash
# Checar timeouts e max_tokens no runtime
cat applications/orchestrator/agents/runtime.py | grep -A5 "messages.create\|max_tokens\|timeout\|retry"
```

Se `max_tokens > 12000` ou não há timeout na chamada Claude, corrija:
```python
# runtime.py
response = client.messages.create(
    model=CLAUDE_MODEL,
    max_tokens=8000,
    timeout=180,        # 3 minutos máximo por chamada Claude
    messages=messages,
)
```

### Passo 3: Verificar endpoints (1 minuto)

```bash
# Listar rotas disponíveis
curl -s http://127.0.0.1:8000/docs  # Se FastAPI, mostra Swagger
# Ou:
curl -s http://127.0.0.1:8000/invoke/dev -X POST -d '{}' -H "Content-Type: application/json" --max-time 5
curl -s http://127.0.0.1:8000/invoke/dev-backend -X POST -d '{}' -H "Content-Type: application/json" --max-time 5
```

### Passo 4: Corrigir o teste (com base nas descobertas)

Após os passos 1-3, as correções necessárias ficarão claras. As mais prováveis são:

1. Adicionar `timeout` no `runtime.py` (se ausente)
2. Ajustar `max_tokens` para valores razoáveis por mode
3. Corrigir payload do teste (adicionar `agent`, `task_id`, remover `input` duplicado)
4. Mapear endpoints corretos (`dev-backend`, `qa-backend`)
5. Corrigir `conftest.py` report

### Passo 5: Re-executar faseado

```bash
# Primeiro, só o test_01:
pytest tests/e2e/test_pipeline_landing.py -v -s -k "test_01" --timeout=300

# Se passar, testar até PM:
pytest tests/e2e/test_pipeline_landing.py -v -s -k "not test_06 and not test_07" --timeout=600

# Se passar, pipeline completo:
pytest tests/e2e/test_pipeline_landing.py -v -s --timeout=900
```

---

## 8. O que NÃO fazer

- **NÃO aumentar mais os timeouts** — 900s já é excessivo. Se a chamada Claude leva mais de 3 minutos, o problema está no prompt/max_tokens/retry, não no timeout do cliente HTTP.
- **NÃO duplicar campos no payload** (`input` + `inputs`) — isso confunde o server e pode causar comportamento indefinido.
- **NÃO rodar `run_phased.py` de novo** — ele só aumenta timeouts e não resolve nada. Use `pytest` diretamente após corrigir os problemas reais.

---

## 9. Hipótese Mais Provável

Com base nos dados:

> O agents server recebe o request, chama o Claude via `runtime.run_agent()`, mas o runtime tem **retry sem limite** ou **max_tokens=16000+** no system prompt do CTO. O Claude gera uma resposta enorme (spec completa + análise), que leva 5+ minutos. Se houver retry por rate limit (HTTP 429 da Anthropic), pode multiplicar por 2-3x. Resultado: 10-20 minutos até timeout.

A confirmação está nos **logs do agents service** durante o teste. Se você ver múltiplas linhas de "Calling Claude..." ou "Retry...", essa é a causa.
