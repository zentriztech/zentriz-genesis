"""C1' — negativa do LLM Guard no runner NÃO derruba o contínuo (plano 27, 27c F01/F18).

Cobre os três pontos (pré-laço Engineer/CTO/PM, Dev, QA) nos DOIS formatos de erro:
  * `LlmGuardDenied` (in-process);
  * `RuntimeError(json{"http_code": 402, ...})` (caminho HTTP: `agents/client_http.py`).

Os testes de comportamento NÃO importam o classificador novo: provam o defeito contra o runner
(falham no estado anterior à correção) e passam depois. O harness troca só a borda (API do Genesis,
chamadas de agente, relógio); o laço do runner é o REAL.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

import orchestrator.runner as runner
from orchestrator.agents import llm_guard

PID = "11111111-1111-4111-8111-111111111111"


# ── formatos de erro ───────────────────────────────────────────────────────────────────────────────
def denial_inproc(code: str = "KILL_SWITCH") -> Exception:
    return llm_guard.LlmGuardDenied(code, "Chave geral de LLM ligada.", PID)


def denial_http(code: str = "KILL_SWITCH") -> Exception:
    """Exatamente o que `client_http.run_agent_http` levanta para o 402 do `agents/server.py`
    (`detail={"code","message","guard":True,"project_id"}` → `error` = corpo cru, até 500 chars)."""
    body = json.dumps({"detail": {"code": code, "message": "Chave geral de LLM ligada.", "guard": True,
                                  "project_id": PID}}, ensure_ascii=False)
    return RuntimeError(json.dumps({
        "agent": "dev", "agent_name": "Dev", "http_code": 402, "error": body[:500],
        "human_message": f"O agente Dev retornou erro HTTP 402: {body[:500]}", "traceback": "",
    }, ensure_ascii=False))


FORMATS = pytest.mark.parametrize("make", [denial_inproc, denial_http], ids=["LlmGuardDenied", "HTTP402"])


# ── harness: API fake em memória + laço real ───────────────────────────────────────────────────────
class _Runaway(BaseException):
    """O laço não terminou sozinho (spin) — o teste falha com esta marca."""


class FakeCtx:
    current_module = "backend"
    project_type = None
    evolution_scope = None

    def __init__(self):
        self.checkpoints = 0

    def save_checkpoint(self, _path):
        self.checkpoints += 1

    def get_dependency_code(self, _deps):
        return None

    def __getattr__(self, name):  # atributos opcionais do pipeline ctx
        return None


class Harness:
    def __init__(self, monkeypatch, tmp_path, tasks, project_status="running", max_sleeps=40, max_status_calls=400):
        self.tasks = [dict(t) for t in tasks]
        self.project_status = project_status
        self.patches: list[dict] = []
        self.task_history: list[tuple[str, str]] = []
        self.steps: list[str] = []
        self.errors: list[str] = []
        self.sleeps: list[float] = []
        self.dev_calls = 0
        self.qa_calls = 0
        self.monitor_calls = 0
        self.status_calls = 0
        self.ctx = FakeCtx()
        self.max_sleeps = max_sleeps
        self.max_status_calls = max_status_calls
        self.dev_exc = None
        self.qa_exc = None
        h = self
        monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path / "pf"))
        monkeypatch.setenv("PROJECT_ID", PID)
        monkeypatch.delenv("API_BASE_URL", raising=False)
        monkeypatch.delenv("API_AGENTS_URL", raising=False)
        monkeypatch.setenv("MONITOR_PARALLEL", "false")
        monkeypatch.setenv("GUARD_DENIAL_MAX_CHECKS", "3")
        monkeypatch.setenv("GUARD_DENIAL_WAIT_BASE_SEC", "1")
        monkeypatch.setenv("GUARD_DENIAL_WAIT_MAX_SEC", "4")
        monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)

        def get_status(_pid):
            h.status_calls += 1
            if h.status_calls > h.max_status_calls:
                raise _Runaway("laço do runner não terminou")
            return h.project_status

        def get_tasks(_pid):
            return [dict(t) for t in h.tasks]

        def update_task(_pid, tid, **kw):
            for t in h.tasks:
                if t["taskId"] == tid and "status" in kw:
                    h.task_history.append((tid, kw["status"]))
                    t["status"] = kw["status"]
                for k, v in kw.items():
                    if k != "status":
                        t[k] = v
            return True

        def patch_project(body):
            h.patches.append(dict(body))
            if "status" in body:
                h.project_status = body["status"]
            return True

        def sleep(sec):
            h.sleeps.append(float(sec))
            if len(h.sleeps) > h.max_sleeps:
                raise _Runaway("laço do runner não terminou (spin de sleep)")

        def call_dev(*a, **k):
            h.dev_calls += 1
            if h.dev_exc is not None:
                raise h.dev_exc
            raise AssertionError("call_dev inesperado")

        def call_qa(*a, **k):
            h.qa_calls += 1
            if h.qa_exc is not None:
                raise h.qa_exc
            raise AssertionError("call_qa inesperado")

        def autonomous_monitor(*a, **k):
            h.monitor_calls += 1
            return {"outcome": "ESCALATE", "summary": "x"}

        def unexpected(name):
            def _f(*a, **k):
                raise _Runaway(f"{name} chamado — o laço avançou para fase pós-Dev/QA")
            return _f

        monkeypatch.setattr(runner, "_get_project_status", get_status)
        monkeypatch.setattr(runner, "_get_tasks", get_tasks)
        monkeypatch.setattr(runner, "_update_task", update_task)
        monkeypatch.setattr(runner, "_patch_project", patch_project)
        monkeypatch.setattr(runner, "_post_step", lambda msg, rid=None: h.steps.append(str(msg)))
        monkeypatch.setattr(runner, "_post_error", lambda msg, rid=None, exc=None: h.errors.append(str(msg)))
        for fn in ("_post_agent_working", "_post_dialogue", "_post_escalation_event", "_audit_log",
                   "_write_spec_dossier_coverage", "_notify_genesis_bug", "_skill_feedback_signal"):
            monkeypatch.setattr(runner, fn, lambda *a, **k: None, raising=False)
        monkeypatch.setattr(runner, "_check_cost_gate", lambda _pid: (True, 0.0))
        monkeypatch.setattr(runner, "_project_storage", lambda: type("S", (), {"is_enabled": lambda s: False})())
        monkeypatch.setattr(runner, "_resolve_backend_stack",
                            lambda *a, **k: {"language": "nodejs", "source": "test", "confidence": "high"})
        monkeypatch.setattr(runner, "_call_autonomous_monitor", autonomous_monitor)
        monkeypatch.setattr(runner, "call_dev", call_dev)
        monkeypatch.setattr(runner, "call_qa", call_qa)
        monkeypatch.setattr(runner, "call_devops", unexpected("call_devops"))
        monkeypatch.setattr(runner, "call_monitor", unexpected("call_monitor"), raising=False)
        monkeypatch.setattr(runner.time, "sleep", sleep)
        monkeypatch.setattr(runner, "_shutdown_requested", False)
        monkeypatch.setattr(runner.signal, "signal", lambda *a, **k: None)

    def run_loop(self):
        runner._run_monitor_loop(PID, "spec.md", "charter", "backlog", "rid-1", pipeline_ctx=self.ctx)

    def statuses(self, tid=None):
        return [s for (t, s) in self.task_history if tid is None or t == tid]

    def final(self, tid):
        return next(t["status"] for t in self.tasks if t["taskId"] == tid)

    @property
    def project_statuses(self):
        return [p["status"] for p in self.patches if "status" in p]


def _tasks(n=3, status="ASSIGNED"):
    return [{"taskId": f"TSK-{i:03d}", "status": status, "title": f"t{i}", "ownerRole": "DEV_BACKEND"}
            for i in range(1, n + 1)]


def _run_or_fail(h: Harness):
    try:
        h.run_loop()
    except _Runaway as e:
        pytest.fail(f"DEFEITO: {e} (sleeps={len(h.sleeps)}, dev={h.dev_calls}, qa={h.qa_calls}, "
                    f"tasks={[(t['taskId'], t['status']) for t in h.tasks]})")


# ── Dev: negativa não vira BLOCKED terminal ────────────────────────────────────────────────────────
@FORMATS
def test_dev_negado_nao_vira_blocked_e_volta_ao_status_anterior(monkeypatch, tmp_path, make):
    h = Harness(monkeypatch, tmp_path, _tasks(3))
    h.dev_exc = make("KILL_SWITCH")
    _run_or_fail(h)
    assert "BLOCKED" not in h.statuses(), f"negativa do Guard virou BLOCKED terminal: {h.task_history}"
    assert all(h.final(t) == "ASSIGNED" for t in ("TSK-001", "TSK-002", "TSK-003")), h.tasks
    assert "failed" not in h.project_statuses and "completed" not in h.project_statuses
    assert h.monitor_calls == 0  # FT-11 não gasta a única tentativa do Monitor Autônomo
    assert all("monitor_attempted" not in t for t in h.tasks)


@FORMATS
def test_dev_retorna_ao_status_ANTERIOR_qa_fail_sem_contar_tentativa(monkeypatch, tmp_path, make):
    tasks = _tasks(1, status="QA_FAIL")
    h = Harness(monkeypatch, tmp_path, tasks)
    h.dev_exc = make("KILL_SWITCH")
    _run_or_fail(h)
    assert h.final("TSK-001") == "QA_FAIL", h.task_history
    assert "BLOCKED" not in h.statuses()
    # a tentativa de rework/repair não é contada: nenhum marcador de tentativa/abandono foi gravado
    assert all("monitor_attempted" not in t for t in h.tasks)
    assert not any("Máximo de tentativas" in s or "DONE (não aprovada)" in s for s in h.steps)


@FORMATS
def test_kill_switch_com_tasks_pendentes_pausa_limpa_sem_loop_nem_completed(monkeypatch, tmp_path, make):
    """F18: com 3 tasks pendentes e KILL_SWITCH o projeto NÃO chega a `completed` e o laço não gira."""
    h = Harness(monkeypatch, tmp_path, _tasks(3))
    h.dev_exc = make("KILL_SWITCH")
    _run_or_fail(h)
    assert h.project_statuses == ["stopped"], h.patches
    assert h.patches[-1].get("blocked_reason", "").startswith("guard_denied")
    assert h.dev_calls <= 3  # GUARD_DENIAL_MAX_CHECKS=3
    assert len(h.sleeps) <= 3 and all(s > 0 for s in h.sleeps)  # espera COM teto, nunca 0 s em spin
    assert h.ctx.checkpoints >= 1  # checkpoint salvo


# ── QA: negativa não gira em laço de 2 s ───────────────────────────────────────────────────────────
@FORMATS
def test_qa_negado_termina_o_laco_sem_spin_e_task_continua_waiting_review(monkeypatch, tmp_path, make):
    h = Harness(monkeypatch, tmp_path, _tasks(1, status="WAITING_REVIEW"))
    h.qa_exc = make("KILL_SWITCH")
    _run_or_fail(h)
    assert h.final("TSK-001") == "WAITING_REVIEW"
    assert h.qa_calls <= 3
    assert h.project_statuses == ["stopped"], h.patches
    assert "failed" not in h.project_statuses and "BLOCKED" not in h.statuses()
    assert h.ctx.checkpoints >= 1


# ── orçamento: sem retry, pausa do Guard preservada ────────────────────────────────────────────────
@FORMATS
def test_negativa_de_orcamento_nao_repete_e_nao_duplica_a_pausa_do_guard(monkeypatch, tmp_path, make):
    """BUDGET_PAUSED: o Guard JÁ pôs o projeto em `stopped`/`stopped_by=budget`. O runner não repete a
    chamada, não sobrescreve o status e devolve a task."""
    h = Harness(monkeypatch, tmp_path, _tasks(2))
    h.dev_exc = make("BUDGET_PAUSED")
    real_get = runner._get_project_status

    def guard_pauses_after_denial(pid):
        # a pausa acontece no Guard (api) ao negar; o runner só a observa
        if h.dev_calls >= 1:
            h.project_status = "stopped"
        return real_get(pid)

    monkeypatch.setattr(runner, "_get_project_status", guard_pauses_after_denial)
    _run_or_fail(h)
    assert h.dev_calls == 1, "erro de orçamento não faz retry"
    assert "BLOCKED" not in h.statuses()
    assert h.final("TSK-001") == "ASSIGNED"
    assert h.patches == [], "o runner não deve duplicar a pausa que o Guard já aplicou"


@FORMATS
def test_negativa_de_orcamento_sem_pausa_do_guard_encerra_sem_esperar(monkeypatch, tmp_path, make):
    """BUDGET_MISSING não pausa o projeto no Guard: só humano resolve ⇒ para na hora (sem espera/retry)."""
    h = Harness(monkeypatch, tmp_path, _tasks(1))
    h.dev_exc = make("BUDGET_MISSING")
    _run_or_fail(h)
    assert h.dev_calls == 1 and h.sleeps == []
    assert h.project_statuses == ["stopped"]
    assert h.final("TSK-001") == "ASSIGNED"


# ── sem negativa nada muda; 429 mantém o comportamento ─────────────────────────────────────────────
def test_erro_comum_do_dev_continua_blocked_como_antes(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, _tasks(1))
    h.dev_exc = RuntimeError(json.dumps({"agent": "dev", "http_code": 500, "error": "boom"}))
    with pytest.raises(_Runaway):  # depois de BLOCKED o laço segue para DevOps (fase pós-Dev) = marca de que BLOCKED é terminal
        h.run_loop()
    assert h.statuses()[:2] == ["IN_PROGRESS", "BLOCKED"]


def test_erro_de_taxa_429_nao_e_negativa_do_guard(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, _tasks(1))
    h.dev_exc = RuntimeError(json.dumps({"agent": "dev", "http_code": 429, "error": "rate limited"}))
    with pytest.raises(_Runaway):
        h.run_loop()
    assert h.statuses()[:2] == ["IN_PROGRESS", "BLOCKED"]  # comportamento atual preservado
    assert h.project_statuses.count("stopped") == 0


def test_flag_off_restaura_o_comportamento_antigo(monkeypatch, tmp_path):
    monkeypatch.setenv("GUARD_DENIAL_GRACEFUL", "off")
    h = Harness(monkeypatch, tmp_path, _tasks(1))
    h.dev_exc = denial_inproc()
    with pytest.raises(_Runaway):
        h.run_loop()
    assert h.statuses()[:2] == ["IN_PROGRESS", "BLOCKED"]


# ── pré-laço (Engineer/CTO/PM): o `except` do pipeline não marca `failed` ───────────────────────────
def _drive_main_with_denial(monkeypatch, tmp_path, exc):
    spec = tmp_path / "spec.md"
    spec.write_text("# Produto\n\nFR-001 fazer algo\n", encoding="utf-8")
    patches: list[dict] = []
    monkeypatch.setenv("PROJECT_ID", PID)
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path / "pf"))
    monkeypatch.delenv("API_BASE_URL", raising=False)
    monkeypatch.delenv("API_AGENTS_URL", raising=False)
    monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)
    monkeypatch.setattr(runner, "_patch_project", lambda b: patches.append(dict(b)) or True)
    monkeypatch.setattr(runner, "_get_project_status", lambda _p: "running")

    def boom(*a, **k):
        raise exc

    monkeypatch.setattr(runner, "call_cto", boom)  # 1ª chamada paga do pipeline (revisão da spec)
    monkeypatch.setattr(sys, "argv", ["runner", "--spec-file", str(spec)])
    try:
        rc = runner.main()
        raised = None
    except BaseException as e:  # noqa: BLE001
        rc, raised = None, e
    return rc, raised, patches


@FORMATS
def test_pre_laco_negado_nao_marca_failed(monkeypatch, tmp_path, make):
    rc, raised, patches = _drive_main_with_denial(monkeypatch, tmp_path, make("KILL_SWITCH"))
    statuses = [p.get("status") for p in patches]
    assert "failed" not in statuses, f"DEFEITO: negativa do Guard marcou o projeto failed: {patches}"
    assert raised is None and rc == 0
    assert statuses[-1] == "stopped"
    assert patches[-1].get("blocked_reason", "").startswith("guard_denied")


@FORMATS
def test_pre_laco_negado_por_orcamento_ja_pausado_pelo_guard_nao_duplica(monkeypatch, tmp_path, make):
    spec = tmp_path / "spec.md"
    spec.write_text("# Produto\n\nFR-001 fazer algo\n", encoding="utf-8")
    patches: list[dict] = []
    monkeypatch.setenv("PROJECT_ID", PID)
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path / "pf"))
    monkeypatch.delenv("API_BASE_URL", raising=False)
    monkeypatch.setattr(runner, "STATE_DIR", tmp_path / "state", raising=False)
    monkeypatch.setattr(runner, "_patch_project", lambda b: patches.append(dict(b)) or True)
    monkeypatch.setattr(runner, "_get_project_status", lambda _p: "stopped")  # o Guard já pausou

    def boom(*a, **k):
        raise make("BUDGET_PAUSED")

    monkeypatch.setattr(runner, "call_cto", boom)
    monkeypatch.setattr(sys, "argv", ["runner", "--spec-file", str(spec)])
    rc = runner.main()
    assert rc == 0
    assert "failed" not in [p.get("status") for p in patches]
    assert [p for p in patches if p.get("status") == "stopped"] == []


# ── classificador ──────────────────────────────────────────────────────────────────────────────────
class TestClassificador:
    def test_reconhece_os_dois_formatos(self):
        from orchestrator.guard_denial import is_guard_denial, guard_denial_code
        for make in (denial_inproc, denial_http):
            for code in ("KILL_SWITCH", "BUDGET_PAUSED", "BUDGET_INSUFFICIENT", "BUDGET_MISSING",
                         "GLOBAL_HOURLY_CAP", "GLOBAL_DAILY_CAP", "REPEAT_PAYLOAD"):
                e = make(code)
                assert is_guard_denial(e), (make.__name__, code)
                assert guard_denial_code(e) == code, (make.__name__, code)

    def test_nao_confunde_outros_erros(self):
        from orchestrator.guard_denial import is_guard_denial
        assert not is_guard_denial(RuntimeError("boom"))
        assert not is_guard_denial(ValueError("x"))
        assert not is_guard_denial(RuntimeError(json.dumps({"http_code": 429, "error": "rate"})))
        assert not is_guard_denial(RuntimeError(json.dumps({"http_code": 500, "error": "x"})))
        assert not is_guard_denial(RuntimeError(json.dumps({"error": "timed out"})))
        assert not is_guard_denial(None)

    def test_402_com_corpo_truncado_ou_sem_codigo_ainda_e_negativa(self):
        from orchestrator.guard_denial import is_guard_denial, guard_denial_code
        e = RuntimeError(json.dumps({"http_code": 402, "error": '{"detail": {"mess'}))
        assert is_guard_denial(e) and guard_denial_code(e) is None

    def test_causa_encadeada(self):
        from orchestrator.guard_denial import is_guard_denial
        try:
            try:
                raise denial_inproc("KILL_SWITCH")
            except Exception as inner:
                raise RuntimeError("wrapper") from inner
        except RuntimeError as outer:
            assert is_guard_denial(outer)

    def test_orcamento_vs_plataforma(self):
        from orchestrator.guard_denial import is_budget_denial
        assert is_budget_denial(denial_http("BUDGET_PAUSED"))
        assert is_budget_denial(denial_inproc("BUDGET_MISSING"))
        assert not is_budget_denial(denial_http("KILL_SWITCH"))

    def test_backoff_tem_teto_e_jitter(self, monkeypatch):
        from orchestrator.guard_denial import backoff_seconds
        monkeypatch.setenv("GUARD_DENIAL_WAIT_BASE_SEC", "30")
        monkeypatch.setenv("GUARD_DENIAL_WAIT_MAX_SEC", "300")
        vals = [backoff_seconds(n, rng=lambda: 0.0) for n in range(1, 9)]
        assert vals[:4] == [30.0, 60.0, 120.0, 240.0] and vals[4:] == [300.0] * 4
        assert backoff_seconds(1, rng=lambda: 1.0) == pytest.approx(37.5)

    def test_flag(self, monkeypatch):
        from orchestrator.guard_denial import graceful_enabled
        monkeypatch.delenv("GUARD_DENIAL_GRACEFUL", raising=False)
        assert graceful_enabled()
        monkeypatch.setenv("GUARD_DENIAL_GRACEFUL", "off")
        assert not graceful_enabled()
        monkeypatch.setenv("GUARD_DENIAL_GRACEFUL", "lixo")
        assert graceful_enabled()
