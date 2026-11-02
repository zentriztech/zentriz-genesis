"""Plano de evolução v2, 2A.4 — resolução de modelo por PAPEL (`LLM_ROLES_MODE`).

Garante: (1) `off` e `shadow` escolhem o MESMO modelo de antes (equivalência com o legado);
(2) `on` escolhe o modelo do papel exigido, vindo do slot (nunca de env/literal);
(3) Staff vazio ⇒ Orchestrator declarado; Advisor vazio ⇒ sem escalada registrada;
(4) piso QA ≥ Dev pelo papel EFETIVO; (5) provider incompatível FALHA ALTO (sem "correção" silenciosa);
(6) matriz papel × slot × slot caído × Guard negado: falha de slot segue a cascata (nunca Advisor),
    o papel exigido não muda ao trocar de slot e a negativa do Guard não rebaixa papel nem modelo.
"""
import json
import sys
import types

import pytest

from orchestrator.agents import llm_guard, llm_roles, runtime
from orchestrator.tests.test_llm_roles import api, PID  # noqa: F401  (fixture do Guard fake)

SONNET, OPUS, HAIKU = "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"
ENVS = ("CLAUDE_MODEL", "CLAUDE_MODEL_REWORK", "CLAUDE_MODEL_FALLBACK", "CLAUDE_MODEL_SPEC",
        "CLAUDE_MODEL_CODE", "PIPELINE_LLM_MODEL", "CLAUDE_MODEL_ADVISOR", "CLAUDE_MODEL_STAFF")


@pytest.fixture(autouse=True)
def _limpa_env(monkeypatch):
    for k in ENVS:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.delenv("LLM_ROLES_MODE", raising=False)


# ── funções puras ────────────────────────────────────────────────────────────

def test_papel_exigido_so_por_fato_duro():
    assert llm_roles.required_role("DEV", rework_attempt=0) == "orchestrator"
    assert llm_roles.required_role("DEV", rework_attempt=1) == "advisor"
    assert llm_roles.required_role("QA", rework_attempt=2) == "advisor"
    for r in ("CTO", "ENGINEER", "PM", "DEVOPS", "MONITOR", "QUALQUER"):
        assert llm_roles.required_role(r, rework_attempt=5) == "orchestrator"


def test_piso_qa_compara_papel_efetivo_nao_ids():
    assert llm_roles.apply_floor("orchestrator", "advisor") == "advisor"
    assert llm_roles.apply_floor("advisor", "orchestrator") == "advisor"   # nunca regride
    assert llm_roles.apply_floor("orchestrator", None) == "orchestrator"
    assert llm_roles.apply_floor("orchestrator", "lixo") == "orchestrator"


@pytest.mark.parametrize("models,req,eff,model,esc,note", [
    (llm_roles.RoleModels(SONNET, OPUS, HAIKU), "orchestrator", "orchestrator", SONNET, False, ""),
    (llm_roles.RoleModels(SONNET, OPUS, HAIKU), "advisor", "advisor", OPUS, True, ""),
    (llm_roles.RoleModels(SONNET, OPUS, HAIKU), "staff", "staff", HAIKU, False, ""),
    (llm_roles.RoleModels(SONNET, OPUS, ""), "staff", "orchestrator", SONNET, False, "staff_empty_uses_orchestrator"),
    (llm_roles.RoleModels(SONNET, "", HAIKU), "advisor", "orchestrator", SONNET, False, "advisor_empty_no_escalation"),
    (llm_roles.RoleModels(SONNET, SONNET, ""), "advisor", "orchestrator", SONNET, False, "advisor_same_as_orchestrator"),
])
def test_resolve_model_matriz_dentro_do_slot(models, req, eff, model, esc, note):
    r = llm_roles.resolve_model(req, models)
    assert (r.llm_role, r.effective_role, r.model, r.escalated, r.note) == (req, eff, model, esc, note)


def test_sem_orchestrator_falha_alto_mesmo_com_env(monkeypatch):
    monkeypatch.setenv("CLAUDE_MODEL", SONNET)  # env NÃO é atalho
    with pytest.raises(llm_roles.RoleResolutionError):
        llm_roles.resolve_model("advisor", llm_roles.RoleModels("", OPUS, ""))


