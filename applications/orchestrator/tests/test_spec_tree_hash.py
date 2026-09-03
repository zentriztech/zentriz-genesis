"""test_spec_tree_hash.py — RFC-0004 T1.2: PARIDADE do hash canônico (lado Python).

Os digests esperados são os MESMOS do teste TS (src/lib/specTreeHash.test.ts) — fonte
de verdade compartilhada. Mudou a fórmula num lado → os dois testes quebram juntos.
"""
import pytest

from spec_tree_hash import (
    SPEC_TREE_MAX_FILES,
    compute_spec_tree_hash,
    hash_spec_tree_from_files,
)

EXPECTED = {
    "f1_raiz_unica": (
        [("", "spec.md", "# Hello\n".encode())],
        "a6ac8c2092ebe76d7e2cb68a891a0877a90ac198c4960a508a820ee785d1e0d2",
    ),
    "f2_subpasta": (
        [("backend", "01-api.md", "API spec\n".encode()), ("", "README.md", "root\n".encode())],
        "699041ac8417c61e4428adf37390376effc68be9f6b8f89d3d6e633de0542f6b",
    ),
    "f3_readme_duplicado": (
        [("backend", "README.md", "b\n".encode()), ("web", "README.md", "w\n".encode()), ("", "README.md", "r\n".encode())],
        "f4e71a35c16d28b358c08a0b7d19737e8a48d33ae3d7348b4146b7730597f914",
    ),
    "f4_unicode": (
        [("", "especificação.md", "conteúdo com acentuação ção\n".encode()), ("módulo", "ação.md", "ê\n".encode())],
        "b52202a8c2d572b4ef5502c2d5b19d921ed02dfaabf1791d7dd0b29f7044d11b",
    ),
    "f5_vazio": (
        [("", "empty.md", b""), ("", "a.md", b"x")],
        "2bf26cbafc6282dcdbf25ca8dc6bb285b910c9c20a5e87cb64900a2b468373df",
    ),
    "f8_astral": (
        # F4: emoji (astral) × BMP alto — pega divergência UTF-16 code-unit × codepoint.
        [("", "\U0001F600-spec.md", b"astral"), ("", "�-spec.md", b"bmp-alto"), ("", "a.md", b"x")],
        "9ff35509c3f9ec8e1a8bbd6ee50077182669af4ee1c13c2d1e0f43904e499a0d",
    ),
    "f6_case_sort": (
        # Z.md < a.md em codepoint — pega regressão para sort locale-aware.
        [("", "Z.md", "z\n".encode()), ("", "a.md", "a\n".encode()), ("", "README.md", "r\n".encode())],
        "e10f5bd01ff8227557994d083cf5a2d55d49743ad446f33a2206646a7f6001a6",
    ),
}


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_fixture_digest(name):
    files, expected = EXPECTED[name]
    assert hash_spec_tree_from_files(files) == expected


def test_input_order_does_not_matter():
    files, expected = EXPECTED["f3_readme_duplicado"]
    assert hash_spec_tree_from_files(list(reversed(files))) == expected


def test_moving_file_between_dirs_changes_hash():
    a = hash_spec_tree_from_files([("a", "x.md", b"same")])
    b = hash_spec_tree_from_files([("b", "x.md", b"same")])
    assert a == "18da37379c86476152bfad760a5256f235269e83219bdfecd5c891d1d69a60a2"
    assert b == "3b007f24d027c76f779d9e5242cf9a5cf2b1406ad9d63058e43df882aaf074ef"
    assert a != b


def test_moving_line_between_files_changes_hash():
    v1 = hash_spec_tree_from_files([("", "a.md", b"l1\nl2"), ("", "b.md", b"l3")])
    v2 = hash_spec_tree_from_files([("", "a.md", b"l1"), ("", "b.md", b"l2\nl3")])
    assert v1 != v2


def test_file_count_cap():
    entries = [("", f"f{i}.md", "0" * 64) for i in range(SPEC_TREE_MAX_FILES + 1)]
    with pytest.raises(ValueError):
        compute_spec_tree_hash(entries)
