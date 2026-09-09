"""🔴 GAP-142 — cache de prompt: medir antes, marcar depois, e nunca mentir sobre o que foi medido.

MEDIDO EM PROD (3 dias, `project_agent_metrics`): 168.376.931 tokens de ENTRADA contra ~8,5 M de
saída — razão 20:1. O custo do cérebro da Bancada é dominado por REENVIAR texto, não por gerar. E
71% dessa entrada chegava a menos de 5 min da chamada anterior do mesmo agente no mesmo projeto,
isto é, DENTRO do TTL do cache de prompt do Bedrock. Mesmo assim não havia uma única ocorrência de
`cache_control`/`cachePoint` em todo o `applications/orchestrator`.

DUAS ETAPAS, para não trocar suposição por suposição:
  1. INSTRUMENTO — `_cache_tokens` lê leitura/escrita de cache nos dois dialetos (SDK `anthropic` e
     Converse) e o POST /agent-metrics passa a carregá-los. Contrato: campo ausente → chave OMITIDA
     → coluna NULL ("o provedor não reportou"); presente valendo 0 → 0 ("medi, não houve cache").
     Colapsar os dois em 0 seria afirmar medição onde não houve (mesma lei do `truncated[]`).
  2. MARCAÇÃO — só onde o prefixo repete de fato. Escrita de cache custa 1,25× a entrada: marcar um
     prefixo que não repete é REGRESSÃO. Por isso `cache_prefix` é opt-in do chamador, e o
     `spec_validator` só o liga quando `SPEC_VALIDATOR_VOTES > 1` (N refutações com system+user
     idênticos, em série — o único prefixo do cérebro que repete byte a byte).

E cache é otimização: se a rota recusar o parâmetro, a chamada REENVIA sem cache em vez de morrer.
"""
import json
import sys
import types

import pytest


# ── 1. o instrumento: NULL ≠ 0 ────────────────────────────────────────────────

class _UsageSDK:
    def __init__(self, r=None, w=None):
        self.input_tokens, self.output_tokens = 100, 10
        self.cache_read_input_tokens = r
        self.cache_creation_input_tokens = w


def test_cache_tokens_le_o_dialeto_do_sdk_anthropic():
    from orchestrator.agents.runtime import _cache_tokens
    assert _cache_tokens(_UsageSDK(r=8000, w=0)) == {"cacheReadTokens": 8000, "cacheWriteTokens": 0}


def test_cache_tokens_le_o_dialeto_da_converse():
    from orchestrator.agents.runtime import _cache_tokens
    assert _cache_tokens({"cacheReadInputTokens": 5, "cacheWriteInputTokens": 7}) == {
        "cacheReadTokens": 5, "cacheWriteTokens": 7,
    }


def test_cache_tokens_omite_o_que_o_provedor_nao_reportou():
    """A distinção que faz o relatório de economia ser honesto: ausente → NULL, nunca 0."""
    from orchestrator.agents.runtime import _cache_tokens
    assert _cache_tokens(_UsageSDK()) == {}          # provedor não reportou nada
    assert _cache_tokens({}) == {}
    assert _cache_tokens(None) == {}
    # só um dos dois reportado → só um viaja
    assert _cache_tokens({"cacheReadInputTokens": 0}) == {"cacheReadTokens": 0}


def test_cache_tokens_nunca_deixa_passar_negativo():
    """Mesmo racional da migration 070 (denial-of-wallet): negativo distorceria o relatório."""
    from orchestrator.agents.runtime import _cache_tokens
    assert _cache_tokens({"cacheReadInputTokens": -5}) == {"cacheReadTokens": 0}


def test_report_direct_usage_carrega_o_cache_medido(monkeypatch):
    """O instrumento só serve se CHEGAR ao medidor: sem isto, marcar cache não seria provável."""
    from orchestrator.agents import runtime

    capturado: dict = {}

    class _FakeThread:
        def __init__(self, target=None, daemon=None):
            self._t = target

        def start(self):
            self._t()

    import urllib.request as _rq
    monkeypatch.setattr(runtime.threading, "Thread", _FakeThread)
    monkeypatch.setattr(_rq, "urlopen", lambda req, timeout=0: types.SimpleNamespace(
        read=lambda: capturado.setdefault("body", json.loads(req.data.decode())) and b"{}"))
    monkeypatch.setenv("API_BASE_URL", "http://api:3000")
    monkeypatch.setenv("GENESIS_API_TOKEN", "tok")

    runtime._report_direct_usage("proj-1234", "spec_validator", "m", 100, 10, 500,
                                cache={"cacheReadTokens": 90, "cacheWriteTokens": 0})
    assert capturado["body"]["cacheReadTokens"] == 90
    assert capturado["body"]["cacheWriteTokens"] == 0

    # Sem cache reportado, as chaves NÃO viajam (o servidor grava NULL = não medido).
    capturado.clear()
    runtime._report_direct_usage("proj-1234", "spec_validator", "m", 100, 10, 500)
    assert "cacheReadTokens" not in capturado["body"]
    assert capturado["body"]["inputTokens"] == 100      # o contrato antigo segue intacto


