"""
test_lei_slots_python.py — LEI 2026-09-10 no lado Python (Fase 3).

Jean: *"nao podemos mais usar hard-code para injetar provide X ou Y e nem Modelos"* e
*"para que os custos de LLM seja do Tenant nao da Zentriz"*.

O que os testes abaixo travam — cada um corresponde a um vazamento MEDIDO no código antigo:

1. `_get_model_for_role` devolvia `"claude-sonnet-4-6"` por omissão: um modelo escolhido pela
   Zentriz, cobrado em quem estivesse rodando. Hoje devolve `""` e o chamador falha alto.
2. `GENESIS_LLM_PROVIDER` tinha default `"anthropic"` — provider por omissão da plataforma.
3. O Cyborg era o ÚNICO plano 100% env: `CYBORG_V3_MODEL` com literal `us.anthropic.claude-opus-4-8`
   e NENHUMA consulta a `tenant_llm_configs`. Agora nasce do slot e leva o envelope inteiro
   (provider + credencial) em toda chamada a `/invoke/raw`.
4. `spec_validator` caía em `"us.anthropic.claude-sonnet-4-6"` fora do Foundry — ignorando o slot.

⚠️ Fora de alcance por desenho: o `spawn_engineer` do Cyborg despacha para o executor (FTS), que
roda o `claude` CLI com a identidade DO HOST. Esse caminho não passa por slot nenhum — está
declarado como o último vazamento aberto, não coberto aqui.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from orchestrator.agents import runtime  # noqa: E402
from orchestrator import cyborg_v3, spec_validator  # noqa: E402


# ── 1/2. runtime: sem literal de modelo nem de provider ──────────────────────────

_MODEL_ENVS = ("CLAUDE_MODEL", "CLAUDE_MODEL_SPEC", "CLAUDE_MODEL_CODE", "PIPELINE_LLM_MODEL")


@pytest.mark.parametrize("role", ["CTO", "ENGINEER", "PM", "DEV", "QA", ""])
def test_sem_env_nenhum_papel_tem_modelo_default(monkeypatch, role):
    """Nenhum papel inventa modelo: sem slot transportado, a resposta é vazio (⇒ falha alto)."""
    for var in _MODEL_ENVS:
        monkeypatch.delenv(var, raising=False)
    assert runtime._get_model_for_role(role) == ""


def test_o_modelo_do_papel_vem_do_env_do_run_que_e_o_transporte_do_slot(monkeypatch):
    """O env continua sendo lido — é como o `runner_server` entrega o slot ao processo do run."""
    for var in _MODEL_ENVS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("CLAUDE_MODEL", "gemini-3-pro")
    assert runtime._get_model_for_role("DEV") == "gemini-3-pro"
    # O específico do papel vence o genérico (continua valendo).
    monkeypatch.setenv("CLAUDE_MODEL_CODE", "claude-opus-5")
    assert runtime._get_model_for_role("DEV") == "claude-opus-5"


def test_resolve_provider_sem_slot_e_sem_env_nao_devolve_anthropic(monkeypatch):
    """O default `"anthropic"` do env sumiu: sem declaração, provider é vazio (⇒ falha alto)."""
    monkeypatch.delenv("GENESIS_LLM_PROVIDER", raising=False)
    env_provider = os.environ.get("GENESIS_LLM_PROVIDER", "").strip().lower()
    assert env_provider == ""
    assert runtime.resolve_provider({}, env_provider) == ""


# ── 3. Cyborg: o envelope do slot viaja em TODA chamada ──────────────────────────

_SLOT_RESP = {
    "ok": True, "provider": "bedrock", "modelId": "us.anthropic.claude-opus-5",
    "fallbackModelId": "us.anthropic.claude-sonnet-5",
    "awsAccessKeyId": "AKIA-DO-TENANT", "awsSecretAccessKey": "sec-do-tenant",
    "awsRegion": "us-east-1",
}


def test_cyborg_resolve_provider_modelo_e_credencial_do_slot(monkeypatch):
    monkeypatch.setattr(cyborg_v3, "_http", lambda *a, **k: (200, json.dumps(_SLOT_RESP)))
    env = cyborg_v3._resolve_slot_llm("proj-1")
    assert env["model_id"] == "us.anthropic.claude-opus-5"
    assert env["model_id_fallback"] == "us.anthropic.claude-sonnet-5"
    # 3º eixo da lei: a CREDENCIAL é do tenant, não a do container.
    assert env["llm_config"]["aws_access_key_id"] == "AKIA-DO-TENANT"
    assert env["llm_config"]["provider"] == "bedrock"


def test_cyborg_sem_slot_utilizavel_falha_alto_em_vez_de_usar_o_env(monkeypatch):
    """422 é a resposta nova da api quando não há slot — antes virava "usando env atual"."""
    monkeypatch.setattr(cyborg_v3, "_http", lambda *a, **k: (422, '{"code":"LLM_SLOT_NOT_CONFIGURED"}'))
    with pytest.raises(RuntimeError) as e:
        cyborg_v3._resolve_slot_llm("proj-1")
    assert "Configurações → LLM" in str(e.value)


def test_cyborg_manda_credencial_do_slot_no_corpo_do_invoke_raw():
    """Antes só o `model_id` viajava: a chamada rodava na identidade do container."""
    token = cyborg_v3._SLOT_LLM.set({
        "model_id": "us.anthropic.claude-opus-5",
        "model_id_fallback": "us.anthropic.claude-sonnet-5",
        "llm_config": {"provider": "bedrock", "aws_access_key_id": "AKIA-DO-TENANT"},
    })
    try:
        campos = cyborg_v3._slot_body_fields()
        assert campos["llm_config"]["aws_access_key_id"] == "AKIA-DO-TENANT"
        assert campos["model_id"] == "us.anthropic.claude-opus-5"
        assert campos["model_id_fallback"] == "us.anthropic.claude-sonnet-5"
        # Um modelo explícito (escalonamento de rework) sobrepõe só o modelo — a credencial fica.
        escalado = cyborg_v3._slot_body_fields("us.anthropic.claude-sonnet-5")
        assert escalado["model_id"] == "us.anthropic.claude-sonnet-5"
        assert escalado["llm_config"]["aws_access_key_id"] == "AKIA-DO-TENANT"
    finally:
        cyborg_v3._SLOT_LLM.reset(token)


def test_cyborg_v3_model_nao_tem_literal_de_modelo():
    """O default `us.anthropic.claude-opus-4-8` era a Zentriz escolhendo Opus na fatura alheia."""
    assert cyborg_v3.V3_MODEL == "" or os.environ.get("CYBORG_V3_MODEL")


def test_cyborg_pede_o_slot_MAIS_FORTE_e_nao_o_primeiro_da_fila(monkeypatch):
    """⚖️ Jean 2026-09-10: *"cyborg usa sempre o melhor modelo entre os cadastrados nos slots"*.

    Quem escolhe é o api-node; o que se trava aqui é o Cyborg PEDIR a estratégia certa — sem o
    `?strategy=strongest` ele continuaria recebendo o slot de prioridade 0, que é o critério da
    Bancada/Fábrica (a ordem do tenant), não o do engenheiro final.
    """
    vistos: dict = {}

    def _spy(method, url, body=None, timeout=60):
        vistos["url"] = url
        return 200, json.dumps({
            **_SLOT_RESP,
            "selection": {"strategy": "strongest", "why": "mais forte entre 2 slots",
                          "slotModels": ["claude-haiku-4-5", "us.anthropic.claude-opus-5"]},
        })

    monkeypatch.setattr(cyborg_v3, "_http", _spy)
    env = cyborg_v3._resolve_slot_llm("proj-1")
    assert "strategy=strongest" in vistos["url"]
    # A auditoria da escolha viaja junto — sem credencial nenhuma.
    assert env["selection_why"] == "mais forte entre 2 slots"
    assert env["slot_models"] == ["claude-haiku-4-5", "us.anthropic.claude-opus-5"]


# ── 4. spec_validator: sem o Sonnet literal ──────────────────────────────────────

def test_spec_validator_sem_modelo_declarado_falha_alto(monkeypatch):
    for var in ("SPEC_VALIDATOR_MODEL", "CLAUDE_MODEL", "GENESIS_LLM_PROVIDER"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(ValueError) as e:
        spec_validator.validate_spec("# Uma spec qualquer\n\nconteúdo", model_id="")
    assert "Configurações → LLM" in str(e.value)


# ── 5. call_bedrock_direct: o caminho MAIS QUENTE ignorava a credencial do slot ──
#
# 🔴 Achado MEDIDO na validação e2e (2026-09-10), e que NENHUM teste pegava: o ramo Foundry de
# `call_bedrock_direct` era escolhido por `os.environ["GENESIS_LLM_PROVIDER"]` e construía o
# cliente com `_build_foundry_client()` — SEM o envelope. Prova ao vivo: chave real no contêiner
# + chave BOGUS no `llm_config` devolveu **200**. Ou seja: a credencial do tenant era descartada e
# o consumo de `/invoke/raw`, splitter, spec_validator e Cyborg ia inteiro para a conta da Zentriz.

def test_call_bedrock_direct_usa_a_credencial_do_SLOT_e_nao_a_do_container(monkeypatch):
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "foundry")
    monkeypatch.setenv("ANTHROPIC_FOUNDRY_API_KEY", "CHAVE-DO-CONTAINER")
    monkeypatch.setenv("ANTHROPIC_FOUNDRY_RESOURCE", "recurso-do-container")

    vistos: dict = {}

    def _spy(llm_cfg=None):
        vistos["llm_cfg"] = llm_cfg
        raise RuntimeError("parar aqui — só interessa QUAL credencial chegou")

    monkeypatch.setattr(runtime, "_build_foundry_client", _spy)
    with pytest.raises(RuntimeError):
        runtime.call_bedrock_direct(
            system="s", user="u", model_id="claude-opus-5", max_tokens=16,
            llm_cfg={"provider": "foundry", "foundry_api_key": "CHAVE-DO-TENANT",
                     "foundry_resource": "recurso-do-tenant"},
        )
    assert vistos["llm_cfg"] is not None, "o envelope do slot não chegou ao cliente Foundry"
    assert vistos["llm_cfg"]["foundry_api_key"] == "CHAVE-DO-TENANT"


def test_call_bedrock_direct_roteia_pelo_provider_do_SLOT_nao_pelo_env(monkeypatch):
    """Env diz `foundry`; o slot do tenant é `google`. Quem decide o destino é o slot.

    Antes o env vencia: um tenant com slot Google entrava no ramo Foundry (que só serve Claude)
    ou caía no ramo Bedrock/Converse — que sem credencial no envelope autentica pela identidade
    DO HOST. Nos dois casos a conta debitada não era a do tenant.
    """
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "foundry")
    monkeypatch.setattr(runtime, "_build_foundry_client",
                        lambda *a, **k: pytest.fail("roteou para Foundry apesar do slot ser Google"))
    monkeypatch.setattr(runtime, "_build_google_client",
                        lambda cfg, model: ("CHAVE-GOOGLE-DO-TENANT", "https://base/"))

    capturado: dict = {}

    def _fake_openai(system, user, model, max_tokens, api_key="", base_url="", client=None, timeout=900):
        capturado.update({"api_key": api_key, "model": model})
        return "resposta", 10, 5

    monkeypatch.setattr(runtime, "_call_openai_compatible_raw", _fake_openai)
    out = runtime.call_bedrock_direct(
        system="s", user="u", model_id="gemini-3-pro", max_tokens=16,
        llm_cfg={"provider": "google", "google_api_key": "CHAVE-GOOGLE-DO-TENANT"},
    )
    assert out == "resposta"
    assert capturado["api_key"] == "CHAVE-GOOGLE-DO-TENANT"
    assert capturado["model"] == "gemini-3-pro"
