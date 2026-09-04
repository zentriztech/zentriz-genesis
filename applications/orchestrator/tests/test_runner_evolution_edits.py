"""Bloco 4 M8 — contrato `edits` no envelope + materialização (o gate de escopo vê `content`)."""
from __future__ import annotations

from pathlib import Path

import orchestrator.runner as runner
from orchestrator.edits import apply_edits
from orchestrator.envelope import validate_response_envelope
from orchestrator.pipeline_context import PipelineContext


def _envelope_with(artifacts):
    return {"status": "OK", "summary": "ok", "evidence": ["e"], "artifacts": artifacts}


def test_envelope_edits_valido_passa():
    ok, errs = validate_response_envelope(
        _envelope_with([{"path": "apps/api/src/x.ts", "format": "edits",
                         "edits": [{"search": "a", "replace": "b"}]}]),
        require_artifacts=True,
    )
    assert ok, errs


def test_envelope_edits_vazio_reprova():
    ok, errs = validate_response_envelope(
        _envelope_with([{"path": "apps/api/src/x.ts", "format": "edits", "edits": []}]),
        require_artifacts=True,
    )
    assert not ok
    assert any("não vazio" in e for e in errs)


def test_envelope_edit_sem_search_reprova():
    ok, errs = validate_response_envelope(
        _envelope_with([{"path": "apps/api/src/x.ts", "format": "edits",
                         "edits": [{"replace": "b"}]}]),
        require_artifacts=True,
    )
    assert not ok
    assert any("search" in e for e in errs)


def test_envelope_content_completo_continua_valido():
    ok, errs = validate_response_envelope(
        _envelope_with([{"path": "apps/api/src/x.ts", "content": "export const a = 1"}]),
        require_artifacts=True,
    )
    assert ok, errs


def test_materializacao_gate_ve_content_e_preserva_simbolos(tmp_path: Path):
    # Simula o que o runner faz: lê o arquivo do disco, aplica edits, e o gate de escopo/símbolos
    # passa a ver `content` COMPLETO (zero mudança no gate).
    apps = tmp_path / "apps" / "api" / "src"
    apps.mkdir(parents=True)
    original = "export function listReports() {}\nexport function exportPdf() {}\n"
    (apps / "svc.ts").write_text(original, encoding="utf-8")

    art = {"path": "apps/api/src/svc.ts", "format": "edits",
           "edits": [{"search": "export function exportPdf() {}",
                      "replace": "export function exportPdf() { /* novo */ }"}]}
    disk = (tmp_path / "apps" / "api" / "src" / "svc.ts").read_text(encoding="utf-8")
    content, errs = apply_edits(disk, art["edits"])
    assert errs == []
    # símbolos preservados no resultado materializado
    assert runner._exported_symbols(content) == {"listReports", "exportPdf"}

    materialized = {"path": art["path"], "content": content}
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/src/**"]
    allowed, viol = runner._evolution_scope_check(ctx, [materialized], tmp_path / "apps")
    assert viol == []
    assert allowed and allowed[0]["path"] == "apps/api/src/svc.ts"
    assert "novo" in allowed[0]["content"]


def test_materializacao_arquivo_inexistente_gera_repair():
    # Arquivo não existe em disco → apply_edits(None, ...) falha → runner dispara repair/QA_FAIL.
    content, errs = apply_edits(None, [{"search": "a", "replace": "b"}])
    assert content is None
    assert errs
