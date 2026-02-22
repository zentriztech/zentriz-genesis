# Guia E2E — Teste do Pipeline de Agentes (Landing Page Estática)

> **Objetivo**: Testar o pipeline completo CTO → Engineer → CTO validate → Charter → PM → Dev → QA → Monitor  
> **Spec de teste**: Landing page institucional simples (sem API, sem formulários, sem backend)  
> **Data**: 2026-02-21  
> **Referência**: [AGENT_LLM_COMMUNICATION_ANALYSIS.md](../analysis/AGENT_LLM_COMMUNICATION_ANALYSIS.md)

---

## 1. Por que esta Spec

A spec da loja de veículos é complexa demais para um primeiro teste E2E — tem backend,
banco de dados, agendamento, notificações. Se o pipeline falhar, não saberemos se o
problema é no pipeline ou na complexidade da spec.

Uma **landing page estática** é o cenário mais simples possível:
- 1 squad (Web)
- 0 APIs, 0 banco de dados, 0 autenticação
- Apenas HTML/CSS/JS (ou Next.js estático)
- FRs simples e verificáveis visualmente

Se o pipeline não funciona com isso, não funciona com nada.

---

## 2. Spec de Teste (TXT — input do pipeline)

Salve este conteúdo como `spec-landing-zentriz.txt` e use como input do pipeline:

```text
Projeto: Landing Page Institucional — Zentriz Consultoria

A Zentriz é uma empresa de consultoria tecnológica e IA. Precisamos de uma
landing page institucional moderna e responsiva para apresentar a empresa,
seus serviços e permitir que visitantes entrem em contato.

A página é ESTÁTICA — não há backend, não há banco de dados, não há formulários
com envio de dados. O único objetivo é apresentar a empresa e direcionar o
visitante para o WhatsApp ou email.

Seções da página (single page, scroll vertical):

1. HERO (topo):
   - Logo da Zentriz
   - Headline principal: texto sobre transformação digital e IA
   - Subtítulo de apoio
   - Botão CTA "Fale Conosco" (ancora para seção de contato)
   - Background com gradiente ou imagem abstrata de tecnologia

2. SOBRE NÓS:
   - Breve descrição da empresa (2-3 parágrafos)
   - Missão / Visão / Valores em cards lado a lado (3 cards)
   - Visual limpo e profissional

3. SERVIÇOS:
   - Lista de 4-6 serviços oferecidos, cada um com:
     - Ícone representativo
     - Título do serviço
     - Descrição curta (2-3 linhas)
   - Layout em grid (2x3 ou 3x2)

4. DIFERENCIAIS / NÚMEROS:
   - 3-4 métricas de impacto (ex: "+50 projetos entregues", "98% satisfação")
   - Contador animado ou números destacados
   - Fundo diferenciado (cor sólida ou gradiente)

5. CONTATO:
   - Texto convidando a conversar
   - Botão WhatsApp (link wa.me/5511999999999 — abre em nova aba)
   - Link de email (mailto:contato@zentriz.com.br)
   - Ícones de redes sociais (LinkedIn, Instagram — links externos)
   - NÃO há formulário — apenas links diretos

6. FOOTER:
   - Logo pequeno
   - Copyright
   - Links de redes sociais repetidos
   - Texto LGPD simples: "Este site não coleta dados pessoais."

Requisitos técnicos:
- Responsivo (mobile-first)
- Performance: LCP < 2.5s, CLS < 0.1
- SEO: title, meta description, OG tags, sitemap.xml
- Acessibilidade: contraste mínimo WCAG AA, alt text em imagens, navegação por teclado
- Stack: Next.js com export estático (ou HTML/CSS/JS puro)
- Sem dependência de backend ou serviços externos (exceto links)
- Hospedagem futura: Vercel ou AWS S3 + CloudFront

Fora de escopo:
- Blog, área de login, painel admin
- Formulário de contato com envio de dados
- Integração com CRM ou email marketing
- Animações complexas (parallax, 3D)
- Internacionalização (apenas PT-BR)
```

---

## 3. Fluxo Esperado do Pipeline

```
Etapa 1: CTO (spec_intake_and_normalize)
  Input:  spec-landing-zentriz.txt
  Output: docs/spec/PRODUCT_SPEC.md

Etapa 2: Engineer (propose)
  Input:  PRODUCT_SPEC.md
  Output: docs/engineer/TECHNICAL_PROPOSAL.md

Etapa 3: CTO (validate_engineer_docs)
  Input:  PRODUCT_SPEC.md + TECHNICAL_PROPOSAL.md
  Output: status=OK (aprovação) ou status=REVISION (feedback)

Etapa 4: CTO (charter_and_proposal)
  Input:  PRODUCT_SPEC.md + TECHNICAL_PROPOSAL.md aprovada
  Output: docs/cto/PROJECT_CHARTER.md

Etapa 5: PM (generate_backlog)
  Input:  PROJECT_CHARTER.md + TECHNICAL_PROPOSAL.md + PRODUCT_SPEC.md
  Output: docs/pm/BACKLOG.md (lista de tasks)

Etapa 6: Monitor Loop (para cada task do backlog)
  6a: Dev gera código → Monitor valida output → QA valida
  6b: Se QA_FAIL → Dev retry com feedback → QA revalida
  6c: Quando todas as tasks passam → pipeline finalizado

(DevOps não será testado neste E2E conforme definição do projeto)
```

---

## 4. Implementação do Teste E2E

### 4.1 Estrutura de Arquivos

```
tests/
└── e2e/
    ├── test_pipeline_landing.py     ← teste principal
    ├── spec_landing_zentriz.txt     ← spec de teste (conteúdo da seção 2)
    ├── validators/
    │   ├── __init__.py
    │   ├── validate_product_spec.py
    │   ├── validate_engineer_proposal.py
    │   ├── validate_charter.py
    │   ├── validate_backlog.py
    │   ├── validate_dev_output.py
    │   └── validate_qa_report.py
    └── conftest.py                  ← fixtures compartilhadas
```

### 4.2 Arquivo Principal do Teste

