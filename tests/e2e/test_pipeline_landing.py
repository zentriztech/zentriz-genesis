"""
Teste E2E do pipeline de agentes usando spec de landing page estática (Zentriz).
Ref: project/docs/E2E_PIPELINE_TEST_GUIDE.md
Spec: project/spec/spec_landing_zentriz.txt

Fluxo: CTO → Engineer → CTO validate → Charter → PM → Dev → QA

Pré-requisitos:
  - Agents service rodando (porta 8000)
  - CLAUDE_API_KEY configurada

Execução:
  pytest tests/e2e/test_pipeline_landing.py -v -s --timeout=600
  pytest tests/e2e/test_pipeline_landing.py -v -s -k "not test_06 and not test_07"  # até PM
"""
import os
import sys
import json
import time
import logging
import re
import pytest
import httpx
from pathlib import Path

# Paths: repo root e tests/e2e para importar validators
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
from validators.validate_dev_output import validate_dev_output
from validators.validate_qa_report import validate_qa_report

# Spec oficial (project/spec/spec_landing_zentriz.txt)
SPEC_FILE = _repo_root / "project" / "spec" / "spec_landing_zentriz.txt"

AGENTS_URL = os.environ.get("API_AGENTS_URL", "http://127.0.0.1:8000")
# Timeouts altos: Claude + repair loop podem levar 5–10 min por agente
TIMEOUTS = {"cto": 900, "engineer": 600, "pm": 600, "dev": 600, "qa": 600, "monitor": 300}

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("e2e")


def load_spec() -> str:
    """Carrega a spec de teste (project/spec/spec_landing_zentriz.txt)."""
    if not SPEC_FILE.exists():
        raise FileNotFoundError("Spec não encontrada: %s" % SPEC_FILE)
    return SPEC_FILE.read_text(encoding="utf-8")


async def call_agent(agent_name: str, body: dict) -> dict:
    """Chama POST /invoke/{agent_name} e retorna ResponseEnvelope. Retry 1x em timeout."""
    url = "%s/invoke/%s" % (AGENTS_URL.rstrip("/"), agent_name)
    timeout = TIMEOUTS.get(agent_name, 300)
    logger.info("CHAMANDO: %s | mode: %s | timeout: %ss", agent_name, body.get("mode"), timeout)
    start = time.time()
    last_exc = None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(url, json=body)
            break
        except (httpx.ReadTimeout, httpx.ConnectTimeout) as e:
            last_exc = e
            if attempt == 0:
                logger.warning("Timeout %s (tentativa 1/2), repetindo...", agent_name)
            else:
                raise
    duration = round(time.time() - start, 1)
    assert response.status_code == 200, "HTTP %d: %s" % (response.status_code, response.text[:500])
    result = response.json()
    assert "status" in result, "JSON sem campo status: %s" % (json.dumps(result)[:500])
    logger.info("RESPOSTA: %s | status=%s | %ss", agent_name, result["status"], duration)
    for art in result.get("artifacts", []):
        logger.info("  -> %s (%s chars)", art.get("path", "N/A"), len(art.get("content", "")))
    return result


def extract_artifact_content(response: dict, path_contains: str = "") -> str:
    """Extrai conteúdo do primeiro artifact que contém path_contains no path."""
    for art in response.get("artifacts", []):
        if path_contains in art.get("path", ""):
            return art.get("content", "")
    if not path_contains and response.get("artifacts"):
        return response["artifacts"][0].get("content", "")
    return ""


def assert_no_placeholders(content: str, context: str):
    forbidden = ["...", "// TODO", "// implementar", "[...]", "/* TODO */", "// rest of", "# TODO"]
    for p in forbidden:
        assert p not in content, "Placeholder em %s: '%s'" % (context, p)


def assert_minimum_length(content: str, min_chars: int, context: str):
    assert len(content) >= min_chars, "%s: muito curto (%d chars, min %d)" % (context, len(content), min_chars)


