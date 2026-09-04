"""Bloco 4 M8 — aplicador `edits` (search/replace, semântica str_replace) em Python puro."""
from __future__ import annotations

from orchestrator.edits import apply_edits


def test_match_unico_aplica():
    original = "linha 1\nfunc alvo()\nlinha 3\n"
    out, errs = apply_edits(original, [{"search": "func alvo()", "replace": "func novo()"}])
    assert errs == []
    assert out == "linha 1\nfunc novo()\nlinha 3\n"


def test_zero_matches_erro_com_trecho():
    original = "abc\ndef\n"
    out, errs = apply_edits(original, [{"search": "inexistente XYZ", "replace": "x"}])
    assert out is None
    assert len(errs) == 1
    assert "NÃO encontrado" in errs[0]
    assert "inexistente XYZ" in errs[0]  # trecho buscado no erro (para o repair)


def test_dois_matches_erro_ambiguo():
    original = "dup\noutra\ndup\n"
    out, errs = apply_edits(original, [{"search": "dup", "replace": "x"}])
    assert out is None
    assert "ambíguo" in errs[0] or "casou 2" in errs[0]


def test_atomicidade_segundo_edit_falha_original_intacto():
    original = "a = 1\nb = 2\n"
    edits = [
        {"search": "a = 1", "replace": "a = 99"},   # casaria
        {"search": "NAO_EXISTE", "replace": "z"},   # falha → aborta tudo
    ]
    out, errs = apply_edits(original, edits)
    assert out is None
    assert errs  # o resultado NÃO é aplicado; quem chama mantém o original
    # (a atomicidade é do retorno: out=None → o runner não grava nada)


def test_crlf_preservado():
    original = "linha 1\r\nalvo\r\nlinha 3\r\n"
    out, errs = apply_edits(original, [{"search": "alvo", "replace": "novo"}])
    assert errs == []
    assert out == "linha 1\r\nnovo\r\nlinha 3\r\n"  # EOL do arquivo mantido
    # o `replace` multi-linha também herda o CRLF do arquivo:
    out2, errs2 = apply_edits(original, [{"search": "alvo", "replace": "x\ny"}])
    assert errs2 == []
    assert out2 == "linha 1\r\nx\r\ny\r\nlinha 3\r\n"


def test_espaco_a_direita_tolerado():
    # Arquivo tem espaço à direita; o `search` do LLM veio sem — deve casar mesmo assim.
    original = "def foo():   \n    return 1\n"
    out, errs = apply_edits(original, [{"search": "def foo():\n    return 1", "replace": "def foo():\n    return 2"}])
    assert errs == []
    assert "return 2" in out


def test_crlf_no_search_casa_arquivo_lf():
    original = "a\nb\nc\n"
    out, errs = apply_edits(original, [{"search": "a\r\nb", "replace": "X\nY"}])
    assert errs == []
    assert out == "X\nY\nc\n"


def test_replace_vazio_remove():
    original = "manter\nremover esta\nmanter2\n"
    out, errs = apply_edits(original, [{"search": "remover esta\n", "replace": ""}])
    assert errs == []
    assert out == "manter\nmanter2\n"


def test_edits_vazio_ou_search_vazio_erro():
    assert apply_edits("x", [])[0] is None
    out, errs = apply_edits("x", [{"search": "", "replace": "y"}])
    assert out is None and "search" in errs[0]


def test_arquivo_inexistente_exige_content():
    out, errs = apply_edits(None, [{"search": "a", "replace": "b"}])
    assert out is None
    assert "novo" in errs[0] or "original" in errs[0]


def test_multiplos_edits_em_ordem():
    original = "1\n2\n3\n"
    out, errs = apply_edits(original, [
        {"search": "1", "replace": "um"},
        {"search": "3", "replace": "tres"},
    ])
    assert errs == []
    assert out == "um\n2\ntres\n"
