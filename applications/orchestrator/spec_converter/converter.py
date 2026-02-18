"""
Converte arquivos de spec (.txt, .doc, .docx, .pdf) em Markdown.
Seguindo boas práticas: títulos hierárquicos, listas, parágrafos, blocos de código.
"""

import logging
from pathlib import Path
from typing import Union

logger = logging.getLogger(__name__)


def _txt_to_markdown(content: str) -> str:
    """Converte texto plano em Markdown: parágrafos, linhas que parecem títulos (#), listas."""
    lines = content.splitlines()
    out: list[str] = []
    in_paragraph = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if in_paragraph:
                out.append("")
            in_paragraph = False
            continue
        if stripped.startswith("#") and len(stripped) > 1 and stripped[1] in (" ", "#"):
            if in_paragraph:
                out.append("")
            out.append(stripped)
            in_paragraph = False
        elif stripped.startswith("- ") or stripped.startswith("* "):
            if in_paragraph:
                out.append("")
            out.append(stripped)
            in_paragraph = False
        elif any(stripped.startswith(f"{i}. ") for i in range(1, 10)):
            if in_paragraph:
                out.append("")
            out.append(stripped)
            in_paragraph = False
        else:
            out.append(stripped)
            in_paragraph = True
    return "\n".join(out).strip() + "\n"


def _convert_txt(path: Path) -> str:
    return _txt_to_markdown(path.read_text(encoding="utf-8", errors="replace"))


def _convert_docx(path: Path) -> str:
    try:
        from docx import Document
    except ImportError:
        logger.warning("python-docx não instalado; retornando conteúdo bruto")
        return path.read_bytes().decode("utf-8", errors="replace")

    doc = Document(path)
    parts: list[str] = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            parts.append("")
            continue
        style = (para.style and para.style.name or "").lower()
        if "heading 1" in style or "title" in style:
            parts.append(f"# {text}")
        elif "heading 2" in style:
            parts.append(f"## {text}")
        elif "heading 3" in style:
            parts.append(f"### {text}")
        else:
            parts.append(text)
    return _txt_to_markdown("\n".join(parts))


def _convert_pdf(path: Path) -> str:
    try:
        import pymupdf
    except ImportError:
        logger.warning("PyMuPDF não instalado; retornando placeholder")
        return f"* Conteúdo PDF não convertido (instale pymupdf): {path.name}\n"

    doc = pymupdf.open(path)
    parts: list[str] = []
    for page in doc:
        parts.append(page.get_text())
    doc.close()
    return _txt_to_markdown("\n\n".join(parts))


def convert_to_markdown(
    input_path: Union[str, Path],
    *,
    output_path: Union[str, Path, None] = None,
) -> str:
    """
    Converte um arquivo de spec para Markdown.
    Aceita .txt, .doc, .docx, .pdf.
    Retorna o conteúdo Markdown; se output_path for informado, também grava o arquivo.
    """
    path = Path(input_path)
    if not path.exists():
        raise FileNotFoundError(f"Arquivo não encontrado: {path}")

    ext = path.suffix.lower()
    if ext == ".txt":
        md = _convert_txt(path)
    elif ext in (".doc", ".docx"):
        md = _convert_docx(path)
    elif ext == ".pdf":
        md = _convert_pdf(path)
    elif ext == ".md":
        md = path.read_text(encoding="utf-8", errors="replace")
    else:
        raise ValueError(f"Formato não suportado: {ext}. Use .md, .txt, .doc, .docx, .pdf.")

    if output_path:
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(md, encoding="utf-8")
        logger.info("Markdown escrito em %s", out)

    return md