# ── 2. a chave de desligamento e o reconhecimento de recusa ───────────────────

def test_cache_desligavel_por_env_sem_deploy(monkeypatch):
    from orchestrator.agents.runtime import _prompt_cache_enabled
    monkeypatch.delenv("GENESIS_PROMPT_CACHE", raising=False)
    assert _prompt_cache_enabled() is True             # default LIGADO
    for v in ("0", "false", "off", "NO"):
        monkeypatch.setenv("GENESIS_PROMPT_CACHE", v)
        assert _prompt_cache_enabled() is False


@pytest.mark.parametrize("msg", [
    "ValidationException: The model does not support cache_control",
    "cachePoint blocks are not supported for this model",
    "prompt caching is not enabled for this account",
])
def test_reconhece_recusa_de_cache(msg):
    from orchestrator.agents.runtime import _is_cache_param_error
    assert _is_cache_param_error(Exception(msg)) is True


def test_nao_confunde_throttle_com_recusa_de_cache():
    """Se qualquer erro virasse "recusa de cache", um throttle seria pago DUAS vezes."""
    from orchestrator.agents.runtime import _is_cache_param_error
    assert _is_cache_param_error(Exception("ThrottlingException: rate exceeded")) is False
    assert _is_cache_param_error(Exception("AccessDeniedException")) is False


# ── 3. Converse (cross-family): cachePoint como BLOCO, e recuo sem cache ──────

class _FakeBedrock:
    def __init__(self, payload, falhar_com_cache=False):
        self._payload, self._falhar = payload, falhar_com_cache
        self.chamadas: list[dict] = []

    def converse(self, **kw):
        self.chamadas.append(kw)
        tem_cache = any("cachePoint" in b for b in kw.get("system") or [])
        if self._falhar and tem_cache:
            raise Exception("ValidationException: cachePoint not supported")
        return self._payload


def _fake_boto3(monkeypatch, client):
    mod = types.ModuleType("boto3")
    mod.client = lambda service, **kw: client          # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "boto3", mod)


_PAYLOAD = {"output": {"message": {"content": [{"text": "ok"}]}},
            "usage": {"inputTokens": 10, "outputTokens": 2, "cacheReadInputTokens": 9},
            "stopReason": "end_turn"}


def test_converse_marca_cachepoint_no_system_e_no_user(monkeypatch):
    from orchestrator.agents import runtime
    fake = _FakeBedrock(_PAYLOAD)
    _fake_boto3(monkeypatch, fake)
    monkeypatch.delenv("GENESIS_PROMPT_CACHE", raising=False)

    out = runtime._call_converse(system="S", user="U", model_id="amazon.nova-pro-v1:0",
                                max_tokens=100, temperature=0.0, usage_project_id=None,
                                usage_agent="cross_family_audit", llm_cfg=None, t0=0.0,
                                cache_prefix=True)
    assert out == "ok"
    env = fake.chamadas[0]
    assert env["system"] == [{"text": "S"}, {"cachePoint": {"type": "default"}}]
    assert env["messages"][0]["content"] == [{"text": "U"}, {"cachePoint": {"type": "default"}}]


def test_converse_sem_cache_prefix_e_byte_identico_ao_de_antes(monkeypatch):
    """O caminho antigo não pode mudar de forma: quem não pede cache manda o MESMO corpo."""
    from orchestrator.agents import runtime
    fake = _FakeBedrock(_PAYLOAD)
    _fake_boto3(monkeypatch, fake)
    runtime._call_converse(system="S", user="U", model_id="amazon.nova-pro-v1:0",
                          max_tokens=100, temperature=0.0, usage_project_id=None,
                          usage_agent="x", llm_cfg=None, t0=0.0)
    assert fake.chamadas[0]["system"] == [{"text": "S"}]
    assert fake.chamadas[0]["messages"] == [{"role": "user", "content": [{"text": "U"}]}]


def test_converse_recua_sem_cache_quando_a_rota_recusa(monkeypatch):
    """Cache é otimização: um modelo que não o suporta não pode derrubar o revisor cross-family —
    ele é a TESTEMUNHA do juiz (GAP-106). Perde-se a economia, não o parecer."""
    from orchestrator.agents import runtime
    fake = _FakeBedrock(_PAYLOAD, falhar_com_cache=True)
    _fake_boto3(monkeypatch, fake)
    out = runtime._call_converse(system="S", user="U", model_id="amazon.nova-pro-v1:0",
                                max_tokens=100, temperature=0.0, usage_project_id=None,
                                usage_agent="cross_family_audit", llm_cfg=None, t0=0.0,
                                cache_prefix=True)
    assert out == "ok"
    assert len(fake.chamadas) == 2                       # 1ª com cache (recusada), 2ª sem
    assert fake.chamadas[1]["system"] == [{"text": "S"}]


