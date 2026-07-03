"""
Testes T-02: loader de type_policy + resolução via aliases + fallback embutido.

Cenários (todos exigidos pelo gate de saída T-02):
- Tipo válido canônico → policy correta.
- Tipo em type_aliases → resolve para canônico.
- Tipo desconhecido → resolve para _default (com blocks_generation=True).
- inputs["type_policy"] presente em build_inputs_for_cto/engineer/pm/dev.
- enforcement_mode reflete env POLICY_ENFORCEMENT_ENABLED (T-02f).
"""
import os

import pytest


# ── _resolve_type ──────────────────────────────────────────────────────────────

def test_resolve_type_canonical_returns_policy():
    from orchestrator.pipeline_context import _resolve_type

    canonical, pol = _resolve_type("backend_api")
    assert canonical == "backend_api"
    assert "required_routes" in pol
    assert "POST /auth/login" in pol["required_routes"]["strict"]


def test_resolve_type_via_alias_returns_canonical():
    from orchestrator.pipeline_context import _resolve_type

    # frontend_webapp é alias para frontend_dashboard (telegram detectProjectType)
    canonical, pol = _resolve_type("frontend_webapp")
    assert canonical == "frontend_dashboard"
    assert "/dashboard" in pol["required_routes"]["strict"]


def test_resolve_type_mobile_alias():
    from orchestrator.pipeline_context import _resolve_type

    canonical, _ = _resolve_type("mobile_app")
    assert canonical == "mobile_crossplatform"


def test_resolve_type_unknown_returns_default_strict():
    from orchestrator.pipeline_context import _resolve_type

    canonical, pol = _resolve_type("something_never_seen_xyz")
    assert canonical == "_default"
    assert pol["meta"]["blocks_generation"] is True
    assert "*" in pol["forbidden_patterns"]


def test_resolve_type_empty_returns_default():
    from orchestrator.pipeline_context import _resolve_type

    canonical, _ = _resolve_type("")
    assert canonical == "_default"


def test_resolve_type_none_returns_default():
    from orchestrator.pipeline_context import _resolve_type

    canonical, _ = _resolve_type(None)
    assert canonical == "_default"


# ── backend_api_python NÃO aliaseia para backend_api ──────────────────────────

def test_backend_api_python_is_own_canonical():
    """
    Regra do plano §2: stack Python vs Node é incompatível.
    backend_api_python NÃO pode ser alias para backend_api.
    """
    from orchestrator.pipeline_context import _resolve_type

    canonical, pol = _resolve_type("backend_api_python")
    assert canonical == "backend_api_python"
    # Deve ter os bugs Python codificados
    assert any("setuptools" in p.lower() for p in pol["forbidden_patterns"])


# ── _build_type_policy_input (payload para os agentes) ────────────────────────

def test_build_type_policy_input_structure():
    from orchestrator.pipeline_context import _build_type_policy_input

    payload = _build_type_policy_input("frontend_dashboard")
    assert payload["canonical_type"] == "frontend_dashboard"
    assert payload["resolved_from"] == "frontend_dashboard"
    assert payload["enforcement_mode"] in ("warn", "blocker")
    assert "policy" in payload
    assert "policy_version" in payload


def test_build_type_policy_input_records_original_alias():
    from orchestrator.pipeline_context import _build_type_policy_input

    payload = _build_type_policy_input("static_site")  # alias → frontend_landing
    assert payload["canonical_type"] == "frontend_landing"
    assert payload["resolved_from"] == "static_site"


# ── enforcement_mode via env (T-02f) ─────────────────────────────────────────

def test_enforcement_mode_default_is_warn(monkeypatch):
    from orchestrator.pipeline_context import _build_type_policy_input

    monkeypatch.delenv("POLICY_ENFORCEMENT_ENABLED", raising=False)
    payload = _build_type_policy_input("backend_api")
    assert payload["enforcement_mode"] == "warn"


def test_enforcement_mode_true_becomes_blocker(monkeypatch):
    from orchestrator.pipeline_context import _build_type_policy_input

    monkeypatch.setenv("POLICY_ENFORCEMENT_ENABLED", "true")
    payload = _build_type_policy_input("backend_api")
    assert payload["enforcement_mode"] == "blocker"


def test_enforcement_mode_false_explicit_stays_warn(monkeypatch):
    from orchestrator.pipeline_context import _build_type_policy_input

    monkeypatch.setenv("POLICY_ENFORCEMENT_ENABLED", "false")
    payload = _build_type_policy_input("backend_api")
    assert payload["enforcement_mode"] == "warn"


