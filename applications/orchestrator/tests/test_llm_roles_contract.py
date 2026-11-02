"""Plano de evolução v2, 2A.5 — contrato de transporte por papel, testado NOS DOIS SENTIDOS.

Envelope ADITIVO e VERSIONADO (`roles_contract_version` + `models{orchestrator,advisor,staff}`), sem
credencial por papel. As fixtures `fixtures/llm_roles_envelope_{legacy,v1}.json` são geradas/conferidas
pelo teste do api-node (`tenantLlmConfig.roles-routing.test.ts`): o que o TypeScript EMITE é o que
o Python aqui CONSOME.

(i)  API nova + agents/runner ANTIGO: o consumidor antigo (cópia congelada da leitura de antes da 2A.5)
     lê o envelope novo e obtém exatamente o mesmo resultado do envelope legado — os campos extras são
     ignorados.
(ii) agents/runner NOVO + API ANTIGA: payload sem os campos novos cai no comportamento legado, em
     off, shadow e on.
"""
import json
import os
import subprocess
import sys
import types
import urllib.request

import pytest

from orchestrator.agents import llm_roles, runtime, server
from orchestrator.tests.test_llm_roles import api, PID  # noqa: F401

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
LEGACY = json.load(open(os.path.join(FIX, "llm_roles_envelope_legacy.json"), encoding="utf-8"))
V1 = json.load(open(os.path.join(FIX, "llm_roles_envelope_v1.json"), encoding="utf-8"))
SONNET, OPUS = "us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-opus-4-8"
HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0"


# ── consumidor ANTIGO, congelado (cópia literal da leitura de antes da 2A.5) ──────────────────────

def _legacy_wrap_with_llm_config(body: dict) -> dict:
    message = {"request_id": body.get("request_id", "http"), "input": body}
    llm_cfg = body.get("llm_config")
    if isinstance(llm_cfg, dict) and llm_cfg:
        rework = str(body.get("model_id_rework") or "").strip()
        message["llm_config"] = {**llm_cfg, "model_rework": rework} if rework else llm_cfg
    cands = body.get("llm_candidates")
    if isinstance(cands, list) and cands:
        message["llm_candidates"] = cands
    return message


def _legacy_llm_candidates(body: dict) -> list:
    cfg0 = body.get("llm_config") if isinstance(body.get("llm_config"), dict) else {}
    m0 = str(body.get("model_id") or (cfg0 or {}).get("model") or "").strip()
    f0 = str(body.get("model_id_fallback") or body.get("model_id_rework")
             or (cfg0 or {}).get("model_rework") or "").strip()
    out: list = []
    if m0:
        out.append({"model": m0, "fallback": f0, "llm_cfg": (cfg0 or None)})
    for cand in (body.get("llm_candidates") or []):
        if not isinstance(cand, dict):
            continue
        m = str(cand.get("model") or "").strip()
        if not m:
            continue
        if any(c["model"] == m and str((c["llm_cfg"] or {}).get("provider") or "")
               == str(cand.get("provider") or "") for c in out):
            continue
        out.append({"model": m, "fallback": str(cand.get("model_rework") or "").strip(), "llm_cfg": cand})
    return out


def _legacy_read(env: dict):
    """(modelo, rework, credenciais, fila de candidatos) como o agents ANTIGO enxerga o corpo."""
    msg = _legacy_wrap_with_llm_config(env)
    cfg = msg["llm_config"]
    cands = _legacy_llm_candidates({"llm_config": msg["llm_config"], "llm_candidates": msg.get("llm_candidates") or []})
    fila = [(c["model"], c["fallback"], c["llm_cfg"].get("aws_access_key_id")) for c in cands]
    return env["model_id"], cfg.get("model_rework"), cfg.get("aws_access_key_id"), fila


# ── (i) API nova + agents/runner antigo ──────────────────────────────────────

def test_fixture_v1_so_acrescenta_campos_em_relacao_ao_legado():
    def strip(o):
        o = {k: v for k, v in o.items() if k not in ("roles_contract_version", "models")}
        o["llm_candidates"] = [{k: v for k, v in c.items() if k != "models"} for c in o["llm_candidates"]]
        return o
    assert strip(V1) == LEGACY
    assert V1["roles_contract_version"] == 1 and set(V1["models"]) == {"orchestrator", "advisor", "staff"}


def test_agents_antigo_le_envelope_novo_igual_ao_legado():
    assert _legacy_read(V1) == _legacy_read(LEGACY)
    modelo, rework, ak, fila = _legacy_read(V1)
    assert (modelo, rework, ak) == (SONNET, OPUS, "AKIA_FAKE_0") and len(fila) == 2


