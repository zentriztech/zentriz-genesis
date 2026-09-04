"""Onda 4 (PR-2): testes do coletor de usage agregado do splitter.

Prova que o sink por-chamada (contextvar) soma os tokens de TODAS as chamadas ao LLM de uma
decomposição — inclusive as paralelas do PASSO 2, que rodam em ThreadPoolExecutor (onde
contextvars NÃO propagam automaticamente) — e que _run_splitter anexa esse total em
result["usage"]. Sem Bedrock: call_bedrock_direct é substituído por um stub que emite o sink.
"""
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from orchestrator.agents.runtime import (
    _UsageCollector,
    _usage_sink,
    collect_usage,
    _sink_usage,
)


def test_collector_soma_e_totaliza():
    c = _UsageCollector()
    c.add(10, 5, "opus-4-8")
    c.add(3, 2, "opus-4-8")
    t = c.totals()
    assert t["input_tokens"] == 13
    assert t["output_tokens"] == 7
    assert t["calls"] == 2
    assert t["model"] == "opus-4-8"


def test_collector_sanitiza_negativo_e_none():
    c = _UsageCollector()
    c.add(-5, None, None)   # negativos e None viram 0; modelo None não sobrescreve
    c.add(4, 4, "sonnet-4-6")
    t = c.totals()
    assert t["input_tokens"] == 4
    assert t["output_tokens"] == 4
    assert t["calls"] == 2
    assert t["model"] == "sonnet-4-6"


def test_sink_usage_sem_coletor_ativo_e_noop():
    # Fora de qualquer collect_usage, _usage_sink é None → não lança nem acumula.
    assert _usage_sink.get() is None
    _sink_usage(100, 100, "x")  # não deve levantar
    assert _usage_sink.get() is None


def test_collect_usage_instala_e_restaura_sink():
    c = _UsageCollector()
    with collect_usage(c) as active:
        assert active is c
        assert _usage_sink.get() is c
        _sink_usage(7, 3, "m")
    # ao sair, o sink volta a None (restore via reset)
    assert _usage_sink.get() is None
    assert c.totals()["input_tokens"] == 7


def test_sink_agrega_atraves_de_threadpool_com_install_por_chamada():
    # Reproduz o padrão do splitter: cada worker instala o sink no SEU contexto (contextvars
    # não herdam em pools que reusam threads) e soma no MESMO coletor compartilhado.
    c = _UsageCollector()

    def worker(_i: int) -> None:
        with collect_usage(c):
            _sink_usage(2, 1, "opus-4-8")

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(worker, range(20)))

    t = c.totals()
    assert t["calls"] == 20
    assert t["input_tokens"] == 40
    assert t["output_tokens"] == 20


def test_run_splitter_anexa_usage_no_resultado(monkeypatch):
    # Stub de call_bedrock_direct: emite tokens pelo sink (como o real faz) e devolve o JSON
    # esperado pelo splitter (manifesto no passo 1, arquivos no passo 2).
    import orchestrator.agents.runtime as runtime
    from orchestrator.agents import server

    manifest = {
        "schemaVersion": "1.3.0",
        "product": {"name": "Proj X", "systemId": "proj-x", "specApproved": False,
                    "deliveryDefault": "source_only", "rationale": "Corte por contexto."},
        "projects": [
            {"id": "px-api", "spec": "specs/px-api.md", "type": "backend_api_node", "dependsOn": [],
             "archetype": "rest-api", "stack": ["Node 20"], "deployTarget": "docker-compose-single-host",
             "summary": "API REST.", "cutReason": "service-scope", "mergeBlocker": "none",
             "ishScore": 8, "relationships": []},
        ],
    }

    def pass2(pid: str) -> dict:
        return {
            "spec": f"# {pid}\n\n## Objetivo\nSpec completa do projeto {pid} com requisitos e critérios de aceite.",
            "files": {},
            "connect": {
                "serviceName": pid, "responsibility": "Responsabilidade do bounded context deste serviço.",
                "interfaces": [], "dependencies": [], "events": {"publishes": [], "subscribes": []},
                "runtimeType": "container", "healthModel": {"hasHealthEndpoint": True, "signals": ["latency_p95"]},
            },
        }

    def fake_call(system, user, model_id, max_tokens=8000, temperature=0.2,
                  usage_project_id=None, usage_agent="direct"):
        # emula o real: reporta usage no sink ativo (instalado por _run_splitter._llm)
        runtime._sink_usage(11, 6, model_id)
        if "PROJETO ALVO" not in user:
            return json.dumps(manifest, ensure_ascii=False)
        return json.dumps(pass2("px-api"), ensure_ascii=False)

    monkeypatch.setattr(runtime, "call_bedrock_direct", fake_call)

    out = server._run_splitter("# doc grande\n\nProduto com uma API.", "us.anthropic.claude-opus-4-8")
    assert "usage" in out
    u = out["usage"]
    # 2 chamadas (manifesto + 1 projeto) × (11 in, 6 out)
    assert u["calls"] == 2
    assert u["input_tokens"] == 22
    assert u["output_tokens"] == 12
    assert u["model"] == "us.anthropic.claude-opus-4-8"
