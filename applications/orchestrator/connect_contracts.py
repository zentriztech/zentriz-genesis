from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CONNECT_SCHEMA_VERSION = "1.0.0"
CONNECT_VERSION_DIR = f"v{CONNECT_SCHEMA_VERSION}"
CONNECT_PROJECT_DIR = f"connect/{CONNECT_VERSION_DIR}"

REPO_ROOT = Path(__file__).resolve().parents[2]
# ZENTRIZ_CONNECT_ROOT env var allows overriding the path in Docker/CI
# (default: sibling directory ../zentriz-connect, works on host but not in container)
_connect_root_env = os.environ.get("ZENTRIZ_CONNECT_ROOT", "").strip()
CONNECT_ROOT = Path(_connect_root_env) if _connect_root_env else REPO_ROOT.parent / "zentriz-connect"
CONNECT_SCHEMA_ROOT = CONNECT_ROOT / "contract-kit" / "schemas"


@dataclass(slots=True)
class ConnectArtifact:
    contract: str
    filename: str
    payload: dict[str, Any]

    def to_json(self) -> str:
        return json.dumps(self.payload, ensure_ascii=False, indent=2)

    @property
    def project_relative_path(self) -> str:
        return f"project/{CONNECT_PROJECT_DIR}/{self.filename}"


def _schema_for(contract: str) -> dict[str, Any]:
    mapping = {
        "SystemPassport": "manifests/system-passport.schema.json",
        "ServiceManifest": "manifests/service-manifest.schema.json",
        "OwnershipManifest": "manifests/ownership-manifest.schema.json",
        "ObservabilityBaselineManifest": "manifests/observability-baseline-manifest.schema.json",
        "RuntimePassport": "manifests/runtime-passport.schema.json",
        "KnownSafeActionsPack": "manifests/known-safe-actions-pack.schema.json",
    }
    relative = mapping[contract]
    schema_path = CONNECT_SCHEMA_ROOT / relative
    if not schema_path.exists():
        # zentriz-connect não disponível neste ambiente — emitir sem validação de schema
        return {}
    return json.loads(schema_path.read_text(encoding="utf-8"))


def _validate_type(value: Any, schema_type: str) -> bool:
    return {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
    }.get(schema_type, True)


def _validate_payload_against_schema(payload: Any, schema: dict[str, Any], prefix: str = "$") -> list[str]:
    errors: list[str] = []
    schema_type = schema.get("type")
    if schema_type and not _validate_type(payload, schema_type):
        errors.append(f"{prefix}: esperado {schema_type}, recebido {type(payload).__name__}")
        return errors

    if "enum" in schema and payload not in schema["enum"]:
        errors.append(f"{prefix}: valor {payload!r} fora do enum {schema['enum']}")

    if schema_type == "object":
        required = schema.get("required", [])
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False and isinstance(payload, dict):
            unexpected = sorted(set(payload.keys()) - set(properties.keys()))
            for key in unexpected:
                errors.append(f"{prefix}.{key}: propriedade não permitida")
        for key in required:
            if not isinstance(payload, dict) or key not in payload:
                errors.append(f"{prefix}.{key}: campo obrigatório ausente")
        if isinstance(payload, dict):
            for key, value in payload.items():
                if key in properties:
                    errors.extend(_validate_payload_against_schema(value, properties[key], f"{prefix}.{key}"))

    if schema_type == "array" and isinstance(payload, list):
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(payload) < min_items:
            errors.append(f"{prefix}: esperado pelo menos {min_items} item(ns)")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for idx, item in enumerate(payload):
                errors.extend(_validate_payload_against_schema(item, item_schema, f"{prefix}[{idx}]"))

    return errors


def validate_connect_artifact(contract: str, payload: dict[str, Any]) -> list[str]:
    schema = _schema_for(contract)
    return _validate_payload_against_schema(payload, schema)


def _first_heading(text: str, fallback: str) -> str:
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return fallback


def _slug(value: str) -> str:
    lowered = re.sub(r"[^a-zA-Z0-9]+", "-", (value or "").strip().lower())
    return re.sub(r"-{2,}", "-", lowered).strip("-") or "service"


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def _extract_service_candidates(*texts: str, current_module: str = "backend") -> list[str]:
    pattern = re.compile(r"\b([a-z0-9][a-z0-9-]{1,40}(?:api|service|worker|webhook|portal|frontend|backend|mobile|consumer))\b", re.IGNORECASE)
    candidates: list[str] = []
    for text in texts:
        for match in pattern.findall(text or ""):
            candidates.append(_slug(match))
    if not candidates:
        candidates.append(_slug(f"{current_module}-core"))
    return _dedupe(candidates)[:3]


def _infer_runtime_type(*texts: str) -> str:
    joined = " ".join(texts).lower()
    if any(word in joined for word in ("lambda", "serverless", "api gateway", "cloud functions")):
        return "serverless"
    if any(word in joined for word in ("docker", "container", "compose", "kubernetes", "k8s")):
        return "container"
    if "vm" in joined:
        return "vm"
    return "other"


