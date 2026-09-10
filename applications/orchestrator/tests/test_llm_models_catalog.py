"""
test_llm_models_catalog.py — ⚖️ Jean, 2026-09-10:
*"a lista de modelos disponíveis deve ser obtida de forma dinâmica baseado no provider e
credenciais informadas, daí carrega a lista de modelos disponíveis nos selects"*.

O que está travado aqui, e por que cada um nasceu de um defeito medido:

1. **Listar não é poder usar.** `list-inference-profiles` devolve os 87 ids como `ACTIVE` e o
   `InvokeModel` recusa 82 deles. Por isso o catálogo só entrega o que passou na INVOCAÇÃO real
   — com a credencial do slot, testada ao vivo em 2026-09-10 (5 utilizáveis de 87).
2. **Coerência entre listar e invocar.** Medido: com `provider=bedrock` e slot **sem credencial**,
   `resolve_provider` resolvia para o provider do ambiente (foundry) — a descoberta perguntava ao
   Bedrock e o probe invocava no Foundry, devolvendo 86 `DeploymentNotFound`. A lista ficava falsa
   e, pior, gastava a identidade do host (a LEI dos slots diz que o custo é do tenant). Agora esse
   caso lista sem verificar e DIZ que não verificou.
3. **Descoberta é conveniência, não bloqueio.** Provider que não lista (Foundry: `/v1/models` → 404
   mesmo com chave válida) cai no catálogo local com aviso — a tela nunca fica sem opção.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from orchestrator.agents import runtime  # noqa: E402


@pytest.fixture(autouse=True)
def _cache_limpo():
    runtime._MODELOS_CACHE.clear()
    yield
    runtime._MODELOS_CACHE.clear()


# ── discover_models ──────────────────────────────────────────────────────────────

def test_foundry_cai_no_catalogo_local_e_avisa():
    ids, origem, aviso = runtime.discover_models({"provider": "foundry", "foundry_api_key": "k"})
    assert origem == "catalog"
    assert "listagem" in aviso  # a tela precisa saber que ninguém confirmou esta lista
    assert "claude-opus-5" in ids


def test_falha_de_listagem_nao_propaga_e_vira_aviso(monkeypatch):
    def explode(_cfg):
        raise RuntimeError("ExpiredTokenException: chave expirada")
    monkeypatch.setattr(runtime, "_discover_bedrock", explode)
    ids, origem, aviso = runtime.discover_models(
        {"provider": "bedrock", "aws_access_key_id": "AKIA", "aws_secret_access_key": "s"})
    assert (ids, origem) == ([], "catalog")
    assert "não foi possível listar" in aviso


def test_aviso_de_listagem_nao_vaza_credencial(monkeypatch):
    def explode(_cfg):
        raise RuntimeError("falha usando a chave SEGREDO_DO_TENANT")
    monkeypatch.setattr(runtime, "_discover_bedrock", explode)
    _ids, _origem, aviso = runtime.discover_models(
        {"provider": "bedrock", "aws_secret_access_key": "SEGREDO_DO_TENANT"})
    assert "SEGREDO_DO_TENANT" not in aviso


# ── list_models_verified ─────────────────────────────────────────────────────────

def test_so_o_que_passou_na_invocacao_conta_como_utilizavel(monkeypatch):
    monkeypatch.setattr(runtime, "discover_models",
                        lambda _cfg: (["bom", "sem-direito"], "provider", ""))
    monkeypatch.setattr(runtime, "probe_slot",
                        lambda _cfg, m, **_k: {"ok": m == "bom", "kind": "" if m == "bom" else "auth",
                                               "message": "" if m == "bom" else "AccessDenied",
                                               "latency_ms": 10})
    out = runtime.list_models_verified({"provider": "bedrock", "aws_access_key_id": "AKIA"},
                                       usar_cache=False)
    assert (out["usable"], out["total"]) == (1, 2)
    # O reprovado permanece na lista COM o motivo: sumir esconderia o diagnóstico do operador.
    assert out["models"][0]["id"] == "bom"
    assert out["models"][1]["kind"] == "auth"


def test_provider_declarado_sem_credencial_lista_mas_nao_verifica(monkeypatch):
    """O caso que devolvia 86 `DeploymentNotFound` falsos."""
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "foundry")
    monkeypatch.setattr(runtime, "discover_models", lambda _cfg: (["us.anthropic.x"], "provider", ""))
    chamou = []
    monkeypatch.setattr(runtime, "probe_slot", lambda *a, **k: chamou.append(a) or {"ok": True})
    out = runtime.list_models_verified({"provider": "bedrock"}, usar_cache=False)
    assert chamou == []                     # nada foi invocado na identidade do host
    assert out["usable"] == 0
    assert out["models"][0]["kind"] == "config"   # "não verificado" ≠ "reprovado"
    assert "credencial" in out["warning"]


def test_com_credencial_propria_o_provider_declarado_manda(monkeypatch):
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "foundry")
    monkeypatch.setattr(runtime, "discover_models", lambda _cfg: (["us.anthropic.x"], "provider", ""))
    monkeypatch.setattr(runtime, "probe_slot", lambda _cfg, m, **_k: {"ok": True, "latency_ms": 5})
    out = runtime.list_models_verified(
        {"provider": "bedrock", "aws_access_key_id": "AKIA", "aws_secret_access_key": "s"},
        usar_cache=False)
    assert out["usable"] == 1


def test_cache_por_credencial_e_furado_pelo_refresh(monkeypatch):
    monkeypatch.setattr(runtime, "discover_models", lambda _cfg: (["m1"], "provider", ""))
    invocacoes = {"n": 0}

    def probe(_cfg, _m, **_k):
        invocacoes["n"] += 1
        return {"ok": True, "latency_ms": 1}
    monkeypatch.setattr(runtime, "probe_slot", probe)

    cfg = {"provider": "anthropic", "api_key": "sk-a"}
    assert runtime.list_models_verified(cfg)["cached"] is False
    assert runtime.list_models_verified(cfg)["cached"] is True
    assert invocacoes["n"] == 1                      # a 2ª abertura da tela não custa invocação
    # Trocar a credencial é OUTRA pergunta: o cache não pode responder pela chave antiga.
    assert runtime.list_models_verified({"provider": "anthropic", "api_key": "sk-b"})["cached"] is False
    assert invocacoes["n"] == 2
    # `refresh` (botão "reverificar") ignora o cache.
    assert runtime.list_models_verified(cfg, usar_cache=False)["cached"] is False
    assert invocacoes["n"] == 3


def test_chave_do_cache_nao_guarda_credencial_em_claro():
    chave = runtime._chave_cache_modelos({"api_key": "sk-SEGREDO"}, "anthropic")
    assert "sk-SEGREDO" not in chave and len(chave) == 64