def test_converse_nao_reenvia_quando_a_falha_nao_e_de_forma(monkeypatch):
    from orchestrator.agents import runtime

    class _Throttle:
        def __init__(self):
            self.n = 0

        def converse(self, **kw):
            self.n += 1
            raise Exception("ThrottlingException: rate exceeded")

    t = _Throttle()
    _fake_boto3(monkeypatch, t)
    with pytest.raises(Exception):
        runtime._call_converse(system="S", user="U", model_id="amazon.nova-pro-v1:0",
                              max_tokens=100, temperature=0.0, usage_project_id=None,
                              usage_agent="x", llm_cfg=None, t0=0.0, cache_prefix=True)
    assert t.n == 1                                       # pagou UMA vez, não duas


# ── 4. caminho Claude (SDK anthropic): blocos com cache_control + guarda ──────

class _FakeMessages:
    def __init__(self, dono):
        self._dono = dono

    def create(self, **kw):
        self._dono.chamadas.append(kw)
        if self._dono.recusar_cache and isinstance(kw.get("system"), list):
            raise Exception("ValidationException: cache_control is not supported")
        return types.SimpleNamespace(
            usage=_UsageSDK(r=7, w=0), content=[types.SimpleNamespace(type="text", text="RESP")],
            stop_reason="end_turn")


class _FakeAnthropic:
    def __init__(self, recusar_cache=False):
        self.chamadas: list[dict] = []
        self.recusar_cache = recusar_cache
        self.messages = _FakeMessages(self)


def _fake_anthropic_sdk(monkeypatch, client):
    mod = types.ModuleType("anthropic")
    mod.AnthropicBedrock = lambda **kw: client          # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "anthropic", mod)


def _env_bedrock(monkeypatch):
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "bedrock")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AK")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "SK")
    monkeypatch.delenv("GENESIS_API_TOKEN", raising=False)
    monkeypatch.delenv("GENESIS_PROMPT_CACHE", raising=False)


def test_claude_marca_cache_control_no_system_e_no_user(monkeypatch):
    """Dois breakpoints (system e user) em vez de um: o system é estável mesmo quando o lote muda,
    então quando o user virar, o system ainda acerta o cache."""
    from orchestrator.agents import runtime
    cli = _FakeAnthropic()
    _fake_anthropic_sdk(monkeypatch, cli)
    _env_bedrock(monkeypatch)

    out = runtime.call_bedrock_direct(system="SYS", user="USR",
                                      model_id="us.anthropic.claude-sonnet-4-6",
                                      max_tokens=2000, cache_prefix=True)
    assert out == "RESP"
    kw = cli.chamadas[0]
    assert kw["system"] == [{"type": "text", "text": "SYS", "cache_control": {"type": "ephemeral"}}]
    assert kw["messages"] == [{"role": "user", "content": [
        {"type": "text", "text": "USR", "cache_control": {"type": "ephemeral"}}]}]


def test_claude_sem_cache_prefix_mantem_o_corpo_antigo(monkeypatch):
    from orchestrator.agents import runtime
    cli = _FakeAnthropic()
    _fake_anthropic_sdk(monkeypatch, cli)
    _env_bedrock(monkeypatch)
    runtime.call_bedrock_direct(system="SYS", user="USR",
                               model_id="us.anthropic.claude-sonnet-4-6", max_tokens=2000)
    assert cli.chamadas[0]["system"] == "SYS"
    assert cli.chamadas[0]["messages"] == [{"role": "user", "content": "USR"}]


def test_claude_recua_sem_cache_quando_a_rota_recusa(monkeypatch):
    from orchestrator.agents import runtime
    cli = _FakeAnthropic(recusar_cache=True)
    _fake_anthropic_sdk(monkeypatch, cli)
    _env_bedrock(monkeypatch)
    out = runtime.call_bedrock_direct(system="SYS", user="USR",
                                      model_id="us.anthropic.claude-sonnet-4-6",
                                      max_tokens=2000, cache_prefix=True)
    assert out == "RESP"
    assert len(cli.chamadas) == 2
    assert cli.chamadas[1]["system"] == "SYS"             # reenviou em texto puro


def test_kill_switch_impede_a_marcacao(monkeypatch):
    from orchestrator.agents import runtime
    cli = _FakeAnthropic()
    _fake_anthropic_sdk(monkeypatch, cli)
    _env_bedrock(monkeypatch)
    monkeypatch.setenv("GENESIS_PROMPT_CACHE", "0")
    runtime.call_bedrock_direct(system="SYS", user="USR",
                               model_id="us.anthropic.claude-sonnet-4-6",
                               max_tokens=2000, cache_prefix=True)
    assert cli.chamadas[0]["system"] == "SYS"
