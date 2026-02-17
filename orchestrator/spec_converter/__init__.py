"""
Conversor de specs para Markdown.
Transforma .txt, .doc/.docx e .pdf em .md bem formatado para consumo pelo CTO.
Ver docs/SPEC_SUBMISSION_AND_FORMATS.md.
"""

from .converter import convert_to_markdown

__all__ = ["convert_to_markdown"]
