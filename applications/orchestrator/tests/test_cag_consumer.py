"""
G7 — lado CONSUMIDOR das lições (2026-09-06).

O QUE ESTAVA QUEBRADO (medido em prod): o produtor de lições da Bancada ficou pronto e o
`lessons_corpus` saiu de 0 para 8 lições reais, com 8/8 embeddings indexados... e NENHUM agente
lia aquilo. Duas causas, ambas cobertas aqui:

  1. O prefixo de CAG só era aplicado dentro de `load_system_prompt_with_skills`, chamada APENAS
     pelo `runner.py` (dev/qa/devops). O CTO da Bancada entra por `run_agent`, que montava o system
     prompt com `build_system_prompt` e seguia direto para o modelo. As lições da Bancada eram
     escritas pela Bancada e lidas por ninguém.

  2. A recuperação filtra `project_id = %s::uuid OR project_id IS NULL`, e a Bancada manda o
     pseudo-projeto `project_id="spec_chat"` (o default do `run_agent` é a string `"default"`).
     Qualquer um dos dois faz o Postgres estourar `invalid input syntax for type uuid`, o `except`
     engole e devolve ZERO lições — em silêncio, parecendo "não há lição relevante".

Os testes abaixo fixam o contrato: UUID sai do `circuit_scope`, a consulta semântica é o pedido
humano (não "cto generic"), e `CAG_ENABLED=off` mantém o prompt byte-idêntico.
"""
import pytest


# ── extração do UUID (defeito 2) ──────────────────────────────────────────────

def test_uuid_sai_do_circuit_scope_da_bancada():
    from orchestrator.agents.runtime import _cag_project_uuid
    uid = "e2a1988c-1c9f-4c2e-9a0b-7d3f5b1e2c44"
    assert _cag_project_uuid("spec_chat", None, f"spec_chat:{uid}", None) == uid


def test_pseudo_projeto_e_default_nunca_viram_project_id():
    """`"spec_chat"`/`"default"` no `::uuid` = erro de SQL → zero lições. Melhor `None` (global)."""
    from orchestrator.agents.runtime import _cag_project_uuid
    assert _cag_project_uuid("spec_chat", "default", "   ", 42) is None
    assert _cag_project_uuid() is None


def test_uuid_direto_no_project_id_e_aceito():
    from orchestrator.agents.runtime import _cag_project_uuid
    uid = "11111111-2222-3333-4444-555555555555"
    assert _cag_project_uuid(uid) == uid


# ── consulta semântica (o sinal da busca) ─────────────────────────────────────

def test_query_prioriza_o_pedido_humano():
    from orchestrator.agents.runtime import _cag_query_from
    q = _cag_query_from(
        {"project_id": "spec_chat"},
        {"user_message": "detalhe os contratos de erro dos endpoints",
         "spec_raw": "# Spec gigante\n" + ("x" * 5000)},
    )
    assert q.startswith("detalhe os contratos de erro dos endpoints")


def test_query_tem_teto_e_nao_manda_a_spec_inteira():
    from orchestrator.agents.runtime import _cag_query_from, CAG_QUERY_MAX_CHARS
    q = _cag_query_from({}, {"spec_raw": "y" * 200_000})
    assert len(q) == CAG_QUERY_MAX_CHARS


def test_query_serializa_dict_e_ignora_vazio():
    from orchestrator.agents.runtime import _cag_query_from
    q = _cag_query_from({}, {"user_message": "  ", "validation_report": {"findings": ["sem idempotência"]}})
    assert "sem idempotência" in q


def test_query_vazia_quando_nao_ha_sinal():
    from orchestrator.agents.runtime import _cag_query_from
    assert _cag_query_from({}, {}) == ""


# ── gate de CAG_ENABLED ───────────────────────────────────────────────────────

def test_cag_off_mantem_o_prompt_byte_identico(monkeypatch):
    from orchestrator.agents.runtime import _maybe_apply_cag_prefix
    monkeypatch.setenv("CAG_ENABLED", "off")
    base = "SYSTEM PROMPT ORIGINAL"
    assert _maybe_apply_cag_prefix(base, "CTO", "generic", None, "q") is base


def test_cag_live_prefixa_as_licoes_recuperadas(monkeypatch):
    """`live` = a lição ENTRA no prompt (é este o gate do G7) e o original é preservado embaixo."""
    import orchestrator.context_loader as cl
    from orchestrator.agents import runtime

    monkeypatch.setenv("CAG_ENABLED", "live")

    class _Pkg:
        payload_tokens = 120
        cache_hit = False
        duration_ms = 3
        lessons_hot = [{"slug": "s1"}]

        def to_prompt_prefix(self) -> str:
            return "### Lições relevantes (corpus RAG)\n- Nenhum endpoint sem contrato completo"

    class _Loader:
        def __init__(self):
            self.seen: dict = {}

        def load(self, role, stack_key, project_id, query):
            self.seen = {"role": role, "stack_key": stack_key, "project_id": project_id, "query": query}
            return _Pkg()

    loader = _Loader()
    monkeypatch.setattr(cl, "get_context_loader", lambda: loader)

    out = runtime._maybe_apply_cag_prefix("SYSTEM ORIGINAL", "CTO", "generic",
                                          "11111111-2222-3333-4444-555555555555", "resolver GAPs")
    assert "contrato completo" in out
    assert out.endswith("SYSTEM ORIGINAL")
    assert loader.seen["project_id"] == "11111111-2222-3333-4444-555555555555"
    assert loader.seen["query"] == "resolver GAPs"