# ── build_inputs_for_* injetam type_policy ────────────────────────────────────

def test_build_inputs_for_cto_includes_type_policy():
    from orchestrator.pipeline_context import PipelineContext

    ctx = PipelineContext("proj-cto")
    ctx.project_type = "backend_api"
    ctx.set_spec_raw("dummy spec")
    inputs = ctx.build_inputs_for_cto(mode="charter")
    assert "type_policy" in inputs
    assert inputs["type_policy"]["canonical_type"] == "backend_api"


def test_build_inputs_for_engineer_includes_type_policy():
    from orchestrator.pipeline_context import PipelineContext

    ctx = PipelineContext("proj-eng")
    ctx.project_type = "frontend_dashboard"
    inputs = ctx.build_inputs_for_engineer()
    assert "type_policy" in inputs
    assert inputs["type_policy"]["canonical_type"] == "frontend_dashboard"


def test_build_inputs_for_pm_includes_type_policy():
    from orchestrator.pipeline_context import PipelineContext

    ctx = PipelineContext("proj-pm")
    ctx.project_type = "frontend_landing"
    inputs = ctx.build_inputs_for_pm()
    assert "type_policy" in inputs
    assert inputs["type_policy"]["canonical_type"] == "frontend_landing"


def test_build_inputs_for_dev_includes_type_policy():
    from orchestrator.pipeline_context import PipelineContext

    ctx = PipelineContext("proj-dev")
    ctx.project_type = "backend_api_python"
    inputs = ctx.build_inputs_for_dev(task={}, task_description="")
    assert "type_policy" in inputs
    assert inputs["type_policy"]["canonical_type"] == "backend_api_python"


def test_build_inputs_with_empty_project_type_falls_back_to_default():
    from orchestrator.pipeline_context import PipelineContext

    ctx = PipelineContext("proj-empty")
    ctx.project_type = ""
    ctx.set_spec_raw("dummy")
    inputs = ctx.build_inputs_for_cto(mode="charter")
    assert inputs["type_policy"]["canonical_type"] == "_default"
    assert inputs["type_policy"]["policy"]["meta"]["blocks_generation"] is True


# ── T-03f: previous_project_type em Evolution ────────────────────────────────

def test_previous_project_type_not_injected_when_absent():
    """CTO só recebe previous_project_type se houver — sem falso positivo."""
    from orchestrator.pipeline_context import PipelineContext

    ctx = PipelineContext("proj-fresh")
    ctx.project_type = "frontend_dashboard"
    ctx.set_spec_raw("dummy")
    inputs = ctx.build_inputs_for_cto(mode="charter")
    assert "previous_project_type" not in inputs


def test_previous_project_type_injected_in_evolution():
    """Em Evolution, runner popula ctx.previous_project_type; CTO deve receber."""
    from orchestrator.pipeline_context import PipelineContext

    ctx = PipelineContext("proj-evo")
    ctx.project_type = "frontend_landing"           # tipo novo
    ctx.previous_project_type = "frontend_dashboard"  # tipo do Charter pai
    ctx.set_spec_raw("dummy")
    inputs = ctx.build_inputs_for_cto(mode="charter")
    assert inputs["previous_project_type"] == "frontend_dashboard"
    assert inputs["type_policy"]["canonical_type"] == "frontend_landing"
    # Gate T-TYPE-COMPLIANCE-EVO no CTO usa esses dois valores para BLOCKER se
    # transição não tiver "## Type Transition" no Charter.


# ── policies.json bate byte-a-byte com YAML fresh ─────────────────────────────

def test_policies_json_is_in_sync_with_yaml():
    """
    Gate T-02: gerar policies.json 2x produz mesmo output; JSON commited bate.
    """
    import json
    from pathlib import Path

    REPO_ROOT = Path(__file__).resolve().parents[3]
    JSON_PATH = REPO_ROOT / "applications/services/api-node/src/generated/policies.json"

    if not JSON_PATH.exists():
        pytest.skip("policies.json ainda não gerado — rode scripts/generate_policies_json.py")

    # Não regenera fisicamente aqui — a suite completa deve rodar --check via CI/prebuild.
    # Aqui verifica só a estrutura mínima.
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    assert data["version"].startswith("0.")
    assert "types" in data
    assert "type_aliases" in data
    assert "_default" in data["types"]
    assert data["types"]["_default"]["meta"]["blocks_generation"] is True
