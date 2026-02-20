"""
Cliente HTTP para invocar agentes via serviço (API_AGENTS_URL).
Usado pelo runner quando não roda no mesmo processo que o serviço agents.
Resiliência: timeout 300s (repair loop pode fazer 3 chamadas LLM), retry em timeout.
"""
import json
import logging
import os
import socket
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

AGENT_ENDPOINTS = {
    "engineer": "/invoke/engineer",
    "cto": "/invoke/cto",
    "pm": "/invoke/pm",
    "dev": "/invoke/dev",
    "qa": "/invoke/qa",
    "monitor": "/invoke/monitor",
    "devops": "/invoke/devops",
}

AGENT_LABELS = {
    "engineer": "Engineer",
    "cto": "CTO",
    "pm": "PM",
    "dev": "Dev",
    "qa": "QA",
    "monitor": "Monitor",
    "devops": "DevOps",
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
    Invoca o agente via HTTP. agent_key: 'engineer' | 'cto' | 'pm' | 'dev' | 'qa' | 'monitor' | 'devops'.
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
    # Timeout alto: Enforcer pode fazer até 3 chamadas LLM (inicial + 2 repairs) por requisição
    timeout = int(os.environ.get("REQUEST_TIMEOUT", "300"))
    max_attempts = max(1, int(os.environ.get("AGENT_HTTP_RETRY_ON_TIMEOUT", "2")))

    logger.info("[%s] Chamando serviço de agentes em %s (timeout=%ss, max_attempts=%s)...", agent_name, url, timeout, max_attempts)

    for attempt in range(max_attempts):
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
        except (TimeoutError, socket.timeout, OSError) as e:
            is_timeout = "timed out" in str(e).lower() or isinstance(e, (TimeoutError, socket.timeout))
            if is_timeout and attempt < max_attempts - 1:
                logger.warning("[%s] Timeout (tentativa %s/%s), repetindo...", agent_name, attempt + 1, max_attempts)
                continue
            if is_timeout:
                logger.error("[%s] Timeout após %s tentativa(s). Aumente REQUEST_TIMEOUT (ex.: 300) ou verifique o serviço de agentes.", agent_name, max_attempts)
                raise RuntimeError(
                    json.dumps({
                        "agent": agent_key,
                        "agent_name": agent_name,
                        "error": "timed out",
                        "human_message": "O agente demorou mais que o limite (timeout). Tente iniciar o pipeline novamente ou defina REQUEST_TIMEOUT=300 no ambiente do runner.",
                        "traceback": "",
                    }, ensure_ascii=False)
                ) from e
            raise
