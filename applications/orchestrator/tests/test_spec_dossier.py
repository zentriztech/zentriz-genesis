"""GAP-54 — a Fábrica lê a spec POR ARQUIVO, com MAPA do produto inteiro.

O "antes" foi MEDIDO em prod (projeto `e2a1988c`, NVX LastMile — Backend, 2026-09-08), sem gastar
LLM: rodando o `fit_spec_to_budget` real sobre os tamanhos reais da árvore, **2 de 12 arquivos
chegavam à Fábrica — 10,2% da spec**. O `modelo-dados.md` (218.840 chars) é maior que o orçamento
INTEIRO (143.800), então o agente que decide o modelo de dados do produto nunca o viu.

Os testes abaixo fixam as duas propriedades que fazem o dossiê ser diferente de "cortar melhor":

  1. **o MAPA cobre 100% dos arquivos** mesmo quando o TEXTO cobre 10% — a diferença entre "não
     recebi" e "não recebi, e sei o que era" é o que separa `no-invent` de invenção;
  2. **nada sai em silêncio** — todo arquivo fora do texto integral é NOMEADO (A5.7/GAP-45: cortar é
     aceitável, mentir sobre o corte não é).

E a propriedade anti-fraude do instrumento: `map_coverage` tem de CAIR quando o mapa é cortado. Uma
métrica que devolve 100% por construção é a armadilha do GAP-42/43 (medir o passe, não o resultado).
"""
import pytest

from orchestrator.spec_dossier import (
    SpecFile,
    build_dossier,
    build_outline,
    parse_spec_blocks,
)

#: Árvore REAL de prod (`project_spec_files` do NVX LastMile na ordem `created_at ASC`, que é a ordem
#: em que `load_spec_all` concatena) com os tamanhos REAIS medidos em 2026-09-08.
NVX_TREE = [
    ("nvx-lastmile-backend.md", 51_009),
    ("modelo-dados.md", 218_840),
    ("visao-escopo.md", 61_544),
    ("contratos-erros.md", 82_639),
    ("privacidade-lgpd.md", 121_161),
    ("autenticacao-sessao.md", 80_877),
    ("definicao-de-pronto.md", 100_910),
    ("infraestrutura-deploy.md", 74_198),
    ("observabilidade-operacao.md", 89_339),
    ("api-entregas-entregadores.md", 73_770),
    ("connect-interoperabilidade.md", 71_225),
    ("README.md", 73_337),
]


def _nvx_files() -> list[SpecFile]:
    """Reconstrói a árvore com cabeçalhos plausíveis e o tamanho exato de prod."""
    out = []
    for name, size in NVX_TREE:
        head = f"# {name[:-3]}\n\n## 1. Escopo\n\ntexto\n\n## 2. Regras\n\n"
        body = head + "x" * max(0, size - len(head))
        out.append(SpecFile(label=name, content=body))
    return out


def _concat(files: list[SpecFile]) -> str:
    """Formato exato de `runner.load_spec_all` para specs multi-arquivo."""
    return "\n\n".join(f"---\n# [{sf.label}]\n\n{sf.content}" for sf in files)


# ── 1. ida e volta com o formato do runner ───────────────────────────────────


def test_desfaz_a_concatenacao_do_runner_sem_perder_arquivo():
    files = _nvx_files()
    parsed = parse_spec_blocks(_concat(files))
    assert [p.label for p in parsed] == [f.label for f in files]
    # Tolerância de 2 chars: o separador "\n\n" da junção fica no fim de cada bloco.
    for got, want in zip(parsed, files):
        assert abs(got.chars - want.chars) <= 2


def test_spec_de_arquivo_unico_tambem_vira_conjunto():
    # Sem este caminho, todo chamador precisaria de um `if spec_pequena` — e o `if` é onde os
    # GAPs moram (foi assim que o Estágio B foi pulado no GAP-13).
    parsed = parse_spec_blocks("# Spec\n\ntexto")
    assert len(parsed) == 1
    assert parsed[0].label == ""


