"""Parecer AV — A-1 (`_is_qa_pass` por substring) e A-4 (mudanças globais da Fase 4 não podem alterar o legado).

A-4: regras novas valem para FILHO DE CARD (`extra.evolution_origin == "card"`); legado/projeto comum mantém o
comportamento anterior. Cada regra tem env de override (documentado em runner.py `_a4_rule_applies`)."""
from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest

from orchestrator import context_files, runner


# ───────────────────────── A-1 ─────────────────────────

@pytest.mark.parametrize("summary", [
    "Falha: o token JWT não é validado", "broken build", "not ok", "NOK", "look at this book",
    "[type_policy_fingerprint_fail: web] missing strong tokens ['x']", "Não aprovado", "não passou",
])
def test_a1_texto_livre_nunca_aprova(summary):
    assert runner._is_qa_pass({"status": "QA_FAIL", "summary": summary}) is False
    assert runner._is_qa_pass({"status": "", "summary": summary}) is False      # sem status estruturado: summary não promove
    assert runner._is_qa_pass({"summary": summary}) is False


@pytest.mark.parametrize("status", ["not ok", "NOK", "QA_FAIL", "broken", "token", "bypass", "failed", "not_pass", "QA_NOT_PASS", "rejected"])
def test_a1_status_de_reprovacao_ou_ambiguo_nao_aprova(status):
    assert runner._is_qa_pass({"status": status, "summary": "aprovado ok passou"}) is False


@pytest.mark.parametrize("status", ["QA_PASS", "qa_pass", "PASS", "passed", "OK", "approved", "aprovado", "success", "DONE", "QA-PASS", " Pass "])
def test_a1_veredito_estruturado_aprova(status):
    assert runner._is_qa_pass({"status": status, "summary": "token"}) is True


def test_a1_campo_verdict_quando_status_vazio_e_sem_veredito_valido_nunca_aprova():
    assert runner._is_qa_pass({"verdict": "PASS"}) is True
    assert runner._is_qa_pass({"verdict": "FAIL"}) is False
    assert runner._is_qa_pass({"status": "BLOCKED", "summary": "ok", "validator_pass": False}) is False


# ───────────────────────── A-4 ─────────────────────────

LEGACY = "aaaaaaaa-0000-0000-0000-000000000001"
CARDP = "bbbbbbbb-0000-0000-0000-000000000002"


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("API_BASE_URL", "http://api.invalid")
    monkeypatch.setenv("GENESIS_API_TOKEN", "t")
    for k in ("QA_NO_VERDICT_BLOCKS", "EVOLUTION_P2P_REQUIRED", "EVOLUTION_P2P_REQUIRED_LEGACY", "CONTEXT_CEILING_ENFORCE",
              "EFFECTIVE_FLAGS_FAIL_CLOSED", "SEED_PARTIAL_STRICT", "EVOLUTION_P2P_MODE"):
        monkeypatch.delenv(k, raising=False)
    runner._CARD_CHILD_CACHE.clear()
    state = {"flags": (500, None)}

    def get(path):
        if path.endswith("/effective-flags"):
            st, body = state["flags"]
            return body, st
        pid = path.rsplit("/", 1)[-1]
        extra = {"evolution": True, "evolution_origin": "card"} if pid == CARDP else {"evolution": True}
        return {"id": pid, "extra": extra}, 200
    monkeypatch.setattr(runner, "_api_get", get)
    yield state
    runner._CARD_CHILD_CACHE.clear()


def test_a4_is_card_child_so_pelo_extra(api):
    assert runner._is_card_child(CARDP) is True
    assert runner._is_card_child(LEGACY) is False
    assert runner._is_card_child(LEGACY, SimpleNamespace(card_id="x")) is True
    assert runner._is_card_child(None) is False


@pytest.mark.parametrize("env_name", ["QA_NO_VERDICT_BLOCKS", "CONTEXT_CEILING_ENFORCE", "EFFECTIVE_FLAGS_FAIL_CLOSED", "SEED_PARTIAL_STRICT"])
def test_a4_regra_legado_x_card_e_overrides(api, monkeypatch, env_name):
    assert runner._a4_rule_applies(env_name, CARDP) is True
    assert runner._a4_rule_applies(env_name, LEGACY) is False
    monkeypatch.setenv(env_name, "all")
    assert runner._a4_rule_applies(env_name, LEGACY) is True
    monkeypatch.setenv(env_name, "off")
    assert runner._a4_rule_applies(env_name, CARDP) is False


def test_a4_a_qa_sem_veredito_so_bloqueia_no_card():
    src = inspect.getsource(runner)
    assert 'not _qa_produced_verdict(qa_response) and _a4_rule_applies("QA_NO_VERDICT_BLOCKS"' in src
    # legado: sem veredito cai no ramo QA_FAIL/rework de antes (nunca aprova)
    assert runner._is_qa_pass({"status": "BLOCKED", "summary": "ok", "_refusal": True}) is False


