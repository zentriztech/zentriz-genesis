#!/usr/bin/env python3
"""Roda o pytest tolerando, de forma explícita e rastreável, as falhas conhecidas de ambiente.

Uso (da raiz do repo):
    python scripts/ci/pytest_known_failures.py [--known ARQ] [--strict-stale] -- <args do pytest>

Regras:
  * falha (failed/error, em setup/call/teardown) que NÃO está em `known-env-failures.txt` => exit 1;
  * falha listada => tolerada, mas impressa;
  * item da lista que agora passou => aviso (lista obsoleta); com --strict-stale vira exit 1;
  * erro de coleta ou pytest abortado (exit code 2/3/4) => exit 1 (nunca mascarado).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pytest

DEFAULT_KNOWN = Path("applications/orchestrator/tests/known-env-failures.txt")


def load_known(path: Path) -> set[str]:
    out: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.add(line)
    return out


class Collector:
    def __init__(self) -> None:
        self.failed: set[str] = set()
        self.passed: set[str] = set()
        self.collect_errors: list[str] = []

    def pytest_collectreport(self, report):  # noqa: ANN001
        if report.failed:
            self.collect_errors.append(report.nodeid)

    def pytest_runtest_logreport(self, report):  # noqa: ANN001
        if report.failed:
            self.failed.add(report.nodeid)
        elif report.when == "call" and report.passed:
            self.passed.add(report.nodeid)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--known", type=Path, default=DEFAULT_KNOWN)
    ap.add_argument("--strict-stale", action="store_true")
    ap.add_argument("pytest_args", nargs=argparse.REMAINDER)
    ns = ap.parse_args()
    args = [a for a in ns.pytest_args if a != "--"]

    known = load_known(ns.known)
    col = Collector()
    code = pytest.main(args, plugins=[col])

    print("\n=== pytest_known_failures ===")
    print(f"pytest exit code: {int(code)} | falhas: {len(col.failed)} | conhecidas na lista: {len(known)}")
    if col.collect_errors:
        print(f"ERRO DE COLETA (nunca tolerado): {sorted(col.collect_errors)}")
        return 1
    if int(code) in (2, 3, 4):  # interrompido / erro interno / uso incorreto
        print("pytest não concluiu a execução normalmente.")
        return 1

    new = sorted(col.failed - known)
    tolerated = sorted(col.failed & known)
    stale = sorted(known & col.passed)
    for n in tolerated:
        print(f"TOLERADA (conhecida): {n}")
    for n in stale:
        print(f"AVISO lista obsoleta (agora passa): {n}")
    for n in new:
        print(f"NOVA FALHA (fora da lista): {n}")
    if new:
        return 1
    if stale and ns.strict_stale:
        return 1
    print(f"OK: 0 falhas novas; {len(tolerated)} conhecidas toleradas.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