def _infer_environments(*texts: str) -> list[dict[str, str]]:
    joined = " ".join(texts).lower()
    envs: list[dict[str, str]] = []
    if "prod" in joined:
        envs.append({"name": "prod", "type": "prod", "criticality": "high"})
    if "staging" in joined or "stage" in joined:
        envs.append({"name": "staging", "type": "staging", "criticality": "medium"})
    if "dev" in joined:
        envs.append({"name": "dev", "type": "dev", "criticality": "medium"})
    if not envs:
        envs.append({"name": "project-runtime", "type": "other", "criticality": "medium"})
    return envs


def _default_owners(system_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    passport_owners = [
        {"id": f"{system_id}-cto", "name": "Genesis CTO", "role": "cto"},
        {"id": f"{system_id}-pm", "name": "Genesis PM", "role": "pm"},
    ]
    ownership = [
        {
            "scope": "core-platform",
            "technicalOwner": {"id": f"{system_id}-cto", "name": "Genesis CTO", "role": "cto"},
            "productOwner": {"id": f"{system_id}-spec", "name": "SPEC Owner", "role": "spec-owner"},
            "escalationPath": [{"id": f"{system_id}-pm", "name": "Genesis PM", "role": "pm"}],
            "fallbackOwnership": [{"id": f"{system_id}-monitor", "name": "Genesis Monitor", "role": "monitor"}],
        }
    ]
    return passport_owners, ownership


def _extract_path_targets(artifact_paths: list[str], service_candidates: list[str]) -> list[dict[str, Any]]:
    entrypoints: list[dict[str, Any]] = []
    if any(path.endswith("Dockerfile") for path in artifact_paths):
        entrypoints.append({"name": "docker-runtime", "type": "other", "pathOrTarget": "Dockerfile", "critical": True})
    for service in service_candidates:
        if "api" in service:
            entrypoints.append({"name": service, "type": "http", "pathOrTarget": f"/{service}", "critical": True})
        elif "webhook" in service:
            entrypoints.append({"name": service, "type": "webhook", "pathOrTarget": f"/{service}", "critical": True})
        elif any(kind in service for kind in ("worker", "consumer")):
            entrypoints.append({"name": service, "type": "queue", "pathOrTarget": service, "critical": True})
        else:
            entrypoints.append({"name": service, "type": "other", "pathOrTarget": service, "critical": True})
    return _dedupe_entrypoints(entrypoints)[:5]


def _dedupe_entrypoints(entrypoints: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str]] = set()
    out: list[dict[str, Any]] = []
    for item in entrypoints:
        key = (item.get("name", ""), item.get("type", ""))
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def _project_name(ctx: Any) -> tuple[str, str]:
    fallback = ctx.project_id or "genesis-project"
    title = _first_heading(ctx.product_spec or ctx.spec_raw or "", fallback)
    display = title
    system_name = _slug(title)
    return system_name, display


def build_system_passport(ctx: Any) -> dict[str, Any]:
    system_name, display_name = _project_name(ctx)
    service_candidates = _extract_service_candidates(ctx.charter, ctx.backlog, ctx.engineer_proposal, current_module=ctx.current_module)
    owners, _ = _default_owners(system_name)
    artifact_paths = sorted((ctx.artifacts or {}).keys())
    payload = {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "systemName": system_name,
        "displayName": display_name,
        "description": (ctx.charter or ctx.product_spec or ctx.spec_raw or display_name)[:220],
        "integrationTier": "tier2-deadpool-ready",
        "owners": owners,
        "repos": [
            {
                "name": "zentriz-genesis",
                "branchStrategy": "polyrepo-federated",
            }
        ],
        "services": service_candidates,
        "environments": _infer_environments(ctx.spec_raw, ctx.charter, ctx.backlog),
        "capabilityProfile": {
            "deadpoolReady": True,
            "supportsSafeActions": bool(ctx.artifacts),
            "supportsObservabilityBaseline": True,
            "supportsRemediationPRFlow": True,
        },
        "operationalHints": artifact_paths[:5] or [f"module:{ctx.current_module}"],
        "observabilityHints": ["correlate by projectId", "emit structured logs per task"],
        "policyReferences": ["policy://genesis/spec-driven", "policy://deadpool-ready/connect-v1"],
    }
    return payload


def build_ownership_manifest(ctx: Any) -> dict[str, Any]:
    system_name, _ = _project_name(ctx)
    _, owners = _default_owners(system_name)
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "owners": owners,
    }


