"""test_byoc_exempt_executor.py — T1: `tenants.byoc_exempt` até o EXECUTOR (full-test-server).

LEI dos slots (Jean, 2026-09-10) × exceção legítima `byoc_exempt` (migration 069; só `zentriz_admin`
liga). O executor já recusava slot Bedrock sem chave (502 no dev). A flag precisa atravessar:
API → `runner_server` (env do run) → `runner._ft_payload` / `cyborg_v3` (corpo do FTS) → FTS.
Aqui: os dois trechos Python do orchestrator + o contrato FTS ponta a ponta (sem chamar o Bedrock).
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

from orchestrator import cyborg_v3
from orchestrator.tests.test_llm_roles_contract import _post_run, RESP_BASE  # noqa: F401
from orchestrator.tests.test_llm_roles import api, PID  # noqa: F401  (fixture `api`)

ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location("fts_byoc", ROOT / "scripts" / "full-test-server.py")
fts = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(fts)

SEM_CHAVE = {"ok": True, "provider": "bedrock", "modelId": "us.anthropic.claude-opus-5-5",
             "awsRegion": "us-west-2"}


# ── runner_server: API -> env do run ─────────────────────────────────────────────

def test_runner_server_propaga_byoc_exempt_true_ao_env_do_run(monkeypatch, tmp_path):
    env = _post_run(monkeypatch, tmp_path, None, {**SEM_CHAVE, "byoc_exempt": True})
    assert env["GENESIS_LLM_BYOC_EXEMPT"] == "1"


@pytest.mark.parametrize("valor", [False, None, "true", 1, "1"])
def test_runner_server_so_true_estrito_isenta(monkeypatch, tmp_path, valor):
    resp = {**SEM_CHAVE}
    if valor is not None:
        resp["byoc_exempt"] = valor
    env = _post_run(monkeypatch, tmp_path, None, resp)
    assert "GENESIS_LLM_BYOC_EXEMPT" not in env


def test_runner_server_nao_herda_isencao_do_env_do_container(monkeypatch, tmp_path):
    """Um `GENESIS_LLM_BYOC_EXEMPT=1` no env do container NÃO pode isentar tenant não isento."""
    env = _post_run(monkeypatch, tmp_path, None, {**SEM_CHAVE, "byoc_exempt": False},
                    extra_env={"GENESIS_LLM_BYOC_EXEMPT": "1"})
    assert "GENESIS_LLM_BYOC_EXEMPT" not in env


# ── runner: env do run -> payload do /run-full-test ──────────────────────────────

def test_runner_le_a_isencao_do_env_estrito(monkeypatch):
    from orchestrator import runner
    monkeypatch.delenv("GENESIS_LLM_BYOC_EXEMPT", raising=False)
    assert runner._byoc_exempt_do_run() is False
    monkeypatch.setenv("GENESIS_LLM_BYOC_EXEMPT", "1")
    assert runner._byoc_exempt_do_run() is True
    monkeypatch.setenv("GENESIS_LLM_BYOC_EXEMPT", "true")
    assert runner._byoc_exempt_do_run() is False


def test_payload_do_full_test_carrega_byoc_exempt_junto_do_slot():
    src = (ROOT / "applications" / "orchestrator" / "runner.py").read_text(encoding="utf-8")
    i = src.index("_ft_payload = {")
    bloco = src[i:src.index("}", i)]
    assert '"llm_config":   _llm_envelope_do_run()' in bloco
    assert '"byoc_exempt":  _byoc_exempt_do_run()' in bloco


# ── cyborg_v3: API -> corpo do /cyborg-engineer ──────────────────────────────────

def test_cyborg_resolve_slot_traz_byoc_exempt(monkeypatch):
    monkeypatch.setattr(cyborg_v3, "_http", lambda *a, **k: (200, json.dumps({**SEM_CHAVE, "byoc_exempt": True})))
    assert cyborg_v3._resolve_slot_llm("p")["byoc_exempt"] is True
    monkeypatch.setattr(cyborg_v3, "_http", lambda *a, **k: (200, json.dumps({**SEM_CHAVE, "byoc_exempt": "true"})))
    assert cyborg_v3._resolve_slot_llm("p")["byoc_exempt"] is False
    monkeypatch.setattr(cyborg_v3, "_http", lambda *a, **k: (200, json.dumps(SEM_CHAVE)))
    assert cyborg_v3._resolve_slot_llm("p")["byoc_exempt"] is False


def test_corpo_do_executor_leva_a_flag_e_o_do_invoke_raw_nao():
    tok = cyborg_v3._SLOT_LLM.set({"model_id": "m", "llm_config": {"provider": "bedrock", "model": "m"},
                                   "byoc_exempt": True})
    try:
        assert cyborg_v3._slot_body_fields("m", for_executor=True)["byoc_exempt"] is True
        assert "byoc_exempt" not in cyborg_v3._slot_body_fields("m")  # agents decidem pela API
    finally:
        cyborg_v3._SLOT_LLM.reset(tok)


def test_spawn_engineer_despacha_ao_fts_com_byoc_exempt(monkeypatch):
    from orchestrator import executor_bridge
    from orchestrator.agents import llm_guard
    seen = {}
    monkeypatch.setattr(executor_bridge, "dispatch",
                        lambda path, payload, *a, **k: (seen.update(path=path, payload=payload) or (200, "{}")))
    monkeypatch.setattr(cyborg_v3, "_load_prompt", lambda *a, **k: "p")
    monkeypatch.setattr(cyborg_v3, "_fetch_type_policy_for_project", lambda *a, **k: None)
    monkeypatch.setattr(cyborg_v3, "_resolve_proj_dir", lambda *a, **k: Path("/tmp"))
    monkeypatch.setattr(llm_guard, "check", lambda **k: object())
    monkeypatch.setattr(llm_guard, "record", lambda *a, **k: None)
    tok = cyborg_v3._SLOT_LLM.set({"model_id": "m", "llm_config": {"provider": "bedrock", "model": "m"},
                                   "byoc_exempt": True})
    try:
        cyborg_v3.spawn_engineer("p1", None, None, "audit", "m")
    finally:
        cyborg_v3._SLOT_LLM.reset(tok)
    assert seen["path"] == "/cyborg-engineer"
    assert seen["payload"]["byoc_exempt"] is True
    assert seen["payload"]["llm_config"]["provider"] == "bedrock"


# ── FTS: a flag da API chega ao roteamento do CLI ────────────────────────────────

BEDROCK_SEM_CHAVE = {"provider": "bedrock", "model": "us.anthropic.claude-opus-5-5", "aws_region": "us-west-2"}
BEDROCK_COM_CHAVE = {**BEDROCK_SEM_CHAVE, "aws_access_key_id": "AKIA_T", "aws_secret_access_key": "SEC_T"}


def test_payload_com_flag_da_api_vira_env_bedrock_sem_chaves_e_marca_a_conta_da_zentriz():
    tent = fts._slot_cli_attempts({"llm_config": BEDROCK_SEM_CHAVE, "byoc_exempt": True})
    assert len(tent) == 1
    env, label = tent[0]
    assert env["CLAUDE_CODE_USE_BEDROCK"] == "1"
    assert env["AWS_REGION"] == env["AWS_DEFAULT_REGION"] == "us-west-2"
    assert "AWS_ACCESS_KEY_ID" not in env and "AWS_SECRET_ACCESS_KEY" not in env
    assert "conta da Zentriz (tenant byoc_exempt)" in label


def test_payload_sem_flag_ou_com_flag_nao_booleana_continua_recusado():
    for extra in ({}, {"byoc_exempt": False}, {"byoc_exempt": "true"}, {"byoc_exempt": 1}):
        skipped: list = []
        assert fts._slot_cli_attempts({"llm_config": BEDROCK_SEM_CHAVE, **extra}, skipped=skipped) == []
        assert "byoc_exempt" in skipped[0]


def test_full_test_payload_isento_monta_env_de_sandbox_sem_vazar_segredo_do_host(monkeypatch):
    for k, v in {"ANTHROPIC_API_KEY": "sk-host", "FTS_AUTH_TOKEN": "fts-host", "GITHUB_TOKEN": "gh-host",
                 "GENESIS_API_TOKEN": "adm-host", "AWS_ACCESS_KEY_ID": "AKIA_HOST",
                 "AWS_SECRET_ACCESS_KEY": "SEC_HOST", "CLAUDE_CODE_USE_BEDROCK": "1",
                 "ANTHROPIC_MODEL": "modelo-do-host"}.items():
        monkeypatch.setenv(k, v)
    tent = fts._slot_envs({"llm_config": BEDROCK_SEM_CHAVE, "byoc_exempt": True,
                           "model_id": "us.anthropic.claude-opus-5-5"},
                          "p1", "", "us.anthropic.claude-opus-5-5", "", "", com_wrappers=False)
    env, label = tent[0]
    assert label and env["CLAUDE_CODE_USE_BEDROCK"] == "1"
    assert env["ANTHROPIC_MODEL"] == "us.anthropic.claude-opus-5-5"  # do slot, não do host
    blob = json.dumps(env)
    for segredo in ("sk-host", "fts-host", "gh-host", "adm-host", "AKIA_HOST", "SEC_HOST"):
        assert segredo not in blob
    assert not [k for k in env if k.startswith(("GITHUB", "FTS_", "ANTHROPIC_API", "AWS_ACCESS", "AWS_SECRET",
                                                 "AWS_SESSION", "GENESIS_API"))]
