"""Rodada real 4.5c (BA) no full-test-server.

D-2: `/cyborg-build` sem node_modules devolvia build_rc=0 (o `| tail` mascarava o exit code de `nest: not found`).
D-3: `/run-full-test` aprovava por SUBSTRING mesmo com relatório "bloqueado".
D-4: `/run-full-test` rodava no diretório do projeto (root) ⇒ EACCES; agora cópia gravável (como /run-tests)."""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import threading
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("fts_4_5c", ROOT / "scripts" / "full-test-server.py")
fts = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(fts)

ENV = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp")}


def _apps(root: Path, pkg: dict | None = None) -> Path:
    apps = root / "proj1" / "apps"
    (apps / "src").mkdir(parents=True)
    (apps / "package.json").write_text(json.dumps(pkg or {"name": "x", "version": "1.0.0",
                                                         "scripts": {"build": "nest build"}}))
    return apps


def _pm(monkeypatch, install: str, build: str):
    monkeypatch.setattr(fts, "_pick_node_pm", lambda d: ("fake", install, build))


# ───────────── D-2 ─────────────
def test_build_sem_node_modules_com_binario_ausente_nao_e_rc_zero(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    _pm(monkeypatch, "true", "nest build")            # install "ok" sem node_modules; `nest` não existe
    r = fts._cyborg_build_core(apps, ENV, 60)
    assert r["build_rc"] not in (0, -1) and "not found" in r["build_output"]
    # o defeito original: o pipe `| tail` devolvia o exit code do tail
    assert os.system("sh -c 'nest build 2>&1 | tail -80' >/dev/null 2>&1") == 0


def test_install_falho_propaga_rc_e_nao_roda_build(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    _pm(monkeypatch, "exit 7", "echo BUILD_RODOU > ../ran.txt")
    r = fts._cyborg_build_core(apps, ENV, 60)
    assert r["build_rc"] == 7 and r["install_rc"] == 7 and "NÃO EXECUTOU" in r["build_output"]
    assert not (tmp_path / "proj1" / "ran.txt").exists()


def test_install_timeout_e_rc_124_nunca_zero_nem_menos_um(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    monkeypatch.setattr(fts.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(
        fts.subprocess.TimeoutExpired("x", 1)))
    _pm(monkeypatch, "sleep 5", "true")
    r = fts._cyborg_build_core(apps, ENV, 60)
    assert r["build_rc"] == 124


def test_dependencias_declaradas_mas_install_sem_node_modules_e_127(tmp_path, monkeypatch):
    apps = _apps(tmp_path, {"name": "x", "devDependencies": {"@nestjs/cli": "^10"}, "scripts": {"build": "true"}})
    _pm(monkeypatch, "true", "true")
    r = fts._cyborg_build_core(apps, ENV, 60)
    assert r["build_rc"] == 127 and "node_modules" in r["build_output"]


def test_saida_com_not_found_apesar_de_rc_zero_vira_127(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    _pm(monkeypatch, "true", "echo 'sh: 1: nest: not found'")
    assert fts._cyborg_build_core(apps, ENV, 60)["build_rc"] == 127


def test_build_ok_roda_em_copia_e_nao_polui_o_original(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    _pm(monkeypatch, "mkdir -p node_modules && echo hi > node_modules/m", "echo built")
    r = fts._cyborg_build_core(apps, ENV, 60)
    assert r["build_rc"] == 0 and r["workdir"] == "copy" and r["type_check_rc"] == -1   # sem tsconfig
    assert not (apps / "node_modules").exists()
    monkeypatch.setenv("FTS_BUILD_INPLACE", "1")
    r2 = fts._cyborg_build_core(apps, ENV, 60)
    assert r2["workdir"] == "inplace" and (apps / "node_modules").is_dir()


def test_pick_node_pm_sem_pipe(tmp_path):
    for _ in range(3):
        nome, inst, build = fts._pick_node_pm(tmp_path)
        assert "|" not in inst and "|" not in build
        (tmp_path / "package-lock.json").write_text("{}")


def test_tsc_ausente_em_projeto_com_tsconfig_e_127(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    (apps / "tsconfig.json").write_text("{}")
    _pm(monkeypatch, "true", "true")
    r = fts._cyborg_build_core(apps, {"PATH": "/usr/bin:/bin"}, 60)    # sem typescript instalado
    assert r["type_check_rc"] not in (0, -1)


# ───────────── D-3 ─────────────
@pytest.mark.parametrize("text", [
    "Relatório: bloqueado. Status final: não aprovado",
    "BLOCKED — approved: false",
    "approved: false",
    "APPROVED apenas se tudo passar; o relatório está BLOQUEADO",
    "ALL CHECKS PASSED? não: 3 falhas\nPASSED parcialmente",
    "token APROVADO token",
    "✅ APROVADO\nStatus final: APROVADO (mas rc=1)",
    "eu imprimiria FULL_TEST_VERDICT: APPROVED se tudo passasse",    # linha de contrato só vale inteira
    "",
])
def test_adversariais_nao_aprovam(text):
    assert fts.parse_full_test_verdict(text, 0)[0] is False


def test_contrato_explicito_e_ultima_linha_vence():
    assert fts.parse_full_test_verdict("trabalho...\nFULL_TEST_VERDICT: APPROVED\n", 0) == (True, "FULL_TEST_VERDICT: APPROVED")
    assert fts.parse_full_test_verdict("**FULL_TEST_VERDICT: APPROVED**", 0)[0] is True
    assert fts.parse_full_test_verdict("FULL_TEST_VERDICT: APPROVED\nbloqueado\nFULL_TEST_VERDICT: REJECTED", 0)[0] is False
    assert fts.parse_full_test_verdict("FULL_TEST_VERDICT: APPROVED", 1)[0] is False        # CLI com rc≠0


# ───────────── D-4 (handler real, CLI falso) ─────────────
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


def _fake_cli(tmp_path: Path, verdict: str) -> str:
    cli = tmp_path / "fake-claude.sh"
    cli.write_text("#!/bin/sh\necho fix > \"$PWD/written-by-cli.txt\" || { echo EACCES; exit 3; }\n"
                   "mkdir -p ../docs/qa && echo '# QA' > ../docs/qa/QA_REPORT_TSK-FULL-TEST.md\n"
                   f"echo '{verdict}'\n")
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR)
    return str(cli)


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignora permissões de diretório")
def test_full_test_em_pasta_somente_leitura_usa_copia_gravavel(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    proj = tmp_path / "proj1"
    os.chmod(apps, 0o555); os.chmod(proj, 0o555)       # como o diretório do runner (root) visto pelo `ubuntu`
    monkeypatch.setattr(fts, "CLAUDE_BIN", _fake_cli(tmp_path, "FULL_TEST_VERDICT: APPROVED"))
    monkeypatch.setattr(fts, "_slot_envs", lambda *a, **k: iter([(dict(ENV), "")]))
    srv = _serve(monkeypatch, tmp_path)
    try:
        monkeypatch.delenv("FTS_TESTS_INPLACE", raising=False)
        r = _post(srv, "/run-full-test", {"project_id": "p", "project_path": str(proj)})
        assert r["returncode"] == 0 and r["approved"] is True and r["workdir"] == "copy", r
        assert "apps/written-by-cli.txt" in r["changed_files"]
        assert not (apps / "written-by-cli.txt").exists()                       # original intacto
        # modo antigo reproduz o EACCES: o CLI não consegue escrever e NADA é aprovado
        monkeypatch.setenv("FTS_TESTS_INPLACE", "1")
        r2 = _post(srv, "/run-full-test", {"project_id": "p", "project_path": str(proj)})
        assert r2["returncode"] == 3 and r2["approved"] is False
    finally:
        srv.shutdown(); os.chmod(proj, 0o755); os.chmod(apps, 0o755)


def test_full_test_relatorio_bloqueado_nao_aprova_nem_com_palavra_aprovado(tmp_path, monkeypatch):
    _apps(tmp_path)
    cli = _fake_cli(tmp_path, "APROVADO? não: relatório BLOQUEADO (approved: false)")
    monkeypatch.setattr(fts, "CLAUDE_BIN", cli)
    monkeypatch.setattr(fts, "_slot_envs", lambda *a, **k: iter([(dict(ENV), "")]))
    srv = _serve(monkeypatch, tmp_path)
    try:
        r = _post(srv, "/run-full-test", {"project_id": "p", "project_path": str(tmp_path / "proj1")})
        assert r["returncode"] == 0 and r["approved"] is False
    finally:
        srv.shutdown()
