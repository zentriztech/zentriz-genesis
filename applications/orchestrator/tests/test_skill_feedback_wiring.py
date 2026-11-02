"""Plano v2, tarefas 1.1/1.2 (ADR-025) — fiação do ciclo de feedback de skill no runner e no runtime.

Garante: flag off ⇒ NENHUMA chamada de rede; sinais corretos (QA = fraco; suíte real = oráculo);
corpo sem PII; lições só são registradas quando a flag está ligada.
"""
from __future__ import annotations

import pytest

import orchestrator.runner as runner
import orchestrator.agents.runtime as runtime

PID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def calls(monkeypatch):
    out: list[tuple[str, str, dict]] = []

    def fake_post(path, body):
        out.append(("POST", path, body))
        return {"ok": True}, 201

    monkeypatch.setattr(runner, "_api_post", fake_post)
    return out


def test_flag_off_nao_chama_a_api(monkeypatch, calls):
    monkeypatch.delenv("SKILL_FEEDBACK", raising=False)
    assert runner._skill_feedback_mode() == "off"
    assert runner._skill_feedback_signal(PID, "T1", "qa_pass") is False
    assert runner._skill_feedback_signal(PID, None, "oracle_pass") is False
    assert calls == []


@pytest.mark.parametrize("raw,expected", [("", "off"), ("sim", "off"), ("SHADOW", "shadow"), (" on ", "on")])
def test_flag_parse(monkeypatch, raw, expected):
    monkeypatch.setenv("SKILL_FEEDBACK", raw)
    assert runner._skill_feedback_mode() == expected


def test_qa_pass_e_fail_viram_sinais_fracos_com_corpo_minimo(monkeypatch, calls):
    monkeypatch.setenv("SKILL_FEEDBACK", "on")
    assert runner._skill_feedback_signal(PID, "TSK-001", "qa_pass") is True
    assert runner._skill_feedback_signal(PID, "TSK-001", "qa_fail") is True
    assert calls == [
        ("POST", "/api/skills/feedback", {"v": 2, "project_id": PID, "signal": "qa_pass", "task_id": "TSK-001"}),
        ("POST", "/api/skills/feedback", {"v": 2, "project_id": PID, "signal": "qa_fail", "task_id": "TSK-001"}),
    ]
    # sem PII: só ids opacos e o sinal
    assert set(calls[0][2]) == {"v", "project_id", "signal", "task_id"}


def test_oraculo_de_projeto_sem_task_id(monkeypatch, calls):
    monkeypatch.setenv("SKILL_FEEDBACK", "shadow")
    runner._skill_feedback_signal(PID, None, "oracle_pass")
    assert calls[0][2] == {"v": 2, "project_id": PID, "signal": "oracle_pass"}


def test_sinal_desconhecido_e_projeto_ausente_sao_ignorados(monkeypatch, calls):
    monkeypatch.setenv("SKILL_FEEDBACK", "on")
    assert runner._skill_feedback_signal(PID, "T", "human_approve") is False  # humano só nasce na api
    assert runner._skill_feedback_signal(None, "T", "qa_pass") is False
    assert calls == []


def test_falha_de_rede_nao_derruba(monkeypatch):
    monkeypatch.setenv("SKILL_FEEDBACK", "on")

    def boom(path, body):
        raise RuntimeError("rede")

    monkeypatch.setattr(runner, "_api_post", boom)
    assert runner._skill_feedback_signal(PID, "T", "qa_pass") is False


