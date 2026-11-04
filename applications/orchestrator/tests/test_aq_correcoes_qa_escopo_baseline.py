"""
EVOLUIR-PROJETO-AQ — correções dos defeitos D-1, D-2, D-3, D-4 achados nas 3 execuções reais da 4.5.

Cada teste abaixo FALHA sem a correção correspondente (mutação registrada em
project/docs/analysis/EVOLUIR-PROJETO-AQ-correcoes-qa-escopo-baseline.md).
Sem rede, sem LLM, sem Docker.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from orchestrator import runner
from orchestrator.agents import runtime
from orchestrator.envelope import parse_response_envelope


# ───────────────────────── D-2: QA sem JSON ─────────────────────────

def _user_msg() -> str:
    return runtime.build_user_message({"task": "Validar", "mode": "validate_task", "inputs": {"spec_ref": "x"}}, role="QA")


def test_d2_instrucao_padrao_nao_pede_raciocinio_em_tags(monkeypatch):
    """Causa-raiz medida ao vivo: pedir 'seu raciocínio dentro de tags <thinking>' ⇒ stop_reason=refusal,
    content vazio (Sonnet 5.5/Bedrock). Por padrão a instrução não pode pedir isso."""
    monkeypatch.delenv("GENESIS_ASK_THINKING_TAGS", raising=False)
    msg = _user_msg()
    assert "raciocínio dentro de tags" not in msg
    assert "<thinking>" not in msg
    assert "<response>" in msg  # o contrato de saída continua sendo o JSON em <response>


def test_d2_flag_restaura_instrucao_antiga(monkeypatch):
    monkeypatch.setenv("GENESIS_ASK_THINKING_TAGS", "1")
    assert "raciocínio dentro de tags <thinking>" in _user_msg()


def test_d2_parser_aceita_prosa_antes_do_json_mas_valida_schema():
    env = {"status": "QA_PASS", "summary": "Task aprovada com evidência suficiente.", "artifacts": [
        {"path": "docs/qa/QA_REPORT_T1.md", "content": "ok"}], "evidence": [{"type": "qa_verdict", "ref": "QA_PASS"}],
        "next_actions": {}}
    raw = "Vou revisar os arquivos. Análise: tudo certo.\n" + json.dumps(env)
    data, errs = parse_response_envelope(raw, "r1", require_artifacts=True)
    assert errs == []
    assert data["status"] == "QA_PASS"


def test_d2_parser_prosa_com_json_malicioso_continua_validado():
    """Seguro: JSON achado no meio da prosa NÃO escapa da validação de path (traversal)."""
    env = {"status": "OK", "summary": "x" * 40, "artifacts": [{"path": "../../etc/passwd", "content": "x"}],
           "evidence": [{"type": "t", "ref": "r"}], "next_actions": {}}
    data, errs = parse_response_envelope("texto solto " + json.dumps(env), "r1", require_artifacts=True)
    assert any("inválido ou bloqueado" in e for e in errs)


def test_d2_parser_ignora_objeto_sem_status():
    data, errs = parse_response_envelope('conversa {"foo": 1} fim', "r1")
    assert errs  # não é envelope: continua reprovado


class _FakeResp:
    def __init__(self, stop_reason: str, text: str = ""):
        self.stop_reason = stop_reason
        self.content = [SimpleNamespace(type="text", text=text)] if text else []
        self.usage = SimpleNamespace(input_tokens=1000, output_tokens=0, cache_read_input_tokens=0,
                                     cache_creation_input_tokens=0)


def _patch_bedrock(monkeypatch, stop_reason: str, text: str = ""):
    import anthropic
    calls = {"n": 0}

    class _Msgs:
        def create(self, **kw):
            calls["n"] += 1
            return _FakeResp(stop_reason, text)

    class _Client:
        def __init__(self, *a, **k):
            self.messages = _Msgs()

    monkeypatch.setattr(anthropic, "AnthropicBedrock", _Client)
    return calls


def _run_qa(tmp_path):
    sp = tmp_path / "SYSTEM_PROMPT.md"
    sp.write_text("Você é o QA.", encoding="utf-8")
    msg = {"request_id": "t", "mode": "validate_task", "task": "Validar", "inputs": {"spec_ref": "x"},
           "input": {"spec_ref": "x"}, "llm_config": {"provider": "bedrock", "model": "us.anthropic.claude-sonnet-5-5"}}
    return runtime.run_agent(system_prompt_path=sp, message=msg, role="QA")


@pytest.fixture
def _isolated_guard(monkeypatch):
    from orchestrator.agents import llm_guard
    monkeypatch.setattr(llm_guard, "check", lambda **k: None)
    monkeypatch.setattr(llm_guard, "record", lambda *a, **k: None)
    monkeypatch.setenv("LLM_ROLES_MODE", "off")
    runtime._circuit_failures.clear()
    yield
    runtime._circuit_failures.clear()


def test_d2_refusal_vira_bloqueio_marcado_e_nao_gasta_todos_os_reparos(monkeypatch, tmp_path, _isolated_guard):
    calls = _patch_bedrock(monkeypatch, "refusal")
    out = _run_qa(tmp_path)
    assert out["status"] == "BLOCKED"
    assert out["validator_pass"] is False
    assert out.get("_refusal") is True
    assert "LLM_REFUSAL" in out["summary"]
    assert "Resposta sem JSON" not in out["summary"].split(";")[0]  # não se disfarça de JSON malformado
    assert calls["n"] == 2  # 1ª chamada + 1 reparo; recusa repetida não queima os demais


def test_d2_resposta_vazia_sem_refusal_tambem_e_marcada(monkeypatch, tmp_path, _isolated_guard):
    _patch_bedrock(monkeypatch, "end_turn")
    out = _run_qa(tmp_path)
    assert out.get("_empty_response") is True
    assert "LLM_EMPTY_RESPONSE" in out["summary"]


def test_d2_qa_sem_veredito_nao_conta_como_rodou():
    refused = {"status": "BLOCKED", "summary": "LLM_REFUSAL token ok", "validator_pass": False, "_refusal": True}
    assert runner._qa_produced_verdict(refused) is False
    assert runner._is_qa_pass(refused) is False   # antes: "ok" em "token" aprovava
    assert runner._qa_produced_verdict({"status": "QA_FAIL", "summary": "x", "validator_pass": True}) is True
    assert runner._qa_produced_verdict({"status": "QA_PASS", "summary": "x"}) is True
    assert runner._is_qa_pass({"status": "QA_PASS", "summary": "x"}) is True
    # envelope que não passou no validador não é revisão feita
    assert runner._qa_produced_verdict({"status": "QA_FAIL", "validator_pass": False}) is False


# ───────────────────────── D-3: TSK-FULL-TEST ─────────────────────────

def test_d3_full_test_nao_executada_fica_cancelled_nunca_done(monkeypatch, tmp_path):
    updates, steps = [], []
    monkeypatch.setattr(runner, "_update_task", lambda pid, tid, **kw: updates.append((pid, tid, kw)))
    monkeypatch.setattr(runner, "_post_step", lambda msg, rid: steps.append(msg))
    st = runner._declare_full_test_not_run("p1", "r1", "full-test-server indisponível", "claude --print …", tmp_path)
    assert st == "CANCELLED"
    assert updates == [("p1", "TSK-FULL-TEST", {"status": "CANCELLED"})]
    assert all(u[2]["status"] not in ("DONE", "QA_PASS") for u in updates)
    assert any("NOT_RUN" in s for s in steps)
    rep = (tmp_path / "docs" / "qa" / "QA_REPORT_TSK-FULL-TEST.md").read_text(encoding="utf-8")
    assert "NOT_RUN" in rep and "NÃO é aprovação" in rep


def test_d3_runner_usa_o_helper_no_ramo_manual():
    src = Path(runner.__file__).read_text(encoding="utf-8")
    manual = src.split("# Claude Code não disponível — instruir execução manual", 1)[1][:900]
    assert "_declare_full_test_not_run(" in manual
    assert 'status="ASSIGNED"' not in manual


# ───────────────────────── D-4: baseline P2P ─────────────────────────

def _ctx(bl):
    return SimpleNamespace(evolution_baseline=bl)


def test_d4_baseline_com_erro_reprova_alto(monkeypatch):
    monkeypatch.delenv("EVOLUTION_P2P_MODE", raising=False)
    monkeypatch.delenv("EVOLUTION_P2P_REQUIRED", raising=False)
    r = runner._evo_p2p_unmeasured_reason(_ctx({"status": "error", "error": "/run-tests 0: error: [Errno 111] Connection refused"}))
    assert r and "Connection refused" in r


def test_d4_casos_que_nao_reprovam(monkeypatch):
    monkeypatch.delenv("EVOLUTION_P2P_MODE", raising=False)
    monkeypatch.delenv("EVOLUTION_P2P_REQUIRED", raising=False)
    assert runner._evo_p2p_unmeasured_reason(_ctx({"status": "ok", "passed": 10, "failed": 0})) is None
    assert runner._evo_p2p_unmeasured_reason(_ctx({"status": "ok", "no_tests": True})) is None   # nada a comparar
    assert runner._evo_p2p_unmeasured_reason(_ctx(None)) is None                                 # baseline não tentada
    assert runner._evo_p2p_unmeasured_reason(None) is None
    monkeypatch.setenv("EVOLUTION_P2P_REQUIRED", "0")
    assert runner._evo_p2p_unmeasured_reason(_ctx({"status": "error", "error": "x"})) is None    # opt-out explícito
    monkeypatch.delenv("EVOLUTION_P2P_REQUIRED")
    monkeypatch.setenv("EVOLUTION_P2P_MODE", "off")
    assert runner._evo_p2p_unmeasured_reason(_ctx({"status": "error", "error": "x"})) is None


def test_d4_veredito_final_considera_p2p_nao_medido():
    src = Path(runner.__file__).read_text(encoding="utf-8")
    assert "not _p2p_unmeasured" in src.split("_ft_final_status = ", 1)[1][:300]


def test_d4_executor_indisponivel_vira_erro_de_baseline_declarado():
    src = Path(runner.__file__).read_text(encoding="utf-8")
    blk = src.split("_bl = _evo_run_tests(project_id, Path(_files_root_evo)", 1)[1][:900]
    assert "if _bl is None:" in blk and '"status": "error"' in blk


# ───────────────────────── D-1: escopo/testes do Cyborg ─────────────────────────

SPEC_FULL = "describe('X', () => {\n" + "".join(f"  it('caso {i}', () => {{}});\n" for i in range(6)) + "});\n"
SPEC_REDUZIDO = "describe('X', () => {\n  it('caso 0', () => {});\n});\n"


def _apps(tmp_path):
    apps = tmp_path / "apps"
    (apps / "src/health").mkdir(parents=True)
    (apps / "src/publishing").mkdir(parents=True)
    (apps / "src/health/health.controller.ts").write_text("export class HealthController {}\n", encoding="utf-8")
    (apps / "src/publishing/publishing.service.spec.ts").write_text(SPEC_FULL, encoding="utf-8")
    (apps / "src/activities").mkdir()
    (apps / "src/activities/activity-config.validator.ts").write_text("export function validate() {}\n", encoding="utf-8")
    return apps


def test_d1_gate_do_dev_rejeita_spec_reduzida(tmp_path):
    apps = _apps(tmp_path)
    ctx = SimpleNamespace(evolution_scope=["src/health/*.ts"])
    arts = [{"path": "apps/src/publishing/publishing.service.spec.ts", "content": SPEC_REDUZIDO}]
    allowed, viol = runner._evolution_scope_check(ctx, arts, apps)
    assert allowed == []
    assert any("TESTES REDUZIDOS" in v for v in viol)


def test_d1_gate_do_dev_aceita_spec_que_cresce(tmp_path):
    apps = _apps(tmp_path)
    ctx = SimpleNamespace(evolution_scope=["src/health/*.ts"])
    mais = SPEC_FULL.replace("});\n", "  it('novo', () => {});\n});\n")
    allowed, viol = runner._evolution_scope_check(ctx, [{"path": "apps/src/publishing/publishing.service.spec.ts", "content": mais}], apps)
    assert viol == [] and len(allowed) == 1


def test_d1_cyborg_gate_reproduz_o_pr1(tmp_path, monkeypatch):
    """Fixture do TK-0001: escopo `src/health/*.ts`; o Cyborg escreve health (ok), um validator de produção
    fora do escopo e um spec reduzido."""
    from orchestrator import cyborg_v3 as cy
    apps = _apps(tmp_path)
    monkeypatch.setattr("orchestrator.project_storage.get_apps_dir", lambda pid: apps)
    arts = [
        {"path": "src/health/health.controller.ts", "content": "export class HealthController { ok() {} }\n"},
        {"path": "src/activities/activity-config.validator.ts", "content": "export function validate() { return 1 }\n"},
        {"path": "src/publishing/publishing.service.spec.ts", "content": SPEC_REDUZIDO},
    ]
    allowed, viol = cy.cyborg_scope_gate("p1", arts, ["src/health/*.ts"])
    assert [a["path"] for a in allowed] == ["src/health/health.controller.ts"]
    assert any("FORA DO ESCOPO" in v and "activity-config.validator.ts" in v for v in viol)
    assert any("TESTES REDUZIDOS" in v for v in viol)


def test_d1_cyborg_sem_escopo_e_passthrough(tmp_path):
    from orchestrator import cyborg_v3 as cy
    arts = [{"path": "src/x.ts", "content": "x"}]
    assert cy.cyborg_scope_gate("p1", arts, []) == (arts, [])
    assert cy.cyborg_scope_gate("p1", arts, None) == (arts, [])


def test_d1_autonomous_rework_nao_grava_fora_do_escopo(tmp_path, monkeypatch):
    """Integração: o loop real do Cyborg só grava o que o gate libera e devolve `scope_violations`."""
    from orchestrator import cyborg_v3 as cy
    from orchestrator import project_storage as ps
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path))
    monkeypatch.setattr(ps, "_root", lambda: tmp_path)
    apps = _apps_in(tmp_path / "p1")
    resp = {"artifacts": [
        {"path": "src/health/health.controller.ts", "content": "export class HealthController { ok() {} }\n"},
        {"path": "src/activities/activity-config.validator.ts", "content": "export function validate() { return 1 }\n"},
        {"path": "src/publishing/publishing.service.spec.ts", "content": SPEC_REDUZIDO},
    ]}

    def fake_http(method, url, body=None, timeout=60):
        if method == "GET" and url.endswith("/api/projects/p1"):
            return 200, json.dumps({"extra": {"evolution": True, "evolution_scope": ["src/health/*.ts"]}})
        if url.endswith("/invoke/raw"):
            return 200, json.dumps({"response": json.dumps(resp)})
        return 200, "{}"

    fixed = {"a": cy.AnalysisResult(name="a", ok=False, score=0, findings=[cy.Finding("BLOCKER", "x", "problema")])}
    clean = {"a": cy.AnalysisResult(name="a", ok=True, score=10, findings=[])}
    audits = iter([clean, clean, clean])
    monkeypatch.setattr(cy, "_http", fake_http)
    monkeypatch.setattr(cy, "_collect_context", lambda pid, prod: {})
    monkeypatch.setattr(cy, "run_prior_audit", lambda *a, **k: next(audits))
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: 0)
    monkeypatch.setattr(cy, "_resolve_proj_dir", lambda pid, prod: tmp_path / pid)
    monkeypatch.setenv("CYBORG_BUILD_RECOVERY_ROUNDS", "0")
    out = cy.autonomous_rework("p1", None, fixed, "m", max_rounds=1)
    assert (apps / "src/health/health.controller.ts").read_text(encoding="utf-8").count("ok()") == 1
    assert "return 1" not in (apps / "src/activities/activity-config.validator.ts").read_text(encoding="utf-8")
    assert (apps / "src/publishing/publishing.service.spec.ts").read_text(encoding="utf-8") == SPEC_FULL
    assert len(out["scope_violations"]) == 2
    saved = json.loads((tmp_path / "p1" / "docs" / "cyborg" / "scope_violations.json").read_text(encoding="utf-8"))
    assert len(saved["violations"]) == 2


def _apps_in(proj: Path) -> Path:
    apps = proj / "apps"
    (apps / "src/health").mkdir(parents=True)
    (apps / "src/publishing").mkdir(parents=True)
    (apps / "src/activities").mkdir(parents=True)
    (apps / "src/health/health.controller.ts").write_text("export class HealthController {}\n", encoding="utf-8")
    (apps / "src/publishing/publishing.service.spec.ts").write_text(SPEC_FULL, encoding="utf-8")
    (apps / "src/activities/activity-config.validator.ts").write_text("export function validate() {}\n", encoding="utf-8")
    return apps
