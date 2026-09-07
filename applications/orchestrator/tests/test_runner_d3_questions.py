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


# ── GAP-62 / GAP-63 ────────────────────────────────────────────────────────────────────────

def test_extract_questions_nao_trunca_o_teto_fica_no_envio():
    """GAP-63: o teto de 12 saiu daqui (era `out[:12]` silencioso) para quem pode DECLARAR o corte."""
    r = {"status": "NEEDS_INFO", "next_actions": {"questions": [f"P{i}?" for i in range(20)]}}
    assert len(runner._extract_questions(r)) == 20


def test_raise_spec_questions_declara_corte_de_12_e_de_1000_chars(monkeypatch):
    """GAP-63: cortar continua certo; sumir com a pergunta em silêncio, não."""
    steps: list[str] = []
    sent: list[dict] = []
    monkeypatch.setattr(runner, "_post_step", lambda msg, rid: steps.append(msg))
    monkeypatch.setattr(runner, "_api_post", lambda path, body: (sent.append(body) or ({"questionId": "q1", "round": 1}, 201)))

    qs = [f"Pergunta {i}?" for i in range(15)]
    qs[0] = "L" * 1500 + "?"
    assert runner._raise_spec_questions("p1", "spec_review", qs, "rid") == "asked"
    # só as 12 primeiras vão para a API…
    assert len(sent[0]["questions"]) == runner.QUESTIONS_PER_ROUND_CAP
    # …e as 3 que sobraram são DECLARADAS, junto do enunciado cortado
    assert any("15 perguntas" in s and "3 ficaram para a próxima" in s for s in steps), steps
    assert any("1.000 caracteres" in s for s in steps), steps


def test_raise_spec_questions_faz_retry_so_no_transitorio(monkeypatch):
    """GAP-62: api reiniciando devolve (None, 0) — insistir resolve. 404 é definitivo: não insiste."""
    monkeypatch.setattr(runner, "_post_step", lambda msg, rid: None)
    monkeypatch.setattr(runner.time, "sleep", lambda _s: None)

    tentativas = {"n": 0}

    def flaky(path, body):
        tentativas["n"] += 1
        return (None, 0) if tentativas["n"] == 1 else ({"questionId": "q1", "round": 1}, 201)

    monkeypatch.setattr(runner, "_api_post", flaky)
    assert runner._raise_spec_questions("p1", "spec_review", ["Qual o SLA?"], "rid") == "asked"
    assert tentativas["n"] == 2, "deveria ter repetido a falha de rede exatamente uma vez"

    # 5xx também é transitório → 3 tentativas e desiste
    quinhentos = {"n": 0}

    def sempre_500(path, body):
        quinhentos["n"] += 1
        return (None, 503)

    monkeypatch.setattr(runner, "_api_post", sempre_500)
    assert runner._raise_spec_questions("p1", "spec_review", ["x"], "rid") == "unavailable"
    assert quinhentos["n"] == 3

    # 404 (rota ausente) é definitivo: UMA tentativa
    quatro04 = {"n": 0}

    def sempre_404(path, body):
        quatro04["n"] += 1
        return (None, 404)

    monkeypatch.setattr(runner, "_api_post", sempre_404)
    assert runner._raise_spec_questions("p1", "spec_review", ["x"], "rid") == "unavailable"
    assert quatro04["n"] == 1


def test_block_for_unregistered_questions_para_a_fabrica(monkeypatch):
    """GAP-62 (o defeito): sem canal para a pergunta, a fábrica PARA — não deixa outro LLM responder."""
    steps: list[str] = []
    patches: list[dict] = []
    monkeypatch.setattr(runner, "_post_step", lambda msg, rid: steps.append(msg))
    monkeypatch.setattr(runner, "_patch_project", lambda body: patches.append(body) or True)

    ok = runner._block_for_unregistered_questions("p1", "charter", ["Qual o SLA?", "Multi-tenant?"], "rid")
    assert ok is True
    assert patches and patches[0]["status"] == "blocked_structural_gate"
    assert "não inventar requisito" in patches[0]["blocked_reason"]
    assert "Qual o SLA?" in patches[0]["blocked_reason"]
    # o humano vê as perguntas MESMO sem o canal de notificação da API ter funcionado
    assert any("BLOCKED" in s for s in steps) and any("Qual o SLA?" in s for s in steps)

    # sem projeto na Bancada não existe canal D3 por desenho → não bloqueia nada
    assert runner._block_for_unregistered_questions(None, "charter", ["x"], "rid") is False
    assert runner._block_for_unregistered_questions("p1", "charter", [], "rid") is False
