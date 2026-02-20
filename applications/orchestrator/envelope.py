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


def repair_prompt() -> str:
    """Prompt padrão de reparo quando a IA falha em JSON/gates (Blueprint §10)."""
    return (
        "Retorne **apenas** JSON válido no formato ResponseEnvelope. "
        "Não inclua texto fora do JSON. "
        "Em strings JSON use \\n para quebras de linha e \\\" para aspas; não deixe strings não terminadas. "
        "Preencha `status`, `artifacts[]` (com `path` e `content`), `evidence[]` e `next_actions`. "
        "`artifact.path` deve começar com `docs/` ou `project/` ou `apps/` (sempre relativo, sem path absoluto)."
    )


def extract_json_from_text(text: str) -> str | None:
    """Extrai bloco JSON de texto (markdown code block ou raw)."""
    if not text or not isinstance(text, str):
        return None
    text = text.strip()
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


def parse_response_envelope(
    raw_text: str,
    request_id: str = "unknown",
    *,
    require_artifacts: bool = False,
    require_evidence_when_ok: bool = False,
) -> tuple[dict, list[str]]:
    """
    Parseia raw_text (resposta da LLM) em ResponseEnvelope e valida.
    Retorna (envelope_dict, list_of_validation_errors).
    Se JSON inválido, retorna envelope mínimo com status FAIL e errors preenchido.
    """
    json_str = extract_json_from_text(raw_text)
    if not json_str:
        return (
            {
                "request_id": request_id,
                "status": "FAIL",
                "summary": (raw_text[:500] if raw_text else "Resposta sem JSON válido."),
                "artifacts": [],
                "evidence": [],
                "next_actions": {},
            },
            ["Resposta não contém JSON válido (ResponseEnvelope)."],
        )
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        return (
            {
                "request_id": request_id,
                "status": "FAIL",
                "summary": f"JSON inválido: {e!s}",
                "artifacts": [],
                "evidence": [],
                "next_actions": {},
            },
            [f"JSON inválido: {e!s}"],
        )
    if "request_id" not in data:
        data["request_id"] = request_id
    for key in ("artifacts", "evidence"):
        if key not in data or not isinstance(data.get(key), list):
            data[key] = data.get(key) if isinstance(data.get(key), list) else []
    if "next_actions" not in data or not isinstance(data.get("next_actions"), dict):
        data["next_actions"] = data.get("next_actions") if isinstance(data.get("next_actions"), dict) else {}
    ok, errs = validate_response_envelope(
        data,
        require_artifacts=require_artifacts,
        require_evidence_when_ok=require_evidence_when_ok,
    )
    return data, errs


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
