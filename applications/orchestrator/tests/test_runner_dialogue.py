"""
Testes de integração do fluxo do runner e do módulo de diálogo.
- Geração de summary_human (templates em português).
- Persistência de diálogo (comportamento quando API não configurada).
"""
import os

import pytest


@pytest.fixture(autouse=True)
def clear_dialogue_env():
    """Garante que PROJECT_ID e API_BASE_URL não vazem de ambiente."""
    before = os.environ.get("PROJECT_ID"), os.environ.get("API_BASE_URL"), os.environ.get("GENESIS_API_TOKEN")
    if "PROJECT_ID" in os.environ:
        del os.environ["PROJECT_ID"]
    if "API_BASE_URL" in os.environ:
        del os.environ["API_BASE_URL"]
    if "GENESIS_API_TOKEN" in os.environ:
        del os.environ["GENESIS_API_TOKEN"]
    yield
    for k in ("PROJECT_ID", "API_BASE_URL", "GENESIS_API_TOKEN"):
        if k in os.environ:
            del os.environ[k]
    for k, v in zip(("PROJECT_ID", "API_BASE_URL", "GENESIS_API_TOKEN"), before):
        if v is not None:
            os.environ[k] = v


def test_build_summary_human_cto_engineer_request():
    from orchestrator.dialogue import build_summary_human
    out = build_summary_human("cto.engineer.request", "cto", "engineer", "")
    assert "CTO" in out and "Engineer" in out
    assert "especificação" in out or "equipes" in out or "squads" in out


def test_build_summary_human_engineer_cto_response():
    from orchestrator.dialogue import build_summary_human
    out = build_summary_human("engineer.cto.response", "engineer", "cto", "")
    assert "Engineer" in out and "CTO" in out
    assert "proposta" in out or "técnica" in out


def test_build_summary_human_project_created():
    from orchestrator.dialogue import build_summary_human
    out = build_summary_human("project.created", "cto", "pm", "")
    assert "Charter" in out or "CTO" in out


def test_build_summary_human_module_planned():
    from orchestrator.dialogue import build_summary_human
    out = build_summary_human("module.planned", "pm", "cto", "")
    assert "PM" in out or "backlog" in out


def test_build_summary_human_generic():
    from orchestrator.dialogue import build_summary_human
    out = build_summary_human("unknown.event", "cto", "engineer", "")
    assert "CTO" in out and "Engineer" in out


def test_get_summary_human_uses_template_when_no_llm_url():
    from orchestrator.dialogue import get_summary_human
    out = get_summary_human("cto.engineer.request", "cto", "engineer", "")
    assert out and isinstance(out, str)
    assert "CTO" in out or "Engineer" in out


def test_post_dialogue_returns_false_when_project_id_unset():
    from orchestrator.dialogue import post_dialogue
    assert post_dialogue("", "cto", "engineer", "Resumo.", event_type="cto.engineer.request", request_id="x") is False


# ── Onda D (épico spec-rica): seletor de variante DevOps (docker default; IaC só com flag) ──
def test_select_devops_variant_defaults_docker_without_flag(tmp_path, monkeypatch):
    from orchestrator.runner import _select_devops_variant
    monkeypatch.delenv("GENESIS_IAC_DEVOPS", raising=False)
    spec = tmp_path / "s.md"
    spec.write_text("distribuição: terraform em AWS RDS", encoding="utf-8")
    # flag desligado → docker, mesmo com terraform+provider declarados (no-op byte-a-byte em prod)
    assert _select_devops_variant(str(spec)) == ("docker", "docker")


def test_select_devops_variant_picks_provider_with_flag(tmp_path, monkeypatch):
    from orchestrator.runner import _select_devops_variant
    monkeypatch.setenv("GENESIS_IAC_DEVOPS", "true")
    spec = tmp_path / "s.md"
    spec.write_text("Distribuição: Terraform no Azure (AKS)", encoding="utf-8")
    assert _select_devops_variant(str(spec)) == ("azure", "azure")
    spec.write_text("terraform, google cloud GKE", encoding="utf-8")
    assert _select_devops_variant(str(spec)) == ("gcp", "gcp")
    spec.write_text("provisionar via terraform em AWS ECS/Fargate", encoding="utf-8")
    assert _select_devops_variant(str(spec)) == ("aws", "aws")


def test_select_devops_variant_conservative_when_ambiguous(tmp_path, monkeypatch):
    from orchestrator.runner import _select_devops_variant
    monkeypatch.setenv("GENESIS_IAC_DEVOPS", "true")
    spec = tmp_path / "s.md"
    # sem 'terraform' → docker; com terraform mas sem provider claro → docker (não adivinha)
    spec.write_text("docker-compose single-host, postgres 16 e redis 7", encoding="utf-8")
    assert _select_devops_variant(str(spec)) == ("docker", "docker")
    spec.write_text("provisionar via terraform, provider a definir", encoding="utf-8")
    assert _select_devops_variant(str(spec)) == ("docker", "docker")
    # path inexistente → docker
    assert _select_devops_variant(str(tmp_path / "nope.md")) == ("docker", "docker")


def test_select_devops_variant_word_boundary_no_substring_misfire(tmp_path, monkeypatch):
    # Achado adversarial: "flaws"/"weeks" contêm "aws"/"eks" como SUBSTRING — não podem casar provider.
    from orchestrator.runner import _select_devops_variant
    monkeypatch.setenv("GENESIS_IAC_DEVOPS", "true")
    spec = tmp_path / "s.md"
    # terraform + prosa com "flaws"/"weeks", provider real = azure → deve resolver azure, não aws
    spec.write_text("terraform no Azure; corrigimos flaws em poucas weeks", encoding="utf-8")
    assert _select_devops_variant(str(spec)) == ("azure", "azure")
    # terraform + só prosa ambígua (flaws/weeks), sem provider real → docker (não aws)
    spec.write_text("terraform; sem flaws, entrega em weeks", encoding="utf-8")
    assert _select_devops_variant(str(spec)) == ("docker", "docker")
