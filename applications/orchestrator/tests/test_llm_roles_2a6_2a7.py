"""Plano de evolução v2, 2A.6 e 2A.7 (ADR-024), tudo sob `LLM_ROLES_MODE=on`.

2A.6 — chamadas diretas do runner (F08 Orchestrator, F11/F12 Staff) passam pela resolução por papel do
       slot: sem slot ⇒ falha alta, provider do slot respeitado, Staff vazio ⇒ Orchestrator declarado,
       `CLAUDE_MODEL_FALLBACK` morto em `call_bedrock_direct`; `off`/`shadow` equivalem ao legado.
2A.7 — escalonamento do Advisor SÓ por fato duro (rework≥1, env=prod, schema reprovado após reparo);
       nunca por rede/vazio/truncamento/entitlement/Guard-deny; idempotência da chave; teto de custo
       (`advisor_cap_reached`); pior caso `CLAUDE_RETRY_ATTEMPTS` × `MAX_REPAIRS` com limite provado;
       failover de disponibilidade do /invoke/raw não é `advisor` no ledger.
"""
import json
import sys
import types

import pytest

from orchestrator.agents import llm_guard, llm_roles, runtime
from orchestrator.tests.test_llm_roles import api, PID  # noqa: F401  (fixture do Guard fake)

SONNET, OPUS, HAIKU = "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"
ENVS = ("CLAUDE_MODEL", "CLAUDE_MODEL_REWORK", "CLAUDE_MODEL_FALLBACK", "CLAUDE_MODEL_SPEC", "CLAUDE_MODEL_CODE",
        "PIPELINE_LLM_MODEL", "CLAUDE_MODEL_ADVISOR", "CLAUDE_MODEL_STAFF", "GENESIS_LLM_PROVIDER",
        "CLAUDE_API_KEY", "GENESIS_LLM_ROLES_CONTRACT_VERSION", "LLM_ROLES_MODE")


@pytest.fixture(autouse=True)
def _limpa_env(monkeypatch):
    for k in ENVS:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(runtime.time, "sleep", lambda *_: None)
    runtime._circuit_failures.clear()


def _slot_env(monkeypatch, *, provider="anthropic", orch=SONNET, adv=None, staff=None):
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", provider)
    monkeypatch.setenv("CLAUDE_API_KEY", "chave-de-teste")
    monkeypatch.setenv("GENESIS_LLM_ROLES_CONTRACT_VERSION", "1")
    if orch:
        monkeypatch.setenv("CLAUDE_MODEL", orch)
    if adv:
        monkeypatch.setenv("CLAUDE_MODEL_ADVISOR", adv)
    if staff:
        monkeypatch.setenv("CLAUDE_MODEL_STAFF", staff)


# ═══════════════════════ 2A.6 — chamadas diretas do runner ═══════════════════════════════════════

@pytest.fixture
def runner(monkeypatch):
    from orchestrator import runner as r
    return r


@pytest.fixture
def direct(monkeypatch):
    """Dublê de `call_bedrock_direct` (cliente genérico por provider): captura o que o runner pediu."""
    calls: list = []

    def fake(system, user, model_id, **kw):
        calls.append({"model": model_id, **kw})
        return "backend" if "web | backend" in user else ("python" if "python | nodejs" in user else
                                                          '{"outcome":"ESCALATE","summary":"x"}')

    monkeypatch.setattr(runtime, "call_bedrock_direct", fake)
    return calls


@pytest.mark.parametrize("ponto,chama", [("F11", lambda r: r._ask_llm_for_backend_language("API FastAPI")),
                                         ("F12", lambda r: r._ask_llm_for_module("api http"))])
def test_f11_f12_sob_on_usam_staff_do_slot(monkeypatch, runner, direct, ponto, chama):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    _slot_env(monkeypatch, adv=OPUS, staff=HAIKU)
    chama(runner)
    c = direct[0]
    assert c["model"] == HAIKU and (c["llm_role"], c["effective_role"]) == ("staff", "staff")
    assert c["llm_cfg"]["provider"] == "anthropic" and "escalated_from" not in c


@pytest.mark.parametrize("ponto,chama", [("F11", lambda r: r._ask_llm_for_backend_language("API FastAPI")),
                                         ("F12", lambda r: r._ask_llm_for_module("api http"))])
