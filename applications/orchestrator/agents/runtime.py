"""
Runtime reutilizável para agentes que usam LLM (Claude).
Carrega SYSTEM_PROMPT.md, recebe message_envelope, chama API Anthropic, devolve response_envelope.
Blueprint V2 REV2: parse/validação via envelope; seleção de modelo por contexto (spec vs code).
"""
from pathlib import Path
import os
import json
import logging
import time
import traceback as _tb

logger = logging.getLogger(__name__)

_r = Path(__file__).resolve().parent.parent.parent
APPLICATIONS_ROOT = _r.parent if _r.name == "applications" else _r

CLAUDE_RETRY_ATTEMPTS = int(os.environ.get("CLAUDE_RETRY_ATTEMPTS", "3"))
MAX_REPAIRS = int(os.environ.get("MAX_REPAIRS", "2"))
CIRCUIT_BREAKER_THRESHOLD = int(os.environ.get("CIRCUIT_BREAKER_THRESHOLD", "3"))

SHOW_TRACEBACK = os.environ.get("SHOW_TRACEBACK", "true").strip().lower() in ("1", "true", "yes")

# Circuit breaker: (project_id, agent, mode) -> falhas consecutivas
_circuit_failures: dict[tuple[str, str, str], int] = {}

AGENT_LABELS = {
    "ENGINEER": "Engineer",
    "CTO": "CTO",
    "PM": "PM",
    "PM_WEB": "PM Web",
    "DEV": "Dev",
    "QA": "QA",
    "MONITOR": "Monitor",
    "DEVOPS": "DevOps",
}


def _label(role: str) -> str:
    return AGENT_LABELS.get(role, role.replace("_", " ").title())


def _extract_api_message(exc: BaseException) -> str | None:
    if hasattr(exc, "body") and isinstance(getattr(exc, "body"), dict):
        body = getattr(exc, "body")
        if isinstance(body.get("error"), dict) and isinstance(body["error"].get("message"), str):
            return body["error"]["message"]
        if isinstance(body.get("message"), str):
            return body["message"]
    if hasattr(exc, "message") and isinstance(getattr(exc, "message"), str):
        return getattr(exc, "message")
    if hasattr(exc, "response"):
        try:
            r = getattr(exc, "response")
            if hasattr(r, "json"):
                data = r.json()
                if isinstance(data.get("error"), dict) and isinstance(data["error"].get("message"), str):
                    return data["error"]["message"]
                if isinstance(data.get("message"), str):
                    return data["message"]
        except Exception:
            pass
    return None


def _build_error_detail(exc: BaseException, api_msg: str | None = None) -> dict:
    """Constrói um dict com informações do erro, respeitando SHOW_TRACEBACK."""
    detail: dict = {
        "error": api_msg or str(exc),
        "error_type": type(exc).__name__,
    }
    if SHOW_TRACEBACK:
        detail["traceback"] = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
    return detail


PROTOCOL_SHARED_MARKER = "<!-- INCLUDE: SYSTEM_PROMPT_PROTOCOL_SHARED -->"
# contracts/ fica em applications/contracts/; APPLICATIONS_ROOT pode ser repo root
_contracts_dir = APPLICATIONS_ROOT / "applications" / "contracts" if (APPLICATIONS_ROOT / "applications" / "contracts").exists() else APPLICATIONS_ROOT / "contracts"
PROTOCOL_SHARED_PATH = _contracts_dir / "SYSTEM_PROMPT_PROTOCOL_SHARED.md"


def load_system_prompt(system_prompt_path: Path) -> str:
    path = system_prompt_path if system_prompt_path.is_absolute() else APPLICATIONS_ROOT / system_prompt_path
    if not path.exists():
        raise FileNotFoundError(f"SYSTEM_PROMPT não encontrado: {path}")
    content = path.read_text(encoding="utf-8")
    if PROTOCOL_SHARED_MARKER in content:
        if not PROTOCOL_SHARED_PATH.exists():
            logger.warning("Protocolo compartilhado não encontrado: %s", PROTOCOL_SHARED_PATH)
        else:
            shared = PROTOCOL_SHARED_PATH.read_text(encoding="utf-8")
            content = content.replace(PROTOCOL_SHARED_MARKER, shared.strip())
    # Prompt bundling: injetar skills.md (conteúdo completo) do mesmo dir do SYSTEM_PROMPT
    prompt_dir = path.parent
    skills_path = prompt_dir / "skills.md"
    if skills_path.exists():
        try:
            skills_content = skills_path.read_text(encoding="utf-8")
            content = content.rstrip() + "\n\n## Competências (skills.md)\n\n" + skills_content.strip() + "\n"
        except Exception as e:
            logger.warning("Não foi possível carregar skills.md de %s: %s", skills_path, e)
    return content


