from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# Constante ÚNICA da versão dos manifests Connect emitidos pelo Genesis (R4 PR1).
# pipeline_context.PipelineContext.connect_version importa daqui — não duplicar o literal.
CONNECT_SCHEMA_VERSION = os.environ.get("CONNECT_SCHEMA_VERSION", "1.1.0").strip() or "1.1.0"
CONNECT_VERSION_DIR = f"v{CONNECT_SCHEMA_VERSION}"
CONNECT_PROJECT_DIR = f"connect/{CONNECT_VERSION_DIR}"

# Tier DECLARADO nos contratos emitidos. Conservador por honestidade (R4 §2): os manifests
# ainda são parcialmente heurísticos até a spec Connect-ready (PR4); o tier EFETIVO é derivado
# pelo consumidor (Deadpool) pela presença dos contratos, nunca por esta declaração.
CONNECT_DECLARED_TIER = "tier1-integration-ready"

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
    # Versão usada no PATH do artefato — deve ser a MESMA que o runner passa ao
    # storage.write_connect_artifact (ctx.connect_version), senão o path registrado no
    # contexto e o arquivo real divergem (achado adversarial PR1 #4).
    version: str = CONNECT_SCHEMA_VERSION

    def to_json(self) -> str:
        return json.dumps(self.payload, ensure_ascii=False, indent=2)

    @property
    def project_relative_path(self) -> str:
        return f"project/connect/v{self.version}/{self.filename}"


def _schema_for(contract: str) -> dict[str, Any]:
    mapping = {
        "SystemPassport": "manifests/system-passport.schema.json",
        "ServiceManifest": "manifests/service-manifest.schema.json",
        "OwnershipManifest": "manifests/ownership-manifest.schema.json",
        "ObservabilityBaselineManifest": "manifests/observability-baseline-manifest.schema.json",
        "RuntimePassport": "manifests/runtime-passport.schema.json",
        "KnownSafeActionsPack": "manifests/known-safe-actions-pack.schema.json",
        "IntegrationReadyContract": "integration/integration-ready-contract.schema.json",
    }
    relative = mapping.get(contract)
    if not relative:
        return {}
    schema_path = CONNECT_SCHEMA_ROOT / relative
    try:
        if not schema_path.exists():
            # zentriz-connect não disponível neste ambiente — emitir sem validação de schema
            return {}
        return json.loads(schema_path.read_text(encoding="utf-8"))
    except Exception:
        # Falha silenciosa — nunca bloquear o pipeline por ausência de schema
        return {}


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


def _extract_service_candidates(*texts: str, current_module: str = "backend", canonical: str | None = None) -> list[str]:
    """
    Serviços do sistema. O serviço CANÔNICO do projeto (serviceId injetado pela API) vem
    sempre primeiro; os demais são inferidos por regex sobre charter/backlog/proposta
    (fallback heurístico até a spec Connect-ready — R4 PR4). Sem cap artificial (R4: o
    antigo `[:3]` descartava serviços de produtos com 4+ projetos).
    """
    pattern = re.compile(r"\b([a-z0-9][a-z0-9-]{1,40}(?:api|service|worker|webhook|portal|frontend|backend|mobile|consumer))\b", re.IGNORECASE)
    candidates: list[str] = []
    if canonical:
        candidates.append(_slug(canonical))
    for text in texts:
        for match in pattern.findall(text or ""):
            candidates.append(_slug(match))
    if not candidates:
        candidates.append(_slug(f"{current_module}-core"))
    return _dedupe(candidates)


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


def _system_identity(ctx: Any) -> tuple[str, str]:
    """
    Identidade canônica do SISTEMA (R4 PR1 — pré-requisito zero).

    Ordem de precedência:
      1. `ctx.system_id` — `products.system_id` injetado pela API (GET /api/projects/:id →
         `systemId`, mesma derivação `deriveSystemService` usada no registro do Deadpool).
         É a ÚNICA fonte que garante que os manifests emitidos casem com a chave do registry.
      2. `ctx.product_name` — slug do nome do produto (mesmo fallback do `deriveSystemService`).
      3. 1º heading da spec — LEGADO/TESTES. No caminho real o runner sempre preenche
         `system_id` (deriveSystemService nunca devolve vazio: cai em slug do título), logo
         este nível só é alcançado por contextos construídos sem a API (testes/replays antigos).
    """
    fallback = getattr(ctx, "project_id", None) or "genesis-project"
    system_id = (getattr(ctx, "system_id", "") or "").strip()
    product_name = (getattr(ctx, "product_name", "") or "").strip()
    if system_id:
        return _slug(system_id), (product_name or system_id)
    if product_name:
        return _slug(product_name), product_name
    title = _first_heading(getattr(ctx, "product_spec", "") or getattr(ctx, "spec_raw", "") or "", fallback)
    return _slug(title), title


