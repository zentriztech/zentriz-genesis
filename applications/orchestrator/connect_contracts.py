from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# Constante ÚNICA da versão dos manifests Connect emitidos pelo Genesis (R4 PR1).
# pipeline_context.PipelineContext.connect_version importa daqui — não duplicar o literal.
# R4 PR5: default 1.1.0 → 1.3.0 (Connect 1.3.0 = ADR-013 Connect-local; manifests de runtime são
# idênticos aos 1.1.0 — mudança aditiva). Artefatos passam a ser gravados em project/connect/v1.3.0/.
CONNECT_SCHEMA_VERSION = os.environ.get("CONNECT_SCHEMA_VERSION", "1.3.0").strip() or "1.3.0"
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
        # R4 PR3 — contratos da BANCADA (Connect 1.3.0, ADR-013 Connect-local)
        "ProductManifest": "products/product-manifest.schema.json",
        "SpecConnectDeclaration": "products/spec-connect-declaration.schema.json",
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


def _resolve_ref(ref: str, root: dict[str, Any] | None) -> dict[str, Any] | None:
    """Resolve `$ref` local (`#/$defs/x` ou `#/definitions/x`). Refs externos não são suportados."""
    if not root or not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    node: Any = root
    for part in ref[2:].split("/"):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node if isinstance(node, dict) else None


def _validate_payload_against_schema(payload: Any, schema: dict[str, Any], prefix: str = "$",
                                     root: dict[str, Any] | None = None) -> list[str]:
    """Validador mínimo (sem dependência externa): type (string OU lista de tipos), enum, required,
    additionalProperties:false, properties, items/minItems, `$ref` local (R4 PR3 — o schema
    SpecConnectDeclaration usa `"type": ["string","null"]` e `$ref: #/$defs/owner`; antes disso
    uma lista em `type` levantava TypeError e o soft-fail engolia a validação inteira)."""
    root = root if root is not None else schema
    if "$ref" in schema:
        target = _resolve_ref(schema["$ref"], root)
        if target is None:
            return []  # ref não resolvível → não validar este nó (nunca falso-positivo)
        merged = {k: v for k, v in schema.items() if k != "$ref"}
        merged.update(target)
        schema = merged

    errors: list[str] = []
    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        if payload is None and "null" in schema_type:
            return errors
        if not any(_validate_type(payload, t) for t in schema_type if isinstance(t, str) and t != "null"):
            errors.append(f"{prefix}: esperado {'|'.join(map(str, schema_type))}, recebido {type(payload).__name__}")
            return errors
        # segue com o tipo efetivo do payload para as regras estruturais
        schema_type = next((t for t in schema_type if isinstance(t, str) and t != "null" and _validate_type(payload, t)), None)
    elif schema_type and not _validate_type(payload, schema_type):
        errors.append(f"{prefix}: esperado {schema_type}, recebido {type(payload).__name__}")
        return errors

    if "enum" in schema and payload not in schema["enum"]:
        errors.append(f"{prefix}: valor {payload!r} fora do enum {schema['enum']}")

    if "pattern" in schema and isinstance(payload, str):
        try:
            if not re.search(schema["pattern"], payload):
                errors.append(f"{prefix}: valor {payload!r} não casa com o padrão {schema['pattern']}")
        except re.error:
            pass

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
                    errors.extend(_validate_payload_against_schema(value, properties[key], f"{prefix}.{key}", root))

    if schema_type == "array" and isinstance(payload, list):
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(payload) < min_items:
            errors.append(f"{prefix}: esperado pelo menos {min_items} item(ns)")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for idx, item in enumerate(payload):
                errors.extend(_validate_payload_against_schema(item, item_schema, f"{prefix}[{idx}]", root))

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


# ── R4 PR4 — SPEC-FIRST: renderers leem a SpecConnectDeclaration (connect.yaml) ────────────────
# Regra de precedência (ADR-013 Connect-local): a DECLARAÇÃO define o contrato (SystemPassport,
# ServiceManifest, Ownership); o CÓDIGO define o runtime (entrypoints reais); POLICY (project_types.yaml)
# preenche defaults (health, sinais, categorias de safe actions). Heurística por regex fica só
# como fallback para projetos legados sem connect.yaml.

