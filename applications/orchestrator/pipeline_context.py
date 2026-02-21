"""
Acumulador de contexto ao longo do pipeline (AGENT_LLM_COMMUNICATION_ANALYSIS).
Garante que cada agente receba os inputs corretos: spec_raw, product_spec,
engineer_proposal, charter, backlog, artefatos já produzidos.
LEI 11: save_checkpoint / load_checkpoint para pipeline resumível.
"""
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class PipelineContext:
    """
    Acumula contexto do pipeline para montar inputs por agente/modo.
    Runner preenche ao longo do fluxo (CTO spec → Engineer → CTO → PM → seed → Monitor Loop).
    """

    def __init__(self, project_id: str):
        self.project_id = project_id
        self.spec_raw = ""
        self.product_spec = ""
        self.product_spec_template = ""
        self.engineer_proposal = ""
        self.charter = ""
        self.backlog = ""
        self.current_module = "backend"
        self.current_task: dict[str, Any] = {}
        self.artifacts: dict[str, str] = {}  # path -> content
        self.completed_tasks: list[str] = []
        self.current_step: int = 0  # LEI 11: etapa atual para retomada (0 = início)

    def set_spec_raw(self, value: str) -> None:
        self.spec_raw = (value or "")[:30000]

    def set_product_spec(self, value: str) -> None:
        self.product_spec = (value or "")[:20000]

    def set_product_spec_template(self, value: str) -> None:
        self.product_spec_template = (value or "")[:15000]

    def set_engineer_proposal(self, value: str) -> None:
        self.engineer_proposal = (value or "")[:15000]

    def set_charter(self, value: str) -> None:
        self.charter = (value or "")[:15000]

    def set_backlog(self, value: str) -> None:
        self.backlog = (value or "")[:20000]

    def set_current_task(self, task: dict[str, Any]) -> None:
        self.current_task = task or {}

    def add_artifact(self, path: str, content: str) -> None:
        if path:
            self.artifacts[path] = content

    def add_completed_task(self, task_id: str) -> None:
        if task_id and task_id not in self.completed_tasks:
            self.completed_tasks.append(task_id)

    def build_inputs_for_cto(self, mode: str, backlog_summary: str = "", validate_backlog_only: bool = False) -> dict:
        inputs = {
            "spec_ref": self.project_id,
            "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        }
        if self.spec_raw:
            inputs["spec_raw"] = self.spec_raw
            inputs["product_spec"] = self.product_spec or self.spec_raw[:20000]
        if self.product_spec_template:
            inputs["spec_template"] = self.product_spec_template
        if self.engineer_proposal:
            inputs["engineer_stack_proposal"] = self.engineer_proposal
        if backlog_summary:
            inputs["backlog_summary"] = backlog_summary[:15000]
        if validate_backlog_only:
            inputs["validate_backlog_only"] = True
        return inputs

    def build_inputs_for_engineer(self, cto_questionamentos: str | None = None) -> dict:
        inputs = {
            "spec_ref": self.project_id,
            "product_spec": self.product_spec,
            "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        }
        if cto_questionamentos:
            inputs["cto_questionamentos"] = cto_questionamentos
        return inputs

    def build_inputs_for_pm(self, cto_questionamentos: str | None = None) -> dict:
        inputs = {
            "spec_ref": self.project_id,
            "charter": self.charter,
            "charter_summary": self.charter,
            "module": self.current_module,
            "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        }
        if self.engineer_proposal:
            inputs["engineer_proposal"] = self.engineer_proposal
        if cto_questionamentos:
            inputs["cto_questionamentos"] = cto_questionamentos
        return inputs

    def build_inputs_for_dev(
        self,
        task: dict,
        task_description: str,
        code_refs: list | None = None,
        existing_artifacts: list | None = None,
    ) -> dict:
        inputs = {
            "spec_ref": self.project_id,
            "charter": self.charter,
            "charter_summary": self.charter,
            "backlog": self.backlog,
            "backlog_summary": self.backlog,
            "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        }
        if code_refs:
            inputs["code_refs"] = code_refs
        return inputs

    def get_relevant_artifacts_for_task(self, task_id: str, max_content: int = 8000) -> list[dict]:
        """Retorna artefatos existentes formatados para existing_artifacts (path + content)."""
        out = []
        for path, content in self.artifacts.items():
            if len(content) > max_content:
                content = content[:max_content] + "\n... [truncado]"
            out.append({"path": path, "content": content})
        return out

    MAX_TOTAL_DEPENDENCY_CHARS = 60_000  # ~15K tokens total (LEI 7)

    def _extract_interfaces(self, code: str) -> str:
        """
        LEI 7: Para arquivos muito grandes, retorna apenas exports, types, interfaces e assinaturas.
        """
        lines = code.split("\n")
        relevant = []
        for line in lines:
            stripped = line.strip()
            if any(
                kw in stripped
                for kw in (
                    "export ",
                    "import ",
                    "interface ",
                    "type ",
                    "enum ",
                    "class ",
                    "async function",
                    "function ",
                    "const ",
                    "extends",
                    "implements",
                    "}: ",
                    "return type",
                )
            ):
                relevant.append(line)
        return "// [INTERFACE RESUMIDA — apenas assinaturas e types]\n" + "\n".join(relevant)

    def get_dependency_code(self, depends_on: list[str], max_per_file: int = 8000) -> dict[str, str]:
        """
        LEI 7: Retorna APENAS o código que esta tarefa precisa.
        Se um arquivo excede 20K chars, envia apenas interfaces/assinaturas.
        Total limitado a MAX_TOTAL_DEPENDENCY_CHARS (~15K tokens).
        """
        result: dict[str, str] = {}
        total_chars = 0
        FILE_INTERFACE_THRESHOLD = 20_000

        for path in depends_on or []:
            if path not in self.artifacts:
                continue
            content = self.artifacts[path]
            if len(content) > FILE_INTERFACE_THRESHOLD:
                content = self._extract_interfaces(content)
            if len(content) > max_per_file:
                content = content[:max_per_file] + "\n... [truncado]"
            if total_chars + len(content) > self.MAX_TOTAL_DEPENDENCY_CHARS:
                logger.warning(
                    "Contexto de dependências excedeu %s chars (LEI 7). Cortando em %s arquivos de %s solicitados.",
                    self.MAX_TOTAL_DEPENDENCY_CHARS,
                    len(result),
                    len(depends_on or []),
                )
                break
            result[path] = content
            total_chars += len(content)
        return result

    def register_artifact(self, path: str, content: str, task_id: str = "") -> None:
        """Registra artefato aprovado (ex.: após QA_PASS). Alias para add_artifact + add_completed_task."""
        self.add_artifact(path, content)
        if task_id:
            self.add_completed_task(task_id)

    def save_checkpoint(self, storage_path: str | Path) -> None:
        """
        LEI 11: Persiste o estado atual do contexto para retomada após falha.
        Grava em storage_path / project_id / checkpoint.json.
        """
        path = Path(storage_path) / self.project_id / "checkpoint.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        checkpoint = {
            "project_id": self.project_id,
            "spec_raw": self.spec_raw,
            "product_spec": self.product_spec,
            "product_spec_template": self.product_spec_template,
            "engineer_proposal": self.engineer_proposal,
            "charter": self.charter,
            "backlog": self.backlog,
            "current_module": self.current_module,
            "current_task": self.current_task,
            "artifacts": self.artifacts,
            "completed_tasks": self.completed_tasks,
            "current_step": self.current_step,
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        with path.open("w", encoding="utf-8") as f:
            json.dump(checkpoint, f, ensure_ascii=False, indent=2)
        logger.info("Checkpoint salvo (LEI 11): step=%s, tasks=%s", self.current_step, len(self.completed_tasks))

    @classmethod
    def load_checkpoint(cls, storage_path: str | Path, project_id: str) -> "PipelineContext | None":
        """
        LEI 11: Restaura contexto de um checkpoint salvo.
        Retorna None se o arquivo não existir.
        """
        path = Path(storage_path) / project_id / "checkpoint.json"
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        ctx = cls(project_id)
        ctx.spec_raw = data.get("spec_raw", "")
        ctx.product_spec = data.get("product_spec", "")
        ctx.product_spec_template = data.get("product_spec_template", "")
        ctx.engineer_proposal = data.get("engineer_proposal", "")
        ctx.charter = data.get("charter", "")
        ctx.backlog = data.get("backlog", "")
        ctx.current_module = data.get("current_module", "backend")
        ctx.current_task = data.get("current_task") or {}
        ctx.artifacts = data.get("artifacts") or {}
        ctx.completed_tasks = data.get("completed_tasks") or []
        ctx.current_step = data.get("current_step", 0)
        logger.info("Checkpoint restaurado (LEI 11): step=%s, tasks=%s", ctx.current_step, len(ctx.completed_tasks))
        return ctx


def validate_backlog_tasks_max_files(tasks: list[dict], max_files_per_task: int = 3) -> list[str]:
    """
    LEI 8: Valida que nenhuma task produz mais que max_files_per_task arquivos.
    Task pode ter estimated_files, files_to_create ou lista equivalente.
    Retorna lista de mensagens de erro (vazia se OK).
    """
    issues: list[str] = []
    for task in tasks or []:
        estimated = task.get("estimated_files") or task.get("files_to_create") or []
        if isinstance(estimated, str):
            estimated = [estimated] if estimated else []
        if len(estimated) > max_files_per_task:
            task_id = task.get("id") or task.get("task_id") or task.get("taskId") or "?"
            issues.append(
                f"TASK {task_id}: produz {len(estimated)} arquivos (máximo {max_files_per_task}). Decompor em sub-tarefas."
            )
    return issues
