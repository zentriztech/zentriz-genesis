"""Bloco 4 M8 — `_persist_artifacts_for_role` NUNCA grava artefatos `format=='edits'` (só o runner materializa)."""
from __future__ import annotations

from pathlib import Path

from orchestrator.agents import server


def test_persist_ignora_edits_e_grava_content(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path))
    message = {"project_id": "proj1"}
    response = {
        "artifacts": [
            # Artefato normal (content completo) → deve ser gravado.
            {"path": "apps/api/src/ok.ts", "content": "export const ok = true // conteudo real"},
            # Artefato `edits` — mesmo com `content` de brinde, NÃO pode virar arquivo bruto.
            {"path": "apps/api/src/nope.ts", "format": "edits",
             "content": "ISTO NÃO PODE SER GRAVADO COMO ARQUIVO",
             "edits": [{"search": "a", "replace": "b"}]},
        ]
    }
    server._persist_artifacts_for_role(message, response, "dev")

    apps = tmp_path / "proj1" / "apps" / "api" / "src"
    assert (apps / "ok.ts").exists(), "artefato content completo deveria ter sido gravado"
    assert not (apps / "nope.ts").exists(), "artefato format=='edits' NÃO pode ser gravado como arquivo"