_INTERFACE_TYPES = {"http", "event", "queue", "stream", "cron", "internal", "other"}
_ENTRYPOINT_TYPES = {"http", "queue", "cron", "stream", "webhook", "cli", "other"}
_RUNTIME_TYPES = {"serverless", "container", "vm", "hybrid", "other"}
_TIERS = {"tier0-generic", "tier1-integration-ready", "tier2-deadpool-ready", "tier3-genesis-deadpool-native"}

# Sinais default por "forma" do serviço (POLICY — independem do domínio do cliente).
_SIGNALS_HTTP = ["http_request_rate", "http_5xx_rate", "latency_p95"]
_SIGNALS_QUEUE = ["queue_lag", "consumer_error_rate", "processing_latency_p95"]
_SIGNALS_CRON = ["job_success_rate", "job_duration_p95", "job_last_run_age"]
_SIGNALS_GENERIC = ["process_up", "error_rate"]


def _decl(ctx: Any) -> dict[str, Any]:
    d = getattr(ctx, "connect_declaration", None)
    return d if isinstance(d, dict) and d else {}


def _decl_interfaces(ctx: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i in _decl(ctx).get("interfaces") or []:
        if not isinstance(i, dict) or not i.get("name"):
            continue
        itype = str(i.get("type") or "other")
        out.append({"name": str(i["name"]), "type": itype if itype in _INTERFACE_TYPES else "other",
                    **({"contractRef": str(i["contractRef"])} if i.get("contractRef") else {})})
    return out


def _policy_for(ctx: Any) -> dict[str, Any]:
    """Policy do tipo do projeto (project_types.yaml) — import tardio: pipeline_context importa este módulo."""
    try:
        from orchestrator.pipeline_context import _resolve_type
        _, pol = _resolve_type(getattr(ctx, "project_type", "") or "")
        return pol if isinstance(pol, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _policy_has_health_route(ctx: Any) -> bool:
    routes = (_policy_for(ctx).get("required_routes") or {})
    all_routes = [str(r) for r in (routes.get("strict") or []) + (routes.get("expected") or [])]
    return any("/health" in r for r in all_routes)


def _service_shape(ctx: Any, interfaces: list[dict[str, Any]]) -> set[str]:
    """Forma do serviço a partir das interfaces declaradas (fallback: módulo/tipo)."""
    shapes = {i["type"] for i in interfaces}
    if not shapes:
        ptype = (getattr(ctx, "project_type", "") or "")
        module = getattr(ctx, "current_module", None) or ""
        # Tipos sem superfície HTTP própria (adversarial PR4 #F): infra/`other`, libs e mobile não
        # ganham `http` por inferência de módulo — senão o Auto Care alertaria sobre /health inexistente.
        if ptype in ("other", "lib_ts") or ptype.startswith("mobile"):
            return shapes
        if "worker" in ptype:
            shapes.add("queue")
        elif module in ("backend", "web", "fullstack") or ptype.startswith(("backend", "frontend", "fullstack")):
            shapes.add("http")
    return shapes


def _default_signals_for(shapes: set[str], declared: list[str]) -> list[str]:
    signals: list[str] = [str(s) for s in declared if s]
    if "http" in shapes or "webhook" in shapes:
        signals += _SIGNALS_HTTP
    if "queue" in shapes or "event" in shapes or "stream" in shapes:
        signals += _SIGNALS_QUEUE
    if "cron" in shapes:
        signals += _SIGNALS_CRON
    if not signals:
        signals += _SIGNALS_GENERIC
    return _dedupe(signals)


def _owner_obj(o: Any) -> dict[str, Any] | None:
    if not isinstance(o, dict) or not o.get("id") or not o.get("name"):
        return None
    out = {"id": str(o["id"]), "name": str(o["name"])}
    if o.get("email"):
        out["email"] = str(o["email"])
    if o.get("role"):
        out["role"] = str(o["role"])
    return out


def _owners(ctx: Any, system_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    """(owners do passport, owners do OwnershipManifest, declarados?). Declarados = owners REAIS do tenant
    vindos do connect.yaml; senão sintéticos (marcados nas notas do IRC)."""
    decl_owners = _decl(ctx).get("owners")
    if isinstance(decl_owners, dict):
        tech = _owner_obj(decl_owners.get("technicalOwner"))
        prod = _owner_obj(decl_owners.get("productOwner"))
        esc = [o for o in (_owner_obj(x) for x in (decl_owners.get("escalationPath") or [])) if o]
        # Owners parciais (adversarial PR4 #B): só productOwner declarado → ele responde também como
        # technicalOwner (schema exige technicalOwner) em vez de descartar o owner REAL pelo sintético.
        if not tech and prod:
            tech = dict(prod)
        if not tech and esc:
            tech = dict(esc[0])
        if tech:
            passport = _dedupe_owners([tech] + ([prod] if prod else []) + esc)
            ownership: dict[str, Any] = {"scope": _canonical_service_id(ctx, system_id), "technicalOwner": tech}
            if prod:
                ownership["productOwner"] = prod
            if esc:
                ownership["escalationPath"] = esc
            return passport, [ownership], True
    passport, ownership_list = _default_owners(system_id)
    return passport, ownership_list, False


def _dedupe_owners(owners: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for o in owners:
        if o["id"] not in seen:
            seen.add(o["id"])
            out.append(o)
    return out


def _environments(ctx: Any) -> list[dict[str, Any]]:
    envs = []
    for e in _decl(ctx).get("environments") or []:
        if isinstance(e, dict) and e.get("name") and e.get("type"):
            item = {"name": str(e["name"]), "type": str(e["type"])}
            for k in ("region", "criticality"):
                if e.get(k):
                    item[k] = str(e[k])
            envs.append(item)
    return envs or _infer_environments(ctx.spec_raw, ctx.charter, ctx.backlog)


def build_system_passport(ctx: Any) -> dict[str, Any]:
    system_name, display_name = _system_identity(ctx)
    decl = _decl(ctx)
    # Spec-first: com declaração, os serviços do sistema são o canônico + dependências irmãs declaradas
    # (o regex sobre prosa fica só para legado).
    if decl:
        canonical = _canonical_service_id(ctx, system_name)
        service_candidates = _dedupe([canonical] + [_slug(str(d)) for d in (decl.get("dependencies") or []) if d])
    else:
        service_candidates = _services_for(ctx, system_name)
    owners, _, _ = _owners(ctx, system_name)
    artifact_paths = sorted((ctx.artifacts or {}).keys())
    description = (str(decl.get("responsibility") or "") or ctx.charter or ctx.product_spec or ctx.spec_raw or display_name)[:220]
    payload = {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "systemName": system_name,
        "displayName": display_name,
        "description": description,
        "integrationTier": CONNECT_DECLARED_TIER,
        "owners": owners,
        "repos": [
            {
                "name": _slug(system_name),
                "branchStrategy": "polyrepo-federated",
            }
        ],
        "services": service_candidates,
        "environments": _environments(ctx),
        "capabilityProfile": {
            # Coerente com o tier DECLARADO (não afirmar deadpoolReady enquanto declaramos tier1).
            "deadpoolReady": CONNECT_DECLARED_TIER in ("tier2-deadpool-ready", "tier3-genesis-deadpool-native"),
            "supportsSafeActions": bool(ctx.artifacts),
            "supportsObservabilityBaseline": True,
            "supportsRemediationPRFlow": True,
        },
        "operationalHints": artifact_paths[:5] or [f"module:{ctx.current_module}"],
        "observabilityHints": ["correlate by request_id/correlation_id", "structured logs with tenant_id and service_id"],
        "policyReferences": ["policy://genesis/spec-driven", "policy://deadpool-ready/connect-v1"]
        + ([f"tier-target://{decl['integrationTierTarget']}"] if decl.get("integrationTierTarget") in _TIERS else []),
    }
    return payload


def build_ownership_manifest(ctx: Any) -> dict[str, Any]:
    system_name, _ = _system_identity(ctx)
    _, owners, _ = _owners(ctx, system_name)
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "owners": owners,
    }


def _service_manifest_from_declaration(ctx: Any, system_name: str) -> dict[str, Any]:
    """ServiceManifest SPEC-FIRST: renderizado do connect.yaml (+ POLICY para health/sinais)."""
    decl = _decl(ctx)
    canonical = _canonical_service_id(ctx, system_name)
    service_id = _slug(str(decl.get("serviceId") or "")) if decl.get("serviceId") else canonical
    interfaces = _decl_interfaces(ctx)
    shapes = _service_shape(ctx, interfaces)
    health = decl.get("healthModel") if isinstance(decl.get("healthModel"), dict) else {}
    has_health = health.get("hasHealthEndpoint")
    if not isinstance(has_health, bool):
        has_health = _policy_has_health_route(ctx) or ("http" in shapes)
    signals = _default_signals_for(shapes, [str(s) for s in (health.get("signals") or [])])
    deps = _dedupe([str(d) for d in (decl.get("dependencies") or []) if d])
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "serviceId": service_id,
        "serviceName": str(decl.get("serviceName") or service_id.replace("-", " ").title()),
        "systemId": system_name,
        "responsibility": str(decl.get("responsibility") or f"Responsabilidades do serviço {service_id}."),
        "dependencies": deps,
        # Honesto: sem interfaces declaradas → [] (schema não exige; placeholder inventado é falsa precisão).
        "interfaces": interfaces,
        "deploymentUnit": service_id,
        "healthModel": {
            "hasHealthEndpoint": bool(has_health),
            "signals": signals,
            "sloCritical": bool(health.get("sloCritical", False)),
        },
        "observabilitySignalsExpected": signals,
    }


def build_service_manifests(ctx: Any) -> list[dict[str, Any]]:
    system_name, _ = _system_identity(ctx)
    if _decl(ctx):
        # Spec-first: este projeto É um serviço; o manifesto vem da declaração (1 por projeto).
        return [_service_manifest_from_declaration(ctx, system_name)]
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


def _shapes_for_ctx(ctx: Any, system_name: str) -> set[str]:
    """Forma(s) do serviço: da declaração quando existe; senão inferida dos candidatos por regex (legado)."""
    if _decl(ctx):
        return _service_shape(ctx, _decl_interfaces(ctx))
    services = _services_for(ctx, system_name)
    shapes: set[str] = set()
    for s in services:
        if "api" in s or "web" in s or "portal" in s or "frontend" in s or "backend" in s:
            shapes.add("http")
        if "worker" in s or "consumer" in s:
            shapes.add("queue")
        if "webhook" in s:
            shapes.add("webhook")
    return shapes or _service_shape(ctx, [])


def build_observability_baseline_manifest(ctx: Any) -> dict[str, Any]:
    """Baseline de observabilidade do PRODUTO (não do pipeline do Genesis — R4: os sinais antigos
    `task_success_rate`/`pipeline-overview` descreviam a fábrica, e o Auto Care alertaria sobre
    métricas inexistentes no sistema do cliente)."""
    system_name, _ = _system_identity(ctx)
    decl = _decl(ctx)
    shapes = _shapes_for_ctx(ctx, system_name)
    health = decl.get("healthModel") if isinstance(decl.get("healthModel"), dict) else {}
    signals = _default_signals_for(shapes, [str(s) for s in (health.get("signals") or [])])
    service_id = _canonical_service_id(ctx, system_name)
    alerts: list[str] = []
    if "http" in shapes or "webhook" in shapes:
        alerts += ["http_5xx_rate_high", "latency_p95_breach", "health_endpoint_down"]
    if "queue" in shapes or "event" in shapes or "stream" in shapes:
        alerts += ["queue_lag_high", "consumer_error_rate_high", "dlq_not_empty"]
    if "cron" in shapes:
        alerts += ["job_failed", "job_missed_schedule"]
    if not alerts:
        alerts = ["process_down", "error_rate_high"]
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "requiredSignals": signals,
        "requiredDashboards": [f"{service_id}-overview", "runtime-health"],
        "requiredAlerts": _dedupe(alerts),
        "traceabilityExpectation": "Toda requisição/mensagem carrega request_id (ou correlation_id) e tenant_id, propagados a logs, métricas e eventos.",
        "logCorrelationStrategy": "Logs estruturados (JSON) com request_id, tenant_id, service_id e, quando houver, event_id.",
    }


def build_runtime_passport(ctx: Any) -> dict[str, Any]:
    """RuntimePassport: o CÓDIGO define o runtime (entrypoints reais dos artefatos); a declaração
    contribui runtimeType (distribuição declarada), filas e entrypoints ESPERADOS das interfaces."""
    system_name, _ = _system_identity(ctx)
    decl = _decl(ctx)
    artifact_paths = sorted((ctx.artifacts or {}).keys())
    services = _services_for(ctx, system_name) if not decl else [_canonical_service_id(ctx, system_name)]
    declared_rt = str(decl.get("runtimeType") or "")
    runtime_type = declared_rt if declared_rt in _RUNTIME_TYPES else _infer_runtime_type(
        ctx.spec_raw, ctx.charter, ctx.backlog, "\n".join(artifact_paths))
    entrypoints = _extract_path_targets(artifact_paths, services) if not decl else (
        [{"name": "docker-runtime", "type": "other", "pathOrTarget": "Dockerfile", "critical": True}]
        if any(p.endswith("Dockerfile") for p in artifact_paths) else []
    )
    for i in _decl_interfaces(ctx):
        etype = i["type"] if i["type"] in _ENTRYPOINT_TYPES else ("other" if i["type"] in ("event", "internal") else "other")
        entrypoints.append({"name": i["name"], "type": etype,
                            "pathOrTarget": i.get("contractRef") or i["name"], "critical": etype in ("http", "queue")})
    queues = _dedupe([str(q) for q in (decl.get("queues") or []) if q]) if decl else \
        [s for s in services if any(t in s for t in ("worker", "consumer"))]
    jobs = [i["name"] for i in _decl_interfaces(ctx) if i["type"] == "cron"]
    critical = _dedupe([str(d) for d in (decl.get("dependencies") or []) if d])
    return {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "runtimeType": runtime_type,
        "entrypoints": _dedupe_entrypoints(entrypoints)[:12],
        "queues": queues,
        "jobs": jobs,
        "criticalServices": critical,
        "restartRecoveryHints": ["Reiniciar o serviço só após confirmar dependências (banco/fila) saudáveis.", "Validar GET /health antes de liberar tráfego."],
        "blastRadiusHints": ["Reinício do serviço não deve afetar outros serviços do sistema.", "Reprocessamento de fila deve ser idempotente."],
    }


def build_known_safe_actions_pack(ctx: Any) -> dict[str, Any]:
    """Ações seguras derivadas da FORMA do serviço (POLICY) — nunca ações do pipeline do Genesis
    (o antigo `replay-monitor-loop` virava candidata de remediação no Deadpool). Todas exigem aprovação."""
    system_name, _ = _system_identity(ctx)
    service_id = _canonical_service_id(ctx, system_name)
    shapes = _shapes_for_ctx(ctx, system_name)
    actions: list[dict[str, Any]] = [{
        "actionId": f"{service_id}-restart",
        "name": f"Reiniciar {service_id}",
        "category": "restart",
        "description": "Reinicia o serviço (container/processo) preservando dados; usar quando health falha sem erro de dependência.",
        "preconditions": ["dependências (banco/fila) saudáveis", "sem deploy em andamento"],
        "rollbackHint": "Se o reinício não restaurar o health em 2 tentativas, escalar ao owner técnico.",
        "requiresApproval": True,
    }]
    if "queue" in shapes or "event" in shapes or "stream" in shapes:
        actions.append({
            "actionId": f"{service_id}-requeue-dlq",
            "name": "Reprocessar DLQ",
            "category": "requeue",
            "description": "Move mensagens da DLQ de volta para a fila principal após correção da causa.",
            "preconditions": ["causa-raiz corrigida", "consumidor idempotente"],
            "rollbackHint": "Pausar o consumidor e devolver as mensagens à DLQ.",
            "requiresApproval": True,
        })
    if "http" in shapes or "webhook" in shapes:
        actions.append({
            "actionId": f"{service_id}-invalidate-cache",
            "name": "Invalidar cache",
            "category": "invalidate-cache",
            "description": "Invalida caches de leitura do serviço quando há dados inconsistentes após deploy/migração.",
            "preconditions": ["fonte de verdade (banco) íntegra"],
            "rollbackHint": "Sem rollback (cache é reconstruído sob demanda).",
            "requiresApproval": True,
        })
    return {"schemaVersion": CONNECT_SCHEMA_VERSION, "systemId": system_name, "actions": actions}


# Tokens (heurísticos, ESPECÍFICOS) que evidenciam cada forma de interface no CÓDIGO gerado —
# usados só pela RECONCILIAÇÃO declarado × gerado (nunca para inventar contrato). Adversarial PR4 #C:
# a versão anterior casava prosa de README ("cron", "sse"⊂"assess", "Readable", "emit(") → 3/3
# falsos positivos. Agora: só arquivos de código sob apps/, tokens de framework, e `event`/`stream`
# só como AUSÊNCIA (declared-but-missing), nunca como "não declarado".
_CODE_HINTS = {
    "http": ("app.get(", "app.post(", "app.use(", "router.get(", "router.post(", "@Get(", "@Post(", "@Controller(",
             "fastify(", "express()", "FastAPI(", "@app.get(", "@app.post(", "http.createServer(", "new Hono(", "gin.Default("),
    "queue": ("amqplib", "amqp.connect(", "@golevelup/nestjs-rabbitmq", "@RabbitSubscribe(", "SQSClient", "ReceiveMessageCommand",
              "KafkaJS", "kafkajs", "new Kafka(", "bullmq", "new Queue(", "new Worker(", "channel.consume(", "pika.BlockingConnection", "boto3.client('sqs'"),
    "event": ("publishEvent(", "eventBus.publish(", "domainEvents", "OutboxEvent", "outbox_events", "EventPublisher", "@EventPattern("),
    "cron": ("node-cron", "cron.schedule(", "@Cron(", "CronJob(", "APScheduler", "BackgroundScheduler(", "@nestjs/schedule", "cron.ScheduleJob("),
    "stream": ("KinesisClient", "socket.io", "new WebSocketServer(", "text/event-stream", "grpc.Server(", "@grpc/grpc-js"),
}
# Formas que só podem ser reportadas como AUSENTES (tokens de "encontrado" são ambíguos demais).
_MISSING_ONLY_SHAPES = {"event", "stream"}
_CODE_EXTS = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".java", ".kt", ".rb", ".cs", ".rs", ".php")


