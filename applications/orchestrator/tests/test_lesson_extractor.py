"""
Testes do LessonExtractor (RAG corpus).

⚖️ Reescritos em 2026-09-05 (G7/A3.4): o extrator passou a ser **100% LLM**. As lições por regex
(`_HEURISTIC_PATTERNS`/`_heuristic_extract`) foram REMOVIDAS, então os testes deixaram de afirmar
slugs inventados por regex e passaram a exercitar o caminho real: modelo mockado, prompt escolhido
por `kind`, veto de contaminação e — o mais importante — **a garantia de que sem LLM não sai lição**.
"""
from __future__ import annotations

import importlib
import os

import pytest


def _reload(**env):
    for k, v in env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    import orchestrator.lesson_extractor as le
    importlib.reload(le)
    return le


def _fake_llm(payload: str, calls: list[dict] | None = None):
    """Substituto de `call_bedrock_direct` que devolve `payload` e registra a chamada."""
    def _call(system, user, model=None, **kwargs):
        if calls is not None:
            calls.append({"system": system, "user": user, "model": model, "kwargs": kwargs})
        return payload
    return _call


def _patch_llm(monkeypatch, payload_or_exc, calls: list[dict] | None = None):
    from orchestrator.agents import runtime
    if isinstance(payload_or_exc, BaseException):
        def _boom(system, user, model=None, **kwargs):
            if calls is not None:
                calls.append({"system": system, "user": user, "model": model, "kwargs": kwargs})
            raise payload_or_exc
        monkeypatch.setattr(runtime, "call_bedrock_direct", _boom)
    else:
        monkeypatch.setattr(runtime, "call_bedrock_direct", _fake_llm(payload_or_exc, calls))


_ONE_LESSON = """[
  {"slug": "spec.api.idempotencia",
   "title": "Rotas de escrita declaram idempotência",
   "body_md": "**Regra:** toda rota de escrita da spec declara chave de idempotência.",
   "category": "contract", "scope": "product", "confidence": 0.8, "tags": ["spec", "api"]}
]"""


# ── modos ─────────────────────────────────────────────────────────────────────

def test_off_mode_returns_empty(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "off")
    le = _reload()
    extractor = le.LessonExtractor()
    out = extractor.extract("findAll is not a function", project_id="p1")
    assert out == []


def test_invalid_mode_falls_back_to_off(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "yolo")
    le = _reload()
    extractor = le.LessonExtractor()
    assert extractor.mode == "off"
    assert extractor.extract("anything") == []


