"""
Teste isolado: PM recebe PRODUCT_SPEC, charter e artefatos do Engineer e gera backlog.

Entrada:
  - PRODUCT_SPEC em PROJECT_FILES_ROOT/<project_id>/docs/spec/PRODUCT_SPEC.md
  - Artefatos do Engineer em PROJECT_FILES_ROOT/<project_id>/docs/engineer/
    (engineer_proposal.md, engineer_architecture.md, engineer_dependencies.md)
  - Charter mínimo (resumo aprovado CTO ou placeholder)
Saída esperada: artifacts em docs/pm/backend/ (BACKLOG.md, DOD.md).

Objetivo: validar que o agente PM + IA geram backlog executável a partir do que o
Engineer entregou, sem rodar o pipeline completo.

Pré-requisitos:
  - Rodar antes: test_cto_spec_only.py e test_engineer_spec_only.py (ou ter PRODUCT_SPEC
    e docs/engineer/*.md em zentriz-files/cto-spec-test/)
  - Agents na porta 8000 (./start-agents-host.sh)
  - CLAUDE_API_KEY no .env

Execução:
  pytest tests/e2e/test_pm_spec_only.py -v -s
  pytest tests/e2e/test_pm_spec_only.py -v -s -k test_pm_generate_backlog
"""
import os
import sys
import pytest
import httpx
from pathlib import Path

_here = Path(__file__).resolve().parent
_repo_root = _here.parent.parent
if str(_here) not in sys.path:
    sys.path.insert(0, str(_here))

PROJECT_FILES_ROOT = os.environ.get("PROJECT_FILES_ROOT", "").strip() or str(Path.home() / "zentriz-files")
PROJECT_ID = os.environ.get("PM_TEST_PROJECT_ID", "cto-spec-test")
DOCS_ENGINEER = Path(PROJECT_FILES_ROOT) / PROJECT_ID / "docs" / "engineer"
DOCS_SPEC = Path(PROJECT_FILES_ROOT) / PROJECT_ID / "docs" / "spec"
PRODUCT_SPEC_PATH = DOCS_SPEC / "PRODUCT_SPEC.md"

AGENTS_URL = os.environ.get("API_AGENTS_URL", "http://127.0.0.1:8000")
PM_TIMEOUT = int(os.environ.get("PM_SPEC_TEST_TIMEOUT", "900"))

ENGINEER_FILES = [
    "engineer_proposal.md",
    "engineer_architecture.md",
    "engineer_dependencies.md",
]


def load_product_spec() -> str:
    path = Path(PRODUCT_SPEC_PATH)
    if not path.exists():
        raise FileNotFoundError(
            "PRODUCT_SPEC não encontrado em %s. Rode antes: pytest tests/e2e/test_cto_spec_only.py"
            % path
        )
    return path.read_text(encoding="utf-8")[:15000]


def load_engineer_artifacts() -> list[str]:
    """Carrega os 3 arquivos do Engineer em ordem (proposal, architecture, dependencies)."""
    out = []
    for name in ENGINEER_FILES:
        path = DOCS_ENGINEER / name
        if not path.exists():
            raise FileNotFoundError(
                "Artefato do Engineer não encontrado: %s. Rode antes: pytest tests/e2e/test_engineer_spec_only.py"
                % path
            )
        out.append(path.read_text(encoding="utf-8"))
    return out


def build_charter_minimal(engineer_proposal: str) -> str:
    """Charter mínimo para o teste: resumo de squad/stack aprovada."""
    if not engineer_proposal or len(engineer_proposal) < 200:
        return "Squad Web aprovada. Stack: Next.js, TypeScript, Tailwind. Gerar backlog executável."
    # Primeiras linhas úteis do proposal (evitar envio gigante)
    head = engineer_proposal[:2000].replace("#", "").strip()
    return "Charter (resumo): " + head[:800] + ("..." if len(head) > 800 else "")


@pytest.mark.asyncio
async def test_pm_generate_backlog():
    """PM gera BACKLOG.md e DOD.md a partir do PRODUCT_SPEC + artefatos do Engineer."""
    product_spec = load_product_spec()
    engineer_docs = load_engineer_artifacts()
    charter = build_charter_minimal(engineer_docs[0] if engineer_docs else "")

    inputs = {
        "product_spec": product_spec,
        "charter": charter,
        "engineer_docs": engineer_docs,
        "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        "context": {"skill_path": "pm/web"},  # Landing page = squad Web (Next.js/Frontend), não backend
    }
    body = {
        "request_id": "pm-spec-test-e2e",
        "project_id": PROJECT_ID,
        "agent": "pm",
        "mode": "generate_backlog",
        "task_id": None,
        "task": "Gerar backlog executável (BACKLOG.md e DOD.md) a partir do PRODUCT_SPEC e da proposta do Engineer.",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1},
    }

    try:
        async with httpx.AsyncClient(timeout=PM_TIMEOUT) as client:
            response = await client.post(
                "%s/invoke/pm" % AGENTS_URL.rstrip("/"),
                json=body,
            )
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        pytest.skip(
            "Agents não acessível em %s. Rode ./start-agents-host.sh primeiro. Erro: %s"
            % (AGENTS_URL, e)
        )

    assert response.status_code == 200, "HTTP %d: %s" % (response.status_code, response.text[:800])
    result = response.json()
    assert "status" in result, "Resposta sem campo status"

    assert result["status"] in ("OK", "NEEDS_INFO", "REVISION", "BLOCKED"), (
        "PM retornou status inesperado: %s" % result["status"]
    )

    artifacts = result.get("artifacts") or []
    pm_paths = [a.get("path", "") for a in artifacts]

    if result["status"] == "OK":
        # Contrato: BACKLOG.md e DOD.md em docs/pm/ (backend é o default)
        expected = ["docs/pm/", "BACKLOG.md", "DOD.md"]
        has_backlog = any("BACKLOG" in p and "pm" in p for p in pm_paths)
        has_dod = any("DOD" in p and "pm" in p for p in pm_paths)
        assert has_backlog, "Artifact BACKLOG ausente (paths: %s)" % pm_paths
        assert has_dod, "Artifact DOD ausente (paths: %s)" % pm_paths

        backlog_content = ""
        for art in artifacts:
            if "BACKLOG" in art.get("path", ""):
                backlog_content = art.get("content", "")
                break
        assert backlog_content, "Conteúdo de BACKLOG ausente"
        assert len(backlog_content) >= 300, "BACKLOG muito curto (%d chars)" % len(backlog_content)

    elif result["status"] in ("BLOCKED", "NEEDS_INFO") and result.get("summary"):
        pass


@pytest.mark.asyncio
async def test_agents_health():
    """Garante que o serviço de agents está acessível antes do teste principal."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get("%s/health" % AGENTS_URL.rstrip("/"))
        assert r.status_code == 200
    except Exception as e:
        pytest.skip("Agents não está rodando em %s: %s" % (AGENTS_URL, e))