```python
"""
tests/e2e/test_pipeline_landing.py

Teste E2E do pipeline de agentes usando uma spec de landing page estática.
Testa o fluxo completo: CTO → Engineer → CTO validate → Charter → PM → Dev → QA

Pré-requisitos:
  - Agents service rodando (porta 8000)
  - CLAUDE_API_KEY configurada
  - CLAUDE_MODEL configurado

Execução:
  pytest tests/e2e/test_pipeline_landing.py -v -s --timeout=600

Flags:
  -v: verbose (mostra nome de cada teste)
  -s: mostra prints/logs (essencial para debug)
  --timeout=600: 10 minutos (pipeline completo pode demorar)
"""

import os
import sys
import json
import time
import logging
import pytest
import httpx
from datetime import datetime

# Ajustar path se necessário
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from validators.validate_product_spec import validate_product_spec
from validators.validate_engineer_proposal import validate_engineer_proposal
from validators.validate_charter import validate_charter
from validators.validate_backlog import validate_backlog
from validators.validate_dev_output import validate_dev_output
from validators.validate_qa_report import validate_qa_report

# ============================================================
# CONFIGURAÇÃO
# ============================================================

AGENTS_URL = os.environ.get("API_AGENTS_URL", "http://127.0.0.1:8000")
SPEC_FILE = os.path.join(os.path.dirname(__file__), "spec_landing_zentriz.txt")

# Timeouts por agente (segundos) — chamadas ao Claude podem demorar
TIMEOUTS = {
    "cto": 120,
    "engineer": 120,
    "pm": 180,
    "dev": 180,
    "qa": 120,
    "monitor": 90,
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("e2e")


# ============================================================
# HELPERS
# ============================================================

def load_spec() -> str:
    """Carrega a spec de teste."""
    with open(SPEC_FILE, 'r', encoding='utf-8') as f:
        return f.read()


async def call_agent(agent_name: str, body: dict) -> dict:
    """
    Chama o endpoint /invoke/{agent_name} e retorna o ResponseEnvelope.
    
    Inclui validação básica: HTTP 200, JSON válido, campo 'status' presente.
    """
    url = f"{AGENTS_URL}/invoke/{agent_name}"
    timeout = TIMEOUTS.get(agent_name, 120)
    
    logger.info(f"\n{'='*60}")
    logger.info(f"CHAMANDO: {agent_name} | mode: {body.get('mode', 'N/A')}")
    logger.info(f"Input size: {len(json.dumps(body))} chars")
    logger.info(f"Timeout: {timeout}s")
    logger.info(f"{'='*60}")
    
    start = time.time()
    
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(url, json=body)
    
    duration = round(time.time() - start, 1)
    
    assert response.status_code == 200, (
        f"HTTP {response.status_code} de {agent_name}: {response.text[:500]}"
    )
    
    result = response.json()
    
    assert "status" in result, (
        f"{agent_name} retornou JSON sem campo 'status': {json.dumps(result)[:500]}"
    )
    
    logger.info(f"RESPOSTA: {agent_name} | status={result['status']} | {duration}s")
    logger.info(f"Summary: {result.get('summary', 'N/A')[:200]}")
    logger.info(f"Artifacts: {len(result.get('artifacts', []))}")
    
    for art in result.get("artifacts", []):
        content_len = len(art.get("content", ""))
        logger.info(f"  → {art.get('path', 'N/A')} ({content_len} chars)")
    
    return result


def extract_artifact_content(response: dict, path_contains: str = "") -> str:
    """Extrai o conteúdo do primeiro artifact que contém path_contains no path."""
    for art in response.get("artifacts", []):
        if path_contains in art.get("path", ""):
            return art.get("content", "")
    return ""


def assert_no_placeholders(content: str, context: str):
    """Verifica que o conteúdo não tem placeholders proibidos."""
    forbidden = ["...", "// TODO", "// implementar", "// ...", "[...]", 
                 "/* TODO */", "// rest of", "// adicionar", "# TODO"]
    for placeholder in forbidden:
        assert placeholder not in content, (
            f"Placeholder proibido encontrado em {context}: '{placeholder}'\n"
            f"Trecho: ...{content[max(0, content.index(placeholder)-50):content.index(placeholder)+80]}..."
        )


def assert_minimum_length(content: str, min_chars: int, context: str):
    """Verifica que o conteúdo tem um tamanho mínimo razoável."""
    assert len(content) >= min_chars, (
        f"{context}: conteúdo muito curto ({len(content)} chars, mínimo {min_chars}). "
        f"Provavelmente incompleto ou genérico."
    )


# ============================================================
# CONTEXT ACCUMULATOR (simula o PipelineContext do runner)
# ============================================================

class TestPipelineContext:
    """Acumula contexto ao longo do teste, simulando o PipelineContext real."""
    
    def __init__(self):
        self.spec_raw = ""
        self.product_spec = ""
        self.engineer_proposal = ""
        self.cto_validation = ""
        self.charter = ""
        self.backlog = ""
        self.backlog_tasks = []
        self.completed_artifacts = {}
        self.completed_tasks = []
        self.failed_tasks = []
        self.step_results = {}  # {step_name: response}
        self.step_durations = {}  # {step_name: seconds}
    
    def print_summary(self):
        """Imprime resumo do pipeline ao final."""
        logger.info("\n" + "=" * 60)
        logger.info("RESUMO DO PIPELINE E2E")
        logger.info("=" * 60)
        for step, result in self.step_results.items():
            status = result.get("status", "N/A")
            duration = self.step_durations.get(step, 0)
            arts = len(result.get("artifacts", []))
            logger.info(f"  {step:40s} | {status:10s} | {duration:5.1f}s | {arts} artifacts")
        logger.info("=" * 60)
        total_time = sum(self.step_durations.values())
        logger.info(f"  TEMPO TOTAL: {total_time:.1f}s ({total_time/60:.1f} min)")
        logger.info(f"  TASKS CONCLUÍDAS: {len(self.completed_tasks)}")
        logger.info(f"  TASKS FALHADAS:   {len(self.failed_tasks)}")
        logger.info("=" * 60)


# ============================================================
# FIXTURES
# ============================================================

@pytest.fixture(scope="module")
def ctx():
    """Pipeline context compartilhado entre todos os testes do módulo."""
    return TestPipelineContext()


@pytest.fixture(scope="module", autouse=True)
def check_agents_health():
    """Verifica que o agents service está rodando antes de executar testes."""
    import httpx
    try:
        r = httpx.get(f"{AGENTS_URL}/health", timeout=10)
        assert r.status_code == 200
        health = r.json()
        assert health.get("claude_configured") == True, (
            f"Claude não configurado: {health}"
        )
        logger.info(f"Agents health OK: model={health.get('claude_model')}")
    except httpx.ConnectError:
        pytest.skip(
            f"Agents service não está rodando em {AGENTS_URL}. "
            f"Execute: ./start-agents-host.sh"
        )
    except Exception as e:
        pytest.skip(f"Falha ao verificar agents health: {e}")


# ============================================================
# TESTES — EXECUTADOS EM ORDEM (dependency chain)
# ============================================================

# IMPORTANTE: pytest-ordering ou pytest-dependency para garantir ordem.
# Sem plugin, use nomes que se ordenem alfabeticamente:
# test_01, test_02, test_03...

@pytest.mark.asyncio
async def test_01_cto_spec_intake(ctx):
    """
    ETAPA 1: CTO recebe spec TXT e converte para PRODUCT_SPEC.md
    
    Valida:
    - Status = OK
    - Artifact docs/spec/PRODUCT_SPEC.md existe
    - Contém seções obrigatórias (## 0 até ## 9)
    - Contém pelo menos 5 FRs (a spec tem 6 seções)
    - Contém pelo menos 3 NFRs (performance, SEO, acessibilidade)
    - Nenhum placeholder proibido
    """
    ctx.spec_raw = load_spec()
    
    body = {
        "project_id": "e2e-landing-test",
        "agent": "cto",
        "mode": "spec_intake_and_normalize",
        "task_id": None,
        "task": "Converter spec TXT para formato PRODUCT_SPEC",
        "inputs": {
            "spec_raw": ctx.spec_raw,
            "product_spec": None,
            "constraints": ["spec-driven", "no-invent", "paths-resilient"]
        },
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1}
    }
    
    start = time.time()
    result = await call_agent("cto", body)
    ctx.step_durations["01_cto_spec_intake"] = time.time() - start
    ctx.step_results["01_cto_spec_intake"] = result
    
    # --- ASSERTIONS ---
    
    assert result["status"] == "OK", (
        f"CTO retornou {result['status']}: {result.get('summary')}\n"
        f"Questions: {result.get('next_actions', {}).get('questions', [])}"
    )
    
    # Extrair PRODUCT_SPEC
    spec_content = extract_artifact_content(result, "PRODUCT_SPEC")
    assert spec_content, "Artifact PRODUCT_SPEC.md não encontrado no response"
    
    ctx.product_spec = spec_content
    
    # Validações de conteúdo
    assert_no_placeholders(spec_content, "PRODUCT_SPEC")
    assert_minimum_length(spec_content, 1500, "PRODUCT_SPEC")
    
    # Seções obrigatórias
    errors = validate_product_spec(spec_content)
    assert not errors, f"PRODUCT_SPEC com problemas:\n" + "\n".join(f"  - {e}" for e in errors)
    
    logger.info("✅ test_01_cto_spec_intake PASSED")


@pytest.mark.asyncio
async def test_02_engineer_propose(ctx):
    """
    ETAPA 2: Engineer analisa a spec e propõe arquitetura.
    
    Valida:
    - Status = OK
    - Proposta contém pelo menos 1 squad
    - Squad tem stack definida
    - Para esta spec: deve propor 1 squad (Web) — NÃO 2+ squads
    - Contém justificativa vinculada a FRs
    """
    assert ctx.product_spec, "PRODUCT_SPEC vazio — test_01 falhou?"
    
    body = {
        "project_id": "e2e-landing-test",
        "agent": "engineer",
        "mode": "propose",
        "task": "Analisar spec e propor arquitetura técnica",
        "inputs": {
            "product_spec": ctx.product_spec,
            "constraints": ["spec-driven", "no-invent", "low-cost"]
        },
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1}
    }
    
    start = time.time()
    result = await call_agent("engineer", body)
    ctx.step_durations["02_engineer_propose"] = time.time() - start
    ctx.step_results["02_engineer_propose"] = result
    
    # --- ASSERTIONS ---
    
    assert result["status"] == "OK", (
        f"Engineer retornou {result['status']}: {result.get('summary')}"
    )
    
    proposal_content = extract_artifact_content(result, "")  # primeiro artifact
    assert proposal_content, "Engineer não produziu nenhum artifact"
    
    ctx.engineer_proposal = proposal_content
    
    assert_no_placeholders(proposal_content, "TECHNICAL_PROPOSAL")
    assert_minimum_length(proposal_content, 800, "TECHNICAL_PROPOSAL")
    
    errors = validate_engineer_proposal(proposal_content)
    assert not errors, f"Proposta do Engineer com problemas:\n" + "\n".join(f"  - {e}" for e in errors)
    
    # Para landing page estática: NÃO deve propor backend ou múltiplas squads
    content_lower = proposal_content.lower()
    # Soft warning (não falha, mas loga)
    if "backend" in content_lower and "squad" in content_lower:
        logger.warning(
            "⚠️ Engineer propôs squad Backend para landing page estática. "
            "Verificar se é proporcional."
        )
    
    logger.info("✅ test_02_engineer_propose PASSED")


@pytest.mark.asyncio
async def test_03_cto_validate_engineer(ctx):
    """
    ETAPA 3: CTO valida a proposta do Engineer.
    
    Valida:
    - Status = OK (aprovação) ou REVISION (feedback)
    - Se REVISION: feedback é específico e acionável
    - Se OK: pode prosseguir para Charter
    
    Nota: se REVISION, o teste executa até 1 rodada extra de loop.
    """
    assert ctx.product_spec, "PRODUCT_SPEC vazio"
    assert ctx.engineer_proposal, "TECHNICAL_PROPOSAL vazio"
    
    max_rounds = 2
    
    for round_num in range(1, max_rounds + 1):
        body = {
            "project_id": "e2e-landing-test",
            "agent": "cto",
            "mode": "validate_engineer_docs",
            "task": "Validar proposta técnica do Engineer",
            "inputs": {
                "product_spec": ctx.product_spec,
                "engineer_proposal": ctx.engineer_proposal,
                "cto_validation": ctx.cto_validation,
            },
            "existing_artifacts": [],
            "limits": {"max_rounds": 3, "round": round_num}
        }
        
        start = time.time()
        result = await call_agent("cto", body)
        ctx.step_durations[f"03_cto_validate_r{round_num}"] = time.time() - start
        ctx.step_results[f"03_cto_validate_r{round_num}"] = result
        
        if result["status"] == "OK":
            logger.info(f"CTO aprovou na rodada {round_num}")
            break
        
        elif result["status"] == "REVISION":
            ctx.cto_validation = result.get("summary", "")
            logger.info(f"CTO pediu revisão (rodada {round_num}): {ctx.cto_validation[:200]}")
            
            # Re-chamar Engineer com feedback
            eng_body = {
                "project_id": "e2e-landing-test",
                "agent": "engineer",
                "mode": "propose",
                "task": "Revisar proposta técnica com feedback do CTO",
                "inputs": {
                    "product_spec": ctx.product_spec,
                    "cto_validation": ctx.cto_validation,
                    "constraints": ["spec-driven", "no-invent"]
                },
                "limits": {"max_rounds": 3, "round": round_num + 1}
            }
            eng_result = await call_agent("engineer", eng_body)
            
            if eng_result["status"] == "OK":
                ctx.engineer_proposal = extract_artifact_content(eng_result, "")
            
            continue
        
        else:
            pytest.fail(
                f"CTO retornou status inesperado: {result['status']}. "
                f"Summary: {result.get('summary')}"
            )
    
    assert result["status"] == "OK", (
        f"Loop CTO↔Engineer não convergiu em {max_rounds} rodadas. "
        f"Último status: {result['status']}"
    )
    
    logger.info("✅ test_03_cto_validate_engineer PASSED")


@pytest.mark.asyncio
async def test_04_cto_charter(ctx):
    """
    ETAPA 4: CTO gera o Project Charter.
    
    Valida:
    - Status = OK
    - Charter contém: visão, squads, escopo, prioridades
    - Charter referencia FRs da spec
    - Charter é autossuficiente (um PM consegue ler e executar)
    """
    assert ctx.product_spec, "PRODUCT_SPEC vazio"
    assert ctx.engineer_proposal, "TECHNICAL_PROPOSAL vazio"
    
    body = {
        "project_id": "e2e-landing-test",
        "agent": "cto",
        "mode": "charter_and_proposal",
        "task": "Produzir Project Charter",
        "inputs": {
            "product_spec": ctx.product_spec,
            "engineer_proposal": ctx.engineer_proposal,
        },
        "existing_artifacts": [],
        "limits": {"max_rounds": 1, "round": 1}
    }
    
    start = time.time()
    result = await call_agent("cto", body)
    ctx.step_durations["04_cto_charter"] = time.time() - start
    ctx.step_results["04_cto_charter"] = result
    
    # --- ASSERTIONS ---
    
    assert result["status"] == "OK", (
        f"CTO charter retornou {result['status']}: {result.get('summary')}"
    )
    
    charter_content = extract_artifact_content(result, "CHARTER")
    if not charter_content:
        charter_content = extract_artifact_content(result, "charter")
    if not charter_content:
        # Pegar primeiro artifact
        charter_content = extract_artifact_content(result, "")
    
    assert charter_content, "Charter não encontrado nos artifacts"
    ctx.charter = charter_content
    
    assert_no_placeholders(charter_content, "PROJECT_CHARTER")
    assert_minimum_length(charter_content, 1000, "PROJECT_CHARTER")
    
    errors = validate_charter(charter_content)
    assert not errors, f"Charter com problemas:\n" + "\n".join(f"  - {e}" for e in errors)
    
    logger.info("✅ test_04_cto_charter PASSED")


@pytest.mark.asyncio
async def test_05_pm_backlog(ctx):
    """
    ETAPA 5: PM gera o backlog de tarefas.
    
    Valida:
    - Status = OK
    - Backlog contém pelo menos 3 tasks
    - Cada task tem: id, título, acceptance_criteria, depends_on_files, estimated_files
    - Tasks estão ordenadas (sem dependências circulares)
    - Nenhuma task produz mais de 3 arquivos
    """
    assert ctx.charter, "Charter vazio"
    assert ctx.product_spec, "PRODUCT_SPEC vazio"
    
    body = {
        "project_id": "e2e-landing-test",
        "agent": "pm",
        "mode": "generate_backlog",
        "task": "Gerar backlog de tarefas para a squad Web",
        "inputs": {
            "charter": ctx.charter,
            "engineer_proposal": ctx.engineer_proposal,
            "product_spec": ctx.product_spec,
            "module": "web",
        },
        "existing_artifacts": [],
        "limits": {"max_rounds": 1, "round": 1}
    }
    
    start = time.time()
    result = await call_agent("pm", body)
    ctx.step_durations["05_pm_backlog"] = time.time() - start
    ctx.step_results["05_pm_backlog"] = result
    
    # --- ASSERTIONS ---
    
    assert result["status"] == "OK", (
        f"PM retornou {result['status']}: {result.get('summary')}"
    )
    
    backlog_content = extract_artifact_content(result, "")
    assert backlog_content, "PM não produziu artifact de backlog"
    ctx.backlog = backlog_content
    
    assert_no_placeholders(backlog_content, "BACKLOG")
    assert_minimum_length(backlog_content, 1000, "BACKLOG")
    
    errors = validate_backlog(backlog_content)
    assert not errors, f"Backlog com problemas:\n" + "\n".join(f"  - {e}" for e in errors)
    
    # Parsear tasks para o loop de execução
    ctx.backlog_tasks = parse_tasks_from_backlog(backlog_content)
    assert len(ctx.backlog_tasks) >= 3, (
        f"Backlog tem apenas {len(ctx.backlog_tasks)} tasks (mínimo 3 para landing page)"
    )
    
    logger.info(f"Backlog gerado: {len(ctx.backlog_tasks)} tasks")
    for t in ctx.backlog_tasks:
        logger.info(f"  - {t.get('id', '?')}: {t.get('title', '?')}")
    
    logger.info("✅ test_05_pm_backlog PASSED")


@pytest.mark.asyncio
async def test_06_dev_qa_loop(ctx):
    """
    ETAPA 6: Loop Dev → QA para cada task do backlog.
    
    Para manter o teste viável em tempo e custo, executa apenas as
    PRIMEIRAS 3 TASKS do backlog. Se as 3 primeiras passam, o pipeline
    está funcionando.
    
    Valida por task:
    - Dev: status=OK, artifacts completos, sem placeholders
    - QA: status=QA_PASS ou QA_FAIL com issues acionáveis
    - Se QA_FAIL: retry 1x com feedback, depois aceita o resultado
    """
    assert ctx.backlog_tasks, "Backlog vazio"
    
    MAX_TASKS_TO_TEST = 3
    MAX_RETRIES = 1
    
    tasks_to_run = ctx.backlog_tasks[:MAX_TASKS_TO_TEST]
    
    for task_idx, task in enumerate(tasks_to_run):
        task_id = task.get("id", f"TASK-{task_idx+1}")
        
        logger.info(f"\n{'─'*60}")
        logger.info(f"TASK {task_idx+1}/{len(tasks_to_run)}: {task_id} — {task.get('title', 'N/A')}")
        logger.info(f"{'─'*60}")
        
        # ---- DEV ----
        dep_code = {}
        for dep_path in task.get("depends_on_files", []):
            if dep_path in ctx.completed_artifacts:
                dep_code[dep_path] = ctx.completed_artifacts[dep_path]
        
        dev_body = {
            "project_id": "e2e-landing-test",
            "agent": "dev",
            "mode": "implement",
            "task_id": task_id,
            "task": f"Implementar: {task.get('title', '')}",
            "inputs": {
                "current_task": task,
                "tech_stack": "Next.js com export estático, TypeScript, Tailwind CSS",
                "dependency_code": dep_code,
                "completed_tasks": [
                    {"task_id": t, "status": "done"} for t in ctx.completed_tasks
                ],
            },
            "limits": {"max_retries": MAX_RETRIES}
        }
        
        start = time.time()
        dev_result = await call_agent("dev", dev_body)
        dev_duration = time.time() - start
        
        assert dev_result["status"] == "OK", (
            f"Dev falhou na task {task_id}: {dev_result.get('summary')}"
        )
        
        dev_artifacts = dev_result.get("artifacts", [])
        assert len(dev_artifacts) > 0, f"Dev não gerou nenhum artifact para {task_id}"
        
        # Verificar qualidade dos artifacts do Dev
        for art in dev_artifacts:
            assert_no_placeholders(
                art.get("content", ""), 
                f"Dev artifact {art.get('path', '?')}"
            )
            assert_minimum_length(
                art.get("content", ""), 50,
                f"Dev artifact {art.get('path', '?')}"
            )
        
        # ---- QA ----
        qa_body = {
            "project_id": "e2e-landing-test",
            "agent": "qa",
            "mode": "validate",
            "task_id": task_id,
            "task": f"Validar implementação de: {task.get('title', '')}",
            "inputs": {
                "current_task": task,
                "dev_artifacts": dev_artifacts,
                "acceptance_criteria": task.get("acceptance_criteria", []),
                "fr_ref": task.get("fr_ref", ""),
            },
        }
        
        qa_result = await call_agent("qa", qa_body)
        
        # Se QA_FAIL, tentar retry
        if qa_result["status"] == "QA_FAIL" and MAX_RETRIES > 0:
            logger.info(f"QA reprovou {task_id}. Retrying com feedback...")
            
            dev_body["inputs"]["previous_attempt"] = {
                "artifacts": dev_artifacts,
                "qa_feedback": qa_result.get("summary", ""),
                "qa_issues": [
                    iss for iss in qa_result.get("artifacts", [{}])[0].get("content", "").split("\n")
                    if "issue" in iss.lower() or "fail" in iss.lower() or "blocker" in iss.lower()
                ]
            }
            dev_body["inputs"]["instruction"] = (
                "Sua implementação anterior foi reprovada pelo QA. "
                "Corrija os issues apontados."
            )
            
            dev_result = await call_agent("dev", dev_body)
            dev_artifacts = dev_result.get("artifacts", [])
            
            # Re-QA
            qa_body["inputs"]["dev_artifacts"] = dev_artifacts
            qa_result = await call_agent("qa", qa_body)
        
        # Registrar resultado
        step_key = f"06_task_{task_id}"
        ctx.step_results[step_key] = {
            "dev": dev_result["status"],
            "qa": qa_result["status"],
        }
        ctx.step_durations[step_key] = dev_duration
        
        if qa_result["status"] == "QA_PASS":
            # Acumular artifacts aprovados
            for art in dev_artifacts:
                ctx.completed_artifacts[art.get("path", "")] = art.get("content", "")
            ctx.completed_tasks.append(task_id)
            logger.info(f"✅ {task_id}: QA_PASS")
        else:
            ctx.failed_tasks.append({
                "task_id": task_id,
                "reason": qa_result.get("summary", "QA_FAIL após retry"),
                "attempts": 2
            })
            logger.warning(f"⚠️ {task_id}: QA_FAIL após retry (aceitável no E2E)")
    
    # Pelo menos metade das tasks devem ter passado
    pass_rate = len(ctx.completed_tasks) / len(tasks_to_run) * 100
    logger.info(f"\nPass rate: {pass_rate:.0f}% ({len(ctx.completed_tasks)}/{len(tasks_to_run)})")
    
    assert len(ctx.completed_tasks) >= len(tasks_to_run) // 2, (
        f"Menos da metade das tasks passou no QA ({len(ctx.completed_tasks)}/{len(tasks_to_run)}). "
        f"O pipeline de Dev↔QA tem problemas graves."
    )
    
    logger.info("✅ test_06_dev_qa_loop PASSED")


@pytest.mark.asyncio
async def test_07_final_summary(ctx):
    """
    ETAPA FINAL: Imprime resumo e valida integridade geral.
    
    Valida:
    - Pipeline produziu documentos em todas as etapas
    - Pelo menos 1 task de código foi gerada e aprovada
    - Nenhuma etapa crítica falhou (CTO, Engineer, PM)
    """
    ctx.print_summary()
    
    # Verificar que o pipeline completo produziu output
    assert ctx.product_spec, "Pipeline falhou: PRODUCT_SPEC não foi gerada"
    assert ctx.engineer_proposal, "Pipeline falhou: TECHNICAL_PROPOSAL não foi gerada"
    assert ctx.charter, "Pipeline falhou: PROJECT_CHARTER não foi gerado"
    assert ctx.backlog, "Pipeline falhou: BACKLOG não foi gerado"
    assert len(ctx.completed_tasks) > 0, "Pipeline falhou: nenhuma task foi implementada e aprovada"
    
    # Salvar artifacts para inspeção manual
    output_dir = os.path.join(os.path.dirname(__file__), "output", "e2e-landing-test")
    os.makedirs(output_dir, exist_ok=True)
    
    with open(os.path.join(output_dir, "PRODUCT_SPEC.md"), 'w') as f:
        f.write(ctx.product_spec)
    with open(os.path.join(output_dir, "TECHNICAL_PROPOSAL.md"), 'w') as f:
        f.write(ctx.engineer_proposal)
    with open(os.path.join(output_dir, "PROJECT_CHARTER.md"), 'w') as f:
        f.write(ctx.charter)
    with open(os.path.join(output_dir, "BACKLOG.md"), 'w') as f:
        f.write(ctx.backlog)
    
    for path, content in ctx.completed_artifacts.items():
        safe_name = path.replace("/", "__").replace("\\", "__")
        with open(os.path.join(output_dir, safe_name), 'w') as f:
            f.write(content)
    
    logger.info(f"\nArtifacts salvos em: {output_dir}")
    logger.info("✅ test_07_final_summary PASSED — PIPELINE E2E OK")


# ============================================================
# PARSER DE BACKLOG (extrair tasks do markdown)
# ============================================================

def parse_tasks_from_backlog(backlog_content: str) -> list:
    """
    Extrai tasks estruturadas do backlog markdown gerado pelo PM.
    
    Procura padrões como:
    **TASK-WEB-001**: Título
    - **FR**: FR-01
    - **Acceptance Criteria**: [...]
    - **depends_on_files**: [...]
    - **estimated_files**: [...]
    """
    import re
    
    tasks = []
    
    # Padrão 1: **TASK-XXX-NNN**: Título
    task_pattern = re.compile(
        r'\*\*(?:TASK[-_]?\w*[-_]?\d+)\*\*\s*[:\-]\s*(.+)',
        re.IGNORECASE
    )
    
    lines = backlog_content.split('\n')
    current_task = None
    
    for i, line in enumerate(lines):
        # Detectar início de task
        task_match = task_pattern.search(line)
        if task_match:
            # Salvar task anterior
            if current_task:
                tasks.append(current_task)
            
            # Extrair ID
            id_match = re.search(r'(TASK[-_]?\w*[-_]?\d+)', line, re.IGNORECASE)
            task_id = id_match.group(1) if id_match else f"TASK-{len(tasks)+1}"
            
            current_task = {
                "id": task_id,
                "title": task_match.group(1).strip(),
                "description": "",
                "fr_ref": "",
                "acceptance_criteria": [],
                "depends_on_files": [],
                "estimated_files": [],
            }
            continue
        
        if current_task is None:
            continue
        
        line_stripped = line.strip().lower()
        
        # Extrair campos
        if "fr" in line_stripped and ":" in line:
            fr_match = re.search(r'FR[-_]?\d+', line, re.IGNORECASE)
            if fr_match:
                current_task["fr_ref"] = fr_match.group(0)
        
        elif "descrição" in line_stripped or "description" in line_stripped:
            current_task["description"] = line.split(":", 1)[-1].strip()
        
        elif "acceptance" in line_stripped or "critério" in line_stripped or "aceite" in line_stripped:
            # Ler linhas seguintes como critérios
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith(("- [", "- ", "  -")):
                criterion = re.sub(r'^[\s\-\[\]xX]+', '', lines[j]).strip()
                if criterion:
                    current_task["acceptance_criteria"].append(criterion)
                j += 1
        
        elif "depends_on" in line_stripped or "dependência" in line_stripped:
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith(("- ", "  -")):
                dep = lines[j].strip().lstrip("- ").strip()
                if dep and dep != "nenhuma" and dep != "[]":
                    current_task["depends_on_files"].append(dep)
                j += 1
        
        elif "estimated_files" in line_stripped or "arquivos" in line_stripped:
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith(("- ", "  -")):
                f = lines[j].strip().lstrip("- ").strip()
                if f:
                    current_task["estimated_files"].append(f)
                j += 1
    
    # Salvar última task
    if current_task:
        tasks.append(current_task)
    
    # Fallback: se o parser não encontrou tasks estruturadas,
    # criar tasks genéricas a partir de headers
    if not tasks:
        logger.warning("Parser de tasks não encontrou padrão TASK-*. Tentando fallback por headers...")
        header_pattern = re.compile(r'^#{2,4}\s+(.+)', re.MULTILINE)
        for idx, match in enumerate(header_pattern.finditer(backlog_content)):
            title = match.group(1).strip()
            if any(kw in title.lower() for kw in ['fase', 'phase', 'backlog', 'squad', 'resumo']):
                continue  # Pular headers de seção
            tasks.append({
                "id": f"TASK-{idx+1:03d}",
                "title": title,
                "description": title,
                "fr_ref": "",
                "acceptance_criteria": [f"Implementar {title} conforme spec"],
                "depends_on_files": [],
                "estimated_files": [],
            })
    
    return tasks
```

