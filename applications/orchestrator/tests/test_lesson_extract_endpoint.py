"""
`/invoke/lesson_extract` — o produtor de lições da BANCADA (G7/A3.3, 2026-09-05).

O endpoint é transporte: recebe o RELATÓRIO do episódio e delega ao LessonExtractor (quem decide o
que é lição é o modelo — ⚖️ LEI). Estes testes provam o contrato do transporte: repasse fiel dos
parâmetros, resposta explícita quando o aprendizado está desligado, o kick do indexer só em `live`
(sem embedding a lição não é recuperável — A3.2) e que uma falha do indexer não derruba a extração.
"""
from __future__ import annotations

import pytest

from orchestrator.agents import server


class _FakeExtractor:
    """Dublê do LessonExtractor: registra a chamada e devolve lições controladas."""
    instances: list["_FakeExtractor"] = []

    mode_to_use = "shadow"
    lessons_to_return: list = []
    persisted_to_report = 0

    def __init__(self, mode=None):
        self.mode = self.mode_to_use
        self.last_persisted = 0
        self.calls: list[dict] = []
        _FakeExtractor.instances.append(self)

    def extract(self, material, project_id=None, stack_key="generic", kind="delivery",
                forbidden_terms=None, llm_cfg=None):
        self.calls.append({
            "material": material, "project_id": project_id, "stack_key": stack_key,
            "kind": kind, "forbidden_terms": forbidden_terms, "llm_cfg": llm_cfg,
        })
        self.last_persisted = self.persisted_to_report
        return list(self.lessons_to_return)


class _L:
    def __init__(self, slug):
        self.slug = slug


@pytest.fixture(autouse=True)
def _fake(monkeypatch):
    import orchestrator.lesson_extractor as le
    _FakeExtractor.instances = []
    _FakeExtractor.mode_to_use = "shadow"
    _FakeExtractor.lessons_to_return = []
    _FakeExtractor.persisted_to_report = 0
    monkeypatch.setattr(le, "LessonExtractor", _FakeExtractor)
    yield


def test_material_vazio_e_erro_de_contrato():
    with pytest.raises(ValueError):
        server._run_lesson_extract({"project_id": "p1"})


def test_modo_off_responde_explicitamente_em_vez_de_silencio():
    _FakeExtractor.mode_to_use = "off"
    out = server._run_lesson_extract({"material": "GAPs da rodada", "project_id": "p1"})
    assert out["mode"] == "off"
    assert out["extracted"] == 0 and out["persisted"] == 0
    assert "RAG_ENABLED=off" in out["reason"]
    # não chegou a chamar extract() (o extrator devolveria [] de qualquer forma, mas o motivo
    # precisa aparecer na resposta para o G7 não voltar a ser invisível)
    assert _FakeExtractor.instances[0].calls == []


def test_repassa_kind_stack_forbidden_e_llm_config():
    _FakeExtractor.lessons_to_return = [_L("spec.api.idempotencia")]
    out = server._run_lesson_extract({
        "material": "GAPs: 6 bloqueadores",
        "project_id": "11111111-1111-1111-1111-111111111111",
        "stack_key": "python-fastapi",
        "forbidden_terms": ["NVX LastMile", "acme"],
        "llm_config": {"aws_region": "us-east-1"},
    })
    call = _FakeExtractor.instances[0].calls[0]
    assert call["kind"] == "spec"  # default do endpoint é o episódio da Bancada
    assert call["project_id"] == "11111111-1111-1111-1111-111111111111"
    assert call["stack_key"] == "python-fastapi"
    assert call["forbidden_terms"] == ["NVX LastMile", "acme"]
    assert call["llm_cfg"] == {"aws_region": "us-east-1"}
    assert out == {"mode": "shadow", "extracted": 1, "persisted": 0,
                   "slugs": ["spec.api.idempotencia"], "kind": "spec"}


