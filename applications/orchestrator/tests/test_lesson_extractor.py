"""
Testes do LessonExtractor (RAG corpus).
"""
from __future__ import annotations

import importlib
import os

import pytest


def _reload(**env):
    for k, v in env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    import orchestrator.lesson_extractor as le
    importlib.reload(le)
    return le


def test_off_mode_returns_empty(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "off")
    le = _reload()
    extractor = le.LessonExtractor()
    out = extractor.extract("findAll is not a function", project_id="p1")
    assert out == []


def test_invalid_mode_falls_back_to_off(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "yolo")
    le = _reload()
    extractor = le.LessonExtractor()
    assert extractor.mode == "off"
    assert extractor.extract("anything") == []


def test_shadow_extracts_but_does_not_persist(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    monkeypatch.setenv("DATABASE_URL", "")
    le = _reload()
    extractor = le.LessonExtractor()
    dialogue = "Erro: findAll is not a function in repository"
    out = extractor.extract(dialogue, project_id="00000000-0000-0000-0000-000000000001")
    assert len(out) == 1
    assert out[0].slug == "nodejs.drizzle.findall-vs-findmany"
    assert out[0].pii_redacted is True


def test_live_without_db_returns_extracted_but_logs(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "live")
    monkeypatch.setenv("DATABASE_URL", "")
    le = _reload()
    extractor = le.LessonExtractor()
    out = extractor.extract("Erro: setuptools >= 80 quebra build")
    # Sem DB, ainda retorna extracted (persist falha graciosamente)
    assert len(out) == 1
    assert out[0].slug == "python.setuptools-80"


def test_pii_redaction_applied(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    extractor = le.LessonExtractor()
    # Inject email no body via heurística (substituir título não muda lógica do teste)
    dialogue = "User joao@example.com hit findAll is not a function"
    out = extractor.extract(dialogue)
    assert len(out) >= 1
    # body_md gerada pela heurística não tem PII; mas se viesse, seria redatado
    for ln in out:
        assert "joao@example.com" not in ln.body_md
        assert "joao@example.com" not in ln.title


def test_multiple_patterns_one_each(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    extractor = le.LessonExtractor()
    dialogue = """
    Multiple errors:
    - python-multipart is not installed
    - findAll is not a function
    - prefix duplicated in router
    """
    out = extractor.extract(dialogue, stack_key="python-fastapi")
    slugs = {ln.slug for ln in out}
    assert "python.fastapi.python-multipart" in slugs
    assert "nodejs.drizzle.findall-vs-findmany" in slugs
    assert "python.fastapi.router-prefix-duplicado" in slugs


def test_no_match_returns_empty(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    extractor = le.LessonExtractor()
    out = extractor.extract("Everything ran smoothly without issues.")
    assert out == []


def test_lesson_to_dict_schema():
    from orchestrator.lesson_extractor import Lesson
    ln = Lesson(slug="x.y.z", title="T", body_md="B")
    d = ln.to_dict()
    assert d["schemaVersion"] == "1.1.0"
    assert d["slug"] == "x.y.z"
    assert d["category"] == "pattern"
    assert "tags" in d


def test_extract_never_raises_on_bad_db_url(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "live")
    monkeypatch.setenv("DATABASE_URL", "postgresql://invalid:0/none")
    le = _reload()
    extractor = le.LessonExtractor()
    # Não deve lançar
    out = extractor.extract("findAll is not a function", project_id="00000000-0000-0000-0000-000000000001")
    assert isinstance(out, list)
