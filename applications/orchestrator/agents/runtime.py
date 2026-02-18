"""
Runtime reutilizável para agentes que usam LLM (Claude).
Carrega SYSTEM_PROMPT.md, recebe message_envelope, chama API Anthropic, devolve response_envelope.
"""
from pathlib import Path
import os
import json
import logging
import time

logger = logging.getLogger(__name__)

# Raiz das aplicações: no host = repo/applications, no container = /app
_r = Path(__file__).resolve().parent.parent.parent
APPLICATIONS_ROOT = _r.parent if _r.name == "applications" else _r

# Retry: número de tentativas (default 3 = 1 inicial + 2 retries; útil para connection errors)
CLAUDE_RETRY_ATTEMPTS = int(os.environ.get("CLAUDE_RETRY_ATTEMPTS", "3"))


def _extract_api_message(exc: BaseException) -> str | None:
    """
    Extrai a mensagem explicativa da API (ex.: Anthropic) quando disponível,
    para exibir no portal em vez de só o texto genérico da exceção.
    """
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


def load_system_prompt(system_prompt_path: Path) -> str:
    """Carrega o conteúdo do SYSTEM_PROMPT (arquivo .md)."""
    path = system_prompt_path if system_prompt_path.is_absolute() else APPLICATIONS_ROOT / system_prompt_path
    if not path.exists():
        raise FileNotFoundError(f"SYSTEM_PROMPT não encontrado: {path}")
    return path.read_text(encoding="utf-8")


def _normalize_response_envelope(out: dict, request_id: str, raw_text: str) -> dict:
    """Garante que o dict tenha pelo menos status e summary; preenche defaults e loga aviso se necessário."""
    if "request_id" not in out:
        out["request_id"] = request_id
    if not isinstance(out.get("status"), str):
        logger.warning("Claude devolveu response_envelope sem status válido; preenchendo default.")
        out["status"] = "OK"
    if "summary" not in out or not isinstance(out.get("summary"), str):
        logger.warning("Claude devolveu response_envelope sem summary; preenchendo a partir do texto.")
        out["summary"] = (raw_text[:500] if raw_text else "Resposta sem summary.")
    for key in ("artifacts", "evidence", "next_actions"):
        if key not in out or not isinstance(out.get(key), list):
            out[key] = out.get(key) if isinstance(out.get(key), list) else []
    return out


def run_agent(
    system_prompt_path: str | Path,
    message: dict,
    role: str = "PM_BACKEND",
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

    model = os.environ.get("CLAUDE_MODEL", "claude-3-5-sonnet-20241022")
    timeout = int(os.environ.get("REQUEST_TIMEOUT", "120"))

    system_content = load_system_prompt(Path(system_prompt_path))
    user_content = (
        "Entrada no formato message_envelope (JSON):\n"
        + json.dumps(message, ensure_ascii=False, indent=2)
        + "\n\nResponda em JSON no formato response_envelope: status, summary, artifacts (lista), evidence (lista), next_actions (lista com owner, action, priority)."
    )

    client = Anthropic(api_key=api_key)
    request_id = message.get("request_id", "unknown")
    last_error = None
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
                wait = 2 + attempt * 2  # 2s, 4s para dar tempo à rede/proxy
                logger.warning(
                    "Tentativa %s falhou (%s); aguardando %s s antes de retry.",
                    attempt + 1, e, wait,
                )
                time.sleep(wait)
            else:
                api_msg = _extract_api_message(e)
                if api_msg:
                    raise RuntimeError(f"Claude API: {api_msg}") from e
                raise RuntimeError(f"Falha ao chamar Claude após {attempt + 1} tentativa(s): {e}") from e

    raw_text = response.content[0].text if response.content else ""
    text = raw_text

    # Tentar extrair JSON da resposta (pode vir com markdown code block)
    if "```json" in text:
        text = text.split("```json")[1].split("```")[0].strip()
    elif "```" in text:
        text = text.split("```")[1].split("```")[0].strip()

    try:
        out = json.loads(text)
    except json.JSONDecodeError:
        out = {
            "request_id": request_id,
            "status": "OK",
            "summary": raw_text[:500] if raw_text else "Resposta sem JSON válido.",
            "artifacts": [],
            "evidence": [],
            "next_actions": [],
        }

    return _normalize_response_envelope(out, request_id, raw_text)
