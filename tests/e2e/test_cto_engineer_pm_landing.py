"""
Teste E2E: CTO → Engineer → PM usando spec da landing (spec_landing_zentriz.txt).

Fluxo: CTO (spec intake) → Engineer (proposta) → CTO (charter) → PM (backlog squad Web).

- Espec: project/spec/spec_landing_zentriz.txt
- Resiliente: retry em timeout, health check no início (skip se agents indisponível).
- Idempotente: project_id fixo, mesma spec; re-executar é seguro e produz mesmo resultado lógico.

Para subir os agentes e configurar o Docker:
  MAX_REPAIRS=0 ./deploy-docker.sh --host-agents --force-recreate && ./start-agents-host.sh

Execução:
  pytest tests/e2e/test_cto_engineer_pm_landing.py -v -s
  pytest tests/e2e/test_cto_engineer_pm_landing.py -v -s --timeout=1800
"""
import os
import sys
import json
import time
import logging
import pytest
import httpx
from pathlib import Path

_here = Path(__file__).resolve().parent
_repo_root = _here.parent.parent
if str(_here) not in sys.path:
    sys.path.insert(0, str(_here))
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from validators.validate_product_spec import validate_product_spec
from validators.validate_engineer_proposal import validate_engineer_proposal
from validators.validate_charter import validate_charter
from validators.validate_backlog import validate_backlog

SPEC_FILE = _repo_root / "project" / "spec" / "spec_landing_zentriz.txt"
AGENTS_URL = os.environ.get("API_AGENTS_URL", "http://127.0.0.1:8000")
PROJECT_ID = "cto-engineer-pm-landing"

# Timeouts por agente (segundos); CTO e Engineer podem levar vários minutos
TIMEOUTS = {
    "cto": int(os.environ.get("E2E_CTO_TIMEOUT", "900")),
    "engineer": int(os.environ.get("E2E_ENGINEER_TIMEOUT", "600")),
    "pm": int(os.environ.get("E2E_PM_TIMEOUT", "600")),
}
MAX_RETRIES = int(os.environ.get("E2E_MAX_RETRIES", "2"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("e2e.cto_engineer_pm")


def load_spec() -> str:
    """Carrega project/spec/spec_landing_zentriz.txt."""
    if not SPEC_FILE.exists():
        raise FileNotFoundError("Spec não encontrada: %s" % SPEC_FILE)
    return SPEC_FILE.read_text(encoding="utf-8")


def check_agents_health() -> bool:
    """Verifica se o serviço de agentes está saudável. Retorna True se OK."""
    try:
        r = httpx.get("%s/health" % AGENTS_URL.rstrip("/"), timeout=10)
        if r.status_code != 200:
            return False
        h = r.json()
        return h.get("claude_configured") is True
    except Exception:
        return False


async def call_agent(agent_name: str, body: dict) -> dict:
    """
    Chama POST /invoke/{agent_name}. Resiliente: até MAX_RETRIES tentativas em timeout.
    Retorna ResponseEnvelope. Levanta AssertionError se HTTP != 200 ou resposta inválida.
    """
    url = "%s/invoke/%s" % (AGENTS_URL.rstrip("/"), agent_name)
    timeout = TIMEOUTS.get(agent_name, 300)
    logger.info("Chamando %s (timeout=%ss, max_retries=%s)", agent_name, timeout, MAX_RETRIES)
    start = time.time()
    last_exc = None
    for attempt in range(MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(url, json=body)
            break
        except (httpx.ReadTimeout, httpx.ConnectTimeout) as e:
            last_exc = e
            if attempt < MAX_RETRIES - 1:
                logger.warning("Timeout %s (tentativa %d/%d), repetindo...", agent_name, attempt + 1, MAX_RETRIES)
            else:
                raise
    duration = round(time.time() - start, 1)
    assert response.status_code == 200, "HTTP %d: %s" % (response.status_code, (response.text or "")[:500])
    result = response.json()
    assert "status" in result, "Resposta sem campo status: %s" % (json.dumps(result)[:500])
    logger.info("Resposta %s | status=%s | %.1fs", agent_name, result.get("status"), duration)
    for art in result.get("artifacts", []):
        logger.info("  -> %s (%s chars)", art.get("path", "N/A"), len(art.get("content", "")))
    return result


def extract_artifact_content(response: dict, path_contains: str = "") -> str:
    """Extrai conteúdo do primeiro artifact cujo path contém path_contains."""
    for art in response.get("artifacts", []):
        if path_contains in art.get("path", ""):
            return art.get("content", "")
    if not path_contains and response.get("artifacts"):
        return response["artifacts"][0].get("content", "")
    return ""


# --- Contexto compartilhado (idempotente: mesmo project_id e spec) ---
class PipelineContext:
    def __init__(self):
        self.spec_raw = ""
        self.product_spec = ""
        self.engineer_proposal = ""
        self.charter = ""
        self.backlog = ""


@pytest.fixture(scope="module")
def ctx():
    return PipelineContext()


@pytest.fixture(scope="module", autouse=True)
def ensure_agents_and_spec():
    """Health check: pula todos os testes se agents não estiverem rodando."""
    if not SPEC_FILE.exists():
        pytest.skip("Spec não encontrada: %s" % SPEC_FILE)
    if not check_agents_health():
        pytest.skip(
            "Agents não está rodando ou Claude não configurado em %s. "
            "Execute: MAX_REPAIRS=0 ./deploy-docker.sh --host-agents --force-recreate && ./start-agents-host.sh"
            % AGENTS_URL
        )


# --- Etapas do pipeline ---

@pytest.mark.asyncio
async def test_01_cto_spec_intake(ctx):
    """ETAPA 1: CTO converte spec TXT para PRODUCT_SPEC.md."""
    ctx.spec_raw = load_spec()
    inputs = {
        "spec_raw": ctx.spec_raw,
        "product_spec": None,
        "constraints": ["spec-driven", "no-invent", "paths-resilient"],
    }
    body = {
        "project_id": PROJECT_ID,
        "agent": "cto",
        "mode": "spec_intake_and_normalize",
        "task_id": None,
        "task": "Converter spec TXT para formato PRODUCT_SPEC",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1},
    }
    result = await call_agent("cto", body)
    assert result["status"] == "OK", "CTO retornou %s: %s" % (result["status"], result.get("summary"))
    spec_content = extract_artifact_content(result, "PRODUCT_SPEC") or extract_artifact_content(result, "spec") or extract_artifact_content(result, "")
    assert spec_content, "Artifact PRODUCT_SPEC não encontrado"
    ctx.product_spec = spec_content
    assert len(spec_content) >= 500, "PRODUCT_SPEC muito curto"
    errors = validate_product_spec(spec_content)
    assert not errors, "PRODUCT_SPEC: " + "; ".join(errors)
    logger.info("test_01_cto_spec_intake OK")


@pytest.mark.asyncio
async def test_02_engineer_propose(ctx):
    """ETAPA 2: Engineer propõe arquitetura (squad Web para landing)."""
    assert ctx.product_spec
    inputs = {
        "product_spec": ctx.product_spec,
        "constraints": ["spec-driven", "no-invent", "low-cost"],
    }
    body = {
        "project_id": PROJECT_ID,
        "agent": "engineer",
        "mode": "propose",
        "task_id": None,
        "task": "Analisar spec e propor arquitetura técnica",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1},
    }
    result = await call_agent("engineer", body)
    assert result["status"] == "OK", "Engineer retornou %s" % result["status"]
    proposal_content = extract_artifact_content(result, "")
    assert proposal_content
    ctx.engineer_proposal = proposal_content
    assert len(proposal_content) >= 400, "Proposta muito curta"
    errors = validate_engineer_proposal(proposal_content)
    assert not errors, "Engineer proposta: " + "; ".join(errors)
    logger.info("test_02_engineer_propose OK")


@pytest.mark.asyncio
async def test_03_cto_charter(ctx):
    """ETAPA 3: CTO gera Project Charter (necessário para o PM)."""
    assert ctx.product_spec and ctx.engineer_proposal
    inputs = {
        "product_spec": ctx.product_spec,
        "engineer_proposal": ctx.engineer_proposal,
    }
    body = {
        "project_id": PROJECT_ID,
        "agent": "cto",
        "mode": "charter_and_proposal",
        "task_id": None,
        "task": "Produzir Project Charter",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 1, "round": 1},
    }
    result = await call_agent("cto", body)
    assert result["status"] == "OK", "CTO charter: %s" % result["status"]
    charter_content = extract_artifact_content(result, "CHARTER") or extract_artifact_content(result, "charter") or extract_artifact_content(result, "")
    assert charter_content
    ctx.charter = charter_content
    assert len(charter_content) >= 300, "Charter muito curto"
    errors = validate_charter(charter_content)
    assert not errors, "Charter: " + "; ".join(errors)
    logger.info("test_03_cto_charter OK")


