"""test_spec_validator.py — RFC-0004 Onda 3 (estágio B): contrato + anti-injection."""
import json

import pytest

from spec_validator import validate_spec, REFUTER_SYSTEM, _FENCE_OPEN, _FENCE_CLOSE


def make_llm(response: str, calls: list):
    def llm(system: str, user: str, model_id: str, **kw) -> str:
        calls.append({"system": system, "user": user, "model": model_id, **kw})
        return response
    return llm


def test_contract_findings_passthrough():
    calls = []
    resp = json.dumps({"findings": [
        {"file": "01-spec.md", "line": 3, "severity": "warning", "title": "x", "rationale": "y"},
    ]})
    out = validate_spec("## Spec\ncorpo", llm_fn=make_llm(resp, calls))
    assert out["findings"][0]["title"] == "x"
    assert out["triage"] is None  # sem SPEC_VALIDATOR_TRIAGE_MODEL → triagem pulada


def test_spec_is_fenced_and_system_has_antiinjection():
    calls = []
    validate_spec("conteúdo do tenant", llm_fn=make_llm('{"findings":[]}', calls))
    user = calls[0]["user"]
    assert user.startswith(_FENCE_OPEN)
    assert user.rstrip().endswith(_FENCE_CLOSE)
    assert "conteúdo do tenant" in user
    # o framing anti-injection é parte do CONTRATO de segurança — não pode regredir
    assert "NÃO-CONFIÁVEL" in REFUTER_SYSTEM
    assert "prompt" in REFUTER_SYSTEM and "injection" in REFUTER_SYSTEM
    assert "NÃO tem ferramentas" in REFUTER_SYSTEM


def test_tolerates_code_fences_in_reply():
    calls = []
    resp = '```json\n{"findings":[{"file":"","line":null,"severity":"info","title":"t","rationale":"r"}]}\n```'
    out = validate_spec("spec", llm_fn=make_llm(resp, calls))
    assert len(out["findings"]) == 1


def test_invalid_contract_raises():
    calls = []
    with pytest.raises(ValueError):
        validate_spec("spec", llm_fn=make_llm('{"nada": true}', calls))
    with pytest.raises(Exception):
        validate_spec("spec", llm_fn=make_llm("prosa sem json", calls))


def test_triage_runs_when_model_configured(monkeypatch):
    monkeypatch.setenv("SPEC_VALIDATOR_TRIAGE_MODEL", "haiku-fake")
    calls = []

    def llm(system, user, model_id, **kw):
        calls.append(model_id)
        if model_id == "haiku-fake":
            return '{"is_spec": true, "summary": "s", "modules": ["a"]}'
        return '{"findings":[]}'

    out = validate_spec("spec", llm_fn=llm)
    assert out["triage"] == {"is_spec": True, "summary": "s", "modules": ["a"]}
    assert calls[0] == "haiku-fake"  # triagem primeiro (barata)


def test_triage_failure_does_not_block(monkeypatch):
    monkeypatch.setenv("SPEC_VALIDATOR_TRIAGE_MODEL", "haiku-fake")

    def llm(system, user, model_id, **kw):
        if model_id == "haiku-fake":
            raise RuntimeError("haiku indisponível")
        return '{"findings":[]}'

    out = validate_spec("spec", llm_fn=llm)
    assert out["triage"] is None
    assert out["findings"] == []
