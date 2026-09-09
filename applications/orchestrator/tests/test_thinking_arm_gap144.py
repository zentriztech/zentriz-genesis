"""🔴 GAP-144 — raciocínio estendido do juiz: de fé para BRAÇO MEDIDO.

O que estava errado não era a decisão de desligar o raciocínio — ela foi MEDIDA (achado #51: no
Foundry o `text_stream` descarta blocos de raciocínio e o JSON saía cortado). Errado era ela valer
para TODA chamada, inclusive a única onde raciocínio paga mais (refutar), sem que ninguém pudesse
ligar e conferir. E o recall do nosso juiz foi medido em 43%..57%, com `sutil` em 20%..40% e
`fora_do_vocabulario` em 0%: há cegueira de sobra para o raciocínio atacar.

Cada teste aqui guarda uma forma MEDIDA de o braço B virar um braço FALSO:
  * ligar por env e o caminho não honrar (Foundry / Converse) → o A/B compararia dois juízes iguais;
  * ligar sem subir o teto de saída → o raciocínio come o JSON e o "resultado" é o achado #51;
  * ligar e a API exigir `temperature = 1` → 400 sobre temperatura num lugar onde ninguém procuraria;
  * ligar para o estágio B inteiro → triagem (teto 800) e consolidação (6.000) cortariam o JSON;
  * um `"false"` de TEXTO no corpo da requisição virando `True` → o braço A rodaria como braço B.
"""
import json
import sys
import types

import pytest


# ── 1. o transporte: `_thinking_extra` e o opt-in por chamada ─────────────────

def test_thinking_extra_segue_desligado_por_padrao(monkeypatch):
    from orchestrator.agents.runtime import _thinking_extra
    monkeypatch.delenv("GENESIS_DISABLE_THINKING", raising=False)
    monkeypatch.delenv("GENESIS_FOUNDRY_DISABLE_THINKING", raising=False)
    assert _thinking_extra() == {"thinking": {"type": "disabled"}}
    assert _thinking_extra("foundry") == {"thinking": {"type": "disabled"}}
    assert _thinking_extra("bedrock") == {"thinking": {"type": "disabled"}}


def test_thinking_extra_opt_in_liga_ADAPTATIVO_e_nunca_enabled(monkeypatch):
    """`thinking.type = "enabled"` dá 400 nos modelos Claude 5 — só `adaptive`|`disabled` existem."""
    from orchestrator.agents.runtime import _thinking_extra
    monkeypatch.delenv("GENESIS_DISABLE_THINKING", raising=False)
    assert _thinking_extra("bedrock", opt_in=True) == {"thinking": {"type": "adaptive"}}
    # e o opt-in do chamador vence o env que desliga (é o braço B pedindo explicitamente)
    monkeypatch.setenv("GENESIS_DISABLE_THINKING", "1")
    assert _thinking_extra("bedrock", opt_in=True) == {"thinking": {"type": "adaptive"}}


def test_thinking_extra_env_ainda_reverte_sem_deploy(monkeypatch):
    """A reversão que já existia não pode ter sido perdida no caminho."""
    from orchestrator.agents.runtime import _thinking_extra
    monkeypatch.setenv("GENESIS_DISABLE_THINKING", "0")
    assert _thinking_extra() == {}
    monkeypatch.delenv("GENESIS_DISABLE_THINKING", raising=False)
    monkeypatch.setenv("GENESIS_FOUNDRY_DISABLE_THINKING", "0")
    assert _thinking_extra("foundry") == {}
    assert _thinking_extra("bedrock") == {"thinking": {"type": "disabled"}}


# ── 2. `call_bedrock_direct`: honra no Bedrock/Claude, DECLARA onde ignora ────

class _Msg:
    def __init__(self):
        self.content = [types.SimpleNamespace(type="text", text='{"findings":[]}')]
        self.usage = types.SimpleNamespace(input_tokens=10, output_tokens=2)
        self.stop_reason = "end_turn"


_AUSENTE = object()


class _Messages:
    def __init__(self, sink):
        self.sink = sink

    # `temperature` NOMEADO de propósito: o runtime só o envia quando a assinatura do SDK o aceita
    # (o SDK >= 1.x removeu o parâmetro). O sentinela deixa o teste distinguir "não enviado" de 0.2.
    def create(self, *, temperature=_AUSENTE, **kw):
        self.sink.append(kw if temperature is _AUSENTE else {**kw, "temperature": temperature})
        return _Msg()


