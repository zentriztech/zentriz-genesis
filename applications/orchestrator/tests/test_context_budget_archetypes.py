"""
Arquétipos da Bancada (GAP-69→75) aplicados à FÁBRICA — ORDEM, RESERVA e CORTE DECLARADO.

O que estes testes congelam (todos medidos em produção na Bancada, 2026-09-07):

* **GAP-72/73 — ORDEM.** O orçamento gasto em ordem de lista entregava ao agente 1 de 10
  seções ancoradas e deixava 8 de 25 literais citados fora do recorte. Na fábrica a lista
  de `existing_artifacts` chega em ordem ALFABÉTICA (`rglob` do runner) e o arquivo que a
  task manda editar disputava a cota com qualquer outro.
* **GAP-45/72 — CAUDA MUDA.** O `break` de `get_dependency_code` derrubava o fim de
  `depends_on` em silêncio: o Dev inventava a interface do arquivo que nunca chegou.
* **GAP-71 — CORTE MUDO / ERRATA NULA.** `... [truncado]` sem números faz o agente concluir
  que viu o arquivo inteiro; como ele devolve o arquivo em formato `whole`, reescreve a
  partir do prefixo e APAGA o resto (o veto "SÍMBOLOS REMOVIDOS" do runner é o sintoma).
"""
import os


# ── plan_allocation: ordem e reserva ──────────────────────────────────────────────────────


def test_citado_no_fim_da_lista_nao_fica_com_zero():
    """O defeito: o orçamento acabava antes de chegar em quem a task cita."""
    from orchestrator.context_budget import plan_allocation
    itens = [(f"apps/f{i}.ts", 30_000) for i in range(9)] + [("apps/alvo.ts", 30_000)]
    alloc = plan_allocation(itens, 60_000, cited=["apps/alvo.ts"], min_share=2_000)
    assert alloc["apps/alvo.ts"] >= 2_000, "o citado tem RESERVA"
    assert alloc["apps/alvo.ts"] == max(alloc.values()), "e é atendido antes da sobra"
    assert sum(alloc.values()) <= 60_000


def test_quem_cabe_inteiro_devolve_a_folga_para_os_seguintes():
    from orchestrator.context_budget import plan_allocation
    alloc = plan_allocation([("a", 100), ("b", 50_000)], 20_000, min_share=1_000)
    assert alloc["a"] == 100, "não faz sentido reservar 1.000 para um arquivo de 100"
    assert alloc["b"] == 19_900, "a folga do primeiro vai para o segundo"


def test_orcamento_zero_nao_esconde_ninguem_mas_declara_zero():
    from orchestrator.context_budget import plan_allocation
    alloc = plan_allocation([("a", 10), ("b", 10)], 0)
    assert alloc == {"a": 0, "b": 0}, "0 é resposta válida — e o chamador tem de DECLARAR"


def test_sem_citados_a_ordem_original_e_preservada():
    from orchestrator.context_budget import plan_allocation
    alloc = plan_allocation([("a", 10), ("b", 10), ("c", 10)], 100)
    assert list(alloc.keys()) == ["a", "b", "c"]


# ── cited_paths: o literal citado (GAP-73, "a outra ponta") ────────────────────────────────


def test_literal_citado_so_na_descricao_conta_como_citado():
    from orchestrator.context_budget import cited_paths
    texto = "Adicionar o campo `courier_id` em apps/src/db/schema.ts sem quebrar o repo."
    assert cited_paths([texto], ["apps/src/db/schema.ts", "apps/src/other.ts"]) == [
        "apps/src/db/schema.ts"
    ]


def test_basename_casa_por_fronteira_de_palavra_e_nao_por_substring():
    from orchestrator.context_budget import cited_paths
    achados = cited_paths(["editar app.ts"], ["apps/src/app.ts", "apps/src/myapp.ts"])
    assert achados == ["apps/src/app.ts"], "`myapp.ts` não pode casar com `app.ts`"


def test_sem_texto_nada_e_citado():
    from orchestrator.context_budget import cited_paths
    assert cited_paths([""], ["apps/a.ts"]) == []


# ── corte declarado (GAP-71) ───────────────────────────────────────────────────────────────


def test_corte_declara_numeros_e_proibe_reescrita_integral():
    from orchestrator.context_budget import apply_cut
    out = apply_cut("apps/a.ts", "y" * 10_000, 4_000)
    assert out.startswith("y" * 4_000)
    assert "4000 de 10000" in out and "6000" in out
    assert "apps/a.ts" in out
    assert "não reescreva" in out.lower()
    assert "[...]" not in out, "não pode disparar o detector de truncamento de artefato"


def test_sem_corte_o_texto_sai_intacto():
    from orchestrator.context_budget import apply_cut
    assert apply_cut("apps/a.ts", "abc", 10) == "abc"


# ── get_dependency_code: cauda declarada, nunca engolida ──────────────────────────────────


def test_dependencia_que_nao_cabe_e_declarada_e_nao_desaparece():
    """40 arquivos e orçamento para ~30 reservas: os últimos DEVEM aparecer declarados."""
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("p1")
    pedidos = []
    for i in range(40):
        p = f"apps/f{i:02d}.ts"
        ctx.add_artifact(p, "export const x = 1;\n" + "z" * 10_000)
        pedidos.append(p)
    dep = ctx.get_dependency_code(pedidos)
    assert list(dep.keys()) == pedidos, "a lista pedida é a lista entregue"
    ultimos = [dep[p] for p in pedidos[-5:]]
    assert all(v.strip() for v in ultimos), "cauda muda era o defeito"
    assert any("NÃO ENTREGUE" in v for v in dep.values()), (
        "quem ficou sem orçamento tem de ser DECLARADO, não omitido"
    )


