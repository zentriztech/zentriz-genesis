"""Evoluir bloco 3 — F1 DevOps condicional, F2 reconciliação sobre apps/ em disco, F3b PASS_TO_PASS."""
from __future__ import annotations

import json
from pathlib import Path

import orchestrator.runner as runner
import orchestrator.connect_contracts as cc
from orchestrator.pipeline_context import PipelineContext


def test_f1_infra_patterns_e_diff_de_dependencias():
    assert runner._evo_path_is_infra("apps/Dockerfile")
    assert runner._evo_path_is_infra("apps/docker-compose.prod.yml")
    assert runner._evo_path_is_infra("apps/.github/workflows/deploy.yml")
    assert runner._evo_path_is_infra("apps/infra/main.tf")
    assert runner._evo_path_is_infra("apps/package-lock.json")
    assert runner._evo_path_is_infra("apps/api/requirements.txt")
    assert not runner._evo_path_is_infra("apps/api/src/reports/service.ts")
    assert not runner._evo_path_is_infra("apps/web/src/pages/index.tsx")
    a = json.dumps({"name": "x", "scripts": {"test": "jest"}, "dependencies": {"express": "^4"}})
    b_script = json.dumps({"name": "x", "scripts": {"test": "vitest"}, "dependencies": {"express": "^4"}})
    b_dep = json.dumps({"name": "x", "scripts": {"test": "jest"}, "dependencies": {"express": "^4", "pdfkit": "^0.15"}})
    assert not runner._evo_package_json_deps_changed(a, b_script)     # script não é infra
    assert runner._evo_package_json_deps_changed(a, b_dep)            # dependência nova é infra
    assert runner._evo_package_json_deps_changed(a, "{ nope")         # ilegível → conservador


def test_f1_infra_changed_usa_arquivos_tocados_e_baseline_de_manifest(tmp_path: Path):
    apps = tmp_path / "apps"; (apps / "api").mkdir(parents=True)
    (apps / "api" / "package.json").write_text(json.dumps({"dependencies": {"express": "^4"}}))
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/**"]
    ctx.evolution_manifest_baseline = {"api/package.json": json.dumps({"dependencies": {"express": "^4"}})}
    ctx.evolution_touched_files = ["apps/api/src/reports/pdf.ts", "apps/api/package.json"]
    changed, hits = runner._evo_infra_changed(ctx, apps)
    assert changed is False and hits == []                              # só código + package.json sem mudança de deps
    (apps / "api" / "package.json").write_text(json.dumps({"dependencies": {"express": "^4", "pdfkit": "1"}}))
    changed, hits = runner._evo_infra_changed(ctx, apps)
    assert changed is True and hits == ["apps/api/package.json"]
    ctx.evolution_touched_files = ["apps/Dockerfile"]
    assert runner._evo_infra_changed(ctx, apps) == (True, ["apps/Dockerfile"])
    assert runner._evo_infra_changed(None, apps) == (False, [])


def test_f3b_regressoes_pass_to_pass():
    base = {"status": "passed", "passed": 3, "failed": 0, "tests": [{"id": "a::t1", "status": "passed"}, {"id": "a::t2", "status": "passed"}, {"id": "b::t3", "status": "passed"}, {"id": "c::skip", "status": "skipped"}]}
    final_ok = {"status": "passed", "passed": 4, "tests": [{"id": "a::t1", "status": "passed"}, {"id": "a::t2", "status": "passed"}, {"id": "b::t3", "status": "passed"}, {"id": "d::novo", "status": "passed"}]}
    assert runner._evo_regressions(base, final_ok) == []
    final_bad = {"status": "failed", "passed": 1, "tests": [{"id": "a::t1", "status": "passed"}, {"id": "a::t2", "status": "failed"}]}
    assert runner._evo_regressions(base, final_bad) == ["a::t2", "b::t3"]   # falhou E sumiu do log = regressão (SWE-bench)
    # sem ids → contagem
    assert runner._evo_regressions({"status": "passed", "passed": 5, "tests": []}, {"status": "passed", "passed": 3, "tests": []}) == ["contagem: 3 passando agora < 5 na baseline"]
    # baseline sem testes / erro → nunca regressão
    assert runner._evo_regressions({"no_tests": True}, final_bad) == []
    assert runner._evo_regressions(base, {"status": "error", "tests": []}) == []
    assert runner._evo_regressions(None, final_bad) == []


def test_f2_corpus_le_apps_em_disco_sem_testes_e_baseline_do_pai(tmp_path: Path, monkeypatch):
    root = tmp_path / "files"; monkeypatch.setenv("PROJECT_FILES_ROOT", str(root))
    child = root / "child"; (child / "apps" / "src").mkdir(parents=True); (child / "apps" / "tests").mkdir()
    (child / "apps" / "node_modules" / "x").mkdir(parents=True)
    (child / "apps" / "src" / "server.ts").write_text("import express from 'express'\nconst app = express()\napp.get('/x', h)\n")
    (child / "apps" / "tests" / "server.test.ts").write_text("app.get('/mock', h)\n")
    (child / "apps" / "node_modules" / "x" / "index.js").write_text("app.get('/lib', h)\n")
    (child / "apps" / "src" / "bundle.min.js").write_text("app.get('/min', h)\n")
    parent = root / "parent"; (parent / "project" / "connect" / "v1.3.0").mkdir(parents=True)
    (parent / "project" / "connect" / "v1.3.0" / "reconciliation.json").write_text(json.dumps({
        "status": "divergent", "declaredButMissing": [{"interface": "orders-events", "type": "event"}], "foundButUndeclared": [{"type": "http"}]}))

    class Ctx:  # duck-typed como o PipelineContext usa
        project_id = "child"; product_id = ""; evolution_parent_id = "parent"
        artifacts = {"apps/src/new.ts": "export const q = new Queue('jobs')\n"}
        connect_declaration = None
    files = cc._code_corpus_files(Ctx())
    assert set(files) == {"apps/src/new.ts", "apps/src/server.ts"}       # testes, node_modules e .min.js fora
    assert cc._parent_reconciliation(Ctx()) is not None
    # sem PROJECT_FILES_ROOT válido → só artifacts (fail-safe)
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path / "nope"))
    assert set(cc._code_corpus_files(Ctx())) == {"apps/src/new.ts"}
    monkeypatch.setenv("EVOLUTION_RECONCILE_DISK", "off"); monkeypatch.setenv("PROJECT_FILES_ROOT", str(root))
    assert set(cc._code_corpus_files(Ctx())) == {"apps/src/new.ts"}
