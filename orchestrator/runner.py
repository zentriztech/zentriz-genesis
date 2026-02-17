"""
Runner do orquestrador: spec -> CTO (Charter) -> PM Backend (backlog).
Persiste estado em orchestrator/state/ e emite eventos conforme schemas.
Uso: python -m orchestrator.runner --spec spec/PRODUCT_SPEC.md
"""
import argparse
import json
import logging
import os
import sys
from pathlib import Path
from datetime import datetime

# Carregar .env da raiz
REPO_ROOT = Path(__file__).resolve().parent.parent
_dotenv = REPO_ROOT / ".env"
if _dotenv.exists():
    from dotenv import load_dotenv
    load_dotenv(_dotenv)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

STATE_DIR = REPO_ROOT / "orchestrator" / "state"
EVENTS_DIR = REPO_ROOT / "orchestrator" / "events" / "schemas"


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def load_spec(spec_path: Path) -> str:
    path = spec_path if spec_path.is_absolute() else REPO_ROOT / spec_path
    if not path.exists():
        raise FileNotFoundError(f"Spec não encontrada: {path}")
    return path.read_text(encoding="utf-8")


def call_cto(spec_ref: str, request_id: str) -> dict:
    from orchestrator.agents.runtime import run_agent
    cto_prompt = REPO_ROOT / "agents" / "cto" / "SYSTEM_PROMPT.md"
    message = {
        "request_id": request_id,
        "input": {
            "spec_ref": spec_ref,
            "context": {},
            "task": {},
            "constraints": {},
            "artifacts": [],
        },
    }
    return run_agent(system_prompt_path=cto_prompt, message=message, role="CTO")


def call_pm_backend(spec_ref: str, charter_summary: str, request_id: str) -> dict:
    from orchestrator.agents.runtime import run_agent
    pm_prompt = REPO_ROOT / "agents" / "pm" / "backend" / "SYSTEM_PROMPT.md"
    message = {
        "request_id": request_id,
        "input": {
            "spec_ref": spec_ref,
            "context": {"charter_summary": charter_summary},
            "task": {},
            "constraints": {},
            "artifacts": [],
        },
    }
    return run_agent(system_prompt_path=pm_prompt, message=message, role="PM_BACKEND")


def persist_state(spec_ref: str, charter: dict, backlog: dict, events: list) -> None:
    ensure_state_dir()
    state = {
        "spec_ref": spec_ref,
        "charter": charter,
        "backlog": backlog,
        "events": events,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    (STATE_DIR / "current_project.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def emit_event(event_type: str, payload: dict, request_id: str) -> None:
    ensure_state_dir()
    event = {
        "event_type": event_type,
        "request_id": request_id,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "payload": payload,
    }
    events_file = STATE_DIR / "events.jsonl"
    with open(events_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
    logger.info("Evento emitido: %s", event_type)


def main() -> int:
    parser = argparse.ArgumentParser(description="Runner: spec -> CTO -> PM Backend -> backlog")
    parser.add_argument("--spec", "-s", default="spec/PRODUCT_SPEC.md", help="Caminho para o spec (FR/NFR)")
    args = parser.parse_args()

    spec_ref = args.spec
    request_id = f"runner-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"

    if not (REPO_ROOT / spec_ref).exists():
        logger.error("Spec não encontrada: %s", spec_ref)
        return 1

    logger.info("Lendo spec: %s", spec_ref)
    load_spec(Path(spec_ref))

    # 1) CTO -> Charter
    logger.info("Chamando agente CTO...")
    cto_response = call_cto(spec_ref, request_id)
    charter_summary = cto_response.get("summary", "")
    charter_artifacts = cto_response.get("artifacts", [])
    logger.info("CTO status: %s", cto_response.get("status"))

    # Persistir Charter (se o CTO retornou conteúdo em artifacts)
    charter_path = REPO_ROOT / "docs" / "PROJECT_CHARTER.md"
    if charter_artifacts and charter_summary:
        charter_path.parent.mkdir(parents=True, exist_ok=True)
        charter_path.write_text(f"# Project Charter (gerado pelo CTO)\n\n{charter_summary}\n", encoding="utf-8")
        logger.info("Charter persistido: %s", charter_path)

    emit_event("project.created", {"spec_ref": spec_ref, "constraints": {}}, request_id)

    # 2) PM Backend -> backlog
    logger.info("Chamando agente PM Backend...")
    pm_response = call_pm_backend(spec_ref, charter_summary, request_id)
    backlog_summary = pm_response.get("summary", "")
    backlog_artifacts = pm_response.get("artifacts", [])
    logger.info("PM Backend status: %s", pm_response.get("status"))

    emit_event("module.planned", {"spec_ref": spec_ref, "backlog_summary": backlog_summary[:200]}, request_id)

    # 3) Persistir estado
    persist_state(
        spec_ref=spec_ref,
        charter={"summary": charter_summary, "artifacts": charter_artifacts},
        backlog={"summary": backlog_summary, "artifacts": backlog_artifacts},
        events=["project.created", "module.planned"],
    )
    logger.info("Estado persistido em orchestrator/state/current_project.json")

    print(json.dumps({
        "request_id": request_id,
        "spec_ref": spec_ref,
        "cto_status": cto_response.get("status"),
        "pm_status": pm_response.get("status"),
        "charter_path": str(charter_path),
        "state_path": str(STATE_DIR / "current_project.json"),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