def test_nao_ha_credencial_por_papel_no_envelope():
    dump = json.dumps([V1["models"]] + [c["models"] for c in V1["llm_candidates"]])
    assert "AKIA" not in dump and "SECRET" not in dump
    for c in V1["llm_candidates"]:
        assert not [k for k in c if k.lower() in ("advisor", "staff", "orchestrator")]


def test_runner_antigo_ignora_campos_novos_da_resposta_do_slot():
    """Cópia da leitura antiga do `runner_server`: só `provider`, `modelId`, `fallbackModelId`, creds."""
    resp_novo = {"ok": True, "provider": "bedrock", "modelId": SONNET, "fallbackModelId": OPUS,
                 "awsAccessKeyId": "AKIA_FAKE_0", "roles_contract_version": 1,
                 "models": {"orchestrator": SONNET, "advisor": OPUS, "staff": HAIKU}}
    resp_antigo = {k: v for k, v in resp_novo.items() if k not in ("roles_contract_version", "models")}
    ler = lambda r: ((r.get("provider") or "").lower(), (r.get("modelId") or "").strip(),  # noqa: E731
                     (r.get("fallbackModelId") or "").strip(), r.get("awsAccessKeyId"))
    assert ler(resp_novo) == ler(resp_antigo)


# ── (ii) agents/runner novo + API antiga ─────────────────────────────────────

@pytest.mark.parametrize("mode", [None, "off", "shadow", "on"])
def test_agents_novo_com_payload_legado_nao_muda_o_envelope(monkeypatch, mode):
    if mode:
        monkeypatch.setenv("LLM_ROLES_MODE", mode)
    assert server._wrap_with_llm_config(LEGACY) == _legacy_wrap_with_llm_config(LEGACY)
    assert runtime.llm_candidates({"llm_config": LEGACY["llm_config"], "llm_candidates": LEGACY["llm_candidates"],
                                   "model_id": LEGACY["model_id"], "model_id_rework": LEGACY["model_id_rework"]}) == \
        _legacy_llm_candidates({"llm_config": LEGACY["llm_config"], "llm_candidates": LEGACY["llm_candidates"],
                                "model_id": LEGACY["model_id"], "model_id_rework": LEGACY["model_id_rework"]})


def test_agents_novo_aceita_model_rework_legado_e_models_novo():
    legado = server._wrap_with_llm_config(LEGACY)["llm_config"]
    assert legado["model_rework"] == OPUS and "models" not in legado
    novo = server._wrap_with_llm_config(V1)["llm_config"]
    assert novo["model_rework"] == OPUS                                   # legado preservado
    assert novo["models"] == V1["models"] and novo["roles_contract_version"] == 1
    # `models` sem versão (corpo malformado) NÃO é promovido: sem contrato, sem roteamento
    sem_versao = {k: v for k, v in V1.items() if k != "roles_contract_version"}
    assert "models" not in server._wrap_with_llm_config(sem_versao)["llm_config"]


def test_models_do_envelope_antigo_derivam_do_legado_e_do_novo_igualmente():
    assert llm_roles.models_from_llm_cfg(server._wrap_with_llm_config(LEGACY)["llm_config"]) == \
        llm_roles.RoleModels(SONNET, OPUS, "")                           # legado: model_rework = Advisor
    assert llm_roles.models_from_llm_cfg(server._wrap_with_llm_config(V1)["llm_config"]) == \
        llm_roles.RoleModels(SONNET, OPUS, HAIKU)


def test_versao_futura_do_contrato_cai_no_legado():
    cfg = {"model": SONNET, "model_rework": OPUS, "roles_contract_version": 99,
           "models": {"orchestrator": "x", "advisor": "y", "staff": "z"}}
    assert llm_roles.models_from_llm_cfg(cfg) == llm_roles.RoleModels(SONNET, OPUS, "")
    assert llm_roles.has_contract(cfg) is False


def _run_dev(monkeypatch, env_body, rework):
    sink: list = []

    class M:
        def create(self, **kw):
            sink.append(kw["model"])
            e = {"request_id": "r", "status": "OK", "artifacts": [], "evidence": [], "next_actions": {},
                 "summary": "implementação concluída com evidência suficiente para o validador"}
            return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text=json.dumps(e))],
                                         usage=types.SimpleNamespace(input_tokens=1, output_tokens=1), stop_reason="end_turn")

    class Cli:
        def __init__(self, *a, **k):
            self.messages = M()

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=Cli, AnthropicBedrock=Cli))
    msg = server._wrap_with_llm_config({**env_body, "request_id": "r"})
    msg["input"] = {**msg["input"], "rework_attempt": rework, "project_id": PID}
    msg["project_id"] = PID
    cfg = dict(msg["llm_config"], provider="bedrock")
    cfg["aws_region"] = "us-east-1"
    msg["llm_config"] = cfg
    out = runtime.run_agent("x.md", msg, role="DEV", system_prompt_override="sys")
    return sink, out