def test_cag_shadow_observa_sem_injetar(monkeypatch):
    import orchestrator.context_loader as cl
    from orchestrator.agents import runtime

    monkeypatch.setenv("CAG_ENABLED", "shadow")

    class _Pkg:
        payload_tokens = 0
        cache_hit = False
        duration_ms = 1
        lessons_hot: list = []

        def to_prompt_prefix(self) -> str:  # pragma: no cover - shadow não deve chamar
            raise AssertionError("shadow não pode injetar prefixo")

    monkeypatch.setattr(cl, "get_context_loader", lambda: type("L", (), {"load": lambda *a, **k: _Pkg()})())
    assert runtime._maybe_apply_cag_prefix("BASE", "CTO", "generic", None, "q") == "BASE"


def test_falha_do_loader_nunca_derruba_o_agente(monkeypatch):
    """Aprender é acessório: exceção na recuperação = prompt original, não erro na rodada."""
    import orchestrator.context_loader as cl
    from orchestrator.agents import runtime

    monkeypatch.setenv("CAG_ENABLED", "live")

    def _boom():
        raise RuntimeError("postgres fora")

    monkeypatch.setattr(cl, "get_context_loader", _boom)
    assert runtime._maybe_apply_cag_prefix("BASE", "CTO", "generic", None, "q") == "BASE"


# ── /invoke/raw: CAG é OPT-IN do chamador (edição por-arquivo da Bancada) ─────

def _raw_body(**extra):
    body = {"prompt_override": "EDITOR DE TEXTO", "user_message": "PEDIDO: detalhe erros",
            "model_id": "us.anthropic.claude-opus-4-8", "max_tokens": 1000}
    body.update(extra)
    return body


@pytest.fixture()
def _raw_client(monkeypatch):
    """Client do FastAPI com `call_bedrock_direct` dublado — devolve o system prompt recebido."""
    from fastapi.testclient import TestClient
    from orchestrator.agents import server, runtime

    seen: dict = {}

    def _fake_direct(system, user, model_id, max_tokens, temperature, llm_cfg=None):
        seen["system"] = system
        return "CONTEUDO FINAL"

    monkeypatch.setattr(runtime, "call_bedrock_direct", _fake_direct)
    return TestClient(server.app), seen


def test_raw_sem_bloco_cag_nao_recupera_licao(_raw_client, monkeypatch):
    """O gate semântico (Haiku) e o planejador de evolução usam este endpoint — não devem mudar."""
    import orchestrator.context_loader as cl
    client, seen = _raw_client
    monkeypatch.setenv("CAG_ENABLED", "live")
    monkeypatch.setattr(cl, "get_context_loader", lambda: (_ for _ in ()).throw(AssertionError("não deveria carregar")))
    r = client.post("/invoke/raw", json=_raw_body())
    assert r.status_code == 200
    assert seen["system"] == "EDITOR DE TEXTO"


def test_raw_com_bloco_cag_prefixa_licoes(_raw_client, monkeypatch):
    import orchestrator.context_loader as cl
    client, seen = _raw_client
    monkeypatch.setenv("CAG_ENABLED", "live")

    class _Pkg:
        payload_tokens = 10
        cache_hit = True
        duration_ms = 2
        lessons_hot = [{"slug": "s1"}]

        def to_prompt_prefix(self) -> str:
            return "### Lições relevantes (corpus RAG)\n- Declarar origem confiável do IP"

    captured: dict = {}

    class _Loader:
        def load(self, role, stack_key, project_id, query):
            captured.update({"role": role, "project_id": project_id, "query": query})
            return _Pkg()

    monkeypatch.setattr(cl, "get_context_loader", lambda: _Loader())
    uid = "e2a1988c-1c9f-4c2e-9a0b-7d3f5b1e2c44"
    r = client.post("/invoke/raw", json=_raw_body(
        cag={"role": "CTO", "stack_key": "generic", "project_id": uid, "query": "GAPs de idempotência"},
    ))
    assert r.status_code == 200
    assert "origem confiável do IP" in seen["system"]
    assert seen["system"].endswith("EDITOR DE TEXTO")
    # o loader recebe o papel em minúsculas (contrato de `_maybe_apply_cag_prefix`)
    assert captured == {"role": "cto", "project_id": uid, "query": "GAPs de idempotência"}


def test_raw_com_cag_quebrado_ainda_edita_o_arquivo(_raw_client, monkeypatch):
    """A edição do arquivo é o trabalho; a lição é bônus. Falha no CAG não pode virar 500."""
    import orchestrator.context_loader as cl
    client, seen = _raw_client
    monkeypatch.setenv("CAG_ENABLED", "live")
    monkeypatch.setattr(cl, "get_context_loader", lambda: (_ for _ in ()).throw(RuntimeError("pgvector fora")))
    r = client.post("/invoke/raw", json=_raw_body(cag={"role": "CTO", "project_id": "spec_chat"}))
    assert r.status_code == 200
    assert r.json()["response"] == "CONTEUDO FINAL"
    assert seen["system"] == "EDITOR DE TEXTO"
