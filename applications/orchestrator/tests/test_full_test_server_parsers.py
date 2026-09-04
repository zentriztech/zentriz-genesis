"""Bloco 3 F3a — parsers puros do /run-tests (scripts/full-test-server.py) com fixtures jest/vitest, junit e go."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("fts", ROOT / "scripts" / "full-test-server.py")
fts = importlib.util.module_from_spec(spec); spec.loader.exec_module(fts)  # import-safe: main guard


def test_parse_jest_json_ids_relativos_e_status(tmp_path: Path):
    app = tmp_path / "apps"
    parsed = {"numTotalTests": 3, "numPassedTests": 1, "numFailedTests": 1, "numPendingTests": 1, "numTodoTests": 0,
              "testResults": [{"name": str(app / "src" / "a.test.ts"), "assertionResults": [
                  {"fullName": "A ok", "status": "passed"}, {"fullName": "A falha", "status": "failed"}, {"title": "A pendente", "status": "pending"}]}]}
    r = fts._parse_jest_json(parsed, app)
    assert (r["total"], r["passed"], r["failed"], r["skipped"], r["no_tests"]) == (3, 1, 1, 1, False)
    assert r["tests"] == [{"id": "src/a.test.ts::A ok", "status": "passed"}, {"id": "src/a.test.ts::A falha", "status": "failed"},
                          {"id": "src/a.test.ts::A pendente", "status": "skipped"}]
    assert fts._parse_jest_json({"numTotalTests": 0, "testResults": []}, app)["no_tests"] is True


def test_parse_junit_status_por_filho(tmp_path: Path):
    x = tmp_path / "j.xml"
    x.write_text('<testsuites><testsuite><testcase classname="tests.test_a" name="test_ok"/>'
                 '<testcase classname="tests.test_a" name="test_fail"><failure message="x"/></testcase>'
                 '<testcase classname="tests.test_b" name="test_err"><error message="boom"/></testcase>'
                 '<testcase classname="tests.test_b" name="test_skip"><skipped/></testcase></testsuite></testsuites>')
    r = fts._parse_junit(str(x))
    assert (r["passed"], r["failed"], r["skipped"], r["total"], r["no_tests"]) == (1, 2, 1, 4, False)
    assert {t["id"]: t["status"] for t in r["tests"]} == {"tests.test_a::test_ok": "passed", "tests.test_a::test_fail": "failed",
                                                          "tests.test_b::test_err": "failed", "tests.test_b::test_skip": "skipped"}


def test_parse_go_json_ignora_eventos_de_pacote():
    lines = [json.dumps(e) for e in [
        {"Action": "run", "Package": "m/p", "Test": "TestA"}, {"Action": "output", "Package": "m/p", "Test": "TestA", "Output": "..."},
        {"Action": "pass", "Package": "m/p", "Test": "TestA"}, {"Action": "fail", "Package": "m/p", "Test": "TestB"},
        {"Action": "skip", "Package": "m/q"},  # pacote sem testes (sem Test) → ignorado
        {"Action": "skip", "Package": "m/p", "Test": "TestC"}, {"Action": "pass", "Package": "m/p"},
    ]]
    r = fts._parse_go_json("\n".join(lines) + "\nlixo não-json\n")
    assert (r["passed"], r["failed"], r["skipped"], r["total"]) == (1, 1, 1, 3)
    assert {t["id"]: t["status"] for t in r["tests"]} == {"m/p::TestA": "passed", "m/p::TestB": "failed", "m/p::TestC": "skipped"}
    assert fts._parse_go_json('{"Action":"skip","Package":"m/q"}')["no_tests"] is True
