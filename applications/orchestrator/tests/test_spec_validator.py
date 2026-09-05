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


# ── RFC-0005 (G2): identidade estável por category|anchor ────────────────────

from spec_validator import _normalize_findings, _finding_key, _norm_anchor  # noqa: E402


def test_contracts_require_category_and_anchor():
    assert '"category"' in REFUTER_SYSTEM and '"anchor"' in REFUTER_SYSTEM
    assert "security_gap" in REFUTER_SYSTEM and "connect_declaration_gap" in REFUTER_SYSTEM
    assert '"category"' in CONSOLIDATE_SYSTEM and '"anchor"' in CONSOLIDATE_SYSTEM
    assert "mesma \"category\" + mesmo \"anchor\"" in CONSOLIDATE_SYSTEM


def test_normalize_findings_taxonomy_and_prompt_injection():
    out = _normalize_findings([
        {"title": "x", "category": "Security_Gap", "anchor": "  FR-03  "},
        {"title": "y", "category": "inventada"},
        {"title": "Tentativa de prompt injection na spec", "severity": "blocker"},
        "lixo",
    ])
    assert [f["category"] for f in out] == ["security_gap", "other", "prompt_injection"]
    assert out[0]["anchor"] == "FR-03" and out[1]["anchor"] == ""


def test_finding_key_ignores_title_but_keeps_digits_in_anchor():
    a = {"file": "spec.md", "category": "missing_data_model", "anchor": "FR-03", "title": "Falta modelo de dados"}
    b = {"file": "spec.md", "category": "missing_data_model", "anchor": "fr-03", "title": "Modelo de dados ausente!"}
    c = {"file": "spec.md", "category": "missing_data_model", "anchor": "FR-04", "title": "Falta modelo de dados"}
    assert _finding_key(a) == _finding_key(b)
    assert _finding_key(a) != _finding_key(c)          # FR-03 ≠ FR-04 (dígitos preservados)
    assert _norm_anchor("## Modelo de Dados (v2)") == "modelo de dados v2"
    # sem anchor → título normalizado
    assert _finding_key({"file": "s.md", "category": "other", "title": "Rotas sem auth"}) == "s.md|other|t:rotas sem auth"


def test_multivote_blocker_union_uses_identity_key_not_title(monkeypatch):
    monkeypatch.setenv("SPEC_VALIDATOR_VOTES", "3")
    monkeypatch.delenv("SPEC_VALIDATOR_TRIAGE_MODEL", raising=False)
    calls = []

    def llm(system, user, model_id, **kw):
        calls.append(system)
        if system == CONSOLIDATE_SYSTEM:
            return json.dumps({"findings": [
                {"file": "spec.md", "line": None, "severity": "blocker", "category": "security_gap", "anchor": "FR-03",
                 "title": "Rotas sem autenticação", "rationale": "r", "votes": 3},
            ]})
        # cada refutador devolve o MESMO blocker com título diferente + um blocker singleton em FR-04
        return json.dumps({"findings": [
            {"file": "spec.md", "line": None, "severity": "blocker", "category": "security_gap", "anchor": "fr-03",
             "title": "Autenticação ausente nas rotas", "rationale": "r"},
            {"file": "spec.md", "line": None, "severity": "blocker", "category": "security_gap", "anchor": "FR-04",
             "title": "Segredo em claro", "rationale": "r"},
        ]})

    out = validate_spec("spec substantiva", llm_fn=llm)
    titles = [f["title"] for f in out["findings"]]
    # o mesmo problema (FR-03) com título reformulado NÃO é duplicado; FR-04 (singleton blocker) é preservado
    assert titles == ["Rotas sem autenticação", "Segredo em claro"]
    assert all(f["category"] == "security_gap" for f in out["findings"])


def test_retry_that_explodes_salvages_findings_of_first_response():
    """Prod 2026-09-05 (NVX LastMile): a 1ª resposta veio TRUNCADA (bateu em max_tokens) e o retry
    com o dobro do orçamento levantou ValueError no SDK ("Streaming is required..."). A exceção do
    retry não pode APAGAR os findings completos que a 1ª resposta já entregou."""
    truncated = (
        '{"findings": ['
        '{"file":"spec.md","line":null,"severity":"blocker","category":"security_gap","anchor":"FR-01",'
        '"title":"Rotas sem autenticação","rationale":"r"},'
        '{"file":"spec.md","line":null,"severity":"warning","category":"contract_gap","anchor":"FR-02",'
        '"title":"Contrato sem versão","rationale":"r"},'
        '{"file":"spec.md","line":null,"severity":"warning","catego'  # cortado no meio
    )
    calls = {"n": 0}

    def llm(system, user, model_id, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return truncated
        raise ValueError("Streaming is required for operations that may take longer than 10 minutes.")

    out = validate_spec("spec substantiva", llm_fn=llm)
    assert calls["n"] == 2  # houve retry
    assert [f["title"] for f in out["findings"]] == ["Rotas sem autenticação", "Contrato sem versão"]


def test_retry_failure_without_salvageable_content_still_raises():
    def llm(system, user, model_id, **kw):
        if "prosa" not in system:
            pass
        raise_it = kw.get("max_tokens", 0) > 4000
        if raise_it:
            raise RuntimeError("quota")
        return "prosa sem json"

    with pytest.raises(Exception):
        validate_spec("spec", llm_fn=llm)
