"""
Agente Dev Backend — implementação da squad Backend (Node.js, endpoints, testes, evidências).
Uso: python -m orchestrator.agents.dev_backend --input message.json
      ou POST /invoke/dev-backend com body message_envelope (quando rodando como serviço).
"""
import argparse
import json
import logging
import os
import sys
from pathlib import Path

from .runtime import run_agent

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SYSTEM_PROMPT_PATH = REPO_ROOT / "agents" / "dev" / "backend" / "nodejs" / "SYSTEM_PROMPT.md"

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


def main() -> int:
    parser = argparse.ArgumentParser(description="Dev Backend Agent — implementação Backend (Node.js, endpoints, evidências)")
    parser.add_argument("--input", "-i", help="Arquivo JSON com message_envelope", default="-")
    parser.add_argument("--output", "-o", help="Arquivo de saída (response_envelope)", default="-")
    args = parser.parse_args()

    if args.input == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(args.input).read_text(encoding="utf-8")

    try:
        message = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error("JSON inválido: %s", e)
        return 1

    if "request_id" not in message:
        message["request_id"] = "dev-backend-cli"
    if "input" not in message:
        message["input"] = message.get("context", {})

    logger.info("Chamando agente Dev Backend (SYSTEM_PROMPT: %s)", SYSTEM_PROMPT_PATH)
    response = run_agent(
        system_prompt_path=SYSTEM_PROMPT_PATH,
        message=message,
        role="DEV_BACKEND",
    )

    out = json.dumps(response, ensure_ascii=False, indent=2)
    if args.output == "-":
        print(out)
    else:
        Path(args.output).write_text(out, encoding="utf-8")

    return 0 if response.get("status") in ("OK", "NEEDS_INFO") else 1


if __name__ == "__main__":
    sys.exit(main())