def test_f11_f12_staff_vazio_usa_orchestrator_declarado(monkeypatch, runner, direct, ponto, chama):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    _slot_env(monkeypatch, adv=OPUS, staff=None)
    chama(runner)
    c = direct[0]
    assert c["model"] == SONNET                                           # Orchestrator do MESMO slot
    assert (c["llm_role"], c["effective_role"]) == ("staff", "orchestrator")   # declarado no ledger


def test_f08_sob_on_e_orchestrator_do_slot(monkeypatch, runner, direct):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    _slot_env(monkeypatch, adv=OPUS, staff=HAIKU)
    monkeypatch.setattr(runner, "_api_get", lambda *a, **k: ([], 200))
    out = runner._call_autonomous_monitor(PID, {"taskId": "T1", "title": "x"}, "req")
    assert out["outcome"] == "ESCALATE"
    c = direct[0]
    assert c["model"] == SONNET and (c["llm_role"], c["effective_role"]) == ("orchestrator", "orchestrator")
    assert c["usage_project_id"] == PID and c["usage_agent"] == "runner:autonomous_monitor"


@pytest.mark.parametrize("chama", [
    lambda r: r._ask_llm_for_backend_language("API"),
    lambda r: r._ask_llm_for_module("api"),
    lambda r: r._call_autonomous_monitor(PID, {"taskId": "T1"}, "req"),
    lambda r: r._detect_backend_language("API"),
])
def test_sem_slot_falha_alta_sem_default_literal_nem_provider_forcado(monkeypatch, runner, direct, chama):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    monkeypatch.setenv("CLAUDE_MODEL_FALLBACK", "claude-sonnet-4-6")      # env NÃO é atalho
    monkeypatch.setattr(runner, "_api_get", lambda *a, **k: ([], 200))
    with pytest.raises(llm_roles.RoleResolutionError):
        chama(runner)
    assert direct == []                                                    # nenhuma chamada saiu


def test_sem_provider_no_slot_falha_alto_mesmo_com_modelo(monkeypatch, runner, direct):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    monkeypatch.setenv("CLAUDE_MODEL", SONNET)
    with pytest.raises(llm_roles.RoleResolutionError, match="provider"):
        runner._ask_llm_for_module("api")
    assert direct == []


def test_f11_sem_slot_nao_tenta_proxima_fonte_nem_vira_default(monkeypatch, runner, direct):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    with pytest.raises(llm_roles.RoleResolutionError):
        runner._detect_backend_stack(project_id=None, engineer_proposal="x" * 80, charter_fallback="y" * 80)
    assert direct == []


def test_f12_sem_slot_nao_cai_na_heuristica(monkeypatch, runner, direct):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    monkeypatch.setattr(runner, "_cb_is_open", lambda: False)
    spec = "Landing page institucional com formulário de contato, sem servidor, apenas HTML e CSS. " * 5
    with pytest.raises(llm_roles.RoleResolutionError):
        runner.infer_pm_module_from_engineer_proposal("", spec)
    assert direct == []


@pytest.mark.parametrize("prov,modelo", [("google", "gemini-2.5-pro"), ("openai", "gpt-4.1"),
                                         ("azure_openai", "gpt-4o"), ("bedrock", "us.anthropic.claude-sonnet-4-6"),
                                         ("foundry", "claude-opus-5")])
def test_provider_do_slot_respeitado_nao_forca_anthropic(monkeypatch, runner, direct, prov, modelo):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    _slot_env(monkeypatch, provider=prov, orch=modelo)
    runner._ask_llm_for_module("api")
    assert direct[0]["llm_cfg"]["provider"] == prov and direct[0]["model"] == modelo


def test_provider_incompativel_com_o_modelo_do_papel_falha_alto(monkeypatch, runner, direct):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    _slot_env(monkeypatch, provider="google", orch="us.anthropic.claude-sonnet-4-6")
    with pytest.raises(llm_roles.RoleProviderMismatch):
        runner._ask_llm_for_backend_language("API")
    assert direct == []


