"""test_fts_slot_env.py — ⚖️ Jean, 2026-09-10:
*"todos devem usar identidade, credencial e modelos dos slots INCLUSIVE spawn_engineer, sempre
testando se funciona e em caso de nao funcionar testa o proximo"*.

O executor (`claude --dangerously-skip-permissions`) não recebe envelope como os agents — ele se
roteia por ENV. Por isso o vazamento aqui era invisível: o `model_id` do slot chegava, a sessão
rodava, o resultado vinha certo… e a fatura ia para a instance role da EC2 da Zentriz.

Três invariantes travadas neste arquivo:

1. **Com slot, nada do host sobrevive.** Principalmente `CLAUDE_CODE_USE_BEDROCK` — a variável que
   sozinha desvia a chamada para o IMDS do host.
2. **Sem slot, nada muda.** Chamador antigo continua com o env legado, byte por byte.
3. **Slot que não responde não roda.** Testa-se ANTES da sessão longa; reprovado, vai o próximo;
   nenhum aprovado, o job falha alto em vez de rodar de graça na conta errada.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("fts_slot", ROOT / "scripts" / "full-test-server.py")
fts = importlib.util.module_from_spec(spec); spec.loader.exec_module(fts)  # import-safe: main guard


BEDROCK = {"provider": "bedrock", "model": "us.anthropic.claude-opus-5",
           "aws_access_key_id": "AKIA_TENANT", "aws_secret_access_key": "SEGREDO_DO_TENANT",
           "aws_region": "us-west-2"}
FOUNDRY = {"provider": "foundry", "model": "claude-opus-5",
           "foundry_api_key": "chave-foundry-do-tenant", "foundry_resource": "tenant-resource"}


# ── _sanitized_base_env ──────────────────────────────────────────────────────────

def test_com_slot_o_roteamento_do_host_nao_sobrevive(monkeypatch):
    """🔴 O vazamento real: o host exporta `CLAUDE_CODE_USE_BEDROCK=1` e o CLI ignora a chave do
    tenant, indo pelo IMDS. Verde na tela, cobrado da Zentriz."""
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("ANTHROPIC_MODEL", "modelo-do-host")
    env = fts._sanitized_base_env(slot_bound=True)
    assert "CLAUDE_CODE_USE_BEDROCK" not in env
    assert "AWS_REGION" not in env
    assert "ANTHROPIC_MODEL" not in env
    assert env["PATH"] and env["HOME"]  # o resto do sandbox continua de pé


def test_sem_slot_o_caminho_legado_e_identico(monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_USE_BEDROCK", raising=False)
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
    env = fts._sanitized_base_env()
    assert env["CLAUDE_CODE_USE_BEDROCK"] == "1"
    assert env["AWS_REGION"] == "us-east-1"


def test_sandbox_com_slot_mantem_token_escopado_e_wrappers(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    slot = fts._cli_env_from_slot(BEDROCK)
    env = fts._build_cyborg_sandbox_env("p1", "prod1", "modelo-de-outro-slot", "tok-escopado",
                                        slot_env=slot)
    assert env["GENESIS_API_TOKEN"] == "tok-escopado"
    assert "cyborg-wrappers" in env["PATH"] or env["PATH"].startswith("/opt/hostb")
    # O `model_id` do argumento é de OUTRO slot — quem manda é o envelope desta tentativa.
    assert env["ANTHROPIC_MODEL"] == "us.anthropic.claude-opus-5"
    assert env["AWS_ACCESS_KEY_ID"] == "AKIA_TENANT"
    assert env["AWS_REGION"] == "us-west-2"


# ── _cli_env_from_slot ───────────────────────────────────────────────────────────

def test_bedrock_do_slot_leva_chave_regiao_e_modelo():
    env = fts._cli_env_from_slot(BEDROCK, fallback_id="us.anthropic.claude-haiku-4-5")
    assert env["CLAUDE_CODE_USE_BEDROCK"] == "1"
    assert env["AWS_SECRET_ACCESS_KEY"] == "SEGREDO_DO_TENANT"
    assert env["ANTHROPIC_MODEL"] == env["CLAUDE_MODEL"] == "us.anthropic.claude-opus-5"
    # O modelo "pequeno e rápido" do CLI também tem de existir na conta DO TENANT.
    assert env["ANTHROPIC_SMALL_FAST_MODEL"] == "us.anthropic.claude-haiku-4-5"


def test_bedrock_sem_credencial_propria_e_recusado():
    """Sem chave no slot, `CLAUDE_CODE_USE_BEDROCK=1` significa 'use a identidade do host' — que é
    exatamente a fatura que a LEI proíbe. Melhor pular o slot do que cobrar a conta errada."""
    assert fts._cli_env_from_slot({"provider": "bedrock", "model": "m"}) is None


def test_anthropic_e_foundry_montam_o_roteamento_certo():
    a = fts._cli_env_from_slot({"provider": "anthropic", "model": "claude-opus-5", "api_key": "sk-x"})
    assert a["ANTHROPIC_API_KEY"] == a["CLAUDE_API_KEY"] == "sk-x"
    assert "CLAUDE_CODE_USE_BEDROCK" not in a

    f = fts._cli_env_from_slot(FOUNDRY)
    assert f["CLAUDE_CODE_USE_FOUNDRY"] == "1"
    assert f["ANTHROPIC_FOUNDRY_RESOURCE"] == "tenant-resource"
    assert f["ANTHROPIC_FOUNDRY_API_KEY"] == "chave-foundry-do-tenant"

    assert fts._cli_env_from_slot({"provider": "foundry", "model": "m",
                                   "foundry_api_key": "k"}) is None  # sem resource nem base


def test_vertex_materializa_a_service_account_em_arquivo_600(tmp_path):
    sa = json.dumps({"type": "service_account", "private_key": "-----BEGIN..."})
    env = fts._cli_env_from_slot(
        {"provider": "google", "model": "claude-opus-5", "vertex_project_id": "proj-x",
         "vertex_location": "us-east5", "vertex_service_account_json": sa},
        creds_dir=str(tmp_path))
    p = Path(env["GOOGLE_APPLICATION_CREDENTIALS"])
    assert env["CLAUDE_CODE_USE_VERTEX"] == "1" and env["ANTHROPIC_VERTEX_PROJECT_ID"] == "proj-x"
    assert p.read_text() == sa
    # Segredo do tenant em disco no host não-confiável: só o dono lê.
    assert oct(os.stat(p).st_mode & 0o777) == "0o600"


@pytest.mark.parametrize("slot", [
    {"provider": "google", "model": "gemini-2.5-pro", "google_api_key": "AIza"},   # outro protocolo
    {"provider": "openai", "model": "gpt-4o", "api_key": "sk-o"},
    {"provider": "azure_openai", "model": "gpt-4o", "api_key": "k", "azure_endpoint": "https://x"},
])
def test_provider_que_o_cli_nao_fala_e_pulado_nao_derruba(slot):
    """Estes slots continuam válidos para Bancada/Fábrica — só não dirigem o executor."""
    assert fts._cli_env_from_slot(slot) is None


# ── _slot_cli_attempts / _slot_envs ──────────────────────────────────────────────

def test_fila_respeita_ordem_do_tenant_e_descarta_o_inutilizavel():
    tentativas = fts._slot_cli_attempts({
        "llm_config": FOUNDRY, "model_id": "claude-opus-5", "model_id_fallback": "claude-sonnet-5",
        "llm_candidates": [FOUNDRY,                                   # duplicata do escolhido
                           {"provider": "openai", "model": "gpt-4o"}, # não dirige o CLI
                           BEDROCK],
    })
    assert [r for _, r in tentativas] == ["foundry/claude-opus-5", "bedrock/us.anthropic.claude-opus-5"]
    assert tentativas[0][0]["ANTHROPIC_SMALL_FAST_MODEL"] == "claude-sonnet-5"
    # Cada tentativa carrega SÓ a credencial do seu slot.
    assert "ANTHROPIC_FOUNDRY_API_KEY" not in tentativas[1][0]


def test_payload_sem_slot_produz_exatamente_uma_tentativa_legada(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    tent = fts._slot_envs({}, "p1", "", "modelo", "tok", "")
    assert len(tent) == 1 and tent[0][1] == ""
    assert tent[0][0]["CLAUDE_CODE_USE_BEDROCK"] == "1"  # comportamento de hoje, intacto


def test_payload_com_slot_inutilizavel_nao_cai_no_host():
    """Fail-closed: tinha slot, nenhum serve ⇒ fila vazia ⇒ o job falha dizendo o motivo."""
    assert fts._slot_envs({"llm_config": {"provider": "openai", "model": "gpt-4o"}},
                          "p1", "", "m", "tok", "") == []


# ── higienização e classificação ─────────────────────────────────────────────────

def test_erro_do_cli_nunca_carrega_a_credencial_do_tenant():
    env = fts._cli_env_from_slot(BEDROCK)
    sujo = "AccessDenied for AKIA_TENANT using SEGREDO_DO_TENANT"
    limpo = fts._scrub_cli_secrets(sujo, env)
    assert "SEGREDO_DO_TENANT" not in limpo and "AKIA_TENANT" not in limpo
    assert "AccessDenied" in limpo  # a causa continua legível


@pytest.mark.parametrize("texto,esperado", [
    ("AccessDeniedException: not authorized", "auth"),
    ("API error 429: too many requests", "quota"),
    ("model_not_found: claude-opus-5", "model"),
    ("connect ECONNREFUSED 10.0.0.1:443", "network"),
    ("Error: build failed with 3 type errors", ""),
])
def test_classificacao_separa_falha_de_slot_de_falha_do_trabalho(texto, esperado):
    assert fts._classify_cli_failure(texto) == esperado


# ── cascata ──────────────────────────────────────────────────────────────────────

def _cascata(monkeypatch, payload, probes, execucoes):
    """Roda a cascata com probe/execução falsos. `probes`/`execucoes` são dicts por rótulo."""
    chamados = []

    def _probe(_bin, env, _cwd, timeout=120):
        rot = env.get("ANTHROPIC_MODEL", "")
        chamados.append(("probe", rot))
        return probes.get(rot, (True, ""))

    def _run(_cmd, _cwd, env, _entrada, _timeout):
        rot = env.get("ANTHROPIC_MODEL", "")
        chamados.append(("run", rot))
        return execucoes.get(rot, {"ok": True, "stdout": "CYBORG_DONE", "stderr": "",
                                   "rc": 0, "duration_s": 3})

    monkeypatch.setattr(fts, "_probe_cli_slot", _probe)
    monkeypatch.setattr(fts, "_run_claude_cli", _run)
    code, body = fts._rodar_com_cascata_de_slots(
        payload, "proj-1234", "", "claude-opus-5", "tok", "", "/bin/claude", ["/bin/claude"],
        "/tmp", "prompt", 60, tag="teste")
    return code, body, chamados


DOIS_SLOTS = {"llm_config": FOUNDRY, "model_id": "claude-opus-5", "llm_candidates": [FOUNDRY, BEDROCK]}


def test_slot_reprovado_no_teste_cede_a_vez_ao_proximo(monkeypatch):
    code, body, chamados = _cascata(
        monkeypatch, DOIS_SLOTS,
        probes={"claude-opus-5": (False, "401 invalid api key")}, execucoes={})
    assert code == 200
    assert body["llm_slot"] == "bedrock/us.anthropic.claude-opus-5"
    assert body["llm_slots_descartados"] == ["foundry/claude-opus-5: 401 invalid api key"]
    # A sessão longa NÃO rodou no slot ruim — é esse o ponto de testar antes.
    assert chamados == [("probe", "claude-opus-5"), ("probe", "us.anthropic.claude-opus-5"),
                        ("run", "us.anthropic.claude-opus-5")]


def test_nenhum_slot_aprovado_falha_alto_em_vez_de_rodar_na_conta_da_zentriz(monkeypatch):
    code, body, chamados = _cascata(
        monkeypatch, DOIS_SLOTS,
        probes={"claude-opus-5": (False, "401"), "us.anthropic.claude-opus-5": (False, "403")},
        execucoes={})
    assert code == 502
    assert len(body["llm_slots_descartados"]) == 2
    assert not [c for c in chamados if c[0] == "run"]


def test_sessao_que_ja_produziu_saida_nao_e_repetida_noutro_slot(monkeypatch):
    """Repetir uma sessão que já mexeu no repositório duplicaria commits e queimaria outra
    janela de 60 min pelo mesmo defeito. Cascata pós-execução só quando morreu na largada."""
    code, body, chamados = _cascata(
        monkeypatch, DOIS_SLOTS, probes={},
        execucoes={"claude-opus-5": {"ok": True, "stdout": "editei 3 arquivos e falhei",
                                     "stderr": "429 quota", "rc": 1, "duration_s": 900}})
    assert code == 200 and body["llm_slot"] == "foundry/claude-opus-5"
    assert [c for c in chamados if c[0] == "run"] == [("run", "claude-opus-5")]


def test_slot_que_morre_na_largada_cede_a_vez(monkeypatch):
    code, body, chamados = _cascata(
        monkeypatch, DOIS_SLOTS, probes={},
        execucoes={"claude-opus-5": {"ok": True, "stdout": "", "stderr": "ThrottlingException",
                                     "rc": 1, "duration_s": 2}})
    assert code == 200 and body["llm_slot"] == "bedrock/us.anthropic.claude-opus-5"
    assert body["llm_slots_descartados"] == ["foundry/claude-opus-5: quota"]


def test_caminho_legado_nao_testa_nada_e_roda_como_antes(monkeypatch):
    code, body, chamados = _cascata(monkeypatch, {}, probes={}, execucoes={})
    assert code == 200 and body["llm_slot"] == ""
    assert not [c for c in chamados if c[0] == "probe"]
