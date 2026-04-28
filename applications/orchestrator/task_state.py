"""
task_state.py — Tasks State persistente (inspirado no Terraform State).

Salva em PROJECT_FILES_ROOT/<project_id>/.tasks-state.json o status de cada task,
sobrevivendo a rebuilds, restarts e timeouts do runner.

Interface:
    ts = TaskState(project_id)
    ts.load()                           # lê do disco
    ts.mark_done("TSK-BE-001")          # marca como DONE
    ts.is_terminal("TSK-BE-001")        # True se DONE/QA_PASS/QA_FAIL/BLOCKED
    ts.get_status("TSK-BE-001")         # retorna status atual ou None
    ts.save()                           # persiste no disco
    ts.sync_to_api(project_id)          # aplica state ao banco via API
    ts.to_seed_tasks(all_tasks)         # retorna tasks com status correto para seed
"""
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

TERMINAL_STATUSES = frozenset({"DONE", "QA_PASS", "QA_FAIL", "BLOCKED"})
ACTIVE_STATUSES   = frozenset({"IN_PROGRESS", "WAITING_REVIEW"})


class TaskState:
    """Gerencia o estado persistente das tasks de um projeto."""

    def __init__(self, project_id: str):
        self.project_id = project_id
        self._state: dict[str, dict[str, Any]] = {}   # task_id → {status, updated_at, ...}
        self._dirty = False

    # ── Paths ────────────────────────────────────────────────────────────────

    @property
    def _state_path(self) -> Path:
        root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
        return Path(root) / self.project_id / ".tasks-state.json"

    # ── Persistence ──────────────────────────────────────────────────────────

    def load(self) -> "TaskState":
        p = self._state_path
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                self._state = data.get("tasks", {})
                logger.info(
                    "[TaskState] Carregado: %d tasks, %d terminais — projeto=%s",
                    len(self._state),
                    sum(1 for t in self._state.values() if t.get("status") in TERMINAL_STATUSES),
                    self.project_id,
                )
            except Exception as e:
                logger.warning("[TaskState] Falha ao carregar state: %s", e)
                self._state = {}
        return self

    def save(self) -> None:
        p = self._state_path
        p.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "project_id": self.project_id,
            "schema_version": "1.0",
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "tasks": self._state,
        }
        p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self._dirty = False
        logger.debug("[TaskState] Salvo: %d tasks — %s", len(self._state), p)

    def save_if_dirty(self) -> None:
        if self._dirty:
            self.save()

    # ── State updates ─────────────────────────────────────────────────────────

    def set_status(self, task_id: str, status: str, **extra: Any) -> None:
        """Atualiza status; nunca rebaixa um status terminal."""
        current = self._state.get(task_id, {}).get("status")
        if current in TERMINAL_STATUSES and status not in TERMINAL_STATUSES:
            logger.debug("[TaskState] Ignorado: %s %s→%s (terminal preservado)", task_id, current, status)
            return
        self._state[task_id] = {
            "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        self._dirty = True

    def mark_done(self, task_id: str) -> None:
        self.set_status(task_id, "DONE")

    def mark_qa_pass(self, task_id: str) -> None:
        self.set_status(task_id, "QA_PASS")

    def mark_qa_fail(self, task_id: str) -> None:
        self.set_status(task_id, "QA_FAIL")

    # ── Queries ───────────────────────────────────────────────────────────────

    def get_status(self, task_id: str) -> str | None:
        return self._state.get(task_id, {}).get("status")

    def is_terminal(self, task_id: str) -> bool:
        return self.get_status(task_id) in TERMINAL_STATUSES

    def terminal_task_ids(self) -> set[str]:
        return {tid for tid, t in self._state.items() if t.get("status") in TERMINAL_STATUSES}

    def pending_task_ids(self, all_ids: list[str]) -> list[str]:
        """Retorna tasks ainda não terminadas, em ordem."""
        done = self.terminal_task_ids()
        return [tid for tid in all_ids if tid not in done]

    # ── Integration ───────────────────────────────────────────────────────────

    def to_seed_tasks(self, all_tasks: list[dict]) -> list[dict]:
        """
        Retorna all_tasks com status correto baseado no state.
        Tasks terminais mantêm seu status; as demais ficam ASSIGNED.
        Usado pelo _seed_tasks para não sobrescrever progresso.
        """
        result = []
        for t in all_tasks:
            tid = t.get("taskId") or t.get("task_id", "")
            saved_status = self.get_status(tid)
            if saved_status in TERMINAL_STATUSES:
                t = {**t, "status": saved_status}
            else:
                t = {**t, "status": "ASSIGNED"}
            result.append(t)
        return result

    def sync_from_api(self, tasks_from_api: list[dict]) -> None:
        """
        Sincroniza o state com o status atual do banco.
        Usado após uma chamada GET /tasks para manter state atualizado.
        """
        for t in tasks_from_api:
            tid = t.get("taskId") or t.get("task_id", "")
            api_status = t.get("status", "ASSIGNED")
            current = self.get_status(tid)
            # Só atualiza se o status da API for "mais avançado" (terminal > active > assigned)
            if current not in TERMINAL_STATUSES:
                self._state[tid] = {
                    "status": api_status,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                self._dirty = True
        self.save_if_dirty()
