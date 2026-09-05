"""
Circuit breaker do runtime dos agentes — correção 2026-09-05.

DOIS DEFEITOS MEDIDOS EM PROD:
  1. O breaker era GLOBAL para a Bancada: a api mandava `project_id="spec_chat"` fixo, então
     3 falhas de um tenant qualquer bloqueavam o chat de spec de TODOS (retornando BLOCKED sem
     nem chamar o provedor). Agora a api manda `circuit_scope` (`spec_chat:<projectId>`) e ele
     VENCE o `project_id` só para efeito de breaker.
  2. O breaker NUNCA fechava sozinho: aberto, nenhuma chamada era feita, e o contador só zerava
     em SUCESSO — ou seja, só reiniciando o container. Agora há meia-abertura por TEMPO.
"""
import pytest


@pytest.fixture(autouse=True)
def _clean_state():
    from orchestrator.agents import runtime
    runtime._circuit_failures.clear()
    yield
    runtime._circuit_failures.clear()


# ── escopo ────────────────────────────────────────────────────────────────────

def test_circuit_scope_prefere_circuit_scope_ao_project_id():
    from orchestrator.agents.runtime import _circuit_scope_id
    inp = {"circuit_scope": "spec_chat:proj-A", "project_id": "spec_chat"}
    assert _circuit_scope_id({"project_id": "spec_chat"}, inp) == "spec_chat:proj-A"


def test_circuit_scope_cai_para_project_id_e_default():
    from orchestrator.agents.runtime import _circuit_scope_id
    assert _circuit_scope_id({}, {"project_id": "proj-1"}) == "proj-1"
    assert _circuit_scope_id({}, {}) == "default"
    # string vazia/espaços não vale como escopo (senão dois projetos colidiriam em "")
    assert _circuit_scope_id({}, {"circuit_scope": "   ", "project_id": "proj-2"}) == "proj-2"


def test_dois_projetos_da_bancada_nao_compartilham_breaker():
    """O bug: 3 falhas do projeto A abriam o breaker do projeto B (mesmo `project_id` fixo)."""
    from orchestrator.agents.runtime import (
        _circuit_scope_id, _circuit_note_failure, _circuit_blocked, CIRCUIT_BREAKER_THRESHOLD,
    )
    key_a = (_circuit_scope_id({}, {"circuit_scope": "spec_chat:A", "project_id": "spec_chat"}), "cto", "chat", "")
    key_b = (_circuit_scope_id({}, {"circuit_scope": "spec_chat:B", "project_id": "spec_chat"}), "cto", "chat", "")
    for _ in range(CIRCUIT_BREAKER_THRESHOLD):
        _circuit_note_failure(key_a)
    assert _circuit_blocked(key_a) is True
    assert _circuit_blocked(key_b) is False


# ── abertura, meia-abertura e fechamento ──────────────────────────────────────

def test_abre_somente_no_threshold():
    from orchestrator.agents.runtime import _circuit_note_failure, _circuit_blocked, CIRCUIT_BREAKER_THRESHOLD
    key = ("proj-1", "dev", "code", "t-1")
    for i in range(1, CIRCUIT_BREAKER_THRESHOLD):
        _circuit_note_failure(key)
        assert _circuit_blocked(key) is False, f"não pode abrir na falha {i}"
    _circuit_note_failure(key)
    assert _circuit_blocked(key) is True


def test_sucesso_zera_o_contador():
    from orchestrator.agents.runtime import _circuit_note_failure, _circuit_reset, _circuit_blocked, CIRCUIT_BREAKER_THRESHOLD
    key = ("proj-1", "dev", "code", "t-1")
    for _ in range(CIRCUIT_BREAKER_THRESHOLD):
        _circuit_note_failure(key)
    _circuit_reset(key)
    assert _circuit_blocked(key) is False


def test_meia_abertura_por_tempo_libera_nova_tentativa(monkeypatch):
    """Sem isto, o breaker aberto só fechava reiniciando o container."""
    from orchestrator.agents import runtime
    key = ("proj-1", "cto", "chat", "")
    fake_now = [1000.0]
    monkeypatch.setattr(runtime.time, "monotonic", lambda: fake_now[0])
    for _ in range(runtime.CIRCUIT_BREAKER_THRESHOLD):
        runtime._circuit_note_failure(key)
    assert runtime._circuit_blocked(key) is True
    # 1 s antes da janela: continua bloqueado
    fake_now[0] += runtime.CIRCUIT_BREAKER_RESET_SEC - 1
    assert runtime._circuit_blocked(key) is True
    # passada a janela: libera UMA tentativa (e zera o contador)
    fake_now[0] += 2
    assert runtime._circuit_blocked(key) is False
    assert runtime._circuit_failures[key] == (0, 0.0)


def test_falha_apos_meia_abertura_reabre_na_proxima_sequencia(monkeypatch):
    from orchestrator.agents import runtime
    key = ("proj-1", "cto", "chat", "")
    fake_now = [1000.0]
    monkeypatch.setattr(runtime.time, "monotonic", lambda: fake_now[0])
    for _ in range(runtime.CIRCUIT_BREAKER_THRESHOLD):
        runtime._circuit_note_failure(key)
    fake_now[0] += runtime.CIRCUIT_BREAKER_RESET_SEC + 1
    assert runtime._circuit_blocked(key) is False  # meia-abertura consumiu o contador
    for _ in range(runtime.CIRCUIT_BREAKER_THRESHOLD):
        runtime._circuit_note_failure(key)
    assert runtime._circuit_blocked(key) is True
    assert runtime._circuit_failures[key][0] == runtime.CIRCUIT_BREAKER_THRESHOLD


def test_reset_desligado_mantem_comportamento_antigo(monkeypatch):
    """`CIRCUIT_BREAKER_RESET_SEC=0` = sem meia-abertura (escape hatch do comportamento antigo)."""
    from orchestrator.agents import runtime
    monkeypatch.setattr(runtime, "CIRCUIT_BREAKER_RESET_SEC", 0)
    key = ("proj-1", "cto", "chat", "")
    for _ in range(runtime.CIRCUIT_BREAKER_THRESHOLD):
        runtime._circuit_note_failure(key)
    assert runtime._circuit_blocked(key) is True