@pytest.mark.parametrize("final,regs,expected", [
    ({"status": "ok", "exit_code": 0, "passed": 12, "failed": 0}, [], "oracle_pass"),
    ({"status": "ok", "exit_code": 0, "passed": 12, "failed": 0}, ["t1"], None),         # regressão: não é prova positiva
    ({"status": "ok", "exit_code": 1, "passed": 10, "failed": 2}, [], "oracle_fail"),
    ({"status": "ok", "exit_code": 2, "passed": 0, "failed": 0}, [], "oracle_fail"),
    ({"status": "ok", "exit_code": 0, "passed": 0, "failed": 0}, [], None),                # nada medido
    ({"status": "ok", "no_tests": True, "exit_code": 0, "passed": 0, "failed": 0}, [], None),
    ({"status": "error", "error": "x", "passed": 0, "failed": 0}, [], None),               # erro de medição ≠ evidência
    (None, [], None),                                                                      # executor indisponível
])
def test_oraculo_vem_so_da_suite_real(final, regs, expected):
    assert runner._oracle_signal_from_final(final, regs) == expected


# ── runtime: lições injetadas ────────────────────────────────────────────────

def test_licoes_injetadas_flag_off_nao_faz_rede(monkeypatch):
    monkeypatch.delenv("SKILL_FEEDBACK", raising=False)
    monkeypatch.setattr(runtime, "_GENESIS_API_TOKEN", "tok")
    monkeypatch.setattr(runtime._urllib_req, "urlopen", lambda *a, **k: pytest.fail("rede com flag off"))
    assert runtime._record_lesson_injection(PID, "T1", [{"slug": "a"}]) is False


def test_licoes_injetadas_on_envia_slugs_unicos_e_ordenados(monkeypatch):
    monkeypatch.setenv("SKILL_FEEDBACK", "on")
    monkeypatch.setattr(runtime, "_GENESIS_API_TOKEN", "tok")
    sent = {}

    class _Resp:
        status = 201
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout=0):
        import json
        sent["url"], sent["body"] = req.full_url, json.loads(req.data)
        return _Resp()

    monkeypatch.setattr(runtime._urllib_req, "urlopen", fake_urlopen)
    ok = runtime._record_lesson_injection(PID, "T1", [{"slug": "b", "bodyMd": "texto"}, {"slug": "a"}, {"slug": "b"}, {"x": 1}])
    assert ok is True
    assert sent["url"].endswith("/api/skills/lesson-injections")
    assert sent["body"] == {"project_id": PID, "task_id": "T1", "slugs": ["a", "b"]}  # sem corpo da lição


def test_licoes_injetadas_sem_task_ou_projeto_nao_registra(monkeypatch):
    monkeypatch.setenv("SKILL_FEEDBACK", "on")
    monkeypatch.setattr(runtime, "_GENESIS_API_TOKEN", "tok")
    monkeypatch.setattr(runtime._urllib_req, "urlopen", lambda *a, **k: pytest.fail("rede sem task"))
    assert runtime._record_lesson_injection(None, "T1", [{"slug": "a"}]) is False
    assert runtime._record_lesson_injection(PID, None, [{"slug": "a"}]) is False
    assert runtime._record_lesson_injection(PID, "T1", []) is False


def test_cag_live_registra_licoes_injetadas_e_shadow_nao(monkeypatch):
    """Só lição que ENTROU no prompt (CAG live) conta; CAG shadow retorna antes do registro."""
    import types

    class _Pkg:
        payload_tokens, cache_hit, duration_ms = 1, False, 1
        lessons_hot = [{"slug": "les-1", "score": 0.9}]
        def to_prompt_prefix(self): return "PREFIXO"

    import orchestrator.context_loader as cl
    monkeypatch.setattr(cl, "get_context_loader", lambda: types.SimpleNamespace(load=lambda **k: _Pkg()))
    recorded = []
    monkeypatch.setattr(runtime, "_record_lesson_injection", lambda p, t, l: recorded.append((p, t, [x["slug"] for x in l])))

    monkeypatch.setenv("CAG_ENABLED", "shadow")
    assert runtime._maybe_apply_cag_prefix("BASE", "dev", "generic", PID, "q", task_id="T1") == "BASE"
    assert recorded == []

    monkeypatch.setenv("CAG_ENABLED", "live")
    out = runtime._maybe_apply_cag_prefix("BASE", "dev", "generic", PID, "q", task_id="T1")
    assert out.startswith("PREFIXO")
    assert recorded == [(PID, "T1", ["les-1"])]
