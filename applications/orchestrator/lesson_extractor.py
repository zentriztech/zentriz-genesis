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

⚖️ LEI (2026-09-05, G7/A3.4): **a extração é 100% LLM — não existe fallback burro.**
Até hoje este módulo caía numa lista de regex (`_HEURISTIC_PATTERNS`) quando o LLM falhava ou
quando ele julgava, pelo env, que não havia provedor. O efeito real medido em produção era pior
que "nenhuma lição": o corpus receberia SOMENTE lições de regex — em prod
`GENESIS_LLM_PROVIDER=bedrock` sem `AWS_ACCESS_KEY_ID` (a EC2 usa instance role), e o gate
"auto" devolvia [] antes de tentar o modelo. Como o corpus vira PROMPT de outros projetos
(`context_loader` → CAG), lição inventada por regex é contaminação com aparência de aprendizado.
Agora: sem LLM **não há extração** (loga o erro e devolve lista vazia).
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

# G7/A3.3 (2026-09-05) — a BANCADA passa a aprender. O episódio dela não é uma entrega de código:
# é um laço de refinamento de ESPECIFICAÇÃO (GAPs apontados por um validador adversarial, revisões
# do CTO, o que convergiu e o que empacou). Prompt próprio porque as lições úteis aqui são de
# ENGENHARIA DE ESPECIFICAÇÃO — e porque o material de entrada é spec de CLIENTE: o corpus é global
# (vira prompt de outros projetos/tenants), então a proibição de conteúdo literal é explícita.
_LLM_SYSTEM_SPEC = (
    "Você é um extrator de lições de ENGENHARIA DE ESPECIFICAÇÃO. Recebe o relatório de um laço de "
    "refinamento de spec de produto numa fábrica autônoma: os GAPs que um validador adversarial "
    "apontou (bloqueadores e avisos), o que o CTO revisou em cada rodada, e o resultado (convergiu, "
    "empacou ou esgotou as rodadas). Extraia de 0 a 4 LIÇÕES REUTILIZÁVEIS sobre COMO ESCREVER E "
    "REVISAR SPECS que ajudem os próximos produtos a nascerem sem os mesmos GAPs (ex.: 'toda spec de "
    "API precisa declarar idempotência das rotas de escrita'). "
    "PROIBIDO ABSOLUTO — o corpus é compartilhado entre clientes: nada de nome de cliente, produto, "
    "projeto, pessoa, marca, domínio, ID, caminho de arquivo, nem trecho LITERAL copiado da spec. "
    "Se a lição só faz sentido citando o produto, ela NÃO é generalizável: descarte. "
    "Se não houver lição de valor durável, retorne lista vazia. "
    "Responda APENAS com um array JSON (sem prosa, sem cercas markdown). Cada item: "
    '{"slug":"spec.tema.regra","title":"curto","body_md":"**Regra:** ... (acionável)",'
    '"category":"pattern|antipattern|contract|security|performance|ux",'
    '"scope":"project|product|ecosystem","confidence":0.0-1.0,"tags":["..."]}'
)

# Prompt por tipo de episódio. `delivery` = entrega auditada pelo Cyborg (comportamento histórico).
_SYSTEM_BY_KIND = {"delivery": _LLM_SYSTEM, "spec": _LLM_SYSTEM_SPEC}


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


def _llm_extract(
    dialogue_text: str,
    stack_key: str,
    kind: str = "delivery",
    usage_project_id: Optional[str] = None,
    llm_cfg: Optional[dict] = None,
) -> list[Lesson]:
    """
    Extrai lições via LLM (Bedrock/Foundry). Sem LLM → [] (e o motivo no log).

    O gate antigo ("auto" só liga com `GENESIS_LLM_PROVIDER=foundry` ou `AWS_ACCESS_KEY_ID`
    presente) ADIVINHAVA a disponibilidade do provedor e errava exatamente em produção, onde a EC2
    fala com o Bedrock pela **instance role** — sem chave no env. Quem sabe chamar é o
    `call_bedrock_direct` (cascata de modelos, credenciais do tenant, fallback de região): se não
    houver como chamar, ele levanta e o erro aparece. `LESSON_EXTRACT_LLM=off` continua sendo o
    desligamento EXPLÍCITO.
    """
    if _LLM_EXTRACT_ENABLED in {"0", "off", "false", "no"}:
        logger.info("[LessonExtractor/llm] LESSON_EXTRACT_LLM=off — extração desligada explicitamente")
        return []
    try:
        from orchestrator.agents.runtime import call_bedrock_direct
    except Exception as exc:
        logger.warning("[LessonExtractor/llm] runtime indisponível (sem LLM → sem lição): %s", exc)
        return []
    model = (os.environ.get("CLAUDE_MODEL_SPEC")
             or os.environ.get("CLAUDE_MODEL")
             or "claude-sonnet-5")
    system = _SYSTEM_BY_KIND.get((kind or "delivery").strip().lower(), _LLM_SYSTEM)
    header = "## Laço de refinamento da spec" if kind == "spec" else "## Diálogo do projeto + auditoria"
    user = f"Stack: {stack_key}\n\n{header}\n{dialogue_text[:38000]}"
    try:
        # `usage_project_id` não é enfeite: sem ele a chamada é INVISÍVEL ao medidor de custo e ao
        # cost cap (é a família do G5, medida em prod). O aprendizado tem preço e ele aparece.
        raw = call_bedrock_direct(
            system, user, model, max_tokens=4000,
            usage_project_id=usage_project_id, usage_agent="lesson_extract", llm_cfg=llm_cfg,
        )
    except Exception as exc:
        # NÃO existe plano B: aprendizado inventado por regex é pior que aprendizado nenhum.
        logger.error("[LessonExtractor/llm] chamada ao modelo FALHOU — nenhuma lição extraída: %s", exc)
        return []
    lessons = _coerce_llm_lessons(raw)
    logger.info("[LessonExtractor/llm] kind=%s model=%s extracted=%d", kind, model, len(lessons))
    return lessons