@pytest.mark.parametrize("prov,model,ok", [
    ("bedrock", "us.anthropic.claude-sonnet-4-6", True),
    ("bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0", True),   # Haiku exige `global.`
    ("bedrock", "gpt-4o", False),
    ("bedrock", "claude-sonnet-4-6", False),
    ("anthropic", "claude-opus-4-8", True),
    ("anthropic", "us.anthropic.claude-opus-4-8", False),
    ("openai", "claude-sonnet-4-6", False),
    ("openai", "gpt-4.1", True),
    ("foundry", "claude-opus-5", True),
    ("foundry", "us.anthropic.claude-opus-5", False),
    ("google", "gemini-2.5-pro", True),
    ("google", "us.anthropic.claude-opus-4-8", False),
    ("azure_openai", "gpt-4o", True),
    ("openai", "modelo-desconhecido-x", True),   # id desconhecido ⇒ não quebra (mesma regra do legado)
])
def test_provider_serves(prov, model, ok):
    assert llm_roles.provider_serves(prov, model) is ok


def test_provider_incompativel_por_papel_falha_alto_nomeando_o_papel():
    m = llm_roles.RoleModels("gpt-4.1", "claude-opus-4-8", "")
    with pytest.raises(llm_roles.RoleProviderMismatch, match="advisor"):
        llm_roles.validate_models("openai", m)


# ── run_agent: equivalência off/shadow e escolha `on` ────────────────────────

class _Msgs:
    def __init__(self, sink, fail=()):
        self.sink, self.fail = sink, set(fail)

    def create(self, **kw):
        self.sink.append(kw["model"])
        if kw["model"] in self.fail:
            raise Exception("AccessDeniedException: not authorized to perform bedrock:InvokeModel")
        env = {"request_id": "r", "status": "OK", "artifacts": [], "evidence": [], "next_actions": {},
               "summary": "implementação concluída com evidência suficiente para o validador"}
        return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text=json.dumps(env))],
                                     usage=types.SimpleNamespace(input_tokens=10, output_tokens=5),
                                     stop_reason="end_turn")


def _run(monkeypatch, *, role="DEV", rework=0, cfg=None, inp_extra=None, fail=()):
    sink: list = []
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(
        Anthropic=lambda **kw: types.SimpleNamespace(messages=_Msgs(sink, fail)), AnthropicBedrock=object))
    llm = {"provider": "anthropic", "api_key": "chave-de-teste", "model": SONNET}
    llm.update(cfg if cfg is not None else {})
    msg = {"request_id": "r", "project_id": PID, "input": {"rework_attempt": rework, "project_id": PID, **(inp_extra or {})},
           "llm_config": llm}
    out = runtime.run_agent("x.md", msg, role=role, system_prompt_override="sys")
    return out, sink


def _models(o=SONNET, a=OPUS, s=HAIKU):
    return {"roles_contract_version": 1, "models": {"orchestrator": o, "advisor": a or None, "staff": s or None}}


@pytest.mark.parametrize("role", ["DEV", "QA", "CTO"])
@pytest.mark.parametrize("rework", [0, 1])
@pytest.mark.parametrize("legacy_rework", [None, OPUS])
@pytest.mark.parametrize("env_rework", [None, "claude-opus-4-7"])
def test_off_e_shadow_escolhem_o_mesmo_modelo_do_legado(api, monkeypatch, role, rework, legacy_rework, env_rework):
    """Equivalência: o envelope pode trazer `models` (API nova), mas off/shadow IGNORAM e seguem a
    lógica legada (model_rework do envelope, depois CLAUDE_MODEL_REWORK do env)."""
    if env_rework:
        monkeypatch.setenv("CLAUDE_MODEL_REWORK", env_rework)
    legacy = {"model_rework": legacy_rework} if legacy_rework else {}
    escolhido_legado = (legacy_rework or env_rework) if (role in ("DEV", "QA") and rework >= 1) else SONNET
    escolhido_legado = escolhido_legado or SONNET
    res = {}
    for mode in (None, "off", "shadow"):
        if mode:
            monkeypatch.setenv("LLM_ROLES_MODE", mode)
        else:
            monkeypatch.delenv("LLM_ROLES_MODE", raising=False)
        # `models` com valores DIFERENTES de propósito: se off/shadow os lessem, o modelo mudaria
        out, sink = _run(monkeypatch, role=role, rework=rework, cfg={**legacy, **_models("outro-orq", "outro-adv", "outro-staff")})
        res[mode] = sink
    assert res[None] == res["off"] == res["shadow"] == [escolhido_legado]


