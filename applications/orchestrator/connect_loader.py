"""
ConnectLoader — carrega contratos Connect com cadeia de fallback resiliente.

Cadeia de resolução (primeira que retornar conteúdo válido vence):
  1. PostgreSQL `context_cache` (cache pré-aquecido)
  2. Snapshot em disco (workspace zentriz-connect/contract-kit/schemas)
  3. Env var CONNECT_CONTRACTS_PATH (override em deploys)
  4. Hardcoded minimal fallback (3 contratos essenciais)

Versão pinada por env CONNECT_VERSION_PIN (default 1.1.0).
Nunca lança — sempre retorna ao menos a lista hardcoded.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


CONNECT_VERSION_PIN = os.environ.get("CONNECT_VERSION_PIN", "1.1.0").strip()
CONNECT_CONTRACTS_PATH = os.environ.get("CONNECT_CONTRACTS_PATH", "").strip()

# Mapeamento role → contratos relevantes
_ROLE_CONTRACTS: dict[str, list[str]] = {
    "cto": ["SystemPassport", "ServiceManifest", "OwnershipManifest"],
    "engineer": ["ServiceManifest", "RuntimePassport", "OwnershipManifest"],
    "pm": ["ServiceManifest", "ObservabilityBaselineManifest"],
    "pm_web": ["ServiceManifest", "ObservabilityBaselineManifest"],
    "dev": ["ServiceManifest", "RuntimePassport", "KnownSafeActionsPack"],
    "qa": ["ServiceManifest", "RuntimePassport"],
    "devops": ["RuntimePassport", "KnownSafeActionsPack", "ObservabilityBaselineManifest"],
    "monitor": ["RuntimePassport", "ObservabilityBaselineManifest"],
    "cyborg": ["KnownSafeActionsPack", "RuntimePassport"],
}

_CONTRACT_TO_SCHEMA: dict[str, str] = {
    "SystemPassport": "manifests/system-passport.schema.json",
    "ServiceManifest": "manifests/service-manifest.schema.json",
    "OwnershipManifest": "manifests/ownership-manifest.schema.json",
    "ObservabilityBaselineManifest": "manifests/observability-baseline-manifest.schema.json",
    "RuntimePassport": "manifests/runtime-passport.schema.json",
    "KnownSafeActionsPack": "manifests/known-safe-actions-pack.schema.json",
    "ContextPackage": "cache/context-package.schema.json",
    "LessonRecord": "learning/lesson-record.schema.json",
    "PiiRedactionRules": "pii/pii-redaction-rules.schema.json",
    "RagQueryResult": "rag/rag-query-result.schema.json",
}

# Hardcoded minimal fallback
_HARDCODED_CONTRACTS: list[dict[str, Any]] = [
    {
        "contract": "ServiceManifest",
        "version": CONNECT_VERSION_PIN,
        "summary": "Catálogo de serviços, portas e healthchecks do produto.",
        "payload": {},
        "source": "hardcoded",
    },
    {
        "contract": "RuntimePassport",
        "version": CONNECT_VERSION_PIN,
        "summary": "Stack runtime: linguagens, deps, comandos de boot/test/lint.",
        "payload": {},
        "source": "hardcoded",
    },
    {
        "contract": "KnownSafeActionsPack",
        "version": CONNECT_VERSION_PIN,
        "summary": "Ações pré-aprovadas para automações sem revisão humana.",
        "payload": {},
        "source": "hardcoded",
    },
]


def _genesis_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _candidate_connect_roots() -> list[Path]:
    roots: list[Path] = []
    if CONNECT_CONTRACTS_PATH:
        roots.append(Path(CONNECT_CONTRACTS_PATH).expanduser())
    env_root = os.environ.get("ZENTRIZ_CONNECT_ROOT", "").strip()
    if env_root:
        roots.append(Path(env_root).expanduser())
    repo_root = _genesis_repo_root()
    roots.append(repo_root.parent / "zentriz-connect")
    return roots


def _read_schema_from_disk(relative: str) -> Optional[dict[str, Any]]:
    for root in _candidate_connect_roots():
        candidate = root / "contract-kit" / "schemas" / relative
        if candidate.exists():
            try:
                return json.loads(candidate.read_text(encoding="utf-8"))
            except Exception as exc:
                logger.debug("[ConnectLoader] erro lendo %s: %s", candidate, exc)
    return None


def _load_from_pg_cache() -> list[dict[str, Any]]:
    """Tenta ler contratos cacheados em context_cache (categoria=contract)."""
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        return []
    try:
        try:
            import psycopg2  # type: ignore
            conn = psycopg2.connect(db_url, connect_timeout=2)
        except ImportError:
            import psycopg  # type: ignore
            conn = psycopg.connect(db_url, connect_timeout=2)
    except Exception:
        return []

    out: list[dict[str, Any]] = []
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT cache_key, payload
                      FROM context_cache
                     WHERE category = 'contract'
                       AND expires_at > NOW()
                    """,
                )
                for cache_key, payload in cur.fetchall():
                    if isinstance(payload, str):
                        try:
                            payload = json.loads(payload)
                        except Exception:
                            payload = {}
                    if not isinstance(payload, dict):
                        continue
                    contracts = payload.get("connectContracts") or []
                    if isinstance(contracts, list):
                        out.extend(contracts)
    except Exception as exc:
        logger.debug("[ConnectLoader] context_cache (contract) indisponível: %s", exc)
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return out


class ConnectLoader:
    """Carrega contratos Connect com cadeia de 4 estágios (resiliente)."""

    def __init__(self, version: Optional[str] = None) -> None:
        self.version = (version or CONNECT_VERSION_PIN).strip()

    def load_for_role(
        self, role: str, stack_key: str = "generic"
    ) -> list[dict[str, Any]]:
        """Retorna lista de contratos relevantes para o role; nunca lança."""
        try:
            return self._load_for_role_safe(role, stack_key)
        except Exception as exc:
            logger.warning("[ConnectLoader] fallback hardcoded: %s", exc)
            return list(_HARDCODED_CONTRACTS)

    def _load_for_role_safe(
        self, role: str, stack_key: str
    ) -> list[dict[str, Any]]:
        wanted = _ROLE_CONTRACTS.get(role, list(_CONTRACT_TO_SCHEMA.keys())[:3])

        # Estágio 1: PostgreSQL cache
        pg_hits = _load_from_pg_cache()
        if pg_hits:
            relevant = [c for c in pg_hits if c.get("contract") in wanted]
            if relevant:
                logger.debug(
                    "[ConnectLoader] role=%s — %d contratos do PG cache",
                    role, len(relevant),
                )
                return relevant

        # Estágios 2-3: snapshot em disco / env path
        disk_contracts: list[dict[str, Any]] = []
        for contract_name in wanted:
            relative = _CONTRACT_TO_SCHEMA.get(contract_name)
            if not relative:
                continue
            schema = _read_schema_from_disk(relative)
            if schema:
                disk_contracts.append(
                    {
                        "contract": contract_name,
                        "version": self.version,
                        "summary": schema.get("description")
                        or schema.get("title")
                        or contract_name,
                        "payload": {},
                        "source": "disk",
                    }
                )

        if disk_contracts:
            logger.debug(
                "[ConnectLoader] role=%s — %d contratos do disco (Connect)",
                role, len(disk_contracts),
            )
            return disk_contracts

        # Estágio 4: hardcoded fallback
        logger.warning(
            "[ConnectLoader] sem cache PG nem snapshot — usando fallback hardcoded (role=%s)",
            role,
        )
        return list(_HARDCODED_CONTRACTS)
