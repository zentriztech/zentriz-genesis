"""
Validação e reparo de MessageEnvelope/ResponseEnvelope (Blueprint V2 REV2).
Path policy: artifact.path deve ser relativo com prefixo docs/ | project/ | apps/.
Bloqueio de path traversal (.., absolutos, ~).
"""
import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

VALID_STATUSES = frozenset({
    "OK", "FAIL", "BLOCKED", "NEEDS_INFO", "REVISION", "QA_PASS", "QA_FAIL",
})
ALLOWED_PATH_PREFIXES = ("docs/", "project/", "apps/")
TRAVERSAL_PATTERN = re.compile(r"\.\.|/\.\.|\.\./|^/|^~|\\\\")


def sanitize_artifact_path(path: str, project_id: str | None) -> str | None:
    """
    Valida e normaliza artifact.path.
    - path deve ser string não vazia.
    - Deve começar com docs/, project/ ou apps/ (sem path traversal).
    - Bloqueia .., caminhos absolutos, ~, backslashes.
    Retorna o path normalizado (com barras normais) ou None se bloqueado.
    """
    if not path or not isinstance(path, str):
        return None
    raw = path.strip().replace("\\", "/").lstrip("/")
    if not raw:
        return None
    if TRAVERSAL_PATTERN.search(path):
        logger.warning("[Envelope] Path bloqueado (traversal): %s", path)
        return None
    if not (raw.startswith("docs/") or raw.startswith("project/") or raw.startswith("apps/")):
        logger.warning("[Envelope] Path bloqueado (prefixo inválido): %s", path)
        return None
    # Normalizar: uma única barra entre segmentos, sem segmentos vazios
    parts = [p for p in raw.split("/") if p and p != "."]
    if not parts:
        return None
    normalized = "/".join(parts)
    if ".." in normalized:
        return None
    return normalized


def validate_response_envelope(
    data: dict,
    *,
    require_artifacts: bool = False,
    require_evidence_when_ok: bool = True,
) -> tuple[bool, list[str]]:
    """
    Valida ResponseEnvelope (schema mínimo + path policy).
    Retorna (ok, list_of_errors).
    """
    errors: list[str] = []
    if not isinstance(data, dict):
        return False, ["ResponseEnvelope deve ser um objeto JSON"]

    status = data.get("status")
    if status not in VALID_STATUSES:
        errors.append(f"status inválido: '{status}'. Deve ser um de: {sorted(VALID_STATUSES)}")

    if not isinstance(data.get("summary"), str):
        errors.append("summary obrigatório e deve ser string")

    artifacts = data.get("artifacts")
    if not isinstance(artifacts, list):
        errors.append("artifacts deve ser uma lista")
        artifacts = []
    elif require_artifacts and len(artifacts) < 1:
        errors.append("modo exige pelo menos um artefato (artifacts.length >= 1)")

    for i, art in enumerate(artifacts):
        if not isinstance(art, dict):
            errors.append(f"artifacts[{i}] deve ser objeto")
            continue
        path = art.get("path")
        if not path or not isinstance(path, str):
            errors.append(f"artifacts[{i}].path obrigatório e deve ser string")
        else:
            norm = sanitize_artifact_path(path, None)
            if norm is None:
                errors.append(f"artifacts[{i}].path inválido ou bloqueado: {path!r}")
        if "content" not in art and require_artifacts:
            errors.append(f"artifacts[{i}] deve ter 'content' quando geração é obrigatória")

    if status == "OK" and require_evidence_when_ok:
        evidence = data.get("evidence")
        if not evidence or not isinstance(evidence, list):
            errors.append("status=OK exige evidence não vazio (ou summary com evidência)")
        elif len(evidence) == 0 and not (data.get("summary") or "").strip():
            errors.append("status=OK exige evidence não vazio")

    if status == "NEEDS_INFO":
        next_actions = data.get("next_actions")
        if isinstance(next_actions, dict) and next_actions.get("questions"):
            pass  # ok
        elif not (isinstance(next_actions, dict) and next_actions.get("questions")):
            errors.append("status=NEEDS_INFO exige next_actions.questions não vazio")

    return len(errors) == 0, errors