def test_guard_negado_propaga_sem_rebaixar_papel(monkeypatch, runner):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    _slot_env(monkeypatch, adv=OPUS, staff=HAIKU)
    vistos: list = []

    def negado(system, user, model_id, **kw):
        vistos.append(model_id)
        raise llm_guard.LlmGuardDenied("BUDGET_INSUFFICIENT", "sem saldo", PID)

    monkeypatch.setattr(runtime, "call_bedrock_direct", negado)
    with pytest.raises(llm_guard.LlmGuardDenied):
        runner._ask_llm_for_module("api")
    assert vistos == [HAIKU]                                  # Staff negado NÃO sobe para Orchestrator/Advisor
    monkeypatch.setattr(runner, "_api_get", lambda *a, **k: ([], 200))
    out = runner._call_autonomous_monitor(PID, {"taskId": "T1"}, "req")
    assert out["outcome"] == "ESCALATE" and "guard" in out["summary"]   # F08: humano decide
    assert vistos == [HAIKU, SONNET]


class _Legacy:
    """Dublês dos caminhos LEGADOS do runner (off/shadow): registram modelo e kwargs do Guard."""

    def __init__(self, monkeypatch, runner):
        self.checks: list = []
        self.invocados: list = []
        monkeypatch.setattr(runner._llm_guard, "check", lambda **kw: self.checks.append(kw) or {})
        monkeypatch.setattr(runner._llm_guard, "record", lambda *a, **k: None)
        outer = self

        class _Body:
            def read(self):
                return json.dumps({"content": [{"text": "backend python"}], "usage": {}}).encode()

        class _Cli:
            def invoke_model(self, modelId, body):
                outer.invocados.append(modelId)
                return {"body": _Body()}

        monkeypatch.setattr(runner, "_bedrock_client", lambda region: _Cli())
        monkeypatch.setenv("GENESIS_LLM_PROVIDER", "bedrock")
        monkeypatch.setenv("CLAUDE_MODEL", "us.anthropic.claude-sonnet-4-6")


@pytest.mark.parametrize("mode", ["off", "shadow"])
def test_off_e_shadow_equivalem_ao_legado_na_escolha_de_modelo(monkeypatch, runner, direct, mode):
    monkeypatch.setenv("LLM_ROLES_MODE", mode)
    lg = _Legacy(monkeypatch, runner)
    monkeypatch.setenv("CLAUDE_MODEL_STAFF", "claude-haiku-4-5")   # sobra de envelope: off/shadow IGNORAM
    runner._ask_llm_for_backend_language("API")
    runner._ask_llm_for_module("api")
    assert lg.invocados == ["us.anthropic.claude-sonnet-4-6"] * 2   # modelo do env, como sempre
    assert direct == []                                              # nunca o cliente por papel
    assert [c["model"] for c in lg.checks] == ["us.anthropic.claude-sonnet-4-6"] * 2


def test_off_ledger_sem_papel_e_shadow_registra_o_papel_que_seria_usado(monkeypatch, runner):
    monkeypatch.setenv("LLM_ROLES_MODE", "off")
    lg = _Legacy(monkeypatch, runner)
    runner._ask_llm_for_backend_language("API")
    assert "llm_role" not in lg.checks[0] and "effective_role" not in lg.checks[0]
    monkeypatch.setenv("LLM_ROLES_MODE", "shadow")
    runner._ask_llm_for_backend_language("API")
    runner._ask_llm_for_module("api")
    for c in lg.checks[1:]:
        assert (c["llm_role"], c["effective_role"]) == ("staff", "orchestrator") and "escalated_from" not in c


def test_off_sem_slot_mantem_o_default_literal_atual(monkeypatch, runner):
    """Equivalência: off NÃO falha alto; mantém o legado (default literal) — a lei só vale sob `on`."""
    monkeypatch.setenv("LLM_ROLES_MODE", "off")
    lg = _Legacy(monkeypatch, runner)
    monkeypatch.delenv("CLAUDE_MODEL")
    runner._ask_llm_for_backend_language("API")
    assert lg.invocados == ["claude-sonnet-4-6"]


def _bedrock_fake(monkeypatch, sink, negados):
    class _Msgs:
        def create(self, **kw):
            sink.append(kw["model"])
            if kw["model"] in negados:
                raise Exception("AccessDeniedException: not authorized to perform bedrock:InvokeModel")
            return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text="ok")],
                                         usage=types.SimpleNamespace(input_tokens=1, output_tokens=1),
                                         stop_reason="end_turn")

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(
        AnthropicBedrock=lambda **kw: types.SimpleNamespace(messages=_Msgs()), Anthropic=object))


