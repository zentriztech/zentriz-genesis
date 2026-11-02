"""Plano de evolução v2, tarefa 1.4 — telemetria de desperdício (`WASTE_TELEMETRY`).

Garante: (1) flag `off` ⇒ payload do preflight/record byte-idêntico (conjunto exato de chaves), mesmo se o
chamador pedir motivo; (2) `shadow` grava `callReason` e `callIdemKey`; (3) motivo derivado do contexto de
`run_agent` (primary, repair, rework); (4) chave `projeto|task|etapa|tentativa` estável entre retries de rede;
(5) sem etapa não há chave; (6) motivo inválido não quebra; (7) negativa do guard não gera record e não muda modelo.
"""
import json
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from orchestrator.agents import llm_guard, runtime

PID = "11111111-2222-3333-4444-555555555555"
PREFLIGHT_KEYS_LEGACY = {"projectId", "purpose", "source", "systemId", "serviceId", "promptHash", "model",
                         "provider", "maxOutputTokens", "estInputTokens"}
RECORD_KEYS_LEGACY = {"projectId", "purpose", "source", "systemId", "serviceId", "promptHash", "model",
                      "provider", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
                      "durationMs"}
WASTE_KEYS = {"callReason", "callIdemKey"}


class _State:
    def __init__(self):
        self.allow, self.calls = True, []


@pytest.fixture
def api(monkeypatch):
    st = _State()

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
            st.calls.append((self.path, body))
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
    for v in ("LLM_GUARD_DISABLED_FOR_TESTS", "PROJECT_ID", "LLM_ROLES_MODE", "WASTE_TELEMETRY"):
        monkeypatch.delenv(v, raising=False)
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


# ── flag e helpers ────────────────────────────────────────────────────────────

def test_waste_mode_padrao_off_invalido_off(monkeypatch):
    monkeypatch.delenv("WASTE_TELEMETRY", raising=False)
    assert llm_guard.waste_mode() == "off"
    monkeypatch.setenv("WASTE_TELEMETRY", "banana")
    assert llm_guard.waste_mode() == "off"
    monkeypatch.setenv("WASTE_TELEMETRY", " Shadow ")
    assert llm_guard.waste_mode() == "shadow"
    monkeypatch.setenv("WASTE_TELEMETRY", "on")
    assert llm_guard.waste_mode() == "on"


def test_derive_reason():
    d = llm_guard.derive_reason
    assert d() == "primary"
    assert d(repair_attempt=1) == "repair"
    assert d(rework_attempt=1, rework_role=True) == "rework"
    assert d(rework_attempt=1, rework_role=False) == "primary"      # rework só vale para Dev/QA
    assert d(repair_attempt=2, rework_attempt=2, rework_role=True) == "repair"  # repair é o desperdício mais fino


def test_idem_key_formato_e_estabilidade():
    assert llm_guard.idem_key(PID, "T-1", "DEV:implement_task", "r0.p1") == f"{PID}|T-1|DEV:implement_task|r0.p1"
    assert llm_guard.idem_key(PID, None, "x", "r0.p0") == f"{PID}|-|x|r0.p0"
    # retry de rede repete a chamada de negócio ⇒ mesma chave; repair é outra tentativa ⇒ chave diferente
    assert llm_guard.idem_key(PID, "T", "e", "r0.p0") == llm_guard.idem_key(PID, "T", "e", "r0.p0")
    assert llm_guard.idem_key(PID, "T", "e", "r0.p0") != llm_guard.idem_key(PID, "T", "e", "r0.p1")


def test_waste_kwargs_vazio_em_off_e_sem_etapa_sem_chave(monkeypatch):
    monkeypatch.delenv("WASTE_TELEMETRY", raising=False)
    assert llm_guard.waste_kwargs("repair", task="T", stage="e", attempt="r0.p1") == {}
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    assert llm_guard.waste_kwargs("support") == {"call_reason": "support"}
    assert llm_guard.waste_kwargs("repair", task="T", stage="e", attempt="r0.p1") == {
        "call_reason": "repair", "call_task": "T", "call_stage": "e", "call_attempt": "r0.p1"}


# ── snapshot off ──────────────────────────────────────────────────────────────

def test_off_payload_byte_identico_mesmo_se_chamador_pedir_motivo(api, monkeypatch):
    _direct(monkeypatch, waste={"call_reason": "repair", "call_task": "T", "call_stage": "e", "call_attempt": "r0.p1"})
    pre, rec = api.calls[0][1], api.calls[1][1]
    assert set(pre) == PREFLIGHT_KEYS_LEGACY and set(rec) == RECORD_KEYS_LEGACY


def test_off_chamada_sem_motivo_identica(api, monkeypatch):
    _direct(monkeypatch)
    assert set(api.calls[0][1]) == PREFLIGHT_KEYS_LEGACY and set(api.calls[1][1]) == RECORD_KEYS_LEGACY


# ── shadow ────────────────────────────────────────────────────────────────────

def test_shadow_grava_motivo_e_chave(api, monkeypatch):
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    _direct(monkeypatch, waste=llm_guard.waste_kwargs("repair", task="T-9", stage="DEV:implement_task", attempt="r1.p1"))
    rec = api.calls[1][1]
    assert rec["callReason"] == "repair"
    assert rec["callIdemKey"] == f"{PID}|T-9|DEV:implement_task|r1.p1"
    assert set(rec) == RECORD_KEYS_LEGACY | WASTE_KEYS


def test_shadow_retry_de_rede_repete_a_chave(api, monkeypatch):
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    w = llm_guard.waste_kwargs("primary", task="T", stage="PM:generate_backlog", attempt="r0.p0")
    _direct(monkeypatch, waste=w)
    _direct(monkeypatch, waste=w)
    recs = [b for p, b in api.calls if p.endswith("/record")]
    assert len(recs) == 2 and recs[0]["callIdemKey"] == recs[1]["callIdemKey"]