def validate_response_quality(agent: str, response: dict) -> tuple[bool, list[str]]:
    """
    Valida qualidade mínima do output (AGENT_LLM_COMMUNICATION_ANALYSIS).
    Retorna (ok, list_of_errors). Usado pelo runtime/runner para retry com feedback.
    """
    errors: list[str] = []
    artifacts = response.get("artifacts") or []
    status = response.get("status") or ""

    for art in artifacts:
        if not isinstance(art, dict):
            continue
        content = art.get("content", "")
        path = art.get("path", "")
        if isinstance(content, str):
            if len(content) < 100 and status == "OK":
                errors.append(f"artifact {path!r} muito curto ({len(content)} chars)")
            if "..." in content or "[...]" in content:
                errors.append(f"artifact {path!r} contém reticências/abreviações")
            if "// TODO" in content or "// TODO " in content:
                errors.append(f"artifact {path!r} contém // TODO")

    if status == "OK" and not response.get("evidence"):
        summary = (response.get("summary") or "").strip()
        if len(summary) < 20:
            errors.append("status=OK sem evidence e summary muito curto")

    return len(errors) == 0, errors


def repair_prompt() -> str:
    """Prompt padrão de reparo quando a IA falha em JSON/gates (Blueprint §10)."""
    return (
        "Retorne **apenas** JSON válido no formato ResponseEnvelope. "
        "Não inclua texto fora do JSON. "
        "Em strings JSON use \\n para quebras de linha e \\\" para aspas; não deixe strings não terminadas. "
        "Preencha `status`, `artifacts[]` (com `path` e `content`), `evidence[]` e `next_actions`. "
        "`artifact.path` deve começar com `docs/` ou `project/` ou `apps/` (sempre relativo, sem path absoluto)."
    )


def extract_thinking(text: str) -> str:
    """Extrai o raciocínio do Claude de dentro de <thinking>...</thinking> (útil para debug/log). LEI 10 / doc §10."""
    if not text or not isinstance(text, str):
        return ""
    match = re.search(r"<thinking>\s*(.*?)\s*</thinking>", text, re.DOTALL)
    return match.group(1).strip() if match else ""


def extract_json_from_text(text: str) -> str | None:
    """
    Extrai bloco JSON de texto.
    Prioridade (AGENT_LLM_COMMUNICATION_ANALYSIS): <response>...</response> permite
    raciocínio em <thinking> e JSON final parseável; depois code blocks; depois raw.
    Se a resposta estiver truncada (sem </response>), extrai do <response> até o fim.
    """
    if not text or not isinstance(text, str):
        return None
    text = text.strip()
    # 1) Conteúdo dentro de <response>...</response> — usar última ocorrência de </response>
    #    para não truncar quando o JSON contém "</response>" no meio (ex.: em artifact content)
    start_tag = text.find("<response>")
    if start_tag >= 0:
        end_tag = text.rfind("</response>")
        if end_tag > start_tag:
            inner = text[start_tag + len("<response>"):end_tag].strip()
            # Preferir JSON direto quando já começa com { (evita truncar em conteúdo markdown com ```)
            if inner.startswith("{"):
                return inner
            if "```json" in inner:
                try:
                    return inner.split("```json")[1].split("```")[0].strip()
                except IndexError:
                    pass
            if "```" in inner:
                try:
                    return inner.split("```")[1].split("```")[0].strip()
                except IndexError:
                    pass
    # 1b) Resposta truncada: existe <response> mas não </response> — extrair do primeiro { até o fim
    start_tag = text.find("<response>")
    if start_tag >= 0:
        after = text[start_tag + len("<response>"):]
        brace = after.find("{")
        if brace >= 0:
            partial = after[brace:].strip()
            if partial:
                return partial
    # 2) Markdown code block ```json
    if "```json" in text:
        try:
            return text.split("```json")[1].split("```")[0].strip()
        except IndexError:
            pass
    if "```" in text:
        try:
            return text.split("```")[1].split("```")[0].strip()
        except IndexError:
            pass
    if text.startswith("{"):
        return text
    return None