def _ctx(bl, **kw):
    return SimpleNamespace(evolution_baseline=bl, **kw)


@pytest.mark.parametrize("bl", [{"no_tests": True, "status": "ok"}, {"status": "error", "error": "Connection refused"}])
def test_a4_b_p2p_baseline_nao_medida_reprova_card_e_nao_o_legado(api, monkeypatch, bl):
    assert runner._evo_p2p_unmeasured_reason(_ctx(bl, card_id=None, is_card_child=True))
    assert runner._evo_p2p_unmeasured_reason(_ctx(bl, card_id="c1"))
    assert runner._evo_p2p_unmeasured_reason(_ctx(bl, card_id=None, is_card_child=False)) is None   # legado: comportamento anterior
    assert runner._evo_p2p_unmeasured_reason(_ctx(bl)) is None
    monkeypatch.setenv("EVOLUTION_P2P_REQUIRED_LEGACY", "1")
    assert runner._evo_p2p_unmeasured_reason(_ctx(bl, card_id=None, is_card_child=False))
    monkeypatch.setenv("EVOLUTION_P2P_REQUIRED", "0")                                                # opt-out global vence
    assert runner._evo_p2p_unmeasured_reason(_ctx(bl, is_card_child=True)) is None


def test_a4_apply_change_context_marca_o_filho_de_card():
    ctx = SimpleNamespace()
    runner._apply_change_context(ctx, {"evolution": True, "evolution_origin": "card"})
    assert ctx.is_card_child is True
    ctx2 = SimpleNamespace()
    runner._apply_change_context(ctx2, {"evolution": True})
    assert ctx2.is_card_child is False


def test_a4_c_teto_de_contexto_bloqueia_so_com_enforce(tmp_path):
    for i in range(5):
        (tmp_path / f"f{i}.ts").write_text("x" * 100, encoding="utf-8")
    kw = dict(max_total_bytes=250, max_files=3)
    with pytest.raises(context_files.ContextTooLargeError):
        context_files.collect_context_artifacts(tmp_path, tmp_path, **kw)                          # card (padrão)
    with pytest.raises(context_files.ContextTooLargeError):
        context_files.collect_context_artifacts(tmp_path, tmp_path, enforce_ceiling=True, **kw)
    out = context_files.collect_context_artifacts(tmp_path, tmp_path, enforce_ceiling=False, **kw)  # legado: sem erro de teto
    assert len(out) == 5
    (tmp_path / "node_modules").mkdir(); (tmp_path / "node_modules" / "x.js").write_text("y", encoding="utf-8")
    out = context_files.collect_context_artifacts(tmp_path, tmp_path, enforce_ceiling=False, **kw)
    assert all("node_modules" not in a["path"] for a in out)                                         # poda segue para todos


def test_a4_c_os_dois_sites_do_runner_passam_a_regra():
    src = inspect.getsource(runner)
    assert src.count('enforce_ceiling=_a4_rule_applies("CONTEXT_CEILING_ENFORCE"') == 2


def test_a4_d_effective_flags_5xx_legado_degrada_card_falha_fechado(api, monkeypatch):
    api["flags"] = (503, None)
    runner._EFFECTIVE_FLAGS_CACHE.clear()
    assert runner._attachments_strict(LEGACY) is False                       # legado: comportamento anterior (flag off)
    runner._EFFECTIVE_FLAGS_CACHE.clear()
    with pytest.raises(runner.SpecReadError):
        runner._attachments_strict(CARDP)                                     # card: fail-closed
    monkeypatch.setenv("EFFECTIVE_FLAGS_FAIL_CLOSED", "all")
    runner._EFFECTIVE_FLAGS_CACHE.clear()
    with pytest.raises(runner.SpecReadError):
        runner._attachments_strict(LEGACY)
    monkeypatch.setenv("EFFECTIVE_FLAGS_FAIL_CLOSED", "off")
    runner._EFFECTIVE_FLAGS_CACHE.clear()
    assert runner._attachments_strict(CARDP) is False


def test_a4_d_load_spec_all_do_legado_nao_vira_failed_com_flags_fora(api, monkeypatch):
    """Cenário do parecer: /effective-flags 5xx durante o deploy api→agents; projeto comum segue a leitura da spec."""
    api["flags"] = (502, None)
    orig = runner._api_get
    def get(path):
        if path.endswith("/spec-files"):
            return [], 200
        return orig(path)
    monkeypatch.setattr(runner, "_api_get", get)
    runner._EFFECTIVE_FLAGS_CACHE.clear()
    assert runner.load_spec_all(LEGACY) == ""                                 # sem SpecReadError
    runner._EFFECTIVE_FLAGS_CACHE.clear()
    with pytest.raises(runner.SpecReadError):
        runner.load_spec_all(CARDP)
