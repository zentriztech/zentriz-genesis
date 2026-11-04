"""Tarefa Q (conversão automática pdf/doc/docx → .md) — CONTRATO com o runner.

O `.md` derivado (kind=spec_text, origin=converted:<id>) entra na árvore da spec como qualquer txt/md e o runner o lê;
o binário original (pdf/doc/docx), guardado só no card, NÃO é lido. Sem rede, sem LLM, sem API real (fakes de test_evolve_repro_f0).

O texto do derivado abaixo é a saída REAL do conversor Node (attachmentConversionRunner, fixture de PDF com camada de texto),
com o cabeçalho de origem exigido.
"""
from __future__ import annotations

import orchestrator.runner as runner
from orchestrator.tests.test_evolve_repro_f0 import FakeSpecApi, SPEC_PRIMARIA, make_pdf_bytes, set_effective_flags

DERIVADO = (
    "> Convertido automaticamente de manual.pdf (anexo 11111111-2222-3333-4444-555555555555, sha256 deadbeef) "
    "em 2026-11-04; pode conter perdas de formatação\n\n<!-- página 1 -->\n\nRegra de negócio DERIVADA-PDF: o CSV usa ponto e vírgula.\n"
)


def _tree(tmp_path, monkeypatch, *, com_derivado: bool) -> FakeSpecApi:
    api = FakeSpecApi(tmp_path)
    api.add("spec-evolution-v2.md", SPEC_PRIMARIA, primary=True)
    api.add("request.md", "# TK-0001\n\nQuero exportar CSV.\n", rel_dir="tickets/TK-0001")
    api.add("manual.pdf", make_pdf_bytes(), rel_dir="tickets/TK-0001/anexos", mime="application/pdf")
    if com_derivado:
        api.add("manual.pdf.md", DERIVADO, rel_dir="tickets/TK-0001/anexos", mime="text/markdown")
    api.install(monkeypatch)
    return api


def test_derivado_md_e_lido_e_o_binario_original_nao(tmp_path, monkeypatch, caplog):
    set_effective_flags(monkeypatch, attachments_strict=True)
    _tree(tmp_path, monkeypatch, com_derivado=True)
    with caplog.at_level("WARNING"):
        out = runner.load_spec_all("p")
    assert "DERIVADA-PDF: o CSV usa ponto e vírgula." in out
    assert "# [tickets/TK-0001/anexos/manual.pdf.md]" in out
    assert "> Convertido automaticamente de manual.pdf" in out  # a marca de origem chega ao prompt
    assert "[tickets/TK-0001/anexos/manual.pdf]" not in out      # o binário não entra
    assert any("manual.pdf" in r.message and "fora da allowlist" in r.message for r in caplog.records)


def test_sem_derivado_o_pdf_continua_fora_da_spec(tmp_path, monkeypatch):
    set_effective_flags(monkeypatch, attachments_strict=True)
    _tree(tmp_path, monkeypatch, com_derivado=False)
    out = runner.load_spec_all("p")
    assert "DERIVADA-PDF" not in out and "manual.pdf" not in out.replace("tickets/TK-0001/request.md", "")
    assert "TEXTO-PRIMARIO" in out


def test_derivado_nao_utf8_e_erro_explicito_nunca_vazio(tmp_path, monkeypatch):
    import pytest
    set_effective_flags(monkeypatch, attachments_strict=True)
    api = _tree(tmp_path, monkeypatch, com_derivado=False)
    api.add("manual.pdf.md", b"ok \xff\xfe\x80 inv\xc3\x28lido", rel_dir="tickets/TK-0001/anexos")
    with pytest.raises(runner.SpecReadError, match="manual.pdf.md"):
        runner.load_spec_all("p")
