"""Revisor CROSS-FAMILY — o caminho de invocação de modelos NÃO-Claude (2026-09-07).

POR QUE ISTO EXISTE (pesquisa, não palpite): `arXiv:2609.04270` mede que auto-revisão da MESMA
família de modelo dá **zero** ganho de acurácia e rejeita **35%** do que estava certo, enquanto um
revisor **cross-family** mid-tier dá **+12 p.p.** com 2% de falso-rejeite. E `arXiv:2609.03230`
mede que o melhor modelo Anthropic acha a mediana de **47%** dos defeitos de requisito, errando
"almost always" os de necessidade e correção. O Genesis inteiro — CTO-editor, refutador e juiz de
promovibilidade — é Claude: somos a configuração que os papers medem como inútil para revisar a si
mesma.

O DEFEITO DE TRANSPORTE QUE ISTO FECHA: `call_bedrock_direct` fala o dialeto do SDK `anthropic`
(`AnthropicBedrock.messages.create`). Um `model_id` de outra família (Nova, Mistral, Llama, Qwen,
DeepSeek) é recusado pela rota do provedor — ou seja, mesmo com entitlement concedido na conta
(medido em 2026-09-07: 6 famílias não-Claude invocáveis na 820), NÃO HAVIA COMO CHAMÁ-LAS. O
caminho portável é a Converse API do Bedrock (boto3), que normaliza system/messages/inferenceConfig
para todos os provedores.

CONTRATO FIXADO AQUI:
  1. o roteamento é por `model_id` — nenhuma flag nova, e o caminho Claude fica byte-idêntico;
  2. credencial do tenant (BYOC) vence o env do container, igual ao caminho Claude;
  3. `stopReason` da Converse alimenta o MESMO `truncated` que o `/invoke/raw` publica — sem isso
     a Bancada aplicaria por cima do bom um parecer CORTADO (família T1/T2);
  4. falha na chamada PROPAGA. Sem fallback burro: o chamador registra "indecidível" e a crítica
     original continua de pé (ver `feedback-genesis-100-llm-nunca-automacao-fixa`).
"""
import pytest


# ── 1. roteamento por família ─────────────────────────────────────────────────

@pytest.mark.parametrize("model_id", [
    "us.anthropic.claude-opus-5",
    "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "claude-opus-5",          # apelido curto do Foundry
    "",                        # vazio cai no default Claude do chamador
])
def test_looks_anthropic_reconhece_as_tres_grafias(model_id):
    from orchestrator.agents.runtime import _looks_anthropic
    assert _looks_anthropic(model_id) is True


@pytest.mark.parametrize("model_id", [
    "amazon.nova-pro-v1:0",
    "amazon.nova-lite-v1:0",
    "mistral.mistral-large-3-675b-instruct",
    "qwen.qwen3-32b-v1:0",
    "deepseek.v3.2",
    "meta.llama3-70b-instruct-v1:0",
])
def test_looks_anthropic_rejeita_cross_family(model_id):
    """As 6 famílias com entitlement medido na conta 820 (2026-09-07) NÃO são Claude."""
    from orchestrator.agents.runtime import _looks_anthropic
    assert _looks_anthropic(model_id) is False


def test_call_bedrock_direct_roteia_nao_claude_para_converse(monkeypatch):
    """O defeito real: sem este desvio, `amazon.nova-pro-v1:0` ia para o SDK anthropic e MORRIA."""
    from orchestrator.agents import runtime

    visto: dict = {}

    def _fake_converse(**kw):
        visto.update(kw)
        return "resposta cross-family"

    monkeypatch.setattr(runtime, "_call_converse", _fake_converse)
    # Se o roteamento falhar, a chamada tenta abrir cliente Anthropic/Bedrock de verdade — o teste
    # quebraria por rede/credencial, não por assert. É justamente o sinal que queremos.
    out = runtime.call_bedrock_direct(system="S", user="U", model_id="amazon.nova-pro-v1:0",
                                     max_tokens=600, temperature=0.0)
    assert out == "resposta cross-family"
    assert visto["model_id"] == "amazon.nova-pro-v1:0"
    assert visto["system"] == "S" and visto["user"] == "U"
    assert visto["temperature"] == 0.0


# ── 2. credenciais: BYOC do tenant vence o env do container ───────────────────

def test_aws_creds_for_prefere_credencial_do_tenant(monkeypatch):
    from orchestrator.agents.runtime import _aws_creds_for
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "DO-CONTAINER")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "SEGREDO-CONTAINER")
    monkeypatch.setenv("AWS_REGION", "us-west-2")
    ak, sk, token, region = _aws_creds_for({
        "aws_access_key_id": "DO-TENANT", "aws_secret_access_key": "SEGREDO-TENANT",
        "aws_region": "sa-east-1",
    })
    assert (ak, sk, region) == ("DO-TENANT", "SEGREDO-TENANT", "sa-east-1")
    assert token == ""   # credencial estática do tenant não tem sessão


