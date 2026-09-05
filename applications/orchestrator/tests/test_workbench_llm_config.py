"""Bancada usa a MESMA config de LLM da fábrica (2026-09-04): lift de llm_config no wrapper do
agents, credenciais do tenant em call_bedrock_direct, modelo efetivo reportado, precedência do
modelo no validador."""
from __future__ import annotations

import sys
import types

import pytest

from orchestrator.agents import runtime
from orchestrator.agents import server
from orchestrator import spec_validator


def test_wrap_with_llm_config_levanta_para_o_topo():
    body = {"request_id": "r1", "task": "x", "llm_config": {"provider": "bedrock", "model": "m1"}}
    msg = server._wrap_with_llm_config(body)
    assert msg["input"] is body and msg["llm_config"] == {"provider": "bedrock", "model": "m1"}
    # sem llm_config (ou vazio) → envelope idêntico ao antigo
    assert "llm_config" not in server._wrap_with_llm_config({"task": "x"})
    assert "llm_config" not in server._wrap_with_llm_config({"task": "x", "llm_config": {}})


class _FakeUsage:
    input_tokens = 10
    output_tokens = 5


class _FakeResp:
    usage = _FakeUsage()
    content = [types.SimpleNamespace(text="PONG")]


def _install_fake_bedrock(monkeypatch, fail_models: set[str], captured: dict):
    """Substitui anthropic.AnthropicBedrock por um fake que grava kwargs do cliente e do create."""
    class _Messages:
        def create(self, **kw):
            captured.setdefault("creates", []).append(dict(kw))
            if kw["model"] in fail_models:
                raise RuntimeError("anthropic.claude-x is not available for this account")
            return _FakeResp()

    class _FakeBedrock:
        def __init__(self, **kw):
            captured["client_kwargs"] = dict(kw)
            self.messages = _Messages()

    fake_mod = types.ModuleType("anthropic")
    fake_mod.AnthropicBedrock = _FakeBedrock
    monkeypatch.setitem(sys.modules, "anthropic", fake_mod)
    monkeypatch.delenv("GENESIS_LLM_PROVIDER", raising=False)
    monkeypatch.setattr(runtime, "_report_direct_usage", lambda *a, **k: None)


def test_call_bedrock_direct_usa_credenciais_do_tenant_e_reporta_modelo_efetivo(monkeypatch):
    captured: dict = {}
    _install_fake_bedrock(monkeypatch, fail_models={"us.anthropic.claude-opus-4-8"}, captured=captured)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "ENV_AK")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "ENV_SK")
    monkeypatch.setenv("CLAUDE_MODEL_FALLBACK", "us.anthropic.claude-sonnet-4-6")
    cfg = {"aws_access_key_id": "TENANT_AK", "aws_secret_access_key": "TENANT_SK", "aws_region": "us-west-2"}
    out = runtime.call_bedrock_direct("sys", "user", "us.anthropic.claude-opus-4-8", max_tokens=8, llm_cfg=cfg)
    assert out == "PONG"
    # credenciais do TENANT vencem o env; região do tenant também
    assert captured["client_kwargs"]["aws_access_key"] == "TENANT_AK"
    assert captured["client_kwargs"]["aws_secret_key"] == "TENANT_SK"
    assert captured["client_kwargs"]["aws_region"] == "us-west-2"
    # cascata: opus indisponível → fallback do env; modelo EFETIVO exposto
    assert [c["model"] for c in captured["creates"]] == ["us.anthropic.claude-opus-4-8", "us.anthropic.claude-sonnet-4-6"]
    assert runtime.LAST_EFFECTIVE_MODEL.get() == "us.anthropic.claude-sonnet-4-6"


def test_call_bedrock_direct_sem_llm_cfg_usa_env(monkeypatch):
    captured: dict = {}
    _install_fake_bedrock(monkeypatch, fail_models=set(), captured=captured)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "ENV_AK")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "ENV_SK")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    runtime.call_bedrock_direct("sys", "user", "us.anthropic.claude-sonnet-4-6", max_tokens=8)
    assert captured["client_kwargs"]["aws_access_key"] == "ENV_AK"
    assert runtime.LAST_EFFECTIVE_MODEL.get() == "us.anthropic.claude-sonnet-4-6"
    # llm_cfg parcial (só uma das chaves) NÃO substitui o env (evita cliente meio-configurado)
    runtime.call_bedrock_direct("sys", "user", "us.anthropic.claude-sonnet-4-6", max_tokens=8,
                                llm_cfg={"aws_access_key_id": "SO_AK"})
    assert captured["client_kwargs"]["aws_access_key"] == "ENV_AK"


