"""Evoluir E1 — repo map da evolução, docs do pai e existing_artifacts reais para os agentes."""
from __future__ import annotations

from pathlib import Path

import orchestrator.runner as runner
from orchestrator.pipeline_context import PipelineContext


def _mk_apps(root: Path) -> Path:
    apps = root / "apps"
    (apps / "src").mkdir(parents=True)
    (apps / "node_modules" / "x").mkdir(parents=True)
    (apps / "node_modules" / "x" / "index.js").write_text("export const lixo = 1;\n" * 50)
    (apps / "src" / "app.ts").write_text(
        "import express from 'express';\nexport interface User { id: string }\nexport async function main() {\n  const app = express();\n  app.get('/health', () => 1);\n  // detalhe interno longo\n  let x = 1;\n  x += 1;\n  return app;\n}\n")
    (apps / "package.json").write_text('{"name":"cf","version":"1.2.0"}')
    (apps / "README.md").write_text("# CF")
    (apps / "img.png").write_bytes(b"\x89PNG")
    return apps


def test_repo_map_traz_arvore_assinaturas_metadados_e_ignora_lixo(tmp_path: Path):
    apps = _mk_apps(tmp_path)
    ctx = PipelineContext("p")
    arts = runner._build_evolution_repo_map(apps, ctx, budget=20000)
    paths = [a["path"] for a in arts]
    assert paths[0] == "apps/_TREE.txt" and "src/app.ts" in arts[0]["content"]
    assert "apps/src/app.ts" in paths and "apps/package.json" in paths and "apps/README.md" in paths
    assert not any("node_modules" in p for p in paths) and "apps/img.png" not in paths
    app_ts = next(a for a in arts if a["path"] == "apps/src/app.ts")["content"]
    assert "INTERFACE RESUMIDA" in app_ts and "export interface User" in app_ts and "export async function main" in app_ts
    assert "x += 1" not in app_ts  # corpo interno fora do repo map
    assert next(a for a in arts if a["path"] == "apps/package.json")["content"].startswith("{")


def test_repo_map_respeita_orcamento_e_dir_inexistente(tmp_path: Path):
    apps = _mk_apps(tmp_path)
    arts = runner._build_evolution_repo_map(apps, PipelineContext("p"), budget=4000)
    assert sum(len(a["content"]) for a in arts) <= 4000 + 200  # tolerância do marcador de truncamento
    assert runner._build_evolution_repo_map(tmp_path / "nao-existe", None) == []


def test_parent_docs_e_existing_artifacts(tmp_path: Path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "cto_charter.md").write_text("# Charter\n" + "x" * 10)
    (tmp_path / "docs" / "engineer_proposal.md").write_text("# Proposta\nNode 20")
    docs = runner._load_parent_evolution_docs(tmp_path, cap=50)
    assert docs["charter"].startswith("# Charter") and "Node 20" in docs["engineer"]
    assert runner._load_parent_evolution_docs(tmp_path / "vazio") == {}
    ctx = PipelineContext("p")
    assert runner._evolution_existing_artifacts(ctx) == [] and runner._evolution_existing_artifacts(None) == []
    ctx.evolution_artifacts = [{"path": "apps/a.ts", "content": "export x"}]  # type: ignore[attr-defined]
    assert runner._evolution_existing_artifacts(ctx) == [{"path": "apps/a.ts", "content": "export x"}]
