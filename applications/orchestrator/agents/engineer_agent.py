"""
Agente Engineer — analisa spec e devolve proposta técnica (squads/equipes, dependências).
Staff Engineer / Software Architect Full-Stack. Comunica-se apenas com o CTO.
Uso: python -m orchestrator.agents.engineer_agent --input message.json
"""
import json
import logging
import os
import sys
from pathlib import Path

from .runtime import run_agent

_r = Path(__file__).resolve().parent.parent.parent
ENGINEER_SYSTEM_PROMPT_PATH = _r / "agents" / "engineer" / "SYSTEM_PROMPT.md"

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


def main() -> int:
    raw = sys.stdin.read() if len(sys.argv) < 2 else Path(sys.argv[1]).read_text(encoding="utf-8")
    try:
        message = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error("JSON inválido: %s", e)
        return 1

    message.setdefault("request_id", "engineer-cli")
    if "input" not in message:
        message["input"] = message.get("context", {})

    logger.info("Chamando agente Engineer (SYSTEM_PROMPT: %s)", ENGINEER_SYSTEM_PROMPT_PATH)
    response = run_agent(
        system_prompt_path=ENGINEER_SYSTEM_PROMPT_PATH,
        message=message,
        role="ENGINEER",
    )
    print(json.dumps(response, ensure_ascii=False, indent=2))
    return 0 if response.get("status") in ("OK", "NEEDS_INFO") else 1


if __name__ == "__main__":
    sys.exit(main())
