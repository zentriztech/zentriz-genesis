"""
ContextLoader — CAG (Context-Aware Generation) para Genesis.

Responsabilidade: montar um ContextPackage que será PREFIXADO ao SYSTEM_PROMPT
estático. Combina:
  1. Contratos Connect carregados pelo ConnectLoader
  2. Bug checklists pré-seedados em context_cache
  3. Lições "quentes" (top hits) — em F3 inclui também busca semântica via RAG

Modos (env CAG_ENABLED):
  off    — retorna ContextPackage vazio. Pipeline atua exatamente como antes.
  shadow — popula cache mas DEVOLVE pacote vazio para injeção (observabilidade).
  live   — popula cache E devolve pacote pronto para injeção no prompt.

REGRA DE OURO: qualquer falha → retornar ContextPackage vazio. Nunca lançar.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

CAG_ENABLED = os.environ.get("CAG_ENABLED", "off").strip().lower()
RAG_ENABLED = os.environ.get("RAG_ENABLED", "off").strip().lower()
CONNECT_VERSION_PIN = os.environ.get("CONNECT_VERSION_PIN", "1.1.0").strip()
LEGACY_PROMPT_FALLBACK = os.environ.get(
    "LEGACY_PROMPT_FALLBACK", "true"
).strip().lower() in ("1", "true", "yes")

VALID_MODES = {"off", "shadow", "live"}
if CAG_ENABLED not in VALID_MODES:
    logger.warning("CAG_ENABLED='%s' inválido — assumindo 'off'", CAG_ENABLED)
    CAG_ENABLED = "off"

# DB connection — a CLI usa o mesmo DATABASE_URL do api-node
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()


# ─────────────────────────────────────────────────────────────────────────────
# Tipos
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(slots=True)
class ContextPackage:
    """Pacote de contexto retornado pelo ContextLoader.load()."""

    role: str = ""
    stack_key: str = "generic"
    project_id: Optional[str] = None
    connect_version: str = CONNECT_VERSION_PIN
    mode: str = "off"

    system_prompt_prefix: str = ""
    connect_contracts: list[dict[str, Any]] = field(default_factory=list)
    bug_checklists: list[dict[str, Any]] = field(default_factory=list)
    lessons_hot: list[dict[str, Any]] = field(default_factory=list)

    payload_tokens: int = 0
    cache_hit: bool = False
    duration_ms: int = 0

    def is_empty(self) -> bool:
        return not (
            self.system_prompt_prefix
            or self.connect_contracts
            or self.bug_checklists
            or self.lessons_hot
        )

    def to_prompt_prefix(self) -> str:
        """Renderiza o pacote como string Markdown injetável no SYSTEM_PROMPT."""
        if self.is_empty():
            return ""

        parts: list[str] = []
        parts.append("## CONTEXTO INJETADO (CAG)\n")
        parts.append(
            f"_Role: {self.role} • Stack: {self.stack_key} • "
            f"Connect: {self.connect_version} • Lessons: {len(self.lessons_hot)}_\n"
        )

        if self.system_prompt_prefix:
            parts.append(self.system_prompt_prefix.strip())
            parts.append("")

        if self.connect_contracts:
            parts.append("### Contratos Connect aplicáveis\n")
            for c in self.connect_contracts:
                parts.append(
                    f"- **{c.get('contract', '?')}** v{c.get('version', '?')}"
                    + (f" — {c['summary']}" if c.get("summary") else "")
                )
            parts.append("")

        if self.bug_checklists:
            parts.append("### Bugs conhecidos — checklist obrigatório\n")
            for b in self.bug_checklists:
                parts.append(f"- **{b.get('title', b.get('slug', '?'))}**")
                if b.get("rule"):
                    parts.append(f"  - Regra: {b['rule']}")
            parts.append("")

        if self.lessons_hot:
            parts.append("### Lições relevantes (corpus RAG)\n")
            for ln in self.lessons_hot:
                parts.append(
                    f"- **{ln.get('title', '?')}** "
                    f"(conf={ln.get('confidence', 0):.2f}, hits={ln.get('hitCount', 0)})"
                )
                body = (ln.get("bodyMd") or "").strip()
                if body:
                    snippet = body[:240] + ("…" if len(body) > 240 else "")
                    parts.append(f"  - {snippet}")
            parts.append("")

        parts.append("---\n")
        return "\n".join(parts)


# ─────────────────────────────────────────────────────────────────────────────
# DB helpers (psycopg2 opcional; fallback gracioso)
# ─────────────────────────────────────────────────────────────────────────────

def _open_pg_connection():
    """Tenta abrir conexão PostgreSQL. Retorna None se indisponível."""
    if not DATABASE_URL:
        return None
    try:
        import psycopg2  # type: ignore
    except ImportError:
        try:
            import psycopg  # type: ignore  # psycopg3
            return psycopg.connect(DATABASE_URL, connect_timeout=3)
        except Exception:
            return None
    try:
        return psycopg2.connect(DATABASE_URL, connect_timeout=3)
    except Exception as exc:
        logger.debug("[ContextLoader] Falha ao conectar no Postgres: %s", exc)
        return None


def _query_context_cache(
    role: str, stack_key: str, project_id: Optional[str]
) -> list[dict[str, Any]]:
    """Lê context_cache filtrando por role + stack + project_id (NULL = global)."""
    conn = _open_pg_connection()
    if conn is None:
        return []

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT cache_key, category, payload, payload_tokens
                      FROM context_cache
                     WHERE role = %s
                       AND (stack_key = %s OR stack_key = 'generic')
                       AND (project_id = %s::uuid OR project_id IS NULL)
                       AND expires_at > NOW()
                  ORDER BY (CASE WHEN project_id IS NOT NULL THEN 0 ELSE 1 END),
                           (CASE WHEN stack_key = %s THEN 0 ELSE 1 END),
                           created_at DESC
                     LIMIT 50
                    """,
                    (role, stack_key, project_id, stack_key),
                )
                rows = cur.fetchall()
        out: list[dict[str, Any]] = []
        for cache_key, category, payload, payload_tokens in rows:
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except Exception:
                    payload = {}
            out.append(
                {
                    "cache_key": cache_key,
                    "category": category,
                    "payload": payload or {},
                    "payload_tokens": payload_tokens or 0,
                }
            )
        return out
    except Exception as exc:
        logger.debug("[ContextLoader] Erro lendo context_cache: %s", exc)
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _bump_hits(cache_keys: list[str]) -> None:
    """Incrementa contador de hits de forma best-effort (não bloqueia em caso de erro)."""
    if not cache_keys:
        return
    conn = _open_pg_connection()
    if conn is None:
        return
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE context_cache
                       SET hits = hits + 1, last_hit_at = NOW()
                     WHERE cache_key = ANY(%s)
                    """,
                    (cache_keys,),
                )
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# RAG (preenchido em F3) — interface estável
# ─────────────────────────────────────────────────────────────────────────────

def _query_lessons_top_hits(
    role: str, stack_key: str, project_id: Optional[str], limit: int = 20
) -> list[dict[str, Any]]:
    """
    Top-N lições por (hit_count * confidence). Lê de lessons_corpus se a tabela
    existir (criada na migration 026). Caso contrário, retorna lista vazia.
    """
    conn = _open_pg_connection()
    if conn is None:
        return []
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT to_regclass('public.lessons_corpus') IS NOT NULL"
                )
                has_corpus = cur.fetchone()[0]
                if not has_corpus:
                    return []
                cur.execute(
                    """
                    SELECT slug, title, category, scope, confidence, hit_count, body_md
                      FROM lessons_corpus
                     WHERE (project_id = %s::uuid OR project_id IS NULL)
                  ORDER BY (hit_count * confidence) DESC, last_hit_at DESC NULLS LAST
                     LIMIT %s
                    """,
                    (project_id, limit),
                )
                rows = cur.fetchall()
        return [
            {
                "slug": r[0],
                "title": r[1],
                "category": r[2],
                "scope": r[3],
                "confidence": float(r[4]) if r[4] is not None else 0.0,
                "hitCount": r[5] or 0,
                "bodyMd": r[6] or "",
            }
            for r in rows
        ]
    except Exception as exc:
        logger.debug("[ContextLoader] lessons_corpus indisponível: %s", exc)
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# ContextLoader
# ─────────────────────────────────────────────────────────────────────────────

class ContextLoader:
    """
    Carrega ContextPackage para um (role, stack_key, project_id).

    Uso:
        loader = ContextLoader()
        pkg = loader.load(role="dev", stack_key="python-fastapi", project_id=None)
        prefix = pkg.to_prompt_prefix()
    """

    def __init__(self, mode: Optional[str] = None) -> None:
        self.mode = (mode or CAG_ENABLED).strip().lower()
        if self.mode not in VALID_MODES:
            self.mode = "off"

    def load(
        self,
        role: str,
        stack_key: str = "generic",
        project_id: Optional[str] = None,
    ) -> ContextPackage:
        """Retorna ContextPackage. Nunca lança; falhas viram pacote vazio."""
        t0 = time.perf_counter()

        if self.mode == "off":
            return ContextPackage(
                role=role,
                stack_key=stack_key,
                project_id=project_id,
                mode="off",
                duration_ms=0,
            )

        try:
            return self._load_safe(role, stack_key, project_id, t0)
        except Exception as exc:
            logger.warning(
                "[ContextLoader] Falha em load(role=%s, stack=%s, project=%s): %s",
                role, stack_key, project_id, exc,
            )
            return ContextPackage(
                role=role,
                stack_key=stack_key,
                project_id=project_id,
                mode=self.mode,
                duration_ms=int((time.perf_counter() - t0) * 1000),
            )

    def _load_safe(
        self,
        role: str,
        stack_key: str,
        project_id: Optional[str],
        t0: float,
    ) -> ContextPackage:
        # Import resiliente: tenta absoluto via pacote orchestrator, depois flat.
        try:
            from orchestrator.connect_loader import ConnectLoader  # type: ignore
        except Exception:
            from connect_loader import ConnectLoader  # type: ignore

        connect_loader = ConnectLoader()
        contracts = connect_loader.load_for_role(role, stack_key)

        cache_rows = _query_context_cache(role, stack_key, project_id)

        bug_checklists: list[dict[str, Any]] = []
        prefix_chunks: list[str] = []
        cache_keys_hit: list[str] = []
        total_tokens = 0

        for row in cache_rows:
            cache_keys_hit.append(row["cache_key"])
            total_tokens += row.get("payload_tokens", 0)
            payload = row.get("payload") or {}
            if row["category"] == "checklist":
                items = payload.get("bugChecklists") or []
                if isinstance(items, list):
                    bug_checklists.extend(items)
            elif row["category"] == "package":
                pre = payload.get("systemPromptPrefix")
                if isinstance(pre, str) and pre.strip():
                    prefix_chunks.append(pre.strip())

        lessons_hot: list[dict[str, Any]] = []
        if RAG_ENABLED in {"shadow", "live"}:
            lessons_hot = _query_lessons_top_hits(role, stack_key, project_id)

        # Best-effort: bump dos hits no cache
        _bump_hits(cache_keys_hit)

        # Em modo shadow, observa-se mas não se injeta — devolver pacote enxuto
        if self.mode == "shadow":
            duration_ms = int((time.perf_counter() - t0) * 1000)
            logger.info(
                "[ContextLoader/shadow] role=%s stack=%s project=%s "
                "cache_rows=%d contracts=%d lessons=%d tokens=%d took=%dms",
                role, stack_key, project_id, len(cache_rows),
                len(contracts), len(lessons_hot), total_tokens, duration_ms,
            )
            return ContextPackage(
                role=role,
                stack_key=stack_key,
                project_id=project_id,
                connect_version=CONNECT_VERSION_PIN,
                mode="shadow",
                cache_hit=bool(cache_rows),
                duration_ms=duration_ms,
            )

        # mode == "live"
        pkg = ContextPackage(
            role=role,
            stack_key=stack_key,
            project_id=project_id,
            connect_version=CONNECT_VERSION_PIN,
            mode="live",
            system_prompt_prefix="\n\n".join(prefix_chunks),
            connect_contracts=contracts,
            bug_checklists=bug_checklists,
            lessons_hot=lessons_hot,
            payload_tokens=total_tokens,
            cache_hit=bool(cache_rows),
            duration_ms=int((time.perf_counter() - t0) * 1000),
        )

        logger.debug(
            "[ContextLoader/live] role=%s stack=%s contracts=%d checklists=%d "
            "lessons=%d tokens=%d took=%dms",
            role, stack_key, len(pkg.connect_contracts),
            len(pkg.bug_checklists), len(pkg.lessons_hot),
            pkg.payload_tokens, pkg.duration_ms,
        )
        return pkg


# Singleton conveniente
_default_loader: Optional[ContextLoader] = None


def get_context_loader() -> ContextLoader:
    global _default_loader
    if _default_loader is None:
        _default_loader = ContextLoader()
    return _default_loader


def load_context_prefix(
    role: str,
    stack_key: str = "generic",
    project_id: Optional[str] = None,
) -> str:
    """Helper: retorna apenas a string a ser prefixada (vazia em mode=off)."""
    try:
        pkg = get_context_loader().load(role, stack_key, project_id)
        return pkg.to_prompt_prefix()
    except Exception as exc:
        logger.debug("[load_context_prefix] fallback vazio: %s", exc)
        return ""
