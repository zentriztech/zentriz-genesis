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


# --- _extract_double_quoted / resilient_json_parse (LEI 4) ---


def test_extract_double_quoted_simple():
    from orchestrator.envelope import _extract_double_quoted
    s = '"hello"'
    val, end = _extract_double_quoted(s, 0)
    assert val == "hello"
    assert end == 7


def test_extract_double_quoted_with_escapes():
    from orchestrator.envelope import _extract_double_quoted
    s = r'"say \"hi\" and \n"'
    val, end = _extract_double_quoted(s, 0)
    assert "hi" in val or "\\" in val
    assert end == len(s)


def test_resilient_json_parse_tentativa1_direct():
    from orchestrator.envelope import resilient_json_parse
    raw = '{"status":"OK","summary":"x","artifacts":[],"evidence":[{"ref":"a"}],"next_actions":{}}'
    data, errs = resilient_json_parse(raw, "req-1")
    assert data["status"] == "OK"
    assert data["summary"] == "x"
    assert errs == []


def test_resilient_json_parse_with_content_escaped():
    """LEI 4: JSON válido com content contendo aspas escapadas é parseado pela Tentativa 1."""
    from orchestrator.envelope import resilient_json_parse
    raw = '{"status":"OK","summary":"x","artifacts":[{"path":"docs/a.md","content":"const x = \\"hello\\";\\n"}],"evidence":[],"next_actions":{}}'
    data, errs = resilient_json_parse(raw, "req-2")
    assert data["status"] == "OK"
    arts = data.get("artifacts") or []
    assert len(arts) == 1
    assert "hello" in arts[0].get("content", "")
    assert errs == []


def test_resilient_json_parse_tentativa3_fallback():
    from orchestrator.envelope import resilient_json_parse
    raw = '{"status":"OK","artifacts":[{"path":"docs/x.md","content": invalid}]}'
    data, errs = resilient_json_parse(raw, "req-3")
    assert data["status"] == "FAIL"
    assert "escaping" in data["summary"].lower() or "inválido" in data["summary"].lower()
    assert len(errs) >= 1


def test_resilient_json_parse_content_with_unescaped_quotes():
    """LEI 4: content com aspas não escapadas (ex.: markdown do CTO) é extraído por _extract_content_value_robust."""
    from orchestrator.envelope import resilient_json_parse
    # JSON inválido: "content" tem aspa interna não escapada (como a IA às vezes devolve)
    raw = '''{"status":"OK","summary":"Done","artifacts":[{"path":"docs/spec/PRODUCT_SPEC.md","content":"# Spec\\n\\nO produto \\"Landing\\" é estático.","format":"markdown"}],"evidence":[],"next_actions":{}}'''
    # Simular o que a IA envia (aspas internas NÃO escapadas):
    raw_bad = '''{"status":"OK","summary":"Done","artifacts":[{"path":"docs/spec/PRODUCT_SPEC.md","content":"# Spec

O produto "Landing" é estático.","format":"markdown"}],"evidence":[],"next_actions":{}}'''
    data, errs = resilient_json_parse(raw_bad, "req-4")
    assert data["status"] == "OK", "Tentativa 2 com extrator robusto deve parsear content com aspas internas"
    arts = data.get("artifacts") or []
    assert len(arts) == 1
    assert "Landing" in arts[0].get("content", "")
    assert "Spec" in arts[0].get("content", "")
    assert errs == []


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


def test_parse_response_extracts_json_from_response_tags():
    """AGENT_LLM_COMMUNICATION_ANALYSIS: JSON pode vir dentro de <response>...</response>."""
    from orchestrator.envelope import parse_response_envelope
    raw = """<thinking>
Analisando a spec...
</thinking>

<response>
{"status":"OK","summary":"Spec convertida","artifacts":[],"evidence":[{"ref":"x"}],"next_actions":{}}
</response>"""
    data, errs = parse_response_envelope(raw, "req-response-tags")
    assert data["status"] == "OK"
    assert data["summary"] == "Spec convertida"
    assert len(errs) == 0


def test_resilient_json_parse_truncated_response():
    """Resposta truncada (sem </response>): extrai JSON parcial e content até o fim."""
    from orchestrator.envelope import resilient_json_parse
    # Simula resposta que cortou no meio do "content" (max_tokens)
    raw = """<thinking>Planejando...</thinking>

<response>
{
  "status": "OK",
  "summary": "Spec convertida.",
  "artifacts": [
    {
      "path": "docs/spec/PRODUCT_SPEC.md",
      "format": "markdown",
      "purpose": "Spec",
      "content": "# PRODUCT SPEC\\n\\n## 0. Metadados\\n- Item 1\\n- Item 2
"""
    data, errs = resilient_json_parse(raw, "req-trunc")
    assert len(errs) == 0
    assert data["status"] == "OK"
    assert data["summary"] == "Spec convertida."
    arts = data.get("artifacts") or []
    assert len(arts) == 1
    assert arts[0]["path"] == "docs/spec/PRODUCT_SPEC.md"
    assert "PRODUCT SPEC" in arts[0].get("content", "")
    assert "## 0. Metadados" in arts[0].get("content", "")


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

def test_validate_response_quality_ok():
    from orchestrator.envelope import validate_response_quality
    r = {"status": "OK", "summary": "Done", "artifacts": [{"path": "docs/x.md", "content": "x" * 150}], "evidence": [{}]}
    ok, errs = validate_response_quality("cto", r)
    assert ok is True
    assert len(errs) == 0


def test_validate_response_quality_fail_short_artifact():
    from orchestrator.envelope import validate_response_quality
    r = {"status": "OK", "summary": "Done", "artifacts": [{"path": "docs/x.md", "content": "short"}], "evidence": [{}]}
    ok, errs = validate_response_quality("cto", r)
    assert ok is False
    assert any("muito curto" in e for e in errs)


def test_validate_response_quality_fail_placeholder():
    from orchestrator.envelope import validate_response_quality
    r = {"status": "OK", "summary": "Done", "artifacts": [{"path": "apps/x.js", "content": "// TODO implement"}], "evidence": [{}]}
    ok, errs = validate_response_quality("dev", r)
    assert ok is False
    assert any("TODO" in e for e in errs)


def test_extract_thinking():
    from orchestrator.envelope import extract_thinking
    raw = """<thinking>
Analisando a spec...
Vou mapear FR-01 para vitrine.
</thinking>
<response>
{"status":"OK","summary":"Ok","artifacts":[],"evidence":[],"next_actions":{}}
</response>"""
    out = extract_thinking(raw)
    assert "Analisando a spec" in out
    assert "FR-01" in out
    assert "vitrine" in out


def test_extract_thinking_empty_when_no_tags():
    from orchestrator.envelope import extract_thinking
    assert extract_thinking('{"status":"OK"}') == ""
    assert extract_thinking("") == ""


def test_repair_prompt_non_empty():
    from orchestrator.envelope import repair_prompt
    p = repair_prompt()
    assert isinstance(p, str)
    assert "JSON" in p
    assert "ResponseEnvelope" in p or "response_envelope" in p.lower()
    assert "docs/" in p or "apps/" in p or "project/" in p
