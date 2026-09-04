"""test_spec_validator.py — RFC-0004 Onda 3 (estágio B): contrato + anti-injection."""
import json

import pytest

from spec_validator import (
    validate_spec,
    REFUTER_SYSTEM,
    CONSOLIDATE_SYSTEM,
    _FENCE_OPEN,
    _FENCE_CLOSE,
)


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


# ── Onda B (épico spec-rica): estabilização por multi-voto ────────────────────
def test_lenses_and_connect_in_refuter_system():
    # As lentes de especialista + Connect-compliance são parte do contrato do refutador.
    assert "LENTES" in REFUTER_SYSTEM
    assert "CONNECT-COMPLIANCE" in REFUTER_SYSTEM
    assert "systemId" in REFUTER_SYSTEM


def test_multivote_runs_n_refuters_then_consolidates(monkeypatch):
    monkeypatch.setenv("SPEC_VALIDATOR_VOTES", "3")
    calls = {"refuter": 0, "consolidate": 0}

    def llm(system, user, model_id, **kw):
        if system == CONSOLIDATE_SYSTEM:
            calls["consolidate"] += 1
            # a temperatura da consolidação é forçada baixa (clustering estável)
            assert kw.get("temperature") == 0.2
            payload = json.loads(user)
            assert payload["runs"] == 3 and payload["threshold"] == 2
            assert len(payload["analyses"]) == 3
            return json.dumps({"findings": [
                {"file": "", "line": None, "severity": "blocker", "title": "núcleo", "rationale": "r", "votes": 3},
            ]})
        calls["refuter"] += 1
        return json.dumps({"findings": [
            {"file": "", "line": None, "severity": "blocker", "title": "núcleo", "rationale": "r"},
        ]})

    out = validate_spec("spec substantiva", llm_fn=llm)
    assert calls["refuter"] == 3  # N refutações independentes
    assert calls["consolidate"] == 1  # 1 consolidação por maioria
    assert len(out["findings"]) == 1 and out["findings"][0]["title"] == "núcleo"


def test_multivote_fallback_when_consolidation_fails(monkeypatch):
    monkeypatch.setenv("SPEC_VALIDATOR_VOTES", "3")

    def llm(system, user, model_id, **kw):
        if system == CONSOLIDATE_SYSTEM:
            return "prosa sem json"  # consolidação quebra → fallback
        # análise mais completa deve vencer o fallback (max por len)
        return json.dumps({"findings": [
            {"file": "", "line": None, "severity": "warning", "title": "a", "rationale": "r"},
            {"file": "", "line": None, "severity": "info", "title": "b", "rationale": "r"},
        ]})

    out = validate_spec("spec", llm_fn=llm)
    # fallback não esconde problemas: devolve a análise mais completa
    assert len(out["findings"]) == 2