def _normalize_response_envelope(out: dict, request_id: str, raw_text: str) -> dict:
    if "request_id" not in out:
        out["request_id"] = request_id
    if not isinstance(out.get("status"), str):
        logger.warning("Claude devolveu response_envelope sem status válido; preenchendo default.")
        out["status"] = "OK"
    if "summary" not in out or not isinstance(out.get("summary"), str):
        logger.warning("Claude devolveu response_envelope sem summary; preenchendo a partir do texto.")
        out["summary"] = (raw_text[:500] if raw_text else "Resposta sem summary.")
    for key in ("artifacts", "evidence"):
        if key not in out or not isinstance(out.get(key), list):
            out[key] = out.get(key) if isinstance(out.get(key), list) else []
    if "next_actions" not in out or not isinstance(out.get("next_actions"), dict):
        out["next_actions"] = out.get("next_actions") if isinstance(out.get("next_actions"), dict) else {}
    return out


def _get_model_for_role(role: str) -> str:
    """Seleção de modelo por contexto (Blueprint 6.1): spec/charter vs código."""
    role_upper = (role or "").upper()
    if role_upper in ("CTO", "ENGINEER", "PM"):
        return os.environ.get("CLAUDE_MODEL_SPEC") or os.environ.get("PIPELINE_LLM_MODEL") or os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
    if role_upper == "DEV":
        return os.environ.get("CLAUDE_MODEL_CODE") or os.environ.get("PIPELINE_LLM_MODEL") or os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
    return os.environ.get("PIPELINE_LLM_MODEL") or os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")