def test_dependencia_grande_entrega_assinaturas_quando_elas_cabem():
    """Janela útil (GAP-74): assinaturas inteiras valem mais que um prefixo cru do mesmo tamanho."""
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("p1")
    corpo = "".join(f"export function f{i}(a: string): void {{}}\n" for i in range(60))
    ctx.add_artifact("apps/big.ts", corpo + "y" * 40_000)
    dep = ctx.get_dependency_code(["apps/big.ts"], max_per_file=8_000)
    assert "INTERFACE RESUMIDA" in dep["apps/big.ts"]
    assert "export function f59" in dep["apps/big.ts"], "as assinaturas do FIM também"
    assert "CORTE DE CONTEXTO" in dep["apps/big.ts"], "e o corte é declarado"


# ── existing_artifacts no prompt: citado primeiro e inteiro ────────────────────────────────


def _msg(task_desc: str, artifacts: list) -> dict:
    return {
        "task": "Implementar task",
        "mode": "implement_task",
        "inputs": {
            "current_task": {"id": "TSK-1", "title": "t", "description": task_desc},
        },
        "existing_artifacts": artifacts,
    }


def test_artefato_citado_pela_task_vem_primeiro_e_chega_inteiro():
    from orchestrator.agents.runtime import build_user_message
    grande = "export const alvo = 1;\n" + "a" * 30_000
    outro = "export const ruido = 1;\n" + "b" * 30_000
    msg = _msg(
        "Corrigir o mapeamento em apps/src/zzz_alvo.ts conforme o critério.",
        [
            {"path": "apps/src/aaa_ruido.ts", "content": outro},
            {"path": "apps/src/zzz_alvo.ts", "content": grande},
        ],
    )
    out = build_user_message(msg, role="DEV")
    i_alvo = out.index("### apps/src/zzz_alvo.ts")
    i_ruido = out.index("### apps/src/aaa_ruido.ts")
    assert i_alvo < i_ruido, "ordem alfabética era o defeito: o citado tem de vir primeiro"
    assert "a" * 30_000 in out, "o arquivo citado chega INTEIRO (reserva)"
    assert "CORTE DE CONTEXTO" in out, "o não citado é cortado — e o corte é declarado"
    assert "apps/src/aaa_ruido.ts" in out.split("CORTE DE CONTEXTO")[0]


def test_flag_off_volta_a_ordem_e_ao_teto_historicos():
    from orchestrator.agents.runtime import build_user_message
    os.environ["AGENT_ARTIFACT_CITED_RESERVE"] = "off"
    try:
        grande = "x" * 30_000
        msg = _msg(
            "Corrigir apps/src/zzz_alvo.ts.",
            [
                {"path": "apps/src/aaa_ruido.ts", "content": "y" * 30_000},
                {"path": "apps/src/zzz_alvo.ts", "content": grande},
            ],
        )
        out = build_user_message(msg, role="DEV")
        assert out.index("### apps/src/aaa_ruido.ts") < out.index("### apps/src/zzz_alvo.ts")
        assert "x" * 30_000 not in out, "com a flag off o citado volta ao teto de 8.000"
    finally:
        os.environ.pop("AGENT_ARTIFACT_CITED_RESERVE", None)


def test_qa_continua_vendo_o_artefato_completo():
    """A reserva NUNCA pode reduzir o teto de quem já via tudo (QA valida completude)."""
    from orchestrator.agents.runtime import build_user_message
    corpo = "z" * 120_000
    msg = _msg("Validar apps/src/a.ts", [{"path": "apps/src/a.ts", "content": corpo}])
    out = build_user_message(msg, role="QA")
    assert corpo in out
    assert "CORTE DE CONTEXTO" not in out


def test_dependency_code_no_prompt_declara_o_corte():
    from orchestrator.agents.runtime import build_user_message
    msg = {
        "task": "t",
        "mode": "implement_task",
        "inputs": {"dependency_code": {"apps/dep.ts": "q" * 20_000}},
    }
    out = build_user_message(msg, role="DEV")
    assert "8000 de 20000" in out
    assert "não reescreva" in out.lower()


# ── get_relevant_artifacts_for_task ───────────────────────────────────────────────────────


def test_relevant_artifacts_coloca_o_citado_primeiro_e_inteiro():
    from orchestrator.pipeline_context import PipelineContext
    ctx = PipelineContext("p1")
    ctx.add_artifact("apps/aaa_ruido.ts", "b" * 30_000)
    ctx.add_artifact("apps/zzz_alvo.ts", "a" * 30_000)
    ctx.set_current_task({"id": "TSK-1", "description": "editar apps/zzz_alvo.ts"})
    out = ctx.get_relevant_artifacts_for_task("TSK-1")
    assert out[0]["path"] == "apps/zzz_alvo.ts"
    assert out[0]["content"] == "a" * 30_000, "citado chega inteiro"
    assert "CORTE DE CONTEXTO" in out[1]["content"], "o resto é cortado com declaração"