def test_spec_vazia_nao_inventa_bloco():
    assert parse_spec_blocks("") == []


# ── 2. o MAPA: cabeçalhos verbatim de TODOS os arquivos ──────────────────────


def test_mapa_lista_todos_os_arquivos_e_os_cabecalhos_verbatim():
    text, mapped, cut = build_outline(_nvx_files())
    assert cut is False
    assert len(mapped) == 12
    for name, _size in NVX_TREE:
        assert name in text
    assert "## 1. Escopo" in text
    assert "## 2. Regras" in text


def test_mapa_da_arvore_de_prod_cabe_com_folga():
    # 12 arquivos de ~1,1 M chars rendem cabeçalhos na casa dos KB: o mapa é barato por natureza,
    # e é por isso que 100% de cobertura de MAPA é alcançável quando 100% de TEXTO não é.
    text, _mapped, cut = build_outline(_nvx_files())
    assert cut is False
    assert len(text) < 40_000


def test_mapa_cortado_derruba_a_cobertura_de_mapa_e_diz_quantos_faltam():
    # 🔴 A propriedade anti-fraude: se o número não pode CAIR, ele não mede nada.
    files = _nvx_files()
    text, mapped, cut = build_outline(files, cap=300)
    assert cut is True
    assert len(mapped) < 12
    assert "MAPA CORTADO" in text
    d = build_dossier(files, budget=5_000, outline_cap=300)
    assert d.map_coverage < 1.0


def test_mapa_corta_por_arquivo_inteiro_nunca_meio_indice():
    # Meio índice é pior que índice nenhum: o agente concluiria que a seção que falta não existe.
    files = _nvx_files()
    _text, mapped, _cut = build_outline(files, cap=400)
    for label in mapped:
        sf = next(f for f in files if f.label == label)
        heads = ["## 1. Escopo", "## 2. Regras"]
        chunk_ok = all(h in _text for h in heads) or sf.label not in mapped
        assert chunk_ok


# ── 3. 🔴 a regressão do NVX: 100% de MAPA com 10% de TEXTO ──────────────────


def test_regressao_nvx_arvore_de_prod_mapa_completo_texto_declarado():
    """O caso que abriu o GAP-54, com os números reais de prod."""
    files = _nvx_files()
    d = build_dossier(files, budget=143_800)

    # ANTES (`fit_spec_to_budget`): 2 de 12 arquivos, e o agente não sabia o que havia nos outros 10.
    assert d.map_coverage == 1.0, "o mapa tem de cobrir os 12 arquivos"
    assert len(d.mapped) == 12
    # DEPOIS: o texto continua limitado pelo orçamento — isto NÃO é mágica, é honestidade.
    assert 0.05 < d.text_coverage < 0.30
    # E o que ficou fora está NOMEADO, um por um.
    assert len(d.omitted) == 12 - len(d.included)
    for label in d.omitted:
        assert label in d.text
    assert "FORA DESTE DOSSIÊ (declarado, não omitido)" in d.text
    assert "não invente" in d.text


def test_arquivo_maior_que_o_orcamento_inteiro_nao_cancela_os_outros():
    # `modelo-dados.md` tem 218.840 chars — maior que o orçamento. Parar nele entregaria 1 de 12.
    files = _nvx_files()
    d = build_dossier(files, budget=143_800)
    assert "modelo-dados.md" in d.omitted
    assert len(d.included) >= 2
    assert d.partial == []


def test_spec_que_cabe_inteira_nao_declara_corte_nenhum():
    files = [SpecFile(label="a.md", content="# A\n\ntexto"), SpecFile(label="b.md", content="# B\n\ntexto")]
    d = build_dossier(files, budget=100_000)
    assert d.omitted == []
    assert d.partial == []
    assert d.text_coverage == 1.0
    assert "Nada: a spec inteira está neste dossiê." in d.text