def test_call_bedrock_direct_nao_le_claude_model_fallback_sob_on(api, monkeypatch):
    monkeypatch.setenv("CLAUDE_MODEL_FALLBACK", "us.anthropic.claude-sonnet-4-5")
    runtime._MODEL_DENIED.clear()
    sink: list = []
    _bedrock_fake(monkeypatch, sink, {"us.anthropic.claude-opus-4-8"})
    cfg = {"provider": "bedrock", "aws_access_key_id": "a", "aws_secret_access_key": "b"}
    # off: o env ainda rebaixa (legado intacto)
    out = runtime.call_bedrock_direct("s", "u", "us.anthropic.claude-opus-4-8", llm_cfg=cfg)
    assert out == "ok" and sink == ["us.anthropic.claude-opus-4-8", "us.anthropic.claude-sonnet-4-5"]
    # on: o env não existe; modelo negado propaga (cascata de slots é quem decide)
    runtime._MODEL_DENIED.clear()
    sink.clear()
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    with pytest.raises(Exception, match="AccessDenied"):
        runtime.call_bedrock_direct("s", "u", "us.anthropic.claude-opus-4-8", llm_cfg=cfg)
    assert sink == ["us.anthropic.claude-opus-4-8"]
    runtime._MODEL_DENIED.clear()