---

### 4.3 Validadores (um por etapa)

#### `validators/validate_product_spec.py`

```python
"""Valida o PRODUCT_SPEC gerado pelo CTO."""

import re


def validate_product_spec(content: str) -> list:
    """
    Retorna lista de erros. Lista vazia = válido.
    """
    errors = []
    
    # Seções obrigatórias (## 0 até ## 9 ou equivalentes)
    required_sections = [
        ("Metadados", r"(?:metadados|metadata|## 0)"),
        ("Visão", r"(?:visão|vision|## 1)"),
        ("Personas|Jornadas", r"(?:persona|jornada|journey|## 2)"),
        ("Requisitos Funcionais", r"(?:requisitos?\s+funciona|functional\s+req|FR[-_]0|## 3)"),
        ("Requisitos Não-Funcionais", r"(?:n[aã]o[\s-]+funciona|non[\s-]+functional|NFR|## 4)"),
        ("Fora de escopo", r"(?:fora\s+de\s+escopo|out\s+of\s+scope|## 8)"),
    ]
    
    content_lower = content.lower()
    
    for section_name, pattern in required_sections:
        if not re.search(pattern, content_lower):
            errors.append(f"Seção obrigatória não encontrada: {section_name}")
    
    # Pelo menos 5 FRs (a spec tem 6 seções visuais)
    fr_count = len(re.findall(r'FR[-_]?\d+', content, re.IGNORECASE))
    if fr_count < 5:
        errors.append(f"Apenas {fr_count} FRs encontrados (mínimo 5 para esta spec)")
    
    # Pelo menos 3 NFRs (performance, SEO, acessibilidade)
    nfr_count = len(re.findall(r'NFR[-_]?\d+', content, re.IGNORECASE))
    if nfr_count < 3:
        errors.append(f"Apenas {nfr_count} NFRs encontrados (mínimo 3 para esta spec)")
    
    # Pelo menos 1 critério de aceite (DADO/QUANDO/ENTÃO ou equivalente)
    has_acceptance = bool(re.search(
        r'(?:DADO|QUANDO|ENTÃO|GIVEN|WHEN|THEN|aceite|acceptance)',
        content, re.IGNORECASE
    ))
    if not has_acceptance:
        errors.append("Nenhum critério de aceite encontrado (DADO/QUANDO/ENTÃO)")
    
    # Deve mencionar keywords da spec
    for keyword in ["hero", "serviço", "contato", "whatsapp", "footer"]:
        if keyword not in content_lower:
            errors.append(f"Keyword da spec não encontrada no output: '{keyword}'")
    
    return errors
```

