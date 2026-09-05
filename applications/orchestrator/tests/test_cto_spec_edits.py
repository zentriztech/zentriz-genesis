"""F1 (2026-09-05) — `edits` no CTO da Bancada: gate do envelope, materialização e guardas.

Contexto: o CTO reemitia a spec INTEIRA (98.045 chars no NVX LastMile) e estourava os 64.000 tokens
de SAÍDA do Opus 5. Com `format:"edits"` a saída passa a ser proporcional à MUDANÇA. A autoria do
texto continua 100% do LLM — o código só aplica o `search/replace` que ele escreveu.
"""

from orchestrator.envelope import validate_response_quality
from agents.runtime import build_user_message, materialize_spec_edits

BASE_SPEC = """# Produto

## 1. Visão
Texto da visão original.

## 2. Requisitos
- FR-01: fazer algo.

## 3. Modelo de dados
Tabela `orders`.
"""


def _envelope(**inputs) -> dict:
    """Corpo como o `server.py` entrega ao runtime: aninhado DUAS vezes (`input` → `inputs`)."""
    return {"input": {"inputs": inputs}}


# ── PR-0: o gate de qualidade não pode reprovar um artefato `edits` ────────────────────────────────

def test_quality_gate_accepts_edits_artifact_without_content():
    """Antes do PR-0 este artefato reprovava com "muito curto (0 chars)" DENTRO do run_agent —
    o que mantinha o caminho `edits` do Dev (Bloco 4 M8) quebrado sem ninguém notar."""
    envelope = {
        "status": "OK",
        "summary": "Ajustei o modelo de dados conforme os GAPs apontados na validação.",
        "artifacts": [
            {
                "path": "docs/spec/PRODUCT_SPEC.md",
                "format": "edits",
                "edits": [{"search": "Tabela `orders`.", "replace": "Tabela `orders` (PK id)."}],
            }
        ],
    }
    ok, errors = validate_response_quality("CTO", envelope)
    assert (ok, errors) == (True, [])


def test_quality_gate_still_rejects_empty_content_artifact():
    envelope = {
        "status": "OK",
        "summary": "Resumo qualquer suficientemente longo para passar do piso de tamanho.",
        "artifacts": [{"path": "docs/spec/PRODUCT_SPEC.md", "content": ""}],
    }
    ok, errors = validate_response_quality("CTO", envelope)
    assert not ok and any("curto" in e for e in errors)


# ── PR-1: materialização no run_agent ─────────────────────────────────────────────────────────────

def test_materialize_replaces_edits_by_full_content():
    out = {
        "status": "OK",
        "artifacts": [
            {
                "path": "docs/spec/PRODUCT_SPEC.md",
                "format": "edits",
                "edits": [
                    {"search": "Texto da visão original.", "replace": "Visão revisada pelo CTO."},
                    {"search": "- FR-01: fazer algo.", "replace": "- FR-01: fazer algo (DADO/QUANDO/ENTÃO)."},
                ],
            }
        ],
    }
    errors = materialize_spec_edits(
        out, _envelope(spec_raw=BASE_SPEC), "CTO", "spec_intake_and_normalize", False, "us.anthropic.claude-opus-5"
    )
    assert errors == []
    art = out["artifacts"][0]
    assert "Visão revisada pelo CTO." in art["content"]
    assert "DADO/QUANDO/ENTÃO" in art["content"]
    assert "## 3. Modelo de dados" in art["content"], "seções não tocadas devem sobreviver"
    assert "edits" not in art and "format" not in art, "artefato materializado é indistinguível de content"
    assert art["_materialized_from_edits"] == 2
    assert out["_edits_applied"] == 2
    assert out["_edits_chars_saved"] > 0


def test_materialize_uses_product_spec_when_spec_raw_absent():
    out = {
        "artifacts": [
            {"path": "docs/spec/PRODUCT_SPEC.md", "format": "edits",
             "edits": [{"search": "Tabela `orders`.", "replace": "Tabela `orders` e `order_items`."}]}
        ]
    }
    errors = materialize_spec_edits(
        out, _envelope(product_spec=BASE_SPEC), "CTO", "spec_intake_and_normalize", False, "us.anthropic.claude-opus-5"
    )
    assert errors == []
    assert "order_items" in out["artifacts"][0]["content"]


def test_search_that_does_not_match_reports_error_and_keeps_artifact_intact():
    """Atômico: nada é aplicado e o erro carrega o trecho real (vira repair da LEI 5)."""
    out = {
        "artifacts": [
            {"path": "docs/spec/PRODUCT_SPEC.md", "format": "edits",
             "edits": [{"search": "trecho que não existe na spec", "replace": "x"}]}
        ]
    }
    errors = materialize_spec_edits(
        out, _envelope(spec_raw=BASE_SPEC), "CTO", "spec_intake_and_normalize", False, "us.anthropic.claude-opus-5"
    )
    assert errors, "search inexistente deve reprovar"
    assert out["artifacts"][0]["format"] == "edits", "sem aplicação parcial"
    assert "content" not in out["artifacts"][0]
    assert out["_edits_failed"] >= 1


