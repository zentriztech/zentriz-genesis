"""🔴 GAP-146 — censo do prefixo do CAG (16% do prompt mais caro da Bancada).

MEDIDO em prod, com o censo do prompt já no ar: cada chamada do CTO por-arquivo carrega ~30.400 chars
(~6.420 tokens) de prefixo de CAG, e SEMPRE o mesmo tamanho — `lessons=20` é o LIMITE da recuperação
(`semantic_search` devolve o top-20 sem piso de similaridade), não uma medida de relevância. Cortar
lição é regredir o G7 (o laço aprendendo com o que já errou), então antes de qualquer piso faltavam
duas medidas: ONDE estão os chars e QUÃO perto do pedido está o que se pagou.

O que fica pinado aqui:
  1. o censo FECHA por construção — `soma(seções) == len(prefixo)`, porque fatia o texto ENTREGUE
     pelos cabeçalhos que o renderizador escreveu (não recalcula a renderização);
  2. seção ausente não aparece (pacote sem contratos Connect não "gasta" em Connect);
  3. prefixo vazio (CAG off / pacote vazio) devolve censo vazio, não zeros inventados.
"""
from orchestrator.context_loader import ContextPackage, prefix_census


def _pkg(**kw) -> ContextPackage:
    return ContextPackage(role="cto", stack_key="generic", mode="live", **kw)


def test_censo_fecha_com_o_prefixo_renderizado():
    pkg = _pkg(
        system_prompt_prefix="REGRAS DO PAPEL " * 20,
        connect_contracts=[{"contract": "spec.v1", "version": "1.3.0", "summary": "s" * 100}],
        bug_checklists=[{"title": "bug conhecido", "rule": "r" * 80}],
        lessons_hot=[{"title": f"lição {i}", "confidence": 0.9, "hitCount": i, "bodyMd": "b" * 500}
                     for i in range(20)],
    )
    prefixo = pkg.to_prompt_prefix()
    censo = prefix_census(prefixo)
    assert sum(censo.values()) == len(prefixo)
    # as lições são a maior fatia — é o número que justifica olhar para o piso de similaridade
    assert max(censo, key=lambda k: censo[k]) == "lessons"
    assert set(censo) == {"cabecalho", "connect", "bugs", "lessons"}


def test_secao_ausente_nao_vira_despesa():
    pkg = _pkg(lessons_hot=[{"title": "só lição", "bodyMd": "x" * 300}])
    censo = prefix_census(pkg.to_prompt_prefix())
    assert "connect" not in censo and "bugs" not in censo
    assert censo["lessons"] > 0
    assert sum(censo.values()) == len(pkg.to_prompt_prefix())


def test_prefixo_vazio_nao_inventa_zeros():
    assert prefix_census("") == {}
    assert prefix_census(_pkg().to_prompt_prefix()) == {}


def test_censo_nao_carrega_conteudo_da_licao():
    pkg = _pkg(lessons_hot=[{"title": "SEGREDO-DO-CLIENTE", "bodyMd": "SEGREDO"}])
    assert "SEGREDO" not in repr(prefix_census(pkg.to_prompt_prefix()))
