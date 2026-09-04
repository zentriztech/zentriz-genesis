"""D3 (needs_spec_input): helpers do runner — extrair perguntas, bloco de respostas, registrar perguntas."""
from __future__ import annotations

import orchestrator.runner as runner


def test_extract_questions_so_em_needs_info_e_tolera_formatos():
    assert runner._extract_questions(None) == []
    assert runner._extract_questions({"status": "OK", "next_actions": {"questions": ["x"]}}) == []
    r = {"status": "NEEDS_INFO", "next_actions": {"questions": [" Qual o SLA? ", {"question": "Multi-tenant?"}, {"text": "Fila?"}, "", 42]}}
    assert runner._extract_questions(r) == ["Qual o SLA?", "Multi-tenant?", "Fila?"]
    assert runner._extract_questions({"status": "needs_info", "next_actions": {"questions": ["a"]}}) == ["a"]
    assert runner._extract_questions({"status": "NEEDS_INFO", "next_actions": {}}) == []


def test_human_answers_block_vazio_e_com_respostas():
    assert runner._human_answers_block(None) == ""
    assert runner._human_answers_block({"extra": {}}) == ""
    block = runner._human_answers_block({"extra": {"spec_answers": [
        {"round": 1, "stage": "spec_review", "questions": ["Qual o SLA?", "Multi-tenant?"], "answer": "SLA 99,9%; sim, multi-tenant por schema."},
    ]}})
    assert "RESPOSTAS DO HUMANO" in block and "Qual o SLA?" in block and "99,9%" in block
    assert "NÃO repergunte" in block


def test_raise_spec_questions_asked_capped_unavailable(monkeypatch):
    posted: list[tuple[str, dict]] = []
    steps: list[str] = []
    monkeypatch.setattr(runner, "_post_step", lambda msg, rid: steps.append(msg))

    monkeypatch.setattr(runner, "_api_post", lambda path, body: (posted.append((path, body)) or ({"questionId": "q1", "round": 1}, 201)))
    assert runner._raise_spec_questions("p1", "spec_review", ["Qual o SLA?"], "rid") == "asked"
    assert posted[0][0] == "/api/projects/p1/questions" and posted[0][1]["questions"] == ["Qual o SLA?"]
    assert any("PERGUNTAS" in s for s in steps) and any("Qual o SLA?" in s for s in steps)

    monkeypatch.setattr(runner, "_api_post", lambda path, body: ({"code": "QUESTION_ROUNDS_EXCEEDED"}, 409))
    assert runner._raise_spec_questions("p1", "charter", ["x"], "rid") == "capped"

    # retry com pergunta já aberta → idempotente ('asked'), o projeto já está em needs_spec_input
    monkeypatch.setattr(runner, "_api_post", lambda path, body: ({"code": "QUESTION_ALREADY_OPEN"}, 409))
    assert runner._raise_spec_questions("p1", "charter", ["x"], "rid") == "asked"

    monkeypatch.setattr(runner, "_api_post", lambda path, body: (None, 404))
    assert runner._raise_spec_questions("p1", "charter", ["x"], "rid") == "unavailable"
    assert runner._raise_spec_questions(None, "charter", ["x"], "rid") == "unavailable"
    assert runner._raise_spec_questions("p1", "charter", [], "rid") == "unavailable"
