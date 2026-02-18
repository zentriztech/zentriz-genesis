"""
Runner do orquestrador: spec -> CTO (Charter) -> PM Backend (backlog).
Persiste estado em orchestrator/state/ e emite eventos conforme schemas.
Uso: python -m orchestrator.runner --spec spec/PRODUCT_SPEC.md

Quando as variáveis API_BASE_URL, PROJECT_ID e GENESIS_API_TOKEN estiverem
definidas, o runner atualiza o projeto na API: started_at ao iniciar e
completed_at + status ao concluir (PATCH /api/projects/:id).
"""
import argparse
import json
import logging
import os
import sys
import urllib.request
from pathlib import Path
from datetime import datetime

# Raiz do repo: runner está em applications/orchestrator/ (host) ou orchestrator/ (container)
_here = Path(__file__).resolve().parent  # applications/orchestrator ou /app/orchestrator
_repo = _here.parent.parent  # applications ou repo root
REPO_ROOT = _repo.parent if _repo.name == "applications" else _repo
# No host: applications/ existe; no container: layout é /app/agents, /app/orchestrator
APPLICATIONS_ROOT = REPO_ROOT / "applications" if (REPO_ROOT / "applications").exists() else REPO_ROOT

_dotenv = REPO_ROOT / ".env"
if _dotenv.exists():
    from dotenv import load_dotenv
    load_dotenv(_dotenv)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

STATE_DIR = APPLICATIONS_ROOT / "orchestrator" / "state"
EVENTS_DIR = APPLICATIONS_ROOT / "orchestrator" / "events" / "schemas"


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def load_spec(spec_path: Path) -> str:
    path = spec_path if spec_path.is_absolute() else REPO_ROOT / spec_path
    if not path.exists():
        raise FileNotFoundError(f"Spec não encontrada: {path}")
    return path.read_text(encoding="utf-8")


def _agents_root() -> Path:
    return APPLICATIONS_ROOT / "agents"


def call_cto(spec_ref: str, request_id: str) -> dict:
    from orchestrator.agents.runtime import run_agent
    cto_prompt = _agents_root() / "cto" / "SYSTEM_PROMPT.md"
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
    pm_prompt = _agents_root() / "pm" / "backend" / "SYSTEM_PROMPT.md"
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


def _patch_project(body: dict) -> bool:
    """Envia PATCH /api/projects/:id quando API_BASE_URL, PROJECT_ID e GENESIS_API_TOKEN estão definidos."""
    base = os.environ.get("API_BASE_URL")
    project_id = os.environ.get("PROJECT_ID")
    token = os.environ.get("GENESIS_API_TOKEN")
    if not base or not project_id or not token:
        return False
    url = f"{base.rstrip('/')}/api/projects/{project_id}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if 200 <= resp.status < 300:
                logger.info("Projeto atualizado na API: %s", body)
                return True
    except Exception as e:
        logger.warning("Falha ao atualizar projeto na API: %s", e)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Runner: spec -> CTO -> PM Backend -> backlog")
    default_spec = "project/spec/PRODUCT_SPEC.md" if (REPO_ROOT / "project" / "spec" / "PRODUCT_SPEC.md").exists() else "spec/PRODUCT_SPEC.md"
    parser.add_argument("--spec", "-s", default=default_spec, help="Caminho para o spec (FR/NFR)")
    args = parser.parse_args()

    spec_ref = args.spec
    request_id = f"runner-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"

    if not (REPO_ROOT / spec_ref).exists():
        logger.error("Spec não encontrada: %s", spec_ref)
        return 1

    logger.info("Lendo spec: %s", spec_ref)
    load_spec(Path(spec_ref))

    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
    _patch_project({"started_at": now_iso})

    # 1) CTO -> Charter
    logger.info("Chamando agente CTO...")
    cto_response = call_cto(spec_ref, request_id)
    charter_summary = cto_response.get("summary", "")
    charter_artifacts = cto_response.get("artifacts", [])
    logger.info("CTO status: %s", cto_response.get("status"))

    # Persistir Charter em orchestrator/state/ (não em project/docs/)
    charter_path = STATE_DIR / "PROJECT_CHARTER.md"
    if charter_artifacts and charter_summary:
        ensure_state_dir()
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

    completed_at_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
    _patch_project({"status": "completed", "completed_at": completed_at_iso})

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
