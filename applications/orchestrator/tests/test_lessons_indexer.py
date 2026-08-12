"""
Testes do lessons_indexer (loop semântico do RAG).

Unitários (sem rede/DB): provedor hash determinístico, provider off, model_id,
serialização de vetor. Integração pgvector (index + cosine) roda só quando há um
DATABASE_URL alcançável e psycopg2 — caso contrário é skipada.
"""
from __future__ import annotations

import importlib
import math
import os

import pytest


def _reload(**env):
    for k, v in env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    import orchestrator.lessons_indexer as li
    importlib.reload(li)
    return li


# ─────────────────────────────────────────────────────────────────────────────
# Unitários — embedding hash (offline)
# ─────────────────────────────────────────────────────────────────────────────

def test_hash_embed_dim_and_normalized():
    li = _reload(RAG_EMBED_PROVIDER="hash")
    v = li.embed_text("qualquer texto")
    assert v is not None and len(v) == li.EMBED_DIM == 1024
    assert math.isclose(math.sqrt(sum(x * x for x in v)), 1.0, rel_tol=1e-9)


def test_hash_embed_deterministic_and_distinct():
    li = _reload(RAG_EMBED_PROVIDER="hash")
    assert li.embed_text("mesmo texto") == li.embed_text("mesmo texto")
    assert li.embed_text("texto A") != li.embed_text("texto B")


def test_hash_model_id_segregado():
    li = _reload(RAG_EMBED_PROVIDER="hash")
    assert li.active_model_id() == "hash-1024"


def test_bedrock_model_id_default():
    li = _reload(RAG_EMBED_PROVIDER="bedrock")
    assert li.active_model_id() == "amazon.titan-embed-text-v2:0"


def test_provider_off_returns_none():
    li = _reload(RAG_EMBED_PROVIDER="off")
    assert li.embed_text("x") is None


def test_empty_text_returns_none():
    li = _reload(RAG_EMBED_PROVIDER="hash")
    assert li.embed_text("") is None
    assert li.embed_text("   ") is None


def test_invalid_provider_falls_back_to_bedrock():
    li = _reload(RAG_EMBED_PROVIDER="banana")
    assert li.RAG_EMBED_PROVIDER == "bedrock"


def test_vec_literal_format():
    li = _reload(RAG_EMBED_PROVIDER="hash")
    assert li._vec_literal([0.5, -0.25, 0.0]) == "[0.5,-0.25,0.0]"


def test_run_indexer_off_provider_short_circuits():
    li = _reload(RAG_EMBED_PROVIDER="off")
    r = li.run_indexer(force=True)
    assert r["ok"] is False and r["reason"] == "provider_off"


def test_run_indexer_no_db_graceful(monkeypatch):
    li = _reload(RAG_EMBED_PROVIDER="hash")
    monkeypatch.setattr(li, "_open_pg", lambda: None)
    r = li.run_indexer(force=True)
    assert r["ok"] is False and r["reason"] == "no_db"


def test_semantic_search_off_returns_empty():
    li = _reload(RAG_EMBED_PROVIDER="off")
    assert li.semantic_search("qualquer", limit=3) == []


# ─────────────────────────────────────────────────────────────────────────────
# Integração pgvector — só com DB alcançável
# ─────────────────────────────────────────────────────────────────────────────

def _db_available() -> bool:
    if not (os.environ.get("DATABASE_URL") or os.environ.get("PGHOST")):
        return False
    try:
        import psycopg2  # noqa: F401
    except Exception:
        try:
            import psycopg  # noqa: F401
        except Exception:
            return False
    li = _reload(RAG_EMBED_PROVIDER="hash")
    conn = li._open_pg()
    if conn is None:
        return False
    try:
        conn.close()
    except Exception:
        pass
    return True


@pytest.mark.skipif(not _db_available(), reason="sem DATABASE_URL/pgvector alcançável")
def test_index_and_cosine_identity_roundtrip():
    """Indexa (hash) e confirma que a query = texto exato de uma lição a rankeia em 1º (score≈1)."""
    li = _reload(RAG_EMBED_PROVIDER="hash")
    li.run_indexer(force=True)
    conn = li._open_pg()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT title, body_md, slug FROM lessons_corpus ORDER BY slug LIMIT 1")
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        pytest.skip("corpus vazio")
    title, body, slug = row
    hits = li.semantic_search(f"{title}\n{body}".strip(), limit=3)
    assert hits, "busca semântica não retornou nada"
    assert hits[0]["slug"] == slug
    assert hits[0]["score"] > 0.999
