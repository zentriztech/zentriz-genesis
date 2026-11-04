"""Rodada real 4.5c (BA) — Cyborg FAIL-CLOSED.

D-1: análise que NÃO executou (402 `REPEAT_PAYLOAD`/erro/vazio) não é "0 achados": aceite exige um mínimo
     de análises VÁLIDAS e reauditar árvore idêntica não reenvia o payload idêntico ao Guard.
D-5: cada rodada de correção passa por gate de integridade (árvore/escopo + build/tipos) e é REVERTIDA se
     quebrar o build/tipos (TS2554 do `CircuitBreaker`) ou se build/tipos não puderem ser verificados.
Nenhuma chamada real a LLM/executor."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from orchestrator import cyborg_v3 as cy
from orchestrator import project_storage as ps

NAMES = list(cy.ANALYSIS_NAMES)


def _ok(name, score=8, findings=None):
    return cy.AnalysisResult(name=name, ok=True, score=score, findings=findings or [], raw="{}")


def _denied(name):
    return cy.AnalysisResult(name=name, ok=False, score=0,
                             error='agents /invoke/raw 402: {"code":"REPEAT_PAYLOAD"}')


def d1_audit():
    """O que a 4.5c gravou em audit.json: só a4 rodou; a1,a2,a3,a5 = 402 REPEAT_PAYLOAD."""
    return {n: (_ok(n, 8) if n == "a4_ux_completude" else _denied(n)) for n in NAMES}


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    cy._AUDIT_CACHE.clear()
    for k in ("CYBORG_AUDIT_MIN_VALID", "CYBORG_ROUND_GATE", "CYBORG_AUDIT_MIN_AVG"):
        monkeypatch.delenv(k, raising=False)
    yield
    cy._AUDIT_CACHE.clear()


# ───────────── D-1: validade e aceite ─────────────
def test_analise_com_402_ou_vazia_e_invalida_mas_veredito_ruim_e_valido():
    assert not cy.analysis_is_valid(_denied("a1"))
    assert not cy.analysis_is_valid(cy.AnalysisResult(name="a1", ok=False, score=0))        # vazia
    assert not cy.analysis_is_valid(None)
    assert cy.analysis_is_valid(cy.AnalysisResult(name="a1", ok=False, score=2, raw="{}",
                                                  findings=[cy.Finding("BLOCKER", "x", "y")]))


def test_aceite_recusa_quando_4_de_5_analises_falharam_com_402():
    ev = cy.evaluate_audit_acceptance(d1_audit(), 0)
    assert ev["insufficient"] is True
    assert ev["ideal"] is False and ev["weighted"] is False
    assert ev["validity"]["valid"] == 1 and ev["validity"]["total"] == 5
    assert set(ev["validity"]["invalid"]) == {"a1_coerencia_estrutural", "a2_fidelidade_spec",
                                              "a3_build_runtime", "a5_dominio"}


def test_aceite_minimo_documentado_4_de_5_e_configuravel(monkeypatch):
    four = {n: (_ok(n) if n != NAMES[0] else _denied(n)) for n in NAMES}
    assert cy.evaluate_audit_acceptance(four, 0)["ideal"] is True            # 4/5 = mínimo padrão
    three = {n: (_ok(n) if n in NAMES[:3] else _denied(n)) for n in NAMES}
    assert cy.evaluate_audit_acceptance(three, 0)["ideal"] is False          # 3/5 < 4
    monkeypatch.setenv("CYBORG_AUDIT_MIN_VALID", "5")
    assert cy.evaluate_audit_acceptance(four, 0)["ideal"] is False
    assert cy.evaluate_audit_acceptance({n: _ok(n) for n in NAMES}, 0)["ideal"] is True


def test_run_cyborg_v3_termina_needs_human_com_auditoria_insuficiente(monkeypatch):
    """Reproduz cyborg_v3 ~2172: build 0, 'média 8,0 (só a4)', '0 BLOCKER' ⇒ antes DELIVERED."""
    monkeypatch.setattr(cy, "_resolve_slot_llm", lambda pid: {"model_id": "m"})
    monkeypatch.setattr(cy, "_post_dialogue", lambda *a, **k: None)
    monkeypatch.setattr(cy, "run_prior_audit", lambda *a, **k: d1_audit())
    monkeypatch.setattr(cy, "spawn_engineer", lambda *a, **k: {"ok": False, "error": "sem bridge"})
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: 0)
    run = cy._run_cyborg_v3_impl("p1", None, None)
    assert run.final_status == "needs_human"
    assert "AUDITORIA INSUFICIENTE" in run.reason and "1/5" in run.reason


def _audit_env(monkeypatch, tmp_path, calls):
    monkeypatch.setattr(cy, "_collect_context", lambda pid, prod: {"spec": "S", "build_rc": 0})
    monkeypatch.setattr(cy, "_load_prompt", lambda name: f"prompt {name}")
    monkeypatch.setattr(cy, "_post_dialogue", lambda *a, **k: None)
    monkeypatch.setattr(cy, "_resolve_proj_dir", lambda pid, prod: tmp_path)

    def fake_call(prompt, ctx, model_id):
        calls.append(prompt)
        return json.dumps({"ok": True, "score": 9, "findings": []})
    monkeypatch.setattr(cy, "_call_bedrock", fake_call)


def test_reauditar_arvore_identica_nao_reenvia_payload_identico(monkeypatch, tmp_path):
    calls: list = []
    _audit_env(monkeypatch, tmp_path, calls)
    a1 = cy.run_prior_audit("p1", None, "m")
    a2 = cy.run_prior_audit("p1", None, "m")      # ex.: após reverter uma rodada (mesmo hash)
    a3 = cy.run_prior_audit("p1", None, "m")
    assert len(calls) == 5                         # só a 1ª auditoria foi ao Guard; sem cache seriam 15
    assert all(cy.analysis_is_valid(ar) for ar in a3.values()) and a2.keys() == a1.keys()
    assert json.loads((tmp_path / "docs/cyborg/audit.json").read_text())["validity"]["valid"] == 5


def test_contexto_diferente_reaudita_e_402_nunca_e_mascarado(monkeypatch, tmp_path):
    calls: list = []
    _audit_env(monkeypatch, tmp_path, calls)
    ctx = {"spec": "S"}
    monkeypatch.setattr(cy, "_collect_context", lambda pid, prod: dict(ctx, build_rc=0))
    cy.run_prior_audit("p1", None, "m")
    ctx["spec"] = "S2"                             # árvore mudou ⇒ pergunta nova
    cy.run_prior_audit("p1", None, "m")
    assert len(calls) == 10

    def denied(prompt, ctx_, model_id):            # Guard soberano: 402 vira análise INVÁLIDA, sem cache nem mascaramento
        raise RuntimeError('agents /invoke/raw 402: {"code":"REPEAT_PAYLOAD"}')
    cy._AUDIT_CACHE.clear()
    monkeypatch.setattr(cy, "_call_bedrock", denied)
    res = cy.run_prior_audit("p1", None, "m")
    assert all(not cy.analysis_is_valid(ar) for ar in res.values())
    assert all("402" in ar.error for ar in res.values())
    assert cy._AUDIT_CACHE == {}


# ───────────── D-5: gate de integridade por rodada ─────────────
def _res(b=0, t=0, bo="", to=""):
    return {"build_rc": b, "build_output": bo, "type_check_rc": t, "type_check_output": to}


def test_tsc_indisponivel_em_projeto_ts_falha_fechado_com_mensagem():
    s = cy.summarize_build_check(_res(0, -1), ts_project=True)
    assert s["verified"] is False and s["ok"] is False and "tsc indisponível" in s["reason"]
    s2 = cy.summarize_build_check(_res(0, 1, to="sh: tsc: not found"), ts_project=True)
    assert s2["verified"] is False
    assert cy.summarize_build_check(_res(0, -1), ts_project=False)["ok"] is True       # sem tsconfig: n/a
    assert cy.summarize_build_check(_res(0, 0, bo="nest: not found"), ts_project=False)["verified"] is False
    assert cy.summarize_build_check(_res(-1, -1), ts_project=False)["verified"] is False
    assert cy.summarize_build_check(None, ts_project=True)["verified"] is False


def test_evaluate_round_gate_regressao_e_nao_verificavel():
    ok = cy.summarize_build_check(_res(0, 0), ts_project=True)
    broke = cy.summarize_build_check(_res(1, 2, to="a.ts(1,1): error TS2554: Expected 2 arguments"), ts_project=True)
    assert cy.evaluate_round_gate(ok, ok) == (True, "")
    acc, why = cy.evaluate_round_gate(ok, broke)
    assert not acc and "QUEBROU" in why
    worse = cy.summarize_build_check(_res(1, 2, to="error TS1\nerror TS2\nerror TS3"), ts_project=True)
    acc, why = cy.evaluate_round_gate(broke, worse)
    assert not acc and "AUMENTOU" in why
    assert cy.evaluate_round_gate(broke, broke)[0] is True                  # já quebrado, não piorou
    unverif = cy.summarize_build_check(_res(0, -1), ts_project=True)
    assert cy.evaluate_round_gate(ok, unverif)[0] is False


def _ts_apps(tmp_path):
    apps = tmp_path / "p1" / "apps"
    (apps / "src").mkdir(parents=True)
    (apps / "package.json").write_text('{"name":"x"}')
    (apps / "tsconfig.json").write_text("{}")
    (apps / "src/circuit-breaker.ts").write_text(
        "export class CircuitBreaker { constructor(public threshold: number) {} }\n"
        "export const cb = new CircuitBreaker(3);\n")
    return apps


def test_round_integrity_gate_arvore_build_e_nao_verificavel(tmp_path):
    apps = _ts_apps(tmp_path)
    before = cy.snapshot_apps_tree(apps)
    good = lambda pid, prod: _res(0, 0)
    assert cy.round_integrity_gate("p1", None, apps, before, [], None, check=good)[0] is True
    no_tsc = lambda pid, prod: _res(0, -1)
    ok, why, _ = cy.round_integrity_gate("p1", None, apps, before, [], None, check=no_tsc)
    assert not ok and "tsc indisponível" in why

    def boom(pid, prod):
        raise RuntimeError("executor fora")
    ok, why, _ = cy.round_integrity_gate("p1", None, apps, before, [], None, check=boom)
    assert not ok and "não verificáveis" in why
    (apps / "src/other.ts").write_text("export const x = 1\n")             # fora do escopo do RFC
    ok, why, _ = cy.round_integrity_gate("p1", None, apps, before, ["src/health/*.ts"], None, check=good)
    assert not ok and "gate de árvore" in why and "other.ts" in why


BAD_CTOR = ("export class CircuitBreaker { constructor(public threshold: number, public timeoutMs: number) {} }\n"
            "export const cb = new CircuitBreaker(3);\n")      # TS2554 em `new CircuitBreaker(3)`


def _rework_env(monkeypatch, tmp_path, dev_prompts, check):
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path))
    monkeypatch.setattr(ps, "_root", lambda: tmp_path)
    monkeypatch.setenv("CYBORG_BUILD_RECOVERY_ROUNDS", "0")

    def fake_http(method, url, body=None, timeout=60):
        if method == "GET" and url.endswith("/api/projects/p1"):
            return 200, json.dumps({"extra": {}})
        if url.endswith("/invoke/raw"):
            dev_prompts.append(body["user_message"])
            return 200, json.dumps({"response": json.dumps({"artifacts": [
                {"path": "src/circuit-breaker.ts", "content": BAD_CTOR}]})})
        return 200, "{}"
    audits = {"n": 0}
    reaudit_calls = []

    def fake_audit(*a, **k):
        reaudit_calls.append(1)
        return {"a": cy.AnalysisResult(name="a", ok=True, score=10, raw="{}")}
    monkeypatch.setattr(cy, "_http", fake_http)
    monkeypatch.setattr(cy, "_collect_context", lambda pid, prod: {})
    monkeypatch.setattr(cy, "run_prior_audit", fake_audit)
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: 0)
    monkeypatch.setattr(cy, "_resolve_proj_dir", lambda pid, prod: tmp_path / pid)
    monkeypatch.setattr(cy, "run_build_check", check)
    return reaudit_calls


def _blocker_audit():
    return {"a": cy.AnalysisResult(name="a", ok=False, score=0, raw="{}",
                                   findings=[cy.Finding("BLOCKER", "cb", "implementar timeout")])}


def test_rework_reverte_rodada_que_quebra_o_construtor_do_circuit_breaker(monkeypatch, tmp_path):
    apps = _ts_apps(tmp_path)
    orig = (apps / "src/circuit-breaker.ts").read_text()
    prompts: list = []

    def tsc(pid, prod):                           # "tsc" simulado: lê o arquivo de verdade
        src = (apps / "src/circuit-breaker.ts").read_text()
        if "timeoutMs: number" in src and "new CircuitBreaker(3)" in src:
            return _res(1, 2, to="src/circuit-breaker.ts(2,16): error TS2554: Expected 2 arguments, but got 1.")
        return _res(0, 0)
    reaudit = _rework_env(monkeypatch, tmp_path, prompts, tsc)
    out = cy.autonomous_rework("p1", None, _blocker_audit(), "m", max_rounds=2)
    assert (apps / "src/circuit-breaker.ts").read_text() == orig           # revertida
    assert len(out["gate_reverts"]) == 2 and "TS2554" in out["gate_reverts"][0]
    assert reaudit == []                                                    # nem pagou re-auditoria
    assert "REVERTIDAS" in prompts[1] and "TS2554" not in prompts[0]        # 2ª rodada sabe por quê


def test_rework_reverte_quando_tsc_indisponivel_falha_fechado(monkeypatch, tmp_path):
    apps = _ts_apps(tmp_path)
    orig = (apps / "src/circuit-breaker.ts").read_text()
    calls = {"n": 0}

    def tsc(pid, prod):
        calls["n"] += 1
        return _res(0, 0) if calls["n"] == 1 else _res(0, 127, to="sh: 1: tsc: not found")
    _rework_env(monkeypatch, tmp_path, [], tsc)
    out = cy.autonomous_rework("p1", None, _blocker_audit(), "m", max_rounds=1)
    assert (apps / "src/circuit-breaker.ts").read_text() == orig
    assert "tsc indisponível" in out["gate_reverts"][0]


def test_rework_mantem_rodada_que_nao_quebra_e_gate_off_restaura_legado(monkeypatch, tmp_path):
    apps = _ts_apps(tmp_path)
    _rework_env(monkeypatch, tmp_path, [], lambda pid, prod: _res(0, 0))
    out = cy.autonomous_rework("p1", None, _blocker_audit(), "m", max_rounds=1)
    assert out["gate_reverts"] == [] and "timeoutMs" in (apps / "src/circuit-breaker.ts").read_text()
    assert cy.round_gate_enabled() is True
    monkeypatch.setenv("CYBORG_ROUND_GATE", "off")
    assert cy.round_gate_enabled() is False


def test_rework_reverte_reauditoria_insuficiente(monkeypatch, tmp_path):
    apps = _ts_apps(tmp_path)
    orig = (apps / "src/circuit-breaker.ts").read_text()
    _rework_env(monkeypatch, tmp_path, [], lambda pid, prod: _res(0, 0))
    monkeypatch.setattr(cy, "run_prior_audit", lambda *a, **k: d1_audit())   # 402 em 4 de 5
    out = cy.autonomous_rework("p1", None, _blocker_audit(), "m", max_rounds=1)
    assert (apps / "src/circuit-breaker.ts").read_text() == orig
    assert "re-auditoria insuficiente" in out["gate_reverts"][0]
    assert out["ok"] is False
