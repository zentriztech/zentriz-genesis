"""
Smoke tests for connect_contracts.py — validates that build_* functions
produce payloads that pass schema validation for all three stages.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from orchestrator.connect_contracts import (
    CONNECT_SCHEMA_VERSION,
    build_connect_artifacts_for_stage,
    build_system_passport,
    build_ownership_manifest,
    build_service_manifests,
    build_observability_baseline_manifest,
    build_runtime_passport,
    build_known_safe_actions_pack,
    build_integration_ready_contract,
    validate_connect_artifact,
)


def _ctx(**kwargs):
    defaults = dict(
        project_id="test-project-001",
        product_spec="# API Voucher Service\n\nA simple voucher management API.",
        spec_raw="# API Voucher Service\n\nA simple voucher management API.",
        charter="CTO approved. Backend squad: 2 devs. REST API with PostgreSQL.",
        backlog="Tasks: implement voucher CRUD, auth, tests, Docker.",
        engineer_proposal="Node.js backend + PostgreSQL. CI via GitHub Actions.",
        current_module="backend",
        artifacts={"apps/api/index.js": "// entry", "Dockerfile": "FROM node:18"},
        connect_artifacts={},
        connect_version=CONNECT_SCHEMA_VERSION,
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


class TestBuildFunctions:
    def test_system_passport_has_required_fields(self):
        payload = build_system_passport(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "owners" in payload
        assert isinstance(payload["owners"], list)

    def test_ownership_manifest_has_required_fields(self):
        payload = build_ownership_manifest(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "owners" in payload

    def test_service_manifests_returns_list(self):
        manifests = build_service_manifests(_ctx())
        assert isinstance(manifests, list)
        assert len(manifests) >= 1
        for m in manifests:
            assert "schemaVersion" in m
            assert "serviceId" in m

    def test_observability_baseline_manifest_has_required_fields(self):
        payload = build_observability_baseline_manifest(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "requiredSignals" in payload

    def test_runtime_passport_has_required_fields(self):
        payload = build_runtime_passport(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "runtimeType" in payload

    def test_known_safe_actions_pack_has_required_fields(self):
        payload = build_known_safe_actions_pack(_ctx())
        assert payload["schemaVersion"] == CONNECT_SCHEMA_VERSION
        assert "systemId" in payload
        assert "actions" in payload


class TestSchemaValidation:
    def test_validate_connect_artifact_pass(self):
        payload = build_system_passport(_ctx())
        errors = validate_connect_artifact("SystemPassport", payload)
        assert errors == [], f"SystemPassport validation errors: {errors}"

    def test_validate_connect_artifact_ownership(self):
        payload = build_ownership_manifest(_ctx())
        errors = validate_connect_artifact("OwnershipManifest", payload)
        assert errors == [], f"OwnershipManifest validation errors: {errors}"

    def test_validate_connect_artifact_observability(self):
        payload = build_observability_baseline_manifest(_ctx())
        errors = validate_connect_artifact("ObservabilityBaselineManifest", payload)
        assert errors == [], f"ObservabilityBaselineManifest validation errors: {errors}"

    def test_validate_connect_artifact_runtime_passport(self):
        payload = build_runtime_passport(_ctx())
        errors = validate_connect_artifact("RuntimePassport", payload)
        assert errors == [], f"RuntimePassport validation errors: {errors}"

    def test_validate_connect_artifact_known_safe_actions(self):
        payload = build_known_safe_actions_pack(_ctx())
        errors = validate_connect_artifact("KnownSafeActionsPack", payload)
        assert errors == [], f"KnownSafeActionsPack validation errors: {errors}"


class TestBuildConnectArtifactsForStage:
    def test_charter_stage_emits_system_and_ownership(self):
        artifacts = build_connect_artifacts_for_stage(_ctx(), "charter")
        contracts = {a.contract for a in artifacts}
        assert "SystemPassport" in contracts
        assert "OwnershipManifest" in contracts

    def test_backlog_stage_emits_service_manifests(self):
        artifacts = build_connect_artifacts_for_stage(_ctx(), "backlog")
        assert all(a.contract == "ServiceManifest" for a in artifacts)
        assert len(artifacts) >= 1

    def test_devops_stage_emits_observability_runtime_safe_actions(self):
        artifacts = build_connect_artifacts_for_stage(_ctx(), "devops")
        contracts = {a.contract for a in artifacts}
        assert "ObservabilityBaselineManifest" in contracts
        assert "RuntimePassport" in contracts
        assert "KnownSafeActionsPack" in contracts

    def test_unknown_stage_raises(self):
        with pytest.raises(ValueError, match="Connect stage desconhecido"):
            build_connect_artifacts_for_stage(_ctx(), "unknown_stage")

    def test_artifacts_have_valid_json_paths(self):
        for stage in ("charter", "backlog", "devops"):
            artifacts = build_connect_artifacts_for_stage(_ctx(), stage)
            for a in artifacts:
                assert a.project_relative_path.startswith("project/connect/")
                assert a.project_relative_path.endswith(".json")

    def test_artifacts_serialize_to_json(self):
        import json
        for stage in ("charter", "backlog", "devops"):
            artifacts = build_connect_artifacts_for_stage(_ctx(), stage)
            for a in artifacts:
                json_str = a.to_json()
                parsed = json.loads(json_str)
                assert isinstance(parsed, dict)


class TestCanonicalIdentityR4PR1:
    """R4 PR1 — pré-requisito zero: systemId/serviceId canônicos vencem o 1º heading da spec."""

    def test_system_id_canonico_vence_heading(self):
        ctx = _ctx(system_id="controle-financeiro", service_id="cf-backend", product_name="Controle Financeiro")
        passport = build_system_passport(ctx)
        assert passport["systemId"] == "controle-financeiro"          # não "api-voucher-service"
        assert passport["displayName"] == "Controle Financeiro"
        for builder in (build_ownership_manifest, build_observability_baseline_manifest,
                        build_runtime_passport, build_known_safe_actions_pack, build_integration_ready_contract):
            assert builder(ctx)["systemId"] == "controle-financeiro"
        for m in build_service_manifests(ctx):
            assert m["systemId"] == "controle-financeiro"

    def test_fallback_product_name_depois_heading(self):
        assert build_system_passport(_ctx(product_name="Meu Produto"))["systemId"] == "meu-produto"
        # legado (sem produto): 1º heading
        assert build_system_passport(_ctx())["systemId"] == "api-voucher-service"

    def test_service_canonico_vem_primeiro_e_e_http(self):
        ctx = _ctx(system_id="controle-financeiro", service_id="cf-backend")
        manifests = build_service_manifests(ctx)
        assert manifests[0]["serviceId"] == "cf-backend"
        assert manifests[0]["interfaces"][0]["type"] == "http"
        assert build_system_passport(ctx)["services"][0] == "cf-backend"

    def test_solo_app_servico_e_o_sistema(self):
        ctx = _ctx(system_id="meu-app", service_id=None)
        assert build_service_manifests(ctx)[0]["serviceId"] == "meu-app"

    def test_sem_cap_de_tres_servicos(self):
        charter = " ".join(f"pagamentos-{i}-service" for i in range(6))
        manifests = build_service_manifests(_ctx(charter=charter, backlog="", engineer_proposal=""))
        assert len(manifests) >= 6

    def test_tier_declarado_conservador(self):
        passport = build_system_passport(_ctx())
        assert passport["integrationTier"] == "tier1-integration-ready"
        # coerência: não afirmar deadpoolReady enquanto declaramos tier1 (adversarial PR1 #3)
        assert passport["capabilityProfile"]["deadpoolReady"] is False

    def test_path_do_artefato_segue_versao_do_contexto(self):
        # adversarial PR1 #4: path registrado == versão que o runner passa ao storage
        artifacts = build_connect_artifacts_for_stage(_ctx(connect_version="9.9.9"), "charter")
        assert all(a.project_relative_path.startswith("project/connect/v9.9.9/") for a in artifacts)


class TestIntegrationReadyContractR4PR1:
    def test_emitido_no_estagio_devops(self):
        artifacts = build_connect_artifacts_for_stage(_ctx(), "devops")
        contracts = {a.contract: a for a in artifacts}
        assert "IntegrationReadyContract" in contracts
        assert contracts["IntegrationReadyContract"].filename == "integration-ready-contract.json"

    def test_valida_contra_schema_real(self):
        payload = build_integration_ready_contract(_ctx(system_id="x-sys"))
        errors = validate_connect_artifact("IntegrationReadyContract", payload)
        assert errors == [], errors
        assert payload["declaredTier"] == "tier1-integration-ready"
        assert payload["contactPoints"] and all("id" in c and "name" in c for c in payload["contactPoints"])


class TestPipelineContextIdentityRoundtrip:
    def test_checkpoint_preserva_identidade_connect(self, tmp_path):
        from orchestrator.pipeline_context import PipelineContext
        ctx = PipelineContext("p1")
        assert ctx.connect_version == CONNECT_SCHEMA_VERSION  # constante única
        ctx.system_id, ctx.service_id, ctx.product_name, ctx.product_id = "sys-a", "svc-b", "Produto A", "prod-uuid"
        ctx.save_checkpoint(tmp_path)
        restored = PipelineContext.load_checkpoint(tmp_path, "p1")
        assert (restored.system_id, restored.service_id, restored.product_name, restored.product_id) == ("sys-a", "svc-b", "Produto A", "prod-uuid")

    def test_checkpoint_legado_sem_identidade(self, tmp_path):
        import json
        from orchestrator.pipeline_context import PipelineContext
        (tmp_path / "p2").mkdir()
        (tmp_path / "p2" / "checkpoint.json").write_text(json.dumps({"project_id": "p2", "connect_version": "0.0.1"}))
        restored = PipelineContext.load_checkpoint(tmp_path, "p2")
        assert restored.system_id == "" and restored.service_id is None and restored.product_name == ""
        # connect_version NÃO é restaurada do checkpoint — sempre a constante do emissor (adversarial PR1 #4)
        assert restored.connect_version == CONNECT_SCHEMA_VERSION
