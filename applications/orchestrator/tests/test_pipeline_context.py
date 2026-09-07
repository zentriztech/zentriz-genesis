"""
Testes para PipelineContext (AGENT_LLM_COMMUNICATION_ANALYSIS).
get_dependency_code, register_artifact, completed_tasks.
"""
import pytest


def test_pipeline_context_register_artifact_and_completed_tasks():
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("proj-1")
    ctx.register_artifact("apps/src/models/vehicle.ts", "export interface Vehicle { id: string; }", "TSK-001")
    assert "apps/src/models/vehicle.ts" in ctx.artifacts
    assert ctx.artifacts["apps/src/models/vehicle.ts"] == "export interface Vehicle { id: string; }"
    assert "TSK-001" in ctx.completed_tasks


def test_pipeline_context_get_dependency_code_returns_only_requested():
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("proj-1")
    ctx.add_artifact("apps/src/models/vehicle.ts", "content A")
    ctx.add_artifact("apps/src/repositories/vehicle.repo.ts", "content B")
    ctx.add_artifact("apps/src/other.ts", "content C")
    dep = ctx.get_dependency_code(["apps/src/models/vehicle.ts", "apps/src/repositories/vehicle.repo.ts"])
    assert len(dep) == 2
    assert dep["apps/src/models/vehicle.ts"] == "content A"
    assert dep["apps/src/repositories/vehicle.repo.ts"] == "content B"
    assert "apps/src/other.ts" not in dep


def test_pipeline_context_get_dependency_code_truncates_large_file():
    """O corte existe, mas DECLARADO: arquétipo GAP-71 (corte mudo faz o Dev apagar código).

    Antes o marcador era `... [truncado]` — sem números. O Dev entrega o arquivo INTEIRO, então
    concluía que tinha visto tudo e reescrevia a partir do prefixo, apagando o resto (o veto
    "SÍMBOLOS REMOVIDOS" do runner é o sintoma). Agora o corte diz quanto ficou de fora e
    proíbe a reescrita integral.
    """
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("proj-1")
    large = "x" * 12000
    ctx.add_artifact("apps/big.ts", large)
    dep = ctx.get_dependency_code(["apps/big.ts"], max_per_file=5000)
    assert "apps/big.ts" in dep
    assert dep["apps/big.ts"].startswith("x" * 5000)
    assert "apps/big.ts" in dep["apps/big.ts"], "o corte tem de nomear o arquivo"
    assert "5000 de 12000" in dep["apps/big.ts"], "o corte tem de dizer os NÚMEROS"
    assert "7000" in dep["apps/big.ts"], "quantos chars ficaram de fora"
    assert "não reescreva" in dep["apps/big.ts"].lower()


def test_pipeline_context_get_dependency_code_missing_path_omitted():
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("proj-1")
    ctx.add_artifact("apps/a.ts", "a")
    dep = ctx.get_dependency_code(["apps/a.ts", "apps/nao_existe.ts"])
    assert dep == {"apps/a.ts": "a"}


def test_pipeline_context_lei7_extract_interfaces_for_large_file():
    """LEI 7: arquivo > 20K chars retorna apenas interfaces/assinaturas."""
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("p1")
    big = "export interface Foo { id: string; }\n" + "// comment\n" * 500 + "function bar(): void {}\n" + "x" * 25000
    ctx.add_artifact("apps/huge.ts", big)
    dep = ctx.get_dependency_code(["apps/huge.ts"], max_per_file=8000)
    assert "apps/huge.ts" in dep
    assert "INTERFACE RESUMIDA" in dep["apps/huge.ts"] or "interface" in dep["apps/huge.ts"]
    assert "export " in dep["apps/huge.ts"] or "function " in dep["apps/huge.ts"]


def test_pipeline_context_lei7_caps_total_chars():
    """LEI 7: total de dependency_code limitado a MAX_TOTAL_DEPENDENCY_CHARS.

    ⚠️ Arquétipo GAP-72/GAP-45: o teto continua valendo, mas a CAUDA não pode desaparecer.
    Antes o laço fazia `break` ao estourar o orçamento e os últimos arquivos de `depends_on`
    sumiam em SILÊNCIO — o Dev inventava a interface deles. Agora todo arquivo pedido aparece,
    inteiro ou com o corte declarado.
    """
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("p1")
    for i in range(10):
        ctx.add_artifact(f"apps/f{i}.ts", "x" * 10000)
    pedidos = [f"apps/f{i}.ts" for i in range(10)]
    dep = ctx.get_dependency_code(pedidos)
    total = sum(len(v) for v in dep.values())
    assert total <= ctx.MAX_TOTAL_DEPENDENCY_CHARS + 10 * 600, "teto + as marcas de corte"
    assert list(dep.keys()) == pedidos, "nenhum arquivo pedido pode desaparecer"
    assert all(v for v in dep.values()), "nem chegar vazio"
    assert dep["apps/f9.ts"], "a CAUDA da lista era exatamente o que o `break` engolia"


def test_validate_backlog_tasks_max_files_lei8_ok():
    """LEI 8: tasks com <= 3 estimated_files passam."""
    from orchestrator.pipeline_context import validate_backlog_tasks_max_files
    tasks = [
        {"id": "T1", "estimated_files": ["a.ts", "b.ts"]},
        {"id": "T2", "estimated_files": ["c.ts"]},
    ]
    assert validate_backlog_tasks_max_files(tasks) == []


def test_validate_backlog_tasks_max_files_lei8_fail():
    """LEI 8: task com > 3 arquivos gera issue."""
    from orchestrator.pipeline_context import validate_backlog_tasks_max_files
    tasks = [
        {"id": "T1", "estimated_files": ["a.ts", "b.ts", "c.ts", "d.ts"]},
    ]
    issues = validate_backlog_tasks_max_files(tasks)
    assert len(issues) == 1
    assert "T1" in issues[0]
    assert "4" in issues[0] and "máximo 3" in issues[0]


def test_pipeline_context_lei11_save_and_load_checkpoint(tmp_path):
    """LEI 11: save_checkpoint persiste estado; load_checkpoint restaura."""
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("proj-checkpoint")
    ctx.set_spec_raw("spec raw content")
    ctx.set_product_spec("product spec")
    ctx.set_charter("charter here")
    ctx.current_step = 2
    ctx.add_artifact("apps/a.ts", "code a")
    ctx.add_completed_task("TSK-1")
    ctx.save_checkpoint(tmp_path)
    assert (tmp_path / "proj-checkpoint" / "checkpoint.json").exists()
    loaded = PipelineContext.load_checkpoint(tmp_path, "proj-checkpoint")
    assert loaded is not None
    assert loaded.project_id == "proj-checkpoint"
    assert loaded.spec_raw == "spec raw content"
    assert loaded.product_spec == "product spec"
    assert loaded.charter == "charter here"
    assert loaded.current_step == 2
    assert loaded.artifacts.get("apps/a.ts") == "code a"
    assert "TSK-1" in loaded.completed_tasks


def test_pipeline_context_lei11_load_checkpoint_missing_returns_none(tmp_path):
    from orchestrator.pipeline_context import PipelineContext
    assert PipelineContext.load_checkpoint(tmp_path, "nonexistent-project") is None
