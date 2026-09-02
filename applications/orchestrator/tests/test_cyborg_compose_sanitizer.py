"""
Testes do GUARDRAIL de compose gerado do Cyborg (`_scan_generated_compose`).

O Cyborg roda `docker compose up --build` sobre um docker-compose.yml produzido pela
pipeline autônoma (LLM) — conteúdo NÃO confiável — e o daemon Docker é o do HOST
(socket montado no container cyborg). Sem esta checagem, um compose com `privileged`,
`pid: host`, `devices`, ou bind-mount de path do host (ex.: /var/run/docker.sock, /:/host)
daria escape para root no host.

Contrato travado por estes testes (fail-closed):
  - compose LIMPO (só volumes nomeados / binds relativos internos / ports) ⇒ ZERO violações
    (não regride os produtos atuais, todos bem-comportados).
  - QUALQUER primitivo perigoso ⇒ pelo menos uma violação (o Cyborg NÃO sobe o stack).
  - compose ilegível / não parseável ⇒ violação (fail-closed: não verificável = não sobe).

Sem custo de LLM — exercita a função pura diretamente.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from orchestrator.zentriz_cyborg import (
    _compose_source_is_host_bind,
    _scan_generated_compose,
)


def _write(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "docker-compose.yml"
    p.write_text(text, encoding="utf-8")
    return p


# ─────────────────────────── Compose LIMPO — não regride ───────────────────────────

def test_clean_compose_is_safe(tmp_path: Path) -> None:
    """Compose típico de produto (named volume + bind relativo interno + ports) = seguro."""
    compose = """
services:
  api:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - appdata:/app/data
      - ./config:/app/config
    environment:
      - NODE_ENV=production
  db:
    image: postgres:16-alpine
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  appdata:
  dbdata:
"""
    assert _scan_generated_compose(_write(tmp_path, compose)) == []


def test_named_volume_with_keys_mount_is_safe(tmp_path: Path) -> None:
    """Espelha o produto real 'frotacores' (volume nomeado montado em /app/keys)."""
    compose = """
services:
  api:
    build: .
    volumes:
      - frotacores_keys:/app/keys
volumes:
  frotacores_keys:
"""
    assert _scan_generated_compose(_write(tmp_path, compose)) == []


# ─────────────────────────── Primitivos perigosos — bloqueiam ───────────────────────────

def test_docker_sock_bind_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("docker.sock" in x for x in v)


def test_privileged_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    privileged: true
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("privileged" in x for x in v)


def test_root_bind_mount_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    volumes:
      - /:/host
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("bind-mount de host" in x for x in v)


def test_pid_host_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    pid: host
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("pid=host" in x for x in v)


def test_network_mode_host_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    network_mode: host
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("network_mode=host" in x for x in v)


def test_cap_add_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    cap_add:
      - SYS_ADMIN
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("cap_add" in x for x in v)


def test_devices_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    devices:
      - /dev/sda:/dev/sda
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("devices" in x for x in v)


def test_seccomp_unconfined_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    security_opt:
      - seccomp:unconfined
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("security_opt" in x for x in v)


def test_long_form_bind_to_proc_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    volumes:
      - type: bind
        source: /proc
        target: /host/proc
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("bind-mount de host" in x for x in v)


def test_named_volume_bind_to_host_device_is_blocked(tmp_path: Path) -> None:
    """Escape disfarçado: volume nomeado com driver_opts fazendo bind ao host."""
    compose = """
services:
  api:
    build: .
    volumes:
      - sneaky:/app/host
volumes:
  sneaky:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("bind ao host device" in x for x in v)


def test_escaping_relative_bind_is_blocked(tmp_path: Path) -> None:
    compose = """
services:
  api:
    build: .
    volumes:
      - ../../etc:/app/etc
"""
    v = _scan_generated_compose(_write(tmp_path, compose))
    assert v and any("bind-mount de host" in x for x in v)


# ─────────────────────────── Fail-closed em entradas inválidas ───────────────────────────

def test_unparseable_compose_is_blocked(tmp_path: Path) -> None:
    v = _scan_generated_compose(_write(tmp_path, "services:\n  api:\n  - : : invalid : yaml : ["))
    assert v  # não verificável ⇒ bloqueia


def test_missing_file_is_blocked(tmp_path: Path) -> None:
    v = _scan_generated_compose(tmp_path / "inexistente.yml")
    assert v  # não conseguiu ler ⇒ bloqueia


# ─────────────────────────── Helper de classificação de source ───────────────────────────

@pytest.mark.parametrize(
    "source,is_host",
    [
        ("/var/run/docker.sock", True),
        ("/", True),
        ("~/data", True),
        ("../escape", True),
        ("a/../../escape", True),
        ("named_volume", False),
        ("./local", False),
        ("data/sub", False),
        ("", False),
    ],
)
def test_source_host_bind_classification(source: str, is_host: bool) -> None:
    assert _compose_source_is_host_bind(source) is is_host