def test_guard_b4_truncated_response_is_never_materialized():
    out = {
        "artifacts": [
            {"path": "docs/spec/PRODUCT_SPEC.md", "format": "edits",
             "edits": [{"search": "Tabela `orders`.", "replace": "Tabela `orders` (cortada no meio"}]}
        ]
    }
    errors = materialize_spec_edits(
        out, _envelope(spec_raw=BASE_SPEC), "CTO", "spec_intake_and_normalize", True, "us.anthropic.claude-opus-5"
    )
    assert len(errors) == 1 and "CORTADA" in errors[0]
    assert "content" not in out["artifacts"][0]


def test_guard_b4_json_recovered_truncation_is_also_blocked():
    out = {
        "_json_recovered_truncated": True,
        "artifacts": [
            {"path": "docs/spec/PRODUCT_SPEC.md", "format": "edits",
             "edits": [{"search": "Tabela `orders`.", "replace": "y"}]}
        ],
    }
    errors = materialize_spec_edits(
        out, _envelope(spec_raw=BASE_SPEC), "CTO", "spec_intake_and_normalize", False, "us.anthropic.claude-opus-5"
    )
    assert len(errors) == 1 and "CORTADA" in errors[0]
    assert "content" not in out["artifacts"][0]


def test_guard_b3_refuses_edits_when_base_would_not_fit_in_prompt():
    """Modelo pequeno → a spec chega CORTADA no prompt; um `search` escrito sobre o trecho visível
    não pode ser aplicado sobre o documento inteiro."""
    big = BASE_SPEC + ("\n\n## Enchimento\n" + "x" * 200_000)
    out = {
        "artifacts": [
            {"path": "docs/spec/PRODUCT_SPEC.md", "format": "edits",
             "edits": [{"search": "Tabela `orders`.", "replace": "z"}]}
        ]
    }
    errors = materialize_spec_edits(
        out, _envelope(spec_raw=big), "CTO", "spec_intake_and_normalize", False, "us.anthropic.claude-haiku-4-5-20251001"
    )
    assert len(errors) == 1 and "cortada" in errors[0]
    assert "content" not in out["artifacts"][0]


def test_missing_base_asks_for_full_content():
    out = {
        "artifacts": [
            {"path": "docs/spec/PRODUCT_SPEC.md", "format": "edits",
             "edits": [{"search": "a", "replace": "b"}]}
        ]
    }
    errors = materialize_spec_edits(out, _envelope(), "CTO", "spec_intake_and_normalize", False, "us.anthropic.claude-opus-5")
    assert len(errors) == 1 and "spec-base" in errors[0]


def test_noop_outside_the_cto_bench_path():
    """O Dev continua sendo materializado pelo `runner.py` (que lê o arquivo do DISCO)."""
    art = {"path": "src/app.ts", "format": "edits", "edits": [{"search": "a", "replace": "b"}]}
    out = {"artifacts": [art]}
    assert materialize_spec_edits(out, _envelope(spec_raw=BASE_SPEC), "DEV", "evolution", False, "") == []
    assert materialize_spec_edits(out, _envelope(spec_raw=BASE_SPEC), "CTO", "evolution", False, "") == []
    assert art["format"] == "edits"


def test_noop_when_artifact_has_content():
    out = {"artifacts": [{"path": "docs/spec/PRODUCT_SPEC.md", "content": BASE_SPEC}]}
    assert materialize_spec_edits(
        out, _envelope(spec_raw=BASE_SPEC), "CTO", "spec_intake_and_normalize", False, "us.anthropic.claude-opus-5"
    ) == []
    assert out.get("_edits_applied") is None


# ── PR-1: o prompt só descreve o formato quando a api pediu ───────────────────────────────────────

MARKER = "EDIÇÕES CIRÚRGICAS"


def test_prompt_describes_edits_only_when_api_asked():
    envelope = {"task": "Revise a spec", "inputs": {"spec_raw": BASE_SPEC}}
    without = build_user_message(envelope, role="CTO")
    assert MARKER not in without, "flag OFF na api ⇒ prompt legado"

    envelope_on = {"task": "Revise a spec", "inputs": {"spec_raw": BASE_SPEC, "edit_format": "edits"}}
    with_edits = build_user_message(envelope_on, role="CTO")
    assert MARKER in with_edits
    assert '"format": "edits"' in with_edits


def test_prompt_does_not_offer_edits_when_spec_was_clipped():
    """Guarda B3 no lado do PROMPT: spec cortada ⇒ nem oferecemos o formato."""
    big = BASE_SPEC + ("\n\n## Enchimento\n" + "x" * 400_000)
    envelope = {"task": "Revise", "inputs": {"spec_raw": big, "edit_format": "edits"}}
    msg = build_user_message(envelope, role="CTO", model="us.anthropic.claude-opus-5")
    assert MARKER not in msg
