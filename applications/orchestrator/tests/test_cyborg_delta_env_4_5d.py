"""Rodada real 4.5d (BG) — Cyborg.

D-13: auditoria ESCOPADA AO DELTA para filhos de CARD (BLOCKER de dívida antiga fora do delta vira PRE_EXISTING;
      BLOCKER no delta / build quebrado continua fail-closed; legado = comportamento anterior).
D-14: falha de AMBIENTE de build (ERESOLVE/not found) ⇒ não paga rodada de LLM; needs_human com a causa.
D-16: o diálogo cita o provedor REAL do slot (não "Foundry" fixo).
Nenhuma chamada real a LLM/executor."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from orchestrator import cyborg_v3 as cy
from orchestrator import project_storage as ps

NAMES = list(cy.ANALYSIS_NAMES)
OLD_DEBT = [
    ("a1_coerencia_estrutural", "src/legacy/old-service.ts"),
    ("a2_fidelidade_spec", "src/legacy/billing.ts"),
    ("a5_dominio", "src/legacy/domain.ts"),
]


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    cy._AUDIT_CACHE.clear()
    for k in ("CYBORG_AUDIT_SCOPE", "CYBORG_ROUND_GATE", "CYBORG_ESCALATION_ENABLED"):
        monkeypatch.delenv(k, raising=False)
    yield
    cy._AUDIT_CACHE.clear()


def _tree(root: Path, files: dict[str, str]):
    for rel, txt in files.items():
        p = root / "apps" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(txt)


def _setup(monkeypatch, tmp_path, *, card=True, child_changes=None, llm=None, build_rc=0, score=8):
    """pai (apps/) + filho (apps/ com 1 linha alterada) + API fake + LLM fake. Devolve (calls, prompts)."""
    base = {"package.json": "{}", "src/a.ts": "export const a = 1\n",
            "src/legacy/old-service.ts": "x\n", "src/legacy/billing.ts": "y\n", "src/legacy/domain.ts": "z\n"}
    parent, child = tmp_path / "parent", tmp_path / "child"
    _tree(parent, base)
    _tree(child, {**base, **(child_changes or {"src/a.ts": "export const a = 2\n"})})
    extra = {"evolution": True, "evolution_parent_id": "parent", "evolution_scope": ["apps/src/a.ts"]}
    if card:
        extra["evolution_origin"] = "card"

    def fake_http(method, url, body=None, timeout=60):
        if url.endswith("/api/projects/child"):
            return 200, json.dumps({"extra": extra})
        if url.endswith("/api/projects/parent"):
            return 200, json.dumps({"productId": None})
        return 200, "{}"
    prompts: list = []

    def fake_call(prompt, ctx, model_id):
        prompts.append((prompt, ctx))
        name = next(n for n in NAMES if f"prompt {n}" in prompt)
        findings = [{"severity": "BLOCKER", "area": "debt", "description": f"dívida antiga em {f}",
                     "evidence": f"{f}:10"} for n, f in OLD_DEBT if n == name]
        if llm:
            findings = llm(name, findings)
        return json.dumps({"ok": True, "score": score, "findings": findings})
    monkeypatch.setattr(cy, "_http", fake_http)
    monkeypatch.setattr(cy, "_collect_context", lambda pid, prod: {"spec": "S", "build_rc": build_rc})
    monkeypatch.setattr(cy, "_load_prompt", lambda name: f"prompt {name}")
    monkeypatch.setattr(cy, "_post_dialogue", lambda *a, **k: None)
    monkeypatch.setattr(cy, "_resolve_proj_dir", lambda pid, prod: tmp_path / pid)
    monkeypatch.setattr(cy, "_call_bedrock", fake_call)
    return prompts


def _blk(audit):
    return sum(1 for ar in audit.values() for f in ar.findings if f.severity == "BLOCKER")


# ───────────── D-13 ─────────────
def test_bugfix_de_1_linha_com_divida_antiga_e_aceito(monkeypatch, tmp_path):
    prompts = _setup(monkeypatch, tmp_path)
    audit = cy.run_prior_audit("child", None, "m")
    assert _blk(audit) == 0
    pre = [f for ar in audit.values() for f in ar.findings if f.severity == cy.PRE_EXISTING]
    assert len(pre) == 3 and all("PRÉ-EXISTENTE" in f.description for f in pre)
    ev = cy.evaluate_audit_acceptance(audit, 0)
    assert ev["ideal"] is True and ev["blk"] == 0
    # prompt instrui o escopo do delta e proíbe escalar; contexto leva o delta
    p, ctx = prompts[0]
    assert "DELTA DO CARD" in p and "PROIBIDO exigir" in p and "conclusão de feature" in p
    assert ctx["audit_scope"]["delta_files"] == ["src/a.ts"]
    aj = json.loads((tmp_path / "child/docs/cyborg/audit.json").read_text())
    assert aj["scope"]["mode"] == "delta" and len(aj["pre_existing"]) == 3     # registrado, não descartado


def test_blocker_no_delta_continua_bloqueando_needs_human(monkeypatch, tmp_path):
    def llm(name, f):
        if name == "a2_fidelidade_spec":
            f.append({"severity": "BLOCKER", "area": "bug", "description": "o fix não trata null",
                      "evidence": "apps/src/a.ts:1"})
        return f
    _setup(monkeypatch, tmp_path, llm=llm)
    audit = cy.run_prior_audit("child", None, "m")
    assert _blk(audit) == 1                                          # só o do delta; 3 antigos viraram pré-existentes
    assert cy.evaluate_audit_acceptance(audit, 0)["ideal"] is False


def test_teste_do_arquivo_alterado_conta_como_delta(monkeypatch, tmp_path):
    def llm(name, f):
        return f + ([{"severity": "BLOCKER", "area": "t", "description": "teste falha",
                      "evidence": "src/a.spec.ts:3"}] if name == "a1_coerencia_estrutural" else [])
    _setup(monkeypatch, tmp_path, llm=llm)
    assert _blk(cy.run_prior_audit("child", None, "m")) == 1


def test_blocker_sem_localizacao_e_build_quebrado_nao_sao_reclassificados(monkeypatch, tmp_path):
    def llm(name, f):
        return f + ([{"severity": "BLOCKER", "area": "x", "description": "arquitetura inconsistente",
                      "evidence": ""}] if name == "a1_coerencia_estrutural" else [])
    _setup(monkeypatch, tmp_path, llm=llm, build_rc=1)
    audit = cy.run_prior_audit("child", None, "m")
    assert _blk(audit) == 1                                          # sem arquivo citado ⇒ fail-closed
    # build quebrado: a3 nunca é rebaixado
    sc = {"delta_files": ["src/a.ts"], "files_allowed": []}
    a3 = cy.AnalysisResult(name="a3_build_runtime", ok=False, score=3,
                           findings=[cy.Finding("BLOCKER", "build", "build falha", "src/legacy/old-service.ts:1")])
    assert cy.apply_delta_scope({"a3_build_runtime": a3}, sc, 1) == [] and a3.findings[0].severity == "BLOCKER"
    assert len(cy.apply_delta_scope({"a3_build_runtime": a3}, sc, 0)) == 1


def test_files_allowed_do_rfc_entram_no_delta(monkeypatch, tmp_path):
    def llm(name, f):
        return f + ([{"severity": "BLOCKER", "area": "x", "description": "d", "evidence": "apps/src/legacy/billing.ts:2"}]
                    if name == "a1_coerencia_estrutural" else [])
    _setup(monkeypatch, tmp_path, llm=llm)
    monkeypatch.setattr(cy, "_http", lambda m, u, b=None, timeout=60: (200, json.dumps(
        {"extra": {"evolution_origin": "card", "evolution_parent_id": "parent",
                   "evolution_scope": ["apps/src/legacy/billing.ts"]}}))
        if u.endswith("/child") else (200, "{}"))
    audit = cy.run_prior_audit("child", None, "m")
    assert any(f.severity == "BLOCKER" and "billing.ts" in f.evidence for ar in audit.values() for f in ar.findings)


def test_legado_e_projeto_comum_mantem_auditoria_completa_byte_identica(monkeypatch, tmp_path):
    prompts = _setup(monkeypatch, tmp_path, card=False)
    audit = cy.run_prior_audit("child", None, "m")
    assert _blk(audit) == 3                                          # nada reclassificado
    assert all(p == f"prompt {n}" for (p, _c), n in zip(sorted(prompts, key=lambda x: x[0]), sorted(NAMES))) \
        or all("DELTA" not in p for p, _ in prompts)
    assert all("audit_scope" not in c for _, c in prompts)
    aj = json.loads((tmp_path / "child/docs/cyborg/audit.json").read_text())
    assert "scope" not in aj and "pre_existing" not in aj


def test_override_full_forca_auditoria_completa_em_card_e_delta_forca_em_legado(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setenv("CYBORG_AUDIT_SCOPE", "full")
    assert _blk(cy.run_prior_audit("child", None, "m")) == 3
    cy._AUDIT_CACHE.clear()
    _setup(monkeypatch, tmp_path, card=False)
    monkeypatch.setenv("CYBORG_AUDIT_SCOPE", "delta")
    assert _blk(cy.run_prior_audit("child", None, "m")) == 0


def test_sem_pai_localizavel_cai_na_auditoria_completa(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(cy, "_http", lambda m, u, b=None, timeout=60: (200, json.dumps(
        {"extra": {"evolution_origin": "card"}})) if u.endswith("/child") else (0, "error"))
    assert _blk(cy.run_prior_audit("child", None, "m")) == 3          # mais rígido, nunca mais frouxo


def test_card_nao_escala_para_conclusao_de_feature_e_termina_needs_human(monkeypatch, tmp_path):
    def llm(name, f):
        return f + ([{"severity": "BLOCKER", "area": "bug", "description": "fix incompleto",
                      "evidence": "src/a.ts:1"}] if name == "a2_fidelidade_spec" else [])
    _setup(monkeypatch, tmp_path, llm=llm, score=6)
    monkeypatch.setattr(cy, "_resolve_slot_llm", lambda pid: {"model_id": "m", "llm_config": {"provider": "bedrock"}})
    monkeypatch.setattr(cy, "spawn_engineer", lambda *a, **k: {"ok": False, "error": "sem bridge"})
    modes: list = []

    def fake_rework(pid, prod, audit, model, max_rounds=2, mode="surgical"):
        modes.append(mode)
        return {"ok": False, "rounds": 1, "final_audit": audit, "delivered": False}
    monkeypatch.setattr(cy, "autonomous_rework", fake_rework)
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: 0)
    run = cy._run_cyborg_v3_impl("child", None, None)
    assert run.final_status == "needs_human" and modes == ["surgical"]    # sem rodada "feature"


def test_legado_ainda_escala_para_feature(monkeypatch, tmp_path):
    def llm(name, f):
        return f
    _setup(monkeypatch, tmp_path, card=False, llm=llm, score=6)
    monkeypatch.setattr(cy, "_resolve_slot_llm", lambda pid: {"model_id": "m"})
    monkeypatch.setattr(cy, "spawn_engineer", lambda *a, **k: {"ok": False, "error": "sem bridge"})
    modes: list = []
    monkeypatch.setattr(cy, "autonomous_rework", lambda pid, prod, audit, model, max_rounds=2, mode="surgical":
                        (modes.append(mode), {"ok": False, "rounds": 1, "final_audit": audit})[1])
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: 0)
    cy._run_cyborg_v3_impl("child", None, None)
    assert modes == ["surgical", "feature"]


# ───────────── D-14 ─────────────
def test_build_env_failure_distingue_ambiente_de_codigo():
    assert "ERESOLVE" in cy.build_env_failure(1, "npm error code ERESOLVE\nnpm error peer dep")
    assert cy.build_env_failure(127, "sh: 1: nest: not found")
    assert cy.build_env_failure(0, "ERESOLVE") is None and cy.build_env_failure(-1, "ERESOLVE") is None
    assert cy.build_env_failure(2, "src/a.ts(1,1): error TS2554: Expected 2 arguments") is None


def _res(b=0, t=0, bo="", to=""):
    return {"build_rc": b, "build_output": bo, "type_check_rc": t, "type_check_output": to}


def _rework_env(monkeypatch, tmp_path, dev_prompts, check, audit_build=None):
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path))
    monkeypatch.setattr(ps, "_root", lambda: tmp_path)
    monkeypatch.setenv("CYBORG_BUILD_RECOVERY_ROUNDS", "0")
    if audit_build is not None:
        d = tmp_path / "p1/docs/cyborg"; d.mkdir(parents=True)
        (d / "audit.json").write_text(json.dumps({"build": audit_build}))
    (tmp_path / "p1/apps/src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "p1/apps/package.json").write_text("{}")
    (tmp_path / "p1/apps/src/x.ts").write_text("export const x = 1\n")

    def fake_http(method, url, body=None, timeout=60):
        if method == "GET" and url.endswith("/api/projects/p1"):
            return 200, json.dumps({"extra": {}})
        if url.endswith("/invoke/raw"):
            dev_prompts.append(body["user_message"])
            return 200, json.dumps({"response": json.dumps({"artifacts": [
                {"path": "src/x.ts", "content": "export const x = 2\n"}]})})
        return 200, "{}"
    reaudit: list = []
    monkeypatch.setattr(cy, "_http", fake_http)
    monkeypatch.setattr(cy, "_collect_context", lambda pid, prod: {})
    monkeypatch.setattr(cy, "run_prior_audit", lambda *a, **k: (reaudit.append(1),
                        {"a": cy.AnalysisResult(name="a", ok=True, score=10, raw="{}")})[1])
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: 0)
    monkeypatch.setattr(cy, "_resolve_proj_dir", lambda pid, prod: tmp_path / pid)
    monkeypatch.setattr(cy, "run_build_check", check)
    return reaudit


def _audit_blk():
    return {"a": cy.AnalysisResult(name="a", ok=False, score=0, raw="{}",
                                   findings=[cy.Finding("BLOCKER", "x", "corrigir x")])}


def test_eresolve_no_estado_atual_nao_paga_llm_e_devolve_a_causa(monkeypatch, tmp_path):
    dev: list = []
    reaudit = _rework_env(monkeypatch, tmp_path, dev, lambda pid, prod: _res(0, 0),
                          audit_build={"rc": 1, "output_tail": "npm error code ERESOLVE\nnpm error peer @nestjs/common"})
    out = cy.autonomous_rework("p1", None, _audit_blk(), "m", max_rounds=3)
    assert out["env_blocked"] and "ERESOLVE" in out["env_blocked"] and out["delivered"] is False
    assert dev == [] and reaudit == [] and out["rounds"] == 0           # ZERO chamadas de LLM


def test_baseline_do_gate_nao_instalavel_tambem_bloqueia_antes_do_llm(monkeypatch, tmp_path):
    dev: list = []
    _rework_env(monkeypatch, tmp_path, dev, lambda pid, prod: _res(
        1, -1, bo="BUILD NÃO EXECUTOU: install falhou (rc=1): npm error code ERESOLVE"))
    out = cy.autonomous_rework("p1", None, _audit_blk(), "m", max_rounds=3)
    assert out.get("env_blocked") and dev == []


def test_falha_de_codigo_continua_pagando_rodada(monkeypatch, tmp_path):
    dev: list = []
    _rework_env(monkeypatch, tmp_path, dev, lambda pid, prod: _res(0, 0),
                audit_build={"rc": 2, "output_tail": "src/x.ts(1,1): error TS2554: Expected 2 arguments"})
    out = cy.autonomous_rework("p1", None, _audit_blk(), "m", max_rounds=1)
    assert "env_blocked" not in out and len(dev) == 1


def test_rodada_revertida_por_ambiente_re_checa_o_build_antes_de_pagar_a_proxima(monkeypatch, tmp_path):
    dev: list = []
    seq = iter([_res(0, 0),                                              # baseline ok
                _res(1, -1, bo="BUILD NÃO EXECUTOU: install falhou: npm error code ERESOLVE"),   # gate da rodada 1
                _res(1, -1, bo="BUILD NÃO EXECUTOU: install falhou: npm error code ERESOLVE")])  # re-check
    _rework_env(monkeypatch, tmp_path, dev, lambda pid, prod: next(seq))
    out = cy.autonomous_rework("p1", None, _audit_blk(), "m", max_rounds=4)
    assert len(dev) == 1 and out["env_blocked"] and "ERESOLVE" in out["env_blocked"]


def test_run_cyborg_termina_needs_human_com_causa_de_ambiente(monkeypatch):
    monkeypatch.setattr(cy, "_resolve_slot_llm", lambda pid: {"model_id": "m"})
    monkeypatch.setattr(cy, "_post_dialogue", lambda *a, **k: None)
    monkeypatch.setattr(cy, "run_prior_audit", lambda *a, **k: _audit_blk())
    monkeypatch.setattr(cy, "spawn_engineer", lambda *a, **k: {"ok": False, "error": "x"})
    monkeypatch.setattr(cy, "_cur_build_rc", lambda *a, **k: 1)
    monkeypatch.setattr(cy, "autonomous_rework", lambda *a, **k: {"ok": False, "final_audit": _audit_blk(),
                                                                   "env_blocked": "npm error code ERESOLVE"})
    run = cy._run_cyborg_v3_impl("p1", None, None)
    assert run.final_status == "needs_human" and "ERESOLVE" in run.reason and "Nenhuma rodada de LLM" in run.reason


# ───────────── D-16 ─────────────
@pytest.mark.parametrize("prov,label", [("bedrock", "Bedrock"), ("anthropic", "Anthropic"), ("foundry", "Foundry"),
                                        ("vertex", "Vertex AI")])
def test_dialogo_cita_o_provedor_real_do_slot(prov, label):
    tok = cy._SLOT_LLM.set({"llm_config": {"provider": prov}})
    try:
        assert cy._slot_provider_label() == label
    finally:
        cy._SLOT_LLM.reset(tok)


def test_sem_slot_nao_inventa_provedor_e_mensagem_do_rework_usa_o_provedor(monkeypatch, tmp_path):
    assert cy._slot_provider_label() == "LLM do slot"
    msgs: list = []
    dev: list = []
    _rework_env(monkeypatch, tmp_path, dev, lambda pid, prod: _res(0, 0))
    monkeypatch.setattr(cy, "_post_dialogue", lambda pid, m: msgs.append(m))
    tok = cy._SLOT_LLM.set({"llm_config": {"provider": "bedrock"}})
    try:
        cy.autonomous_rework("p1", None, _audit_blk(), "m", max_rounds=1)
    finally:
        cy._SLOT_LLM.reset(tok)
    joined = "\n".join(msgs)
    assert "via Bedrock" in joined and "Foundry" not in joined