class E2EPipelineContext:
    """Contexto acumulado ao longo do pipeline (simula PipelineContext). Não é teste pytest."""

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
        self.step_results = {}
        self.step_durations = {}

    def print_summary(self):
        logger.info("RESUMO DO PIPELINE E2E")
        for step, result in self.step_results.items():
            status = result.get("status", "N/A") if isinstance(result, dict) else str(result)
            duration = self.step_durations.get(step, 0)
            arts = len(result.get("artifacts", [])) if isinstance(result, dict) else 0
            logger.info("  %s | %s | %.1fs | %s artifacts", step[:40], status, duration, arts)
        total = sum(self.step_durations.values())
        logger.info("  TEMPO TOTAL: %.1fs | TASKS OK: %s | FALHADAS: %s", total, len(self.completed_tasks), len(self.failed_tasks))


@pytest.fixture(scope="module")
def ctx():
    return E2EPipelineContext()


@pytest.fixture(scope="module", autouse=True)
def check_agents_health():
    try:
        r = httpx.get("%s/health" % AGENTS_URL.rstrip("/"), timeout=10)
        assert r.status_code == 200
        h = r.json()
        assert h.get("claude_configured") is True, "Claude não configurado: %s" % h
        logger.info("Agents health OK: model=%s", h.get("claude_model"))
    except httpx.ConnectError:
        pytest.skip("Agents service não está rodando em %s. Execute: ./start-agents-host.sh" % AGENTS_URL)
    except Exception as e:
        pytest.skip("Falha ao verificar agents health: %s" % e)


@pytest.mark.asyncio
async def test_01_cto_spec_intake(ctx):
    """ETAPA 1: CTO converte spec TXT para PRODUCT_SPEC.md"""
    ctx.spec_raw = load_spec()
    inputs = {
        "spec_raw": ctx.spec_raw,
        "product_spec": None,
        "constraints": ["spec-driven", "no-invent", "paths-resilient"],
    }
    body = {
        "project_id": "e2e-landing-test",
        "agent": "cto",
        "mode": "spec_intake_and_normalize",
        "task_id": None,
        "task": "Converter spec TXT para formato PRODUCT_SPEC",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1},
    }
    start = time.time()
    result = await call_agent("cto", body)
    ctx.step_durations["01_cto_spec_intake"] = time.time() - start
    ctx.step_results["01_cto_spec_intake"] = result

    assert result["status"] == "OK", "CTO retornou %s: %s" % (result["status"], result.get("summary"))
    spec_content = extract_artifact_content(result, "PRODUCT_SPEC") or extract_artifact_content(result, "spec") or extract_artifact_content(result, "")
    assert spec_content, "Artifact PRODUCT_SPEC não encontrado"
    ctx.product_spec = spec_content
    assert_no_placeholders(spec_content, "PRODUCT_SPEC")
    assert_minimum_length(spec_content, 1500, "PRODUCT_SPEC")
    errors = validate_product_spec(spec_content)
    assert not errors, "PRODUCT_SPEC: " + "; ".join(errors)
    logger.info("test_01_cto_spec_intake PASSED")


@pytest.mark.asyncio
async def test_02_engineer_propose(ctx):
    """ETAPA 2: Engineer propõe arquitetura."""
    assert ctx.product_spec
    inputs = {
        "product_spec": ctx.product_spec,
        "constraints": ["spec-driven", "no-invent", "low-cost"],
    }
    body = {
        "project_id": "e2e-landing-test",
        "agent": "engineer",
        "mode": "propose",
        "task_id": None,
        "task": "Analisar spec e propor arquitetura técnica",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1},
    }
    start = time.time()
    result = await call_agent("engineer", body)
    ctx.step_durations["02_engineer_propose"] = time.time() - start
    ctx.step_results["02_engineer_propose"] = result

    assert result["status"] == "OK", "Engineer retornou %s" % result["status"]
    proposal_content = extract_artifact_content(result, "")
    assert proposal_content
    ctx.engineer_proposal = proposal_content
    assert_no_placeholders(proposal_content, "TECHNICAL_PROPOSAL")
    assert_minimum_length(proposal_content, 800, "TECHNICAL_PROPOSAL")
    errors = validate_engineer_proposal(proposal_content)
    assert not errors, "Engineer proposta: " + "; ".join(errors)
    logger.info("test_02_engineer_propose PASSED")


