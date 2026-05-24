"""
LessonExtractor — extrai lições estruturadas do project_dialogue.

Responsabilidade: ler o diálogo agregado de um projeto ACCEPTED/DONE, propor
lições no formato lesson-record (Connect 1.1+), redigir PII, e persistir em
lessons_corpus com upsert idempotente por slug.

REGRA DE OURO: nunca lança em produção. Falhas viram log + retorno vazio.
Controlado por RAG_ENABLED env var (off/shadow/live):
  - off    → método extract() retorna [] sem fazer nada
  - shadow → extrai e LOGA mas não persiste no DB
  - live   → extrai, redige PII e persiste em lessons_corpus

Dependências: nenhuma além das já presentes no orchestrator (psycopg2 opcional).
LLM call: opcional — se não houver Anthropic client, o extrator usa heurísticas
simples (regex em error_log, bug_checklists batidos) para gerar lições candidatas.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3  # noqa: F401  (kept for symmetry with deadpool variant)
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)


RAG_ENABLED = os.environ.get("RAG_ENABLED", "off").strip().lower()
PII_REDACTION_STRICT = os.environ.get("PII_REDACTION_STRICT", "true").strip().lower() in (
    "1", "true", "yes", "on",
)

VALID_RAG_MODES = {"off", "shadow", "live"}
if RAG_ENABLED not in VALID_RAG_MODES:
    logger.warning("RAG_ENABLED='%s' inválido — assumindo 'off'", RAG_ENABLED)
    RAG_ENABLED = "off"


# ─────────────────────────────────────────────────────────────────────────────
# Tipos
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(slots=True)
class Lesson:
    slug: str
    title: str
    body_md: str
    category: str = "pattern"  # bug | pattern | antipattern | stack | contract | performance | security | ux
    scope: str = "project"      # task | project | product | ecosystem
    stack_key: str = "generic"
    role: Optional[str] = None
    confidence: float = 0.7
    project_id: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    pii_redacted: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": "1.1.0",
            "slug": self.slug,
            "title": self.title,
            "bodyMd": self.body_md,
            "category": self.category,
            "scope": self.scope,
            "stackKey": self.stack_key,
            "role": self.role,
            "confidence": self.confidence,
            "projectId": self.project_id,
            "tags": list(self.tags),
            "piiRedacted": self.pii_redacted,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Heurísticas para extração sem LLM
# ─────────────────────────────────────────────────────────────────────────────

# Padrões comuns que viram lições candidatas
_HEURISTIC_PATTERNS: list[tuple[re.Pattern[str], str, str, str]] = [
    (re.compile(r"setuptools.*(>=|>)\s*80", re.I),
     "python.setuptools-80",
     "setuptools 80+ quebra pip install -e",
     "Pinar setuptools<80 no requirements quando usar pip install -e ."),
    (re.compile(r"asyncpg.*ENUM|ENUM.*asyncpg", re.I),
     "python.fastapi.asyncpg.enum-native",
     "ENUM PostgreSQL com asyncpg",
     "Use create_type=False e crie o tipo via op.execute(\"CREATE TYPE...\")."),
    (re.compile(r"findAll is not a function", re.I),
     "nodejs.drizzle.findall-vs-findmany",
     "Drizzle não expõe findAll — usar findMany",
     "Padronize repositórios para db.query.<table>.findMany()."),
    (re.compile(r"prefix.*duplicat|duplicate.*prefix", re.I),
     "python.fastapi.router-prefix-duplicado",
     "Prefixo duplicado em include_router",
     "Defina prefix em apenas um dos pontos: APIRouter ou include_router."),
    (re.compile(r"python-multipart.*not installed|requires python-multipart", re.I),
     "python.fastapi.python-multipart",
     "python-multipart obrigatório para uploads",
     "Adicione python-multipart em requirements quando usar UploadFile/Form."),
    (re.compile(r"CORS.*not allowed|Access-Control-Allow-Origin", re.I),
     "nodejs.cors-pre-route",
     "CORS configurado depois das rotas",
     "Sempre app.use(cors(...)) antes de qualquer app.use(router)."),
]


def _heuristic_extract(dialogue_text: str) -> list[Lesson]:
    """Extrai lições via regex matching — fallback sem LLM."""
    found: list[Lesson] = []
    seen_slugs: set[str] = set()
    for pat, slug, title, rule in _HEURISTIC_PATTERNS:
        if pat.search(dialogue_text) and slug not in seen_slugs:
            found.append(
                Lesson(
                    slug=slug,
                    title=title,
                    body_md=f"**Regra:** {rule}",
                    category="bug",
                    scope="project",
                    confidence=0.6,  # heurística → confiança moderada
                    tags=["auto-extracted", "heuristic"],
                )
            )
            seen_slugs.add(slug)
    return found


# ─────────────────────────────────────────────────────────────────────────────
# PII redaction (best-effort, regex puro)
# ─────────────────────────────────────────────────────────────────────────────

_PII_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"AKIA[0-9A-Z]{16}"), "[AWS_KEY]"),
    (re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "[JWT]"),
    (re.compile(r"(?i)Bearer\s+[A-Za-z0-9._\-]{16,}"), "Bearer [TOKEN]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[EMAIL]"),
    (re.compile(r"(?<![0-9])\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}(?![0-9])"), "[CNPJ]"),
    (re.compile(r"(?<![0-9])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![0-9])"), "[CPF]"),
]


def _redact(text: str) -> str:
    out = text
    for pat, repl in _PII_RULES:
        try:
            out = pat.sub(repl, out)
        except re.error:
            if PII_REDACTION_STRICT:
                raise
    return out


# ─────────────────────────────────────────────────────────────────────────────
# DB helpers
# ─────────────────────────────────────────────────────────────────────────────

def _open_pg():
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        return None
    try:
        try:
            import psycopg2  # type: ignore
            return psycopg2.connect(db_url, connect_timeout=3)
        except ImportError:
            import psycopg  # type: ignore
            return psycopg.connect(db_url, connect_timeout=3)
    except Exception as exc:
        logger.debug("[LessonExtractor] sem PG: %s", exc)
        return None


def _persist_lessons(lessons: list[Lesson]) -> int:
    if not lessons:
        return 0
    conn = _open_pg()
    if conn is None:
        logger.warning("[LessonExtractor] DATABASE_URL ausente — não persistido")
        return 0

    inserted = 0
    try:
        with conn:
            with conn.cursor() as cur:
                # Confirmar que a tabela existe (migration 026)
                cur.execute("SELECT to_regclass('public.lessons_corpus') IS NOT NULL")
                if not cur.fetchone()[0]:
                    logger.warning(
                        "[LessonExtractor] tabela lessons_corpus não existe (migration 026?)"
                    )
                    return 0
                for ln in lessons:
                    cur.execute(
                        """
                        INSERT INTO lessons_corpus
                            (id, project_id, slug, category, scope, stack_key,
                             role, title, body_md, confidence, pii_redacted, tags, updated_at)
                        VALUES (%s, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                        ON CONFLICT (slug) DO UPDATE
                           SET title       = EXCLUDED.title,
                               body_md     = EXCLUDED.body_md,
                               category    = EXCLUDED.category,
                               scope       = EXCLUDED.scope,
                               stack_key   = EXCLUDED.stack_key,
                               role        = EXCLUDED.role,
                               confidence  = GREATEST(lessons_corpus.confidence, EXCLUDED.confidence),
                               tags        = EXCLUDED.tags,
                               updated_at  = NOW()
                        """,
                        (
                            str(uuid.uuid4()),
                            ln.project_id,
                            ln.slug,
                            ln.category,
                            ln.scope,
                            ln.stack_key,
                            ln.role,
                            ln.title,
                            ln.body_md,
                            ln.confidence,
                            ln.pii_redacted,
                            ln.tags,
                        ),
                    )
                    inserted += 1
    except Exception as exc:
        logger.warning("[LessonExtractor] falha ao persistir: %s", exc)
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return inserted


def _enqueue_outbox(project_id: str, event: str = "project_accepted") -> bool:
    conn = _open_pg()
    if conn is None:
        return False
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT to_regclass('public.lessons_index_outbox') IS NOT NULL"
                )
                if not cur.fetchone()[0]:
                    return False
                cur.execute(
                    """
                    INSERT INTO lessons_index_outbox (project_id, event, payload)
                    VALUES (%s::uuid, %s, %s::jsonb)
                    """,
                    (project_id, event, json.dumps({"queued_at": datetime.now(timezone.utc).isoformat()})),
                )
        return True
    except Exception as exc:
        logger.debug("[LessonExtractor] outbox indisponível: %s", exc)
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# LessonExtractor
# ─────────────────────────────────────────────────────────────────────────────

class LessonExtractor:
    """
    Extrai lições do diálogo de um projeto.

    Modo de operação:
      - off    → sempre retorna []
      - shadow → extrai e loga, NÃO persiste
      - live   → extrai, redige PII e persiste em lessons_corpus
    """

    def __init__(self, mode: Optional[str] = None) -> None:
        self.mode = (mode or RAG_ENABLED).strip().lower()
        if self.mode not in VALID_RAG_MODES:
            self.mode = "off"

    def extract(
        self,
        dialogue_text: str,
        project_id: Optional[str] = None,
        stack_key: str = "generic",
    ) -> list[Lesson]:
        """Retorna lições extraídas. Nunca lança — falhas viram []."""
        if self.mode == "off":
            return []
        if not dialogue_text:
            return []

        try:
            return self._extract_safe(dialogue_text, project_id, stack_key)
        except Exception as exc:
            logger.warning("[LessonExtractor] falha em extract(): %s", exc)
            return []

    def _extract_safe(
        self,
        dialogue_text: str,
        project_id: Optional[str],
        stack_key: str,
    ) -> list[Lesson]:
        # Heurística primeiro (rápido, sem dependências externas)
        candidates = _heuristic_extract(dialogue_text)

        # Aplica PII redaction e metadata final
        for ln in candidates:
            ln.body_md = _redact(ln.body_md)
            ln.title = _redact(ln.title)
            ln.project_id = project_id
            ln.stack_key = stack_key
            ln.pii_redacted = True

        if self.mode == "shadow":
            logger.info(
                "[LessonExtractor/shadow] project=%s extracted=%d (não persistido)",
                project_id, len(candidates),
            )
            return candidates

        # mode == "live": persistir
        n = _persist_lessons(candidates)
        if project_id:
            _enqueue_outbox(project_id, event="project_accepted")
        logger.info(
            "[LessonExtractor/live] project=%s extracted=%d persisted=%d",
            project_id, len(candidates), n,
        )
        return candidates


def get_lesson_extractor() -> LessonExtractor:
    return LessonExtractor()
