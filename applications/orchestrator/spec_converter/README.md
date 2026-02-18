# Spec Converter

Converte arquivos de spec (.txt, .doc, .docx, .pdf) em Markdown para consumo pelo agente CTO.

- **Referência**: [docs/SPEC_SUBMISSION_AND_FORMATS.md](../../docs/SPEC_SUBMISSION_AND_FORMATS.md)
- **Uso**: `from orchestrator.spec_converter import convert_to_markdown`
- **Exemplo**: `convert_to_markdown("/path/to/file.pdf", output_path="/path/to/spec.md")`

Formato .md é preferencial; quando o usuário envia outros formatos, este módulo gera .md bem formatado (títulos, listas, parágrafos).
