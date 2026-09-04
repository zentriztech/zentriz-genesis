"""Bloco 4 M7 — métricas de reescrita da Fase 0 (`evolution_dev_rewrite_stats`).

Cobre o helper determinístico `_accumulate_dev_rewrite_metrics`: com a flag
`EVOLUTION_DEV_EDIT_METRICS=on` e em modo evolução (`evolution_scope` presente), mede quanto do
conteúdo devolvido pelo Dev já era idêntico ao arquivo em disco (antes da gravação). Arquivo idêntico
→ `ratio_unchanged` ~1.0; arquivo novo → contado em `files_new`, sem `bytes_unchanged`. Com a flag OFF
(ou fora de evolução) → NADA é acumulado no checkpoint (byte-idêntico ao histórico).
"""
from __future__ import annotations

from pathlib import Path

import orchestrator.runner as runner
from orchestrator.pipeline_context import PipelineContext


def _mk_apps(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "api" / "src"
    apps.mkdir(parents=True)
    return tmp_path / "apps"


def test_flag_off_no_op(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("EVOLUTION_DEV_EDIT_METRICS", raising=False)
    monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)
    apps = _mk_apps(tmp_path)
    (apps / "api" / "src" / "svc.ts").write_text("export const a = 1\n", encoding="utf-8")
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/src/**"]
    arts = [{"path": "apps/api/src/svc.ts", "content": "export const a = 1\n"}]
    runner._accumulate_dev_rewrite_metrics(ctx, arts, apps)
    assert ctx.evolution_dev_rewrite_stats is None


def test_flag_on_fora_de_evolucao_no_op(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("EVOLUTION_DEV_EDIT_METRICS", "on")
    monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)
    apps = _mk_apps(tmp_path)
    ctx = PipelineContext("p")  # sem evolution_scope
    arts = [{"path": "apps/api/src/svc.ts", "content": "x\n"}]
    runner._accumulate_dev_rewrite_metrics(ctx, arts, apps)
    assert ctx.evolution_dev_rewrite_stats is None


def test_identico_ratio_um(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("EVOLUTION_DEV_EDIT_METRICS", "on")
    monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)
    apps = _mk_apps(tmp_path)
    content = "export function listReports() {}\nexport function exportPdf() {}\n"
    (apps / "api" / "src" / "svc.ts").write_text(content, encoding="utf-8")
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/src/**"]
    arts = [{"path": "apps/api/src/svc.ts", "content": content}]
    runner._accumulate_dev_rewrite_metrics(ctx, arts, apps)
    stats = ctx.evolution_dev_rewrite_stats
    assert stats is not None
    assert stats["files"] == 1
    assert stats["files_new"] == 0
    assert stats["bytes_out"] == len(content)
    assert stats["bytes_unchanged"] == len(content)
    assert stats["ratio_unchanged"] == 1.0
    assert "measured_at" in stats


def test_arquivo_novo_contado_sem_unchanged(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("EVOLUTION_DEV_EDIT_METRICS", "on")
    monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)
    apps = _mk_apps(tmp_path)  # svc.ts NÃO existe
    novo = "export const novo = 42\n"
    arts = [{"path": "apps/api/src/svc.ts", "content": novo}]
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/src/**"]
    runner._accumulate_dev_rewrite_metrics(ctx, arts, apps)
    stats = ctx.evolution_dev_rewrite_stats
    assert stats["files"] == 1
    assert stats["files_new"] == 1
    assert stats["bytes_unchanged"] == 0
    assert stats["ratio_unchanged"] == 0.0
    assert stats["bytes_out"] == len(novo)


def test_reescrita_parcial_acumula_e_soma_entre_chamadas(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("EVOLUTION_DEV_EDIT_METRICS", "on")
    monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)
    apps = _mk_apps(tmp_path)
    before = "linha A\nlinha B\nlinha C\n"
    (apps / "api" / "src" / "svc.ts").write_text(before, encoding="utf-8")
    after = "linha A\nlinha X\nlinha C\n"  # só a do meio muda
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/src/**"]
    runner._accumulate_dev_rewrite_metrics(ctx, [{"path": "apps/api/src/svc.ts", "content": after}], apps)
    s1 = ctx.evolution_dev_rewrite_stats
    assert s1["files"] == 1
    assert 0.0 < s1["ratio_unchanged"] < 1.0
    assert s1["bytes_unchanged"] > 0
    # 2ª chamada (outra rodada): acumula sobre o estado anterior no checkpoint.
    (apps / "api" / "src" / "outro.ts").write_text("y\n", encoding="utf-8")
    runner._accumulate_dev_rewrite_metrics(ctx, [{"path": "apps/api/src/outro.ts", "content": "y\n"}], apps)
    s2 = ctx.evolution_dev_rewrite_stats
    assert s2["files"] == 2  # acumulou


def test_docs_e_nao_apps_ignorados(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("EVOLUTION_DEV_EDIT_METRICS", "on")
    monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)
    apps = _mk_apps(tmp_path)
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/src/**"]
    arts = [
        {"path": "docs/nota.md", "content": "# nota"},
        {"path": "CHANGELOG.md", "content": "v1"},
    ]
    runner._accumulate_dev_rewrite_metrics(ctx, arts, apps)
    # Nenhum artefato apps/ → nada acumulado.
    assert ctx.evolution_dev_rewrite_stats is None
