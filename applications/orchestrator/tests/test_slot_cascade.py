"""
test_slot_cascade.py — ⚖️ Jean, 2026-09-10:
*"todos devem usar identidade, credencial e modelos dos slots […] sempre testando se funciona e em
caso de nao funcionar testa o proximo, o ideal é testar no momento que é adicionado"*.

Três comportamentos travados aqui, cada um correspondendo a uma forma de o desenho dar errado:

1. **Não regredir.** Envelope sem `llm_candidates` ⇒ EXATAMENTE uma tentativa. A contingência é
   aditiva; se ela mudasse o caminho do corpo antigo, todo run existente teria mudado de
   comportamento junto.
2. **Só falha de SLOT cascateia.** Erro de pedido (prompt grande demais, resposta inválida) tentado
   noutro provider paga o dobro para receber o mesmo erro.
3. **Trocar de slot troca de CREDENCIAL.** É esse o ponto da LEI: a fatura é do tenant dono do slot
   que atendeu. Um candidato que herdasse a chave do anterior cobraria a conta errada.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from orchestrator.agents import runtime  # noqa: E402
from orchestrator.agents.server import _slot_cascade  # noqa: E402


# ── classify_llm_error / is_slot_failure ─────────────────────────────────────────

@pytest.mark.parametrize("msg,esperado", [
    ("AccessDeniedException: not authorized to perform bedrock:InvokeModel", "auth"),
    ("Error code: 401 - invalid_api_key", "auth"),
    ("ThrottlingException: Too many requests", "quota"),
    ("429 RESOURCE_EXHAUSTED", "quota"),
    ("404 model_not_found: the model does not exist", "model"),
    ("DeploymentNotFound", "model"),
    ("Connection timed out after 600s", "network"),
    ("provider=anthropic exige API Key no slot de LLM do tenant.", "config"),
    ("resposta truncada: o modelo devolveu JSON inválido", "other"),
])
def test_classificacao_do_erro(msg, esperado):
    assert runtime.classify_llm_error(msg) == esperado


def test_403_que_cita_model_continua_sendo_auth():
    """Um 403 quase sempre explica QUAL modelo foi negado. Classificar como `model` faria a cascata
    culpar o id e pular o slot certo — por isso credencial é avaliada antes de disponibilidade."""
    exc = Exception("403 AccessDenied: you don't have access to model us.anthropic.claude-opus-5")
    assert runtime.classify_llm_error(exc) == "auth"


def test_erro_de_pedido_nao_e_falha_de_slot():
    assert runtime.is_slot_failure("AccessDenied") is True
    assert runtime.is_slot_failure("prompt is too long: 300000 tokens > 200000") is False


# ── llm_candidates ───────────────────────────────────────────────────────────────

def test_corpo_antigo_produz_uma_unica_tentativa():
    """Sem o campo novo, a fila tem tamanho 1 — o comportamento de hoje, byte por byte."""
    cands = runtime.llm_candidates({
        "model_id": "claude-opus-5", "model_id_fallback": "claude-sonnet-5",
        "llm_config": {"provider": "foundry", "model": "claude-opus-5", "foundry_api_key": "k"},
    })
    assert len(cands) == 1
    assert cands[0]["model"] == "claude-opus-5"
    assert cands[0]["fallback"] == "claude-sonnet-5"


def test_fila_preserva_ordem_e_credencial_de_cada_slot():
    cands = runtime.llm_candidates({
        "model_id": "claude-opus-5",
        "llm_config": {"provider": "foundry", "model": "claude-opus-5", "foundry_api_key": "k1"},
        "llm_candidates": [
            {"provider": "foundry", "model": "claude-opus-5", "foundry_api_key": "k1"},
            {"provider": "bedrock", "model": "us.anthropic.claude-sonnet-5",
             "aws_access_key_id": "AKIA2", "model_rework": "us.anthropic.claude-haiku-4-5"},
        ],
    })
    # O 1º candidato É o slot escolhido — dedup por (modelo, provider) evita pagar o erro 2×.
    assert len(cands) == 2
    assert cands[1]["llm_cfg"]["provider"] == "bedrock"
    assert cands[1]["llm_cfg"]["aws_access_key_id"] == "AKIA2"
    assert cands[1]["fallback"] == "us.anthropic.claude-haiku-4-5"
    assert "foundry_api_key" not in cands[1]["llm_cfg"]


def test_candidato_sem_modelo_e_descartado():
    cands = runtime.llm_candidates({
        "model_id": "m1", "llm_config": {"provider": "bedrock", "model": "m1"},
        "llm_candidates": [{"provider": "google"}, "lixo", {"provider": "google", "model": "m2"}],
    })
    assert [c["model"] for c in cands] == ["m1", "m2"]


# ── _scrub_secrets ───────────────────────────────────────────────────────────────

def test_mensagem_de_erro_nunca_carrega_credencial():
    """O Google devolve a API key na URL do erro. Esta mensagem vai para a TELA e para o banco."""
    cfg = {"provider": "google", "model": "gemini-2.5-pro", "google_api_key": "AIzaSyABCDEFGH123"}
    sujo = "400 from https://api/v1?key=AIzaSyABCDEFGH123 — invalid key"
    limpo = runtime._scrub_secrets(sujo, cfg)
    assert "AIzaSyABCDEFGH123" not in limpo
    assert "***" in limpo
    # Provider e modelo NÃO são segredo — sem eles a mensagem não diz qual slot falhou.
    assert runtime._scrub_secrets("falha em gemini-2.5-pro", cfg) == "falha em gemini-2.5-pro"


# ── _slot_cascade ────────────────────────────────────────────────────────────────

def test_cascata_sem_contingencia_chama_a_funcao_uma_vez_com_a_MESMA_mensagem():
    msg = {"llm_config": {"provider": "foundry", "model": "claude-opus-5", "foundry_api_key": "k"}}
    vistos = []

    def fn(m):
        vistos.append(m)
        return {"ok": True}

    assert _slot_cascade(msg, fn) == {"ok": True}
    assert len(vistos) == 1
    assert vistos[0] is msg  # nem uma cópia: o caminho antigo não muda em nada


def test_cascata_avanca_no_slot_quebrado_e_leva_a_credencial_do_proximo():
    msg = {
        "llm_config": {"provider": "foundry", "model": "claude-opus-5", "foundry_api_key": "k1"},
        "llm_candidates": [
            {"provider": "foundry", "model": "claude-opus-5", "foundry_api_key": "k1"},
            {"provider": "bedrock", "model": "us.anthropic.claude-sonnet-5",
             "aws_access_key_id": "AKIA2", "aws_secret_access_key": "S2"},
        ],
    }
    vistos = []

    def fn(m):
        cfg = m["llm_config"]
        vistos.append(cfg)
        if cfg["provider"] == "foundry":
            raise Exception("401 invalid_api_key")
        return "resposta do slot 2"

    assert _slot_cascade(msg, fn) == "resposta do slot 2"
    assert [c["provider"] for c in vistos] == ["foundry", "bedrock"]
    assert vistos[1]["aws_access_key_id"] == "AKIA2"
    # A chave do slot 1 não pode viajar na tentativa 2 — seria fatura na conta errada.
    assert "foundry_api_key" not in vistos[1]


def test_erro_de_pedido_nao_queima_os_outros_slots():
    msg = {
        "llm_config": {"provider": "foundry", "model": "claude-opus-5", "foundry_api_key": "k1"},
        "llm_candidates": [
            {"provider": "foundry", "model": "claude-opus-5", "foundry_api_key": "k1"},
            {"provider": "bedrock", "model": "us.anthropic.claude-sonnet-5", "aws_access_key_id": "A"},
        ],
    }
    chamadas = []

    def fn(m):
        chamadas.append(m["llm_config"]["provider"])
        raise ValueError("prompt is too long: 400000 tokens")

    with pytest.raises(ValueError):
        _slot_cascade(msg, fn)
    assert chamadas == ["foundry"]  # parou no primeiro: o defeito é do pedido, não do slot


def test_ultimo_slot_propaga_o_erro_original():
    """Esgotada a fila, o erro que chega ao chamador é o do ÚLTIMO slot — não um genérico da
    cascata, que esconderia a causa real de quem for depurar."""
    msg = {
        "llm_config": {"provider": "foundry", "model": "m1", "foundry_api_key": "k1"},
        "llm_candidates": [
            {"provider": "foundry", "model": "m1", "foundry_api_key": "k1"},
            {"provider": "bedrock", "model": "m2", "aws_access_key_id": "A"},
        ],
    }

    def fn(m):
        raise Exception(f"403 AccessDenied em {m['llm_config']['provider']}")

    with pytest.raises(Exception, match="bedrock"):
        _slot_cascade(msg, fn)


# ── probe_slot ───────────────────────────────────────────────────────────────────

def test_probe_sem_modelo_ou_sem_provider_nao_chama_ninguem(monkeypatch):
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "")
    monkeypatch.setattr(runtime, "call_bedrock_direct",
                        lambda **kw: pytest.fail("não deveria chamar o provider"))
    r = runtime.probe_slot({"provider": "foundry"}, "")
    assert r["ok"] is False and r["kind"] == "config"
    r = runtime.probe_slot({}, "claude-opus-5")
    assert r["ok"] is False and r["kind"] == "config"


def test_probe_ok_quando_o_modelo_pedido_responde(monkeypatch):
    def fake(**kw):
        runtime.LAST_EFFECTIVE_MODEL.set(kw["model_id"])
        return "ok"
    monkeypatch.setattr(runtime, "call_bedrock_direct", fake)
    r = runtime.probe_slot({"provider": "foundry", "foundry_api_key": "k"}, "claude-opus-5")
    assert r["ok"] is True and r["kind"] == "" and r["model"] == "claude-opus-5"


def test_probe_reprova_quando_quem_respondeu_foi_o_fallback_da_plataforma(monkeypatch):
    """🔴 `call_bedrock_direct` tem cascata própria: sem comparar o modelo EFETIVO, um slot pedindo
    um modelo que a conta não serve receberia 200 (porque outro respondeu) e seria carimbado verde
    — exatamente o GOTCHA do entitlement do Bedrock."""
    def fake(**kw):
        runtime.LAST_EFFECTIVE_MODEL.set("us.anthropic.claude-sonnet-4-6")
        return "ok"
    monkeypatch.setattr(runtime, "call_bedrock_direct", fake)
    r = runtime.probe_slot({"provider": "bedrock", "aws_access_key_id": "A"},
                           "us.anthropic.claude-opus-4-8")
    assert r["ok"] is False
    assert r["kind"] == "model"
    assert r["effective_model"] == "us.anthropic.claude-sonnet-4-6"


def test_probe_classifica_a_falha_e_higieniza_a_mensagem(monkeypatch):
    def fake(**kw):
        raise Exception("401 invalid_api_key: sk-super-secreta-do-tenant")
    monkeypatch.setattr(runtime, "call_bedrock_direct", fake)
    r = runtime.probe_slot({"provider": "anthropic", "api_key": "sk-super-secreta-do-tenant"},
                           "claude-opus-5")
    assert r["ok"] is False and r["kind"] == "auth"
    assert "sk-super-secreta-do-tenant" not in r["message"]


def test_probe_nunca_lanca(monkeypatch):
    """O probe roda no caminho de SALVAR o slot: se lançasse, uma credencial ruim impediria o
    tenant de corrigir a configuração pela tela."""
    def fake(**kw):
        raise RuntimeError("boom inesperado")
    monkeypatch.setattr(runtime, "call_bedrock_direct", fake)
    r = runtime.probe_slot({"provider": "bedrock", "aws_access_key_id": "A"}, "m")
    assert r["ok"] is False and "latency_ms" in r