def test_call_bedrock_direct_repassa_effective_role_ao_ledger(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    monkeypatch.setattr(runtime, "_call_bedrock_direct_impl", lambda *a, **k: "ok")
    with llm_guard.guard_scope(project_id=PID, purpose="t"):
        runtime.call_bedrock_direct("s", "u", "m", llm_role="staff", effective_role="orchestrator")
    pre = [b for p, b in api.calls if p.endswith("/preflight")][0]
    assert (pre["llmRole"], pre["effectiveRole"]) == ("staff", "orchestrator") and "escalatedFrom" not in pre


# ═══════════════════════ 2A.7 — política de escalonamento ═══════════════════════════════════════

def test_gatilhos_duros_sao_so_rework_e_env_prod():
    rr = llm_roles.required_role
    assert rr("DEV", rework_attempt=1) == rr("QA", rework_attempt=3) == "advisor"
    assert rr("DEV", rework_attempt=0, env="prod") == rr("ENGINEER", env="production") == "advisor"
    assert rr("DEV", rework_attempt=0, env="dev") == rr("DEV", env=None) == rr("DEV", env="staging") == "orchestrator"
    assert rr("CTO", rework_attempt=9, env="prod") == rr("PM", env="prod") == "orchestrator"
    assert rr("QA", env="prod") == "orchestrator"   # QA sobe só pelo piso do Dev, nunca sozinho por env


@pytest.mark.parametrize("kw,esperado", [
    (dict(parse_errors=["json"], gate_errors=[], raw_text="x", stop_reason="end_turn", repair_attempt=1, max_repairs=2), True),
    (dict(parse_errors=[], gate_errors=["campo"], raw_text="x", stop_reason="end_turn", repair_attempt=1, max_repairs=2), True),
    (dict(parse_errors=["json"], gate_errors=[], raw_text="x", stop_reason="max_tokens", repair_attempt=1, max_repairs=2), False),  # truncamento
    (dict(parse_errors=["json"], gate_errors=[], raw_text="  ", stop_reason="end_turn", repair_attempt=1, max_repairs=2), False),   # vazio
    (dict(parse_errors=[], gate_errors=[], raw_text="x", stop_reason="end_turn", repair_attempt=1, max_repairs=2), False),         # sem erro de schema
    (dict(parse_errors=["json"], gate_errors=[], raw_text="x", stop_reason="end_turn", repair_attempt=0, max_repairs=2), False),   # sem reparo anterior
    (dict(parse_errors=["json"], gate_errors=[], raw_text="x", stop_reason="end_turn", repair_attempt=1, max_repairs=1), False),   # 1 só reparo
    (dict(parse_errors=["json"], gate_errors=[], raw_text="x", stop_reason="end_turn", repair_attempt=1, max_repairs=3), False),   # ainda não é o último
])
def test_schema_reprovado_so_escala_apos_reparo_e_sem_truncamento_ou_vazio(kw, esperado):
    assert llm_roles.schema_escalation_eligible(**kw) is esperado


# ── orçamento: idempotência e teto ───────────────────────────────────────────────────────────────

def test_chave_de_escalonamento_task_etapa_papel_tentativa():
    k = llm_roles.escalation_key("T1", "DEV:implement_task:primary", "advisor", 1)
    assert k != llm_roles.escalation_key("T2", "DEV:implement_task:primary", "advisor", 1)
    assert k != llm_roles.escalation_key("T1", "QA:validate_task:primary", "advisor", 1)
    assert k != llm_roles.escalation_key("T1", "DEV:implement_task:primary", "advisor", 2)   # rework 2 ≠ retry do 1
    assert k == llm_roles.escalation_key("T1", "DEV:implement_task:primary", "advisor", 1)


def test_reserve_concede_uma_vez_por_chave_e_libera_quando_a_chamada_nao_saiu():
    b = llm_roles.AdvisorBudget()
    assert b.reserve("p", "k", 1.0).allowed
    r = b.reserve("p", "k", 1.0)
    assert (r.allowed, r.code) == (False, "escalation_deduped")
    assert b.spent("p") == 1.0                       # a 2ª reserva NÃO cobra de novo
    b.release("k")                                   # exceção antes da resposta: nada foi cobrado
    assert b.spent("p") == 0.0 and b.reserve("p", "k", 1.0).allowed
    b.settle("k", 0.25)                              # liquida com o custo real; a chave permanece
    assert b.spent("p") == 0.25 and not b.reserve("p", "k", 0.1).allowed


def test_teto_por_run_cumulativo_e_cap_zero_desliga_o_advisor(monkeypatch):
    b = llm_roles.AdvisorBudget()
    monkeypatch.setenv("ADVISOR_MAX_USD_PER_RUN", "2.5")
    assert b.reserve("p", "a", 1.0).allowed and b.reserve("p", "b", 1.0).allowed
    r = b.reserve("p", "c", 1.0)
    assert (r.allowed, r.code) == (False, "advisor_cap_reached")
    assert b.reserve("outro-run", "c", 1.0).allowed          # escopo (run) separado
    monkeypatch.setenv("ADVISOR_MAX_USD_PER_RUN", "0")
    assert b.reserve("novo", "d", 0.0001).code == "advisor_cap_reached"   # 0 = sem Advisor


def test_cap_default_conservador_e_env_invalida_cai_no_default(monkeypatch):
    assert llm_roles.advisor_cap_usd() == llm_roles.DEFAULT_ADVISOR_CAP_USD == 5.0
    monkeypatch.setenv("ADVISOR_MAX_USD_PER_RUN", "banana")
    assert llm_roles.advisor_cap_usd() == 5.0
    monkeypatch.setenv("ADVISOR_MAX_USD_PER_RUN", "-3")
    assert llm_roles.advisor_cap_usd() == 5.0


def test_chaves_expiram_pelo_ttl_mas_o_gasto_permanece(monkeypatch):
    b = llm_roles.AdvisorBudget()
    b.reserve("p", "k", 1.0)
    b.settle("k", 1.0)
    t0 = llm_roles.time.time()
    monkeypatch.setattr(llm_roles.time, "time", lambda: t0 + 3601)
    assert b.reserve("p", "k", 0.5).allowed and b.spent("p") == 1.5


def test_sem_task_id_nao_ha_dedupe_entre_tarefas_distintas():
    b = llm_roles.AdvisorBudget()
    m = llm_roles.RoleModels(SONNET, OPUS, None)
    kw = dict(required="advisor", models=m, repair_attempt=0, schema_escalate=False, scope="p",
              task_id=None, stage="DEV:x", rework_attempt=1, projected_usd=0.1, budget=b)
    assert llm_roles.plan_attempt(**kw).escalated and llm_roles.plan_attempt(**kw).escalated


# ── run_agent ───────────────────────────────────────────────────────────────────────────────────

_OK = {"request_id": "r", "status": "OK", "artifacts": [], "evidence": [], "next_actions": {},
       "summary": "implementação concluída com evidência suficiente para o validador"}


class _Cli:
    """Cliente falso com roteiro por modelo: 'ok' | 'bad' (JSON inválido) | 'bad_trunc' | 'empty' |
    ('raise', texto). Cada item é consumido uma vez; o último se repete."""

    def __init__(self, script):
        self.script = {m: list(v) for m, v in script.items()}
        self.requests: list = []      # modelo de TODA requisição (inclui as que lançaram)
        self.billed: list = []        # modelo das requisições que RETORNARAM (cobradas)
        self.messages = self

    def create(self, **kw):
        m = kw["model"]
        self.requests.append(m)
        seq = self.script.get(m) or ["ok"]
        step = seq.pop(0) if len(seq) > 1 else seq[0]
        if isinstance(step, tuple):
            raise Exception(step[1])
        self.billed.append(m)
        stop = "end_turn"
        if step == "ok":
            text = json.dumps(_OK)
        elif step == "bad":
            text = "isto não é um envelope json"
        elif step == "bad_trunc":
            text, stop = "isto não é um envelope json", "max_tokens"
        else:
            text = ""
        return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text=text)],
                                     usage=types.SimpleNamespace(input_tokens=10, output_tokens=5), stop_reason=stop)


