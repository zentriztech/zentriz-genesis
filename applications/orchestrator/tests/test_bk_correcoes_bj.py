"""BK — correções dos achados do parecer BJ no orchestrator.

B-N1  executor remoto caído ⇒ NUNCA build local no container do Cyborg (fail-closed, sem LLM).
A-N1  filho de card não usa a ponte /cyborg-engineer.
W3    aceite de filho de card: build_rc≠0/−1, erros de tsc NOVOS vs. pai e FULL-TEST reprovada por código.
A-N3  efeitos globais (tree gate, NOT_RUN⇒CANCELLED, flags com API fora) só para filho de card.
Nenhuma chamada real a LLM/executor/rede."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from orchestrator import cyborg_v3 as cy
from orchestrator import runner

NAMES = list(cy.ANALYSIS_NAMES)


def _ok_audit(score=9):
    return {n: cy.AnalysisResult(name=n, ok=True, score=score, findings=[], raw="{}") for n in NAMES}


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    cy._AUDIT_CACHE.clear()
    for k in ("UNTRUSTED_EXECUTOR_URL", "FULL_TEST_SERVER_URL", "CYBORG_ALLOW_LOCAL_BUILD_FALLBACK", "CYBORG_TREE_GATE",
              "FULL_TEST_NOT_RUN_CANCELS", "EFFECTIVE_FLAGS_UNKNOWN_FAIL_CLOSED", "EFFECTIVE_FLAGS_FAIL_CLOSED"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(cy, "_post_dialogue", lambda *a, **k: None)
    yield
    cy._AUDIT_CACHE.clear()


# ───────────── B-N1 ─────────────
def _proj(tmp_path, monkeypatch):
    (tmp_path / "apps").mkdir(exist_ok=True)
    (tmp_path / "apps" / "package.json").write_text('{"name":"x","scripts":{"build":"true"}}', encoding="utf-8")
    monkeypatch.setattr(cy, "_resolve_proj_dir", lambda pid, prod: tmp_path)


def _remote_down(monkeypatch, status=503):
    monkeypatch.setenv("FULL_TEST_SERVER_URL", "http://host.docker.internal:7878")
    monkeypatch.setenv("UNTRUSTED_EXECUTOR_URL", "http://host-b.internal:7878")
    monkeypatch.setattr(cy.executor_bridge, "dispatch", lambda *a, **k: (status, "down"))


def _spy_subprocess(monkeypatch):
    import subprocess
    calls: list = []

    def fake_run(cmd, *a, **k):
        calls.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


def test_bn1_executor_remoto_caido_nao_executa_build_local(monkeypatch, tmp_path):
    _proj(tmp_path, monkeypatch); _remote_down(monkeypatch)
    calls = _spy_subprocess(monkeypatch)
    ctx = cy._collect_context("p1", None)
    assert calls == []                                      # nenhum npm install / tsc / build no container
    assert "executor remoto" in ctx["executor_blocked"] and "CYBORG_ALLOW_LOCAL_BUILD_FALLBACK" in ctx["executor_blocked"]
    assert ctx["build_rc"] == -1


def test_bn1_executor_remoto_com_excecao_de_transporte_tambem_falha_fechado(monkeypatch, tmp_path):
    _proj(tmp_path, monkeypatch); _remote_down(monkeypatch)
    def boom(*a, **k):
        raise OSError("connection refused")
    monkeypatch.setattr(cy.executor_bridge, "dispatch", boom)
    calls = _spy_subprocess(monkeypatch)
    assert "executor_blocked" in cy._collect_context("p1", None) and calls == []


def test_bn1_run_termina_needs_human_sem_gastar_llm(monkeypatch, tmp_path):
    _proj(tmp_path, monkeypatch); _remote_down(monkeypatch)
    calls = _spy_subprocess(monkeypatch)
    llm: list = []
    monkeypatch.setattr(cy, "_call_bedrock", lambda *a, **k: llm.append(1) or "{}")
    monkeypatch.setattr(cy, "_resolve_slot_llm", lambda pid: {"model_id": "m"})
    monkeypatch.setattr(cy, "spawn_engineer", lambda *a, **k: llm.append("engineer") or {"ok": False})
    run = cy._run_cyborg_v3_impl("p1", None, None)
    assert run.final_status == "needs_human" and "ambiente de execução" in run.reason and "Nenhuma rodada de LLM" in run.reason
    assert llm == [] and calls == []


def test_bn1_sem_executor_remoto_mantem_build_local_legado(monkeypatch, tmp_path):
    _proj(tmp_path, monkeypatch)
    monkeypatch.setattr(cy.executor_bridge, "dispatch", lambda *a, **k: (503, "down"))
    calls = _spy_subprocess(monkeypatch)
    ctx = cy._collect_context("p1", None)
    assert "executor_blocked" not in ctx and any(c[:2] == ["npm", "install"] for c in calls)


def test_bn1_override_explicito_permite_build_local_com_executor_remoto(monkeypatch, tmp_path):
    _proj(tmp_path, monkeypatch); _remote_down(monkeypatch)
    monkeypatch.setenv("CYBORG_ALLOW_LOCAL_BUILD_FALLBACK", "1")
    calls = _spy_subprocess(monkeypatch)
    ctx = cy._collect_context("p1", None)
    assert "executor_blocked" not in ctx and any(c[:2] == ["npm", "install"] for c in calls)


# ───────────── A-N1 ─────────────
def _run_env(monkeypatch, *, card, extra_audit=None):
    monkeypatch.setattr(cy, "_resolve_slot_llm", lambda pid: {"model_id": "m"})
    monkeypatch.setattr(cy, "run_prior_audit", lambda *a, **k: _ok_audit())
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: 0)
    monkeypatch.setattr(cy, "cyborg_card_status", lambda pid: card)
    monkeypatch.setattr(cy, "_audit_delta_active", lambda *a, **k: card)
    monkeypatch.setattr(cy, "card_acceptance_inputs", lambda *a, **k: {"notes": []})
    spawned: list = []
    monkeypatch.setattr(cy, "spawn_engineer",
                        lambda *a, **k: spawned.append(1) or {"ok": True, "stdout": "CYBORG_DONE status=DELIVERED url=http://x"})
    return spawned


def test_an1_filho_de_card_nao_usa_ponte_do_engenheiro_e_decide_pela_auditoria(monkeypatch):
    spawned = _run_env(monkeypatch, card=True)
    run = cy._run_cyborg_v3_impl("child", None, None)
    assert spawned == []                                     # `DELIVERED` pela última linha NUNCA é consultado
    assert run.final_status == "delivered" and "aceito por auditoria" in run.reason


def test_an1_legado_continua_usando_a_ponte(monkeypatch):
    spawned = _run_env(monkeypatch, card=False)
    run = cy._run_cyborg_v3_impl("legacy", None, None)
    assert spawned == [1] and run.final_status == "delivered" and run.s3_url == "http://x"


# ───────────── W3 / D-19 ─────────────
TS_A = "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'."
TS_A_MOVED = "src/a.ts(42,9): error TS2322: Type 'string' is not assignable to type 'number'."
TS_B = "src/b.ts(1,1): error TS2554: Expected 2 arguments, but got 1."


def test_w3_parse_ts_errors_ignora_posicao():
    assert cy.parse_ts_errors(TS_A) == cy.parse_ts_errors(TS_A_MOVED)
    assert cy.new_ts_errors(cy.parse_ts_errors(TS_A + "\n" + TS_B), cy.parse_ts_errors(TS_A_MOVED)) \
        == sorted(cy.parse_ts_errors(TS_B))


def _card(**kw):
    base = {"new_tsc_errors": [], "tsc_baseline_unknown": False, "full_test_failure": None, "notes": []}
    base.update(kw)
    return base


def test_w3_aceite_card_build_rc_menos1_e_diferente_de_zero_nao_aceitam():
    a = _ok_audit()
    assert cy.evaluate_audit_acceptance(a, -1)["ideal"] is True                       # legado: permissivo (inalterado)
    for rc in (-1, 1, 2):
        ev = cy.evaluate_audit_acceptance(a, rc, card=_card())
        assert ev["ideal"] is False and ev["weighted"] is False and ev["build_failed"] is True
    assert cy.evaluate_audit_acceptance(a, 0, card=_card())["ideal"] is True


def test_w3_erros_tsc_preexistentes_iguais_aceitam_e_novos_nao():
    a = _ok_audit()
    same = cy.evaluate_audit_acceptance(a, 0, card=_card(notes=["1 erro(s) pré-existente(s)"]))
    assert same["ideal"] is True and same["card_notes"]
    new = cy.evaluate_audit_acceptance(a, 0, card=_card(new_tsc_errors=sorted(cy.parse_ts_errors(TS_B))))
    assert new["ideal"] is False and new["weighted"] is False and "NOVO" in new["card_blockers"][0]
    unk = cy.evaluate_audit_acceptance(a, 0, card=_card(tsc_baseline_unknown=True, child_tsc_errors=["x"]))
    assert unk["ideal"] is False


def test_w3_full_test_reprovada_por_codigo_nao_aceita():
    ev = cy.evaluate_audit_acceptance(_ok_audit(), 0, card=_card(full_test_failure="suíte falhou"))
    assert ev["ideal"] is False and ev["weighted"] is False and "FULL-TEST" in ev["card_blockers"][0]


def _inputs_env(monkeypatch, tmp_path, child_errs, parent_errs, build_block=None, verdict=None):
    monkeypatch.setattr(cy, "_resolve_proj_dir", lambda pid, prod: tmp_path)
    (tmp_path / "docs" / "cyborg").mkdir(parents=True, exist_ok=True)
    blk = {"rc": 0, "type_check_rc": 2 if child_errs else 0, "type_check_errors": sorted(cy.parse_ts_errors("\n".join(child_errs)))}
    blk.update(build_block or {})
    (tmp_path / "docs" / "cyborg" / "audit.json").write_text(json.dumps({"build": blk}), encoding="utf-8")
    if verdict is not None:
        (tmp_path / "docs" / "qa").mkdir(parents=True, exist_ok=True)
        (tmp_path / "docs" / "qa" / "full_test_verdict.json").write_text(json.dumps(verdict), encoding="utf-8")
    monkeypatch.setattr(cy, "_parent_tsc_errors",
                        lambda pid: None if parent_errs is None else sorted(cy.parse_ts_errors("\n".join(parent_errs))))


def test_w3_inputs_pai_com_mesmos_erros_aceita_erro_novo_bloqueia(monkeypatch, tmp_path):
    _inputs_env(monkeypatch, tmp_path, [TS_A], [TS_A_MOVED])
    inp = cy.card_acceptance_inputs("child", None)
    assert inp["new_tsc_errors"] == [] and not inp["tsc_baseline_unknown"]
    assert cy.evaluate_audit_acceptance(_ok_audit(), 0, card=inp)["ideal"] is True
    _inputs_env(monkeypatch, tmp_path, [TS_A, TS_B], [TS_A_MOVED])
    inp = cy.card_acceptance_inputs("child", None)
    assert len(inp["new_tsc_errors"]) == 1 and cy.evaluate_audit_acceptance(_ok_audit(), 0, card=inp)["ideal"] is False


def test_w3_inputs_baseline_do_pai_nao_medida_falha_fechado(monkeypatch, tmp_path):
    _inputs_env(monkeypatch, tmp_path, [TS_A], None)
    assert cy.card_acceptance_inputs("child", None)["tsc_baseline_unknown"] is True


def test_w3_full_test_codigo_bloqueia_infra_e_not_run_so_registram(monkeypatch, tmp_path):
    _inputs_env(monkeypatch, tmp_path, [], [], verdict={"status": "QA_FAIL", "approved": True, "medida_falhou": True, "reason": "3 testes"})
    assert cy.card_acceptance_inputs("c", None)["full_test_failure"] == "3 testes"
    (tmp_path / "docs" / "qa" / "full_test_verdict.json").write_text(
        json.dumps({"status": "NOT_RUN", "not_run": True, "reason": "executor fora"}), encoding="utf-8")
    inp = cy.card_acceptance_inputs("c", None)
    assert inp["full_test_failure"] is None and any("NÃO executada" in n for n in inp["notes"])
    (tmp_path / "docs" / "qa" / "full_test_verdict.json").write_text(
        json.dumps({"status": "QA_FAIL", "approved": True, "unmeasured": True, "reason": "baseline"}), encoding="utf-8")
    assert cy.card_acceptance_inputs("c", None)["full_test_failure"] is None


def test_w3_run_card_com_tsc_novo_termina_needs_human(monkeypatch):
    _run_env(monkeypatch, card=True)
    monkeypatch.setattr(cy, "card_acceptance_inputs", lambda *a, **k: _card(new_tsc_errors=["src/b.ts|TS2554|x"]))
    run = cy._run_cyborg_v3_impl("child", None, None)
    assert run.final_status == "needs_human" and "NOVO" in run.reason


def test_w3_run_card_com_build_rc_menos1_termina_needs_human_e_legado_mantem(monkeypatch):
    _run_env(monkeypatch, card=True)
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: -1)
    assert cy._run_cyborg_v3_impl("child", None, None).final_status == "needs_human"
    _run_env(monkeypatch, card=False)
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: -1)
    monkeypatch.setattr(cy, "spawn_engineer", lambda *a, **k: {"ok": False, "error": "sem bridge"})
    assert cy._run_cyborg_v3_impl("legacy", None, None).final_status == "delivered"   # comportamento anterior


# ───────────── A-N3 ─────────────
def _tree_run(monkeypatch, tmp_path, card):
    apps = tmp_path / "apps"; apps.mkdir(exist_ok=True)
    (apps / "package-lock.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(cy, "_resolve_proj_dir", lambda pid, prod: tmp_path)
    monkeypatch.setattr(cy, "cyborg_card_status", lambda pid: card)
    seen: list = []
    monkeypatch.setattr(cy, "snapshot_apps_tree", lambda d: seen.append(d) or {})
    monkeypatch.setattr(cy, "_cyborg_evolution_scope", lambda pid: None)
    monkeypatch.setattr(cy, "audit_apps_tree_changes", lambda *a, **k: ([], []))
    monkeypatch.setattr(cy, "_run_cyborg_v3_impl", lambda *a, **k: cy.CyborgV3Run(project_id="p", tenant_id=None, prod_id=None, started_at=0, model_id="m"))
    cy.run_cyborg_v3("p", None, None)
    return seen


def test_an3_tree_gate_so_em_card_e_override(monkeypatch, tmp_path):
    assert _tree_run(monkeypatch, tmp_path, True) != []
    assert _tree_run(monkeypatch, tmp_path, False) == []                 # legado: sem remover/restaurar lockfile
    monkeypatch.setenv("CYBORG_TREE_GATE", "on")
    assert _tree_run(monkeypatch, tmp_path, False) != []
    monkeypatch.setenv("CYBORG_TREE_GATE", "off")
    assert _tree_run(monkeypatch, tmp_path, True) == []
    monkeypatch.delenv("CYBORG_TREE_GATE")
    assert _tree_run(monkeypatch, tmp_path, None) != []                   # origem desconhecida: mais rígido


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("API_BASE_URL", "http://api.invalid"); monkeypatch.setenv("GENESIS_API_TOKEN", "t")
    runner._CARD_CHILD_CACHE.clear()
    yield
    runner._CARD_CHILD_CACHE.clear()


def _declare(monkeypatch, tmp_path, project_id, ctx=None):
    updates: list = []
    monkeypatch.setattr(runner, "_update_task", lambda pid, tid, **kw: updates.append(kw["status"]))
    monkeypatch.setattr(runner, "_post_step", lambda msg, rid: None)
    st = runner._declare_full_test_not_run(project_id, "r", "executor fora", "cmd", tmp_path, pipeline_ctx=ctx)
    return st, updates


def test_an3_full_test_not_run_cancelled_so_em_card(monkeypatch, tmp_path, api):
    monkeypatch.setattr(runner, "_api_get", lambda path: ({"extra": {"evolution": True}}, 200))
    st, up = _declare(monkeypatch, tmp_path, "legacy")
    assert st == "ASSIGNED" and up == ["ASSIGNED"]                         # legado: status anterior
    assert json.loads((tmp_path / "docs" / "qa" / "full_test_verdict.json").read_text())["not_run"] is True
    st, up = _declare(monkeypatch, tmp_path, "c", SimpleNamespace(is_card_child=True, card_id=None))
    assert st == "CANCELLED" and up == ["CANCELLED"]
    monkeypatch.setenv("FULL_TEST_NOT_RUN_CANCELS", "all")
    assert _declare(monkeypatch, tmp_path, "legacy")[0] == "CANCELLED"


def test_an3_api_fora_no_inicio_legado_degrada_card_conhecido_falha_fechado(monkeypatch, api):
    def down(path):
        if path.endswith("/effective-flags"):
            return None, 503
        raise OSError("api fora")                                         # nem a origem do projeto é legível
    monkeypatch.setattr(runner, "_api_get", down)
    runner._EFFECTIVE_FLAGS_CACHE.clear()
    assert runner._attachments_strict("unknown-origin") is False          # antes: SpecReadError derrubava a run
    monkeypatch.setenv("EFFECTIVE_FLAGS_UNKNOWN_FAIL_CLOSED", "1")
    runner._EFFECTIVE_FLAGS_CACHE.clear()
    with pytest.raises(runner.SpecReadError):
        runner._attachments_strict("unknown-origin")
    monkeypatch.delenv("EFFECTIVE_FLAGS_UNKNOWN_FAIL_CLOSED")
    runner._CARD_CHILD_CACHE["card-known"] = True                         # origem já conhecida como card ⇒ fecha
    runner._EFFECTIVE_FLAGS_CACHE.clear()
    with pytest.raises(runner.SpecReadError):
        runner._attachments_strict("card-known")