@pytest.mark.asyncio
async def test_03_cto_validate_engineer(ctx):
    """ETAPA 3: CTO valida proposta do Engineer."""
    assert ctx.product_spec and ctx.engineer_proposal
    inputs = {
        "product_spec": ctx.product_spec,
        "engineer_proposal": ctx.engineer_proposal,
        "cto_validation": ctx.cto_validation,
    }
    body = {
        "project_id": "e2e-landing-test",
        "agent": "cto",
        "mode": "validate_engineer_docs",
        "task_id": None,
        "task": "Validar proposta técnica do Engineer",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1},
    }
    start = time.time()
    result = await call_agent("cto", body)
    ctx.step_durations["03_cto_validate"] = time.time() - start
    ctx.step_results["03_cto_validate"] = result

    assert result["status"] in ("OK", "REVISION"), "CTO status inesperado: %s" % result["status"]
    if result["status"] == "REVISION":
        ctx.cto_validation = result.get("summary", "")
    assert result["status"] == "OK", "CTO não aprovou em 1 rodada (REVISION requer loop extra no guia)"
    logger.info("test_03_cto_validate_engineer PASSED")


@pytest.mark.asyncio
async def test_04_cto_charter(ctx):
    """ETAPA 4: CTO gera Project Charter."""
    assert ctx.product_spec and ctx.engineer_proposal
    inputs = {
        "product_spec": ctx.product_spec,
        "engineer_proposal": ctx.engineer_proposal,
    }
    body = {
        "project_id": "e2e-landing-test",
        "agent": "cto",
        "mode": "charter_and_proposal",
        "task_id": None,
        "task": "Produzir Project Charter",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 1, "round": 1},
    }
    start = time.time()
    result = await call_agent("cto", body)
    ctx.step_durations["04_cto_charter"] = time.time() - start
    ctx.step_results["04_cto_charter"] = result

    assert result["status"] == "OK", "CTO charter: %s" % result["status"]
    charter_content = extract_artifact_content(result, "CHARTER") or extract_artifact_content(result, "charter") or extract_artifact_content(result, "")
    assert charter_content
    ctx.charter = charter_content
    assert_no_placeholders(charter_content, "PROJECT_CHARTER")
    assert_minimum_length(charter_content, 1000, "PROJECT_CHARTER")
    errors = validate_charter(charter_content)
    assert not errors, "Charter: " + "; ".join(errors)
    logger.info("test_04_cto_charter PASSED")


@pytest.mark.asyncio
async def test_05_pm_backlog(ctx):
    """ETAPA 5: PM gera backlog."""
    assert ctx.charter and ctx.product_spec
    inputs = {
        "charter": ctx.charter,
        "engineer_proposal": ctx.engineer_proposal,
        "product_spec": ctx.product_spec,
        "module": "web",
    }
    body = {
        "project_id": "e2e-landing-test",
        "agent": "pm",
        "mode": "generate_backlog",
        "task_id": None,
        "task": "Gerar backlog de tarefas para a squad Web",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 1, "round": 1},
    }
    start = time.time()
    result = await call_agent("pm", body)
    ctx.step_durations["05_pm_backlog"] = time.time() - start
    ctx.step_results["05_pm_backlog"] = result

    assert result["status"] == "OK", "PM: %s" % result["status"]
    backlog_content = extract_artifact_content(result, "")
    assert backlog_content
    ctx.backlog = backlog_content
    assert_no_placeholders(backlog_content, "BACKLOG")
    assert_minimum_length(backlog_content, 1000, "BACKLOG")
    errors = validate_backlog(backlog_content)
    assert not errors, "Backlog: " + "; ".join(errors)
    ctx.backlog_tasks = parse_tasks_from_backlog(backlog_content)
    assert len(ctx.backlog_tasks) >= 3, "Backlog com menos de 3 tasks: %d" % len(ctx.backlog_tasks)
    logger.info("Backlog: %d tasks. test_05_pm_backlog PASSED", len(ctx.backlog_tasks))


