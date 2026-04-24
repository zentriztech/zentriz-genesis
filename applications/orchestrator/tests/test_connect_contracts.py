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