def _unescape_json_string(s: str) -> str:
    r"""
    Decodifica escapes de string JSON (valor extraído do texto bruto).
    Converte \n -> newline, \r -> CR, \t -> tab, \" -> ", \\ -> \.
    Ordem: primeiro \\ para não interpretar \n como escape.
    """
    if not s:
        return s
    # Placeholder para \\ (dois chars no source) para não confundir com \n, \t, etc.
    s = s.replace("\\\\", "\x00")
    s = s.replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t").replace('\\"', '"')
    return s.replace("\x00", "\\")


def _extract_double_quoted(s: str, start: int) -> tuple[str | None, int]:
    """Extrai string entre aspas duplas a partir de start (start = índice do \" de abertura). Retorna (valor, posição após o \" de fecho) ou (None, start)."""
    if start >= len(s) or s[start] != '"':
        return None, start
    i = start + 1
    parts: list[str] = []
    while i < len(s):
        if s[i] == "\\":
            if i + 1 < len(s):
                parts.append(s[i : i + 2])
                i += 2
            else:
                return None, start
        elif s[i] == '"':
            return "".join(parts), i + 1
        else:
            parts.append(s[i])
            i += 1
    return None, start


def _extract_content_value_robust(s: str, value_quote_pos: int) -> tuple[str | None, int]:
    """
    Extrai o valor de "content" mesmo com aspas não escapadas no meio (LEI 4).
    A partir da aspa de abertura (value_quote_pos), avança até encontrar a aspa de FECHO:
    uma aspa seguida (após whitespace) de ',' ou '}' ou ']' ou de nova chave '"format"', '"purpose"', '"path"'.
    Trata \\ e \\" corretamente; aspas internas não escapadas são tratadas como conteúdo.
    Retorna (valor, posição após a aspa de fecho) ou (None, value_quote_pos).
    """
    if value_quote_pos >= len(s) or s[value_quote_pos] != '"':
        return None, value_quote_pos
    i = value_quote_pos + 1
    parts: list[str] = []
    while i < len(s):
        if s[i] == "\\":
            if i + 1 < len(s):
                parts.append(s[i : i + 2])
                i += 2
            else:
                return None, value_quote_pos
        elif s[i] == '"':
            # Verificar se é aspa de fecho: à frente (com whitespace) vem , } ] ou "format"/"purpose"/"path"
            j = i + 1
            while j < len(s) and s[j] in " \t\n\r":
                j += 1
            if j >= len(s):
                return "".join(parts), i + 1
            if s[j] in ",}]":
                return "".join(parts), i + 1
            if s[j] == '"':
                # Próxima chave: "format", "purpose", "path"
                rest = s[j : j + 20]
                if re.match(r'"(format|purpose|path|evidence)"\s*:', rest):
                    return "".join(parts), i + 1
            # Aspa interna (conteúdo), incluir e continuar
            parts.append(s[i])
            i += 1
        else:
            parts.append(s[i])
            i += 1
    # Resposta truncada: fim da string sem aspa de fecho — retornar conteúdo parcial
    if parts:
        return "".join(parts), len(s)
    return None, value_quote_pos


def resilient_json_parse(raw_text: str, request_id: str = "unknown") -> tuple[dict, list[str]]:
    """
    LEI 4 (AGENT_LLM_COMMUNICATION_ANALYSIS): parse JSON com fallbacks para escaping quebrado.
    Tentativa 1: parse direto (após extrair de <response>).
    Tentativa 2: extrair valores de "content" com _extract_double_quoted, substituir por placeholder, parsear, reinjetar.
    Tentativa 3: retorna envelope FAIL com mensagem de escaping.
    Retorna (envelope_dict, parse_errors); parse_errors vazio se sucesso.
    """
    json_str = extract_json_from_text(raw_text)
    if not json_str:
        json_str = raw_text.strip()
    if not json_str:
        return (
            {
                "request_id": request_id,
                "status": "FAIL",
                "summary": "Resposta sem JSON (ResponseEnvelope).",
                "artifacts": [],
                "evidence": [],
                "next_actions": {},
            },
            ["Resposta não contém JSON válido (ResponseEnvelope)."],
        )

    # Tentativa 1: parse direto
    try:
        data = json.loads(json_str)
        if isinstance(data, dict):
            return data, []
    except json.JSONDecodeError:
        pass

    # Tentativa 2: substituir "content": "..." por placeholders (conteúdo pode ter aspas não escapadas)
    try:
        content_blocks: list[str] = []
        replacements: list[tuple[int, int, str]] = []
        pattern = re.compile(r'"content"\s*:\s*"')
        i = 0
        while i < len(json_str):
            m = pattern.search(json_str, i)
            if not m:
                break
            value_quote = m.end() - 1
            # Usar extrator robusto para content com aspas internas (markdown, etc.)
            content_val, end_pos = _extract_content_value_robust(json_str, value_quote)
            if content_val is None:
                content_val, end_pos = _extract_double_quoted(json_str, value_quote)
            if content_val is None:
                i = value_quote + 1
                continue
            content_val = _unescape_json_string(content_val)
            idx = len(content_blocks)
            content_blocks.append(content_val)
            replacements.append((value_quote, end_pos, f'"@@PLACEHOLDER_{idx}@@"'))
            i = end_pos

        if not replacements:
            raise json.JSONDecodeError("no content blocks", "", 0)

        parts: list[str] = []
        last = 0
        for start, end, ph in replacements:
            parts.append(json_str[last:start])
            parts.append(ph)
            last = end
        parts.append(json_str[last:])
        cleaned = "".join(parts)
        # Resposta truncada: fechar JSON se o último replacement vai até o fim
        if replacements and replacements[-1][1] >= len(json_str):
            if not cleaned.rstrip().endswith("}"):
                cleaned = cleaned.rstrip()
                cleaned += "\n    }\n  ]\n}"
                logger.warning("Resposta IA truncada: JSON fechado para recuperar envelope e artifact parcial.")
        data = json.loads(cleaned)
        if not isinstance(data, dict):
            raise json.JSONDecodeError("not a dict", cleaned, 0)
        for art in data.get("artifacts") or []:
            if not isinstance(art, dict):
                continue
            content = art.get("content", "")
            if isinstance(content, str):
                m = re.match(r"^@@PLACEHOLDER_(\d+)@@$", content.strip())
                if m:
                    idx = int(m.group(1))
                    if 0 <= idx < len(content_blocks):
                        art["content"] = content_blocks[idx]
        return data, []
    except (json.JSONDecodeError, IndexError, KeyError):
        pass

    # Tentativa 3: se o JSON parece ser do Engineer (3 docs), extrair artifacts um a um do json_str
    if "docs/engineer/engineer_proposal.md" in json_str and "docs/engineer/engineer_architecture.md" in json_str and "docs/engineer/engineer_dependencies.md" in json_str:
        artifacts_engineer = _extract_engineer_artifacts_from_json_str(json_str)
        if len(artifacts_engineer) >= 3:
            logger.info("[Envelope] Recuperados %d artifacts do Engineer a partir do JSON (fallback).", len(artifacts_engineer))
            return (
                {
                    "request_id": request_id,
                    "status": "OK",
                    "summary": "Proposta técnica recuperada (parse parcial por escaping). 3 artefatos Engineer.",
                    "artifacts": artifacts_engineer[:3],
                    "evidence": [{"type": "spec_ref", "ref": "FR-01", "note": "Engineer artifacts extraídos do JSON"}],
                    "next_actions": {"owner": "CTO", "items": ["Validar proposta"], "questions": []},
                },
                [],
            )

    # Tentativa 4: fallback final
    logger.error("Falha total no parse JSON (LEI 4). Primeiros 500 chars: %s", json_str[:500])
    return (
        {
            "request_id": request_id,
            "status": "FAIL",
            "summary": "Resposta do Claude contém JSON inválido — provável problema de escaping.",
            "artifacts": [],
            "evidence": [],
            "next_actions": {"owner": "system", "items": ["Retry com instrução de escaping reforçada"]},
        },
        ["JSON inválido — provável problema de escaping em artifacts[].content"],
    )


def _extract_engineer_artifacts_from_json_str(json_str: str) -> list[dict]:
    """
    Extrai os 3 artifacts do Engineer (proposal, architecture, dependencies) do texto JSON
    quando o parse completo falha. Localiza cada "path": "docs/engineer/engineer_XXX.md" e o
    "content" seguinte, extrai com _extract_content_value_robust e monta a lista.
    """
    paths_order = [
        "docs/engineer/engineer_proposal.md",
        "docs/engineer/engineer_architecture.md",
        "docs/engineer/engineer_dependencies.md",
    ]
    pattern_path = re.compile(r'"path"\s*:\s*"(' + re.escape("docs/engineer/engineer_proposal.md") + r'|' + re.escape("docs/engineer/engineer_architecture.md") + r'|' + re.escape("docs/engineer/engineer_dependencies.md") + r')"')
    artifacts: list[dict] = []
    for m in pattern_path.finditer(json_str):
        path_val = m.group(1)
        after = json_str[m.end():]
        content_label = re.search(r'"content"\s*:\s*"', after)
        if not content_label:
            continue
        # Índice da aspa de abertura do valor (último " do match '"content": "')
        quote_pos = content_label.end() - 1
        content_val, _ = _extract_content_value_robust(after, quote_pos)
        if content_val is None:
            content_val, _ = _extract_double_quoted(after, quote_pos)
        if content_val is not None and len(content_val.strip()) > 50:
            content_val = _unescape_json_string(content_val)
            artifacts.append({
                "path": path_val,
                "content": content_val,
                "format": "markdown",
                "purpose": "Engineer doc" if "proposal" in path_val else ("Architecture" if "architecture" in path_val else "Dependencies"),
            })
    ordered = []
    for p in paths_order:
        for a in artifacts:
            if a.get("path") == p:
                ordered.append(a)
                break
    return ordered


def parse_response_envelope(
    raw_text: str,
    request_id: str = "unknown",
    *,
    require_artifacts: bool = False,
    require_evidence_when_ok: bool = False,
) -> tuple[dict, list[str]]:
    """
    Parseia raw_text (resposta da LLM) em ResponseEnvelope e valida.
    Usa resilient_json_parse (LEI 4) com 3 níveis de fallback para escaping.
    Retorna (envelope_dict, list_of_validation_errors).
    """
    data, parse_errors = resilient_json_parse(raw_text, request_id)
    if "request_id" not in data:
        data["request_id"] = request_id
    for key in ("artifacts", "evidence"):
        if key not in data or not isinstance(data.get(key), list):
            data[key] = data.get(key) if isinstance(data.get(key), list) else []
    if "next_actions" not in data or not isinstance(data.get("next_actions"), dict):
        data["next_actions"] = data.get("next_actions") if isinstance(data.get("next_actions"), dict) else {}
    ok, val_errors = validate_response_envelope(
        data,
        require_artifacts=require_artifacts,
        require_evidence_when_ok=require_evidence_when_ok,
    )
    return data, parse_errors + val_errors


# ---------------------------------------------------------------------------
# Gates por agente/modo (Runner Enforcer — PROMPT_EXECUCAO_100P)
# ---------------------------------------------------------------------------

def get_requirements_for_mode(agent: str, mode: str) -> tuple[bool, bool]:
    """
    Retorna (require_artifacts, require_evidence_when_ok) para o par agent+mode.
    Modos de geração/validação exigem artifacts; status=OK exige evidence.
    """
    a = (agent or "").upper()
    m = (mode or "").strip().lower()
    # Modos que exigem artefatos
    artifact_modes = (
        "spec_intake_and_normalize", "validate_engineer_docs", "validate_backlog", "charter_and_proposal",
        "generate_engineering_docs", "generate_backlog", "implement_task", "validate_task",
        "orchestrate", "provision_artifacts",
    )
    require_artifacts = m in artifact_modes
    # OK sempre exige evidência (Blueprint 2.4)
    require_evidence_when_ok = True
    return require_artifacts, require_evidence_when_ok


def _required_path_prefixes_for_mode(agent: str, mode: str, task_id: str | None) -> list[str]:
    """Prefixes ou padrões que devem existir em artifacts[].path para o modo (para validação extra)."""
    a = (agent or "").upper()
    m = (mode or "").strip().lower()
    if a == "CTO" and m == "spec_intake_and_normalize":
        return ["docs/spec/PRODUCT_SPEC.md"]
    if a == "CTO" and m in ("validate_engineer_docs", "validate_backlog"):
        return ["docs/cto/"]
    if a == "ENGINEER" and m == "generate_engineering_docs":
        return ["docs/engineer/engineer_proposal.md", "docs/engineer/engineer_architecture.md", "docs/engineer/engineer_dependencies.md"]
    if a == "PM" and m == "generate_backlog":
        return ["docs/pm/"]
    if a == "DEV" and m == "implement_task":
        prefixes = ["apps/"]
        if task_id:
            prefixes.append("docs/dev/dev_implementation_")
        return prefixes
    if a == "QA" and m == "validate_task":
        return ["docs/qa/"]
    if a == "MONITOR" and m == "orchestrate":
        return ["docs/monitor/TASK_STATE.json", "docs/monitor/STATUS.md"]
    if a == "DEVOPS" and m == "provision_artifacts":
        return ["project/", "docs/devops/"]
    return []


def validate_response_envelope_for_mode(
    data: dict,
    agent: str,
    mode: str,
    task_id: str | None = None,
) -> tuple[bool, list[str]]:
    """
    Valida ResponseEnvelope com gates do modo (artifacts obrigatórios, evidence quando OK).
    Retorna (ok, list_of_errors).
    """
    require_artifacts, require_evidence = get_requirements_for_mode(agent, mode)
    ok, errors = validate_response_envelope(
        data,
        require_artifacts=require_artifacts,
        require_evidence_when_ok=require_evidence,
    )
    if not ok:
        return ok, errors
    extra_errors: list[str] = []
    # Verificação extra: pelo menos um artifact com path nos prefixos obrigatórios (quando definidos)
    prefixes = _required_path_prefixes_for_mode(agent, mode, task_id)
    if prefixes:
        artifacts = data.get("artifacts") or []
        paths = [a.get("path") or "" for a in artifacts if isinstance(a, dict)]
        for prefix in prefixes:
            if any(p.startswith(prefix) or prefix in p for p in paths):
                continue
            if prefix.endswith(".md") or prefix.endswith(".json"):
                if not any(prefix in p or (prefix.split("/")[-1] in p) for p in paths):
                    extra_errors.append(f"modo {mode} exige artefato com path contendo: {prefix}")
            else:
                if not any(p.startswith(prefix) for p in paths):
                    extra_errors.append(f"modo {mode} exige pelo menos um artefato em {prefix}")
    # QA: status deve ser QA_PASS ou QA_FAIL
    if (agent or "").upper() == "QA" and mode == "validate_task":
        status = data.get("status")
        if status not in ("QA_PASS", "QA_FAIL"):
            extra_errors.append(f"QA em validate_task deve ter status QA_PASS ou QA_FAIL, obtido: {status!r}")
    if extra_errors:
        return False, extra_errors
    return True, []


def filter_artifacts_by_path_policy(artifacts: list[dict], project_id: str | None) -> list[dict]:
    """
    Filtra e normaliza artifacts: só mantém os que passam em sanitize_artifact_path.
    Atualiza path para o valor normalizado. Remove os bloqueados.
    """
    out = []
    for art in artifacts:
        if not isinstance(art, dict):
            continue
        path = art.get("path")
        if not path:
            continue
        norm = sanitize_artifact_path(path, project_id)
        if norm is None:
            logger.warning("[Envelope] Artefato ignorado (path bloqueado): %s", path)
            continue
        out.append({**art, "path": norm})
    return out
