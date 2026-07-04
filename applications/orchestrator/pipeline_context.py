"""
Acumulador de contexto ao longo do pipeline (AGENT_LLM_COMMUNICATION_ANALYSIS).
Garante que cada agente receba os inputs corretos: spec_raw, product_spec,
engineer_proposal, charter, backlog, artefatos já produzidos.
LEI 11: save_checkpoint / load_checkpoint para pipeline resumível.
"""
from __future__ import annotations   # T-02: permite `str | None` mesmo em Python 3.9 (testes locais)

import functools
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ── Type Policy (T-02) ────────────────────────────────────────────────────────
# Fonte: applications/agents/policies/project_types.yaml
# Consumidores: build_inputs_for_cto/engineer/pm/dev via inputs["type_policy"].
# Precedência: CONTRACT LAW > user Delta > type_policy > spec (ver policies/README.md §3).

_POLICY_PATH = Path(__file__).resolve().parent.parent / "agents" / "policies" / "project_types.yaml"

# EMBEDDED_DEFAULT: fallback quando YAML não existe (dev/staging antes de commit).
# NUNCA usar como política real — dispara REVISION obrigatória (blocks_generation=True).
_EMBEDDED_DEFAULT_POLICY = {
    "version": "0.0.0-fallback",
    "type_aliases": {},
    "defaults": {},
    "groups": {},
    "types": {
        "_default": {
            "inherit_from": None,
            "labels": {"pt_br": "🚫 Fallback embutido", "en": "Embedded fallback"},
            "scaffold": [],
            "required_routes": {"strict": [], "expected": []},
            "required_components": [],
            "forbidden_patterns": ["*"],
            "fingerprint": {
                "required_tokens": {"strong": [], "soft": []},
                "forbidden_tokens": [],
                "synonyms_pt_br": {},
            },
            "stack_when_charter_silent": [],
            "smell_signals": [],
            "meta": {"requires_runbook": False, "warn_on_default": True, "blocks_generation": True},
        },
    },
}


