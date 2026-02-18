"""
Runtime reutilizável para agentes que usam LLM (Claude).
Carrega SYSTEM_PROMPT.md, recebe message_envelope, chama API Anthropic, devolve response_envelope.
"""
from pathlib import Path
import os
import json
import logging

logger = logging.getLogger(__name__)

# Raiz das aplicações: no host = repo/applications, no container = /app
_r = Path(__file__).resolve().parent.parent.parent
APPLICATIONS_ROOT = _r.parent if _r.name == "applications" else _r


def load_system_prompt(system_prompt_path: Path) -> str:
    """Carrega o conteúdo do SYSTEM_PROMPT (arquivo .md)."""
    path = system_prompt_path if system_prompt_path.is_absolute() else APPLICATIONS_ROOT / system_prompt_path
    if not path.exists():
        raise FileNotFoundError(f"SYSTEM_PROMPT não encontrado: {path}")
    return path.read_text(encoding="utf-8")


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
    response = client.messages.create(
        model=model,
        max_tokens=4096,
        system=system_content,
        messages=[{"role": "user", "content": user_content}],
        timeout=timeout,
    )

    text = response.content[0].text if response.content else ""
    request_id = message.get("request_id", "unknown")

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
            "summary": text[:500] if text else "Resposta sem JSON válido.",
            "artifacts": [],
            "evidence": [],
            "next_actions": [],
        }

    if "request_id" not in out:
        out["request_id"] = request_id
    return out
