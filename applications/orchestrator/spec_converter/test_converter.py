"""Testes unitários do conversor de spec para Markdown."""
import tempfile
from pathlib import Path

import pytest

from orchestrator.spec_converter import convert_to_markdown


def test_convert_md_returns_content_unchanged():
    with tempfile.NamedTemporaryFile(suffix=".md", delete=False) as f:
        f.write("# Título\n\nParágrafo.\n".encode("utf-8"))
        path = Path(f.name)
    try:
        out = convert_to_markdown(path)
        assert "# Título" in out
        assert "Parágrafo." in out
    finally:
        path.unlink(missing_ok=True)


def test_convert_txt_to_markdown():
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
        f.write(
            "# Objetivo\n\nFazer um sistema.\n\n- Item 1\n- Item 2\n".encode("utf-8")
        )
        path = Path(f.name)
    try:
        out = convert_to_markdown(path)
        assert "Objetivo" in out or "#" in out
        assert "sistema" in out
        assert "Item 1" in out
    finally:
        path.unlink(missing_ok=True)


def test_convert_txt_writes_output_path():
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
        f.write("Hello world\n".encode("utf-8"))
        in_path = Path(f.name)
    out_path = Path(tempfile.mkdtemp()) / "out.md"
    try:
        convert_to_markdown(in_path, output_path=out_path)
        assert out_path.exists()
        assert "Hello" in out_path.read_text(encoding="utf-8")
    finally:
        in_path.unlink(missing_ok=True)
        if out_path.exists():
            out_path.unlink()
        out_path.parent.rmdir()


def test_convert_unsupported_extension_raises():
    with tempfile.NamedTemporaryFile(suffix=".xyz", delete=False) as f:
        f.write(b"x")
        path = Path(f.name)
    try:
        with pytest.raises(ValueError, match="não suportado"):
            convert_to_markdown(path)
    finally:
        path.unlink(missing_ok=True)


def test_convert_missing_file_raises():
    with pytest.raises(FileNotFoundError, match="não encontrado"):
        convert_to_markdown(Path("/nonexistent/spec.xyz"))
