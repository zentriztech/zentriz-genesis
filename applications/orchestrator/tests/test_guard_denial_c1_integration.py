"""C1' — integração com o servidor `agents` REAL devolvendo 402 pelo caminho HTTP (aceite do plano 27).

Cadeia exercitada de ponta a ponta, sem dublê de exceção:

  runner (`call_dev`/`call_qa`/`call_cto` reais)
    → `agents/client_http.run_agent_http` (urllib real)
      → `agents/server.py` (FastAPI/uvicorn REAL, em thread, porta efêmera)
        → `agents/runtime.run_agent` (real) → `llm_guard.check` (real)
          → API do Genesis SIMULADA (stub HTTP) devolvendo `allow:false` no preflight
        ← `LlmGuardDenied` → handler do server → HTTP 402
      ← `RuntimeError(json{http_code:402,...})` (NÃO é `LlmGuardDenied`)
    → classificador `is_guard_denial` + tratamento do laço.

Só o Guard (preflight) é simulado; nenhum provedor de LLM é chamado (o preflight nega antes).
"""
from __future__ import annotations

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import orchestrator.runner as runner
from orchestrator.agents import llm_guard
from orchestrator.tests.test_guard_denial_c1 import (
    PID, Harness, _run_or_fail, _tasks,
)

# Funções REAIS do runner, capturadas antes de o Harness instalar dublês de borda.
_REAL_CALL_DEV = runner.call_dev
_REAL_CALL_QA = runner.call_qa

uvicorn = pytest.importorskip("uvicorn")
pytest.importorskip("fastapi")


class _GuardApi:
    """API do Genesis simulada: só o que o Guard Python usa (`/api/internal/llm-guard/*`)."""

    def __init__(self):
        self.allow = False
        self.code = "KILL_SWITCH"
        self.preflights: list[dict] = []
        self.provider_calls = 0


@pytest.fixture
def real_agents_server(monkeypatch):
    state = _GuardApi()

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if self.path.endswith("/llm-guard/preflight"):
                state.preflights.append(body)
                out = {"allow": state.allow, "code": state.code,
                       "message": "Chave geral de LLM ligada: todo LLM do Genesis está bloqueado por um administrador."}
            else:
                out = {"ok": True}
            data = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):
            pass

    guard = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=guard.serve_forever, daemon=True).start()

    # O Guard é REAL (não o desligado dos testes unitários): fail-closed, falando com o stub acima.
    monkeypatch.delenv("LLM_GUARD_DISABLED_FOR_TESTS", raising=False)
    monkeypatch.setenv("API_BASE_URL", f"http://127.0.0.1:{guard.server_port}")
    monkeypatch.setenv("GENESIS_API_TOKEN", "tok-teste")
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "bedrock")
    monkeypatch.setenv("CLAUDE_MODEL", "modelo-de-teste")  # só para o envelope; nenhum provedor é chamado
    monkeypatch.delenv("LLM_ROLES_MODE", raising=False)
    monkeypatch.delenv("WASTE_TELEMETRY", raising=False)

    from orchestrator.agents.server import app

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    deadline = time.time() + 15
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    assert server.started, "uvicorn não subiu"
    monkeypatch.setenv("API_AGENTS_URL", f"http://127.0.0.1:{port}")
    state.port = port
    state.guard_url = f"http://127.0.0.1:{guard.server_port}"
    yield state
    server.should_exit = True
    th.join(timeout=10)
    guard.shutdown()


def _dev_call():
    return runner.call_dev("spec.md", "charter", "backlog", "rid-1", task_id="TSK-001", task="t",
                           code_refs=[], existing_artifacts=[], task_dict={"taskId": "TSK-001"},
                           dev_variant="backend", rework_attempt=0)


def test_servidor_real_devolve_402_e_o_runner_recebe_RuntimeError_nao_LlmGuardDenied(real_agents_server):
    from orchestrator.guard_denial import guard_denial_code, is_guard_denial
    with pytest.raises(Exception) as ei:
        _dev_call()
    exc = ei.value
    # o defeito de formato que o `except LlmGuardDenied` do plano original não pegaria:
    assert isinstance(exc, RuntimeError) and not isinstance(exc, llm_guard.LlmGuardDenied)
    payload = json.loads(str(exc))
    assert payload["http_code"] == 402
    assert is_guard_denial(exc) and guard_denial_code(exc) == "KILL_SWITCH"
    assert real_agents_server.preflights, "o preflight real do Guard não foi consultado"


def test_servidor_real_429_nao_e_negativa(real_agents_server):
    """Controle: erro de taxa (aqui, 500 do servidor por falha do provedor) NÃO é negativa do Guard."""
    from orchestrator.guard_denial import is_guard_denial
    real_agents_server.allow = True  # o Guard libera; a chamada segue e falha adiante (sem provedor real)
    with pytest.raises(Exception) as ei:
        _dev_call()
    assert not is_guard_denial(ei.value)


def test_laco_real_com_servidor_real_402_dev_nao_vira_blocked_e_para(monkeypatch, tmp_path, real_agents_server):
    h = Harness(monkeypatch, tmp_path, _tasks(3))
    monkeypatch.setenv("API_BASE_URL", real_agents_server.guard_url)  # o Harness limpa a env; o Guard real precisa dela
    monkeypatch.setattr(runner, "call_dev", _REAL_CALL_DEV)  # o Harness pôs um dublê; aqui vale o real
    h.ctx = None  # call_dev/call_qa reais usam métodos do PipelineContext real; sem ctx o checkpoint não é exercitado aqui
    _run_or_fail(h)
    assert "BLOCKED" not in h.statuses()
    assert all(h.final(t) == "ASSIGNED" for t in ("TSK-001", "TSK-002", "TSK-003"))
    assert h.project_statuses == ["stopped"]
    assert h.patches[-1]["blocked_reason"] == "guard_denied: KILL_SWITCH"
    assert len(real_agents_server.preflights) == 3  # 3 verificações reais (GUARD_DENIAL_MAX_CHECKS=3), nenhuma além
    assert len(h.sleeps) == 2


def test_laco_real_com_servidor_real_402_qa_termina_sem_spin(monkeypatch, tmp_path, real_agents_server):
    h = Harness(monkeypatch, tmp_path, _tasks(1, status="WAITING_REVIEW"))
    monkeypatch.setenv("API_BASE_URL", real_agents_server.guard_url)
    monkeypatch.setattr(runner, "call_qa", _REAL_CALL_QA)
    h.ctx = None
    _run_or_fail(h)
    assert h.final("TSK-001") == "WAITING_REVIEW"
    assert h.project_statuses == ["stopped"]
    assert len(real_agents_server.preflights) == 3 and len(h.sleeps) == 2


def test_pre_laco_real_com_servidor_real_402_nao_marca_failed(monkeypatch, tmp_path, real_agents_server):
    spec = tmp_path / "spec.md"
    spec.write_text("# Produto\n\nFR-001 fazer algo\n", encoding="utf-8")
    patches: list[dict] = []
    monkeypatch.setenv("PROJECT_ID", PID)
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path / "pf"))
    monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)
    monkeypatch.setattr(runner, "_patch_project", lambda b: patches.append(dict(b)) or True)
    monkeypatch.setattr(runner, "_get_project_status", lambda _p: "running")
    import sys
    monkeypatch.setattr(sys, "argv", ["runner", "--spec-file", str(spec)])
    rc = runner.main()  # call_cto REAL → HTTP → servidor real → 402
    statuses = [p.get("status") for p in patches]
    assert rc == 0 and "failed" not in statuses and statuses[-1] == "stopped", patches
    assert real_agents_server.preflights