def build_service_manifests(ctx: Any) -> list[dict[str, Any]]:
    system_name, _ = _project_name(ctx)
    service_candidates = _extract_service_candidates(ctx.charter, ctx.backlog, ctx.engineer_proposal, current_module=ctx.current_module)
    manifests = []
    for service in service_candidates:
        service_type = "http" if "api" in service or ctx.current_module == "web" else "other"
        if "worker" in service or "consumer" in service:
            service_type = "queue"
        if "webhook" in service:
            service_type = "webhook"
        manifests.append(
            {
                "schemaVersion": CONNECT_SCHEMA_VERSION,
                "serviceId": service,
                "serviceName": service.replace("-", " ").title(),
                "systemId": system_name,
                "responsibility": f"Executar responsabilidades do módulo {ctx.current_module} no pipeline do Genesis.",
                "dependencies": ["project-storage", "pipeline-context"],
                "interfaces": [
                    {
                        "name": f"{service}-entrypoint",
                        "type": service_type if service_type in {"http", "queue"} else "other",
                        "contractRef": f"connect://service/{service}",
                    }
                ],
                "deploymentUnit": service,
                "healthModel": {
                    "hasHealthEndpoint": service_type == "http",
                    "signals": ["task_success_rate", "task_failure_rate", "latency_p95"],
                    "sloCritical": True,
                },
                "observabilitySignalsExpected": ["task_success_rate", "task_failure_rate", "latency_p95"],
            }
        )
    return manifests


def build_observability_baseline_manifest(ctx: Any) -> dict[str, Any]:
    system_name, _ = _project_name(ctx)
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "requiredSignals": ["task_success_rate", "task_failure_rate", "latency_p95", "artifact_write_errors"],
        "requiredDashboards": ["pipeline-overview", "task-health", "artifact-generation"],
        "requiredAlerts": ["task_failures_spike", "artifact_write_error", "pipeline_stalled"],
        "traceabilityExpectation": "Cada artefato Connect deve rastrear project_id, request_id e task_id quando houver.",
        "logCorrelationStrategy": "Logs estruturados por request_id, project_id, task_id e stage.",
    }


def build_runtime_passport(ctx: Any) -> dict[str, Any]:
    system_name, _ = _project_name(ctx)
    artifact_paths = sorted((ctx.artifacts or {}).keys())
    services = _extract_service_candidates(ctx.charter, ctx.backlog, ctx.engineer_proposal, current_module=ctx.current_module)
    runtime_type = _infer_runtime_type(ctx.spec_raw, ctx.charter, ctx.backlog, "\n".join(artifact_paths))
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "runtimeType": runtime_type,
        "entrypoints": _extract_path_targets(artifact_paths, services),
        "queues": [service for service in services if any(token in service for token in ("worker", "consumer"))],
        "jobs": ["monitor-loop", "qa-rework-check"],
        "criticalServices": ["project-storage", "agent-runtime"],
        "restartRecoveryHints": ["Restaurar checkpoint antes de reexecutar pipeline."],
        "blastRadiusHints": ["Falha no DevOps não deve invalidar artefatos já persistidos.", "Falha no QA não deve corromper artifacts existentes."],
    }


def build_known_safe_actions_pack(ctx: Any) -> dict[str, Any]:
    system_name, _ = _project_name(ctx)
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "actions": [
            {
                "actionId": "replay-monitor-loop",
                "name": "Replay Monitor Loop",
                "category": "retry",
                "description": "Reexecuta o Monitor Loop após correção de bloqueio operacional sem descartar checkpoints.",
                "preconditions": ["checkpoint íntegro", "task status revisado"],
                "rollbackHint": "Restaurar checkpoint anterior se o replay degradar o estado.",
                "requiresApproval": True,
            }
        ],
    }


def build_connect_artifacts_for_stage(ctx: Any, stage: str) -> list[ConnectArtifact]:
    stage = (stage or "").strip().lower()
    artifacts: list[ConnectArtifact] = []
    if stage == "charter":
        artifacts.extend(
            [
                ConnectArtifact("SystemPassport", "system-passport.json", build_system_passport(ctx)),
                ConnectArtifact("OwnershipManifest", "ownership-manifest.json", build_ownership_manifest(ctx)),
            ]
        )
    elif stage == "backlog":
        for manifest in build_service_manifests(ctx):
            artifacts.append(
                ConnectArtifact(
                    "ServiceManifest",
                    f"service-manifest.{_slug(manifest['serviceId'])}.json",
                    manifest,
                )
            )
    elif stage == "devops":
        artifacts.extend(
            [
                ConnectArtifact(
                    "ObservabilityBaselineManifest",
                    "observability-baseline-manifest.json",
                    build_observability_baseline_manifest(ctx),
                ),
                ConnectArtifact("RuntimePassport", "runtime-passport.json", build_runtime_passport(ctx)),
                ConnectArtifact("KnownSafeActionsPack", "known-safe-actions-pack.json", build_known_safe_actions_pack(ctx)),
            ]
        )
    else:
        raise ValueError(f"Connect stage desconhecido: {stage}")

    for artifact in artifacts:
        errors = validate_connect_artifact(artifact.contract, artifact.payload)
        if errors:
            raise ValueError(f"Contrato {artifact.contract} inválido para stage {stage}: {'; '.join(errors)}")
    return artifacts