@pytest.mark.parametrize("mode", [None, "off", "shadow", "on"])
@pytest.mark.parametrize("rework", [0, 1])
def test_agents_novo_com_api_antiga_escolhe_como_o_legado(api, monkeypatch, mode, rework):
    """Em QUALQUER modo, payload sem os campos novos ⇒ mesmo modelo do comportamento legado
    (rework>=1 ⇒ model_rework; senão o principal)."""
    if mode:
        monkeypatch.setenv("LLM_ROLES_MODE", mode)
    sink, _ = _run_dev(monkeypatch, LEGACY, rework)
    assert sink == [OPUS if rework >= 1 else SONNET]


@pytest.mark.parametrize("rework", [0, 1])
def test_agents_novo_com_api_nova_sob_on_escolhe_pelo_models(api, monkeypatch, rework):
    monkeypatch.setenv("LLM_ROLES_MODE", "on")
    sink, out = _run_dev(monkeypatch, V1, rework)
    assert sink == [OPUS if rework >= 1 else SONNET]
    assert out["_effective_role"] == ("advisor" if rework >= 1 else "orchestrator")


# ── Fábrica: runner_server novo ──────────────────────────────────────────────

def test_runner_deriva_papeis_do_legado_quando_a_api_e_antiga():
    resp_antiga = {"ok": True, "provider": "bedrock", "modelId": SONNET, "fallbackModelId": OPUS}
    assert llm_roles.models_from_runner_response(resp_antiga) == llm_roles.RoleModels(SONNET, OPUS, "")
    resp_nova = {**resp_antiga, "roles_contract_version": 1,
                 "models": {"orchestrator": SONNET, "advisor": None, "staff": HAIKU}}
    assert llm_roles.models_from_runner_response(resp_nova) == llm_roles.RoleModels(SONNET, "", HAIKU)


def test_transport_env_e_so_transporte_sem_credencial_e_remove_atalhos():
    t = llm_roles.transport_env(llm_roles.RoleModels(SONNET, OPUS, ""))
    assert t["CLAUDE_MODEL_ADVISOR"] == OPUS and t["CLAUDE_MODEL_STAFF"] is None
    assert t["GENESIS_LLM_ROLES_CONTRACT_VERSION"] == "1"
    for atalho in ("CLAUDE_MODEL_SPEC", "CLAUDE_MODEL_CODE", "PIPELINE_LLM_MODEL"):
        assert t[atalho] is None
    assert not [k for k in t if "KEY" in k or "SECRET" in k or "TOKEN" in k]


def test_envelope_do_runner_so_com_versao_transportada(monkeypatch):
    env = {"CLAUDE_MODEL": SONNET, "CLAUDE_MODEL_ADVISOR": OPUS}
    assert llm_roles.envelope_from_env(env) == {}                       # runner_server antigo ⇒ legado
    env["GENESIS_LLM_ROLES_CONTRACT_VERSION"] = "1"
    assert llm_roles.envelope_from_env(env) == {
        "roles_contract_version": 1, "models": {"orchestrator": SONNET, "advisor": OPUS, "staff": None}}


def _post_run(monkeypatch, tmp_path, mode, resp, extra_env=None):
    """Executa o `/run` REAL do runner_server com a api e o subprocess falsos; devolve o env do run."""
    from orchestrator import runner_server as rs
    spec = tmp_path / "spec.md"
    spec.write_text("# spec")
    seen: dict = {}

    class _Resp:
        def __init__(self, data): self.data = data
        def read(self): return json.dumps(self.data).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout=0):
        url = req.full_url if hasattr(req, "full_url") else req
        return _Resp(resp if "project-llm-config" in url else {})

    def fake_popen(cmd, env=None, **kw):
        seen["env"] = dict(env)
        return types.SimpleNamespace(pid=4242)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    monkeypatch.setattr(rs, "_write_pid", lambda *a, **k: None)
    monkeypatch.setattr(rs, "_read_pid", lambda *a, **k: None)
    monkeypatch.setattr(rs, "_running_pids", {})
    if mode:
        monkeypatch.setenv("LLM_ROLES_MODE", mode)
    else:
        monkeypatch.delenv("LLM_ROLES_MODE", raising=False)
    for k, v in (extra_env or {}).items():
        monkeypatch.setenv(k, v)
    rs.run(rs.RunBody(projectId=PID, specPath=str(spec), apiBaseUrl="http://api:3000", token="tok"))
    return seen["env"]


