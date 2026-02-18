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

# Mapeamento role/agent -> path do endpoint
AGENT_ENDPOINTS = {
    "engineer": "/invoke/engineer",
    "cto": "/invoke/cto",
    "pm_backend": "/invoke",
}


def _read_error_body(exc: urllib.error.HTTPError, max_len: int = 2000) -> str:
    """Lê o body da resposta de erro para incluir no diagnóstico."""
    body = ""
    if getattr(exc, "fp", None) and exc.fp:
        try:
            raw = exc.fp.read()
            body = (raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw))[:max_len]
        except Exception:
            pass
    return body


def run_agent_http(agent_key: str, message: dict) -> dict:
    """
    Invoca o agente via HTTP. agent_key: 'engineer' | 'cto' | 'pm_backend'.
    message: message_envelope (request_id, input com spec_ref, context, etc.).
    Retorna response_envelope (dict).
    """
    base = os.environ.get("API_AGENTS_URL", "").rstrip("/")
    if not base:
        raise ValueError("API_AGENTS_URL não definida")

    path = AGENT_ENDPOINTS.get(agent_key)
    if not path:
        raise ValueError(f"Agente desconhecido: {agent_key}")

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
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                raise RuntimeError(f"Agente {agent_key} retornou status {resp.status}")
            out = json.loads(resp.read().decode("utf-8"))
        return out
    except urllib.error.HTTPError as e:
        err_body = _read_error_body(e)
        detail = err_body
        try:
            parsed = json.loads(err_body) if err_body.strip().startswith("{") else {}
            detail = parsed.get("detail", parsed.get("message", err_body))
            if isinstance(detail, list):
                detail = "; ".join(str(x) for x in detail)
        except Exception:
            pass
        msg = f"Agente {agent_key} retornou HTTP {e.code}: {e.reason}. Detalhe: {detail}"
        logger.error("%s", msg)
        raise RuntimeError(msg) from e
