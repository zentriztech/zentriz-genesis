"""
LEI 9 (AGENT_LLM_COMMUNICATION_ANALYSIS): state machine de tasks.
Ciclo de vida: PENDING → IN_PROGRESS → IN_REVIEW → DONE | REWORK (max 2) → BLOCKED.
"""
import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

VALID_TRANSITIONS: dict[str, list[str]] = {
    "PENDING": ["IN_PROGRESS"],
    "ASSIGNED": ["IN_PROGRESS"],
    "IN_PROGRESS": ["IN_REVIEW", "BLOCKED"],
    "IN_REVIEW": ["DONE", "QA_FAIL"],
    "QA_FAIL": ["IN_PROGRESS", "BLOCKED"],
    "DONE": [],
    "BLOCKED": ["PENDING", "ASSIGNED"],
}

MAX_REWORK_BEFORE_BLOCKED = 2


class TaskStateMachine:
    """
    Estado e transições por task (LEI 9).
    Rework (QA_FAIL → IN_PROGRESS) contado; após MAX_REWORK_BEFORE_BLOCKED, transição para BLOCKED.
    """

    def __init__(self, task_id: str, initial_state: str = "PENDING"):
        self.task_id = task_id
        self.state = initial_state
        self.rework_count = 0
        self.history: list[dict[str, Any]] = []

    def transition(self, new_state: str, reason: str = "") -> bool:
        allowed = VALID_TRANSITIONS.get(self.state, [])
        if new_state not in allowed:
            logger.error(
                "Transição inválida: %s de %s → %s (permitidas: %s)",
                self.task_id,
                self.state,
                new_state,
                allowed,
            )
            return False

        self.history.append({
            "from": self.state,
            "to": new_state,
            "reason": reason,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

        if new_state == "QA_FAIL":
            self.rework_count += 1
            if self.rework_count > MAX_REWORK_BEFORE_BLOCKED:
                self.state = "BLOCKED"
                self.history.append({
                    "from": "QA_FAIL",
                    "to": "BLOCKED",
                    "reason": f"Máximo de reworks atingido ({self.rework_count})",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                return True
            self.state = "IN_PROGRESS"
            return True

        self.state = new_state
        return True

    def can_transition(self, new_state: str) -> bool:
        return new_state in VALID_TRANSITIONS.get(self.state, [])
