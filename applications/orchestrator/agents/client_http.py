"""
Cliente HTTP para invocar agentes via serviço (API_AGENTS_URL).
Usado pelo runner quando não roda no mesmo processo que o serviço agents.
"""
import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

AGENT_ENDPOINTS = {
    "engineer": "/invoke/engineer",
    "cto": "/invoke/cto",
    "pm_backend": "/invoke",
    "dev_backend": "/invoke/dev-backend",
    "qa_backend": "/invoke/qa-backend",
    "monitor_backend": "/invoke/monitor",
    "devops_docker": "/invoke/devops-docker",
}

AGENT_LABELS = {
    "engineer": "Engineer",
    "cto": "CTO",
    "pm_backend": "PM Backend",
    "dev_backend": "Dev Backend",
    "qa_backend": "QA Backend",
    "monitor_backend": "Monitor Backend",
    "devops_docker": "DevOps Docker",
}


def _read_error_body(exc: urllib.error.HTTPError, max_len: int = 4000) -> str:
    body = ""
    if getattr(exc, "fp", None) and exc.fp:
        try:
            raw = exc.fp.read()
            body = (raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw))[:max_len]
        except Exception:
            pass
    return body


def _parse_error_detail(err_body: str) -> dict:
    """Extrai detail estruturado do body de erro do FastAPI."""
    if not err_body.strip():
        return {}
    try:
        parsed = json.loads(err_body)
        detail = parsed.get("detail", parsed)
        if isinstance(detail, str):
            try:
                return json.loads(detail)
            except (json.JSONDecodeError, TypeError):
                return {"error": detail}
        if isinstance(detail, dict):
            return detail
        if isinstance(detail, list):
            return {"error": "; ".join(str(x) for x in detail)}
        return {"error": str(detail)}
    except (json.JSONDecodeError, TypeError):
        return {"error": err_body[:500]}


def run_agent_http(agent_key: str, message: dict) -> dict:
    """
    Invoca o agente via HTTP. agent_key: 'engineer' | 'cto' | 'pm_backend' | 'dev_backend' | 'qa_backend' | 'monitor_backend' | 'devops_docker'.
    message: message_envelope (request_id, input com spec_ref, context, etc.).
    Retorna response_envelope (dict).
    """
    base = os.environ.get("API_AGENTS_URL", "").rstrip("/")
    if not base:
        raise ValueError("API_AGENTS_URL não definida")

    path = AGENT_ENDPOINTS.get(agent_key)
    if not path:
        raise ValueError(f"Agente desconhecido: {agent_key}")

    agent_name = AGENT_LABELS.get(agent_key, agent_key)
    url = f"{base}{path}"
    body = message if "input" in message else {"request_id": message.get("request_id", "http"), "input": message}
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    timeout = int(os.environ.get("REQUEST_TIMEOUT", "120"))

    logger.info("[%s] Chamando serviço de agentes em %s...", agent_name, url)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                raise RuntimeError(f"Agente {agent_name} retornou status {resp.status}")
            out = json.loads(resp.read().decode("utf-8"))
        logger.info("[%s] Resposta recebida com sucesso.", agent_name)
        return out
    except urllib.error.HTTPError as e:
        err_body = _read_error_body(e)
        detail = _parse_error_detail(err_body)
        error_msg = detail.get("error", detail.get("human_message", err_body[:500]))
        human_msg = detail.get("human_message", f"O agente {agent_name} retornou erro HTTP {e.code}: {error_msg}")
        tb = detail.get("traceback", "")

        logger.error("[%s] HTTP %d: %s", agent_name, e.code, error_msg)

        raise RuntimeError(json.dumps({
            "agent": agent_key,
            "agent_name": agent_name,
            "http_code": e.code,
            "error": error_msg,
            "human_message": human_msg,
            "traceback": tb,
        }, ensure_ascii=False)) from e
