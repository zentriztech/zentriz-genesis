"""🔴 GAP-54 — a FIAÇÃO: o runner realmente reparte a leitura, e o CTO não reemite mais a spec.

`test_spec_dossier` e `test_spec_review` provam os módulos. Estes testes provam o que os liga ao
pipeline, que é onde os GAPs anteriores moraram (o Estágio B pulado do GAP-13 nasceu num `if`, não
num algoritmo). As propriedades fixadas:

  • **spec que cabe → UMA chamada**, exatamente como antes do GAP-54 (trava de custo e de regressão);
  • **árvore que não cabe → N chamadas** com `spec_readonly=True` e foco, e a UNIÃO dos passes cobre
    os 12 arquivos (o "antes" medido em prod foi 2 de 12 = 10,2%);
  • **`spec_readonly` troca o teto** de `_spec_input_cap()` (escrita, 145.000) para `_spec_read_cap()`
    (leitura, ~499.200) — e SÓ com a flag, porque quem reemite não pode ler mais do que devolve;
  • **perguntas de qualquer passe sobrevivem** (D3/GAP-62: engolir pergunta bloqueante é fail-OPEN);
  • **`SPEC_REVIEW_PER_FILE=off`** volta ao caminho único, byte a byte.
"""
import pytest

from orchestrator import runner
from orchestrator.tests.test_spec_dossier import NVX_TREE


def _tree() -> str:
    """Árvore REAL do NVX LastMile em prod, no formato de `load_spec_all`."""
    parts = []
    for name, size in NVX_TREE:
        head = f"# {name[:-3]}\n\n## 1. Escopo\n\ntexto\n\n## 2. Regras\n\n"
        parts.append(f"---\n# [{name}]\n\n" + head + "x" * max(0, size - len(head)))
    return "\n\n".join(parts)


@pytest.fixture()
def espia(monkeypatch):
    """Substitui `call_cto` e registra cada chamada; nenhum LLM é gasto."""
    chamadas: list[dict] = []

    def fake_call_cto(spec_ref, request_id, **kw):
        chamadas.append(kw)
        return {"status": "OK", "summary": "revisado", "artifacts": []}

    monkeypatch.setattr(runner, "call_cto", fake_call_cto)
    monkeypatch.setattr(runner, "_post_step", lambda *a, **k: None)
    monkeypatch.setenv("SPEC_REVIEW_PER_FILE", "on")
    return chamadas


def _review(spec: str) -> dict:
    return runner._review_spec_with_cto(spec, spec_ref="s", request_id="r")


# ── 1. a trava de custo: spec pequena não paga nada a mais ───────────────────


def test_spec_que_cabe_gasta_uma_unica_chamada(espia):
    out = _review("---\n# [a.md]\n\ntexto curto\n\n---\n# [b.md]\n\noutro")
    assert len(espia) == 1
    assert out["per_file"] is False
    assert out["review"] is None
    assert "spec_readonly" not in espia[0], "chamada única continua sendo a de ESCRITA"


def test_spec_de_arquivo_unico_nao_vira_dossie(espia):
    _review("# Spec\n\ntexto")
    assert len(espia) == 1
    assert espia[0].get("spec_readonly") is None


def test_flag_off_volta_ao_caminho_unico_mesmo_com_arvore_gigante(espia, monkeypatch):
    monkeypatch.setenv("SPEC_REVIEW_PER_FILE", "off")
    out = _review(_tree())
    assert len(espia) == 1
    assert out["per_file"] is False


# ── 2. 🔴 a regressão do NVX: 12 de 12, contra 2 de 12 medidos em prod ───────


def test_arvore_do_nvx_e_lida_por_arquivo_e_cobre_os_12(espia):
    out = _review(_tree())
    assert out["per_file"] is True
    rv = out["review"]
    assert rv.total_files == 12
    assert rv.uncovered == [], f"faltaram: {rv.uncovered}"
    assert rv.partial == []
    assert rv.complete is True
    assert 1 < len(espia) <= 16, "reparte a leitura sem virar uma chamada por arquivo"


def test_todo_passe_da_arvore_declara_leitura_e_manda_o_foco(espia):
    _review(_tree())
    assert all(c.get("spec_readonly") is True for c in espia), "revisão por arquivo NÃO reemite a spec"
    assert espia[0].get("spec_focus", "") == "", "o primeiro passe não tem foco"
    assert all(c.get("spec_focus") for c in espia[1:]), "os demais passes têm foco explícito"