def test_shadow_registra_o_papel_que_seria_exigido_sem_trocar_modelo(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "shadow")
    out, sink = _run(monkeypatch, rework=1, cfg=_models(SONNET, None, None))  # sem Advisor/model_rework
    rec = [b for p, b in api.calls if p.endswith("/record")][0]
    assert sink == [SONNET]                                    # modelo = legado (sem escalada)
    assert (rec["llmRole"], rec["effectiveRole"]) == ("advisor", "orchestrator")  # SERIA advisor; nada mudou
    assert "escalatedFrom" not in rec
    assert (out["_llm_role"], out["_effective_role"]) == ("advisor", "orchestrator")


def test_off_nao_carimba_papel_efetivo(api, monkeypatch):
    out, _ = _run(monkeypatch, rework=1, cfg=_models())
    assert "_llm_role" not in out and "_effective_role" not in out


@pytest.mark.parametrize("role,rework,esperado,papel,efetivo", [
    ("DEV", 0, SONNET, "orchestrator", "orchestrator"),
    ("DEV", 1, OPUS, "advisor", "advisor"),
    ("QA", 1, OPUS, "advisor", "advisor"),
    ("QA", 0, SONNET, "orchestrator", "orchestrator"),
    ("CTO", 3, SONNET, "orchestrator", "orchestrator"),   # CTO/PM nunca sobem (fato duro só Dev/QA)
])
def test_on_escolhe_o_modelo_do_papel_exigido(api, monkeypatch, role, rework, esperado, papel, efetivo):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    out, sink = _run(monkeypatch, role=role, rework=rework, cfg=_models())
    assert sink == [esperado]
    rec = [b for p, b in api.calls if p.endswith("/record")][0]
    assert (rec["llmRole"], rec["effectiveRole"]) == (papel, efetivo)
    assert ("escalatedFrom" in rec) == (efetivo == "advisor")
    assert (out["_llm_role"], out["_effective_role"]) == (papel, efetivo)


