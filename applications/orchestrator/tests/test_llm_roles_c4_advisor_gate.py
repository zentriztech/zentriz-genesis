"""C4' — teto do Advisor decidido PELO GUARD (X % do orçamento total do projeto-dono; gasto = ledger), não pela env/memória.

Aceites (desenho 27 §4): com a env `ADVISOR_MAX_USD_PER_RUN` REMOVIDA o teto continua valendo; reinício do `agents` NÃO zera o gasto
do Advisor (o gasto vem do ledger do Guard); base ausente ⇒ `advisor_denied_no_base` e a chamada segue no Orchestrator do slot;
estourar o teto nega só o Advisor (nota `advisor_cap_reached`), nunca a task. Sem política ⇒ fallback legado (env), explícito.
"""
import pytest

from orchestrator.agents import llm_guard, llm_roles, runtime
from orchestrator.tests.test_llm_roles import api, PID  # noqa: F401  (fixture do Guard fake)
from orchestrator.tests.test_llm_roles_2a6_2a7 import (  # noqa: F401
    _Cli, _agent, _limpa_env, OPUS, SONNET,
)

KW = dict(required="advisor", models=llm_roles.RoleModels(SONNET, OPUS, None), repair_attempt=0, schema_escalate=False,
          scope="run-1", task_id="T-1", stage="DEV:x", rework_attempt=1, projected_usd=1.0, project_id=PID)


class FakeGuard:
    """Guard simulado: teto = pct % × base; gasto = LEDGER (lista que sobrevive à troca de `AdvisorBudget`)."""

    def __init__(self, base_usd=50.0, pct=10.0, ledger=None, policy=True):
        self.base, self.pct, self.ledger, self.policy = base_usd, pct, ledger if ledger is not None else [], policy
        self.calls = []

    def __call__(self, project_id, projected_usd, inflight_usd):
        self.calls.append((project_id, projected_usd, inflight_usd))
        if not self.policy:
            return {"allow": True, "mode": "legacy"}
        if not self.base:
            return {"allow": False, "mode": "policy", "code": "advisor_denied_no_base"}
        cap = self.base * self.pct / 100.0
        if sum(self.ledger) + inflight_usd + projected_usd > cap:
            return {"allow": False, "mode": "policy", "code": "advisor_cap_reached"}
        return {"allow": True, "mode": "policy", "capUsd": cap}


def test_com_a_env_removida_o_teto_do_guard_continua_valendo(monkeypatch):
    monkeypatch.delenv("ADVISOR_MAX_USD_PER_RUN", raising=False)
    g = FakeGuard(base_usd=50, pct=10)                   # teto US$ 5
    b = llm_roles.AdvisorBudget()
    for i in range(3):                                   # 3 × 1,0 em voo; o legado (env 5.0) também deixaria, o Guard idem
        assert llm_roles.plan_attempt(**{**KW, "task_id": f"T{i}"}, budget=b, gate=g).escalated
    g.base = 2                                           # base menor ⇒ teto US$ 0,2: o Guard nega (a env nem existe)
    p = llm_roles.plan_attempt(**{**KW, "task_id": "T9"}, budget=b, gate=g)
    assert (p.escalated, p.note, p.model) == (False, "advisor_cap_reached", SONNET)    # segue no Orchestrator
    assert p.key is None and g.calls[-1][2] == pytest.approx(3.0)                       # reservas em voo informadas ao Guard


def test_reinicio_do_agents_nao_zera_o_gasto_do_advisor(monkeypatch):
    monkeypatch.delenv("ADVISOR_MAX_USD_PER_RUN", raising=False)
    ledger = []
    g = FakeGuard(base_usd=50, pct=10, ledger=ledger)    # teto US$ 5
    b1 = llm_roles.AdvisorBudget()
    p1 = llm_roles.plan_attempt(**KW, budget=b1, gate=g)
    assert p1.escalated
    b1.settle(p1.key, 4.5)
    ledger.append(4.5)                                   # o /record do Guard gravou o gasto no ledger
    # REINÍCIO: processo novo = AdvisorBudget novo (memória zerada); o gasto vem do ledger
    b2 = llm_roles.AdvisorBudget()
    assert b2.spent("run-1") == 0.0
    p2 = llm_roles.plan_attempt(**{**KW, "task_id": "T-2"}, budget=b2, gate=g)
    assert (p2.escalated, p2.note) == (False, "advisor_cap_reached")
    # prova de contraste: o fallback legado em memória TERIA liberado (4,5 + 1,0 > 5,0 só porque o gasto estava na memória do b1)
    legacy = llm_roles.plan_attempt(**{**KW, "task_id": "T-2", "project_id": None}, budget=b2)
    assert legacy.escalated


