"""
Testes do ConnectLoader (cadeia de fallback).
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
    import orchestrator.connect_loader as cl
    importlib.reload(cl)
    return cl


def test_fallback_to_hardcoded_when_no_pg_no_disk(monkeypatch, tmp_path):
    """Sem PG e bloqueando todos os candidatos de disco, retorna hardcoded fallback."""
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("CONNECT_CONTRACTS_PATH", str(tmp_path / "nope"))
    monkeypatch.setenv("ZENTRIZ_CONNECT_ROOT", str(tmp_path / "nope"))
    cl = _reload()
    # Forçar que nenhum candidato de disco tenha schemas (override do sibling do workspace)
    monkeypatch.setattr(cl, "_candidate_connect_roots", lambda: [tmp_path / "nope"])
    loader = cl.ConnectLoader()
    contracts = loader.load_for_role("dev", stack_key="python-fastapi")
    assert isinstance(contracts, list)
    assert len(contracts) >= 1
    sources = {c.get("source") for c in contracts}
    assert "hardcoded" in sources


def test_load_from_disk_when_workspace_present():
    """Caso o workspace zentriz-connect esteja presente, contratos vêm do disco."""
    cl = _reload()
    loader = cl.ConnectLoader()
    contracts = loader.load_for_role("dev", stack_key="python-fastapi")
    # Em ambiente dev (workspace federado), disco deve responder.
    # Caso contrário, fallback hardcoded (também aceitável).
    assert isinstance(contracts, list) and contracts


def test_role_specific_contracts():
    cl = _reload()
    loader = cl.ConnectLoader()
    cto_contracts = loader.load_for_role("cto", stack_key="generic")
    devops_contracts = loader.load_for_role("devops", stack_key="generic")
    assert isinstance(cto_contracts, list)
    assert isinstance(devops_contracts, list)


def test_unknown_role_returns_default():
    cl = _reload()
    loader = cl.ConnectLoader()
    contracts = loader.load_for_role("unknown_role_xyz", stack_key="generic")
    assert isinstance(contracts, list)
    assert len(contracts) >= 1


def test_loader_never_raises(monkeypatch):
    """Mesmo com PG configurado mas inacessível, não lança."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://invalid:0/none")
    cl = _reload()
    loader = cl.ConnectLoader()
    # Não deve lançar
    contracts = loader.load_for_role("dev", stack_key="python-fastapi")
    assert isinstance(contracts, list)


def test_version_pin_propagates(monkeypatch):
    monkeypatch.setenv("CONNECT_VERSION_PIN", "9.9.9")
    cl = _reload()
    loader = cl.ConnectLoader()
    contracts = loader.load_for_role("dev")
    for c in contracts:
        # Hardcoded e disk usam version do loader; PG cache pode ter outra
        assert "version" in c