def run_agent(
    system_prompt_path: str | Path,
    message: dict,
    role: str = "PM",
) -> dict:
    """
    Executa o agente: system prompt + message -> Claude -> response_envelope.
    message deve conter request_id, input (spec_ref, context, task, constraints, artifacts).
    Retorna dict com status, summary, artifacts, evidence, next_actions (formato response_envelope).
    """
    try:
        from anthropic import Anthropic
    except ImportError:
        raise ImportError("Instale anthropic: pip install anthropic")

    api_key = os.environ.get("CLAUDE_API_KEY")
    if not api_key:
        raise ValueError("CLAUDE_API_KEY não definida (variável de ambiente)")

    model = _get_model_for_role(role)
    timeout = int(os.environ.get("REQUEST_TIMEOUT", "120"))
    agent_name = _label(role)

    system_content = load_system_prompt(Path(system_prompt_path))
    # MessageEnvelope: extrair project_id, mode, task_id para gates e circuit breaker
    inp = message.get("input") or {}
    project_id = message.get("project_id") or inp.get("project_id") or "default"
    mode = message.get("mode") or inp.get("mode") or "default"
    task_id = message.get("task_id") or inp.get("task_id")
    circuit_key = (str(project_id), str(role), str(mode))
    if _circuit_failures.get(circuit_key, 0) >= CIRCUIT_BREAKER_THRESHOLD:
        logger.warning("[%s] Circuit breaker aberto para %s (falhas consecutivas >= %s).", agent_name, circuit_key, CIRCUIT_BREAKER_THRESHOLD)
        out = _normalize_response_envelope({
            "request_id": message.get("request_id", "unknown"),
            "status": "BLOCKED",
            "summary": f"Circuit breaker: {CIRCUIT_BREAKER_THRESHOLD} falhas consecutivas (agent={role}, mode={mode}). Escale para Monitor/CTO.",
            "artifacts": [],
            "evidence": [],
            "next_actions": {"owner": "Monitor", "items": ["Intervenção humana: revisar logs e reprocessar ou ajustar prompt."], "questions": []},
        }, message.get("request_id", "unknown"), "")
        out["circuit_breaker_open"] = True
        out["validator_pass"] = False
        return out

    user_base = (
        "Entrada no formato message_envelope (JSON):\n"
        + json.dumps(message, ensure_ascii=False, indent=2)
        + "\n\nResponda em JSON no formato response_envelope: status, summary, artifacts (lista com path e content), evidence (lista), next_actions (objeto com owner, items, questions)."
    )
    user_content = user_base

    client = Anthropic(api_key=api_key)
    request_id = message.get("request_id", "unknown")

    for repair_attempt in range(MAX_REPAIRS + 1):
        logger.info("[%s] Enviando solicitação à Claude (modelo: %s, repair=%d/%d)...", agent_name, model, repair_attempt, MAX_REPAIRS)
        last_error = None
        response = None
        for attempt in range(CLAUDE_RETRY_ATTEMPTS):
            try:
                response = client.messages.create(
                    model=model,
                    max_tokens=4096,
                    system=system_content,
                    messages=[{"role": "user", "content": user_content}],
                    timeout=timeout,
                )
                break
            except Exception as e:
                last_error = e
                err_lower = str(e).lower()
                is_retryable = (
                    getattr(e, "status_code", None) in (429, 500, 502, 503)
                    or "timeout" in err_lower
                    or "connection" in err_lower
                    or "ssl" in err_lower
                )
                if is_retryable and attempt < CLAUDE_RETRY_ATTEMPTS - 1:
                    time.sleep(2 + attempt * 2)
                else:
                    _circuit_failures[circuit_key] = _circuit_failures.get(circuit_key, 0) + 1
                    api_msg = _extract_api_message(e)
                    error_detail = _build_error_detail(e, api_msg)
                    raise RuntimeError(
                        json.dumps({"agent": role, "model": model, **error_detail}, ensure_ascii=False)
                    ) from e

        raw_text = response.content[0].text if response and response.content else ""
        logger.info("[%s] Resposta recebida (audit: role=%s model=%s request_id=%s).", agent_name, role, model, request_id)

        try:
            from orchestrator.envelope import (
                parse_response_envelope,
                repair_prompt,
                validate_response_envelope_for_mode,
                get_requirements_for_mode,
            )
        except ImportError:
            repair_prompt = None
            parse_response_envelope = None
            validate_response_envelope_for_mode = None
            get_requirements_for_mode = None

        req_artifacts, req_evidence = (get_requirements_for_mode(role, mode) if get_requirements_for_mode else (False, True))
        if parse_response_envelope:
            out, parse_errors = parse_response_envelope(
                raw_text, request_id,
                require_artifacts=req_artifacts,
                require_evidence_when_ok=req_evidence,
            )
        else:
            parse_errors = []
            text = raw_text
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0].strip()
            elif "```" in text:
                text = text.split("```")[1].split("```")[0].strip()
            try:
                out = json.loads(text) if text else {}
            except json.JSONDecodeError:
                out = {"request_id": request_id, "status": "FAIL", "summary": raw_text[:500] if raw_text else "Resposta sem JSON válido.", "artifacts": [], "evidence": [], "next_actions": {}}
            if "next_actions" in out and isinstance(out["next_actions"], list):
                out["next_actions"] = {}

        gate_errors = []
        if validate_response_envelope_for_mode and out.get("status") != "FAIL":
            ok, gate_errors = validate_response_envelope_for_mode(out, role, mode, task_id)
        all_errors = parse_errors + gate_errors
        out["artifacts_paths"] = [a.get("path") for a in out.get("artifacts", []) if isinstance(a, dict) and a.get("path")]

        if not all_errors:
            _circuit_failures[circuit_key] = 0
            out["validator_pass"] = True
            out["validation_errors"] = []
            return _normalize_response_envelope(out, request_id, raw_text)

        if repair_attempt < MAX_REPAIRS:
            try:
                repair_msg = (repair_prompt() if repair_prompt else "") + "\n\nFalhas: " + "; ".join(all_errors[:5])
            except Exception:
                repair_msg = "Retorne apenas JSON válido (ResponseEnvelope). Falhas: " + "; ".join(all_errors[:5])
            user_content = user_content + "\n\n---\n" + repair_msg
            logger.warning("[%s] Repair %d/%d: %s", agent_name, repair_attempt + 1, MAX_REPAIRS, all_errors[:2])
            continue

        _circuit_failures[circuit_key] = _circuit_failures.get(circuit_key, 0) + 1
        out["status"] = "BLOCKED"
        out["summary"] = (out.get("summary") or "") + "; Enforcer: " + "; ".join(all_errors[:5])
        out["validator_pass"] = False
        out["validation_errors"] = all_errors
        return _normalize_response_envelope(out, request_id, raw_text)