def _canonical_service_id(ctx: Any, system_id: str) -> str:
    """
    serviceId canônico do PROJETO: `ctx.service_id` (API) quando existe; para App solo
    (sistema mono-serviço, serviceId=null no Deadpool) o serviço É o sistema.
    """
    service_id = getattr(ctx, "service_id", None)
    if isinstance(service_id, str) and service_id.strip():
        return _slug(service_id)
    return system_id


def _services_for(ctx: Any, system_id: str) -> list[str]:
    """Serviços do sistema com o serviço canônico do projeto sempre em 1º lugar."""
    return _extract_service_candidates(
        ctx.charter, ctx.backlog, ctx.engineer_proposal,
        current_module=ctx.current_module,
        canonical=_canonical_service_id(ctx, system_id),
    )


def build_system_passport(ctx: Any) -> dict[str, Any]:
    system_name, display_name = _system_identity(ctx)
    service_candidates = _services_for(ctx, system_name)
    owners, _ = _default_owners(system_name)
    artifact_paths = sorted((ctx.artifacts or {}).keys())
    payload = {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "systemName": system_name,
        "displayName": display_name,
        "description": (ctx.charter or ctx.product_spec or ctx.spec_raw or display_name)[:220],
        "integrationTier": CONNECT_DECLARED_TIER,
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
            # Coerente com o tier DECLARADO (não afirmar deadpoolReady enquanto declaramos tier1).
            "deadpoolReady": CONNECT_DECLARED_TIER in ("tier2-deadpool-ready", "tier3-genesis-deadpool-native"),
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
    system_name, _ = _system_identity(ctx)
    _, owners = _default_owners(system_name)
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "owners": owners,
    }


def build_service_manifests(ctx: Any) -> list[dict[str, Any]]:
    system_name, _ = _system_identity(ctx)
    service_candidates = _services_for(ctx, system_name)
    canonical = _canonical_service_id(ctx, system_name)
    manifests = []
    for service in service_candidates:
        service_type = "http" if "api" in service or ctx.current_module == "web" else "other"
        # O serviço canônico do projeto expõe a interface principal do módulo: backend/web = http.
        if service == canonical and (ctx.current_module in ("backend", "web", "fullstack") or not ctx.current_module):
            service_type = "http"
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
    system_name, _ = _system_identity(ctx)
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
    system_name, _ = _system_identity(ctx)
    artifact_paths = sorted((ctx.artifacts or {}).keys())
    services = _services_for(ctx, system_name)
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
    system_name, _ = _system_identity(ctx)
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


def build_integration_ready_contract(ctx: Any) -> dict[str, Any]:
    """
    IntegrationReadyContract — contrato REQUIRED pelo Deadpool (`build_connect_support_profile`:
    sem ele o sistema nunca sai de `tier0-observed`, mesmo com os outros 5 manifests). Até o R4
    PR1 o Genesis nunca o emitia. `supports*` refletem o que este emissor de fato produz;
    `declaredTier` é conservador (ver CONNECT_DECLARED_TIER); `contactPoints` reutilizam os
    owners do passport (sintéticos até a spec Connect-ready — PR4 — nota explícita no payload).
    """
    system_name, _ = _system_identity(ctx)
    passport_owners, _ = _default_owners(system_name)
    contact_points = [
        {"id": o["id"], "name": o["name"], "role": o["role"]} for o in passport_owners
    ] or [{"id": f"{system_name}-owner", "name": "Owner", "role": "owner"}]
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "declaredTier": CONNECT_DECLARED_TIER,
        "supportsIncidentEnvelope": True,
        "supportsOwnershipManifest": True,
        "supportsServiceManifest": True,
        "supportsSafeActionConstraints": True,
        "supportsObservabilityBaseline": True,
        "contactPoints": contact_points,
        "notes": [
            "Emitido pelo Genesis a partir do contexto do pipeline (estágio devops).",
            "contactPoints/owners sintéticos até a spec declarar owners reais do tenant (spec Connect-ready).",
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
                ConnectArtifact("IntegrationReadyContract", "integration-ready-contract.json", build_integration_ready_contract(ctx)),
            ]
        )
    else:
        raise ValueError(f"Connect stage desconhecido: {stage}")

    # Path do artefato segue a versão do CONTEXTO (a mesma que o runner passa ao storage).
    _ctx_version = str(getattr(ctx, "connect_version", "") or CONNECT_SCHEMA_VERSION).lstrip("v")
    for artifact in artifacts:
        artifact.version = _ctx_version

    import logging as _logging
    _log = _logging.getLogger(__name__)
    for artifact in artifacts:
        try:
            errors = validate_connect_artifact(artifact.contract, artifact.payload)
            if errors:
                # Logar como aviso — nunca derrubar o pipeline por erro de validação de schema
                _log.warning(
                    "[Connect] Contrato %s com avisos de validação (stage=%s): %s",
                    artifact.contract, stage, "; ".join(errors),
                )
        except Exception as _val_err:
            _log.warning("[Connect] Falha ao validar contrato %s: %s", artifact.contract, _val_err)
    return artifacts