_CORPUS_SKIP_DIRS = ("node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", ".venv", "venv", "fixtures", "__mocks__", "mocks")
_CORPUS_MAX_FILE = 200_000
_CORPUS_MAX_TOTAL = 2_000_000


def _is_test_path(p: str) -> bool:
    low = p.lower()
    return ("/tests/" in f"/{low}" or "/test/" in f"/{low}" or "/__tests__/" in f"/{low}"
            or ".test." in low or ".spec." in low or low.startswith("tests/") or low.startswith("test/"))


def _code_corpus_files(ctx: Any) -> dict[str, str]:
    """Bloco 3 F2 — corpus = código FINAL do serviço: artefatos gerados nesta run (ctx.artifacts) + o `apps/` em
    DISCO (código herdado do pai em evolução; antes a reconciliação só via o que os agentes geraram → falso
    `declared_but_missing` para tudo que já existia). Só código sob apps/, sem testes/fixtures/minificados;
    caps por arquivo e total. Devolve {path_relativo: conteúdo} — evidência por arquivo no report."""
    files: dict[str, str] = {}
    for path, content in (ctx.artifacts or {}).items():
        p = str(path)
        if not (p.startswith("apps/") or "/apps/" in p) or not p.lower().endswith(_CODE_EXTS) or _is_test_path(p):
            continue
        files[p] = str(content)
    if os.environ.get("EVOLUTION_RECONCILE_DISK", "on").lower() == "off":
        return files
    root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
    pid = str(getattr(ctx, "project_id", "") or "")
    prod = str(getattr(ctx, "product_id", "") or "")
    if not pid:
        return files
    cands = [os.path.join(root, prod, pid, "apps")] if prod else []
    cands.append(os.path.join(root, pid, "apps"))
    apps_dir = next((c for c in cands if os.path.isdir(c)), None)
    if not apps_dir:
        return files
    total = sum(len(v) for v in files.values())
    for dirpath, dirnames, filenames in os.walk(apps_dir):
        # Determinístico entre runs (o cap pode cortar): diretórios ordenados; `.venv-genesis` do executor fora.
        dirnames[:] = sorted(d for d in dirnames if d not in _CORPUS_SKIP_DIRS and not d.startswith(".venv"))
        for fn in sorted(filenames):
            if not fn.lower().endswith(_CODE_EXTS) or fn.lower().endswith((".min.js", ".min.mjs")):
                continue
            full = os.path.join(dirpath, fn)
            rel = "apps/" + os.path.relpath(full, apps_dir).replace(os.sep, "/")
            if rel in files or _is_test_path(rel):
                continue
            try:
                if os.path.getsize(full) > _CORPUS_MAX_FILE:
                    continue
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    txt = fh.read()
            except OSError:
                continue
            if total + len(txt) > _CORPUS_MAX_TOTAL:
                break
            files[rel] = txt
            total += len(txt)
    return files


