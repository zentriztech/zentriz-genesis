"""
Testes do ContextLoader (CAG) — verifica modos off/shadow/live e fallback gracioso.
"""
from __future__ import annotations

import importlib
import os

import pytest


def _reload_loader_with_env(**env):
    """Recarrega context_loader com env vars específicos (CAG_ENABLED, etc)."""
    for k, v in env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    import orchestrator.context_loader as cl
    importlib.reload(cl)
    return cl


def test_off_mode_returns_empty_package(monkeypatch):
    monkeypatch.setenv("CAG_ENABLED", "off")
    monkeypatch.setenv("DATABASE_URL", "")
    cl = _reload_loader_with_env()
    loader = cl.ContextLoader()
    pkg = loader.load(role="dev", stack_key="python-fastapi")
    assert pkg.is_empty()
    assert pkg.mode == "off"
    assert pkg.role == "dev"
    assert pkg.to_prompt_prefix() == ""


def test_invalid_mode_falls_back_to_off(monkeypatch):
    monkeypatch.setenv("CAG_ENABLED", "yolo")
    monkeypatch.setenv("DATABASE_URL", "")
    cl = _reload_loader_with_env()
    loader = cl.ContextLoader()
    pkg = loader.load(role="dev", stack_key="generic")
    assert pkg.mode == "off"
    assert pkg.is_empty()


def test_load_safe_swallows_exceptions(monkeypatch):
    """ContextLoader.load nunca deve lançar — falhas viram pacote vazio."""
    monkeypatch.setenv("CAG_ENABLED", "live")
    monkeypatch.setenv("DATABASE_URL", "postgresql://invalid:0/none")
    cl = _reload_loader_with_env()
    loader = cl.ContextLoader()
    pkg = loader.load(role="dev", stack_key="python-fastapi")
    # Sem PG real, deve cair em hardcoded fallback no ConnectLoader
    assert pkg.mode == "live"
    # Pode ter contratos hardcoded; o importante é não lançar
    assert isinstance(pkg.connect_contracts, list)


def test_explicit_mode_override(monkeypatch):
    """Permite passar mode no construtor independente do env."""
    monkeypatch.setenv("CAG_ENABLED", "live")
    monkeypatch.setenv("DATABASE_URL", "")
    cl = _reload_loader_with_env()
    loader = cl.ContextLoader(mode="off")
    pkg = loader.load(role="cto")
    assert pkg.mode == "off"


def test_to_prompt_prefix_renders_sections():
    from orchestrator.context_loader import ContextPackage
    pkg = ContextPackage(
        role="dev",
        stack_key="python-fastapi",
        mode="live",
        connect_contracts=[
            {"contract": "ServiceManifest", "version": "1.1.0", "summary": "Catálogo."}
        ],
        bug_checklists=[
            {"slug": "x.y", "title": "Bug X", "rule": "Não faça Y."}
        ],
        lessons_hot=[
            {"slug": "l.1", "title": "Lição 1", "confidence": 0.9, "hitCount": 3, "bodyMd": "Corpo."}
        ],
    )
    out = pkg.to_prompt_prefix()
    assert "CONTEXTO INJETADO (CAG)" in out
    assert "ServiceManifest" in out
    assert "Bug X" in out
    assert "Lição 1" in out
    assert "Corpo." in out


def test_empty_package_renders_empty_prefix():
    from orchestrator.context_loader import ContextPackage
    pkg = ContextPackage(role="dev", mode="live")
    assert pkg.to_prompt_prefix() == ""


def test_load_context_prefix_helper_off(monkeypatch):
    monkeypatch.setenv("CAG_ENABLED", "off")
    cl = _reload_loader_with_env()
    out = cl.load_context_prefix(role="dev", stack_key="python-fastapi")
    assert out == ""


def test_singleton_loader(monkeypatch):
    monkeypatch.setenv("CAG_ENABLED", "off")
    cl = _reload_loader_with_env()
    a = cl.get_context_loader()
    b = cl.get_context_loader()
    assert a is b
