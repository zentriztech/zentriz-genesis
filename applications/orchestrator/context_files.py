"""Montagem segura de contexto de LLM a partir de pastas de projeto (achado N-1 da execução real 4.5b).

Defeito corrigido: o contexto do Dev varria `apps/` com `rglob("*")` SEM podar diretórios de dependências;
com `node_modules` presente (baseline/install) o contexto virou milhares de arquivos e o Guard estimou
US$ 26,16, negou e pausou a linhagem. Este módulo é o ponto ÚNICO de varredura para contexto de LLM:

- poda `node_modules`, `.next`, `dist`, `build`, `.venv`, `__pycache__`, `coverage` etc. ANTES de descer
  (os.walk com poda in-place — nunca lista o conteúdo de node_modules);
- ignora lockfiles gerados (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `*.lock`) e binários;
- aplica TETO defensivo do total coletado: estourou ⇒ `ContextTooLargeError` com mensagem acionável
  (falhar alto), nunca devolver um contexto absurdo que o Guard só barra depois de estimar o custo.

Env: `CONTEXT_MAX_FILE_BYTES` (50000), `CONTEXT_MAX_TOTAL_BYTES` (1500000), `CONTEXT_MAX_FILES` (3000).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

CONTEXT_SKIP_DIRS = frozenset({
    "node_modules", ".next", ".nuxt", ".git", "dist", "build", "out", ".turbo", ".cache", ".parcel-cache",
    ".vercel", ".output", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "coverage", ".nyc_output", "target", ".gradle", ".idea", ".pnpm-store", ".yarn",
})
CONTEXT_SKIP_FILES = frozenset({
    "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "npm-shrinkwrap.json", "bun.lockb", ".DS_Store",
})
CONTEXT_SKIP_SUFFIXES = (".lock", ".lockb", ".map", ".min.js", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
                         ".pdf", ".zip", ".gz", ".tgz", ".woff", ".woff2", ".ttf", ".eot", ".pyc")


class ContextTooLargeError(RuntimeError):
    """O contexto coletado excede o teto defensivo — falha alta e clara, antes de qualquer chamada paga."""


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "") or default))
    except ValueError:
        return default


def is_context_excluded(rel_parts: tuple[str, ...] | list[str], name: str | None = None) -> bool:
    """True se algum segmento do caminho é diretório de dependência/artefato, ou o arquivo é lock/binário."""
    parts = list(rel_parts)
    leaf = name if name is not None else (parts[-1] if parts else "")
    dirs = parts[:-1] if name is None else parts
    if any(d in CONTEXT_SKIP_DIRS for d in dirs):
        return True
    return leaf in CONTEXT_SKIP_FILES or leaf.lower().endswith(CONTEXT_SKIP_SUFFIXES)


def iter_context_files(root: Path) -> Iterator[Path]:
    """Arquivos regulares sob `root`, em ordem determinística, podando diretórios excluídos antes de descer."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in CONTEXT_SKIP_DIRS)
        for fn in sorted(filenames):
            if fn in CONTEXT_SKIP_FILES or fn.lower().endswith(CONTEXT_SKIP_SUFFIXES):
                continue
            p = Path(dirpath) / fn
            if p.is_symlink():
                continue
            yield p


def collect_context_artifacts(root: Path, rel_to: Path, *, max_file_bytes: int | None = None,
                              max_total_bytes: int | None = None, max_files: int | None = None) -> list[dict]:
    """Lê arquivos de texto de `root` como `[{path, content}]` (path relativo a `rel_to`).

    Arquivos > `max_file_bytes` são pulados (comportamento histórico). Se o total lido passar de
    `max_total_bytes` ou o número de arquivos de `max_files`, levanta `ContextTooLargeError`.
    """
    max_file = max_file_bytes or _int_env("CONTEXT_MAX_FILE_BYTES", 50_000)
    max_total = max_total_bytes or _int_env("CONTEXT_MAX_TOTAL_BYTES", 1_500_000)
    max_n = max_files or _int_env("CONTEXT_MAX_FILES", 3000)
    out: list[dict] = []
    total = 0
    for f in iter_context_files(root):
        try:
            size = f.stat().st_size
        except OSError:
            continue
        if size >= max_file:
            continue
        total += size
        if total > max_total or len(out) + 1 > max_n:
            raise ContextTooLargeError(
                f"contexto de LLM de '{root}' excede o teto defensivo "
                f"({total} bytes/{len(out) + 1} arquivos > {max_total} bytes/{max_n} arquivos). "
                "Provável artefato de build/dependência fora das exclusões (node_modules, dist, .venv…) ou "
                "projeto grande demais para enviar inteiro: reduza o escopo, remova os artefatos gerados ou "
                "ajuste CONTEXT_MAX_TOTAL_BYTES/CONTEXT_MAX_FILES conscientemente."
            )
        out.append({"path": str(f.relative_to(rel_to)), "content": f.read_text(encoding="utf-8", errors="replace")})
    return out


def rglob_filtered(root: Path, pattern: str) -> list[Path]:
    """`root.rglob(pattern)` sem entrar em diretórios excluídos (substituto direto para contexto de LLM)."""
    import fnmatch
    return [p for p in iter_context_files(root) if fnmatch.fnmatch(p.name, pattern)] if "/" not in pattern else \
        [p for p in root.rglob(pattern) if not is_context_excluded(p.relative_to(root).parts)]