@functools.lru_cache(maxsize=1)
def _load_type_policy() -> dict:
    """
    Carrega applications/agents/policies/project_types.yaml uma única vez por processo.
    YAML ausente → EMBEDDED_DEFAULT + log ERROR (NÃO crasha o pipeline).
    """
    try:
        import yaml  # pyyaml — dep já usada no runner
    except ImportError:
        logger.error("[type_policy] pyyaml não instalado; usando EMBEDDED_DEFAULT")
        return _EMBEDDED_DEFAULT_POLICY
    if not _POLICY_PATH.exists():
        logger.error("[type_policy] YAML não encontrado em %s; usando EMBEDDED_DEFAULT", _POLICY_PATH)
        return _EMBEDDED_DEFAULT_POLICY
    try:
        with open(_POLICY_PATH, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        # Sanity mínima
        if "types" not in data or "_default" not in data.get("types", {}):
            logger.error("[type_policy] YAML sem 'types._default'; usando EMBEDDED_DEFAULT")
            return _EMBEDDED_DEFAULT_POLICY
        return data
    except Exception as e:  # noqa: BLE001
        logger.error("[type_policy] falha ao carregar %s: %s; usando EMBEDDED_DEFAULT", _POLICY_PATH, e)
        return _EMBEDDED_DEFAULT_POLICY


def _resolve_type(raw_type: Optional[str]) -> tuple:
    """
    Aplica type_aliases e retorna (canonical_type_id, policy_dict).
    - raw vazio ou desconhecido → ("_default", policy_do__default).
    - raw em aliases → resolve para canônico.
    - raw canônico direto → retorna como está.
    """
    policy = _load_type_policy()
    raw = (raw_type or "").strip()
    if not raw:
        return "_default", policy["types"]["_default"]
    canonical = policy.get("type_aliases", {}).get(raw, raw)
    types = policy.get("types", {})
    if canonical in types:
        return canonical, types[canonical]
    logger.warning("[type_policy] tipo '%s' desconhecido (nem canônico nem alias); resolvido para _default", raw)
    return "_default", types["_default"]


def _build_type_policy_input(raw_type: Optional[str]) -> dict:
    """
    Monta o payload injetado como inputs["type_policy"] nos prompts dos agentes.
    Inclui enforcement_mode (T-02f): 'warn' (default) ou 'blocker'.

    T-12 observabilidade: emite log estruturado type_policy_resolved a cada chamada.
    Ferramenta downstream (endpoint /api/reports/type-compliance) parseia esse log.
    """
    canonical, pol = _resolve_type(raw_type)
    enforcement = "blocker" if os.environ.get("POLICY_ENFORCEMENT_ENABLED", "false").lower() == "true" else "warn"
    version = _load_type_policy().get("version", "unknown")

    # T-12: log estruturado — formato JSON single-line para parsing fácil
    try:
        logger.info(
            "type_policy_resolved %s",
            json.dumps({
                "event": "type_policy_resolved",
                "resolved_from": raw_type or "",
                "canonical_type": canonical,
                "enforcement_mode": enforcement,
                "policy_version": version,
                "fallback_default": canonical == "_default",
                "blocks_generation": bool(pol.get("meta", {}).get("blocks_generation", False)),
            }),
        )
    except Exception:
        pass  # log é aditivo — nunca bloqueia execução

    return {
        "canonical_type": canonical,
        "resolved_from": raw_type or "",
        "enforcement_mode": enforcement,
        "policy_version": version,
        "policy": pol,
    }


class PipelineContext:
    """
    Acumula contexto do pipeline para montar inputs por agente/modo.
    Runner preenche ao longo do fluxo (CTO spec → Engineer → CTO → PM → seed → Monitor Loop).
    """

    def __init__(self, project_id: str):
        self.project_id = project_id
        self.connect_version = "1.0.0"
        self.spec_raw = ""
        self.product_spec = ""
        self.product_spec_template = ""
        self.engineer_proposal = ""
        self.charter = ""
        self.backlog = ""
        # T10-fix (2026-07-02): default None em vez de "backend".
        # Motivo: T10 usa isso como cache. Se boot inicializar como "backend", o cache
        # ganha antes do YAML do Engineer ser lido → runner sempre roda PM Backend
        # mesmo em projeto Web puro (bug reproduzido no projeto 1f5feb4f-6ced-4f3d-9d70-767506bcce9c).
        # None força T10 a chamar infer_pm_module que lê o YAML determinístico.
        self.current_module: "str | None" = None
        self.current_task: dict[str, Any] = {}
        self.artifacts: dict[str, str] = {}  # path -> content
        self.connect_artifacts: dict[str, str] = {}  # project/connect/... -> content
        self.completed_tasks: list[str] = []
        self.current_step: int = 0  # LEI 11: etapa atual para retomada (0 = início)
        self.project_type: str = ""  # e.g. "backend_api", "frontend_webapp", "landing_page"
        # T-03f: em Evolution, tipo do Charter pai — usado pelo Gate T-TYPE-COMPLIANCE-EVO do CTO
        # para detectar transições silenciosas de tipo. Vazio quando não é Evolution.
        self.previous_project_type: str = ""
        self.product_id: str = ""    # ID do produto ao qual este projeto pertence
        self.linked_projects_context: str = ""  # Contexto dos projetos linkados (para o CTO)
        # Detected backend stack — cached to avoid repeated LLM calls per task
        # {"language": "python"|"nodejs"|..., "source": "pm_backlog_disk"|..., "confidence": "high"|"medium"|"low"}
        self.backend_stack: dict | None = None

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
        if self.project_type:
            inputs["project_type"] = self.project_type
        # T-02: injetar policy resolvida (canônico + tipo → política técnica + enforcement_mode)
        inputs["type_policy"] = _build_type_policy_input(self.project_type)
        # T-03f: em Evolution, propagar tipo do Charter pai para o Gate T-TYPE-COMPLIANCE-EVO
        if self.previous_project_type:
            inputs["previous_project_type"] = self.previous_project_type
        if self.linked_projects_context:
            inputs["linked_projects_context"] = self.linked_projects_context
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
        if self.project_type:
            inputs["project_type"] = self.project_type
        # T-02: policy é obrigatória — Engineer deriva arquitetura obedecendo required_routes.strict
        inputs["type_policy"] = _build_type_policy_input(self.project_type)
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
        if self.project_type:
            inputs["project_type"] = self.project_type
        # T-02: policy — PM seed backlog cobrindo required_routes.strict + required_components
        inputs["type_policy"] = _build_type_policy_input(self.project_type)
        if self.engineer_proposal:
            inputs["engineer_proposal"] = self.engineer_proposal
        if cto_questionamentos:
            inputs["cto_questionamentos"] = cto_questionamentos
        # Contexto de projetos linkados — PM precisa para decomposição correta de tasks de integração
        if self.linked_projects_context:
            inputs["linked_projects_context"] = self.linked_projects_context
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
        if self.project_type:
            inputs["project_type"] = self.project_type
        # T-02: policy — Wave 1 (T-07) codifica precedência nos Dev prompts;
        # Wave 0 apenas transporta o payload para não retrabalhar depois.
        inputs["type_policy"] = _build_type_policy_input(self.project_type)
        if code_refs:
            inputs["code_refs"] = code_refs
        # Contexto de projetos linkados — Dev precisa para saber endpoints, schemas e autenticação do backend
        if self.linked_projects_context:
            inputs["linked_projects_context"] = self.linked_projects_context
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

    def register_connect_artifact(self, path: str, content: str) -> None:
        if path:
            self.connect_artifacts[path] = content
            self.add_artifact(path, content)

    def save_checkpoint(self, storage_path: str | Path) -> None:
        """
        LEI 11: Persiste o estado atual do contexto para retomada após falha.
        Grava em storage_path / project_id / checkpoint.json.
        """
        path = Path(storage_path) / self.project_id / "checkpoint.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        checkpoint = {
            "project_id": self.project_id,
            "connect_version": self.connect_version,
            "spec_raw": self.spec_raw,
            "product_spec": self.product_spec,
            "product_spec_template": self.product_spec_template,
            "engineer_proposal": self.engineer_proposal,
            "charter": self.charter,
            "backlog": self.backlog,
            "current_module": self.current_module,
            "current_task": self.current_task,
            "artifacts": self.artifacts,
            "connect_artifacts": self.connect_artifacts,
            "completed_tasks": self.completed_tasks,
            "current_step": self.current_step,
            "project_type": self.project_type,
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
        ctx.connect_version = data.get("connect_version", "1.0.0")
        ctx.spec_raw = data.get("spec_raw", "")
        ctx.product_spec = data.get("product_spec", "")
        ctx.product_spec_template = data.get("product_spec_template", "")
        ctx.engineer_proposal = data.get("engineer_proposal", "")
        ctx.charter = data.get("charter", "")
        ctx.backlog = data.get("backlog", "")
        # T10-fix: preservar None quando checkpoint não tem current_module
        # (checkpoints antigos com "backend" hardcoded serão sobrescritos após 1ª inferência real).
        _cm = data.get("current_module")
        ctx.current_module = _cm if _cm in ("web", "backend", "mobile", "fullstack") else None
        ctx.current_task = data.get("current_task") or {}
        ctx.artifacts = data.get("artifacts") or {}
        ctx.connect_artifacts = data.get("connect_artifacts") or {}
        ctx.completed_tasks = data.get("completed_tasks") or []
        ctx.current_step = data.get("current_step", 0)
        ctx.project_type = data.get("project_type", "")
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