def _veto_leaks(lessons: list[Lesson], forbidden_terms: list[str]) -> list[Lesson]:
    """
    VETO de contaminação (não é julgamento de conteúdo): descarta a lição que carrega um termo
    identificável do projeto/cliente de origem. O corpus é GLOBAL — vira prompt de outros tenants —
    e o prompt já proíbe citar nome de produto/cliente; isto é a rede que pega a desobediência.
    Só compara termos que o chamador conhece de fato (título do projeto, nome do tenant, IDs).
    """
    terms = [t.strip().lower() for t in forbidden_terms if t and len(t.strip()) >= 4]
    if not terms:
        return lessons
    kept: list[Lesson] = []
    for ln in lessons:
        hay = f"{ln.slug}\n{ln.title}\n{ln.body_md}".lower()
        hit = next((t for t in terms if t in hay), None)
        if hit:
            logger.warning(
                "[LessonExtractor/veto] lição '%s' descartada: cita termo do projeto de origem (%d chars)",
                ln.slug, len(hit),
            )
            continue
        kept.append(ln)
    return kept


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
        # Quantas lições da ÚLTIMA chamada foram de fato gravadas em `lessons_corpus`. O retorno de
        # extract() são as candidatas; sem este contador o chamador não distingue "o modelo não achou
        # lição" de "achou e o banco recusou" — que foi exatamente o G7 ("corpus = 0", sem sinal).
        self.last_persisted: int = 0

    def extract(
        self,
        dialogue_text: str,
        project_id: Optional[str] = None,
        stack_key: str = "generic",
        kind: str = "delivery",
        forbidden_terms: Optional[list[str]] = None,
        llm_cfg: Optional[dict] = None,
    ) -> list[Lesson]:
        """
        Retorna lições extraídas. Nunca lança — falhas viram [].

        `kind`: "delivery" (entrega auditada pelo Cyborg) ou "spec" (laço da Bancada — prompt e
        proibições próprias). `forbidden_terms`: termos do projeto de origem que NÃO podem aparecer
        na lição (veto de contaminação do corpus global). `llm_cfg`: credenciais do TENANT (mesmo
        shape do envelope) — a extração usa a mesma identidade que gerou o episódio.
        """
        self.last_persisted = 0
        if self.mode == "off":
            return []
        if not dialogue_text:
            return []

        try:
            return self._extract_safe(
                dialogue_text, project_id, stack_key, kind, forbidden_terms or [], llm_cfg,
            )
        except Exception as exc:
            logger.warning("[LessonExtractor] falha em extract(): %s", exc)
            return []

    def _extract_safe(
        self,
        dialogue_text: str,
        project_id: Optional[str],
        stack_key: str,
        kind: str = "delivery",
        forbidden_terms: Optional[list[str]] = None,
        llm_cfg: Optional[dict] = None,
    ) -> list[Lesson]:
        # 100% LLM (LEI): quem decide o que é lição é o modelo. Sem modelo, sem lição.
        candidates = _llm_extract(
            dialogue_text, stack_key, kind, usage_project_id=project_id, llm_cfg=llm_cfg,
        )
        candidates = _veto_leaks(candidates, forbidden_terms or [])

        # Aplica PII redaction e metadata final
        for ln in candidates:
            # Proveniência do episódio: dá para separar no corpus o que a Bancada aprendeu do que a
            # fábrica aprendeu (e medir o G7 sem adivinhar).
            _origin = "bancada" if (kind or "").strip().lower() == "spec" else "factory"
            if _origin not in ln.tags:
                ln.tags.append(_origin)
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
        self.last_persisted = n
        if project_id:
            _enqueue_outbox(project_id, event="project_accepted")
        logger.info(
            "[LessonExtractor/live] project=%s extracted=%d persisted=%d",
            project_id, len(candidates), n,
        )
        return candidates


def get_lesson_extractor() -> LessonExtractor:
    return LessonExtractor()
