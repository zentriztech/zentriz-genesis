"""Tarefas 1.5 (anexos) e 1.6 (herança transitiva) do plano EVOLUIR-PROJETO-BANCADA (v2), Fase 1'.

Flags: ATTACHMENTS_STRICT (off|on) e TASK_INHERIT_TRANSITIVE (off|on). `off` = comportamento anterior, byte a byte.
Sem rede, sem LLM, sem API real (fakes de test_evolve_repro_f0).
"""
from __future__ import annotations

import logging
import re

import pytest

import orchestrator.runner as runner
from orchestrator.tests.test_evolve_repro_f0 import (
    FakeSpecApi, FakeTaskStore, SPEC_EXTRA, SPEC_PRIMARIA, make_pdf_bytes, make_png_bytes, make_xlsx_bytes,
)

DOCX = b"PK\x03\x04[Content_Types].xml word/document.xml"
DOC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + bytes(range(128, 200))


def _tree(tmp_path, monkeypatch, extras: dict[str, bytes]) -> FakeSpecApi:
    api = FakeSpecApi(tmp_path)
    api.add("spec-evolution-v2.md", SPEC_PRIMARIA, primary=True)
    api.add("contratos.md", SPEC_EXTRA, rel_dir="docs")
    api.add("request.md", "# TK-0001\n\nQuero exportar CSV.\n", rel_dir="tickets/TK-0001")
    api.add("notas.txt", "NOTA-TXT: texto puro anexado ao card.\n", rel_dir="tickets/TK-0001/anexos", mime="text/plain")
    for name, raw in extras.items():
        api.add(name, raw, rel_dir="tickets/TK-0001/anexos", mime="application/octet-stream")
    api.install(monkeypatch)
    return api


# ───────────────────────── 1.5 — runner ─────────────────────────

BINARIOS = {"print.png": make_png_bytes(), "planilha.xlsx": make_xlsx_bytes(), "manual.pdf": make_pdf_bytes(),
            "contrato.docx": DOCX, "antigo.doc": DOC}


def test_strict_binarios_fora_da_arvore_e_spec_de_texto_intacta(tmp_path, monkeypatch, caplog):
    monkeypatch.setenv("ATTACHMENTS_STRICT", "on")
    _tree(tmp_path, monkeypatch, BINARIOS)
    with caplog.at_level("WARNING"):
        out = runner.load_spec_all("p")
    for ok in ("TEXTO-PRIMARIO", "TEXTO-EXTRA", "NOTA-TXT", "# [tickets/TK-0001/request.md]"):
        assert ok in out
    for nome in BINARIOS:
        assert f"[tickets/TK-0001/anexos/{nome}]" not in out
        assert any(nome in r.message and "fora da allowlist" in r.message for r in caplog.records), nome


def test_strict_so_binarios_e_erro_explicito_nao_vazio(tmp_path, monkeypatch):
    monkeypatch.setenv("ATTACHMENTS_STRICT", "on")
    api = FakeSpecApi(tmp_path); api.add("manual.pdf", make_pdf_bytes(), mime="application/pdf"); api.install(monkeypatch)
    with pytest.raises(runner.SpecReadError, match="nenhum arquivo de texto"):
        runner.load_spec_all("p")


def test_strict_arquivo_de_spec_ilegivel_levanta_erro_explicito(tmp_path, monkeypatch):
    monkeypatch.setenv("ATTACHMENTS_STRICT", "on")
    api = _tree(tmp_path, monkeypatch, {})
    api.add("quebrado.md", b"ok \xff\xfe\x80 inv\xc3\x28lido", rel_dir="docs")  # .md mas NÃO é UTF-8
    with pytest.raises(runner.SpecReadError, match="docs/quebrado.md"):
        runner.load_spec_all("p")


def test_strict_arquivo_registrado_ausente_no_disco_levanta_erro(tmp_path, monkeypatch):
    monkeypatch.setenv("ATTACHMENTS_STRICT", "on")
    api = _tree(tmp_path, monkeypatch, {})
    (tmp_path / "docs" / "contratos.md").unlink()
    with pytest.raises(runner.SpecReadError, match="não existe no disco"):
        runner.load_spec_all("p")


def test_strict_allowlist_de_texto_configuravel(tmp_path, monkeypatch):
    monkeypatch.setenv("ATTACHMENTS_STRICT", "on")
    monkeypatch.setenv("SPEC_TEXT_EXTENSIONS", ".md")
    _tree(tmp_path, monkeypatch, {})
    out = runner.load_spec_all("p")
    assert "TEXTO-EXTRA" in out and "NOTA-TXT" not in out  # .txt deixou de ser texto da spec