def _agent(monkeypatch, cli, *, role="DEV", rework=0, task="T-1", models=None, inp_extra=None,
           repairs=2, retries=3):
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=lambda **kw: cli, AnthropicBedrock=object))
    monkeypatch.setattr(runtime, "MAX_REPAIRS", repairs)
    monkeypatch.setattr(runtime, "CLAUDE_RETRY_ATTEMPTS", retries)
    llm = {"provider": "anthropic", "api_key": "k", "model": SONNET, "roles_contract_version": 1,
           "models": models or {"orchestrator": SONNET, "advisor": OPUS, "staff": None}}
    msg = {"request_id": "r", "project_id": PID, "task_id": task,
           "input": {"rework_attempt": rework, "project_id": PID, "task_id": task, **(inp_extra or {})},
           "llm_config": llm}
    return runtime.run_agent("x.md", msg, role=role, system_prompt_override="sys")


def _recs(api):
    return [b for p, b in api.calls if p.endswith("/record")]


def test_rework_escala_uma_vez_e_o_retry_da_mesma_tentativa_nao_escala_de_novo(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    c1 = _Cli({})
    o1 = _agent(monkeypatch, c1, rework=1)
    assert c1.requests == [OPUS] and (o1["_llm_role"], o1["_effective_role"]) == ("advisor", "advisor")
    # retry de rede da MESMA tentativa (client_http reenvia): não é cobrada/escalada outra vez
    c2 = _Cli({})
    o2 = _agent(monkeypatch, c2, rework=1)
    assert c2.requests == [SONNET]                                    # nada de 2º Opus
    assert o2["_escalation_note"] == "escalation_deduped"
    assert (o2["_llm_role"], o2["_effective_role"]) == ("advisor", "orchestrator")
    rec = _recs(api)[-1]
    assert (rec["llmRole"], rec["effectiveRole"]) == ("advisor", "orchestrator") and "escalatedFrom" not in rec
    # rework 2 é OUTRA tentativa de negócio: escala normalmente
    c3 = _Cli({})
    _agent(monkeypatch, c3, rework=2)
    assert c3.requests == [OPUS]


def test_chave_e_liberada_quando_a_chamada_do_advisor_nao_chegou_a_cobrar(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    c1 = _Cli({OPUS: [("raise", "400 invalid_request_error: bad param")]})
    with pytest.raises(RuntimeError):
        _agent(monkeypatch, c1, rework=1)
    assert llm_roles.BUDGET.spent(PID) == 0.0
    c2 = _Cli({})
    o2 = _agent(monkeypatch, c2, rework=1)          # o retry ainda pode escalar: nada foi cobrado
    assert c2.requests == [OPUS] and o2["_effective_role"] == "advisor"


@pytest.mark.parametrize("cap", ["0", "0.000001"])
def test_teto_estourado_nao_escala_registra_e_nao_usa_outro_modelo(api, monkeypatch, cap):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    monkeypatch.setenv("ADVISOR_MAX_USD_PER_RUN", cap)
    cli = _Cli({})
    out = _agent(monkeypatch, cli, rework=1)
    assert cli.requests == [SONNET]                                   # segue no Orchestrator do slot
    assert out["_escalation_note"] == "advisor_cap_reached"
    assert (out["_llm_role"], out["_effective_role"]) == ("advisor", "orchestrator")
    rec = _recs(api)[0]
    assert (rec["llmRole"], rec["effectiveRole"]) == ("advisor", "orchestrator") and "escalatedFrom" not in rec


def test_teto_acumula_por_run_entre_tarefas(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    monkeypatch.setenv("ADVISOR_MAX_USD_PER_RUN", "2.5")
    monkeypatch.setattr(llm_roles, "estimate_cost_usd", lambda i, o: 1.0)   # cada Advisor "custa" US$ 1
    usados = []
    for t in ("T-1", "T-2", "T-3"):
        cli = _Cli({})
        o = _agent(monkeypatch, cli, rework=1, task=t)
        usados.append((cli.requests[0], o.get("_escalation_note")))
    assert usados == [(OPUS, None), (OPUS, None), (SONNET, "advisor_cap_reached")]


def test_env_prod_escala_e_dev_nao(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    c1 = _Cli({})
    _agent(monkeypatch, c1, task="T-p", inp_extra={"env": "prod"})
    c2 = _Cli({})
    _agent(monkeypatch, c2, task="T-d", inp_extra={"env": "dev"})
    assert c1.requests == [OPUS] and c2.requests == [SONNET]


def test_schema_reprovado_apos_reparo_escala_so_o_ultimo_reparo(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    cli = _Cli({SONNET: ["bad"], OPUS: ["ok"]})
    out = _agent(monkeypatch, cli)
    # tentativa 0 e reparo 1 no Orchestrator; reparo 2 (o último) no Advisor — total 3 = 1 + MAX_REPAIRS
    assert cli.requests == [SONNET, SONNET, OPUS]
    assert out["validator_pass"] and (out["_llm_role"], out["_effective_role"]) == ("advisor", "advisor")
    recs = _recs(api)
    assert [(r["llmRole"], r["effectiveRole"], "escalatedFrom" in r) for r in recs] == [
        ("orchestrator", "orchestrator", False), ("orchestrator", "orchestrator", False),
        ("advisor", "advisor", True)]


@pytest.mark.parametrize("falha", ["bad_trunc", "empty"])
def test_truncamento_e_resposta_vazia_nunca_escalam(api, monkeypatch, falha):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    cli = _Cli({SONNET: [falha], OPUS: ["ok"]})
    out = _agent(monkeypatch, cli)
    assert cli.requests == [SONNET] * 3 and OPUS not in cli.requests
    assert out["status"] == "BLOCKED" and out["_effective_role"] == "orchestrator"


def test_excecao_de_rede_nao_escala_e_propaga(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    cli = _Cli({SONNET: [("raise", "Connection timeout")]})
    with pytest.raises(RuntimeError):
        _agent(monkeypatch, cli)
    assert cli.requests == [SONNET] * 3 and OPUS not in cli.requests     # só os retries de transporte


def test_entitlement_negado_nao_escala_e_propaga(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    cli = _Cli({SONNET: [("raise", "AccessDeniedException: not authorized to perform bedrock:InvokeModel")]})
    with pytest.raises(RuntimeError):
        _agent(monkeypatch, cli)
    assert OPUS not in cli.requests


def test_guard_deny_nao_escala_nem_rebaixa_e_devolve_a_reserva(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    api.allow = False
    cli = _Cli({})
    with pytest.raises(llm_guard.LlmGuardDenied):
        _agent(monkeypatch, cli, rework=1)
    assert cli.requests == [] and llm_roles.BUDGET.spent(PID) == 0.0     # nenhum modelo chamado; reserva devolvida
    api.allow = True
    cli2 = _Cli({})
    _agent(monkeypatch, cli2, rework=1)                                  # a mesma tentativa ainda pode escalar
    assert cli2.requests == [OPUS]


@pytest.mark.parametrize("mode", [None, "off", "shadow"])
def test_off_e_shadow_nao_escalam_por_schema_nem_env_prod(api, monkeypatch, mode):
    if mode:
        monkeypatch.setenv("LLM_ROLES_MODE", mode)
    cli = _Cli({SONNET: ["bad"], OPUS: ["ok"]})
    out = _agent(monkeypatch, cli, inp_extra={"env": "prod"})
    assert cli.requests == [SONNET] * 3 and out["status"] == "BLOCKED"   # escolha de modelo = legado
    if mode == "shadow":
        assert out["_llm_role"] == "advisor" and out["_effective_role"] == "orchestrator"   # shadow só registra
    else:
        assert "_llm_role" not in out


@pytest.mark.parametrize("retries", [1, 2, 3, 4])
@pytest.mark.parametrize("repairs", [0, 1, 2, 3])
def test_pior_caso_retries_x_repairs_tem_limite_maximo_provado(api, monkeypatch, retries, repairs):
    """Pior caso: rework (Advisor na 1ª tentativa) + schema reprovado SEMPRE + erro transitório de rede
    em toda requisição menos a última de cada tentativa. Limite provado:
      · respostas COBRADAS do Advisor ≤ 2 (tentativa 0 de rework + último reparo por schema);
      · requisições ao Advisor ≤ 2 × CLAUDE_RETRY_ATTEMPTS (retry de transporte não cria escalada nova);
      · respostas cobradas no total ≤ 1 + MAX_REPAIRS (retries × repairs NÃO multiplicam o 2,5×)."""
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    flaky = [("raise", "Read timeout")] * (retries - 1) + ["bad"]
    cli = _Cli({SONNET: flaky, OPUS: flaky})
    # cada tentativa reinicia o roteiro: repete o padrão (transitórios + resposta inválida)
    orig = cli.create
    estado = {"n": 0}

    def create(**kw):
        seq_pos = estado["n"] % retries
        estado["n"] = 0 if seq_pos == retries - 1 else estado["n"] + 1
        cli.script[kw["model"]] = [flaky[seq_pos]]
        return orig(**kw)

    cli.create = create
    out = _agent(monkeypatch, cli, rework=1, repairs=repairs, retries=retries, task=f"T-{retries}-{repairs}")
    adv_req = cli.requests.count(OPUS)
    adv_billed = cli.billed.count(OPUS)
    assert adv_billed <= 2
    assert adv_req <= 2 * retries
    assert len(cli.billed) <= 1 + repairs
    assert out["status"] == "BLOCKED"
    esperado_adv = 1 + (1 if repairs >= 2 else 0)          # tentativa 0 + último reparo (só com MAX_REPAIRS >= 2)
    assert adv_billed == esperado_adv


# ── /invoke/raw: failover de disponibilidade NÃO é advisor ─────────────────────────────────────

def _invoke(monkeypatch, mode):
    from orchestrator.agents import server
    vistos: list = []

    def fake(system, user, model_id, **kw):
        vistos.append((model_id, kw.get("llm_role"), kw.get("effective_role"), kw.get("escalated_from"),
                       (kw.get("waste") or {}).get("call_reason")))
        return "" if model_id == "m-orq" else "ok"

    monkeypatch.setattr(runtime, "call_bedrock_direct", fake)
    monkeypatch.setenv("LLM_ROLES_MODE", mode)
    monkeypatch.setenv("WASTE_TELEMETRY", "shadow")
    out = server.invoke_raw({"prompt_override": "s", "user_message": "u", "model_id": "m-orq",
                             "model_id_fallback": "m-fb", "llm_config": {"provider": "bedrock"}})
    return out, vistos


def test_failover_do_invoke_raw_nao_e_advisor_no_ledger_em_shadow(monkeypatch):
    out, v = _invoke(monkeypatch, "shadow")
    assert [x[0] for x in v] == ["m-orq", "m-fb"] and out["fallback"] is True    # modelo: igual ao legado
    assert v[1][1:] == ("orchestrator", "orchestrator", None, "retry")           # NÃO advisor, sem escalated_from


def test_failover_do_invoke_raw_off_nao_carimba_papel(monkeypatch):
    out, v = _invoke(monkeypatch, "off")
    assert [x[0] for x in v] == ["m-orq", "m-fb"] and v[1][1:4] == (None, None, None)


def test_failover_do_invoke_raw_sob_on_nao_chama_o_fallback(monkeypatch):
    out, v = _invoke(monkeypatch, "on")
    assert [x[0] for x in v] == ["m-orq"] and "fallback" not in out