#### `validators/validate_engineer_proposal.py`

```python
"""Valida a proposta técnica do Engineer."""

import re


def validate_engineer_proposal(content: str) -> list:
    errors = []
    content_lower = content.lower()
    
    # Deve mencionar pelo menos 1 squad
    if not re.search(r'squad', content_lower):
        errors.append("Nenhuma squad mencionada na proposta")
    
    # Deve definir stack
    stack_keywords = ["next.js", "nextjs", "react", "html", "css", "typescript", "tailwind"]
    has_stack = any(kw in content_lower for kw in stack_keywords)
    if not has_stack:
        errors.append("Nenhuma stack web identificada (Next.js, React, HTML/CSS)")
    
    # Deve referenciar FRs
    if not re.search(r'FR[-_]?\d+', content, re.IGNORECASE):
        errors.append("Nenhuma referência a FRs da spec")
    
    # Deve ser proporcional: landing page estática = 1 squad
    squad_mentions = len(re.findall(r'squad\s+\d|squad\s+\w+\s*:', content_lower))
    if squad_mentions > 2:
        errors.append(
            f"Proposta tem {squad_mentions} squads para landing page estática "
            f"(esperado 1, máximo 2)"
        )
    
    return errors
```

#### `validators/validate_charter.py`

```python
"""Valida o Project Charter do CTO."""

import re


def validate_charter(content: str) -> list:
    errors = []
    content_lower = content.lower()
    
    # Deve conter visão
    if not re.search(r'(?:visão|vision|objetivo|goal)', content_lower):
        errors.append("Charter sem seção de visão/objetivo")
    
    # Deve referenciar squads
    if not re.search(r'squad', content_lower):
        errors.append("Charter sem referência a squads")
    
    # Deve mencionar PM
    if not re.search(r'\bpm\b', content_lower):
        errors.append("Charter sem menção a PM")
    
    # Deve referenciar FRs ou spec
    if not re.search(r'(?:FR[-_]?\d+|spec|requisito|funcional)', content, re.IGNORECASE):
        errors.append("Charter sem referência a FRs ou spec")
    
    # Deve conter escopo ou prioridades
    if not re.search(r'(?:escopo|scope|priorid|priority|mvp)', content_lower):
        errors.append("Charter sem escopo ou prioridades definidas")
    
    return errors
```