def _fake_anthropic(monkeypatch, sink):
    """Injeta um SDK `anthropic` falso — `call_bedrock_direct` importa dentro da função."""
    class _Client:
        def __init__(self, **kw):
            self.messages = _Messages(sink)

    mod = types.ModuleType("anthropic")
    mod.AnthropicBedrock = _Client            # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "anthropic", mod)


def _ambiente_bedrock(monkeypatch):
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "bedrock")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AK")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "SK")
    monkeypatch.delenv("CLAUDE_MODEL_FALLBACK", raising=False)
    monkeypatch.delenv("GENESIS_DISABLE_THINKING", raising=False)
    from orchestrator.agents import runtime
    monkeypatch.setattr(runtime, "_report_direct_usage", lambda *a, **k: None)
    monkeypatch.setattr(runtime, "_sink_usage", lambda *a, **k: None)
    return runtime


def test_bedrock_com_thinking_manda_adaptive_e_forca_temperature_1(monkeypatch):
    """Raciocínio estendido exige `temperature = 1`: sem isto o braço B morre com 400."""
    sink: list = []
    runtime = _ambiente_bedrock(monkeypatch)
    _fake_anthropic(monkeypatch, sink)
    out = runtime.call_bedrock_direct("S", "U", "us.anthropic.claude-opus-5",
                                      max_tokens=64000, temperature=0.2, thinking=True)
    assert out == '{"findings":[]}'
    assert sink[0]["thinking"] == {"type": "adaptive"}
    assert sink[0]["temperature"] == 1.0


def test_bedrock_sem_thinking_e_byte_identico_ao_de_antes(monkeypatch):
    """Quem não pede o braço B tem de continuar mandando exatamente o corpo antigo."""
    sink: list = []
    runtime = _ambiente_bedrock(monkeypatch)
    _fake_anthropic(monkeypatch, sink)
    runtime.call_bedrock_direct("S", "U", "us.anthropic.claude-opus-5",
                                max_tokens=8000, temperature=0.2)
    assert sink[0]["thinking"] == {"type": "disabled"}
    assert sink[0]["temperature"] == 0.2
    assert sink[0]["system"] == "S"


def test_foundry_ignora_thinking_e_DECLARA_em_log(monkeypatch, caplog):
    """Achado #51: no Foundry o `text_stream` descarta os blocos de raciocínio. Ignorar em silêncio
    faria o A/B atribuir ao raciocínio um resultado que rodou sem ele."""
    sink: list = []
    runtime = _ambiente_bedrock(monkeypatch)
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "foundry")
    monkeypatch.setattr(runtime, "_build_foundry_client",
                        lambda: types.SimpleNamespace(messages=_Messages(sink)))
    with caplog.at_level("WARNING"):
        runtime.call_bedrock_direct("S", "U", "opus-5", max_tokens=8000, thinking=True)
    assert sink[0]["thinking"] == {"type": "disabled"}      # NÃO ligou
    assert "IGNORADO" in caplog.text and "text_stream" in caplog.text


def test_converse_ignora_thinking_e_DECLARA_em_log(monkeypatch, caplog):
    """Cada família não-Claude expõe raciocínio por um campo próprio; o dialeto do Anthropic daria 400."""
    runtime = _ambiente_bedrock(monkeypatch)
    visto: dict = {}
    monkeypatch.setattr(runtime, "_call_converse", lambda **kw: visto.update(kw) or "ok")
    with caplog.at_level("WARNING"):
        out = runtime.call_bedrock_direct("S", "U", "amazon.nova-pro-v1:0", max_tokens=4000,
                                          thinking=True)
    assert out == "ok"
    assert "thinking" not in visto                          # não vaza para a Converse
    assert "IGNORADO" in caplog.text and "Converse" in caplog.text


# ── 3. o refutador: só ELE ganha raciocínio, e com o teto subido ──────────────