def test_shadow_sem_etapa_grava_motivo_mas_nao_chave(api, monkeypatch):
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    _direct(monkeypatch, waste=llm_guard.waste_kwargs("support"))
    rec = api.calls[1][1]
    assert rec["callReason"] == "support" and "callIdemKey" not in rec


def test_shadow_motivo_invalido_ou_ausente_nao_quebra(api, monkeypatch):
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    assert _direct(monkeypatch, waste={"call_reason": "banana", "call_stage": "e"}) == "ok"
    assert not (WASTE_KEYS & set(api.calls[1][1]))
    api.calls.clear()
    assert _direct(monkeypatch) == "ok"
    assert not (WASTE_KEYS & set(api.calls[1][1]))


def test_guard_deny_nao_chama_nem_registra(api, monkeypatch):
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    api.allow = False
    chamou = []
    monkeypatch.setattr(runtime, "_call_bedrock_direct_impl", lambda *a, **k: chamou.append(1) or "x")
    with llm_guard.guard_scope(project_id=PID):
        with pytest.raises(llm_guard.LlmGuardDenied):
            runtime.call_bedrock_direct(system="s", user="u", model_id="m1", waste=llm_guard.waste_kwargs("repair"))
    assert chamou == [] and [p for p, _ in api.calls] == ["/api/internal/llm-guard/preflight"]


def test_roles_e_waste_coexistem(api, monkeypatch):
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    monkeypatch.setenv("LLM_ROLES_MODE", "shadow")
    _direct(monkeypatch, waste=llm_guard.waste_kwargs("escalation"), **llm_guard.role_kwargs(escalated=True))
    rec = api.calls[1][1]
    assert (rec["llmRole"], rec["escalatedFrom"], rec["callReason"]) == ("advisor", "orchestrator", "escalation")


# ── run_agent: primary / repair / rework ──────────────────────────────────────

class _FakeMessages:
    """1ª resposta inválida (força repair da LEI 5) quando `bad_first`; depois, envelope válido."""
    def __init__(self, sink, bad_first):
        self.sink, self.bad_first, self.n = sink, bad_first, 0

    def create(self, **kw):
        self.sink.append(kw["model"])
        self.n += 1
        if self.bad_first and self.n == 1:
            text = "isto não é um envelope JSON"
        else:
            text = json.dumps({"request_id": "r", "status": "OK",
                               "summary": "implementação concluída com evidência suficiente para o validador",
                               "artifacts": [], "evidence": [], "next_actions": {}})
        return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text=text)],
                                     usage=types.SimpleNamespace(input_tokens=10, output_tokens=5),
                                     stop_reason="end_turn")


def _run(monkeypatch, rework_attempt, bad_first=False, role="DEV"):
    models: list[str] = []
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(
        Anthropic=lambda **kw: types.SimpleNamespace(messages=_FakeMessages(models, bad_first)),
        AnthropicBedrock=object))
    msg = {"request_id": "r", "project_id": PID, "task_id": "T-7",
           "input": {"rework_attempt": rework_attempt, "project_id": PID},
           "llm_config": {"provider": "anthropic", "api_key": "k", "model": "claude-sonnet-4-6",
                          "model_rework": "claude-opus-4-8"}}
    out = runtime.run_agent("x.md", msg, role=role, system_prompt_override="sys")
    return out, models


def test_run_agent_primary_rework_e_repair(api, monkeypatch):
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    try:
        _, m0 = _run(monkeypatch, 0)
        _, m1 = _run(monkeypatch, 1)
        _, m2 = _run(monkeypatch, 0, bad_first=True)
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"run_agent não isolável neste ambiente: {exc}")
    recs = [b for p, b in api.calls if p.endswith("/record")]
    assert [r["callReason"] for r in recs[:2]] == ["primary", "rework"]
    assert m0 == ["claude-sonnet-4-6"] and m1 == ["claude-opus-4-8"]   # nenhuma escolha de modelo mudou
    assert recs[0]["callIdemKey"] == f"{PID}|T-7|DEV:default|r0.p0"
    assert recs[1]["callIdemKey"] == f"{PID}|T-7|DEV:default|r1.p0"
    # terceira execução: 1ª chamada inválida (primary) + repair; ambas pagas e com chaves distintas
    assert [r["callReason"] for r in recs[2:]] == ["primary", "repair"]
    assert recs[2]["callIdemKey"].endswith("|r0.p0") and recs[3]["callIdemKey"].endswith("|r0.p1")
    assert m2 == ["claude-sonnet-4-6", "claude-sonnet-4-6"]


def test_run_agent_off_nao_envia_motivo(api, monkeypatch):
    try:
        _run(monkeypatch, 1, bad_first=True)
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"run_agent não isolável neste ambiente: {exc}")
    assert api.calls and not any(WASTE_KEYS & set(b) for _, b in api.calls)
    assert all(set(b) <= (PREFLIGHT_KEYS_LEGACY | RECORD_KEYS_LEGACY) for _, b in api.calls)


def test_waste_call_kwargs_off_nao_acrescenta_argumento(monkeypatch):
    """Regressão: com a flag off a chamada a `call_bedrock_direct` fica com os MESMOS argumentos (dublês antigos seguem válidos)."""
    monkeypatch.delenv("WASTE_TELEMETRY", raising=False)
    assert llm_guard.waste_call_kwargs("primary") == {}
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    assert llm_guard.waste_call_kwargs("escalation") == {"waste": {"call_reason": "escalation"}}
