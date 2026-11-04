"""T1 — `byoc_exempt` no roteamento do CLI do full-test-server (`_cli_env_from_slot`).

Regra (Jean): provedor, região e modelos vêm do SLOT; slot Bedrock SEM chave só usa a conta da
Zentriz (IMDS do host) quando o TENANT é `byoc_exempt` — decisão explícita (zentriz_admin) e auditável.
Tenant não isento segue fail-closed. Nenhuma chamada real ao Bedrock aqui."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("fts_byoc_s", ROOT / "scripts" / "full-test-server.py")
fts = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(fts)

SEM = {"provider": "bedrock", "model": "us.anthropic.claude-opus-5-5", "aws_region": "eu-west-1"}
COM = {**SEM, "aws_access_key_id": "AKIA_TENANT", "aws_secret_access_key": "SEC_TENANT"}


def test_isento_sem_chave_devolve_env_bedrock_sem_chaves_com_regiao_e_modelos_do_slot():
    env = fts._cli_env_from_slot(SEM, fallback_id="us.anthropic.claude-haiku-4-5", byoc_exempt=True)
    assert env["CLAUDE_CODE_USE_BEDROCK"] == "1"
    assert env["AWS_REGION"] == env["AWS_DEFAULT_REGION"] == "eu-west-1"
    assert env["ANTHROPIC_MODEL"] == env["CLAUDE_MODEL"] == "us.anthropic.claude-opus-5-5"
    assert env["ANTHROPIC_SMALL_FAST_MODEL"] == "us.anthropic.claude-haiku-4-5"
    assert not [k for k in env if k.startswith(("AWS_ACCESS", "AWS_SECRET", "AWS_SESSION", "AWS_PROFILE"))]


def test_isento_sem_regiao_usa_us_east_1():
    env = fts._cli_env_from_slot({"provider": "bedrock", "model": "m"}, byoc_exempt=True)
    assert env["AWS_REGION"] == "us-east-1"


def test_nao_isento_sem_chave_e_recusado_fail_closed():
    assert fts._cli_env_from_slot(SEM) is None
    assert fts._cli_env_from_slot(SEM, byoc_exempt=False) is None


@pytest.mark.parametrize("flag", ["true", 1, "1", None])
def test_so_true_estrito_isenta(flag):
    assert fts._cli_env_from_slot(SEM, byoc_exempt=flag) is None


@pytest.mark.parametrize("parcial", [{"aws_access_key_id": "AKIA"}, {"aws_secret_access_key": "S"},
                                     {"aws_session_token": "tok"}])
def test_chave_parcial_nao_e_isencao_mesmo_com_tenant_isento(parcial):
    assert fts._cli_env_from_slot({**SEM, **parcial}, byoc_exempt=True) is None


def test_com_chaves_do_slot_nada_muda_isento_ou_nao():
    a = fts._cli_env_from_slot(COM)
    b = fts._cli_env_from_slot(COM, byoc_exempt=True)
    assert a == b
    assert a["AWS_ACCESS_KEY_ID"] == "AKIA_TENANT" and a["AWS_SECRET_ACCESS_KEY"] == "SEC_TENANT"
    assert a["AWS_REGION"] == "eu-west-1"


def test_isencao_nao_vale_para_outros_providers():
    assert fts._cli_env_from_slot({"provider": "anthropic", "model": "claude-opus-5"}, byoc_exempt=True) is None
    assert fts._cli_env_from_slot({"provider": "foundry", "model": "claude-opus-5"}, byoc_exempt=True) is None


def test_motivo_do_nao_isento_manda_habilitar_byoc_exempt_ou_cadastrar_chaves():
    why = fts._slot_unusable_reason(SEM)
    assert "byoc_exempt" in why and "cadastre chaves" in why
    assert "PARCIAL" in fts._slot_unusable_reason({**SEM, "aws_access_key_id": "A"}, byoc_exempt=True)


def test_sandbox_slot_bound_nao_remove_o_necessario_e_remove_segredos_do_host(monkeypatch):
    for k, v in {"ANTHROPIC_API_KEY": "sk-host", "FTS_AUTH_TOKEN": "fts-host", "GITHUB_TOKEN": "gh-host",
                 "AWS_ACCESS_KEY_ID": "AKIA_HOST", "CLAUDE_CODE_USE_BEDROCK": "1",
                 "AWS_REGION": "sa-east-1", "ANTHROPIC_MODEL": "do-host"}.items():
        monkeypatch.setenv(k, v)
    slot = fts._cli_env_from_slot(SEM, byoc_exempt=True)
    env = fts._sanitized_base_env(slot_bound=True)
    env.update(slot)
    assert env["PATH"] and env["HOME"]                 # IMDS/SDK precisam de rede+HOME, nada mais
    assert env["AWS_REGION"] == "eu-west-1"            # do slot, não do host
    assert env["ANTHROPIC_MODEL"] == "us.anthropic.claude-opus-5-5"
    for k in ("ANTHROPIC_API_KEY", "FTS_AUTH_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID"):
        assert k not in env