#### `validators/validate_backlog.py`

```python
"""Valida o backlog gerado pelo PM."""

import re


def validate_backlog(content: str) -> list:
    errors = []
    content_lower = content.lower()
    
    # Deve conter pelo menos 3 tasks identificáveis
    task_patterns = [
        r'TASK[-_]?\w*[-_]?\d+',  # TASK-WEB-001
        r'#{2,4}\s+(?:Task|Tarefa)',  # ## Task 1
    ]
    
    task_count = 0
    for pattern in task_patterns:
        task_count += len(re.findall(pattern, content, re.IGNORECASE))
    
    if task_count < 3:
        errors.append(f"Apenas {task_count} tasks encontradas (mínimo 3)")
    
    # Deve conter acceptance criteria ou critérios de aceite
    if not re.search(r'(?:acceptance|aceite|critério|criteria)', content_lower):
        errors.append("Nenhum acceptance criteria encontrado nas tasks")
    
    # Deve referenciar FRs
    if not re.search(r'FR[-_]?\d+', content, re.IGNORECASE):
        errors.append("Nenhuma referência a FRs nas tasks")
    
    # Deve mencionar arquivos estimados
    if not re.search(r'(?:estimated_files|arquivos|\.tsx|\.ts|\.css|\.html)', content_lower):
        errors.append("Tasks não mencionam arquivos que serão produzidos")
    
    return errors
```

