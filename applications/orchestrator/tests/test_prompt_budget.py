"""
Orçamento de contexto do prompt (2026-09-05) — `_prompt_budget`, `_clip` e integração
em `build_user_message`.

Origem: spec de 39.907 chars chegava cortada em 30.000 ao CTO, em silêncio
(`runtime.py`, `spec_raw[:30000]`). Plano: `project/docs/plans/AGENTES-ORCAMENTO-DE-CONTEXTO-2026-09-05.md`.

Cada teste aqui fecha um GAP nomeado da revisão adversarial (§4 do plano).
"""
import pytest

from orchestrator.agents.runtime import (
    _PROMPT_FIELD_FLOORS,
    _clip,
    _prompt_budget,
    build_user_message,
)
from orchestrator.envelope import validate_response_quality

OPUS5 = "us.anthropic.claude-opus-5"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Nenhum override de ambiente vaza entre testes."""
    for var in ("AGENT_PROMPT_BUDGET", "AGENT_PROMPT_SPEC_CHARS", "AGENT_PROMPT_TOTAL_CHARS"):
        monkeypatch.delenv(var, raising=False)


# ── GAP-1/2: o cap sai do max_output, não da janela ───────────────────────────

def test_opus5_cap_muito_acima_do_teto_antigo():
    b = _prompt_budget(OPUS5)
    # (64.000 - 8.000) * 4 * 0,65 = 145.600
    assert b["spec_raw"] == 145_600
    assert b["spec_raw"] > _PROMPT_FIELD_FLOORS["spec_raw"] * 4


def test_campos_secundarios_escalam_pelo_mesmo_fator():
    b = _prompt_budget(OPUS5)
    k = b["spec_raw"] / _PROMPT_FIELD_FLOORS["spec_raw"]
    for field, floor in _PROMPT_FIELD_FLOORS.items():
        assert b[field] == int(floor * k)


# ── GAP-4: modelo desconhecido / Haiku NUNCA regride ─────────────────────────

@pytest.mark.parametrize("model", ["", "modelo-que-nao-existe", "anthropic.claude-haiku-4-5"])
def test_piso_garantido_sem_regressao(model):
    b = _prompt_budget(model)
    for field, floor in _PROMPT_FIELD_FLOORS.items():
        assert b[field] >= floor, f"{model} regrediu em {field}"


def test_haiku_max_output_pequeno_cai_no_piso():
    # Haiku 4.5: max_output 8.192 → (8.192-8.000)*4*0,65 = 499 → piso 30.000
    b = _prompt_budget("us.anthropic.claude-haiku-4-5-20251001-v1:0")
    assert b["spec_raw"] == _PROMPT_FIELD_FLOORS["spec_raw"]


# ── GAP-5: Foundry/OpenAI tem tabela própria ──────────────────────────────────

def test_modelo_foundry_usa_tabela_openai():
    from orchestrator.agents.runtime import _OPENAI_MODEL_LIMITS, _model_limits_for

    modelo = next(iter(_OPENAI_MODEL_LIMITS))
    assert _model_limits_for(modelo) is _OPENAI_MODEL_LIMITS[modelo]
    assert _prompt_budget(modelo)["spec_raw"] >= _PROMPT_FIELD_FLOORS["spec_raw"]


def test_o3_mini_max_output_grande_eleva_o_cap():
    # o3-mini: max_output 100.000 → cap bem acima do piso
    if "o3-mini" in __import__("orchestrator.agents.runtime", fromlist=["x"])._OPENAI_MODEL_LIMITS:
        assert _prompt_budget("o3-mini")["spec_raw"] > 200_000


# ── GAP-11: janela de 1M não pode virar orçamento global absurdo ──────────────

def test_teto_absoluto_do_orcamento_global():
    for model in (OPUS5, "us.anthropic.claude-opus-4-8[1m]", "gpt-4.1"):
        assert _prompt_budget(model)["_total"] <= 400_000


def test_global_nunca_desce_abaixo_do_piso_historico(monkeypatch):
    """Mesmo com override absurdo, `spec_raw` recebe ao menos os 30.000 de hoje."""
    monkeypatch.setenv("AGENT_PROMPT_TOTAL_CHARS", "1000")
    assert _prompt_budget(OPUS5)["_total"] == _PROMPT_FIELD_FLOORS["spec_raw"]


# ── GAP-3 (o mais perigoso): o marcador não pode ser lido como truncamento ────

def test_marcador_de_corte_nao_tem_reticencias():
    out = _clip("x" * 100, 10, "spec_raw", OPUS5)
    assert "[CORTE DE CONTEXTO]" in out
    assert "..." not in out
    assert "…" not in out


def test_marcador_informa_os_numeros_reais():
    out = _clip("x" * 1000, 400, "spec_raw", OPUS5)
    assert "400 de 1000" in out
    assert "600 omitidos" in out


def test_marcador_e_aprovado_pelo_detector_de_truncamento():
    """Se o modelo copiar o marcador para um artefato, NÃO pode disparar repair.

    Foi um repair de ~19 min de Opus 5 que estourou o teto do job em 2026-09-04.
    """
    marcado = _clip("# Spec\n\n" + ("conteúdo real da seção. " * 200), 2000, "spec_raw", OPUS5)
    response = {
        "request_id": "req-1",
        "status": "OK",
        "summary": "spec normalizada com o conteúdo recebido",
        "artifacts": [{"path": "docs/spec/PRODUCT_SPEC.md", "content": marcado}],
        "evidence": ["revisão da spec"],
        "next_actions": {"owner": "PM", "items": [], "questions": []},
    }
    ok, errors = validate_response_quality("CTO", response)
    assert ok, errors


def test_nao_corta_quando_cabe():
    texto = "y" * 100
    assert _clip(texto, 100, "spec_raw") == texto
    assert _clip(texto, 500, "spec_raw") == texto


# ── GAP-8: flag off ⇒ prompt BYTE-IDÊNTICO ao comportamento antigo ────────────

# Sentinelas raras: letras comuns (S/P/C) também aparecem no texto fixo do prompt e
# contaminariam a contagem.
_SPEC, _PROD, _CHARTER, _BACKLOG, _ENG = "¤", "þ", "ø", "ð", "æ"


def _msg_grande():
    return {
        "task": "normalizar",
        "mode": "spec_intake_and_normalize",
        "inputs": {
            "spec_raw": _SPEC * 50_000,
            "product_spec": _PROD * 40_000,   # diferente de spec_raw → sem dedupe
            "charter": _CHARTER * 30_000,
            "backlog": _BACKLOG * 30_000,
            "engineer_proposal": _ENG * 30_000,
        },
    }


def test_flag_off_reproduz_os_tetos_historicos(monkeypatch):
    monkeypatch.setenv("AGENT_PROMPT_BUDGET", "off")
    out = build_user_message(_msg_grande(), role="CTO", model=OPUS5)
    assert "[CORTE DE CONTEXTO]" not in out
    assert out.count(_SPEC) == 30_000
    assert out.count(_PROD) == 20_000
    assert out.count(_CHARTER) == 15_000
    assert out.count(_BACKLOG) == 15_000
    assert out.count(_ENG) == 15_000


def test_flag_off_ignora_o_modelo(monkeypatch):
    """Com a flag off o prompt não pode variar por modelo."""
    monkeypatch.setenv("AGENT_PROMPT_BUDGET", "off")
    msg = _msg_grande()
    assert build_user_message(msg, role="CTO", model=OPUS5) == build_user_message(
        msg, role="CTO", model="modelo-inventado"
    )


def test_ordem_dos_blocos_preservada():
    """A ordem histórica (Engineer → Charter → Backlog) não muda com o orçamento ligado."""
    out = build_user_message(_msg_grande(), role="CTO", model=OPUS5)
    assert (
        out.index("## Proposta do Engineer")
        < out.index("## Project Charter")
        < out.index("## Backlog")
    )


def test_sem_model_cai_nos_pisos():
    """Chamador antigo (sem `model`) mantém o comportamento de antes."""
    out = build_user_message(_msg_grande(), role="CTO")
    assert out.count(_SPEC) == _PROMPT_FIELD_FLOORS["spec_raw"]


# ── Caso real do Jean: spec de 39.907 chars passa inteira ─────────────────────

def test_spec_de_39907_chars_chega_inteira_ao_cto():
    spec = "# Spec NVX LastMile\n" + ("x" * (39_907 - 20))
    assert len(spec) == 39_907
    out = build_user_message(
        {"task": "revisar", "mode": "spec_intake_and_normalize", "inputs": {"spec_raw": spec}},
        role="CTO",
        model=OPUS5,
    )
    assert "[CORTE DE CONTEXTO]" not in out
    assert spec in out


def test_spec_acima_do_cap_e_cortada_COM_marcador():
    out = build_user_message(
        {"inputs": {"spec_raw": "x" * 200_000}}, role="CTO", model=OPUS5
    )
    assert "[CORTE DE CONTEXTO]" in out
    assert "145600 de 200000" in out


# ── GAP-9: dedupe só em igualdade/prefixo ─────────────────────────────────────

def test_dedupe_quando_product_spec_e_igual_a_spec_raw():
    spec = "# Spec\n" + "z" * 5_000
    out = build_user_message(
        {"inputs": {"spec_raw": spec, "product_spec": spec}}, role="CTO", model=OPUS5
    )
    assert out.count("## Product Spec Atual") == 1
    assert "MESMO documento" in out
    assert out.count(spec) == 1


def test_dedupe_quando_product_spec_e_prefixo_de_spec_raw():
    spec = "# Spec\n" + "z" * 30_000
    out = build_user_message(
        {"inputs": {"spec_raw": spec, "product_spec": spec[:20_000]}}, role="CTO", model=OPUS5
    )
    assert "MESMO documento" in out


def test_sem_dedupe_quando_sao_documentos_diferentes():
    """`spec_raw` = upload cru, `product_spec` = PRODUCT_SPEC.md normalizado."""
    out = build_user_message(
        {"inputs": {"spec_raw": "A" * 5_000, "product_spec": "B" * 4_000}},
        role="CTO",
        model=OPUS5,
    )
    assert "MESMO documento" not in out
    assert out.count("A") >= 5_000
    assert out.count("B") >= 4_000


def test_dedupe_desligado_com_a_flag_off(monkeypatch):
    monkeypatch.setenv("AGENT_PROMPT_BUDGET", "off")
    spec = "z" * 5_000
    out = build_user_message(
        {"inputs": {"spec_raw": spec, "product_spec": spec}}, role="CTO", model=OPUS5
    )
    assert "MESMO documento" not in out
    assert out.count("z") == 10_000


# ── GAP-1/D4: orçamento global segura a soma ──────────────────────────────────

def test_orcamento_global_limita_a_soma_dos_documentos(monkeypatch):
    monkeypatch.setenv("AGENT_PROMPT_TOTAL_CHARS", "60000")
    out = build_user_message(_msg_grande(), role="CTO", model=OPUS5)
    # spec_raw come 50.000 (cabe no cap de 145.600, limitado pela sobra global de 60.000)
    assert out.count(_SPEC) == 50_000
    # sobra 10.000 para product_spec; charter/backlog/engineer ficam sem orçamento
    assert out.count(_PROD) == 10_000
    assert out.count(_CHARTER) == 0
    assert out.count(_BACKLOG) == 0
    assert out.count(_ENG) == 0
    # e o corte foi ANUNCIADO, não silencioso
    assert "[CORTE DE CONTEXTO]" in out


def test_prioridade_spec_raw_sobre_os_demais(monkeypatch):
    """Com orçamento escasso, a spec (input principal) é servida primeiro."""
    monkeypatch.setenv("AGENT_PROMPT_TOTAL_CHARS", "31000")
    out = build_user_message(_msg_grande(), role="CTO", model=OPUS5)
    assert out.count(_SPEC) == 31_000
    assert out.count(_PROD) == 0


# ── D5: overrides de ambiente ─────────────────────────────────────────────────

def test_override_do_cap_da_spec(monkeypatch):
    monkeypatch.setenv("AGENT_PROMPT_SPEC_CHARS", "70000")
    assert _prompt_budget(OPUS5)["spec_raw"] == 70_000


def test_override_invalido_e_ignorado(monkeypatch):
    monkeypatch.setenv("AGENT_PROMPT_SPEC_CHARS", "nao-e-numero")
    monkeypatch.setenv("AGENT_PROMPT_TOTAL_CHARS", "-5")
    b = _prompt_budget(OPUS5)
    assert b["spec_raw"] == 145_600
    assert b["_total"] == 280_000


def test_override_nao_pode_baixar_do_piso(monkeypatch):
    monkeypatch.setenv("AGENT_PROMPT_SPEC_CHARS", "1000")
    assert _prompt_budget(OPUS5)["spec_raw"] == _PROMPT_FIELD_FLOORS["spec_raw"]


# ── CAUSA RAIZ: corpo plano embrulhado pelo server em {"input": body} ─────────
# A Bancada manda `{task, mode, inputs:{...}}` (sem `input`); `server.py::_wrap_with_llm_config`
# embrulha em `{"input": body}` e os campos de conteúdo ficavam um nível abaixo do que o montador
# lia. Medido em prod: prompt do CTO com 322 chars, spec ZERO.


def _corpo_bancada(spec: str) -> dict:
    """Forma EXATA de `specChat.ts::buildChatMessage` + o embrulho de `_invoke_agent`."""
    return {
        "request_id": "http",
        "input": {
            "project_id": "spec_chat",
            "agent": "CTO",
            "mode": "spec_intake_and_normalize",
            "task": "Você é um CTO sênior refinando uma especificação",
            "inputs": {
                "spec_raw": spec,
                "product_spec": spec,
                "chat_transcript": "user: revise",
                "input_type": "spec_refinement",
            },
        },
    }


def test_corpo_da_bancada_entrega_a_spec_ao_modelo():
    spec = "# Spec NVX\n" + ("x" * 39_000)
    out = build_user_message(_corpo_bancada(spec), role="CTO", model=OPUS5)
    assert "## Spec do Projeto (input principal)" in out
    assert spec in out
    assert "Você é um CTO sênior" in out          # a tarefa do nível de fora não se perde
    assert "spec_intake_and_normalize" in out      # nem o modo
    assert len(out) > 39_000


def test_corpo_da_bancada_tambem_deduplica():
    spec = "# Spec\n" + ("y" * 20_000)
    out = build_user_message(_corpo_bancada(spec), role="CTO", model=OPUS5)
    assert "MESMO documento" in out
    assert out.count(spec) == 1


def test_corpo_da_bancada_respeita_a_flag_off(monkeypatch):
    """Com a flag off o embrulho continua resolvido (é bug, não orçamento), mas nos tetos antigos."""
    monkeypatch.setenv("AGENT_PROMPT_BUDGET", "off")
    spec = _SPEC * 50_000
    out = build_user_message(_corpo_bancada(spec), role="CTO", model=OPUS5)
    assert out.count(_SPEC) == 30_000 + 20_000   # sem dedupe: os dois blocos, nos pisos


def test_envelope_plano_sem_inputs_nao_muda():
    """Caminho da fábrica (`_build_message_envelope` já duplica `input: inputs`): intacto."""
    inputs = {"spec_raw": _SPEC * 1_000, "constraints": ["x"]}
    fabrica = {"request_id": "r", "mode": "m", "task": "t", "inputs": inputs, "input": inputs,
               "existing_artifacts": []}
    out = build_user_message(fabrica, role="CTO", model=OPUS5)
    assert out.count(_SPEC) == 1_000


def test_existing_artifacts_do_envelope_plano_aparecem():
    out = build_user_message(
        {"request_id": "http", "input": {
            "task": "t", "inputs": {"spec_raw": "s"},
            "existing_artifacts": [{"path": "docs/x.md", "content": "conteúdo do artefato"}],
        }},
        role="CTO",
        model=OPUS5,
    )
    assert "## Artefatos Existentes" in out
    assert "conteúdo do artefato" in out


# ── Robustez: valores não-string não podem estourar o montador ────────────────

def test_valor_nao_string_nao_quebra():
    out = build_user_message({"inputs": {"spec_raw": "ok", "product_spec": 12345}}, model=OPUS5)
    assert "12345" in out


def test_corte_registra_warning_estruturado(caplog):
    with caplog.at_level("WARNING"):
        _clip("x" * 100, 10, "spec_raw", OPUS5)
    assert any("CORTADO" in r.getMessage() and "spec_raw" in r.getMessage()
               for r in caplog.records)
