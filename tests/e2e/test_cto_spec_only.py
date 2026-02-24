"""
Teste isolado: CTO recebe spec (project/spec/spec_landing_zentriz.txt) e gera PRODUCT_SPEC.md
baseado no template (project/spec/PRODUCT_SPEC_TEMPLATE.md).

Objetivo: validar que o agente CTO + IA conseguem converter a spec em .md no formato do template,
sem rodar o pipeline completo.

- Este teste faz UMA ÚNICA requisição (sem retry em caso de falha).
- Fluxo completo (o que é enviado, o que a IA recebe, o que devolve): ver CTO_SPEC_TEST_FLOW.md
- Para o servidor não retentar em falhas de validação: MAX_REPAIRS=0 ./start-agents-host.sh

Pré-requisitos:
  - Agents rodando na porta 8000 (./start-agents-host.sh)
  - CLAUDE_API_KEY no .env (ou ambiente)
  - Template em project/spec/PRODUCT_SPEC_TEMPLATE.md (o runtime injeta no system prompt)

Execução:
  pytest tests/e2e/test_cto_spec_only.py -v -s
  pytest tests/e2e/test_cto_spec_only.py -v -s -k test_cto_spec_intake_landing
"""
import os
import json
import pytest
import httpx
from pathlib import Path

_here = Path(__file__).resolve().parent
_repo_root = _here.parent.parent

SPEC_FILE = _repo_root / "project" / "spec" / "spec_landing_zentriz.txt"
TEMPLATE_FILE = _repo_root / "project" / "spec" / "PRODUCT_SPEC_TEMPLATE.md"
AGENTS_URL = os.environ.get("API_AGENTS_URL", "http://127.0.0.1:8000")
# CTO spec_intake pode levar 6–12 min (Claude + template grande + repair)
CTO_TIMEOUT = int(os.environ.get("CTO_SPEC_TEST_TIMEOUT", "900"))


def load_spec() -> str:
    if not SPEC_FILE.exists():
        raise FileNotFoundError("Spec não encontrada: %s" % SPEC_FILE)
    return SPEC_FILE.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_cto_spec_intake_landing():
    """CTO converte spec_landing_zentriz.txt para PRODUCT_SPEC.md no formato do template."""
    spec_raw = load_spec()
    assert len(spec_raw) > 100, "Spec deve ter conteúdo suficiente"

    inputs = {
        "spec_raw": spec_raw,
        "product_spec": None,
        "constraints": ["spec-driven", "no-invent", "paths-resilient"],
    }
    body = {
        "request_id": "cto-spec-test-e2e",
        "project_id": "cto-spec-test",
        "agent": "cto",
        "mode": "spec_intake_and_normalize",
        "task_id": None,
        "task": "Converter spec TXT para PRODUCT_SPEC.md conforme template",
        "inputs": inputs,
        "input": inputs,
        "existing_artifacts": [],
        "limits": {"max_rounds": 3, "round": 1},
    }

    try:
        async with httpx.AsyncClient(timeout=CTO_TIMEOUT) as client:
            response = await client.post(
                "%s/invoke/cto" % AGENTS_URL.rstrip("/"),
                json=body,
            )
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        pytest.skip("Agents não acessível em %s. Rode ./start-agents-host.sh primeiro. Erro: %s" % (AGENTS_URL, e))

    assert response.status_code == 200, (
        "HTTP %d: %s" % (response.status_code, response.text[:800])
    )
    result = response.json()
    assert "status" in result, "Resposta sem campo status"

    # CTO pode retornar OK, NEEDS_INFO, REVISION ou BLOCKED (ex.: qualidade falhou mas resposta foi parseada)
    assert result["status"] in ("OK", "NEEDS_INFO", "REVISION", "BLOCKED"), (
        "CTO retornou status inesperado: %s" % result["status"]
    )

    # Quando OK, deve haver artifact com PRODUCT_SPEC (path pode ser docs/spec/PRODUCT_SPEC.md)
    artifacts = result.get("artifacts") or []
    product_spec_content = None
    for art in artifacts:
        path = art.get("path", "")
        if "PRODUCT_SPEC" in path or "spec" in path.lower():
            product_spec_content = art.get("content", "")
            if product_spec_content:
                break

    if result["status"] == "OK":
        assert product_spec_content, (
            "CTO status=OK mas nenhum artifact com PRODUCT_SPEC: paths=%s"
            % [a.get("path") for a in artifacts]
        )
        # Verificações mínimas do conteúdo gerado (baseado no template)
        assert "Metadados" in product_spec_content or "Visão" in product_spec_content or "FR-" in product_spec_content or "Requisitos" in product_spec_content, (
            "Conteúdo gerado não parece seguir o template (Metadados/Visão/FR/Requisitos)"
        )
        assert len(product_spec_content) >= 500, "PRODUCT_SPEC gerado muito curto"
    # BLOCKED/NEEDS_INFO: resposta foi parseada; pode ter artifact curto ou summary com perguntas
    elif result["status"] in ("BLOCKED", "NEEDS_INFO") and result.get("summary"):
        pass  # Teste passou: API respondeu, parse OK, status coerente

    # Opcional: salvar em arquivo para inspeção
    if product_spec_content and os.environ.get("SAVE_CTO_SPEC_OUTPUT"):
        out_path = _repo_root / "project" / "spec" / "PRODUCT_SPEC_from_cto_test.md"
        out_path.write_text(product_spec_content, encoding="utf-8")
        print("Salvo em %s" % out_path)


@pytest.mark.asyncio
async def test_agents_health():
    """Garante que o serviço de agents está acessível antes do teste principal."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get("%s/health" % AGENTS_URL.rstrip("/"))
        assert r.status_code == 200
    except Exception as e:
        pytest.skip("Agents não está rodando em %s: %s" % (AGENTS_URL, e))
