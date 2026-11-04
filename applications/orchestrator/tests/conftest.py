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


@pytest.fixture(autouse=True)
def _advisor_budget_limpo(monkeypatch):
    """2A.7: idempotência/teto do Advisor são estado de PROCESSO; cada teste começa sem reservas e sem env de teto."""
    from orchestrator.agents import llm_roles
    for k in (llm_roles.ENV_ADVISOR_CAP, llm_roles.ENV_PRICE_IN, llm_roles.ENV_PRICE_OUT, llm_roles.ENV_BUDGET_TTL, llm_roles.ENV_DEDUPE_TTL):
        monkeypatch.delenv(k, raising=False)
    llm_roles.BUDGET.reset()
    yield
    llm_roles.BUDGET.reset()


@pytest.fixture(autouse=True)
def _runner_effective_flags_limpas():
    """M-03: as flags efetivas por projeto (cache de 30 s no runner) são estado de PROCESSO; cada teste começa sem cache."""
    try:
        import orchestrator.runner as _runner
    except Exception:  # noqa: BLE001
        yield
        return
    _runner._EFFECTIVE_FLAGS_CACHE.clear()
    yield
    _runner._EFFECTIVE_FLAGS_CACHE.clear()