# ── 4. o FOCO é do agente, e o dossiê obedece ────────────────────────────────


def test_foco_do_agente_traz_o_arquivo_que_o_orcamento_teria_descartado():
    """⚖️ LEI: relevância é decisão de LLM. O módulo só transporta a escolha dele.

    Sem foco, `modelo-dados.md` (218.840) nunca chega. Com o agente pedindo por ele, ele chega — e
    são os OUTROS que ficam declarados de fora. Isto é o que torna a Fábrica capaz de trabalhar num
    produto de 1,1 M chars sem ninguém decidir por ela o que importa.
    """
    files = _nvx_files()
    d = build_dossier(files, budget=250_000, focus=["modelo-dados.md"])
    assert "modelo-dados.md" in d.included
    assert d.omitted, "com foco no arquivo gigante, os outros têm de sair DECLARADOS"


def test_foco_em_rotulo_inexistente_nao_quebra_nem_silencia():
    files = _nvx_files()
    d = build_dossier(files, budget=143_800, focus=["nao-existe.md"])
    assert d.included, "foco inválido não pode zerar o dossiê"
    assert len(d.mapped) == 12


def test_ordem_de_apresentacao_e_a_da_bancada_mesmo_com_foco():
    # O agente escolhe O QUE lê; a sequência em que o produto foi escrito continua sendo a da spec.
    files = _nvx_files()
    d = build_dossier(files, budget=143_800, focus=["visao-escopo.md"])
    original = [f.label for f in files]
    assert d.included == [lbl for lbl in original if lbl in d.included]


# ── 5. o caso degenerado: NADA cabe ──────────────────────────────────────────


def test_quando_nenhum_arquivo_cabe_o_primeiro_entra_parcial_e_e_declarado():
    # Orçamento de 20.000 e o menor arquivo com 51.009: nada cabe íntegro, mas o recorte ainda
    # carrega contrato de sobra para valer a pena — aí o parcial é o último recurso legítimo.
    files = _nvx_files()
    d = build_dossier(files, budget=20_000, outline_cap=200)
    assert d.partial, "corte no meio existe, mas só como último recurso"
    assert "veio CORTADO" in d.text


def test_fragmento_minusculo_e_recusado_em_favor_do_mapa_honesto():
    # 🔴 Um fragmento de algumas centenas de chars entre INÍCIO/FIM parece um arquivo e não é: o
    # agente leria o começo de um documento e concluiria sobre o resto.
    d = build_dossier(_nvx_files(), budget=2_000, outline_cap=200)
    assert d.partial == []
    assert d.included == []
    assert "APENAS o mapa" in d.text


def test_lista_vazia_nao_inventa_dossie():
    d = build_dossier([], budget=143_800)
    assert d.text == ""
    assert d.total == 0
    assert d.text_coverage == 1.0


@pytest.mark.parametrize("budget", [3_000, 5_000, 50_000, 143_800, 400_000, 2_000_000])
def test_o_dossie_nunca_estoura_o_orcamento_pedido(budget):
    # 🔴 Um dossiê que estoura o orçamento é recortado DEPOIS pelo `_clip` do runtime — e aí o corte
    # volta a ser cego e silencioso, que é exatamente o defeito que este módulo existe para matar.
    # Por isso a asserção é ESTRITA: nenhuma folga, em nenhum orçamento.
    d = build_dossier(_nvx_files(), budget=budget)
    assert len(d.text) <= budget, f"{len(d.text)} > {budget}"


def test_orcamento_minusculo_entrega_so_o_mapa_e_diz_que_e_so_o_mapa():
    # Um agente que recebe só o índice e não é avisado disso conclui sobre texto que não leu.
    d = build_dossier(_nvx_files(), budget=3_000)
    assert d.text_coverage < 0.01
    assert "APENAS o mapa" in d.text
