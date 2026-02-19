"""
Agente DevOps — IaC, CI/CD, deploy (skill definida em applications/agents).
Uso: python -m orchestrator.agents.devops --input message.json [--skill-path devops/docker]
     ou POST /invoke/devops com body message_envelope (skill_path opcional em input.context.skill_path).
"""
import argparse
import json
import logging
import os
import sys
from pathlib import Path

from .runtime import run_agent

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_SKILL_PATH = "devops/docker"
PROMPT_FILENAME = "SYSTEM_PROMPT.md"

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


def get_system_prompt_path(skill_path: str | None = None) -> Path:
    """Resolve SYSTEM_PROMPT path from applications/agents. Uses DEFAULT_SKILL_PATH if skill_path is None."""
    path = (skill_path or DEFAULT_SKILL_PATH).strip().lstrip("/")
    full = REPO_ROOT / "agents" / path / PROMPT_FILENAME
    if not full.exists():
        raise FileNotFoundError(f"SYSTEM_PROMPT não encontrado: {full}")
    return full


def main() -> int:
    parser = argparse.ArgumentParser(description="DevOps Agent — IaC, CI/CD, deploy (skill em applications/agents)")
    parser.add_argument("--input", "-i", help="Arquivo JSON com message_envelope", default="-")
    parser.add_argument("--output", "-o", help="Arquivo de saída (response_envelope)", default="-")
    parser.add_argument("--skill-path", help=f"Skill path relativo a applications/agents (default: {DEFAULT_SKILL_PATH})", default=None)
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
        message["request_id"] = "devops-cli"
    if "input" not in message:
        message["input"] = message.get("context", {})
    skill_path = args.skill_path or ((message.get("input") or {}).get("context") or {}).get("skill_path")
    prompt_path = get_system_prompt_path(skill_path)

    logger.info("Chamando agente DevOps (SYSTEM_PROMPT: %s)", prompt_path)
    response = run_agent(
        system_prompt_path=prompt_path,
        message=message,
        role="DEVOPS",
    )

    out = json.dumps(response, ensure_ascii=False, indent=2)
    if args.output == "-":
        print(out)
    else:
        Path(args.output).write_text(out, encoding="utf-8")

    return 0 if response.get("status") in ("OK", "NEEDS_INFO") else 1


if __name__ == "__main__":
    sys.exit(main())
