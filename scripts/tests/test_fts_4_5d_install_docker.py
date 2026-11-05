"""Rodada real 4.5d (BG) no full-test-server.

D-12: `/cyborg-build` rodava `npm install` simples e morria em ERESOLVE (peer deps); agora retenta UMA vez com
      `--legacy-peer-deps` (como o /run-tests) e registra o fallback. Outra falha continua fail-closed.
D-15: o CLI do TSK-FULL-TEST subiu MongoDB em Docker no host; agora sem DOCKER_*, com shims que negam e
      registram, e o prompt proíbe Docker."""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("fts_4_5d", ROOT / "scripts" / "full-test-server.py")
fts = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(fts)

ENV = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp")}


def _apps(root: Path) -> Path:
    apps = root / "proj1" / "apps"
    (apps / "src").mkdir(parents=True)
    (apps / "package.json").write_text(json.dumps({"name": "x", "dependencies": {"a": "1"},
                                                   "scripts": {"build": "true"}}))
    return apps


def _installer(tmp_path: Path, body: str) -> str:
    sh = tmp_path / "fake-npm.sh"
    sh.write_text(body)
    return f"sh {sh}"


def _npm(monkeypatch, cmd: str, build: str = "echo built"):
    monkeypatch.setattr(fts, "_pick_node_pm", lambda d: ("npm", cmd, build))


# ───────────── D-12 ─────────────
ERESOLVE_THEN_OK = (
    'case "$*" in *--legacy-peer-deps*) mkdir -p node_modules; echo ok-legacy; exit 0;; esac\n'
    'echo "npm error code ERESOLVE" >&2; echo "npm error peer @nestjs/common@\\"^8 || ^9 || ^10\\"" >&2; exit 1\n')


def test_eresolve_na_primeira_tentativa_retenta_com_legacy_peer_deps(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    _npm(monkeypatch, _installer(tmp_path, ERESOLVE_THEN_OK))
    r = fts._cyborg_build_core(apps, ENV, 60)
    assert r["install_rc"] == 0 and r["build_rc"] == 0
    assert "legacy-peer-deps" in r["install_fallback"]
    assert r["build_output"].startswith("[install: npm install --legacy-peer-deps")     # registrado no relatório
    assert "ERESOLVE" in r["install_first_attempt_output"]


def test_install_ok_na_primeira_nao_usa_fallback(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    _npm(monkeypatch, _installer(tmp_path, "mkdir -p node_modules; exit 0\n"))
    r = fts._cyborg_build_core(apps, ENV, 60)
    assert r["build_rc"] == 0 and "install_fallback" not in r


def test_falha_de_install_por_outro_motivo_continua_fail_closed_sem_retry(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    counter = tmp_path / "n"
    _npm(monkeypatch, _installer(tmp_path, f'echo x >> {counter}; echo "npm error code E404" >&2; exit 1\n'))
    r = fts._cyborg_build_core(apps, ENV, 60)
    assert r["install_rc"] == 1 and r["build_rc"] == 1 and "NÃO EXECUTOU" in r["build_output"]
    assert "install_fallback" not in r
    assert counter.read_text().count("x") == 1                          # uma tentativa só


def test_eresolve_que_persiste_com_legacy_tambem_falha_fechado(tmp_path, monkeypatch):
    apps = _apps(tmp_path)
    _npm(monkeypatch, _installer(tmp_path, 'echo "npm error code ERESOLVE" >&2; exit 1\n'))
    r = fts._cyborg_build_core(apps, ENV, 60)
    assert r["build_rc"] == 1 and "NÃO EXECUTOU" in r["build_output"] and r["install_fallback"]


# ───────────── D-15 ─────────────
def test_env_do_cli_sem_docker_e_com_shims_que_negam_e_registram(tmp_path):
    base = {"PATH": "/usr/bin:/bin", "DOCKER_HOST": "unix:///var/run/docker.sock", "DOCKER_CONFIG": "/x",
            "COMPOSE_PROJECT_NAME": "p", "HOME": "/tmp"}
    env = fts._deny_docker_env(base, tmp_path / "shims")
    assert not any(k.startswith(("DOCKER_", "COMPOSE_")) for k in env) and env["HOME"] == "/tmp"
    assert env["PATH"].split(":")[0] == str(tmp_path / "shims")
    for b in ("docker", "docker-compose", "podman"):
        r = subprocess.run([b, "ps"], env=env, capture_output=True, text=True)
        assert r.returncode == 126 and "BLOQUEADO" in r.stderr
    log = fts._read_docker_attempts(tmp_path / "shims")
    assert len(log) == 3 and "docker ps" in log[0]
    assert "DOCKER_HOST" in base                                         # entrada não é mutada


def test_wrapper_prompt_proibe_docker_e_mantem_contrato_de_veredito():
    p = fts._build_full_test_wrapper_prompt("/a/apps", "/a", "FASE 1 ...")
    assert "DOCKER PROIBIDO" in p and "/var/run/docker.sock" in p and "FULL_TEST_VERDICT: APPROVED" in p
    assert p.index("DOCKER PROIBIDO") < p.index("CONTRATO DE VEREDITO")


def test_prompt_padrao_do_full_test_nao_manda_rodar_docker():
    src = (ROOT / "scripts" / "full-test-server.py").read_text()
    default = src[src.index("# TASK-FULL-TEST — Validação E2E e Correção Final"):src.index("TASK-FULL-TEST iniciada")]
    assert "docker logs" not in default and "docker ps" not in default


def test_runner_grava_prompt_com_restricao_de_docker():
    import sys
    sys.path.insert(0, str(ROOT / "applications"))
    from orchestrator import runner
    assert "DOCKER PROIBIDO" in runner.FULL_TEST_DOCKER_DENIAL and "docker.sock" in runner.FULL_TEST_DOCKER_DENIAL
    import inspect
    assert "_ft_prompt + FULL_TEST_DOCKER_DENIAL" in inspect.getsource(runner)


def test_jest_zero_tests_error_nao_dobra_contagem_de_suites():
    """4.5d (BF): jest conta suítes com erro de execução em numFailedTestSuites; o rótulo não pode virar '46 de 23'."""
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location("fts_label", pathlib.Path(__file__).resolve().parents[1] / "full-test-server.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    msg = m._jest_zero_tests_error({"numTotalTests": 0, "numFailedTestSuites": 23, "numRuntimeErrorTestSuites": 23,
                                    "numTotalTestSuites": 23, "testResults": []}, 1)
    assert msg is not None and msg.startswith("23 de 23"), msg
    msg2 = m._jest_zero_tests_error({"numTotalTests": 0, "numFailedTestSuites": 0, "numRuntimeErrorTestSuites": 5,
                                     "numTotalTestSuites": 5, "testResults": []}, 1)
    assert msg2 is not None and msg2.startswith("5 de 5"), msg2