def _code_corpus(ctx: Any) -> str:
    """Compat: corpus concatenado (ver _code_corpus_files)."""
    return "\n".join(_code_corpus_files(ctx).values())


def _parent_reconciliation(ctx: Any) -> dict[str, Any] | None:
    """Bloco 3 F2 — baseline em evolução: reconciliation.json do PAI (project/connect/v*/). None se não houver."""
    parent = str(getattr(ctx, "evolution_parent_id", "") or "")
    if not parent:
        return None
    root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
    prod = str(getattr(ctx, "product_id", "") or "")
    for base in ([os.path.join(root, prod, parent)] if prod else []) + [os.path.join(root, parent)]:
        cdir = os.path.join(base, "project", "connect")
        if not os.path.isdir(cdir):
            continue
        def _vkey(v: str) -> tuple:
            nums = re.findall(r"\d+", v)
            return tuple(int(n) for n in nums) if nums else (0,)
        for ver in sorted(os.listdir(cdir), key=_vkey, reverse=True):  # semântico: v1.10.0 > v1.9.0
            f = os.path.join(cdir, ver, "reconciliation.json")
            if os.path.isfile(f):
                try:
                    with open(f, "r", encoding="utf-8") as fh:
                        data = json.load(fh)
                    return data if isinstance(data, dict) else None
                except Exception:
                    return None
    return None


