"""spec_tree_hash.py — RFC-0004 (F1/F4): hash canônico da ÁRVORE de spec (espelho Python).

A fonte de verdade da fórmula é applications/services/api-node/src/lib/specTreeHash.ts —
os dois lados têm teste de paridade com os MESMOS fixtures (specTreeHash.test.ts /
tests/test_spec_tree_hash.py). Qualquer mudança AQUI deve mudar LÁ junto.

Fórmula (estilo git-tree, determinística byte a byte):
    linha  = rel_dir + "\\0" + filename + "\\0" + sha256hex(bytes do arquivo) + "\\n"
    linhas ordenadas por comparação BINÁRIA (codepoint)
    spec_hash = sha256hex(concat(linhas))

Substitui a fórmula legada (concat de conteúdos ordenados por filename via localeCompare,
join "\\n") que divergia entre API e runner e mentia ao mover arquivo entre pastas.
"""
from __future__ import annotations

import hashlib

SPEC_TREE_MAX_FILES = 200
SPEC_TREE_MAX_FILE_BYTES = 256 * 1024
SPEC_TREE_MAX_TOTAL_BYTES = 2 * 1024 * 1024


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compute_spec_tree_hash(entries: list[tuple[str, str, str]]) -> str:
    """entries: lista de (rel_dir, filename, content_sha256_hex).

    Levanta ValueError acima do teto de arquivos (paridade com SpecTreeLimitError do TS).
    """
    if len(entries) > SPEC_TREE_MAX_FILES:
        raise ValueError(f"spec excede {SPEC_TREE_MAX_FILES} arquivos ({len(entries)})")
    # F4: sort por BYTES UTF-8 (== ordem de codepoint) — explícito para paridade com o TS,
    # que usa Buffer.compare (o `<` de str do JS compara UTF-16 e diverge no plano astral).
    lines = sorted(
        (f"{rel_dir}\0{filename}\0{sha}\n" for rel_dir, filename, sha in entries),
        key=lambda line: line.encode("utf-8"),
    )
    return sha256_hex("".join(lines).encode("utf-8"))


def hash_spec_tree_from_files(files: list[tuple[str, str, bytes]]) -> str:
    """files: lista de (rel_dir, filename, bytes). Aplica os tetos de tamanho."""
    total = 0
    entries: list[tuple[str, str, str]] = []
    for rel_dir, filename, data in files:
        if len(data) > SPEC_TREE_MAX_FILE_BYTES:
            raise ValueError(f"arquivo {filename} excede {SPEC_TREE_MAX_FILE_BYTES} bytes")
        total += len(data)
        entries.append((rel_dir, filename, sha256_hex(data)))
    if total > SPEC_TREE_MAX_TOTAL_BYTES:
        raise ValueError(f"spec agregada excede {SPEC_TREE_MAX_TOTAL_BYTES} bytes")
    return compute_spec_tree_hash(entries)