@pytest.mark.asyncio
async def test_04_pm_backlog(ctx):
    """ETAPA 4: PM gera backlog para squad Web (landing = frontend, sem backend)."""
    assert ctx.charter and ctx.product_spec and ctx.engineer_proposal
    inputs = {
        "charter": ctx.charter,
        "engineer_proposal": ctx.engineer_proposal,
        "product_spec": ctx.product_spec,
        "module": "web",
    }
    body = {
        "project_id": PROJECT_ID,
        "agent": "pm",
        "mode": "generate_backlog",
        "task_id": None,
        "task": "Gerar backlog de tarefas para a squad Web",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 1, "round": 1},
        "context": {"skill_path": "pm/web"},
    }
    result = await call_agent("pm", body)
    assert result["status"] == "OK", "PM: %s" % result["status"]
    backlog_content = extract_artifact_content(result, "BACKLOG") or extract_artifact_content(result, "")
    assert backlog_content
    ctx.backlog = backlog_content
    assert len(backlog_content) >= 500, "Backlog muito curto"
    errors = validate_backlog(backlog_content)
    assert not errors, "Backlog: " + "; ".join(errors)
    logger.info("test_04_pm_backlog OK — CTO → Engineer → PM concluído")


@pytest.mark.asyncio
async def test_05_summary(ctx):
    """Resumo e persistência opcional dos artefatos (idempotente)."""
    assert ctx.product_spec and ctx.engineer_proposal and ctx.charter and ctx.backlog
    out_dir = _here / "output" / PROJECT_ID
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "PRODUCT_SPEC.md").write_text(ctx.product_spec, encoding="utf-8")
    (out_dir / "TECHNICAL_PROPOSAL.md").write_text(ctx.engineer_proposal, encoding="utf-8")
    (out_dir / "PROJECT_CHARTER.md").write_text(ctx.charter, encoding="utf-8")
    (out_dir / "BACKLOG.md").write_text(ctx.backlog, encoding="utf-8")
    logger.info("Artefatos salvos em %s (idempotente: re-executar sobrescreve).", out_dir)
