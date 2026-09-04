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


def test_build_split_prompt_ciente_de_infra():
    # Onda C (épico spec-rica): o splitter deve tratar infra compartilhada e distribuição como
    # concern explícito — senão a fábrica gera app que não sobe. Ver
    # [[genesis-spec-rica-connect-compliant-epic-2026-09-04]].
    p = build_split_prompt(LONG)
    assert "CIENTE DE INFRA" in p
    assert "-infra" in p and "other" in p
    assert "DISTRIBUIÇÃO" in p or "Distribuição" in p
    assert "docker-compose" in p and "Terraform" in p


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


# ── R4 PR3: SPLITTER em 2 PASSOS (manifesto → arquivos por projeto, fan-out) ──────────────
import json as _json
from orchestrator.product_architect import (
    PRODUCT_MANIFEST_SCHEMA_VERSION, CUT_REASONS, MERGE_BLOCKERS, build_project_files_prompt,
)


def _pass1_manifest():
    """Passo 1: manifesto SEM specContent, com racional de corte (enums) e summary."""
    return {
        "schemaVersion": "1.3.0",
        "product": {"name": "Controle Financeiro", "systemId": "controle-financeiro", "specApproved": False,
                    "deliveryDefault": "source_only", "rationale": "Corte por bounded context; infra compartilhada.",
                    "connect": {"environments": [{"name": "prod", "type": "prod", "criticality": "high"}],
                                "integrationTierTarget": "tier1-integration-ready"}},
        "projects": [
            {"id": "cf-infra", "spec": "specs/cf-infra.md", "type": "other", "dependsOn": [],
             "summary": "Postgres + Redis compartilhados, docker-compose single-host.",
             "cutReason": "shared-infra", "mergeBlocker": "none", "ishScore": 6, "relationships": []},
            {"id": "cf-backend", "spec": "specs/cf-backend.md", "type": "backend_api_node", "dependsOn": ["cf-infra"],
             "archetype": "rest-api", "stack": ["Node 20"], "deployTarget": "docker-compose-single-host",
             "summary": "API REST de lançamentos e contas.",
             "cutReason": "service-scope", "mergeBlocker": "none", "ishScore": 8,
             "relationships": [{"dependsOn": "cf-infra", "type": "customer-supplier"}]},
        ],
    }


def _pass2_for(pid: str) -> dict:
    return {
        "spec": f"# {pid}\n\n## Objetivo\nSpec principal completa do projeto {pid} com requisitos funcionais e critérios de aceite.",
        "files": {
            "contratos.md": "# Contratos\n\n```yaml\nopenapi: 3.1.0\ninfo: {title: cf, version: 1.0.0}\npaths: {}\n```\nContratos design-first do projeto.",
            "README.md": "# não deve entrar (reservado)  ................................................................",
            "Arquivo Inválido.md": "x" * 100,
        },
        "connect": {
            "serviceName": f"Serviço {pid}", "responsibility": "Responsabilidade clara do bounded context deste serviço.",
            "interfaces": [{"name": "http", "type": "http", "contractRef": "contratos.md#openapi"}],
            "dependencies": ["cf-infra"] if pid != "cf-infra" else [],
            "events": {"publishes": ["lancamento.registrado"], "subscribes": []},
            "runtimeType": "container", "healthModel": {"hasHealthEndpoint": True, "signals": ["latency_p95"]},
            "systemId": "TENTATIVA-DE-SOBRESCREVER", "owners": {"technicalOwner": {"id": "x", "name": "y"}},
            "campoDesconhecido": 1,
        },
    }


def _two_pass_stub(manifest: dict, calls: list[str] | None = None):
    """1ª chamada → manifesto (passo 1); chamadas seguintes → passo 2 do projeto citado no prompt."""
    def fn(system: str, user: str, model_id: str) -> str:
        if calls is not None:
            calls.append(user)
        if "PROJETO ALVO" not in user:
            return _json.dumps(manifest, ensure_ascii=False)
        # o bloco de irmãos também contém `"id": ...` — o alvo é o que vem DEPOIS de "PROJETO ALVO"
        target_block = user.split("PROJETO ALVO", 1)[1]
        for p in manifest["projects"]:
            if f'"id": "{p["id"]}"' in target_block:
                return _json.dumps(_pass2_for(p["id"]), ensure_ascii=False)
        raise AssertionError("projeto alvo não identificado no prompt do passo 2")
    return fn


def test_build_split_prompt_passo1_contrato_novo():
    p = build_split_prompt(LONG)
    assert PRODUCT_MANIFEST_SCHEMA_VERSION in p
    assert "cutReason" in p and "mergeBlocker" in p and "ishScore" in p
    assert "NÃO devolva `specContent`" in p
    for enum in sorted(CUT_REASONS) + sorted(MERGE_BLOCKERS):
        assert enum in p