def test_validate_spec_precedencia_do_modelo(monkeypatch):
    seen: list[str] = []

    def llm_fn(system, user, model_id, **kw):
        seen.append(model_id)
        return '{"findings": []}'

    monkeypatch.delenv("SPEC_VALIDATOR_MODEL", raising=False)
    monkeypatch.delenv("SPEC_VALIDATOR_TRIAGE_MODEL", raising=False)
    monkeypatch.delenv("GENESIS_LLM_PROVIDER", raising=False)
    monkeypatch.setenv("SPEC_VALIDATOR_VOTES", "1")
    spec_validator.validate_spec("# Spec\n\nFR-01 algo", llm_fn=llm_fn, model_id="us.anthropic.claude-opus-4-8")
    assert seen and seen[0] == "us.anthropic.claude-opus-4-8"          # modelo do tenant
    seen.clear()
    spec_validator.validate_spec("# Spec\n\nFR-01 algo", llm_fn=llm_fn)
    assert seen and seen[0] == "us.anthropic.claude-sonnet-4-6"        # default por desenho
    seen.clear()
    monkeypatch.setenv("SPEC_VALIDATOR_MODEL", "us.anthropic.claude-haiku-4-5")
    spec_validator.validate_spec("# Spec\n\nFR-01 algo", llm_fn=llm_fn, model_id="us.anthropic.claude-opus-4-8")
    assert seen and seen[0] == "us.anthropic.claude-haiku-4-5"         # env é override explícito


# ── Validador: orçamento por família + retry/salvage em JSON truncado (achado prod 2026-09-04) ──

def test_refuter_max_tokens_por_familia(monkeypatch):
    monkeypatch.delenv("SPEC_VALIDATOR_MAX_TOKENS", raising=False)
    assert spec_validator._refuter_max_tokens("us.anthropic.claude-sonnet-4-6") == 4000
    # 2026-09-05: 16.000 → 32.000 de primeira (a 1ª chamada batia no teto e o retry gastava o dobro
    # pelo MESMO resultado; token de saída é cobrado pelo gerado, não pelo teto).
    assert spec_validator._refuter_max_tokens("us.anthropic.claude-fable-5-1") == 32000
    assert spec_validator._refuter_max_tokens("us.anthropic.claude-opus-5") == 32000
    monkeypatch.setenv("SPEC_VALIDATOR_MAX_TOKENS", "9000")
    assert spec_validator._refuter_max_tokens("us.anthropic.claude-fable-5-1") == 9000


def test_refuter_truncado_retry_com_dobro_e_salvage(monkeypatch):
    monkeypatch.delenv("SPEC_VALIDATOR_MODEL", raising=False)
    monkeypatch.delenv("SPEC_VALIDATOR_TRIAGE_MODEL", raising=False)
    monkeypatch.delenv("SPEC_VALIDATOR_MAX_TOKENS", raising=False)
    monkeypatch.setenv("SPEC_VALIDATOR_VOTES", "1")
    good = '{"findings":[{"file":"a.md","severity":"warning","category":"contrato","anchor":"FR-01","title":"ok","rationale":"r"}]}'
    truncated = '{"findings":[{"file":"a.md","severity":"blocker","category":"seguranca","anchor":"FR-02","title":"salvo","rationale":"r"},{"file":"a.md","severity":"warn'
    calls: list[int] = []

    def llm_first_truncated(system, user, model_id, **kw):
        calls.append(kw["max_tokens"])
        return truncated if len(calls) == 1 else good

    out = spec_validator.validate_spec("spec", llm_fn=llm_first_truncated, model_id="us.anthropic.claude-fable-5-1")
    assert calls == [32000, 64000]                       # retry com o dobro (teto 64k = saída do Opus 5)
    assert [f["title"] for f in out["findings"]] == ["ok"]

    calls.clear()
    def llm_always_truncated(system, user, model_id, **kw):
        calls.append(kw["max_tokens"]); return truncated
    out2 = spec_validator.validate_spec("spec", llm_fn=llm_always_truncated, model_id="us.anthropic.claude-fable-5-1")
    assert [f["title"] for f in out2["findings"]] == ["salvo"]   # salvage recupera o item completo
    assert len(calls) == 2

    with pytest.raises(ValueError):                       # nada salvável → erro como antes
        spec_validator.validate_spec("spec", llm_fn=lambda *a, **k: "prosa sem json")


