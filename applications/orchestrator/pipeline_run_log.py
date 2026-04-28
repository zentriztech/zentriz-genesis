"""
Pipeline Run Log — histórico estruturado de execuções do pipeline.

Salva em PROJECT_FILES_ROOT/<project_id>/pipeline_run_log.json.
Cada entrada representa uma execução (run): início, parada, motivo, duração e métricas.
Sobrevive a restarts; novas entradas são appendadas, nunca sobrescritas.

Interface:
    prl = PipelineRunLog(project_id)
    prl.start_run(request_id, trigger="manual")
    prl.stop_run(reason="completed", metrics={"tasks_done": 5, "tasks_total": 11})
    prl.get_runs()   # lista de runs
"""
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

STOP_REASONS = frozenset({
    "completed",       # pipeline finalizou normalmente
    "accepted",        # usuário aceitou o projeto
    "stopped",         # usuário stopou manualmente
    "sigterm",         # sinal SIGTERM recebido
    "timeout",         # timeout de agent/task
    "error",           # exceção não tratada
    "api_unreachable", # API do backend inacessível por muito tempo
    "interrupted",     # processo encerrado abruptamente (detectado no próximo start)
})


class PipelineRunLog:
    """Mantém log append-only de execuções do pipeline para um projeto."""

    def __init__(self, project_id: str):
        self.project_id = project_id
        self._current_run_id: Optional[str] = None

    @property
    def _log_path(self) -> Path:
        root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
        return Path(root) / self.project_id / "pipeline_run_log.json"

    def _load(self) -> Dict[str, Any]:
        p = self._log_path
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception as e:
                logger.warning("[RunLog] Falha ao ler log: %s", e)
        return {"project_id": self.project_id, "schema_version": "1.0", "runs": []}

    def _save(self, data: Dict[str, Any]) -> None:
        p = self._log_path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def _now(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def start_run(self, request_id: str, trigger: str = "manual") -> str:
        """Registra início de run; marca runs anteriores sem stop como 'interrupted'."""
        data = self._load()
        runs: List[Dict[str, Any]] = data.setdefault("runs", [])

        # Fechar runs sem stop_time (crashes anteriores)
        for run in runs:
            if not run.get("stop_time"):
                run["stop_time"] = self._now()
                run["stop_reason"] = "interrupted"
                run["duration_sec"] = None
                logger.info(
                    "[RunLog] Run anterior sem stop marcada como interrupted: run_id=%s",
                    run.get("run_id"),
                )

        run_id = f"{self.project_id[:8]}-run-{len(runs) + 1:03d}"
        self._current_run_id = run_id
        now = self._now()
        runs.append({
            "run_id": run_id,
            "request_id": request_id,
            "trigger": trigger,
            "start_time": now,
            "stop_time": None,
            "stop_reason": None,
            "duration_sec": None,
            "metrics": {},
        })
        data["last_updated"] = now
        self._save(data)
        logger.info("[RunLog] Run iniciada: run_id=%s, trigger=%s", run_id, trigger)
        return run_id

    def stop_run(
        self,
        reason: str = "completed",
        metrics: Optional[Dict[str, Any]] = None,
        run_id: Optional[str] = None,
    ) -> None:
        """Registra fim da run atual (ou run_id específico)."""
        data = self._load()
        runs: List[Dict[str, Any]] = data.get("runs", [])
        target_id = run_id or self._current_run_id

        run = next((r for r in runs if r.get("run_id") == target_id and not r.get("stop_time")), None)
        if not run:
            # Fallback: última run sem stop
            run = next((r for r in reversed(runs) if not r.get("stop_time")), None)

        if not run:
            logger.warning("[RunLog] Nenhuma run aberta encontrada para fechar (reason=%s)", reason)
            return

        now = self._now()
        run["stop_time"] = now
        run["stop_reason"] = reason if reason in STOP_REASONS else "error"
        if run.get("start_time"):
            try:
                start = datetime.fromisoformat(run["start_time"].replace("Z", "+00:00"))
                stop = datetime.fromisoformat(now.replace("Z", "+00:00"))
                run["duration_sec"] = round((stop - start).total_seconds())
            except Exception:
                run["duration_sec"] = None
        if metrics:
            run["metrics"] = metrics
        data["last_updated"] = now
        self._save(data)
        logger.info(
            "[RunLog] Run fechada: run_id=%s, reason=%s, duration=%ss",
            run.get("run_id"), reason, run.get("duration_sec"),
        )
        self._current_run_id = None

    def get_runs(self) -> List[Dict[str, Any]]:
        return self._load().get("runs", [])

    def get_current_run_id(self) -> Optional[str]:
        return self._current_run_id
