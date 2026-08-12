"""Testes do Product Architect (modo inferência) — SEM Bedrock (llm_fn stub).

Prova os gates determinísticos que blindam a proposta do LLM antes de devolvê-la, e o
guardrail 'propõe, nunca executa' (needs_human sempre True).
"""
import json
import pytest

from orchestrator.product_architect import (
    infer_manifest,
    validate_proposal,
    build_prompt,
    build_split_prompt,
    split_document,
    _extract_json,
    ManifestProposalError,
)

PRESENT = ["specs/contracts.md", "specs/api.md", "specs/web.md"]


def _good_manifest():
    return {
        "schemaVersion": "1.1.0",
        "product": {"name": "P", "systemId": "p", "specApproved": False, "deliveryDefault": "source_only"},
        "projects": [
            {"id": "contracts", "spec": "specs/contracts.md", "type": "lib_ts", "dependsOn": []},
            {"id": "api", "spec": "specs/api.md", "type": "backend_api_nestjs", "dependsOn": ["contracts"]},
            {"id": "web", "spec": "specs/web.md", "type": "frontend_dashboard", "dependsOn": ["contracts", "api"]},
        ],
    }


def _stub(manifest_obj, wrap=None):
    """Cria um llm_fn que devolve o manifesto serializado (opcionalmente 'sujo')."""
    body = json.dumps(manifest_obj)
    if wrap == "fence":
        body = f"Claro! Aqui está:\n```json\n{body}\n```\nEspero ajudar."
    elif wrap == "prose":
        body = f"Segue a proposta: {body} — fim."
    return lambda system, user, model_id: body


# ── build_prompt ────────────────────────────────────────────────────────────
def test_build_prompt_inclui_specs_e_prosa():
    p = build_prompt("Um app de inglês com backend e mobile.", PRESENT)
    assert "app de inglês" in p
    assert "specs/api.md" in p
    assert "DAG" in p


# ── _extract_json ───────────────────────────────────────────────────────────
def test_extrai_json_puro():
    assert _extract_json('{"a":1}') == {"a": 1}


def test_extrai_json_de_cerca():
    assert _extract_json('```json\n{"a":1}\n```') == {"a": 1}


def test_extrai_json_de_prosa():
    assert _extract_json('bla bla {"a":1} fim') == {"a": 1}


def test_json_invalido_lanca():
    with pytest.raises(ManifestProposalError) as e:
        _extract_json("isto não é json")
    assert e.value.code == "PROPOSAL_INVALID_JSON"


# ── infer_manifest (happy path + variações de formatação) ────────────────────
def test_infer_happy_path():
    out = infer_manifest("prosa", PRESENT, llm_fn=_stub(_good_manifest()))
    assert out["needs_human"] is True
    assert len(out["manifest"]["projects"]) == 3


def test_infer_tolera_cerca_de_codigo():
    out = infer_manifest("prosa", PRESENT, llm_fn=_stub(_good_manifest(), wrap="fence"))
    assert out["manifest"]["product"]["name"] == "P"


def test_infer_tolera_prosa_ao_redor():
    out = infer_manifest("prosa", PRESENT, llm_fn=_stub(_good_manifest(), wrap="prose"))
    assert len(out["manifest"]["projects"]) == 3


def test_needs_human_sempre_true():
    out = infer_manifest("prosa", PRESENT, llm_fn=_stub(_good_manifest()))
    assert out["needs_human"] is True


def test_spec_approved_forcado_a_false():
    m = _good_manifest()
    m["product"]["specApproved"] = True
    out = infer_manifest("prosa", PRESENT, llm_fn=_stub(m))
    assert out["manifest"]["product"]["specApproved"] is False
    assert any("specApproved" in w for w in out["warnings"])


# ── gates determinísticos (validate_proposal) ────────────────────────────────
def test_rejeita_ciclo():
    m = _good_manifest()
    m["projects"][0]["dependsOn"] = ["web"]  # contracts→web→api→contracts = ciclo
    with pytest.raises(ManifestProposalError) as e:
        validate_proposal(m, PRESENT)
    assert e.value.code == "PROPOSAL_CYCLE"


def test_rejeita_tipo_invalido():
    m = _good_manifest()
    m["projects"][1]["type"] = "backend_rocket"
    with pytest.raises(ManifestProposalError) as e:
        validate_proposal(m, PRESENT)
    assert e.value.code == "PROPOSAL_INVALID_TYPE"


def test_rejeita_spec_ausente():
    m = _good_manifest()
    m["projects"][2]["spec"] = "specs/fantasma.md"
    with pytest.raises(ManifestProposalError) as e:
        validate_proposal(m, PRESENT)
    assert e.value.code == "PROPOSAL_SPEC_MISSING"


def test_rejeita_dep_orfa():
    m = _good_manifest()
    m["projects"][1]["dependsOn"] = ["fantasma"]
    with pytest.raises(ManifestProposalError) as e:
        validate_proposal(m, PRESENT)
    assert e.value.code == "PROPOSAL_DEP_ORPHAN"