def test_call_bedrock_direct_passa_timeout_explicito_e_sobrevive_a_max_tokens_alto(monkeypatch):
    """Prod 2026-09-05 (NVX LastMile): sem `timeout` explícito o SDK anthropic recusa CLIENT-SIDE
    qualquer max_tokens > 21.333 ("Streaming is required for operations that may take longer than
    10 minutes") — o retry do refutador (32.000) derrubava a validação antes de chamar a AWS.
    O fake abaixo reproduz a regra REAL do SDK (`messages.py`: `not stream and not is_given(timeout)
    and client.timeout == DEFAULT_TIMEOUT` → `_calculate_nonstreaming_timeout`)."""
    captured: dict = {}

    class _Messages:
        def create(self, **kw):
            captured.setdefault("creates", []).append(dict(kw))
            if "timeout" not in kw and 3600 * kw["max_tokens"] / 128_000 > 600:
                raise ValueError("Streaming is required for operations that may take longer than "
                                 "10 minutes.")
            return _FakeResp()

    class _FakeBedrock:
        def __init__(self, **kw):
            self.messages = _Messages()

    fake_mod = types.ModuleType("anthropic")
    fake_mod.AnthropicBedrock = _FakeBedrock
    monkeypatch.setitem(sys.modules, "anthropic", fake_mod)
    monkeypatch.delenv("GENESIS_LLM_PROVIDER", raising=False)
    monkeypatch.setattr(runtime, "_report_direct_usage", lambda *a, **k: None)

    out = runtime.call_bedrock_direct("sys", "user", "us.anthropic.claude-opus-5", max_tokens=32000)
    assert out == "PONG"
    assert captured["creates"][0]["timeout"] >= 900  # explícito → desarma o guard do SDK


def test_call_bedrock_direct_desliga_thinking_e_cai_para_adaptativo_se_recusado(monkeypatch):
    """2026-09-05: raciocínio adaptativo LIGADO no Bedrock (`blocks=thinking,text` medido em prod)
    consome `max_tokens` e truncava o JSON. Desligamos por padrão — e, se a rota recusar o parâmetro,
    a chamada NÃO pode morrer: reenvia uma vez sem ele."""
    captured: dict = {"creates": []}

    class _Messages:
        def __init__(self, reject_thinking: bool):
            self._reject = reject_thinking

        def create(self, **kw):
            captured["creates"].append(dict(kw))
            if self._reject and "thinking" in kw:
                raise ValueError("Extra inputs are not permitted: thinking")
            return _FakeResp()

    def _install(reject: bool):
        class _FakeBedrock:
            def __init__(self, **kw):
                self.messages = _Messages(reject)
        fake_mod = types.ModuleType("anthropic")
        fake_mod.AnthropicBedrock = _FakeBedrock
        monkeypatch.setitem(sys.modules, "anthropic", fake_mod)

    monkeypatch.delenv("GENESIS_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("GENESIS_DISABLE_THINKING", raising=False)
    monkeypatch.setattr(runtime, "_report_direct_usage", lambda *a, **k: None)

    _install(reject=False)
    assert runtime.call_bedrock_direct("sys", "user", "us.anthropic.claude-opus-5", max_tokens=32000) == "PONG"
    assert captured["creates"][-1]["thinking"] == {"type": "disabled"}

    captured["creates"].clear()
    _install(reject=True)
    assert runtime.call_bedrock_direct("sys", "user", "us.anthropic.claude-opus-5", max_tokens=32000) == "PONG"
    assert len(captured["creates"]) == 2                       # 1ª com thinking, 2ª sem
    assert "thinking" not in captured["creates"][1]

    captured["creates"].clear()
    monkeypatch.setenv("GENESIS_DISABLE_THINKING", "0")        # kill-switch sem redeploy
    _install(reject=False)
    runtime.call_bedrock_direct("sys", "user", "us.anthropic.claude-opus-5", max_tokens=8000)
    assert "thinking" not in captured["creates"][0]


def test_thinking_extra_por_provider(monkeypatch):
    monkeypatch.delenv("GENESIS_DISABLE_THINKING", raising=False)
    monkeypatch.delenv("GENESIS_FOUNDRY_DISABLE_THINKING", raising=False)
    assert runtime._thinking_extra("bedrock") == {"thinking": {"type": "disabled"}}
    assert runtime._thinking_extra("foundry") == {"thinking": {"type": "disabled"}}
    monkeypatch.setenv("GENESIS_FOUNDRY_DISABLE_THINKING", "0")
    assert runtime._thinking_extra("foundry") == {}             # compat: só afeta o Foundry
    assert runtime._thinking_extra("bedrock") == {"thinking": {"type": "disabled"}}
    monkeypatch.setenv("GENESIS_DISABLE_THINKING", "0")
    assert runtime._thinking_extra("bedrock") == {}
    assert runtime._is_thinking_param_error(ValueError("Extra inputs: thinking")) is True
    assert runtime._is_thinking_param_error(ValueError("throttled")) is False


def test_nonstreaming_timeout_escala_com_max_tokens(monkeypatch):
    monkeypatch.delenv("REQUEST_TIMEOUT", raising=False)
    assert runtime._nonstreaming_timeout_sec(8000) == 900      # piso = timeout da fábrica
    assert runtime._nonstreaming_timeout_sec(32000) == 900
    assert runtime._nonstreaming_timeout_sec(64000) == 1800    # escala (3600 s por 128k tokens)
    assert runtime._nonstreaming_timeout_sec(999_999) == 3600  # teto de 1 h