@pytest.mark.parametrize("flag", [None, "off", "OFF", "qualquer"])
def test_off_e_byte_identico_ao_comportamento_anterior(tmp_path, monkeypatch, caplog, flag):
    if flag is None:
        monkeypatch.delenv("ATTACHMENTS_STRICT", raising=False)
    else:
        monkeypatch.setenv("ATTACHMENTS_STRICT", flag)
    _tree(tmp_path, monkeypatch, {"print.png": make_png_bytes()})
    with caplog.at_level("WARNING"):
        assert runner.load_spec_all("p") == ""  # defeito histórico preservado com a flag off
    assert any("[load_spec_all] Falha ao carregar spec files" in r.message for r in caplog.records)


def test_off_arvore_de_texto_igual_com_e_sem_flag(tmp_path, monkeypatch):
    _tree(tmp_path, monkeypatch, {})
    monkeypatch.delenv("ATTACHMENTS_STRICT", raising=False)
    off = runner.load_spec_all("p")
    monkeypatch.setenv("ATTACHMENTS_STRICT", "on")
    assert runner.load_spec_all("p") == off  # árvore só de texto: mesma saída


# ───────────────────────── 1.6 — herança transitiva ─────────────────────────

def _chain(store: FakeTaskStore, monkeypatch=None):
    """v1 → v2 → v3 → v4, cada versão com a sua TSK-EVO-001 (colisão clássica) além da BE da v1."""
    store.seed("v1", "TSK-BE-001", requirements="v1: CRUD de entregas")
    store.seed("v1", "TSK-DEVOPS-001", requirements="devops da v1")
    assert runner._inherit_parent_tasks("v2", "v1", parent_version=1) == 1
    store.seed("v2", "TSK-EVO-001", requirements="v2: exportar CSV")
    runner._inherit_parent_tasks("v3", "v2", parent_version=2)
    store.seed("v3", "TSK-EVO-001", requirements="v3: filtro por data")
    runner._inherit_parent_tasks("v4", "v3", parent_version=3)


def test_v1_v2_v3_v4_herda_tudo_sem_colisao(monkeypatch):
    monkeypatch.setenv("TASK_INHERIT_TRANSITIVE", "on")
    store = FakeTaskStore(); store.install(monkeypatch)
    _chain(store)
    inh = lambda pid: [i for i in store.ids(pid) if i.startswith("TSK-INH-")]  # noqa: E731
    assert inh("v2") == ["TSK-INH-V1-BE-001"]
    assert inh("v3") == ["TSK-INH-V1-BE-001", "TSK-INH-V2-EVO-001"]
    assert inh("v4") == ["TSK-INH-V1-BE-001", "TSK-INH-V2-EVO-001", "TSK-INH-V3-EVO-001"]
    assert store.ids("v4") == inh("v4")  # a v4 ainda não tem trabalho próprio
    t = store.text("v4")
    assert "v1: CRUD de entregas" in t and "v2: exportar CSV" in t and "v3: filtro por data" in t
    assert all(x["status"] == "DONE" for x in store.tasks["v4"].values())
    assert "TSK-DEVOPS-001" not in "".join(store.ids("v4"))
    # herdada carregada adiante não ganha prefixo duplo nem perde o texto
    assert store.tasks["v4"]["TSK-INH-V1-BE-001"]["requirements"].startswith("[HERDADA da v1 — TSK-BE-001]")


def test_idempotente_reaplicar_nao_duplica(monkeypatch):
    monkeypatch.setenv("TASK_INHERIT_TRANSITIVE", "on")
    store = FakeTaskStore(); store.install(monkeypatch)
    _chain(store)
    before = dict(store.tasks["v4"])
    runner._inherit_parent_tasks("v4", "v3", parent_version=3)
    assert store.tasks["v4"] == before


def test_so_herda_done_e_qa_pass(monkeypatch):
    monkeypatch.setenv("TASK_INHERIT_TRANSITIVE", "on")
    store = FakeTaskStore(); store.install(monkeypatch)
    store.seed("v1", "TSK-BE-001", status="DONE"); store.seed("v1", "TSK-BE-002", status="ASSIGNED")
    store.seed("v1", "TSK-BE-003", status="QA_PASS")
    runner._inherit_parent_tasks("v2", "v1", parent_version=1)
    assert store.ids("v2") == ["TSK-INH-V1-BE-001", "TSK-INH-V1-BE-003"]


