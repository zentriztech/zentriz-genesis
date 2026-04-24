from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APPLICATIONS_ROOT = ROOT / "applications"
if str(APPLICATIONS_ROOT) not in sys.path:
    sys.path.insert(0, str(APPLICATIONS_ROOT))

from orchestrator.connect_contracts import build_connect_artifacts_for_stage
from orchestrator.pipeline_context import PipelineContext


def _build_context() -> PipelineContext:
    ctx = PipelineContext("voucher-mvp")
    ctx.set_spec_raw(
        "# Voucher MVP\n\n"
        "Sistema com backend API, monitor loop, webhooks e dashboard. "
        "Ambientes dev, staging e prod. DevOps com Docker e runbook."
    )
    ctx.set_product_spec(
        "# Voucher MVP\n\n"
        "Criar plataforma com orders-api, webhook worker e observabilidade estruturada."
    )
    ctx.set_engineer_proposal(
        "Squad backend para orders-api e webhook-worker. "
        "Docker para execução local e webhooks críticos."
    )
    ctx.set_charter(
        "Project Charter\n\nSquad backend responsável por orders-api e occurrence-webhook. "
        "Monitor e DevOps devem preparar operação Deadpool Ready."
    )
    ctx.set_backlog(
        "BACKLOG\n\n- Implementar orders-api\n- Implementar occurrence-webhook\n"
        "- Configurar observabilidade e runbook\n"
    )
    ctx.current_module = "backend"
    ctx.register_artifact("project/docker/Dockerfile", "FROM python:3.11-slim")
    ctx.register_artifact("docs/devops/RUNBOOK.md", "# Runbook")
    return ctx


def test_build_charter_stage_connect_artifacts_are_valid() -> None:
    ctx = _build_context()
    artifacts = build_connect_artifacts_for_stage(ctx, "charter")
    assert [artifact.contract for artifact in artifacts] == ["SystemPassport", "OwnershipManifest"]
    for artifact in artifacts:
        assert artifact.payload["schemaVersion"] == "1.0.0"
        assert artifact.project_relative_path.startswith("project/connect/v1.0.0/")


def test_build_backlog_stage_connect_artifacts_are_valid() -> None:
    ctx = _build_context()
    artifacts = build_connect_artifacts_for_stage(ctx, "backlog")
    assert artifacts
    assert all(artifact.contract == "ServiceManifest" for artifact in artifacts)
    assert any("service-manifest" in artifact.filename for artifact in artifacts)


def test_build_devops_stage_connect_artifacts_are_valid() -> None:
    ctx = _build_context()
    artifacts = build_connect_artifacts_for_stage(ctx, "devops")
    contracts = {artifact.contract for artifact in artifacts}
    assert contracts == {"ObservabilityBaselineManifest", "RuntimePassport", "KnownSafeActionsPack"}
    runtime = next(artifact for artifact in artifacts if artifact.contract == "RuntimePassport")
    assert runtime.payload["entrypoints"]
    assert runtime.payload["runtimeType"] in {"container", "serverless", "other", "vm", "hybrid"}


def test_build_connect_artifacts_for_unknown_stage_fails() -> None:
    ctx = _build_context()
    try:
        build_connect_artifacts_for_stage(ctx, "unknown")
    except ValueError as exc:
        assert "Connect stage desconhecido" in str(exc)
    else:
        raise AssertionError("Expected ValueError for unknown stage")
