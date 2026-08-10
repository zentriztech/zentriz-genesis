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


_LLM_EXTRACT_ENABLED = os.environ.get("LESSON_EXTRACT_LLM", "auto").strip().lower()
_VALID_CATEGORIES = {
    "bug", "pattern", "antipattern", "stack", "contract",
    "performance", "security", "ux",
}
_VALID_SCOPES = {"task", "project", "product", "ecosystem"}

_LLM_SYSTEM = (
    "Você é um extrator de lições de engenharia de software. Recebe o diálogo dos "
    "agentes de uma fábrica autônoma (CTO, Engineer, PM, Dev, QA, Cyborg) sobre um "
    "projeto QUE FOI ACEITO (resultado verificado), mais a auditoria do Cyborg. "
    "Extraia de 0 a 6 LIÇÕES REUTILIZÁVEIS e ACIONÁVEIS que ajudem projetos futuros a "
    "evitar os mesmos erros ou repetir os mesmos acertos. Cada lição deve ser um padrão "
    "generalizável — NÃO um fato específico deste projeto (nada de nomes de projeto, IDs, "
    "nomes de pessoa). Se não houver lição de valor durável, retorne lista vazia. "
    "Responda APENAS com um array JSON (sem prosa, sem cercas markdown). Cada item: "
    '{"slug":"kebab.com.pontos","title":"curto","body_md":"**Regra:** ... (acionável)",'
    '"category":"bug|pattern|antipattern|stack|contract|performance|security|ux",'
    '"scope":"task|project|product|ecosystem","confidence":0.0-1.0,"tags":["..."]}'
)


def _coerce_llm_lessons(raw: str) -> list[Lesson]:
    """Parseia a resposta do LLM (array JSON, tolerante a cercas/prosa) em Lessons."""
    if not raw or not raw.strip():
        return []
    txt = raw.strip()
    # Remove cercas markdown se houver
    if "```" in txt:
        import re as _re
        m = _re.search(r"```(?:json)?\s*(.+?)```", txt, _re.DOTALL)
        if m:
            txt = m.group(1).strip()
    # Isola o primeiro '[' … último ']'
    lb, rb = txt.find("["), txt.rfind("]")
    if lb != -1 and rb != -1 and rb > lb:
        txt = txt[lb:rb + 1]
    try:
        data = json.loads(txt)
    except Exception as exc:
        logger.debug("[LessonExtractor/llm] JSON inválido: %s", exc)
        return []
    if not isinstance(data, list):
        return []
    out: list[Lesson] = []
    for item in data[:6]:
        if not isinstance(item, dict):
            continue
        slug = str(item.get("slug") or "").strip()[:120]
        title = str(item.get("title") or "").strip()[:200]
        body = str(item.get("body_md") or item.get("bodyMd") or "").strip()
        if not slug or not title or not body:
            continue
        cat = str(item.get("category") or "pattern").strip().lower()
        scope = str(item.get("scope") or "project").strip().lower()
        try:
            conf = float(item.get("confidence", 0.75))
        except (TypeError, ValueError):
            conf = 0.75
        tags = item.get("tags") or []
        if not isinstance(tags, list):
            tags = []
        tags = [str(t)[:40] for t in tags[:8]] + ["auto-extracted", "llm"]
        out.append(Lesson(
            slug=slug,
            title=title,
            body_md=body,
            category=cat if cat in _VALID_CATEGORIES else "pattern",
            scope=scope if scope in _VALID_SCOPES else "project",
            confidence=max(0.0, min(1.0, conf)),
            tags=tags,
        ))
    return out


def _llm_extract(dialogue_text: str, stack_key: str) -> list[Lesson]:
    """Extrai lições via LLM (Bedrock/Foundry). Best-effort: falha → []."""
    if _LLM_EXTRACT_ENABLED in {"0", "off", "false", "no"}:
        return []
    # 'auto' só liga se houver um provider LLM configurado; senão cai na heurística.
    if _LLM_EXTRACT_ENABLED == "auto":
        _provider = os.environ.get("GENESIS_LLM_PROVIDER", "").strip().lower()
        _has_bedrock = bool(os.environ.get("AWS_ACCESS_KEY_ID", "").strip())
        if _provider != "foundry" and not _has_bedrock:
            return []
    try:
        from orchestrator.agents.runtime import call_bedrock_direct
    except Exception as exc:
        logger.debug("[LessonExtractor/llm] runtime indisponível: %s", exc)
        return []
    model = (os.environ.get("CLAUDE_MODEL_SPEC")
             or os.environ.get("CLAUDE_MODEL")
             or "claude-sonnet-5")
    user = f"Stack: {stack_key}\n\n## Diálogo do projeto + auditoria\n{dialogue_text[:38000]}"
    try:
        raw = call_bedrock_direct(_LLM_SYSTEM, user, model, max_tokens=4000)
    except Exception as exc:
        logger.warning("[LessonExtractor/llm] chamada falhou (fallback heurística): %s", exc)
        return []
    lessons = _coerce_llm_lessons(raw)
    logger.info("[LessonExtractor/llm] model=%s extracted=%d", model, len(lessons))
    return lessons


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
        # Fallback: montar DSN a partir das PG* env vars (padrão dos containers
        # Docker do Genesis, que expõem PGHOST/PGUSER/... e NÃO DATABASE_URL).
        # Sem isto o F4 fica inerte no Docker mesmo em modo 'live' (achado #23).
        host = os.environ.get("PGHOST", "").strip()
        if host:
            port = os.environ.get("PGPORT", "5432")
            user = os.environ.get("PGUSER", "genesis")
            password = os.environ.get("PGPASSWORD", "")
            dbname = os.environ.get("PGDATABASE", "zentriz_genesis")
            db_url = f"postgresql://{user}:{password}@{host}:{port}/{dbname}"
        else:
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
                    # As lições são persistidas como GLOBAIS (project_id NULL) para que
                    # projetos FUTUROS as recuperem — é o propósito do F4 (aprendizado
                    # cross-project). Por construção o extrator só emite lições
                    # GENERALIZÁVEIS (o prompt proíbe fatos específicos do projeto), então
                    # o project_id é apenas PROVENIÊNCIA (vai na tag proj:<id8>), não deve
                    # particionar a recuperação — o context_loader filtra
                    # project_id = <atual> OR NULL, e lições presas ao id de origem nunca
                    # reapareceriam. O campo scope segue como metadado de abrangência. (achado #23)
                    _pid = None
                    _tags = list(ln.tags)
                    if ln.project_id:
                        _origin = f"proj:{ln.project_id[:8]}"
                        if _origin not in _tags:
                            _tags.append(_origin)
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
                            _pid,
                            ln.slug,
                            ln.category,
                            ln.scope,
                            ln.stack_key,
                            ln.role,
                            ln.title,
                            ln.body_md,
                            ln.confidence,
                            ln.pii_redacted,
                            _tags,
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
        # LLM primeiro (lições ricas e generalizáveis); heurística como fallback e
        # complemento (padrões conhecidos que o LLM pode não verbalizar). Dedup por slug.
        candidates = _llm_extract(dialogue_text, stack_key)
        _seen = {ln.slug for ln in candidates}
        for ln in _heuristic_extract(dialogue_text):
            if ln.slug not in _seen:
                candidates.append(ln)
                _seen.add(ln.slug)

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