def build_reconciliation_report(ctx: Any) -> dict[str, Any]:
    """Reconciliação DECLARADO × GERADO (R4 §3 / ADR-013 Connect-local). Só faz sentido com
    connect.yaml; sem declaração devolve status `not-applicable`. Divergência é FINDING (QA), não
    silêncio — e enquanto houver `declared_but_missing`, o sistema não deve ser anunciado como tier2."""
    system_name, _ = _system_identity(ctx)
    service_id = _canonical_service_id(ctx, system_name)
    decl_ifaces = _decl_interfaces(ctx)
    if not _decl(ctx):
        return {"schemaVersion": CONNECT_SCHEMA_VERSION, "systemId": system_name, "serviceId": service_id,
                "status": "not-applicable", "declaredButMissing": [], "foundButUndeclared": [],
                "notes": ["Projeto sem connect.yaml (legado): manifests emitidos por heurística."]}
    files = _code_corpus_files(ctx)
    code = "\n".join(files.values())
    def _evidence(shape: str) -> list[str]:
        """Arquivos (apps/…) com token do shape — evidência por arquivo, não só booleano (case-sensitive: tokens de framework)."""
        hints = _CODE_HINTS.get(shape, ())
        return sorted(p for p, txt in files.items() if any(h in txt for h in hints))[:20]
    def _found(shape: str) -> bool:
        return bool(_evidence(shape))
    declared_shapes = {i["type"] for i in decl_ifaces if i["type"] in _CODE_HINTS}
    missing = [{"interface": i["name"], "type": i["type"], "reason": "nenhuma evidência no código (apps/ gerado + em disco)"}
               for i in decl_ifaces if i["type"] in _CODE_HINTS and code and not _found(i["type"])]
    undeclared = [{"type": shape, "reason": "evidência de framework no código sem interface declarada", "evidence": _evidence(shape)}
                  for shape in ("http", "queue", "cron")
                  if code and shape not in declared_shapes and shape not in _MISSING_ONLY_SHAPES and _found(shape)]
    status = "clean" if not missing and not undeclared else "divergent"
    if not code:
        status = "pending"  # ainda sem artefatos (estágio anterior ao Dev)
    notes = ["Heurística por tokens no código (apps/ gerado nesta run + código em disco) — evidência, não prova. Divergência vira finding de QA."]
    report: dict[str, Any] = {
        "schemaVersion": CONNECT_SCHEMA_VERSION,
        "systemId": system_name,
        "serviceId": service_id,
        "status": status,
        "declaredButMissing": missing,
        "foundButUndeclared": undeclared,
        "corpus": {"files": len(files), "bytes": len(code)},
        "notes": notes,
    }
    # Bloco 3 F2 — evolução: baseline = reconciliation.json do PAI; só divergências NOVAS são finding.
    parent = _parent_reconciliation(ctx)
    if parent is not None:
        pm = {(m.get("interface"), m.get("type")) for m in (parent.get("declaredButMissing") or []) if isinstance(m, dict)}
        pu = {u.get("type") for u in (parent.get("foundButUndeclared") or []) if isinstance(u, dict)}
        report["baseline"] = {"source": "parent-reconciliation", "parentStatus": parent.get("status")}
        report["newDeclaredButMissing"] = [m for m in missing if (m["interface"], m["type"]) not in pm]
        report["newFoundButUndeclared"] = [u for u in undeclared if u["type"] not in pu]
        report["status"] = "clean" if not report["newDeclaredButMissing"] and not report["newFoundButUndeclared"] else ("divergent" if code else "pending")
        notes.append("Evolução: status considera só divergências NOVAS em relação à versão anterior (baseline = pai).")
    return report


