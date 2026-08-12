"""
lessons_indexer — fecha o LOOP SEMÂNTICO do RAG do Genesis.

Até agora o LessonExtractor (modo live) persistia lições em lessons_corpus e
enfileirava um evento em lessons_index_outbox, mas NADA consumia essa outbox:
os embeddings nunca eram gerados (tabela lessons_embeddings órfã) e o
ContextLoader só recuperava por hit_count*confidence (lexical). Este módulo
fecha o ciclo:

    outbox (produtor: LessonExtractor)
        → run_indexer(): embedding das lições sem vetor → lessons_embeddings
        → semantic_search(): recuperação por similaridade de cosseno (pgvector)

Provedores de embedding (env RAG_EMBED_PROVIDER):
  bedrock (default) — Amazon Bedrock Titan Text Embeddings V2
                      (amazon.titan-embed-text-v2:0, 1024 dims, normalize=True),
                      via boto3 bedrock-runtime + credential chain (role da instância;
                      mesma resolução de região do call_bedrock_direct).
  hash              — embedding determinístico OFFLINE (sem rede), para testes/CI e
                      plumbing shadow-safe. Grava model_id distinto ("hash-1024") para
                      NUNCA se misturar com vetores Bedrock reais nas consultas.
  off               — desliga (embed_text → None). Retrieval cai no lexical.

REGRA DE OURO: nunca lança em produção. Falhas viram log + retorno vazio/None.
Dimensão fixada em 1024 (migration 045 alinhou lessons_embeddings ao Titan V2).
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

EMBED_DIM = 1024  # Titan V2 (também a dimensão fixada na migration 045).

RAG_EMBED_PROVIDER = os.environ.get("RAG_EMBED_PROVIDER", "bedrock").strip().lower()
_VALID_PROVIDERS = {"bedrock", "hash", "off"}
if RAG_EMBED_PROVIDER not in _VALID_PROVIDERS:
    logger.warning("RAG_EMBED_PROVIDER='%s' inválido — assumindo 'bedrock'", RAG_EMBED_PROVIDER)
    RAG_EMBED_PROVIDER = "bedrock"

BEDROCK_EMBED_MODEL = os.environ.get(
    "RAG_EMBED_MODEL", "amazon.titan-embed-text-v2:0"
).strip()

# Rótulo persistido em lessons_embeddings.model_id — segrega provedores.
_HASH_MODEL_ID = "hash-1024"

# Truncagem defensiva do texto enviado ao embedder (Titan aceita ~8k tokens).
_MAX_EMBED_CHARS = 8000


def active_model_id() -> str:
    """model_id gravado/consultado para o provedor ativo (index e search concordam)."""
    if RAG_EMBED_PROVIDER == "hash":
        return _HASH_MODEL_ID
    return BEDROCK_EMBED_MODEL


# ─────────────────────────────────────────────────────────────────────────────
# Embedding providers
# ─────────────────────────────────────────────────────────────────────────────

def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    if norm <= 0.0:
        return vec
    return [x / norm for x in vec]


def _embed_hash(text: str) -> list[float]:
    """
    Embedding determinístico offline (sem rede). NÃO tem qualidade semântica de um
    modelo treinado, mas é estável e L2-normalizado — suficiente para exercitar o
    pipeline (index + cosine) em CI/shadow sem depender de Bedrock. O texto idêntico
    sempre gera o mesmo vetor; textos diferentes geram vetores diferentes.
    """
    seed = (text or "").encode("utf-8", "ignore")
    vec: list[float] = []
    counter = 0
    while len(vec) < EMBED_DIM:
        digest = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
        for j in range(0, len(digest), 4):
            if len(vec) >= EMBED_DIM:
                break
            n = int.from_bytes(digest[j:j + 4], "big")
            vec.append((n / 4294967295.0) * 2.0 - 1.0)  # → [-1, 1]
        counter += 1
    return _l2_normalize(vec)


_bedrock_client = None  # cache do cliente boto3 (lazy)


def _get_bedrock_runtime():
    global _bedrock_client
    if _bedrock_client is not None:
        return _bedrock_client
    try:
        import boto3  # type: ignore
    except Exception as exc:  # pragma: no cover - ambiente sem boto3
        logger.warning("[lessons_indexer] boto3 indisponível: %s", exc)
        return None
    region = (
        os.environ.get("GENESIS_AWS_REGION")
        or os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    try:
        _bedrock_client = boto3.client("bedrock-runtime", region_name=region)
    except Exception as exc:
        logger.warning("[lessons_indexer] falha ao criar bedrock-runtime: %s", exc)
        return None
    return _bedrock_client


def _embed_bedrock(text: str) -> Optional[list[float]]:
    """Embedding via Bedrock Titan V2. Best-effort: qualquer falha → None."""
    client = _get_bedrock_runtime()
    if client is None:
        return None
    body = json.dumps({
        "inputText": (text or "")[:_MAX_EMBED_CHARS],
        "dimensions": EMBED_DIM,
        "normalize": True,
    })
    try:
        resp = client.invoke_model(
            modelId=BEDROCK_EMBED_MODEL,
            body=body,
            accept="application/json",
            contentType="application/json",
        )
        payload = json.loads(resp["body"].read())
        emb = payload.get("embedding")
        if not isinstance(emb, list) or len(emb) != EMBED_DIM:
            logger.warning(
                "[lessons_indexer] embedding Bedrock inesperado (len=%s)",
                len(emb) if isinstance(emb, list) else "n/a",
            )
            return None
        return [float(x) for x in emb]
    except Exception as exc:
        logger.warning("[lessons_indexer] embed Bedrock falhou: %s", exc)
        return None


def embed_text(text: str) -> Optional[list[float]]:
    """Gera o embedding do texto pelo provedor ativo. Nunca lança; falha → None."""
    if not text or not text.strip():
        return None
    if RAG_EMBED_PROVIDER == "off":
        return None
    if RAG_EMBED_PROVIDER == "hash":
        return _embed_hash(text)
    return _embed_bedrock(text)


def _vec_literal(vec: list[float]) -> str:
    """Serializa um vetor Python no literal aceito pelo pgvector: '[f,f,...]'."""
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


# ─────────────────────────────────────────────────────────────────────────────
# DB helpers (self-contained; mesma resolução DSN do resto do orchestrator)
# ─────────────────────────────────────────────────────────────────────────────

def _database_url() -> str:
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if db_url:
        return db_url
    host = os.environ.get("PGHOST", "").strip()
    if not host:
        return ""
    user = os.environ.get("PGUSER", "genesis")
    password = os.environ.get("PGPASSWORD", "")
    port = os.environ.get("PGPORT", "5432")
    dbname = os.environ.get("PGDATABASE", "zentriz_genesis")
    return f"postgresql://{user}:{password}@{host}:{port}/{dbname}"


def _open_pg():
    db_url = _database_url()
    if not db_url:
        return None
    try:
        try:
            import psycopg2  # type: ignore
            return psycopg2.connect(db_url, connect_timeout=5)
        except ImportError:
            import psycopg  # type: ignore
            return psycopg.connect(db_url, connect_timeout=5)
    except Exception as exc:
        logger.debug("[lessons_indexer] sem PG: %s", exc)
        return None


def _tables_ready(cur) -> bool:
    cur.execute(
        "SELECT to_regclass('public.lessons_corpus') IS NOT NULL"
        "   AND to_regclass('public.lessons_embeddings') IS NOT NULL"
        "   AND to_regclass('public.lessons_index_outbox') IS NOT NULL"
    )
    return bool(cur.fetchone()[0])


# ─────────────────────────────────────────────────────────────────────────────
# Indexer — consome outbox → grava embeddings
# ─────────────────────────────────────────────────────────────────────────────

def run_indexer(limit: int = 200, force: bool = False) -> dict[str, Any]:
    """
    Consome a outbox e gera embeddings para lições ainda sem vetor (do model_id ativo).

    Idempotente: as lições são GLOBAIS (project_id NULL) — a outbox é apenas o SINAL
    de que há trabalho. A cada chamada varremos as lições sem embedding para o model_id
    ativo (LEFT JOIN), geramos o vetor e fazemos upsert. Se não há evento pendente e
    force=False, não faz nada (economiza chamadas ao embedder).

    Retorna um dict com contadores. Nunca lança.
    """
    result: dict[str, Any] = {
        "ok": False, "provider": RAG_EMBED_PROVIDER, "model_id": active_model_id(),
        "pending_consumed": 0, "embedded": 0, "skipped": 0,
    }
    if RAG_EMBED_PROVIDER == "off":
        result["reason"] = "provider_off"
        return result

    conn = _open_pg()
    if conn is None:
        result["reason"] = "no_db"
        return result

    model_id = active_model_id()
    try:
        with conn:
            with conn.cursor() as cur:
                if not _tables_ready(cur):
                    result["reason"] = "tables_missing"
                    return result

                # 1) Reivindica eventos pendentes da outbox.
                cur.execute(
                    "SELECT id FROM lessons_index_outbox "
                    " WHERE processed_at IS NULL ORDER BY created_at LIMIT %s",
                    (limit,),
                )
                pending_ids = [r[0] for r in cur.fetchall()]
                if not pending_ids and not force:
                    result["ok"] = True
                    result["reason"] = "no_pending"
                    return result

                # 2) Lições sem embedding para o model_id ativo.
                cur.execute(
                    """
                    SELECT c.id, c.title, c.body_md
                      FROM lessons_corpus c
                 LEFT JOIN lessons_embeddings e
                        ON e.lesson_id = c.id AND e.model_id = %s
                     WHERE e.lesson_id IS NULL
                     LIMIT %s
                    """,
                    (model_id, limit),
                )
                todo = cur.fetchall()

                for lesson_id, title, body_md in todo:
                    text = f"{title or ''}\n{body_md or ''}".strip()
                    vec = embed_text(text)
                    if vec is None:
                        result["skipped"] += 1
                        continue
                    cur.execute(
                        """
                        INSERT INTO lessons_embeddings (lesson_id, model_id, embedding)
                        VALUES (%s, %s, %s::vector)
                        ON CONFLICT (lesson_id, model_id)
                          DO UPDATE SET embedding = EXCLUDED.embedding, created_at = NOW()
                        """,
                        (lesson_id, model_id, _vec_literal(vec)),
                    )
                    result["embedded"] += 1

                # 3) Marca a outbox consumida (só se não abortou por embedder morto).
                #    Se TODAS as lições foram skipadas por falha do embedder (ex.: Bedrock
                #    fora), NÃO consome a outbox — deixa para uma próxima tentativa.
                embedder_alive = not (todo and result["embedded"] == 0)
                if pending_ids and embedder_alive:
                    cur.execute(
                        "UPDATE lessons_index_outbox SET processed_at = NOW() "
                        " WHERE id = ANY(%s)",
                        (pending_ids,),
                    )
                    result["pending_consumed"] = len(pending_ids)

        result["ok"] = True
        logger.info(
            "[lessons_indexer] provider=%s model=%s pending=%d embedded=%d skipped=%d",
            RAG_EMBED_PROVIDER, model_id, result["pending_consumed"],
            result["embedded"], result["skipped"],
        )
        return result
    except Exception as exc:
        logger.warning("[lessons_indexer] run_indexer falhou: %s", exc)
        result["reason"] = f"error: {exc}"
        return result
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Retrieval semântico — cosine (pgvector)
# ─────────────────────────────────────────────────────────────────────────────

def semantic_search(
    query_text: str,
    role: Optional[str] = None,
    stack_key: str = "generic",
    project_id: Optional[str] = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """
    Recupera lições por similaridade de cosseno ao query_text. Complementa o
    _query_lessons_top_hits (lexical) do ContextLoader.

    Filtra por escopo de projeto (project_id atual OU global NULL) e pelo model_id
    do provedor ativo (não mistura vetores hash/Bedrock). Nunca lança; falha → [].
    O `role` é aceito por simetria com o lexical, mas não filtra (lições são
    tipicamente role-agnósticas); mantém a assinatura estável para o call site.
    """
    if RAG_EMBED_PROVIDER == "off":
        return []
    qvec = embed_text(query_text or "")
    if qvec is None:
        return []
    conn = _open_pg()
    if conn is None:
        return []
    model_id = active_model_id()
    qlit = _vec_literal(qvec)
    try:
        with conn:
            with conn.cursor() as cur:
                if not _tables_ready(cur):
                    return []
                cur.execute(
                    """
                    SELECT c.slug, c.title, c.category, c.scope, c.confidence,
                           c.hit_count, c.body_md,
                           1.0 - (e.embedding <=> %s::vector) AS score
                      FROM lessons_corpus c
                      JOIN lessons_embeddings e
                        ON e.lesson_id = c.id AND e.model_id = %s
                     WHERE (c.project_id = %s::uuid OR c.project_id IS NULL)
                  ORDER BY e.embedding <=> %s::vector
                     LIMIT %s
                    """,
                    (qlit, model_id, project_id, qlit, limit),
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
                "score": float(r[7]) if r[7] is not None else 0.0,
            }
            for r in rows
        ]
    except Exception as exc:
        logger.debug("[lessons_indexer] semantic_search indisponível: %s", exc)
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass
