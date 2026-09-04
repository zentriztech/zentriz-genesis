"""Bloco 4 M8 (Fase 1) — aplicador puro-Python do formato `edits` (search/replace) do Dev.

Semântica adotada do text editor tool da Anthropic (`str_replace`): o `search` deve casar EXATA e
UNICAMENTE no arquivo original. 0 ou >1 ocorrências → erro (com o motivo e um trecho do arquivo real,
para o repair). Um segundo passo TOLERANTE cobre apenas diferenças de fim de linha (CRLF↔LF) e de
espaço em branco à DIREITA de cada linha — nunca reordena nem reindenta (a flexibilidade do Aider vale
para `udiff`, não para search/replace exato). A aplicação é ATÔMICA (todos os edits ou nenhum) e o EOL
do arquivo é preservado. `replace` vazio = remoção do trecho.

O runner (que tem o arquivo em disco) é o único que chama isto; o resultado vira `content` completo,
de forma que gate de escopo, `_exported_symbols`, QA e `write_apps_artifact` seguem vendo o arquivo
inteiro — zero mudança neles.
"""
from __future__ import annotations

import re

_MAX_SNIPPET = 600


def _detect_eol(text: str) -> str:
    """EOL predominante do arquivo original (para reconstruir o `replace`)."""
    return "\r\n" if "\r\n" in text else "\n"


def _to_lf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _tolerant_pattern(search_lf: str) -> str:
    """Regex que casa `search` tolerando CRLF e espaço em branco à direita de cada linha.

    Nunca toca indentação (espaço à esquerda é escapado literalmente). Quebra de linha casa `\\r?\\n`.
    """
    lines = search_lf.split("\n")
    parts = [re.escape(line.rstrip()) + r"[ \t]*" for line in lines]
    return r"\r?\n".join(parts)


def _snippet(text: str) -> str:
    s = text[:_MAX_SNIPPET]
    if len(text) > _MAX_SNIPPET:
        s += "…(truncado)"
    return s


def apply_edits(original: str, edits) -> tuple[str | None, list[str]]:
    """Aplica uma lista de edits `{search, replace}` a `original`.

    Retorna `(result, [])` em sucesso ou `(None, [erros])` em falha (atômico: nada é aplicado se
    qualquer edit falhar). Preserva o EOL do arquivo original e tolera CRLF/espaço-à-direita no match.
    """
    errors: list[str] = []
    if original is None or not isinstance(original, str):
        return None, ["conteúdo original ausente ou não textual (arquivo novo exige `content` completo)"]
    if not isinstance(edits, list) or len(edits) < 1:
        return None, ["`edits` deve ser uma lista não vazia"]

    eol = _detect_eol(original)
    result = original
    for idx, edit in enumerate(edits):
        if not isinstance(edit, dict):
            errors.append(f"edit #{idx}: deve ser objeto {{search, replace}}")
            return None, errors
        search = edit.get("search")
        replace = edit.get("replace", "")
        if not isinstance(search, str) or search == "":
            errors.append(f"edit #{idx}: campo `search` obrigatório e não vazio")
            return None, errors
        if replace is None:
            replace = ""
        if not isinstance(replace, str):
            replace = str(replace)
        # `replace` reconstruído com o EOL do arquivo (o LLM manda \n no JSON).
        replace_eol = _to_lf(replace).replace("\n", eol) if eol == "\r\n" else _to_lf(replace)

        # 1) Casamento EXATO (str_replace canônico).
        count = result.count(search)
        if count == 1:
            result = result.replace(search, replace_eol, 1)
            continue
        if count > 1:
            errors.append(
                f"edit #{idx}: `search` casou {count} vezes (ambíguo). Inclua mais linhas de contexto "
                f"(3+) para torná-lo único. Trecho buscado: {_snippet(search)!r}"
            )
            return None, errors

        # 2) Passo TOLERANTE (só CRLF e espaço à direita).
        pattern = _tolerant_pattern(_to_lf(search))
        matches = list(re.finditer(pattern, result))
        if len(matches) == 1:
            m = matches[0]
            result = result[: m.start()] + replace_eol + result[m.end():]
            continue
        if len(matches) > 1:
            errors.append(
                f"edit #{idx}: `search` casou {len(matches)} vezes (ambíguo, mesmo tolerando espaços). "
                f"Inclua mais contexto. Trecho buscado: {_snippet(search)!r}"
            )
            return None, errors

        # 0 ocorrências → erro com trecho do arquivo real, para o repair.
        errors.append(
            f"edit #{idx}: `search` NÃO encontrado no arquivo. Copie o trecho exato (incluindo indentação). "
            f"Trecho buscado: {_snippet(search)!r}. Início do arquivo atual: {_snippet(result)!r}"
        )
        return None, errors

    return result, []