def build_integration_ready_contract(ctx: Any) -> dict[str, Any]:
    """
    IntegrationReadyContract — contrato REQUIRED pelo Deadpool (`build_connect_support_profile`:
    sem ele o sistema nunca sai de `tier0-observed`, mesmo com os outros 5 manifests). Até o R4
    PR1 o Genesis nunca o emitia. `supports*` refletem o que este emissor de fato produz;
    `declaredTier` é conservador (ver CONNECT_DECLARED_TIER); `contactPoints` reutilizam os
    owners do passport (sintéticos até a spec Connect-ready — PR4 — nota explícita no payload).
    """
    system_name, _ = _system_identity(ctx)
    passport_owners, _, declared = _owners(ctx, system_name)
    contact_points = [
        {k: v for k, v in o.items() if k in ("id", "name", "email", "role")} for o in passport_owners
    ] or [{"id": f"{system_name}-owner", "name": "Owner", "role": "owner"}]
    notes = ["Emitido pelo Genesis a partir do contexto do pipeline (estágio devops)."]
    if declared:
        notes.append("contactPoints = owners declarados na spec (connect.yaml) — spec Connect-ready.")
    else:
        notes.append("contactPoints/owners SINTÉTICOS (projeto sem connect.yaml) — não usar para escalonamento real.")
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
        "notes": notes,
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
                # R4 PR4: reconciliação declarado × gerado (sem schema Connect — validação é pulada).
                ConnectArtifact("ReconciliationReport", "reconciliation.json", build_reconciliation_report(ctx)),
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
        if artifact.contract == "ReconciliationReport":
            if artifact.payload.get("status") == "divergent":
                _log.warning("[Connect] RECONCILIAÇÃO divergente (declarado × gerado): faltando=%s não-declarado=%s",
                             [m.get("interface") for m in artifact.payload.get("declaredButMissing", [])],
                             [u.get("type") for u in artifact.payload.get("foundButUndeclared", [])])
            continue
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