def test_split_dois_passos_fanout_gera_specs_arquivos_e_connect_yaml():
    calls: list[str] = []
    out = split_document(LONG, llm_fn=_two_pass_stub(_pass1_manifest(), calls))
    # 1 chamada de manifesto + 1 por projeto
    assert len(calls) == 3
    m = out["manifest"]
    assert m["schemaVersion"] == PRODUCT_MANIFEST_SCHEMA_VERSION
    ids = [p["id"] for p in m["projects"]]
    assert ids == ["cf-infra", "cf-backend"]
    specs = out["specs"]
    # spec principal + contratos.md + connect.yaml por projeto; README/inválido descartados
    for pid in ids:
        assert specs[f"specs/{pid}.md"].startswith(f"# {pid}")
        assert f"specs/{pid}/contratos.md" in specs
        assert f"specs/{pid}/connect.yaml" in specs
        assert f"specs/{pid}/README.md" not in specs
    # manifesto: files[] + connectDeclaration + campos crus removidos + rationale dobrado
    be = next(p for p in m["projects"] if p["id"] == "cf-backend")
    assert be["connectDeclaration"] == "specs/cf-backend/connect.yaml"
    kinds = {f["kind"] for f in be["files"]}
    assert {"contracts", "connect-declaration"} <= kinds
    for raw in ("summary", "cutReason", "mergeBlocker", "ishScore", "relationships"):
        assert raw not in be
    assert be["rationale"].startswith("Corte: service-scope · Integrador: none · ISH 8/10 · Relações: cf-infra=customer-supplier")
    assert be["archetype"] == "rest-api" and be["stack"] == ["Node 20"]
    # avisos visíveis: arquivos descartados + chaves Connect desconhecidas
    joined = "\n".join(out["warnings"])
    assert "README.md" in joined and "Arquivo Inválido.md" in joined and "campoDesconhecido" in joined


def test_split_connect_yaml_identidade_vem_do_manifesto_e_valida_no_schema():
    import yaml
    from orchestrator.connect_contracts import validate_connect_artifact
    out = split_document(LONG, llm_fn=_two_pass_stub(_pass1_manifest()))
    decl = yaml.safe_load(out["specs"]["specs/cf-backend/connect.yaml"])
    assert decl["schemaVersion"] == PRODUCT_MANIFEST_SCHEMA_VERSION
    assert decl["systemId"] == "controle-financeiro"          # não "TENTATIVA-DE-SOBRESCREVER"
    assert decl["serviceId"] == "cf-backend"
    assert "owners" not in decl                                # owners vêm do tenant, não do LLM
    assert decl["interfaces"][0]["type"] == "http"
    assert validate_connect_artifact("SpecConnectDeclaration", decl) == []


def test_split_enums_fora_do_padrao_viram_fallback_com_warning():
    m = _pass1_manifest()
    m["projects"][1]["cutReason"] = "porque-sim"
    m["projects"][1]["mergeBlocker"] = "talvez"
    m["projects"][1]["ishScore"] = 3
    m["projects"][1]["relationships"] = [{"dependsOn": "cf-infra", "type": "amizade"}]
    out = split_document(LONG, llm_fn=_two_pass_stub(m))
    be = next(p for p in out["manifest"]["projects"] if p["id"] == "cf-backend")
    assert be["rationale"].startswith("Corte: service-scope · Integrador: none · ISH 3/10 · Relações: cf-infra=none")
    joined = "\n".join(out["warnings"])
    assert "porque-sim" in joined and "talvez" in joined and "amizade" in joined
    assert "ISH 3/10 < 5" in joined


def test_split_passo1_invalido_nao_gasta_passo2():
    calls: list[str] = []
    m = _pass1_manifest()
    m["projects"][0]["dependsOn"] = ["cf-backend"]  # ciclo
    with pytest.raises(ManifestProposalError) as e:
        split_document(LONG, llm_fn=_two_pass_stub(m, calls))
    assert e.value.code == "PROPOSAL_CYCLE"
    assert len(calls) == 1  # só o manifesto foi chamado


def test_split_legado_com_campos_crus_normaliza_rationale():
    # proposta antiga (specContent) que TAMBÉM traz racional cru → dobra em rationale e remove crus
    m = _split_proposal()
    m["projects"][1].update({"summary": "API do produto.", "cutReason": "service-scope", "mergeBlocker": "none", "ishScore": 7})
    out = split_document(LONG, llm_fn=_stub(m))
    api = next(p for p in out["manifest"]["projects"] if p["id"] == "api")
    assert api["rationale"].startswith("Corte: service-scope · Integrador: none · ISH 7/10 — API do produto.")
    assert "summary" not in api and "cutReason" not in api
    assert out["manifest"]["schemaVersion"] == PRODUCT_MANIFEST_SCHEMA_VERSION


def test_split_connect_dependencia_declarada_fora_do_grafo_gera_aviso():
    m = _pass1_manifest()
    m["projects"][1]["dependsOn"] = []  # backend declara depender de cf-infra no connect, mas o grafo não tem a aresta
    out = split_document(LONG, llm_fn=_two_pass_stub(m))
    assert any("aresta faltante no grafo" in w and "cf-infra" in w for w in out["warnings"])


def test_split_passo2_repete_uma_vez_e_falha_honesto(monkeypatch):
    import orchestrator.product_architect as pa
    monkeypatch.setattr(pa, "SPLITTER_RETRY_BACKOFF_S", 0)  # sem sleep no teste
    m = _pass1_manifest()
    attempts: dict[str, int] = {}

    def fn(system: str, user: str, model_id: str) -> str:
        if "PROJETO ALVO" not in user:
            return _json.dumps(m)
        pid = "cf-infra" if '"id": "cf-infra"' in user.split("PROJETO ALVO", 1)[1] else "cf-backend"
        attempts[pid] = attempts.get(pid, 0) + 1
        if pid == "cf-backend":
            return "isto não é json"
        return _json.dumps(_pass2_for(pid))

    with pytest.raises(ManifestProposalError) as e:
        split_document(LONG, llm_fn=fn)
    assert e.value.code == "PROPOSAL_INVALID_JSON"
    assert attempts["cf-backend"] == 2  # 1 retry


def test_build_project_files_prompt_inclui_alvo_e_irmaos():
    m = _pass1_manifest()
    p = build_project_files_prompt(LONG, m, m["projects"][1])
    assert "PROJETO ALVO" in p and '"id": "cf-backend"' in p
    assert "cf-infra" in p and "NÃO redecomponha" in p
