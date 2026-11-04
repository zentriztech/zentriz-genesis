"""AV/A-6 — bind do full-test-server (FTS_BIND), firewall versionado e start-fts.sh. Sem root, sem rede, sem iptables real:
o iptables é um binário falso com estado em arquivo (IPTABLES_BIN)."""
from __future__ import annotations

import importlib.util
import os
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("fts_bind", ROOT / "scripts" / "full-test-server.py")
fts = importlib.util.module_from_spec(spec); spec.loader.exec_module(fts)
FW = ROOT / "scripts" / "dev" / "fts-firewall.sh"
START = ROOT / "scripts" / "dev" / "start-fts.sh"


# ───────────── resolve_bind_addresses ─────────────
def test_bind_padrao_e_loopback():
    assert fts.resolve_bind_addresses({}) == ["127.0.0.1"]
    assert fts.resolve_bind_addresses({"FTS_BIND": "  "}) == ["127.0.0.1"]


def test_bind_bridge_e_lista_sem_duplicar():
    assert fts.resolve_bind_addresses({"FTS_BIND": "172.17.0.1"}) == ["172.17.0.1"]
    assert fts.resolve_bind_addresses({"FTS_BIND": "127.0.0.1, 172.17.0.1,127.0.0.1"}) == ["127.0.0.1", "172.17.0.1"]


@pytest.mark.parametrize("bad", ["localhost", "999.1.1.1", "abc", "127.0.0.1;rm"])
def test_bind_invalido_derruba_o_boot(bad):
    with pytest.raises(SystemExit):
        fts.resolve_bind_addresses({"FTS_BIND": bad})


def test_bind_todas_as_interfaces_exige_opt_in_explicito():
    for any_ in ("0.0.0.0", "::"):
        with pytest.raises(SystemExit):
            fts.resolve_bind_addresses({"FTS_BIND": any_})
    assert fts.resolve_bind_addresses({"FTS_BIND": "0.0.0.0", "FTS_ALLOW_ANY_BIND": "1"}) == ["0.0.0.0"]


# ───────────── fts-firewall.sh com iptables falso ─────────────
@pytest.fixture()
def fake_ipt(tmp_path):
    state = tmp_path / "rules.txt"; state.write_text("")
    calls = tmp_path / "calls.txt"; calls.write_text("")
    bin_ = tmp_path / "iptables"
    bin_.write_text(f"""#!/usr/bin/env bash
echo "$*" >> {calls}
op="$1"; shift
case "$op" in
  -C) grep -qxF -- "$*" {state} ;;
  -I) shift_pos=""; chain="$1"; shift; if [[ "$1" =~ ^[0-9]+$ ]]; then shift; fi; echo "$chain $*" >> {state} ;;
  -D) grep -vxF -- "$*" {state} > {state}.n || true; mv {state}.n {state} ;;
  *) exit 0 ;;
esac
""")
    bin_.chmod(bin_.stat().st_mode | stat.S_IEXEC)
    env = {**os.environ, "IPTABLES_BIN": str(bin_), "IP6TABLES_BIN": str(tmp_path / "nao-existe6"), "FTS_PORT": "7878"}
    return env, state, calls


def run(cmd, env, *args):
    return subprocess.run([str(cmd), *args], env=env, capture_output=True, text=True)


def test_firewall_check_sem_regras_falha_e_so_le(fake_ipt):
    env, state, calls = fake_ipt
    r = run(FW, env, "--check")
    assert r.returncode == 1 and "AUSENTE" in r.stdout
    ops = {line.split()[0] for line in calls.read_text().splitlines() if line.strip()}
    assert ops == {"-C"}                      # --check NUNCA muta (nem -I nem -D)


def test_firewall_aplica_idempotente_e_check_passa(fake_ipt):
    env, state, _ = fake_ipt
    assert run(FW, env).returncode == 0
    rules = state.read_text().splitlines()
    assert "INPUT -i lo -p tcp --dport 7878 -j ACCEPT" in rules
    assert "INPUT ! -s 172.16.0.0/12 -p tcp --dport 7878 -j DROP" in rules
    assert run(FW, env).returncode == 0       # segunda aplicação não duplica
    assert state.read_text().splitlines().count("INPUT ! -s 172.16.0.0/12 -p tcp --dport 7878 -j DROP") == 1
    assert run(FW, env, "--check").returncode == 0


def test_firewall_remove(fake_ipt):
    env, state, _ = fake_ipt
    run(FW, env)
    assert run(FW, env, "--remove").returncode == 0
    assert state.read_text().strip() == ""
    assert run(FW, env, "--check").returncode == 1


def test_firewall_sem_iptables_sai_2(tmp_path):
    env = {**os.environ, "IPTABLES_BIN": str(tmp_path / "nada")}
    assert run(FW, env, "--check").returncode == 2


# ───────────── start-fts.sh --dry-run ─────────────
def _start_env(tmp_path, **extra):
    base = {k: v for k, v in os.environ.items() if not k.startswith("FTS_")}
    base.update({"FTS_ENV_FILE": str(tmp_path / "nao-existe.env"), "IPTABLES_BIN": str(tmp_path / "nada"), "PATH": os.environ["PATH"]})
    base.update(extra)
    return base


def test_start_recusa_sem_token(tmp_path):
    r = run(START, _start_env(tmp_path), "--dry-run")
    assert r.returncode == 2 and "FTS_AUTH_TOKEN" in r.stderr


def test_start_bind_padrao_loopback_mais_bridge_e_nunca_0000(tmp_path):
    r = run(START, _start_env(tmp_path, FTS_AUTH_TOKEN="t"), "--dry-run")
    assert r.returncode == 0, r.stderr
    bind = r.stdout.split("bind=")[1].split()[0]
    assert bind.startswith("127.0.0.1,") and "0.0.0.0" not in bind
    assert "AVISO" in r.stderr                    # firewall ausente é dito


def test_start_recusa_bind_em_todas_as_interfaces(tmp_path):
    r = run(START, _start_env(tmp_path, FTS_AUTH_TOKEN="t", FTS_BIND="0.0.0.0"), "--dry-run")
    assert r.returncode == 4


def test_start_exige_firewall_quando_pedido(tmp_path):
    r = run(START, _start_env(tmp_path, FTS_AUTH_TOKEN="t", FTS_REQUIRE_FIREWALL="1"), "--dry-run")
    assert r.returncode == 5


def test_start_producao_sem_executor_isolado_recusa_b2(tmp_path):
    r = run(START, _start_env(tmp_path, FTS_AUTH_TOKEN="t", FTS_HOST_ROLE="production"), "--dry-run")
    assert r.returncode == 3 and "B-2" in r.stderr
    ok = run(START, _start_env(tmp_path, FTS_AUTH_TOKEN="t", FTS_HOST_ROLE="production", FTS_ISOLATED_EXECUTOR="1"), "--dry-run")
    assert ok.returncode == 0


def test_start_le_envfile_sem_sobrescrever_o_ambiente(tmp_path):
    envf = tmp_path / "fts.env"
    envf.write_text("# c\nFTS_AUTH_TOKEN=do-arquivo\nFTS_BIND=127.0.0.1\n")
    r = run(START, _start_env(tmp_path, FTS_ENV_FILE=str(envf)), "--dry-run")
    assert r.returncode == 0 and "bind=127.0.0.1 " in r.stdout
    r2 = run(START, _start_env(tmp_path, FTS_ENV_FILE=str(envf), FTS_BIND="172.17.0.1"), "--dry-run")
    assert "bind=172.17.0.1 " in r2.stdout            # o ambiente vence o arquivo