def test_shadow_extracts_but_does_not_persist(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    monkeypatch.setenv("DATABASE_URL", "")
    le = _reload()
    _patch_llm(monkeypatch, _ONE_LESSON)
    # persistir em shadow seria o defeito que este teste protege
    monkeypatch.setattr(le, "_persist_lessons", lambda *a, **k: pytest.fail("shadow não persiste"))
    out = le.LessonExtractor().extract(
        "GAPs: rotas de escrita sem idempotência",
        project_id="00000000-0000-0000-0000-000000000001",
    )
    assert len(out) == 1
    assert out[0].slug == "spec.api.idempotencia"
    assert out[0].pii_redacted is True
    assert out[0].category == "contract"


def test_live_without_db_returns_extracted_but_logs(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "live")
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("PGHOST", "")
    le = _reload()
    _patch_llm(monkeypatch, _ONE_LESSON)
    out = le.LessonExtractor().extract("GAPs do laço da Bancada")
    # Sem DB, ainda retorna extracted (persist falha graciosamente)
    assert len(out) == 1
    assert out[0].slug == "spec.api.idempotencia"


# ── ⚖️ LEI: 100% LLM, sem fallback burro ──────────────────────────────────────

def test_heuristica_foi_removida_do_modulo(monkeypatch):
    """A lei proíbe lição inventada por regex — os símbolos não podem voltar por descuido."""
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    assert not hasattr(le, "_HEURISTIC_PATTERNS")
    assert not hasattr(le, "_heuristic_extract")


def test_falha_do_modelo_nao_gera_licao(monkeypatch):
    """Modelo indisponível → ZERO lição (antes caía na heurística e contaminava o corpus)."""
    monkeypatch.setenv("RAG_ENABLED", "live")
    le = _reload()
    calls: list[dict] = []
    _patch_llm(monkeypatch, RuntimeError("AccessDeniedException"), calls)
    persisted: list[list] = []
    monkeypatch.setattr(le, "_persist_lessons", lambda lessons: persisted.append(list(lessons)) or 0)
    out = le.LessonExtractor().extract(
        "Erro: findAll is not a function / python-multipart is not installed / prefix duplicated",
        project_id="00000000-0000-0000-0000-000000000001",
    )
    assert out == []
    assert len(calls) == 1  # tentou de verdade antes de desistir
    assert persisted in ([], [[]])  # nunca escreve lição no corpus


def test_gate_auto_nao_adivinha_provedor(monkeypatch):
    """
    Regressão do defeito de PROD: com `GENESIS_LLM_PROVIDER=bedrock` e SEM `AWS_ACCESS_KEY_ID`
    (a EC2 usa instance role), o gate antigo devolvia [] sem nem chamar o modelo — ligar
    `RAG_ENABLED=live` teria persistido SÓ lições de regex.
    """
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    monkeypatch.setenv("GENESIS_LLM_PROVIDER", "bedrock")
    monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("LESSON_EXTRACT_LLM", raising=False)
    le = _reload()
    calls: list[dict] = []
    _patch_llm(monkeypatch, _ONE_LESSON, calls)
    out = le.LessonExtractor().extract("GAPs da rodada")
    assert len(calls) == 1
    assert len(out) == 1


def test_lesson_extract_llm_off_nao_chama_modelo(monkeypatch):
    """Desligamento EXPLÍCITO continua existindo (e não vira heurística)."""
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    monkeypatch.setenv("LESSON_EXTRACT_LLM", "off")
    le = _reload()
    calls: list[dict] = []
    _patch_llm(monkeypatch, _ONE_LESSON, calls)
    out = le.LessonExtractor().extract("GAPs da rodada")
    assert out == []
    assert calls == []
    monkeypatch.delenv("LESSON_EXTRACT_LLM", raising=False)


def test_resposta_sem_json_nao_gera_licao(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    _patch_llm(monkeypatch, "Não identifiquei lições generalizáveis nesta rodada.")
    assert le.LessonExtractor().extract("GAPs da rodada") == []


def test_resposta_em_cerca_markdown_e_tolerada(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    _patch_llm(monkeypatch, f"Segue o resultado:\n```json\n{_ONE_LESSON}\n```\n")
    out = le.LessonExtractor().extract("GAPs da rodada")
    assert [ln.slug for ln in out] == ["spec.api.idempotencia"]


# ── kind: fábrica (delivery) vs. Bancada (spec) ───────────────────────────────

def test_kind_spec_usa_prompt_de_especificacao_e_tag_bancada(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    calls: list[dict] = []
    _patch_llm(monkeypatch, _ONE_LESSON, calls)
    out = le.LessonExtractor().extract("GAPs: 6 bloqueadores", kind="spec")
    assert calls[0]["system"] == le._LLM_SYSTEM_SPEC
    assert "Laço de refinamento da spec" in calls[0]["user"]
    assert "bancada" in out[0].tags
    assert "factory" not in out[0].tags


def test_kind_delivery_mantem_prompt_historico(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    calls: list[dict] = []
    _patch_llm(monkeypatch, _ONE_LESSON, calls)
    out = le.LessonExtractor().extract("Diálogo do projeto aceito")
    assert calls[0]["system"] == le._LLM_SYSTEM
    assert "factory" in out[0].tags


# ── veto de contaminação do corpus global ─────────────────────────────────────

def test_veto_descarta_licao_que_cita_o_projeto_de_origem(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    payload = """[
      {"slug":"spec.lastmile.rotas","title":"NVX LastMile precisa de idempotência",
       "body_md":"**Regra:** ...","category":"contract","scope":"product"},
      {"slug":"spec.api.idempotencia","title":"Rotas de escrita declaram idempotência",
       "body_md":"**Regra:** genérica.","category":"contract","scope":"product"}
    ]"""
    _patch_llm(monkeypatch, payload)
    out = le.LessonExtractor().extract(
        "GAPs da rodada", kind="spec", forbidden_terms=["NVX LastMile", "nvx", "acme"],
    )
    assert [ln.slug for ln in out] == ["spec.api.idempotencia"]


def test_veto_ignora_termos_curtos(monkeypatch):
    """Termo de 1-3 chars casaria dentro de qualquer palavra e apagaria o corpus inteiro."""
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    _patch_llm(monkeypatch, _ONE_LESSON)
    out = le.LessonExtractor().extract("GAPs", kind="spec", forbidden_terms=["de", "api", ""])
    assert len(out) == 1


def test_veto_sem_termos_nao_filtra_nada():
    from orchestrator.lesson_extractor import Lesson, _veto_leaks
    lessons = [Lesson(slug="a.b", title="T", body_md="B")]
    assert _veto_leaks(lessons, []) == lessons


# ── PII ───────────────────────────────────────────────────────────────────────

def test_pii_redaction_applied(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "shadow")
    le = _reload()
    payload = """[
      {"slug":"spec.contato","title":"Falar com joao@example.com",
       "body_md":"**Regra:** avisar joao@example.com e usar AKIAABCDEFGHIJKLMNOP.",
       "category":"pattern","scope":"project"}
    ]"""
    _patch_llm(monkeypatch, payload)
    out = le.LessonExtractor().extract("qualquer diálogo")
    assert len(out) == 1
    for ln in out:
        assert "joao@example.com" not in ln.body_md
        assert "joao@example.com" not in ln.title
        assert "[EMAIL]" in ln.title
        assert "[AWS_KEY]" in ln.body_md
        assert ln.pii_redacted is True


# ── schema e robustez ─────────────────────────────────────────────────────────

def test_lesson_to_dict_schema():
    from orchestrator.lesson_extractor import Lesson
    ln = Lesson(slug="x.y.z", title="T", body_md="B")
    d = ln.to_dict()
    assert d["schemaVersion"] == "1.1.0"
    assert d["slug"] == "x.y.z"
    assert d["category"] == "pattern"
    assert "tags" in d


def test_extract_never_raises_on_bad_db_url(monkeypatch):
    monkeypatch.setenv("RAG_ENABLED", "live")
    monkeypatch.setenv("DATABASE_URL", "postgresql://invalid:0/none")
    le = _reload()
    _patch_llm(monkeypatch, _ONE_LESSON)
    # Não deve lançar
    out = le.LessonExtractor().extract(
        "GAPs da rodada", project_id="00000000-0000-0000-0000-000000000001",
    )
    assert isinstance(out, list)


def test_extract_never_raises_quando_runtime_explode(monkeypatch):
    """Se o próprio import do runtime falhar, o extrator loga e devolve [] (nunca lança)."""
    monkeypatch.setenv("RAG_ENABLED", "live")
    le = _reload()
    import builtins
    real_import = builtins.__import__

    def _fail(name, *args, **kwargs):
        if name == "orchestrator.agents.runtime":
            raise ImportError("boom")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fail)
    assert le.LessonExtractor().extract("GAPs da rodada") == []