def test_kind_delivery_explicito_e_respeitado():
    server._run_lesson_extract({"material": "diálogo do projeto", "kind": "delivery"})
    assert _FakeExtractor.instances[0].calls[0]["kind"] == "delivery"


def test_forbidden_terms_invalido_nao_quebra():
    server._run_lesson_extract({"material": "x", "forbidden_terms": "NVX"})
    assert _FakeExtractor.instances[0].calls[0]["forbidden_terms"] == []


def test_shadow_nao_cutuca_o_indexer(monkeypatch):
    import orchestrator.lessons_indexer as ix
    monkeypatch.setattr(ix, "run_indexer", lambda *a, **k: pytest.fail("shadow não indexa"))
    _FakeExtractor.lessons_to_return = [_L("spec.a")]
    out = server._run_lesson_extract({"material": "GAPs"})
    assert "indexer" not in out


def test_live_cutuca_o_indexer_e_reporta(monkeypatch):
    import orchestrator.lessons_indexer as ix
    monkeypatch.setattr(ix, "run_indexer", lambda *a, **k: {
        "embedded": 2, "pending_consumed": 1, "provider": "bedrock-titan-v2",
    })
    _FakeExtractor.mode_to_use = "live"
    _FakeExtractor.lessons_to_return = [_L("spec.a"), _L("spec.b")]
    _FakeExtractor.persisted_to_report = 2
    out = server._run_lesson_extract({"material": "GAPs", "project_id": "p1"})
    assert out["persisted"] == 2
    assert out["indexer"] == {"embedded": 2, "pending_consumed": 1,
                              "provider": "bedrock-titan-v2", "reason": None}


def test_live_sem_licao_nao_gasta_indexer(monkeypatch):
    import orchestrator.lessons_indexer as ix
    monkeypatch.setattr(ix, "run_indexer", lambda *a, **k: pytest.fail("nada a indexar"))
    _FakeExtractor.mode_to_use = "live"
    out = server._run_lesson_extract({"material": "GAPs"})
    assert out["extracted"] == 0 and "indexer" not in out


def test_falha_do_indexer_nao_perde_a_extracao(monkeypatch):
    import orchestrator.lessons_indexer as ix

    def _boom(*a, **k):
        raise RuntimeError("pgvector fora do ar")

    monkeypatch.setattr(ix, "run_indexer", _boom)
    _FakeExtractor.mode_to_use = "live"
    _FakeExtractor.lessons_to_return = [_L("spec.a")]
    _FakeExtractor.persisted_to_report = 1
    out = server._run_lesson_extract({"material": "GAPs", "project_id": "p1"})
    assert out["persisted"] == 1
    assert "pgvector fora do ar" in out["indexer_error"]


# ── job assíncrono ────────────────────────────────────────────────────────────

def test_job_async_guarda_resultado(monkeypatch):
    _FakeExtractor.lessons_to_return = [_L("spec.a")]
    started = server.invoke_lesson_extract_async({"material": "GAPs", "project_id": "p1"})
    assert started["status"] == "running"
    assert started["jobId"].startswith("le-")
    # a thread é daemon e a extração é dublê: esperar o estado final sem sleep fixo
    for _ in range(200):
        out = server.get_lesson_extract_status(started["jobId"])
        if out["status"] != "running":
            break
        import time as _t
        _t.sleep(0.01)
    assert out["status"] == "done"
    assert out["result"]["slugs"] == ["spec.a"]


def test_job_async_reporta_erro_de_contrato():
    started = server.invoke_lesson_extract_async({"project_id": "p1"})
    for _ in range(200):
        out = server.get_lesson_extract_status(started["jobId"])
        if out["status"] != "running":
            break
        import time as _t
        _t.sleep(0.01)
    assert out["status"] == "error"
    assert "material" in out["error"]


def test_status_de_job_inexistente_e_404():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        server.get_lesson_extract_status("le-naoexiste")
    assert exc.value.status_code == 404
