"""🔴 GAP-146 — o censo do prompt no caminho `/invoke/raw` (o mais caro da Bancada).

POR QUE ESTE ARQUIVO EXISTE: o censo do `runtime` (`build_user_message`) mediu ZERO chamadas em prod
com o laço rodando CTO. Causa: o caminho por-arquivo (`SPEC_CTO_EDIT_FORMAT=edits`, o dominante da
autonomia) monta o prompt na api e chama `/invoke/raw` com `prompt_override` + `user_message` já
prontos — `build_user_message` nunca é executado. A api passou a medir campo a campo na origem; aqui
se mede o TOTAL que sai, incluindo a única parte que a api não conhece: a lição anexada pelo CAG.

O que fica pinado:
  1. a linha existe e o total é `len(system) + len(user)` — a conta do provedor, não a do chamador;
  2. `cag=` mede o DELTA que o CAG acrescentou (0 quando não houve lição) — sem isso o censo da api
     passaria por conta inteira e a economia/despesa da lição seria invisível;
  3. o censo não derruba a chamada e não carrega conteúdo do prompt.
"""
import logging

import pytest


def _chamar(monkeypatch, body, cag_prefixo: str = ""):
    """Executa `invoke_raw` sem tocar em Bedrock. Devolve (resposta, system visto pelo modelo)."""
    from orchestrator.agents import runtime, server

    visto: dict[str, str] = {}

    def _fake_call(system, user, model_id, max_tokens, temperature, llm_cfg=None):
        visto["system"], visto["user"] = system, user
        return "ok"

    monkeypatch.setattr(runtime, "call_bedrock_direct", _fake_call)
    if cag_prefixo:
        monkeypatch.setattr(
            runtime, "_maybe_apply_cag_prefix",
            lambda system, *a, **k: cag_prefixo + system,
        )
    return server.invoke_raw(body), visto


def test_censo_mede_o_total_que_sai(monkeypatch, caplog):
    with caplog.at_level(logging.INFO):
        _chamar(monkeypatch, {"prompt_override": "S" * 400, "user_message": "U" * 9_000})
    linha = next(m for m in caplog.messages if "[prompt-census]" in m)
    assert "origem=invoke-raw" in linha
    assert "total=9400c" in linha and "system=400c" in linha and "user=9000c" in linha
    assert "cag=0c" in linha


def test_censo_isola_o_que_a_lição_do_CAG_acrescentou(monkeypatch, caplog):
    """A lição entra DEPOIS que a api montou o pedido: sem este delta, ela seria despesa anônima."""
    with caplog.at_level(logging.INFO):
        _, visto = _chamar(
            monkeypatch,
            {"prompt_override": "S" * 100, "user_message": "U" * 500,
             "cag": {"role": "CTO", "project_id": "spec_chat"}},
            cag_prefixo="L" * 2_000,
        )
    linha = next(m for m in caplog.messages if "[prompt-census]" in m)
    assert "cag=2000c" in linha
    assert "system=100c" in linha          # `system` é o de ANTES do CAG (o que a api conhece)
    assert "total=2600c" in linha          # e o total é o que o provedor cobra
    assert "role=CTO" in linha
    assert len(visto["system"]) == 2_100   # o prompt REAL levou a lição


def test_censo_nao_carrega_conteudo_do_prompt(monkeypatch, caplog):
    with caplog.at_level(logging.INFO):
        _chamar(monkeypatch, {"prompt_override": "sistema", "user_message": "SEGREDO-DO-CLIENTE"})
    linha = next(m for m in caplog.messages if "[prompt-census]" in m)
    assert "SEGREDO" not in linha


def test_body_incompleto_continua_400_e_nao_e_medido(monkeypatch, caplog):
    """O censo não vira a validação do endpoint: sem prompt, o erro é o mesmo de antes."""
    from fastapi import HTTPException
    with caplog.at_level(logging.INFO):
        with pytest.raises(HTTPException) as e:
            _chamar(monkeypatch, {"prompt_override": "", "user_message": "U"})
    assert e.value.status_code == 400
    assert not [m for m in caplog.messages if "[prompt-census]" in m]