def test_sem_base_nega_so_o_advisor_e_a_chamada_segue_no_orchestrator():
    g = FakeGuard(base_usd=0)
    p = llm_roles.plan_attempt(**KW, budget=llm_roles.AdvisorBudget(), gate=g)
    assert (p.escalated, p.note, p.model, p.effective_role) == (False, "advisor_denied_no_base", SONNET, "orchestrator")
    assert p.llm_role == "advisor" and p.key is None
    assert p.note in llm_roles.ESCALATION_DENIED_NOTES


def test_sem_politica_o_fallback_legado_em_env_continua_explicito(monkeypatch):
    monkeypatch.setenv("ADVISOR_MAX_USD_PER_RUN", "1.5")
    g = FakeGuard(policy=False)
    b = llm_roles.AdvisorBudget()
    assert llm_roles.plan_attempt(**KW, budget=b, gate=g).escalated
    p = llm_roles.plan_attempt(**{**KW, "task_id": "T-2"}, budget=b, gate=g)
    assert (p.escalated, p.note) == (False, "advisor_cap_reached")        # teto da env, como antes da C4'


def test_dedupe_continua_valendo_com_guard():
    g = FakeGuard()
    b = llm_roles.AdvisorBudget()
    assert llm_roles.plan_attempt(**KW, budget=b, gate=g).escalated
    p = llm_roles.plan_attempt(**KW, budget=b, gate=g)
    assert (p.escalated, p.note) == (False, "escalation_deduped")


def test_guard_inalcancavel_nega_so_o_advisor_fail_closed(monkeypatch):
    monkeypatch.delenv("LLM_GUARD_DISABLED_FOR_TESTS", raising=False)
    monkeypatch.setenv("API_BASE_URL", "http://127.0.0.1:9")    # porta fechada
    monkeypatch.setenv("GENESIS_API_TOKEN", "tok")
    v = llm_guard.advisor_gate(PID, 1.0, 0.0)
    assert (v["allow"], v["code"]) == (False, "advisor_guard_unreachable")
    p = llm_roles.plan_attempt(**KW, budget=llm_roles.AdvisorBudget())
    assert (p.escalated, p.note, p.model) == (False, "advisor_guard_unreachable", SONNET)
    # sem projeto não há onde perguntar ⇒ legado
    assert llm_guard.advisor_gate(None)["mode"] == "legacy"


def test_run_agent_ponta_a_ponta_sem_base_segue_no_orchestrator_e_registra_nota(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    monkeypatch.delenv("ADVISOR_MAX_USD_PER_RUN", raising=False)
    api.advisor_verdict = {"allow": False, "mode": "policy", "code": "advisor_denied_no_base", "message": "sem orçamento"}
    cli = _Cli({})
    out = _agent(monkeypatch, cli, rework=1, task="T-c4a")
    assert cli.requests == [SONNET]                                   # nenhuma chamada ao Advisor; task NÃO falhou
    assert out["_escalation_note"] == "advisor_denied_no_base"
    assert any(p.endswith("/advisor-gate") and b["projectId"] == PID for p, b in api.calls)
    # com o teto estourado: idem, outra nota
    api.advisor_verdict = {"allow": False, "mode": "policy", "code": "advisor_cap_reached"}
    cli2 = _Cli({})
    out2 = _agent(monkeypatch, cli2, rework=1, task="T-c4b")
    assert cli2.requests == [SONNET] and out2["_escalation_note"] == "advisor_cap_reached"
    # liberado pelo Guard (política, dentro do teto): escala ao Advisor
    api.advisor_verdict = {"allow": True, "mode": "policy", "capUsd": 5.0}
    cli3 = _Cli({})
    out3 = _agent(monkeypatch, cli3, rework=1, task="T-c4c")
    assert cli3.requests == [OPUS] and out3["_effective_role"] == "advisor"
