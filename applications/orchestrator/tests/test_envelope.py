"""
Testes do módulo envelope (Blueprint Fase 5): validator ResponseEnvelope, sanitizer de path, repair.
"""
import json
import pytest


# --- sanitize_artifact_path ---

def test_sanitize_path_allowed_docs():
    from orchestrator.envelope import sanitize_artifact_path
    assert sanitize_artifact_path("docs/spec/PRODUCT_SPEC.md", "p1") == "docs/spec/PRODUCT_SPEC.md"
    assert sanitize_artifact_path("docs/cto/charter.md", None) == "docs/cto/charter.md"


def test_sanitize_path_allowed_project_and_apps():
    from orchestrator.envelope import sanitize_artifact_path
    assert sanitize_artifact_path("project/Dockerfile", "p1") == "project/Dockerfile"
    assert sanitize_artifact_path("apps/src/index.js", "p1") == "apps/src/index.js"


def test_sanitize_path_blocked_traversal():
    from orchestrator.envelope import sanitize_artifact_path
    assert sanitize_artifact_path("docs/../../../etc/passwd", "p1") is None
    assert sanitize_artifact_path("..", "p1") is None
    assert sanitize_artifact_path("docs/foo/../bar", "p1") is None


def test_sanitize_path_blocked_absolute_and_home():
    from orchestrator.envelope import sanitize_artifact_path
    assert sanitize_artifact_path("/etc/passwd", "p1") is None
    assert sanitize_artifact_path("~/secret", "p1") is None


def test_sanitize_path_blocked_invalid_prefix():
    from orchestrator.envelope import sanitize_artifact_path
    assert sanitize_artifact_path("other/file.md", "p1") is None
    assert sanitize_artifact_path("", "p1") is None


# --- validate_response_envelope ---

def test_validate_response_ok():
    from orchestrator.envelope import validate_response_envelope
    data = {"status": "OK", "summary": "Done", "artifacts": [], "evidence": [{"ref": "x"}], "next_actions": {}}
    ok, errs = validate_response_envelope(data, require_evidence_when_ok=True)
    assert ok is True
    assert len(errs) == 0


def test_validate_response_fail_status_invalid():
    from orchestrator.envelope import validate_response_envelope
    data = {"status": "INVALID", "summary": "x", "artifacts": [], "evidence": [], "next_actions": {}}
    ok, errs = validate_response_envelope(data)
    assert ok is False
    assert any("status" in e for e in errs)


def test_validate_response_require_artifacts():
    from orchestrator.envelope import validate_response_envelope
    data = {"status": "OK", "summary": "x", "artifacts": [], "evidence": [], "next_actions": {}}
    ok, errs = validate_response_envelope(data, require_artifacts=True)
    assert ok is False
    assert any("artifacts" in e or "artefato" in e.lower() for e in errs)


def test_validate_response_artifacts_path_blocked():
    from orchestrator.envelope import validate_response_envelope
    data = {
        "status": "OK", "summary": "x",
        "artifacts": [{"path": "/etc/passwd", "content": "x"}],
        "evidence": [], "next_actions": {},
    }
    ok, errs = validate_response_envelope(data)
    assert ok is False
    assert any("path" in e or "bloqueado" in e.lower() for e in errs)


# --- parse_response_envelope ---

def test_parse_response_valid_json():
    from orchestrator.envelope import parse_response_envelope
    raw = '{"status":"OK","summary":"Hi","artifacts":[],"evidence":[],"next_actions":{}}'
    data, errs = parse_response_envelope(raw, "req-1")
    assert data["status"] == "OK"
    assert data["summary"] == "Hi"
    assert data["request_id"] == "req-1"
    assert isinstance(data["artifacts"], list)
    assert isinstance(data["next_actions"], dict)


def test_parse_response_json_in_code_block():
    from orchestrator.envelope import parse_response_envelope
    raw = 'Text before\n```json\n{"status":"QA_PASS","summary":"OK","artifacts":[],"evidence":[],"next_actions":{}}\n```'
    data, errs = parse_response_envelope(raw, "req-2")
    assert data["status"] == "QA_PASS"
    assert "Resposta não contém" not in str(errs) or data.get("status") == "QA_PASS"


def test_parse_response_invalid_json_returns_fail_envelope():
    from orchestrator.envelope import parse_response_envelope
    raw = "not json at all"
    data, errs = parse_response_envelope(raw, "req-3")
    assert data["status"] == "FAIL"
    assert len(errs) >= 1


# --- filter_artifacts_by_path_policy ---

def test_filter_artifacts_keeps_allowed():
    from orchestrator.envelope import filter_artifacts_by_path_policy
    arts = [
        {"path": "apps/index.js", "content": "x"},
        {"path": "docs/qa/report.md", "content": "y"},
    ]
    out = filter_artifacts_by_path_policy(arts, "p1")
    assert len(out) == 2
    assert out[0]["path"] == "apps/index.js"
    assert out[1]["path"] == "docs/qa/report.md"


def test_filter_artifacts_removes_blocked():
    from orchestrator.envelope import filter_artifacts_by_path_policy
    arts = [
        {"path": "apps/ok.js", "content": "x"},
        {"path": "../../../etc/passwd", "content": "y"},
    ]
    out = filter_artifacts_by_path_policy(arts, "p1")
    assert len(out) == 1
    assert out[0]["path"] == "apps/ok.js"


# --- repair_prompt ---

def test_repair_prompt_non_empty():
    from orchestrator.envelope import repair_prompt
    p = repair_prompt()
    assert isinstance(p, str)
    assert "JSON" in p
    assert "ResponseEnvelope" in p or "response_envelope" in p.lower()
    assert "docs/" in p or "apps/" in p or "project/" in p
