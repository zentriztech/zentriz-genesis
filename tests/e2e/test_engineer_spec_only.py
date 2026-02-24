"""
Teste isolado: Engineer recebe PRODUCT_SPEC.md (gerado pelo CTO) e gera proposta técnica.

Entrada: PRODUCT_SPEC em PROJECT_FILES_ROOT/<project_id>/docs/spec/PRODUCT_SPEC.md
         (por padrão: /Users/mac/zentriz-files/cto-spec-test/docs/spec/PRODUCT_SPEC.md)
Saída esperada: artifacts em docs/engineer/ (engineer_proposal.md, engineer_architecture.md,
                engineer_dependencies.md).

Objetivo: validar que o agente Engineer + IA conseguem produzir proposta técnica a partir
do PRODUCT_SPEC, sem rodar o pipeline completo (CTO já foi testado em test_cto_spec_only).

Pré-requisitos:
  - Rodar antes: pytest tests/e2e/test_cto_spec_only.py (gera PRODUCT_SPEC em zentriz-files)
  - Ou colocar um PRODUCT_SPEC.md válido em ENGINEER_TEST_PRODUCT_SPEC_PATH
  - Agents na porta 8000 (./start-agents-host.sh)
  - CLAUDE_API_KEY no .env

Execução:
  pytest tests/e2e/test_engineer_spec_only.py -v -s
  pytest tests/e2e/test_engineer_spec_only.py -v -s -k test_engineer_propose
"""
import os
import sys
import json
import pytest
import httpx
from pathlib import Path

_here = Path(__file__).resolve().parent
_repo_root = _here.parent.parent
if str(_here) not in sys.path:
    sys.path.insert(0, str(_here))

from validators.validate_engineer_proposal import validate_engineer_proposal

# Caminho do PRODUCT_SPEC gerado pelo teste do CTO (ou env)
PROJECT_FILES_ROOT = os.environ.get("PROJECT_FILES_ROOT", "").strip() or str(Path.home() / "zentriz-files")
PROJECT_ID = os.environ.get("ENGINEER_TEST_PROJECT_ID", "cto-spec-test")
DEFAULT_PRODUCT_SPEC_PATH = Path(PROJECT_FILES_ROOT) / PROJECT_ID / "docs" / "spec" / "PRODUCT_SPEC.md"
PRODUCT_SPEC_PATH = os.environ.get("ENGINEER_TEST_PRODUCT_SPEC_PATH", str(DEFAULT_PRODUCT_SPEC_PATH))

AGENTS_URL = os.environ.get("API_AGENTS_URL", "http://127.0.0.1:8000")
ENGINEER_TIMEOUT = int(os.environ.get("ENGINEER_SPEC_TEST_TIMEOUT", "900"))


def load_product_spec() -> str:
    path = Path(PRODUCT_SPEC_PATH)
    if not path.exists():
        raise FileNotFoundError(
            "PRODUCT_SPEC não encontrado em %s. Rode antes: pytest tests/e2e/test_cto_spec_only.py"
            % path
        )
    return path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_engineer_propose():
    """Engineer gera proposta técnica (docs/engineer/*.md) a partir do PRODUCT_SPEC."""
    product_spec = load_product_spec()
    assert len(product_spec) > 500, "PRODUCT_SPEC deve ter conteúdo suficiente"

    # Limite enviado ao agente (runner usa 15000)
    product_spec_trunc = product_spec[:15000]

    inputs = {
        "spec_ref": "docs/spec/PRODUCT_SPEC.md",
        "product_spec": product_spec_trunc,
        "constraints": ["spec-driven", "paths-resilient", "no-invent"],
    }
    body = {
        "request_id": "engineer-spec-test-e2e",
        "project_id": PROJECT_ID,
        "agent": "engineer",
        "mode": "generate_engineering_docs",
        "task_id": None,
        "task": "Gerar proposta técnica (stacks, squads, dependências) a partir do PRODUCT_SPEC.",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1},
    }

    try:
        async with httpx.AsyncClient(timeout=ENGINEER_TIMEOUT) as client:
            response = await client.post(
                "%s/invoke/engineer" % AGENTS_URL.rstrip("/"),
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
        "Engineer retornou status inesperado: %s" % result["status"]
    )

    artifacts = result.get("artifacts") or []
    engineer_paths = [a.get("path", "") for a in artifacts]

    if result["status"] == "OK":
        # Contrato: pelo menos 3 docs em docs/engineer/
        expected = [
            "docs/engineer/engineer_proposal.md",
            "docs/engineer/engineer_architecture.md",
            "docs/engineer/engineer_dependencies.md",
        ]
        for path in expected:
            has = any(path in p for p in engineer_paths)
            assert has, "Artifact obrigatório ausente: %s (paths: %s)" % (path, engineer_paths)

        # Conteúdo da proposta (para validação): engineer_proposal ou primeiro artifact
        proposal_content = ""
        for art in artifacts:
            if "engineer_proposal" in art.get("path", ""):
                proposal_content = art.get("content", "")
                break
        if not proposal_content and artifacts:
            proposal_content = artifacts[0].get("content", "")

        assert proposal_content, "Nenhum conteúdo de proposta nos artifacts"
        assert len(proposal_content) >= 400, "Proposta técnica muito curta (%d chars)" % len(proposal_content)

        errors = validate_engineer_proposal(proposal_content)
        assert not errors, "Engineer proposta: " + "; ".join(errors)

    # NEEDS_INFO/BLOCKED: resposta parseada; summary pode ter perguntas
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
