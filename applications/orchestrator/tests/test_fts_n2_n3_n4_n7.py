"""4.5b N-2/N-3/N-4/N-7 no full-test-server: cópia gravável (EACCES), lockfile gerado pelo build, jest com
suítes quebradas ≠ no_tests e motivo do slot pulado. Fixtures reproduzem os defeitos da execução real."""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import threading
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("fts_n", ROOT / "scripts" / "full-test-server.py")
fts = importlib.util.module_from_spec(spec); spec.loader.exec_module(fts)


# ───────────── N-2: instalar numa cópia gravável ─────────────
def _node_project(root: Path) -> Path:
    apps = root / "proj1" / "apps"
    apps.mkdir(parents=True)
    (apps / "package.json").write_text(json.dumps({"name": "x", "version": "1.0.0",
                                                    "scripts": {"test": "node -e \"process.exit(0)\""}}))
    (apps / "src").mkdir()
    (apps / "src" / "a.js").write_text("1")
    return apps


def test_copy_project_for_tests_ignora_dependencias_e_fica_gravavel(tmp_path):
    apps = _node_project(tmp_path)
    (apps / "node_modules" / "p").mkdir(parents=True)
    (apps / "node_modules" / "p" / "i.js").write_text("x")
    (apps / ".git").mkdir(); (apps / ".git" / "HEAD").write_text("x")
    os.chmod(apps / "src", 0o555); os.chmod(apps, 0o555)   # como a pasta do runner (root) vista pelo `ubuntu`
    try:
        dst = fts._copy_project_for_tests(apps, tmp_path / "work" / "apps")
        assert not (dst / "node_modules").exists() and not (dst / ".git").exists()
        assert (dst / "src" / "a.js").is_file()
        assert os.access(dst, os.W_OK) and os.access(dst / "src", os.W_OK)
    finally:
        os.chmod(apps, 0o755); os.chmod(apps / "src", 0o755)


def _serve(monkeypatch, files_root: Path):
    monkeypatch.setattr(fts, "GENESIS_FILES_ROOT", str(files_root))
    monkeypatch.setattr(fts, "FTS_AUTH_TOKEN", "t")
    srv = fts.ThreadedHTTPServer(("127.0.0.1", 0), fts.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _post(srv, path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{srv.server_address[1]}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "X-FTS-Token": "t"})
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignora permissões de diretório")
def test_run_tests_em_pasta_somente_leitura_nao_da_eacces_e_nao_polui_o_projeto(tmp_path, monkeypatch):
    apps = _node_project(tmp_path)
    os.chmod(apps, 0o555)
    srv = _serve(monkeypatch, tmp_path)
    try:
        monkeypatch.delenv("FTS_TESTS_INPLACE", raising=False)
        r = _post(srv, "/run-tests", {"project_path": str(tmp_path / "proj1"), "timeout": 120})
        assert r["status"] == "passed", r
        assert r.get("workdir") == "copy"
        assert not (apps / "node_modules").exists() and not (apps / "package-lock.json").exists()
        # reproduz o defeito original: no diretório do projeto o install falha (EACCES) ⇒ baseline `error`
        monkeypatch.setenv("FTS_TESTS_INPLACE", "1")
        r2 = _post(srv, "/run-tests", {"project_path": str(tmp_path / "proj1"), "timeout": 120})
        assert r2["status"] == "error" and "npm install falhou" in (r2["error"] or "")
    finally:
        srv.shutdown(); os.chmod(apps, 0o755)


# ───────────── N-4: jest com suítes quebradas ─────────────
def test_jest_zero_testes_com_suites_falhando_e_erro_nao_no_tests():
    parsed = {"numTotalTests": 0, "numFailedTestSuites": 23, "numTotalTestSuites": 23,
              "testResults": [{"name": "a.spec.ts", "message": "SyntaxError: Cannot use import statement"}]}
    msg = fts._jest_zero_tests_error(parsed, 1)
    assert msg and "23 de 23" in msg and "jest.config" in msg and "SyntaxError" in msg


def test_jest_zero_testes_legitimo_continua_no_tests():
    assert fts._jest_zero_tests_error({"numTotalTests": 0, "numFailedTestSuites": 0}, 0) is None
    assert fts._jest_zero_tests_error({"numTotalTests": 5, "numFailedTestSuites": 1}, 1) is None


# ───────────── N-3: build não deixa lockfile novo; gerenciador pelo lockfile ─────────────
def test_pick_node_pm_segue_o_lockfile_existente(tmp_path):
    assert fts._pick_node_pm(tmp_path)[0] == "pnpm"
    (tmp_path / "package-lock.json").write_text("{}")
    nome, inst, build = fts._pick_node_pm(tmp_path)
    assert nome == "npm" and inst.startswith("npm install") and build.startswith("npm run build")
    (tmp_path / "package-lock.json").unlink(); (tmp_path / "yarn.lock").write_text("")
    assert fts._pick_node_pm(tmp_path)[0] == "yarn"


def test_remove_generated_lockfiles_so_remove_os_novos(tmp_path):
    (tmp_path / "package-lock.json").write_text("{}")
    before = fts._lockfiles_present(tmp_path)
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: 9\n" * 10)   # o que o `pnpm install` criou no PR #5
    (tmp_path / "package-lock.json").write_text('{"changed": true}')
    removed = fts._remove_generated_lockfiles(tmp_path, before)
    assert removed == ["pnpm-lock.yaml"]
    assert not (tmp_path / "pnpm-lock.yaml").exists() and (tmp_path / "package-lock.json").exists()


# ───────────── N-7: motivo do slot pulado ─────────────
def test_slot_bedrock_sem_chaves_explica_o_motivo_e_chega_ao_chamador():
    payload = {"llm_config": {"provider": "bedrock", "model": "us.anthropic.claude-sonnet-5-5"},
               "model_id": "us.anthropic.claude-sonnet-5-5"}
    skipped: list = []
    assert fts._slot_envs(payload, "p1", "", "", "", "", com_wrappers=False, skipped=skipped) == []
    assert len(skipped) == 1
    assert "bedrock/us.anthropic.claude-sonnet-5-5" in skipped[0] and "aws_access_key_id" in skipped[0]
    assert "instance role" in skipped[0]
