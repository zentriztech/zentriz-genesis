"""
Fallback: extrai os 3 artefatos do Engineer a partir da resposta bruta (raw_response_*.txt).

Usado apenas quando o JSON da resposta veio incompleto ou com 1 artifact. O contrato
com a IA exige saída somente <thinking> curto + <response> JSON; quando a IA cumpre,
não é necessário este extrator. Quando não cumpre, o raw pode conter os 3 docs em
blocos no <thinking>; aqui extraímos e gravamos em disco.

Detecção de fim: marcadores variáveis (início de meta-comentário da IA) têm prioridade;
sentinel de texto fixo é opcional, para não depender de uma frase específica no doc.
"""
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

ARTIFACT_NAMES = [
    "engineer_proposal.md",
    "engineer_architecture.md",
    "engineer_dependencies.md",
]

# Prefixos de linha que indicam início de meta/thinking da IA (não fazem parte do .md)
_THINKING_LINE_PREFIXES = re.compile(
    r"^(Now I |Let me |The key challenge|Actually,? |I need to |I'll |So the |OK I think |Let me (?:trace|reconsider)|Scanning for |So we need )",
    re.IGNORECASE | re.MULTILINE,
)


def _trim_engineer_dependencies_content(content: str) -> str:
    """
    Trunca engineer_dependencies.md no fim do conteúdo útil.
    1) Se existir linha que comece com marcador variável de meta (ex.: "Now I need to..."), corta antes dela.
    2) Senão, se existir sentinel de fim de parágrafo (TBD/placeholders), corta no fim desse parágrafo.
    """
    best_end = len(content)
    # 1) Marcadores variáveis: primeira linha que parece início de thinking
    for m in _THINKING_LINE_PREFIXES.finditer(content):
        pos = m.start()
        line_start = content.rfind("\n", 0, pos) + 1
        if line_start > 100:
            best_end = min(best_end, line_start)
            break
    # 2) Sentinel opcional (fim natural do parágrafo TBD/placeholders)
    sentinel = "placeholders configuráveis em `src/data/content.ts`."
    idx = content.find(sentinel)
    if idx != -1:
        end = idx + len(sentinel)
        if end < len(content) and content[end] == ".":
            end += 1
        rest = content[end:]
        nl = rest.find("\n")
        if nl != -1:
            end = end + nl + 1
        best_end = min(best_end, end)
    return content[:best_end].rstrip()


def extract_engineer_artifacts_from_raw(raw_text: str) -> list[dict]:
    """
    Extrai os 3 blocos markdown do raw (resposta bruta do Engineer).
    Retorna lista de dicts com "path" e "content" (path = docs/engineer/<name>).
    """
    if not raw_text or not raw_text.strip():
        return []

    results = []
    for name in ARTIFACT_NAMES:
        # Cabeçalho de seção: **engineer_XXX.md content:** (evita "**engineer_XXX.md** - Clean..." mais adiante)
        marker = "**%s content:**" % name
        start = raw_text.find(marker)
        if start == -1:
            continue
        start = start + len(marker)  # após o marcador
        # Início do bloco: próximo ``` após o cabeçalho
        code_start = raw_text.find("```", start)
        if code_start == -1:
            continue
        # Conteúdo começa após ``` e eventual linha de linguagem (ex.: ```\n ou ```markdown\n)
        line_end = raw_text.find("\n", code_start + 3)
        if line_end == -1:
            content_start = code_start + 3
        else:
            content_start = line_end + 1
        # Fim do bloco: próxima seção "**engineer_XXX.md content:**" ou <response>
        end_pos = len(raw_text)
        for other in ARTIFACT_NAMES:
            if other == name:
                continue
            pos = raw_text.find("**%s content:**" % other, content_start)
            if pos != -1 and pos < end_pos:
                end_pos = pos
        response_tag = raw_text.find("<response>", content_start)
        if response_tag != -1 and response_tag < end_pos:
            end_pos = response_tag
        content = raw_text[content_start:end_pos].rstrip()
        # Remover fechamento de code block se ficou no final
        if content.endswith("```"):
            content = content[:-3].rstrip()

        content = content.strip()
        if len(content) < 50:
            continue
        if name == "engineer_dependencies.md":
            content = _trim_engineer_dependencies_content(content)
        results.append({
            "path": f"docs/engineer/{name}",
            "content": content,
            "format": "markdown",
        })
        logger.info("[EngineerRawExtract] Extraído %s (%d chars)", name, len(content))

    return results


def persist_engineer_artifacts_from_raw(
    project_id: str,
    request_id: str,
    raw_text: str,
) -> int:
    """
    Extrai os 3 artefatos do raw e grava em project_id/docs/engineer/.
    Retorna o número de arquivos gravados (0 a 3).
    """
    try:
        from orchestrator import project_storage as storage
    except ImportError:
        logger.warning("[EngineerRawExtract] project_storage não disponível")
        return 0

    if not getattr(storage, "is_enabled", lambda: False)():
        return 0

    artifacts = extract_engineer_artifacts_from_raw(raw_text)
    try:
        from orchestrator.envelope import _unescape_json_string
    except ImportError:
        _unescape_json_string = lambda s: s
    written = 0
    for art in artifacts:
        path_val = (art.get("path") or "").strip()
        content = art.get("content", "")
        if not path_val or not content or not path_val.startswith("docs/"):
            continue
        content = _unescape_json_string(content)
        rel = path_val[5:].lstrip("/")  # docs/engineer/XXX.md -> engineer/XXX.md
        try:
            storage.write_doc_by_path(
                project_id, "engineer", rel, content,
                title=Path(path_val).stem,
            )
            written += 1
        except Exception as e:
            logger.warning("[EngineerRawExtract] Falha ao gravar %s: %s", path_val, e)
    return written
