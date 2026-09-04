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