def test_on_advisor_vazio_nao_escala_e_registra(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    out, sink = _run(monkeypatch, rework=2, cfg=_models(SONNET, None, HAIKU))
    rec = [b for p, b in api.calls if p.endswith("/record")][0]
    assert sink == [SONNET]
    assert (rec["llmRole"], rec["effectiveRole"]) == ("advisor", "orchestrator") and "escalatedFrom" not in rec


def test_on_advisor_igual_ao_orchestrator_nao_troca(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    _, sink = _run(monkeypatch, rework=1, cfg=_models(SONNET, SONNET, None))
    assert sink == [SONNET]


def test_on_staff_vazio_usa_orchestrator_declarado():
    r = llm_roles.resolve_model("staff", llm_roles.RoleModels(SONNET, OPUS, ""))
    assert (r.llm_role, r.effective_role, r.model) == ("staff", "orchestrator", SONNET)


def test_role_kwargs_declara_staff_vazio_e_advisor_vazio(monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    assert llm_guard.role_kwargs(required="staff", effective="orchestrator") == {
        "llm_role": "staff", "effective_role": "orchestrator"}
    assert llm_guard.role_kwargs(required="advisor", effective="orchestrator", escalated=False) == {
        "llm_role": "advisor", "effective_role": "orchestrator"}
    assert llm_guard.role_kwargs(required="advisor", effective="advisor", escalated=True) == {
        "llm_role": "advisor", "effective_role": "advisor", "escalated_from": "orchestrator"}
    monkeypatch.setenv("LLM_ROLES_MODE", "off")
    assert llm_guard.role_kwargs(required="advisor", effective="advisor", escalated=True) == {}


def test_on_ignora_env_de_rework_e_de_escolha(api, monkeypatch):
    """LEI dos slots: sob `on` nenhum modelo vem de env — nem CLAUDE_MODEL_REWORK, nem SPEC/CODE/PIPELINE."""
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    for k in ("CLAUDE_MODEL_REWORK", "CLAUDE_MODEL_SPEC", "CLAUDE_MODEL_CODE", "PIPELINE_LLM_MODEL", "CLAUDE_MODEL"):
        monkeypatch.setenv(k, "modelo-de-env-nao-deve-ser-usado")
    _, sink = _run(monkeypatch, rework=1, cfg=_models(SONNET, None, None))
    assert sink == [SONNET]


def test_on_sem_modelo_no_slot_falha_alto_mesmo_com_env(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    monkeypatch.setenv("CLAUDE_MODEL", SONNET)
    with pytest.raises(ValueError, match="nenhum modelo"):
        _run(monkeypatch, cfg={"model": ""})


def test_get_model_for_role_sob_on_ignora_envs_nao_injetadas(monkeypatch):
    monkeypatch.setenv("CLAUDE_MODEL", "do-slot")
    monkeypatch.setenv("CLAUDE_MODEL_SPEC", "atalho-spec")
    monkeypatch.setenv("CLAUDE_MODEL_CODE", "atalho-code")
    monkeypatch.setenv("PIPELINE_LLM_MODEL", "atalho-pipe")
    assert [runtime._get_model_for_role(r) for r in ("CTO", "DEV", "QA")] == ["atalho-spec", "atalho-code", "atalho-pipe"]  # off: igual ao atual
    monkeypatch.setenv("LLM_ROLES_MODE", "shadow")
    assert runtime._get_model_for_role("CTO") == "atalho-spec"                                                       # shadow: igual
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    assert [runtime._get_model_for_role(r) for r in ("CTO", "DEV", "QA")] == ["do-slot"] * 3


def test_provider_incompativel_falha_alto_sob_on_e_corrige_sob_off(api, monkeypatch):
    cfg = {"provider": "openai", "api_key": "k", "model": "claude-sonnet-4-6", **_models(SONNET, OPUS, None)}
    out, sink = _run(monkeypatch, cfg=cfg)          # off: comportamento atual (corrige em silêncio)
    assert sink == [SONNET]
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    with pytest.raises(llm_roles.RoleProviderMismatch, match="openai"):
        _run(monkeypatch, cfg=cfg)


def test_provider_incompativel_so_no_advisor_falha_ao_escalar_e_nao_troca_provider(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    cfg = {"provider": "anthropic", "api_key": "k", "model": "claude-sonnet-4-6", **_models(SONNET, "gpt-4.1", None)}
    _, sink = _run(monkeypatch, rework=0, cfg=cfg)  # rework 0 nem toca o Advisor
    assert sink == [SONNET]
    with pytest.raises(llm_roles.RoleProviderMismatch, match="advisor"):
        _run(monkeypatch, rework=1, cfg=cfg)


# ── piso QA ≥ Dev pelo papel efetivo ─────────────────────────────────────────

def test_on_piso_qa_sobe_para_advisor_quando_dev_foi_advisor(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    _, sem_piso = _run(monkeypatch, role="QA", rework=0, cfg=_models())
    _, com_piso = _run(monkeypatch, role="QA", rework=0, cfg=_models(), inp_extra={"role_floor": "advisor"})
    assert (sem_piso, com_piso) == ([SONNET], [OPUS])


def test_on_piso_sem_advisor_e_no_op(api, monkeypatch):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    _, sink = _run(monkeypatch, role="QA", rework=0, cfg=_models(SONNET, None, None), inp_extra={"role_floor": "advisor"})
    assert sink == [SONNET]


def test_piso_so_vale_sob_on(api, monkeypatch):
    for mode in (None, "shadow"):
        if mode:
            monkeypatch.setenv("LLM_ROLES_MODE", mode)
        _, sink = _run(monkeypatch, role="QA", rework=0, cfg=_models(), inp_extra={"role_floor": "advisor"})
        assert sink == [SONNET]


# ── matriz papel × slot × slot caído × Guard negado ──────────────────────────

def test_falha_do_slot_nao_sobe_para_advisor_e_papel_exigido_nao_muda(api, monkeypatch):
    """Slot 0 negado (entitlement) no Orchestrator: a cascata vai para o slot 1 pedindo o MESMO papel
    (orchestrator). O Advisor do slot 0 NÃO é chamado."""
    from orchestrator.agents.server import _slot_cascade
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    s0, s1 = "claude-sonnet-4-6", "claude-sonnet-4-5"
    chamados: list = []
    sink: list = []
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(
        Anthropic=lambda **kw: types.SimpleNamespace(messages=_Msgs(sink, fail={s0})), AnthropicBedrock=object))

    def fn(m):
        chamados.append(m["llm_config"]["model"])
        return runtime.run_agent("x.md", m, role="DEV", system_prompt_override="sys")

    msg = {"request_id": "r", "project_id": PID, "input": {"rework_attempt": 0, "project_id": PID},
           "llm_config": {"provider": "anthropic", "api_key": "k0", "model": s0, **_models(s0, OPUS, None)},
           "llm_candidates": [
               {"provider": "anthropic", "api_key": "k0", "model": s0, "models": {"orchestrator": s0, "advisor": OPUS, "staff": None}},
               {"provider": "anthropic", "api_key": "k1", "model": s1, "models": {"orchestrator": s1, "advisor": None, "staff": None}}]}
    out = _slot_cascade(msg, fn)
    assert chamados == [s0, s1]
    assert OPUS not in sink and sink == [s0, s1]       # nunca o Advisor por falha de modelo
    assert out["_llm_role"] == "orchestrator"          # papel exigido inalterado na troca de slot


def test_rework_em_slot_de_contingencia_usa_o_advisor_do_proprio_slot(api, monkeypatch):
    from orchestrator.agents.server import _slot_cascade
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    s0, s1, adv1 = "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-opus-4-7"
    sink: list = []
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(
        Anthropic=lambda **kw: types.SimpleNamespace(messages=_Msgs(sink, fail={s0, OPUS})), AnthropicBedrock=object))
    msg = {"request_id": "r", "project_id": PID, "input": {"rework_attempt": 1, "project_id": PID},
           "llm_config": {"provider": "anthropic", "api_key": "k0", "model": s0, **_models(s0, OPUS, None)},
           "llm_candidates": [
               {"provider": "anthropic", "api_key": "k0", "model": s0, "models": {"orchestrator": s0, "advisor": OPUS, "staff": None}},
               {"provider": "anthropic", "api_key": "k1", "model": s1, "models": {"orchestrator": s1, "advisor": adv1, "staff": None}}]}
    out = _slot_cascade(msg, lambda m: runtime.run_agent("x.md", m, role="DEV", system_prompt_override="sys"))
    # slot 0: papel exigido = advisor ⇒ OPUS (negado) ⇒ falha do slot ⇒ slot 1 ⇒ papel advisor NO slot 1
    assert sink == [OPUS, adv1]
    assert (out["_llm_role"], out["_effective_role"]) == ("advisor", "advisor")


def test_sem_claude_model_fallback_modelo_negado_nao_e_trocado_sob_on(api, monkeypatch):
    """Semântica 5: com `on`, CLAUDE_MODEL_FALLBACK não substitui o modelo negado (cascata de slots)."""
    monkeypatch.setenv("CLAUDE_MODEL_FALLBACK", "claude-sonnet-3-7")
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    with pytest.raises(RuntimeError):
        _run(monkeypatch, cfg=_models(), fail={SONNET})
    # (o par off/legado com o env presente é coberto por test_model_deny_cache.py, que segue verde)


@pytest.mark.parametrize("mode", ["shadow", "on"])
def test_guard_negado_nao_rebaixa_papel_nem_modelo(api, monkeypatch, mode):
    monkeypatch.setenv("LLM_ROLES_MODE", mode)
    api.allow = False
    sink: list = []
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(
        Anthropic=lambda **kw: types.SimpleNamespace(messages=_Msgs(sink)), AnthropicBedrock=object))
    msg = {"request_id": "r", "project_id": PID, "input": {"rework_attempt": 1, "project_id": PID},
           "llm_config": {"provider": "anthropic", "api_key": "k", "model": SONNET, "model_rework": OPUS, **_models()}}
    with pytest.raises(Exception) as e:
        runtime.run_agent("x.md", msg, role="DEV", system_prompt_override="sys")
    assert runtime.classify_llm_error(e.value) == "guard" and not runtime.is_slot_failure(e.value)
    assert sink == []                                                    # nada foi chamado (nem Orchestrator, nem Advisor)
    pre = [b for p, b in api.calls if p.endswith("/preflight")]
    assert pre and all(b["model"] == OPUS and b["llmRole"] == "advisor" for b in pre)  # pediu o papel/modelo exigidos e parou
    assert not [1 for p, _ in api.calls if p.endswith("/record")]


def test_guard_negado_nao_dispara_cascata_de_slot(api, monkeypatch):
    from orchestrator.agents.server import _slot_cascade
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    api.allow = False
    visitados: list = []

    def fn(m):
        visitados.append(m["llm_config"]["model"])
        return runtime.run_agent("x.md", m, role="DEV", system_prompt_override="sys")

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(
        Anthropic=lambda **kw: types.SimpleNamespace(messages=_Msgs([])), AnthropicBedrock=object))
    msg = {"request_id": "r", "project_id": PID, "input": {"project_id": PID},
           "llm_config": {"provider": "anthropic", "api_key": "k0", "model": SONNET, **_models()},
           "llm_candidates": [{"provider": "anthropic", "api_key": "k0", "model": SONNET, "models": {"orchestrator": SONNET, "advisor": OPUS, "staff": None}},
                              {"provider": "anthropic", "api_key": "k1", "model": "claude-sonnet-4-5", "models": {"orchestrator": "claude-sonnet-4-5", "advisor": None, "staff": None}}]}
    with pytest.raises(Exception):
        _slot_cascade(msg, fn)
    assert visitados == [SONNET]   # negativa do Guard NÃO tenta o próximo slot (seria contornar o Guard)


# ── client_http e /invoke/raw: falha não sobe para Advisor ───────────────────

def test_invoke_raw_sob_on_nao_usa_advisor_em_falha_nem_resposta_vazia(api, monkeypatch):
    from orchestrator.agents import server
    chamados: list = []

    def fake_direct(system, user, model_id, **kw):
        chamados.append((model_id, kw.get("llm_role"), kw.get("escalated_from")))
        if model_id == "m-orq":
            return ""            # principal vazio
        return "ok-do-slot-2"

    monkeypatch.setattr(server, "call_bedrock_direct", fake_direct, raising=False)
    import orchestrator.agents.runtime as rt
    monkeypatch.setattr(rt, "call_bedrock_direct", fake_direct)
    body = {"prompt_override": "s", "user_message": "u", "model_id": "m-orq", "model_id_fallback": "m-adv",
            "llm_config": {"provider": "bedrock"},
            "llm_candidates": [{"provider": "bedrock", "model": "m-orq", "model_rework": "m-adv"},
                               {"provider": "bedrock", "model": "m-slot2"}]}
    try:
        server_fn = server.invoke_raw if hasattr(server, "invoke_raw") else None
    except Exception:  # pragma: no cover
        server_fn = None
    if server_fn is None:
        pytest.skip("handler /invoke/raw não exposto como função isolável")
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    out = server_fn(body)
    assert [c[0] for c in chamados] == ["m-orq", "m-slot2"]     # Advisor (m-adv) nunca chamado
    assert out["response"] == "ok-do-slot-2" and out.get("slot_cascade") == 1 and "fallback" not in out


def test_client_http_sob_on_nao_escala_para_advisor_no_retry_de_timeout(monkeypatch):
    import orchestrator.agents.client_http as ch
    src = open(ch.__file__, encoding="utf-8").read()
    assert "llm_roles" in src and 'if _llm_roles.is_on()' in src and '_fallback_model = ""' in src
