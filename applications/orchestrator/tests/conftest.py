import sys
from pathlib import Path

# Ensure `applications/` is on sys.path so `from orchestrator.<module>` resolves.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest


@pytest.fixture(autouse=True)
def _llm_guard_off_by_default(monkeypatch):
    """O LLM GUARD é fail-closed (sem api ⇒ nega). Nos testes de unidade de outros módulos não há
    api: desliga por padrão. `test_llm_guard.py` religa e testa o guard contra um servidor falso."""
    monkeypatch.setenv("LLM_GUARD_DISABLED_FOR_TESTS", "1")