def test_rejeita_self_dep():
    m = _good_manifest()
    m["projects"][0]["dependsOn"] = ["contracts"]
    with pytest.raises(ManifestProposalError) as e:
        validate_proposal(m, PRESENT)
    assert e.value.code == "PROPOSAL_SELF_DEP"


def test_rejeita_id_duplicado():
    m = _good_manifest()
    m["projects"][1]["id"] = "contracts"
    with pytest.raises(ManifestProposalError) as e:
        validate_proposal(m, PRESENT)
    assert e.value.code == "PROPOSAL_DUPLICATE_ID"


def test_rejeita_sem_projetos():
    with pytest.raises(ManifestProposalError) as e:
        validate_proposal({"product": {"name": "P"}, "projects": []}, PRESENT)
    assert e.value.code == "PROPOSAL_NO_PROJECTS"


def test_rejeita_sem_product_name():
    with pytest.raises(ManifestProposalError) as e:
        validate_proposal({"product": {}, "projects": [{"id": "a", "spec": "specs/api.md", "type": "lib_ts"}]}, PRESENT)
    assert e.value.code == "PROPOSAL_NO_PRODUCT"


def test_proposta_ruim_do_llm_lanca_no_infer():
    """LLM devolve manifesto com ciclo → infer_manifest propaga o gate (não executa nada)."""
    m = _good_manifest()
    m["projects"][0]["dependsOn"] = ["web"]
    with pytest.raises(ManifestProposalError):
        infer_manifest("prosa", PRESENT, llm_fn=_stub(m))


# ── SPLITTER (split_document): doc → N specs geradas + grafo ──────────────────
LONG = "# App de idiomas\n\nUm produto B2B2C com contracts, backend e app mobile."


def _split_proposal():
    """Proposta do splitter: cada projeto carrega specContent (a spec markdown gerada)."""
    return {
        "schemaVersion": "1.1.0",
        "product": {"name": "ZVoices", "systemId": "zvoices", "specApproved": False, "deliveryDefault": "source_only"},
        "projects": [
            {"id": "contracts", "spec": "specs/contracts.md", "type": "lib_ts", "dependsOn": [],
             "specContent": "# Contracts\n\n## Objetivo\nContratos compartilhados do produto ZVoices para os demais projetos."},
            {"id": "api", "spec": "specs/api.md", "type": "backend_api_nestjs", "dependsOn": ["contracts"],
             "specContent": "# API\n\n## Objetivo\nBackend NestJS que expõe os endpoints do produto ZVoices e consome os contracts."},
            {"id": "mobile", "spec": "specs/mobile.md", "type": "mobile_crossplatform", "dependsOn": ["contracts", "api"],
             "specContent": "# Mobile\n\n## Objetivo\nApp React Native CLI que consome a API e os contracts do produto ZVoices."},
        ],
    }


def test_build_split_prompt_inclui_doc_e_contrato():
    p = build_split_prompt(LONG)
    assert "App de idiomas" in p
    assert "specContent" in p
    assert "DAG" in p


def test_split_happy_path_separa_manifest_e_specs():
    out = split_document(LONG, llm_fn=_stub(_split_proposal()))
    assert out["needs_human"] is True
    assert len(out["manifest"]["projects"]) == 3
    # specs foram extraídas e endereçadas por caminho
    assert set(out["specs"].keys()) == {"specs/contracts.md", "specs/api.md", "specs/mobile.md"}
    assert out["specs"]["specs/api.md"].startswith("# API")
    # o manifest limpo NÃO carrega specContent (formato canônico PRODUCT.json)
    for p in out["manifest"]["projects"]:
        assert "specContent" not in p


def test_split_tolera_cerca_de_codigo():
    out = split_document(LONG, llm_fn=_stub(_split_proposal(), wrap="fence"))
    assert out["manifest"]["product"]["name"] == "ZVoices"


def test_split_rejeita_spec_content_vazio():
    m = _split_proposal()
    m["projects"][1]["specContent"] = "curto"  # < MIN_SPEC_CONTENT_CHARS
    with pytest.raises(ManifestProposalError) as e:
        split_document(LONG, llm_fn=_stub(m))
    assert e.value.code == "PROPOSAL_EMPTY_SPEC"


def test_split_rejeita_caminho_de_spec_duplicado():
    m = _split_proposal()
    m["projects"][1]["spec"] = "specs/contracts.md"  # colide com o projeto 0
    with pytest.raises(ManifestProposalError) as e:
        split_document(LONG, llm_fn=_stub(m))
    assert e.value.code == "PROPOSAL_SPEC_DUPLICATE_PATH"


def test_split_propaga_gate_de_ciclo():
    m = _split_proposal()
    m["projects"][0]["dependsOn"] = ["mobile"]  # contracts→mobile→api→contracts = ciclo
    with pytest.raises(ManifestProposalError) as e:
        split_document(LONG, llm_fn=_stub(m))
    assert e.value.code == "PROPOSAL_CYCLE"


def test_split_needs_human_e_spec_approved_false():
    m = _split_proposal()
    m["product"]["specApproved"] = True
    out = split_document(LONG, llm_fn=_stub(m))
    assert out["needs_human"] is True
    assert out["manifest"]["product"]["specApproved"] is False
