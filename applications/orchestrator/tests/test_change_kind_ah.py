"""Correções AH da revisão AF da Fase 4 (runner/orchestrator): A2 (ticket legado não muda o prompt), A3 (card_id em toda task
não herdada; consolidação trivial não descarta tasks do card) e M3 (QA recebe o tipo do card).

Sem rede, sem LLM, sem API real.
"""
from __future__ import annotations

import pytest

import orchestrator.runner as runner
from orchestrator.agents.runtime import build_user_message
from orchestrator.change_kind import derive_change_context, is_card_child
from orchestrator.pipeline_context import PipelineContext

CARD_UUID = "3f2b8c1e-0a4d-4e57-9b6a-1c2d3e4f5a6b"
ORIGIN_FILE = "tickets/TK-0007/request.md"

# `extra` que /evolve legado e o claim gravam para um ticket SEM card (evolveClaim.ts:514) …
LEGACY_EXTRA = {"evolution": True, "ticket_id": CARD_UUID, "ticket_number": 7, "ticket_kind": "fix"}
# … e o do claim de promoção de card (evolveClaim.ts:514-515).
CARD_EXTRA = {**LEGACY_EXTRA, "card_draft_project_id": "draft", "evolution_origin": "card"}


def _ctx_from_extra(extra: dict) -> PipelineContext:
    c = PipelineContext("filho"); c.set_charter("Charter"); c.current_module = "backend"
    runner._apply_change_context(c, extra)
    return c


def _prompts(ctx: PipelineContext) -> dict[str, str]:
    return {
        "CTO": build_user_message({"task": "t", "inputs": ctx.build_inputs_for_cto("charter_and_proposal")}, role="CTO"),
        "PM": build_user_message({"task": "t", "inputs": ctx.build_inputs_for_pm()}, role="PM"),
        "DEV": build_user_message({"task": "t", "inputs": ctx.evolution_scope_inputs("T1")}, role="DEV"),
        "QA": build_user_message({"task": "t", "inputs": _qa_inputs(ctx)}, role="QA"),
    }


def _qa_inputs(ctx: PipelineContext) -> dict:
    captured: dict = {}

    def fake_run(role, message, *a, **k):
        captured.update(message["inputs"]); return {"status": "OK"}
    mp = pytest.MonkeyPatch()
    try:
        mp.setattr("orchestrator.agents.client_http.run_agent_http", fake_run)
        mp.setenv("API_AGENTS_URL", "http://x")
        runner.call_qa("filho", "c", "b", "d", "rid", task_id="T1", pipeline_ctx=ctx)
    finally:
        mp.undo()
    return captured


# ───────────── A2 ─────────────

def test_a2_ticket_legado_prompt_identico_ao_pre_fase4():
    virgem = PipelineContext("filho"); virgem.set_charter("Charter"); virgem.current_module = "backend"
    legado = _ctx_from_extra(LEGACY_EXTRA)
    assert (legado.ticket_kind, legado.spec_origin, legado.card_id, legado.origin_spec_file) == (None, None, None, None)
    p_leg, p_virgem = _prompts(legado), _prompts(virgem)
    assert p_leg == p_virgem
    for role, p in p_leg.items():
        assert "FAIL_TO_PASS" not in p and "ORIGEM DA SPEC" not in p and "Non-goals" not in p, role


def test_a2_card_recebe_as_regras_novas():
    assert is_card_child(CARD_EXTRA) and not is_card_child(LEGACY_EXTRA) and not is_card_child(None)
    assert derive_change_context(LEGACY_EXTRA)["card_id"] is None      # legado também não liga tasks ao card
    for role, p in _prompts(_ctx_from_extra(CARD_EXTRA)).items():
        assert "FAIL_TO_PASS" in p and "TSK-INH-" in p, role


# ───────────── A3 ─────────────

@pytest.mark.parametrize("tid,linked", [
    ("TSK-EVO-001", True), ("TSK-FULL-TEST", True), ("TSK-DEVOPS-001", True), ("TSK-TRIVIAL-001", True),
    ("TSK-BE-003", True), ("TSK-WEB-HOME-FIX", True), ("TSK-INH-V1-BE-001", False),
])
def test_a3_card_id_por_prefixo(tid, linked):
    out = runner._link_tasks_to_card([{"task_id": tid}], CARD_UUID, ORIGIN_FILE)[0]
    assert (out.get("card_id") == CARD_UUID) is linked
    assert (out.get("origin_spec_file") == ORIGIN_FILE) is linked


def test_a3_task_camelcase_tambem_e_ligada_e_sem_card_nada_muda():
    assert runner._link_tasks_to_card([{"taskId": "TSK-DEVOPS-001"}], CARD_UUID, None)[0]["card_id"] == CARD_UUID
    t = [{"task_id": "TSK-TRIVIAL-001"}]
    assert runner._link_tasks_to_card(t, None, None) is t


def test_a3_args_do_pipeline_ctx_so_para_filho_de_card():
    assert runner._card_link_args(_ctx_from_extra(CARD_EXTRA)) == (CARD_UUID, ORIGIN_FILE)
    assert runner._card_link_args(_ctx_from_extra(LEGACY_EXTRA)) == (None, None)
    assert runner._card_link_args(None) == (None, None)


def test_a3_consolidacao_trivial_nao_descarta_tasks_de_card():
    many = [{"task_id": f"TSK-EVO-00{i}"} for i in range(5)]
    assert runner._may_consolidate_trivial(many, None) is True          # comportamento antigo, projeto comum
    assert runner._may_consolidate_trivial(many, CARD_UUID) is False    # card: nada é cancelado
    assert runner._may_consolidate_trivial(many[:3], None) is False


def test_a3_todos_os_pontos_de_post_passam_pelo_vinculo():
    """Guarda estática (fraca por natureza): nenhum POST de TSK-DEVOPS/FULL-TEST/TRIVIAL volta a sair sem o helper."""
    import re
    from pathlib import Path
    src = Path(runner.__file__).read_text(encoding="utf-8")
    for needle in ('{"tasks": _devops_task}', '{"tasks": [_trivial_task]}', '{"tasks": [_consolidated_task]}'):
        assert needle not in src, needle
    assert len(re.findall(r"_link_tasks_to_card\(", src)) >= 6


# ───────────── M3 ─────────────

def test_m3_qa_recebe_tipo_do_card_e_fail_to_pass_na_correcao():
    p = _prompts(_ctx_from_extra(CARD_EXTRA))["QA"]
    assert "TIPO DO CARD = CORREÇÃO" in p and "FAIL_TO_PASS" in p
    feature = _prompts(_ctx_from_extra({**CARD_EXTRA, "ticket_kind": "feature"}))["QA"]
    assert "Non-goals" in feature and "FAIL_TO_PASS" not in feature


def test_m3_qa_de_projeto_comum_nao_muda():
    comum = _qa_inputs(_ctx_from_extra({"evolution": True}))
    assert "change_kind_instruction" not in comum and "ticket_kind" not in comum