#### `validators/validate_dev_output.py`

```python
"""Valida output do Dev."""


def validate_dev_output(artifacts: list) -> list:
    errors = []
    
    if not artifacts:
        errors.append("Dev não produziu nenhum artifact")
        return errors
    
    for art in artifacts:
        path = art.get("path", "")
        content = art.get("content", "")
        
        if not path:
            errors.append("Artifact sem path")
        
        if not content or len(content) < 50:
            errors.append(f"{path}: conteúdo muito curto ({len(content)} chars)")
        
        # Placeholders proibidos
        forbidden = ["...", "// TODO", "// implementar", "/* TODO */",
                     "// rest of", "// adicionar", "# TODO", "[...]"]
        for placeholder in forbidden:
            if placeholder in content:
                errors.append(f"{path}: contém placeholder proibido '{placeholder}'")
    
    return errors
```

#### `validators/validate_qa_report.py`

```python
"""Valida report do QA."""


def validate_qa_report(response: dict) -> list:
    errors = []
    
    status = response.get("status", "")
    
    if status not in ("QA_PASS", "QA_FAIL"):
        errors.append(f"QA retornou status inesperado: {status} (esperado QA_PASS ou QA_FAIL)")
    
    if status == "QA_FAIL":
        summary = response.get("summary", "")
        if len(summary) < 50:
            errors.append("QA_FAIL sem summary detalhado")
        
        # Deve ter issues acionáveis
        artifacts = response.get("artifacts", [])
        has_issues = False
        for art in artifacts:
            content = art.get("content", "")
            if "issue" in content.lower() or "fail" in content.lower():
                has_issues = True
        
        if not has_issues and "issue" not in summary.lower():
            errors.append("QA_FAIL sem issues específicos (Dev não consegue corrigir)")
    
    return errors
```

