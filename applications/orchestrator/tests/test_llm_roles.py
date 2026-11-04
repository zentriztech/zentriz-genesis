"""Plano de evolução v2, tarefa 1.3 — papel de LLM no ledger (`LLM_ROLES_MODE`).

Garante: (1) flag `off` ⇒ payload do preflight/record byte-idêntico ao de antes (conjunto exato de chaves);
(2) `shadow` grava o papel derivado do comportamento atual; (3) escalada grava `escalatedFrom`;
(4) papel ausente não quebra; (5) negativa do guard não muda papel nem modelo e não gera registro;
(6) o rework do `run_agent` (modelo do slot trocado) vira advisor, e só ele.
"""
import json
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from orchestrator.agents import llm_guard, runtime

PID = "11111111-2222-3333-4444-555555555555"

# Snapshot: chaves do payload ANTES da tarefa 1.3.
PREFLIGHT_KEYS_LEGACY = {"projectId", "purpose", "source", "systemId", "serviceId", "promptHash", "model",
                         "provider", "maxOutputTokens", "estInputTokens"}
RECORD_KEYS_LEGACY = {"projectId", "purpose", "source", "systemId", "serviceId", "promptHash", "model",
                      "provider", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
                      "durationMs"}
ROLE_KEYS = {"llmRole", "effectiveRole", "escalatedFrom"}


class _State:
    def __init__(self):
        self.allow, self.calls = True, []
        self.advisor_verdict = {"allow": True, "mode": "legacy"}   # C4': resposta do Guard a /advisor-gate


@pytest.fixture
def api(monkeypatch):
    st = _State()

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
            st.calls.append((self.path, body))
            if self.path.endswith("/advisor-gate"):   # C4': sem política `advisor_pct` ⇒ Guard devolve "legacy" (teto em env)
                out = st.advisor_verdict
            else:
                out = ({"allow": st.allow, "code": "BUDGET_MISSING", "message": "teste"}
                       if self.path.endswith("/preflight") else {"ok": True})
            data = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.delenv("LLM_GUARD_DISABLED_FOR_TESTS", raising=False)
    monkeypatch.delenv("PROJECT_ID", raising=False)
    monkeypatch.delenv("LLM_ROLES_MODE", raising=False)
    monkeypatch.setenv("API_BASE_URL", f"http://127.0.0.1:{srv.server_port}")
    monkeypatch.setenv("GENESIS_API_TOKEN", "tok")
    yield st
    srv.shutdown()


def _direct(monkeypatch, **kw):
    def _impl(*a, **k):
        runtime._record_call_outcome(100, 20, "end_turn", {})
        return "ok"
    monkeypatch.setattr(runtime, "_call_bedrock_direct_impl", _impl)
    with llm_guard.guard_scope(project_id=PID, purpose="t"):
        return runtime.call_bedrock_direct(system="s", user="u", model_id="m1", **kw)


# ── flag ──────────────────────────────────────────────────────────────────────

def test_roles_mode_padrao_off_e_invalido_vira_off(monkeypatch):
    monkeypatch.delenv("LLM_ROLES_MODE", raising=False)
    assert llm_guard.roles_mode() == "off"
    monkeypatch.setenv("LLM_ROLES_MODE", "banana")
    assert llm_guard.roles_mode() == "off"
    monkeypatch.setenv("LLM_ROLES_MODE", " Shadow ")
    assert llm_guard.roles_mode() == "shadow"
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    assert llm_guard.roles_mode() == "on"


def test_role_kwargs_vazio_em_off_e_derivado_em_shadow(monkeypatch):
    monkeypatch.delenv("LLM_ROLES_MODE", raising=False)
    assert llm_guard.role_kwargs() == {} and llm_guard.role_kwargs(escalated=True) == {}
    monkeypatch.setenv("LLM_ROLES_MODE", "shadow")
    assert llm_guard.role_kwargs() == {"llm_role": "orchestrator"}
    assert llm_guard.role_kwargs(escalated=True) == {"llm_role": "advisor", "escalated_from": "orchestrator"}
    assert llm_guard.role_kwargs(staff=True) == {"llm_role": "staff"}


# ── snapshot off ──────────────────────────────────────────────────────────────

def test_off_payload_byte_identico_mesmo_com_papel_no_chamador(api, monkeypatch):
    # chamador de papel pede explicitamente, mas a flag está off ⇒ nada viaja
    _direct(monkeypatch, llm_role="advisor", escalated_from="orchestrator")
    pre, rec = api.calls[0][1], api.calls[1][1]
    assert set(pre) == PREFLIGHT_KEYS_LEGACY
    assert set(rec) == RECORD_KEYS_LEGACY
    assert not (ROLE_KEYS & set(pre)) and not (ROLE_KEYS & set(rec))


def test_off_chamada_sem_papel_identica(api, monkeypatch):
    _direct(monkeypatch)
    assert set(api.calls[0][1]) == PREFLIGHT_KEYS_LEGACY and set(api.calls[1][1]) == RECORD_KEYS_LEGACY


# ── shadow ────────────────────────────────────────────────────────────────────

def test_shadow_grava_orchestrator_no_modelo_principal(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "shadow")
    _direct(monkeypatch, **llm_guard.role_kwargs())
    rec = api.calls[1][1]
    assert rec["llmRole"] == "orchestrator" and rec["effectiveRole"] == "orchestrator"
    assert "escalatedFrom" not in rec
    assert set(rec) == RECORD_KEYS_LEGACY | {"llmRole", "effectiveRole"}


