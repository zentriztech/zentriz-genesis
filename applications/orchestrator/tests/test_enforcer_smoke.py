"""
Smoke tests do Enforcer (Blueprint §10): validator por modo, repair_prompt, gates.
"""
import pytest


# --- get_requirements_for_mode ---

def test_get_requirements_implement_task():
    from orchestrator.envelope import get_requirements_for_mode
    req_art, req_ev = get_requirements_for_mode("Dev", "implement_task")
    assert req_art is True
    assert req_ev is True


def test_get_requirements_validate_task():
    from orchestrator.envelope import get_requirements_for_mode
    req_art, req_ev = get_requirements_for_mode("QA", "validate_task")
    assert req_art is True
    assert req_ev is True


def test_get_requirements_generate_backlog():
    from orchestrator.envelope import get_requirements_for_mode
    req_art, req_ev = get_requirements_for_mode("PM", "generate_backlog")
    assert req_art is True
    assert req_ev is True


# --- validate_response_envelope_for_mode (gates) ---

def test_validate_for_mode_implement_task_rejects_empty_artifacts():
    from orchestrator.envelope import validate_response_envelope_for_mode
    data = {"status": "OK", "summary": "Done", "artifacts": [], "evidence": [{"ref": "x"}], "next_actions": {}}
    ok, errs = validate_response_envelope_for_mode(data, "Dev", "implement_task")
    assert ok is False
    assert any("artefato" in e.lower() or "artifacts" in e for e in errs)


def test_validate_for_mode_validate_task_requires_qa_pass_or_qa_fail():
    from orchestrator.envelope import validate_response_envelope_for_mode
    data = {
        "status": "OK",
        "summary": "Review done",
        "artifacts": [{"path": "docs/qa/report.md", "content": "x"}],
        "evidence": [{"ref": "x"}],
        "next_actions": {},
    }
    ok, errs = validate_response_envelope_for_mode(data, "QA", "validate_task")
    assert ok is False
    assert any("QA_PASS" in e or "QA_FAIL" in e for e in errs)


def test_validate_for_mode_validate_task_accepts_qa_pass():
    from orchestrator.envelope import validate_response_envelope_for_mode
    data = {
        "status": "QA_PASS",
        "summary": "Aprovado",
        "artifacts": [{"path": "docs/qa/report.md", "content": "x"}],
        "evidence": [{"ref": "x"}],
        "next_actions": {},
    }
    ok, errs = validate_response_envelope_for_mode(data, "QA", "validate_task")
    assert ok is True
    assert len(errs) == 0


def test_validate_for_mode_path_traversal_rejected():
    from orchestrator.envelope import validate_response_envelope_for_mode
    data = {
        "status": "OK",
        "summary": "x",
        "artifacts": [{"path": "docs/../../../etc/passwd", "content": "x"}],
        "evidence": [{"ref": "x"}],
        "next_actions": {},
    }
    ok, errs = validate_response_envelope_for_mode(data, "Dev", "implement_task", task_id="t1")
    assert ok is False
    assert any("path" in e or "bloqueado" in e.lower() for e in errs)


def test_validate_for_mode_invalid_prefix_rejected():
    from orchestrator.envelope import validate_response_envelope_for_mode
    data = {
        "status": "OK",
        "summary": "x",
        "artifacts": [{"path": "other/secret.md", "content": "x"}],
        "evidence": [{"ref": "x"}],
        "next_actions": {},
    }
    ok, errs = validate_response_envelope_for_mode(data, "Dev", "implement_task")
    assert ok is False
    assert any("path" in e or "bloqueado" in e.lower() or "prefixo" in e.lower() for e in errs)


# --- repair_prompt ---

def test_repair_prompt_not_empty():
    from orchestrator.envelope import repair_prompt
    prompt = repair_prompt()
    assert isinstance(prompt, str)
    assert len(prompt) > 20
    assert "ResponseEnvelope" in prompt or "JSON" in prompt
    assert "docs/" in prompt or "project/" in prompt or "apps/" in prompt


# --- _build_message_envelope (runner) ---

def test_build_message_envelope_structure():
    from orchestrator.runner import _build_message_envelope
    env = _build_message_envelope(
        "req-1", "Dev", "backend", "implement_task",
        task_id="t1", task="Implementar X",
        inputs={"spec_ref": "spec.md", "backlog_summary": "..."},
        existing_artifacts=[],
        limits={"max_rework": 3},
    )
    assert env["request_id"] == "req-1"
    assert env["agent"] == "Dev"
    assert env["variant"] == "backend"
    assert env["mode"] == "implement_task"
    assert env["task_id"] == "t1"
    assert env["task"] == "Implementar X"
    assert env["inputs"]["spec_ref"] == "spec.md"
    assert "project_id" in env
    assert "input" in env  # compat