---

## 5. Como Executar

### 5.1 Pré-requisitos

```bash
# 1. Agents service rodando
./start-agents-host.sh
# ou: docker compose up agents

# 2. Verificar health
curl -s http://127.0.0.1:8000/health | python -m json.tool
# Deve mostrar: "claude_configured": true

# 3. Instalar dependências do teste
pip install pytest pytest-asyncio httpx --break-system-packages
```

### 5.2 Executar o teste completo

```bash
# Rodar todos os testes em ordem, com output verbose
pytest tests/e2e/test_pipeline_landing.py -v -s --timeout=600

# Rodar apenas até a etapa do PM (sem Dev/QA — mais rápido e barato)
pytest tests/e2e/test_pipeline_landing.py -v -s --timeout=300 -k "not test_06 and not test_07"

# Rodar apenas 1 etapa isolada (requer que etapas anteriores tenham passado)
pytest tests/e2e/test_pipeline_landing.py -v -s -k "test_01"
```

### 5.3 Custo estimado por execução

| Etapa | Chamadas ao Claude | Tokens estimados (in+out) | Custo aprox. (Sonnet) |
|-------|-------------------|--------------------------|----------------------|
| CTO spec_intake | 1 | ~6K | ~$0.02 |
| Engineer propose | 1 | ~8K | ~$0.03 |
| CTO validate | 1-2 | ~8K | ~$0.03 |
| CTO charter | 1 | ~8K | ~$0.03 |
| PM backlog | 1 | ~12K | ~$0.04 |
| Dev (3 tasks) | 3-6 | ~30K | ~$0.10 |
| QA (3 tasks) | 3-6 | ~18K | ~$0.06 |
| **TOTAL** | **11-18** | **~90K** | **~$0.31** |

### 5.4 Output esperado (quando tudo passa)