def test_heranca_legada_do_pai_segue_como_esta(monkeypatch):
    monkeypatch.setenv("TASK_INHERIT_TRANSITIVE", "on")
    store = FakeTaskStore(); store.install(monkeypatch)
    store.seed("v3", "TSK-INH-EVO-001", requirements="[HERDADA da versão anterior — TSK-EVO-001] origem v2")
    store.seed("v3", "TSK-EVO-001", requirements="origem v3")
    runner._inherit_parent_tasks("v4", "v3", parent_version=3)
    assert store.ids("v4") == ["TSK-INH-EVO-001", "TSK-INH-V3-EVO-001"]


def test_sem_versao_do_pai_usa_rotulo_unico_pelo_id_do_pai(monkeypatch):
    monkeypatch.setenv("TASK_INHERIT_TRANSITIVE", "on")
    store = FakeTaskStore(); store.install(monkeypatch)  # o fake devolve LISTA em /api/projects/<id> ⇒ versão indisponível
    store.seed("0a1b2c3d-pai", "TSK-BE-001")
    runner._inherit_parent_tasks("filho", "0a1b2c3d-pai")
    assert store.ids("filho") == ["TSK-INH-VP0A1B2C3D-BE-001"]


def test_off_e_byte_identico_ao_comportamento_anterior(monkeypatch):
    monkeypatch.delenv("TASK_INHERIT_TRANSITIVE", raising=False)
    store = FakeTaskStore(); store.install(monkeypatch)
    store.seed("v1", "TSK-BE-001", requirements="CRUD de entregas")
    store.seed("v2", "TSK-INH-BE-001", requirements="herdada"); store.seed("v2", "TSK-EVO-001", requirements="exportar CSV")
    assert runner._inherit_parent_tasks("v3", "v2") == 1          # pula TSK-INH-*, só um nível
    assert store.ids("v3") == ["TSK-INH-EVO-001"]                  # ID sem versão de origem (formato histórico)
    assert store.tasks["v3"]["TSK-INH-EVO-001"]["requirements"] == "[HERDADA da versão anterior — TSK-EVO-001] exportar CSV"


def test_id_herdado_versionado_nao_e_casado_pelo_regex_de_backlog():
    rx = re.compile(r'\b(TSK-[A-Z]+-\d+|TSK-\d+)\b')
    assert rx.search("TSK-INH-V2-EVO-001") is None   # criado pelo runner, nunca parseado do texto do PM
    assert rx.search("TSK-EVO-001").group(1) == "TSK-EVO-001"
    assert "TSK-INH-V2-EVO-001".startswith("TSK-INH-")  # exclusões de contagem/Dev/QA/API continuam valendo


# ───────────────────────── 1.6 — resumo compacto ─────────────────────────

def _rows(n_versions: int, per: int) -> list[dict]:
    rows = []
    for v in range(1, n_versions + 1):
        for i in range(per):
            rows.append({"taskId": f"TSK-INH-V{v}-EVO-{i:03d}", "status": "DONE",
                         "requirements": f"[HERDADA da v{v} — TSK-EVO-{i:03d}] requisito {v}.{i} " + "x" * 300})
    return rows


def test_resumo_agrupa_por_versao_mais_nova_primeiro(monkeypatch):
    out = runner._summarize_inherited_tasks(_rows(3, 2) + [{"taskId": "TSK-EVO-009", "status": "DONE", "requirements": "da v4"}],
                                            parent_version=4, max_tokens=5000)
    assert out.index("#### v4") < out.index("#### v3") < out.index("#### v2") < out.index("#### v1")
    assert "[HERDADA" not in out and "omitida" not in out


def test_resumo_respeita_o_limite_de_tokens_e_declara_o_corte():
    out = runner._summarize_inherited_tasks(_rows(5, 20), parent_version=5, max_tokens=300)
    assert len(out) <= 300 * 4 + 200  # teto + a linha final de aviso
    assert "omitida(s)" in out and "teto de ~300 tokens" in out
    shown = out.count("\n- TSK-")
    assert 0 < shown < 100
    assert f"e mais {100 - shown} task(s)" in out


def test_resumo_limite_por_env_com_padrao_e_faixa(monkeypatch):
    monkeypatch.delenv("TASK_INHERIT_SUMMARY_MAX_TOKENS", raising=False)
    assert runner._task_inherit_summary_max_tokens() == 1500
    monkeypatch.setenv("TASK_INHERIT_SUMMARY_MAX_TOKENS", "1")
    assert runner._task_inherit_summary_max_tokens() == 200
    monkeypatch.setenv("TASK_INHERIT_SUMMARY_MAX_TOKENS", "999999")
    assert runner._task_inherit_summary_max_tokens() == 20000
    monkeypatch.setenv("TASK_INHERIT_SUMMARY_MAX_TOKENS", "lixo")
    assert runner._task_inherit_summary_max_tokens() == 1500