RESP_BASE = {"ok": True, "provider": "bedrock", "modelId": SONNET, "fallbackModelId": OPUS,
             "awsAccessKeyId": "AKIA_FAKE_0", "awsSecretAccessKey": "SECRET_FAKE_0", "awsRegion": "us-east-1"}
RESP_NOVA = {**RESP_BASE, "roles_contract_version": 1, "models": {"orchestrator": SONNET, "advisor": OPUS, "staff": HAIKU}}
TRANSPORTE = ("CLAUDE_MODEL_ADVISOR", "CLAUDE_MODEL_STAFF", "GENESIS_LLM_ROLES_CONTRACT_VERSION")


@pytest.mark.parametrize("mode", [None, "off", "shadow"])
def test_runner_server_off_e_shadow_nao_injetam_transporte_novo(monkeypatch, tmp_path, mode):
    env = _post_run(monkeypatch, tmp_path, mode, RESP_NOVA)
    assert env["CLAUDE_MODEL"] == SONNET and env["CLAUDE_MODEL_REWORK"] == OPUS
    assert not [k for k in TRANSPORTE if k in env]


def test_runner_server_on_injeta_advisor_e_staff_como_transporte(monkeypatch, tmp_path):
    env = _post_run(monkeypatch, tmp_path, "on", RESP_NOVA)
    assert (env["CLAUDE_MODEL"], env["CLAUDE_MODEL_ADVISOR"], env["CLAUDE_MODEL_STAFF"]) == (SONNET, OPUS, HAIKU)
    assert env["CLAUDE_MODEL_REWORK"] == OPUS and env["GENESIS_LLM_ROLES_CONTRACT_VERSION"] == "1"
    # credencial UMA vez, do slot; nenhuma variável de credencial por papel
    assert env["AWS_ACCESS_KEY_ID"] == "AKIA_FAKE_0"
    assert not [k for k in env if k.startswith(("AWS_ACCESS_KEY_ID_", "CLAUDE_API_KEY_", "AWS_SECRET_ACCESS_KEY_"))]


def test_runner_server_on_com_api_antiga_cai_no_legado_derivado(monkeypatch, tmp_path):
    env = _post_run(monkeypatch, tmp_path, "on", RESP_BASE)
    assert (env["CLAUDE_MODEL"], env["CLAUDE_MODEL_ADVISOR"]) == (SONNET, OPUS)   # Advisor := fallback do slot
    assert "CLAUDE_MODEL_STAFF" not in env


def test_runner_server_on_nao_deixa_env_do_container_virar_papel_nem_atalho(monkeypatch, tmp_path):
    env = _post_run(monkeypatch, tmp_path, "on", {**RESP_NOVA, "models": {"orchestrator": SONNET, "advisor": None, "staff": None}},
                    extra_env={"CLAUDE_MODEL_ADVISOR": "vazou-do-container", "CLAUDE_MODEL_STAFF": "vazou-do-container",
                               "CLAUDE_MODEL_SPEC": "atalho", "CLAUDE_MODEL_CODE": "atalho", "PIPELINE_LLM_MODEL": "atalho"})
    for k in ("CLAUDE_MODEL_ADVISOR", "CLAUDE_MODEL_STAFF", "CLAUDE_MODEL_SPEC", "CLAUDE_MODEL_CODE", "PIPELINE_LLM_MODEL"):
        assert k not in env


def test_runner_server_provider_incompativel_por_papel_falha_alto_sob_on(monkeypatch, tmp_path):
    from fastapi import HTTPException
    resp = {**RESP_NOVA, "provider": "openai", "apiKey": "k", "modelId": "gpt-4.1",
            "models": {"orchestrator": "gpt-4.1", "advisor": OPUS, "staff": None}}
    with pytest.raises(HTTPException) as e:
        _post_run(monkeypatch, tmp_path, "on", resp)
    assert e.value.status_code == 422 and "advisor" in str(e.value.detail)
    # off: comportamento atual preservado (provider corrigido em silêncio, run segue)
    env = _post_run(monkeypatch, tmp_path, None, {**resp, "modelId": "claude-sonnet-4-6", "models": None})
    assert env["GENESIS_LLM_PROVIDER"] == "anthropic"


def test_runner_server_sem_slot_segue_422(monkeypatch, tmp_path):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        _post_run(monkeypatch, tmp_path, "on", {"ok": False})
    assert e.value.status_code == 422