def test_aws_creds_for_cai_no_env_sem_config_do_tenant(monkeypatch):
    from orchestrator.agents.runtime import _aws_creds_for
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "DO-CONTAINER")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "SEGREDO-CONTAINER")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("GENESIS_AWS_REGION", raising=False)
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
    ak, sk, _token, region = _aws_creds_for(None)
    assert (ak, sk, region) == ("DO-CONTAINER", "SEGREDO-CONTAINER", "us-east-1")


def test_aws_creds_for_ignora_config_pela_metade(monkeypatch):
    """Meia credencial no `llm_config` (só a chave, sem o segredo) não pode SILENCIAR o env."""
    from orchestrator.agents.runtime import _aws_creds_for
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "DO-CONTAINER")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "SEGREDO-CONTAINER")
    ak, sk, _t, _r = _aws_creds_for({"aws_access_key_id": "DO-TENANT"})
    assert (ak, sk) == ("DO-CONTAINER", "SEGREDO-CONTAINER")


# ── 3. a chamada Converse: texto, usage e stopReason ─────────────────────────

class _FakeBedrock:
    def __init__(self, payload):
        self._payload = payload
        self.chamadas: list[dict] = []

    def converse(self, **kw):
        self.chamadas.append(kw)
        return self._payload


def _install_fake_boto3(monkeypatch, fake_client):
    import sys, types
    mod = types.ModuleType("boto3")
    mod.client = lambda service, **kw: fake_client            # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "boto3", mod)


def test_call_converse_extrai_texto_usage_e_stop_reason(monkeypatch):
    from orchestrator.agents import runtime

    fake = _FakeBedrock({
        "output": {"message": {"content": [{"text": '{"verdict":'}, {"text": '"ausente"}'}]}},
        "usage": {"inputTokens": 1234, "outputTokens": 56},
        "stopReason": "end_turn",
    })
    _install_fake_boto3(monkeypatch, fake)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AK")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "SK")

    out = runtime._call_converse(system="SYS", user="USR", model_id="amazon.nova-pro-v1:0",
                                max_tokens=600, temperature=0.0, usage_project_id=None,
                                usage_agent="cross_family_audit", llm_cfg=None, t0=0.0)
    assert out == '{"verdict":"ausente"}'          # blocos concatenados, nada perdido
    assert runtime.LAST_EFFECTIVE_MODEL.get() == "amazon.nova-pro-v1:0"
    assert runtime.LAST_USAGE.get() == {"input_tokens": 1234, "output_tokens": 56}
    assert runtime.LAST_STOP_REASON.get() == "end_turn"

    enviado = fake.chamadas[0]
    assert enviado["modelId"] == "amazon.nova-pro-v1:0"
    assert enviado["system"] == [{"text": "SYS"}]
    assert enviado["messages"] == [{"role": "user", "content": [{"text": "USR"}]}]
    assert enviado["inferenceConfig"] == {"maxTokens": 600, "temperature": 0.0}


def test_call_converse_publica_truncamento_com_o_mesmo_literal(monkeypatch):
    """`stopReason: max_tokens` tem de chegar CRU: é o literal que o `/invoke/raw` usa para
    marcar `truncated` e recusar parecer cortado (família T1/T2 — aplicar o mutilado por cima
    do bom). Traduzir aqui reintroduziria o defeito."""
    from orchestrator.agents import runtime

    fake = _FakeBedrock({
        "output": {"message": {"content": [{"text": "resposta cortada no meio"}]}},
        "usage": {"inputTokens": 10, "outputTokens": 600},
        "stopReason": "max_tokens",
    })
    _install_fake_boto3(monkeypatch, fake)
    runtime._call_converse(system="S", user="U", model_id="mistral.mistral-large-3-675b-instruct",
                          max_tokens=600, temperature=0.0, usage_project_id=None,
                          usage_agent="cross_family_review", llm_cfg=None, t0=0.0)
    assert runtime.LAST_STOP_REASON.get() == "max_tokens"


def test_call_converse_propaga_falha_sem_fallback_burro(monkeypatch):
    """Se o cross-family morre, ninguém "resolve" a acusação por conta própria: a exceção sobe e
    o chamador registra INDECIDÍVEL, mantendo a crítica original de pé."""
    from orchestrator.agents import runtime

    class _Boom:
        def converse(self, **_kw):
            raise RuntimeError("AccessDeniedException")

    _install_fake_boto3(monkeypatch, _Boom())
    with pytest.raises(RuntimeError, match="AccessDenied"):
        runtime._call_converse(system="S", user="U", model_id="deepseek.v3.2", max_tokens=600,
                               temperature=0.0, usage_project_id=None, usage_agent="x",
                               llm_cfg=None, t0=0.0)


def test_call_converse_aguenta_resposta_sem_blocos(monkeypatch):
    """Resposta 200 com content vazio é falha real (achado #30) — devolve "" para o `/invoke/raw`
    tratar como vazio, em vez de estourar KeyError e virar 500 sem diagnóstico."""
    from orchestrator.agents import runtime

    _install_fake_boto3(monkeypatch, _FakeBedrock({"output": {"message": {}}, "usage": {}}))
    out = runtime._call_converse(system="S", user="U", model_id="qwen.qwen3-32b-v1:0",
                                max_tokens=600, temperature=0.0, usage_project_id=None,
                                usage_agent="x", llm_cfg=None, t0=0.0)
    assert out == ""