def parse_tasks_from_backlog(backlog_content: str) -> list:
    """Extrai tasks do markdown do backlog (TASK-WEB-001, etc.)."""
    tasks = []
    task_pattern = re.compile(r"\*\*(?:TASK[-_]?\w*[-_]?\d+)\*\*\s*[:\-]\s*(.+)", re.IGNORECASE)
    lines = backlog_content.split("\n")
    current = None
    for i, line in enumerate(lines):
        m = task_pattern.search(line)
        if m:
            if current:
                tasks.append(current)
            id_m = re.search(r"(TASK[-_]?\w*[-_]?\d+)", line, re.IGNORECASE)
            task_id = id_m.group(1) if id_m else "TASK-%d" % (len(tasks) + 1)
            current = {
                "id": task_id,
                "title": m.group(1).strip(),
                "description": "",
                "fr_ref": "",
                "acceptance_criteria": [],
                "depends_on_files": [],
                "estimated_files": [],
            }
            continue
        if current is None:
            continue
        low = line.strip().lower()
        if "acceptance" in low or "critério" in low or "aceite" in low:
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith(("- [", "- ", "  -")):
                c = re.sub(r"^[\s\-\[\]xX]+", "", lines[j]).strip()
                if c:
                    current["acceptance_criteria"].append(c)
                j += 1
        elif "depends_on" in low or "dependência" in low:
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith(("- ", "  -")):
                dep = lines[j].strip().lstrip("- ").strip()
                if dep and dep not in ("nenhuma", "[]"):
                    current["depends_on_files"].append(dep)
                j += 1
    if current:
        tasks.append(current)
    if not tasks:
        for idx, m in enumerate(re.finditer(r"^#{2,4}\s+(.+)", backlog_content, re.MULTILINE)):
            title = m.group(1).strip()
            if any(k in title.lower() for k in ["fase", "phase", "backlog", "squad", "resumo"]):
                continue
            tasks.append({
                "id": "TASK-%03d" % (idx + 1),
                "title": title,
                "description": title,
                "fr_ref": "",
                "acceptance_criteria": ["Implementar %s conforme spec" % title],
                "depends_on_files": [],
                "estimated_files": [],
            })
    return tasks