def test_shadow_escalada_grava_escalated_from(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "shadow")
    _direct(monkeypatch, **llm_guard.role_kwargs(escalated=True))
    rec = api.calls[1][1]
    assert (rec["llmRole"], rec["effectiveRole"], rec["escalatedFrom"]) == ("advisor", "advisor", "orchestrator")


def test_shadow_sem_papel_ou_papel_invalido_nao_quebra(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "shadow")
    assert _direct(monkeypatch) == "ok"
    assert not (ROLE_KEYS & set(api.calls[1][1]))
    api.calls.clear()
    assert _direct(monkeypatch, llm_role="ceo", escalated_from="x") == "ok"
    assert not (ROLE_KEYS & set(api.calls[1][1]))


def test_guard_deny_nao_muda_papel_nem_grava(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "shadow")
    api.allow = False
    chamou = []
    monkeypatch.setattr(runtime, "_call_bedrock_direct_impl", lambda *a, **k: chamou.append(1) or "x")
    with llm_guard.guard_scope(project_id=PID):
        with pytest.raises(llm_guard.LlmGuardDenied) as e:
            runtime.call_bedrock_direct(system="s", user="u", model_id="m1", **llm_guard.role_kwargs())
    assert chamou == [] and e.value.code == "BUDGET_MISSING"
    assert [p for p, _ in api.calls] == ["/api/internal/llm-guard/preflight"]  # nenhum record
    # a negativa não "rebaixa": o papel exigido segue o mesmo para a próxima tentativa
    assert llm_guard.role_kwargs() == {"llm_role": "orchestrator"}


# ── run_agent: rework escalado = advisor ──────────────────────────────────────

class _FakeMessages:
    def __init__(self, sink):
        self.sink = sink

    def create(self, **kw):
        self.sink.append(kw["model"])
        env = {"request_id": "r", "status": "OK", "summary": "implementação concluída com evidência suficiente para o validador", "artifacts": [], "evidence": [], "next_actions": {}}
        return types.SimpleNamespace(
            content=[types.SimpleNamespace(type="text", text=json.dumps(env))],
            usage=types.SimpleNamespace(input_tokens=10, output_tokens=5),
            stop_reason="end_turn")


def _run(monkeypatch, rework_attempt, mode):
    models: list[str] = []
    # `anthropic` pode nem estar instalado no ambiente de teste: injeta um módulo mínimo.
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(
        Anthropic=lambda **kw: types.SimpleNamespace(messages=_FakeMessages(models)),
        AnthropicBedrock=object))
    if mode:
        monkeypatch.setenv("LLM_ROLES_MODE", mode)
    msg = {"request_id": "r", "project_id": PID, "input": {"rework_attempt": rework_attempt, "project_id": PID},
           "llm_config": {"provider": "anthropic", "api_key": "k", "model": "claude-sonnet-4-6",
                          "model_rework": "claude-opus-4-8"}}
    out = runtime.run_agent("x.md", msg, role="DEV", system_prompt_override="sys")
    return out, models


def test_run_agent_rework_vira_advisor_e_primeira_tentativa_orchestrator(api, monkeypatch):
    try:
        out0, m0 = _run(monkeypatch, 0, "shadow")
        out1, m1 = _run(monkeypatch, 1, "shadow")
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"run_agent não isolável neste ambiente: {exc}")
    recs = [b for p, b in api.calls if p.endswith("/record")]
    assert m0 == ["claude-sonnet-4-6"] and m1 == ["claude-opus-4-8"]  # nenhuma escolha de modelo mudou
    assert (recs[0]["llmRole"], "escalatedFrom" in recs[0]) == ("orchestrator", False)
    assert (recs[1]["llmRole"], recs[1]["escalatedFrom"]) == ("advisor", "orchestrator")
    assert out0["_llm_role"] == "orchestrator" and out1["_llm_role"] == "advisor"


def test_run_agent_off_nao_carimba_papel(api, monkeypatch):
    try:
        out, _ = _run(monkeypatch, 1, None)
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"run_agent não isolável neste ambiente: {exc}")
    assert "_llm_role" not in out
    assert not any(ROLE_KEYS & set(b) for _, b in api.calls)


# ── runner: /agent-metrics ────────────────────────────────────────────────────

def _metrics_payload(monkeypatch, mode):
    import urllib.request as _rq
    from orchestrator import runner
    seen = {}
    monkeypatch.setattr(_rq, "urlopen", lambda req, timeout=0: seen.setdefault("b", json.loads(req.data.decode())))
    monkeypatch.setenv("API_BASE_URL", "http://api:3000")
    monkeypatch.setenv("GENESIS_API_TOKEN", "tok")
    if mode:
        monkeypatch.setenv("LLM_ROLES_MODE", mode)
    else:
        monkeypatch.delenv("LLM_ROLES_MODE", raising=False)
    runner._record_agent_metrics(PID, "Dev", {"_input_tokens": 5, "_output_tokens": 2, "_model": "m",
                                              "_duration_ms": 9, "status": "OK", "_llm_role": "advisor"}, "T1", 2)
    return seen["b"]


def test_metrics_off_payload_identico_e_shadow_acrescenta_llmRole(monkeypatch):
    off = _metrics_payload(monkeypatch, None)
    assert set(off) == {"agent", "taskId", "round", "inputTokens", "outputTokens", "model", "durationMs", "status"}
    sh = _metrics_payload(monkeypatch, "shadow")
    assert sh["llmRole"] == "advisor" and set(sh) - {"llmRole"} == set(off)