def test_thinking_enabled_le_env_e_aceita_override_explicito(monkeypatch):
    from orchestrator.spec_validator import _thinking_enabled
    monkeypatch.delenv("SPEC_VALIDATOR_THINKING", raising=False)
    assert _thinking_enabled() is False
    for v in ("1", "on", "true", "TRUE"):
        monkeypatch.setenv("SPEC_VALIDATOR_THINKING", v)
        assert _thinking_enabled() is True
    # o pedido por requisição vence o env nos DOIS sentidos (senão não há braço A com env ligado)
    assert _thinking_enabled(False) is False
    monkeypatch.delenv("SPEC_VALIDATOR_THINKING", raising=False)
    assert _thinking_enabled(True) is True


def test_teto_de_saida_dobra_com_thinking(monkeypatch):
    """Os tokens de raciocínio contam contra `max_tokens`: ligar sem subir o teto REPETE o achado #51."""
    from orchestrator.spec_validator import _refuter_max_tokens
    monkeypatch.delenv("SPEC_VALIDATOR_MAX_TOKENS", raising=False)
    assert _refuter_max_tokens("us.anthropic.claude-opus-5") == 32000
    assert _refuter_max_tokens("us.anthropic.claude-opus-5", thinking=True) == 64000
    # modelo antigo (teto 4.000) sobe para 32.000, nunca para 8.000 — o raciocínio comeria o JSON
    assert _refuter_max_tokens("us.anthropic.claude-3-haiku", thinking=True) == 32000
    # e o env continua tendo a palavra final (reversível sem deploy)
    monkeypatch.setenv("SPEC_VALIDATOR_MAX_TOKENS", "12000")
    assert _refuter_max_tokens("us.anthropic.claude-opus-5", thinking=True) == 12000


def test_thinking_vai_SO_ao_refutador_nunca_a_triagem_nem_a_consolidacao(monkeypatch):
    """Triagem tem teto de 800 e consolidação de 6.000 — raciocínio ali cortaria o JSON."""
    from orchestrator.spec_validator import validate_spec, REFUTER_SYSTEM, TRIAGE_SYSTEM
    monkeypatch.setenv("SPEC_VALIDATOR_TRIAGE_MODEL", "amazon.nova-pro-v1:0")
    monkeypatch.setenv("SPEC_VALIDATOR_VOTES", "2")   # traz a CONSOLIDAÇÃO (teto 6.000) para a prova
    calls: list = []

    def llm(system, user, model_id, **kw):
        calls.append({"system": system, **kw})
        if system == TRIAGE_SYSTEM:
            return json.dumps({"suspects": []})
        return json.dumps({"findings": []})

    validate_spec("## Spec\ncorpo", llm_fn=llm, thinking=True)
    refutador = [c for c in calls if c["system"] == REFUTER_SYSTEM]
    outros = [c for c in calls if c["system"] != REFUTER_SYSTEM]
    assert refutador and all(c.get("thinking") is True for c in refutador)
    assert all(c["max_tokens"] >= 32000 for c in refutador)
    assert all(c.get("thinking") in (None, False) for c in outros)
    assert all(c["max_tokens"] < 32000 for c in outros)


def test_sem_pedido_o_refutador_segue_sem_raciocinio(monkeypatch):
    from orchestrator.spec_validator import validate_spec, REFUTER_SYSTEM
    monkeypatch.delenv("SPEC_VALIDATOR_THINKING", raising=False)
    calls: list = []

    def llm(system, user, model_id, **kw):
        calls.append({"system": system, **kw})
        return json.dumps({"findings": []})

    validate_spec("## Spec\ncorpo", llm_fn=llm)
    assert all(c.get("thinking") in (None, False) for c in calls)


# ── 4. a borda HTTP: só um BOOLEANO decide o braço ───────────────────────────

@pytest.mark.parametrize("valor,esperado", [
    (True, True), (False, False),
    ("false", None), ("true", None), (None, None), (1, None), ("", None),
])
def test_server_so_aceita_booleano_explicito_para_escolher_o_braco(monkeypatch, valor, esperado):
    """Um `"false"` de texto é verdadeiro em Python: se ele escolhesse o braço, o A/B compararia o
    mesmo juiz consigo mesmo e o relatório afirmaria um braço que não rodou."""
    from orchestrator.agents import server
    import orchestrator.spec_validator as sv

    visto: dict = {}
    monkeypatch.setattr(sv, "validate_spec",
                        lambda spec_text, **kw: visto.update(kw) or {"findings": []})
    server._run_spec_validator_async("job-1", {"spec_text": "## Spec", "thinking": valor})
    assert visto["thinking"] is esperado
