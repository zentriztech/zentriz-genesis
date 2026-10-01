"""LLM GUARD (post-mortem 30/09/2026, BRL 90 mil) — o lado Python.

Trava os 4 comportamentos que fecham o furo do incidente:
1. FAIL-CLOSED: api fora / token ausente ⇒ a chamada NÃO sai para o provedor.
2. Negado pela api ⇒ `LlmGuardDenied`, classificado como `guard` (a cascata de slots NÃO tenta o
   próximo slot — isso seria contornar o guard).
3. Permitido ⇒ a chamada acontece e o gasto (tokens) é REGISTRADO com o projeto do escopo.
4. Pseudo-projeto (`spec_chat`) não vira projeto; UUID do escopo vence.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from orchestrator.agents import llm_guard, runtime

PID = "11111111-2222-3333-4444-555555555555"


class _Fake:
    def __init__(self, allow=True, code="OK"):
        self.allow, self.code, self.calls = allow, code, []


@pytest.fixture
def fake_api(monkeypatch):
    state = _Fake()

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
            state.calls.append((self.path, body, self.headers.get("Authorization")))
            if self.path.endswith("/preflight"):
                out = {"allow": state.allow, "code": state.code, "message": "teste"}
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

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.delenv("LLM_GUARD_DISABLED_FOR_TESTS", raising=False)
    monkeypatch.delenv("PROJECT_ID", raising=False)
    monkeypatch.setenv("API_BASE_URL", f"http://127.0.0.1:{srv.server_port}")
    monkeypatch.setenv("GENESIS_API_TOKEN", "tok-teste")
    yield state
    srv.shutdown()


def test_sem_token_nega_sem_chamar_o_provedor(monkeypatch):
    monkeypatch.delenv("LLM_GUARD_DISABLED_FOR_TESTS", raising=False)
    monkeypatch.delenv("GENESIS_API_TOKEN", raising=False)
    with pytest.raises(llm_guard.LlmGuardDenied) as e:
        llm_guard.check(model="m", user="u")
    assert e.value.code == "GUARD_NO_TOKEN"


def test_api_fora_nega_fail_closed(monkeypatch):
    monkeypatch.delenv("LLM_GUARD_DISABLED_FOR_TESTS", raising=False)
    monkeypatch.setenv("GENESIS_API_TOKEN", "x")
    monkeypatch.setenv("API_BASE_URL", "http://127.0.0.1:9")  # porta fechada
    with pytest.raises(llm_guard.LlmGuardDenied) as e:
        llm_guard.check(model="m", user="u")
    assert e.value.code == "GUARD_UNREACHABLE"


def test_negado_nao_chama_o_provedor_e_e_classe_guard(fake_api, monkeypatch):
    fake_api.allow, fake_api.code = False, "BUDGET_MISSING"
    chamou = []
    monkeypatch.setattr(runtime, "_call_bedrock_direct_impl", lambda *a, **k: chamou.append(1) or "x")
    with llm_guard.guard_scope(project_id=PID):
        with pytest.raises(llm_guard.LlmGuardDenied) as e:
            runtime.call_bedrock_direct(system="s", user="u", model_id="us.anthropic.claude-sonnet-4-6")
    assert chamou == []
    assert e.value.code == "BUDGET_MISSING"
    assert runtime.classify_llm_error(e.value) == "guard"
    assert runtime.is_slot_failure(e.value) is False  # cascata NÃO tenta outro slot


def test_permitido_registra_tokens_no_projeto_do_escopo(fake_api, monkeypatch):
    def _impl(*a, **k):
        runtime._record_call_outcome(1200, 340, "end_turn", {"cacheReadTokens": 50})
        return "resposta"
    monkeypatch.setattr(runtime, "_call_bedrock_direct_impl", _impl)
    with llm_guard.guard_scope(project_id=PID, purpose="teste"):
        out = runtime.call_bedrock_direct(system="s", user="u", model_id="m1")
    assert out == "resposta"
    paths = [c[0] for c in fake_api.calls]
    assert paths == ["/api/internal/llm-guard/preflight", "/api/internal/llm-guard/record"]
    pre, rec = fake_api.calls[0][1], fake_api.calls[1][1]
    assert pre["projectId"] == PID and pre["promptHash"] == llm_guard.prompt_hash("m1", "s", "u")
    assert rec["inputTokens"] == 1200 and rec["outputTokens"] == 340 and rec["cacheReadTokens"] == 50
    assert fake_api.calls[0][2] == "Bearer tok-teste"


def test_pseudo_projeto_nao_vira_projeto(fake_api):
    llm_guard.check(model="m", user="u", project_id="spec_chat")
    assert fake_api.calls[-1][1]["projectId"] is None
    with llm_guard.guard_scope(project_id=PID):
        llm_guard.check(model="m", user="u", project_id="default")
    assert fake_api.calls[-1][1]["projectId"] == PID


def test_escopo_atravessa_thread_so_com_copy_context(fake_api):
    import contextvars
    from concurrent.futures import ThreadPoolExecutor
    with llm_guard.guard_scope(project_id=PID):
        with ThreadPoolExecutor(1) as ex:
            ex.submit(contextvars.copy_context().run, llm_guard.check, model="m", user="u").result()
    assert fake_api.calls[-1][1]["projectId"] == PID


def test_record_nunca_lanca(monkeypatch):
    monkeypatch.delenv("LLM_GUARD_DISABLED_FOR_TESTS", raising=False)
    monkeypatch.setenv("GENESIS_API_TOKEN", "x")
    monkeypatch.setenv("API_BASE_URL", "http://127.0.0.1:9")
    llm_guard.record({"projectId": PID, "model": "m"}, input_tokens=1, output_tokens=1)


def test_invoke_raw_devolve_402_quando_negado(fake_api, monkeypatch):
    from fastapi.testclient import TestClient
    from orchestrator.agents import server
    fake_api.allow, fake_api.code = False, "KILL_SWITCH"
    monkeypatch.setattr(runtime, "_call_bedrock_direct_impl", lambda *a, **k: "nunca")
    c = TestClient(server.app)
    r = c.post("/invoke/raw", json={"prompt_override": "s", "user_message": "u", "model_id": "m",
                                    "model_id_fallback": "m2", "guard_project_id": PID})
    assert r.status_code == 402
    assert r.json()["detail"]["code"] == "KILL_SWITCH"
    # principal negado NÃO escala para o fallback (1 preflight só)
    assert [c[0] for c in fake_api.calls].count("/api/internal/llm-guard/preflight") == 1
    assert fake_api.calls[0][1]["projectId"] == PID
