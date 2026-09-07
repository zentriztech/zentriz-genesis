"""
🔴 GAP-53 — o orçamento da SPEC na entrada da FÁBRICA ("iniciar onda").

Medido em prod 2026-09-07 (NVX LastMile, projeto e2a1988c): a Bancada tinha uma árvore de
**12 arquivos / 1.065.930 chars** e a fábrica recebia os primeiros **40.000**
(`AGENT_INPUT_CHARS`, teto pensado para artefatos INTERMEDIÁRIOS). Consequências medidas:

  • 3,75% da spec entregue; o corte caía DENTRO do 1º arquivo ⇒ **zero** dos 12 arquivos
    chegava íntegro;
  • o CTO via **6 de 22** FRs; o Engineer (`[:15000]`) via **0 de 22**;
  • o corte era SILENCIOSO — o log anunciava "1.065.930 chars, 12 arquivo(s)" e nada dizia
    que 96% ficou fora (classe do GAP-45: mentir sobre o próprio corte).

Estes testes congelam as duas regras de TRANSPORTE (a decisão de conteúdo continua do LLM):
cortar em fronteira de arquivo e DECLARAR o corte no prompt.
"""
import os

from orchestrator.runner import _spec_input_cap, fit_spec_to_budget
from orchestrator.pipeline_context import PipelineContext


def _tree(*sizes: int) -> tuple[str, list[str]]:
    """Monta uma concatenação no formato de `load_spec_all` com N arquivos."""
    labels = [f"arquivo-{i:02d}.md" for i in range(len(sizes))]
    parts = [f"---\n# [{lab}]\n\n" + ("x" * n) for lab, n in zip(labels, sizes)]
    return "\n\n".join(parts), labels


def test_spec_que_cabe_passa_intacta_e_sem_aviso():
    tree, _ = _tree(100, 100)
    out, dropped, partial = fit_spec_to_budget(tree, 100_000)
    assert out == tree
    assert dropped == [] and partial is False
    assert "CORTE" not in out and "INCOMPLETA" not in out


def test_corta_em_fronteira_de_arquivo_e_nomeia_os_que_ficaram_fora():
    # 3 arquivos de ~10k; orçamento comporta 2 (reserva de 1.200 para o aviso).
    tree, labels = _tree(10_000, 10_000, 10_000)
    out, dropped, partial = fit_spec_to_budget(tree, 23_000)
    assert partial is False
    assert dropped == [labels[2]]
    # os 2 primeiros chegam ÍNTEGROS (nenhum corte no meio de arquivo)
    assert out.count("# [") == 2
    assert out.rstrip().endswith("x")
    # e o corte é DECLARADO com nome de arquivo
    assert "ESTA ESPECIFICAÇÃO CHEGOU INCOMPLETA" in out
    assert labels[2] in out
    assert "não invente" in out


def test_primeiro_arquivo_gigante_e_pulado_inteiro_em_vez_de_cortado():
    """Cortar no meio é o ÚLTIMO recurso: se outro arquivo cabe, entrega-se ele ÍNTEGRO."""
    tree, labels = _tree(50_000, 1_000)
    out, dropped, partial = fit_spec_to_budget(tree, 10_000)
    assert partial is False
    assert dropped == [labels[0]]
    assert labels[0] in out and "não invente" in out


def test_corte_no_meio_so_quando_NENHUM_arquivo_cabe():
    tree, labels = _tree(50_000, 40_000)
    out, dropped, partial = fit_spec_to_budget(tree, 10_000)
    assert partial is True
    assert dropped == [labels[1]]
    assert "cortado no meio" in out
    assert len(out) <= 10_000 + 1_500  # aviso cabe na reserva


def test_arquivo_unico_sem_fronteira_ainda_declara():
    out, dropped, partial = fit_spec_to_budget("y" * 90_000, 20_000)
    assert partial is True and dropped == []
    assert "INCOMPLETA" in out


def test_orcamento_da_spec_e_maior_que_o_dos_artefatos_intermediarios():
    """O bug era exatamente usar o mesmo teto dos artefatos para a spec."""
    assert _spec_input_cap() >= 145_000
    assert _spec_input_cap() > int(os.environ.get("AGENT_INPUT_CHARS", "40000"))


def test_contexto_nao_reduz_a_spec_ao_teto_dos_artefatos():
    """`set_spec_raw`/`set_product_spec` cortavam em 40.000 — a perda era permanente."""
    ctx = PipelineContext("p1")
    grande = "z" * 120_000
    ctx.set_spec_raw(grande)
    ctx.set_product_spec(grande)
    assert len(ctx.spec_raw) == 120_000, "spec crua não pode cair no teto de artefato"
    assert len(ctx.product_spec) == 120_000, "spec normalizada é da mesma natureza da crua"


def test_arquivo_gigante_no_meio_nao_cancela_os_seguintes():
    """First-fit: parar no 1º que não cabe entregava 1 de 3; empacotar entrega 2."""
    tree, labels = _tree(10_000, 500_000, 10_000)
    out, dropped, partial = fit_spec_to_budget(tree, 40_000)
    assert partial is False
    assert dropped == [labels[1]]
    assert out.count("# [") == 2, "o 3º arquivo cabe e tem de chegar"


def test_regressao_nvx_a_arvore_de_prod_entrega_arquivos_inteiros():
    """Cenário medido em prod: 12 arquivos, 1.065.930 chars, corte em 40.000 (3,75%).

    ⚠️ Este teste também CONGELA o teto estrutural honesto: mesmo com o orçamento correto,
    esta árvore NÃO cabe num prompt (o 2º arquivo, `modelo-dados.md`, tem 198.435 chars —
    mais que o orçamento inteiro). O que este fix garante é: arquivos ÍNTEGROS, muito mais
    spec entregue e o que faltou DECLARADO. Entregar 100% exige a fábrica ler POR ARQUIVO
    (GAP-54), não um teto maior.
    """
    tamanhos = [52_151, 198_435, 61_706, 80_234, 99_031, 78_762,
                95_338, 72_438, 101_009, 71_844, 68_980, 85_595]
    tree, labels = _tree(*tamanhos)
    out, dropped, partial = fit_spec_to_budget(tree, _spec_input_cap())
    assert partial is False, "o 1º arquivo do NVX cabe — não pode sair parcial"
    entregues = out.count("# [")
    assert entregues >= 2, "first-fit tem de empacotar ao menos 2 arquivos íntegros"
    assert len(dropped) == len(labels) - entregues
    # a proporção entregue tem de ser MUITO maior que os 3,75% do defeito
    assert len(out) / len(tree) > 0.10
    for lab in dropped[:8]:
        assert lab in out, "todo arquivo ausente é nomeado ao agente"