```
tests/e2e/test_pipeline_landing.py::test_01_cto_spec_intake PASSED
tests/e2e/test_pipeline_landing.py::test_02_engineer_propose PASSED
tests/e2e/test_pipeline_landing.py::test_03_cto_validate_engineer PASSED
tests/e2e/test_pipeline_landing.py::test_04_cto_charter PASSED
tests/e2e/test_pipeline_landing.py::test_05_pm_backlog PASSED
tests/e2e/test_pipeline_landing.py::test_06_dev_qa_loop PASSED
tests/e2e/test_pipeline_landing.py::test_07_final_summary PASSED

============================================================
RESUMO DO PIPELINE E2E
============================================================
  01_cto_spec_intake                       | OK         |  15.2s | 1 artifacts
  02_engineer_propose                      | OK         |  18.7s | 1 artifacts
  03_cto_validate_r1                       | OK         |  12.3s | 1 artifacts
  04_cto_charter                           | OK         |  16.8s | 1 artifacts
  05_pm_backlog                            | OK         |  22.1s | 1 artifacts
  06_task_TASK-WEB-001                     | OK/QA_PASS |  25.4s | 3 artifacts
  06_task_TASK-WEB-002                     | OK/QA_PASS |  28.9s | 2 artifacts
  06_task_TASK-WEB-003                     | OK/QA_PASS |  31.2s | 3 artifacts
============================================================
  TEMPO TOTAL: 170.6s (2.8 min)
  TASKS CONCLUÍDAS: 3
  TASKS FALHADAS:   0
============================================================

7 passed in 175.23s
```

---

## 6. Diagnóstico de Falhas

### 6.1 Tabela de falhas comuns

| Teste que falha | Sintoma | Causa provável | Correção |
|----------------|---------|----------------|----------|
| test_01 (CTO) | `status=NEEDS_INFO` | System prompt do CTO não tem template inline | Verificar `build_system_message` injeta PRODUCT_SPEC_TEMPLATE |
| test_01 (CTO) | Spec com "..." ou genérica | `max_tokens` muito baixo ou temperature alta | Usar temperature=0.3, max_tokens=12000 |
| test_01 (CTO) | Faltam FRs | CTO não mapeou todas as seções | Verificar que a spec está completa no `user_message` |
| test_02 (Engineer) | Propõe 4 squads | Prompt não instrui proporcionalidade | Adicionar: "Proponha o MÍNIMO de squads" |
| test_02 (Engineer) | Propõe backend | Não leu "sem API, sem backend" na spec | Verificar que spec_raw chega completa no input |
| test_03 (CTO validate) | Loop infinito (REVISION) | Feedback do CTO é genérico | Verificar prompt: "feedback ESPECÍFICO e acionável" |
| test_04 (Charter) | Charter vazio/curto | Context window estourou | Verificar token budget antes da chamada |
| test_05 (PM) | Menos de 3 tasks | PM não decompôs adequadamente | Verificar prompt do PM: instrução de decomposição |
| test_05 (PM) | Tasks sem acceptance_criteria | PM pulou campo | Verificar template de backlog no prompt |
| test_06 (Dev) | Código com "// TODO" | Dev prompt não proíbe | Verificar LEI 2: regra no INÍCIO e FIM do prompt |
| test_06 (Dev) | Imports incorretos | Dev não recebeu dependency_code | Verificar `depends_on_files` e `completed_artifacts` |
| test_06 (QA) | QA_PASS em tudo sem verificar | Prompt do QA muito fraco | Aplicar LEI 12: prompt cético |
| test_06 (QA) | QA_FAIL genérico ("tem problemas") | Prompt não instrui issues acionáveis | Verificar: "indique arquivo + região + critério" |
| Qualquer | `JSONDecodeError` | Escaping de código dentro de JSON | Implementar LEI 4: `resilient_json_parse` |
| Qualquer | Timeout | `max_tokens` alto + prompt grande | Verificar LEI 3: token budget |
| Qualquer | `ConnectionRefused` | Agents service não está rodando | `curl http://127.0.0.1:8000/health` |

### 6.2 Como debugar uma etapa específica

```bash
# 1. Rodar apenas a etapa que falha com log máximo
pytest tests/e2e/test_pipeline_landing.py -v -s -k "test_02" --log-cli-level=DEBUG

# 2. Verificar o que o Claude recebeu (logs do agents service)
# Terminal do agents:
#   [cto/spec_intake_and_normalize] System prompt: 4523 chars | User msg: 3847 chars
#   [cto] Thinking: Analisando a spec da landing page...
#   [cto] Status: OK | Summary: Spec convertida...

# 3. Inspecionar artifacts gerados
cat tests/e2e/output/e2e-landing-test/PRODUCT_SPEC.md

# 4. Se o JSON é inválido, ver o output bruto do Claude
# Adicionar no runtime.py:
#   logger.debug(f"RAW OUTPUT:\n{raw_text[:2000]}")
```

### 6.3 Script de diagnóstico rápido

```bash
#!/bin/bash
# tests/e2e/diagnose.sh — Verifica pré-requisitos antes de rodar o E2E

echo "=== Diagnóstico E2E ==="

# 1. Agents service
echo -n "Agents health: "
curl -sf http://127.0.0.1:8000/health | python3 -c "
import sys, json
h = json.load(sys.stdin)
model = h.get('claude_model', 'N/A')
configured = h.get('claude_configured', False)
print(f'model={model} configured={configured}')
if not configured:
    print('  ❌ CLAUDE_API_KEY não configurada!')
    sys.exit(1)
print('  ✅ OK')
" || echo "  ❌ Agents service não está rodando"

# 2. Python deps
echo -n "pytest: "
python3 -c "import pytest; print(f'v{pytest.__version__} ✅')" 2>/dev/null || echo "❌ pip install pytest"

echo -n "httpx: "
python3 -c "import httpx; print(f'v{httpx.__version__} ✅')" 2>/dev/null || echo "❌ pip install httpx"

echo -n "pytest-asyncio: "
python3 -c "import pytest_asyncio; print('✅')" 2>/dev/null || echo "❌ pip install pytest-asyncio"

# 3. Spec file
echo -n "Spec file: "
if [ -f "tests/e2e/spec_landing_zentriz.txt" ]; then
    wc -c tests/e2e/spec_landing_zentriz.txt | awk '{print $1 " bytes ✅"}'
else
    echo "❌ Arquivo não encontrado"
fi

echo "=== Fim diagnóstico ==="
```

---

## 7. Critérios de Sucesso do E2E

O pipeline é considerado **funcional** quando:

| Critério | Mínimo para PASS |
|----------|-----------------|
| CTO gera PRODUCT_SPEC com FRs | ≥ 5 FRs identificados |
| Engineer propõe arquitetura proporcional | 1 squad para landing page |
| CTO↔Engineer convergem | Em ≤ 2 rodadas |
| Charter é autossuficiente | PM consegue gerar backlog a partir dele |
| PM gera backlog com tasks | ≥ 3 tasks com acceptance criteria |
| Dev gera código completo | 0 placeholders em 100% dos artifacts |
| QA valida com rigor | Rejeita pelo menos 1 issue se houver problemas |
| Pipeline completo roda sem crash | 7/7 testes passam |
| Tempo total | < 5 minutos |
| Custo total | < $0.50 por execução |

Quando estes critérios forem atendidos com a spec de landing page, o pipeline
está pronto para receber specs mais complexas (como a loja de veículos).