def test_o_dossie_chega_no_lugar_da_spec_bruta(espia):
    _review(_tree())
    primeiro = espia[0]["spec_content"]
    assert "=== MAPA DA SPEC" in primeiro
    assert "--- INÍCIO " in primeiro
    assert "=== FIM DO DOSSIÊ" in primeiro, "o selo de integridade tem de chegar ao agente"
    # O MAPA cobre os 12 arquivos mesmo no passe em que o TEXTO cobre poucos.
    for name, _size in NVX_TREE:
        assert name in primeiro


def test_nenhum_dossie_passa_do_orcamento_de_leitura(espia):
    _review(_tree())
    cap = runner._spec_read_cap()
    for c in espia:
        assert len(c["spec_content"]) <= cap


# ── 3. o teto certo para cada tipo de chamada ────────────────────────────────


def test_leitura_tem_teto_maior_que_escrita():
    # GAP-61: amarrar a leitura ao `max_output` cobrava 2 de 12 arquivos.
    assert runner._spec_read_cap() > runner._spec_input_cap()


def test_teto_de_leitura_por_env(monkeypatch):
    monkeypatch.setenv("SPEC_READ_CHARS", "300000")
    assert runner._spec_read_cap() == 300_000


def test_teto_de_leitura_nunca_fica_abaixo_do_de_escrita(monkeypatch):
    # Piso: um cap de leitura MENOR que o de escrita seria regressão silenciosa.
    monkeypatch.setenv("SPEC_INPUT_CHARS", "600000")
    monkeypatch.delenv("SPEC_READ_CHARS", raising=False)
    assert runner._spec_read_cap() >= runner._spec_input_cap()


@pytest.mark.parametrize("valor,esperado", [("off", False), ("0", False), ("false", False), ("on", True), ("", True)])
def test_flag_per_file(monkeypatch, valor, esperado):
    monkeypatch.setenv("SPEC_REVIEW_PER_FILE", valor)
    assert runner._spec_per_file_review_enabled() is esperado


# ── 4. o que o passe devolve tem de sobreviver ───────────────────────────────


def test_pergunta_de_um_passe_qualquer_chega_agregada(monkeypatch):
    """D3/GAP-62: a dúvida bloqueante pode nascer no passe 7."""
    n = {"i": 0}

    def fake_call_cto(spec_ref, request_id, **kw):
        n["i"] += 1
        if n["i"] == 3:
            return {"status": "NEEDS_INFO", "next_actions": {"questions": ["Qual o TTL do token?"]}}
        return {"status": "OK"}

    monkeypatch.setattr(runner, "call_cto", fake_call_cto)
    monkeypatch.setattr(runner, "_post_step", lambda *a, **k: None)
    monkeypatch.setenv("SPEC_REVIEW_PER_FILE", "on")
    out = _review(_tree())
    assert out["questions"] == ["Qual o TTL do token?"]


def test_falha_de_passe_nao_credita_cobertura_nem_aborta(monkeypatch):
    n = {"i": 0}

    def flaky(spec_ref, request_id, **kw):
        n["i"] += 1
        if n["i"] == 2:
            raise RuntimeError("Bedrock 429")
        return {"status": "OK"}

    monkeypatch.setattr(runner, "call_cto", flaky)
    monkeypatch.setattr(runner, "_post_step", lambda *a, **k: None)
    monkeypatch.setenv("SPEC_REVIEW_PER_FILE", "on")
    out = _review(_tree())
    rv = out["review"]
    assert len(rv.failures) == 1
    assert rv.complete is False, "spec com passe falhado não pode se declarar completa"
    assert rv.covered, "os passes que deram certo continuam valendo"
    # E ainda existe uma `response` utilizável para o resto do pipeline.
    assert out["response"].get("status") == "OK"


def test_response_vazia_quando_todos_os_passes_falham(monkeypatch):
    monkeypatch.setattr(runner, "call_cto", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("429")))
    monkeypatch.setattr(runner, "_post_step", lambda *a, **k: None)
    monkeypatch.setenv("SPEC_REVIEW_PER_FILE", "on")
    out = _review(_tree())
    assert out["response"] == {}
    assert out["review"].complete is False


# ── 5. o prompt do CTO parou de mandar reemitir num dossiê ───────────────────


def test_prompt_do_cto_tem_a_excecao_do_dossie():
    from pathlib import Path

    p = Path(runner.__file__).resolve().parents[1] / "agents" / "cto" / "SYSTEM_PROMPT.md"
    if not p.exists():  # pragma: no cover — layout alternativo
        pytest.skip("SYSTEM_PROMPT.md do CTO não encontrado")
    txt = p.read_text(encoding="utf-8")
    assert "spec_readonly" in txt, "o Sub-modo C tem de reconhecer o dossiê"
    assert "=== MAPA DA SPEC" in txt
    assert "FIM DO DOSSIÊ" in txt, "o selo de integridade tem de ser verificável pelo agente"
