"""
Testes do PORTÃO DE ENTRADA da regeneração de domínio (achados #55 → #56 → #57).

`_domain_incoherence_findings(audit)` é o gatilho que ENGATA toda a maquinaria de
regeneração de domínio do Cyborg (submodo REGEN do `autonomous_rework`). Se ele
disparar de menos, um "domínio-errado-verde" (build compila, domínio incorreto —
achado #48/#55) passa despercebido; se disparar de mais, o Cyborg regenera o núcleo
de projetos íntegros e regride. Estes testes travam o contrato EXATO do gatilho:

  Dispara (BLOCKER) quando:
    (a) area ∈ {wrong_domain_lexicon, template_leftover, mock_incoherent, wrong_domain}
        em QUALQUER analisador; OU
    (b) analisador ∈ {a2_fidelidade_spec, a5_dominio} E a descrição contém um dos
        marcadores de descompasso de domínio (_DOMAIN_MISMATCH_MARKERS).

  NÃO dispara para: findings não-BLOCKER (MAJOR/MINOR), BLOCKERs de build/feature-gap,
  marcador de domínio num analisador que não seja a2/a5, ou fidelidade BLOCKER SEM marcador.

Sem custo de LLM — exercita a função pura de decisão diretamente. É a rede de
regressão do fix mais caro da fábrica (#52→#57).
"""
from __future__ import annotations

from orchestrator.cyborg_v3 import (
    Finding,
    AnalysisResult,
    _domain_incoherence_findings,
    _DOMAIN_INCOHERENCE_AREAS,
    _DOMAIN_MISMATCH_MARKERS,
)


def _audit(name: str, findings: list[Finding]) -> dict:
    return {name: AnalysisResult(name=name, ok=False, score=0, findings=findings)}


# ── (a) sinal FORTE por área ────────────────────────────────────────────────

def test_area_signal_triggers_for_each_incoherence_area():
    for area in sorted(_DOMAIN_INCOHERENCE_AREAS):
        audit = _audit("a7_qualquer", [Finding("BLOCKER", area, "irrelevante para o teste")])
        hits = _domain_incoherence_findings(audit)
        assert len(hits) == 1, f"área {area!r} deveria disparar a regen"
        assert hits[0].area == area


def test_area_signal_works_in_any_analyzer_name():
    # o sinal FORTE por área independe do nome do analisador
    audit = _audit("a9_seguranca", [Finding("BLOCKER", "template_leftover", "sobra de template")])
    assert len(_domain_incoherence_findings(audit)) == 1


# ── (b) sinal por FIDELIDADE (marcador na descrição) ─────────────────────────

def test_fidelity_marker_triggers_only_in_a2_a5():
    for name in ("a2_fidelidade_spec", "a5_dominio"):
        for marker in _DOMAIN_MISMATCH_MARKERS:
            desc = f"O produto {marker} exigido pela spec."
            audit = _audit(name, [Finding("BLOCKER", "fidelity", desc)])
            hits = _domain_incoherence_findings(audit)
            assert len(hits) == 1, f"{name} + marcador {marker!r} deveria disparar"


def test_fidelity_marker_ignored_outside_a2_a5():
    # mesmo marcador, analisador errado → NÃO dispara (evita falso-positivo de regen)
    audit = _audit("a3_apps_tree", [Finding("BLOCKER", "fidelity", "domínio errado detectado")])
    assert _domain_incoherence_findings(audit) == []


def test_fidelity_blocker_without_marker_does_not_trigger():
    audit = _audit("a2_fidelidade_spec", [Finding("BLOCKER", "fidelity", "falta o campo createdAt")])
    assert _domain_incoherence_findings(audit) == []


# ── negativos: severidade e build/feature-gap não são domínio ────────────────

def test_non_blocker_severity_never_triggers():
    for sev in ("MAJOR", "MINOR", "INFO"):
        audit = _audit("a5_dominio", [Finding(sev, "wrong_domain", "domínio errado")])
        assert _domain_incoherence_findings(audit) == [], f"severidade {sev} não deveria disparar"


def test_build_blocker_is_not_domain_incoherence():
    # gate de build (#38) é soberano e separado; um erro de build não é domínio-errado
    audit = _audit("a1_build", [Finding("BLOCKER", "build", "tsc rc=2: TS2305 no módulo X")])
    assert _domain_incoherence_findings(audit) == []


def test_feature_gap_blocker_is_not_domain_incoherence():
    # gap-de-feature (achado #50/#54) → feature mode, NÃO regen de domínio
    audit = _audit("a2_fidelidade_spec",
                   [Finding("BLOCKER", "missing_feature", "falta o subsistema offline WatermelonDB")])
    assert _domain_incoherence_findings(audit) == []


# ── composição realista: mistura de sinais num audit multi-analisador ────────

def test_mixed_audit_counts_only_domain_signals():
    audit = {
        "a1_build": AnalysisResult("a1_build", False, 0, [
            Finding("BLOCKER", "build", "tsc rc=1"),                      # não
        ]),
        "a2_fidelidade_spec": AnalysisResult("a2_fidelidade_spec", False, 0, [
            Finding("BLOCKER", "fidelity", "entrega é um lms genérico"),  # SIM (marcador)
            Finding("MAJOR", "fidelity", "domínio errado"),              # não (MAJOR)
        ]),
        "a5_dominio": AnalysisResult("a5_dominio", False, 0, [
            Finding("BLOCKER", "wrong_domain_lexicon", "usa Course/Hour"), # SIM (área)
        ]),
        "a7_seguranca": AnalysisResult("a7_seguranca", False, 0, [
            Finding("BLOCKER", "mock_incoherent", "mock de outro produto"),# SIM (área, qualquer analisador)
        ]),
    }
    hits = _domain_incoherence_findings(audit)
    assert len(hits) == 3


def test_empty_and_none_audit_are_safe():
    assert _domain_incoherence_findings({}) == []
    assert _domain_incoherence_findings(None) == []


if __name__ == "__main__":
    # Runner sem pytest (host/containers da fábrica não têm pytest instalado).
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = failed = 0
    for fn in fns:
        try:
            fn()
            passed += 1
            print(f"  PASS  {fn.__name__}")
        except Exception:
            failed += 1
            print(f"  FAIL  {fn.__name__}")
            traceback.print_exc()
    print(f"\n{passed} passed, {failed} failed (de {len(fns)} testes)")
    raise SystemExit(1 if failed else 0)