@pytest.mark.asyncio
async def test_06_dev_qa_loop(ctx):
    """ETAPA 6: Loop Dev → QA para as primeiras 3 tasks."""
    assert ctx.backlog_tasks
    MAX_TASKS = 3
    MAX_RETRIES = 1
    tasks_to_run = ctx.backlog_tasks[:MAX_TASKS]
    for task_idx, task in enumerate(tasks_to_run):
        task_id = task.get("id", "TASK-%d" % (task_idx + 1))
        logger.info("TASK %d/%d: %s", task_idx + 1, len(tasks_to_run), task_id)
        dep_code = {}
        for p in task.get("depends_on_files", []):
            if p in ctx.completed_artifacts:
                dep_code[p] = ctx.completed_artifacts[p]
        dev_inputs = {
            "current_task": task,
            "tech_stack": "Next.js com export estático, TypeScript, Tailwind CSS",
            "dependency_code": dep_code,
            "completed_tasks": [{"task_id": t, "status": "done"} for t in ctx.completed_tasks],
        }
        dev_body = {
            "project_id": "e2e-landing-test",
            "agent": "dev",
            "mode": "implement_task",
            "task_id": task_id,
            "task": "Implementar: %s" % task.get("title", ""),
            "inputs": dev_inputs,
            "input": dev_inputs,
            "limits": {"max_retries": MAX_RETRIES},
        }
        start = time.time()
        dev_result = await call_agent("dev", dev_body)
        dev_duration = time.time() - start
        assert dev_result["status"] == "OK", "Dev falhou %s: %s" % (task_id, dev_result.get("summary"))
        dev_artifacts = dev_result.get("artifacts", [])
        assert len(dev_artifacts) > 0, "Dev não gerou artifact para %s" % task_id
        for art in dev_artifacts:
            assert_no_placeholders(art.get("content", ""), "Dev %s" % art.get("path", "?"))
            assert_minimum_length(art.get("content", ""), 50, "Dev %s" % art.get("path", "?"))
        qa_inputs = {
            "current_task": task,
            "dev_artifacts": dev_artifacts,
            "acceptance_criteria": task.get("acceptance_criteria", []),
            "fr_ref": task.get("fr_ref", ""),
        }
        qa_body = {
            "project_id": "e2e-landing-test",
            "agent": "qa",
            "mode": "validate",
            "task_id": task_id,
            "task": "Validar: %s" % task.get("title", ""),
            "inputs": qa_inputs,
            "input": qa_inputs,
        }
        qa_result = await call_agent("qa", qa_body)
        if qa_result["status"] == "QA_FAIL" and MAX_RETRIES > 0:
            dev_inputs["previous_attempt"] = {
                "artifacts": dev_artifacts,
                "qa_feedback": qa_result.get("summary", ""),
            }
            dev_body["inputs"] = dev_body["input"] = dev_inputs
            dev_result = await call_agent("dev", dev_body)
            dev_artifacts = dev_result.get("artifacts", [])
            qa_inputs["dev_artifacts"] = dev_artifacts
            qa_body["inputs"] = qa_body["input"] = qa_inputs
            qa_result = await call_agent("qa", qa_body)
        ctx.step_results["06_task_%s" % task_id] = {"dev": dev_result["status"], "qa": qa_result["status"]}
        ctx.step_durations["06_task_%s" % task_id] = dev_duration
        if qa_result["status"] == "QA_PASS":
            for art in dev_artifacts:
                ctx.completed_artifacts[art.get("path", "")] = art.get("content", "")
            ctx.completed_tasks.append(task_id)
            logger.info("%s QA_PASS", task_id)
        else:
            ctx.failed_tasks.append({"task_id": task_id, "reason": qa_result.get("summary", "QA_FAIL")})
            logger.warning("%s QA_FAIL (aceitável no E2E)", task_id)
    assert len(ctx.completed_tasks) >= len(tasks_to_run) // 2, "Menos da metade das tasks passou"
    logger.info("test_06_dev_qa_loop PASSED (OK: %d, FAIL: %d)", len(ctx.completed_tasks), len(ctx.failed_tasks))


@pytest.mark.asyncio
async def test_07_final_summary(ctx):
    """ETAPA 7: Resumo e persistência dos artifacts."""
    ctx.print_summary()
    assert ctx.product_spec
    assert ctx.engineer_proposal
    assert ctx.charter
    assert ctx.backlog
    assert len(ctx.completed_tasks) > 0
    out_dir = _here / "output" / "e2e-landing-test"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "PRODUCT_SPEC.md").write_text(ctx.product_spec, encoding="utf-8")
    (out_dir / "TECHNICAL_PROPOSAL.md").write_text(ctx.engineer_proposal, encoding="utf-8")
    (out_dir / "PROJECT_CHARTER.md").write_text(ctx.charter, encoding="utf-8")
    (out_dir / "BACKLOG.md").write_text(ctx.backlog, encoding="utf-8")
    for path, content in ctx.completed_artifacts.items():
        safe = path.replace("/", "__").replace("\\", "__")
        (out_dir / safe).write_text(content, encoding="utf-8")
    logger.info("Artifacts salvos em %s. test_07_final_summary PASSED — PIPELINE E2E OK", out_dir)
