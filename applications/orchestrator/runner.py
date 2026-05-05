"""
Runner do orquestrador: spec -> Engineer -> CTO (Charter) -> PM (backlog).
Quando API e PROJECT_ID estão definidos: após PM faz seed de tarefas e
entra no Monitor Loop (Fase 2), que aciona Dev/QA/DevOps conforme estado das tasks
até o usuário aceitar o projeto (POST /accept) ou parar (SIGTERM/stopped).
Persiste estado em orchestrator/state/ e emite eventos conforme schemas.
Uso: python -m orchestrator.runner --spec spec/PRODUCT_SPEC.md
"""
import argparse
import json
import logging
import os
import re
import signal
import sys
import threading
import time
import traceback as _tb
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from datetime import datetime, timezone

_shutdown_requested = False


class _NullLock:
    """No-op context manager used when monitor_parallel=False to avoid branching."""
    def __enter__(self): return self
    def __exit__(self, *_): pass


def _sigterm_handler(_signum, _frame):
    global _shutdown_requested
    _shutdown_requested = True
    logger = logging.getLogger(__name__)
    logger.info("[Pipeline] SIGTERM recebido; encerrando Monitor Loop.")

def _get_summary_human(*a, **k):
    from orchestrator.dialogue import get_summary_human
    return get_summary_human(*a, **k)


def _project_storage():
    try:
        from orchestrator import project_storage
        return project_storage
    except ImportError:
        return None

_here = Path(__file__).resolve().parent
_repo = _here.parent.parent
REPO_ROOT = _repo.parent if _repo.name == "applications" else _repo
APPLICATIONS_ROOT = REPO_ROOT / "applications" if (REPO_ROOT / "applications").exists() else REPO_ROOT

_dotenv = REPO_ROOT / ".env"
if _dotenv.exists():
    from dotenv import load_dotenv
    load_dotenv(_dotenv)

class _ProjectFilter(logging.Filter):
    """Injects project_id into every log record so structured formatters can include it."""
    _project_id: str | None = None

    @classmethod
    def set_project_id(cls, pid: str | None) -> None:
        cls._project_id = pid

    def filter(self, record: logging.LogRecord) -> bool:
        record.project_id = self._project_id or "—"  # type: ignore[attr-defined]
        return True


_log_level = os.environ.get("LOG_LEVEL", "INFO")
_log_format = os.environ.get("LOG_FORMAT", "text")
if _log_format == "json":
    import json as _json_mod
    class _JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            return _json_mod.dumps({
                "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
                "level": record.levelname,
                "project_id": getattr(record, "project_id", "—"),
                "logger": record.name,
                "msg": record.getMessage(),
            }, ensure_ascii=False)
    _handler = logging.StreamHandler()
    _handler.setFormatter(_JsonFormatter())
    logging.basicConfig(level=_log_level, handlers=[_handler])
else:
    logging.basicConfig(
        level=_log_level,
        format="%(asctime)s %(levelname)s [%(project_id)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

for _h in logging.root.handlers:
    _h.addFilter(_ProjectFilter())

logger = logging.getLogger(__name__)

STATE_DIR = APPLICATIONS_ROOT / "orchestrator" / "state"
EVENTS_DIR = APPLICATIONS_ROOT / "orchestrator" / "events" / "schemas"

SHOW_TRACEBACK = os.environ.get("SHOW_TRACEBACK", "true").strip().lower() in ("1", "true", "yes")


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def _generate_quality_report(
    project_id: str | None,
    spec_ref: str,
    pipeline_ctx: "PipelineContext | None",
    started_at: str,
    completed_at: str,
    tasks_done: int,
    tasks_total: int,
    token_data: dict | None = None,
) -> str:
    """Generates a markdown quality report and saves it to project files."""
    lines = [
        f"# Relatório de Qualidade — Pipeline Genesis",
        f"",
        f"**Project ID:** `{project_id or 'N/A'}`  ",
        f"**Spec:** `{spec_ref}`  ",
        f"**Gerado em:** {completed_at}",
        f"",
        f"---",
        f"",
        f"## Resumo de Execução",
        f"",
        f"| Item | Valor |",
        f"|------|-------|",
        f"| Início | {started_at} |",
        f"| Conclusão | {completed_at} |",
        f"| Tasks concluídas | {tasks_done}/{tasks_total} |",
    ]
    if token_data:
        lines.extend([
            f"| Tokens entrada | {token_data.get('input', 0):,} |",
            f"| Tokens saída | {token_data.get('output', 0):,} |",
            f"| Custo estimado | ~${token_data.get('cost_usd', 0):.2f} USD |",
        ])
    lines.extend([
        f"",
        f"---",
        f"",
        f"## Cobertura de Tasks",
        f"",
    ])
    if pipeline_ctx and pipeline_ctx.completed_tasks:
        for tid in sorted(pipeline_ctx.completed_tasks):
            lines.append(f"- [x] {tid}")
    else:
        lines.append(f"_{tasks_done} tasks concluídas (detalhes em docs/pm/web/BACKLOG.md)_")
    lines.extend([
        f"",
        f"---",
        f"",
        f"## Artefatos Gerados",
        f"",
        f"- `docs/` — Documentação técnica (spec, charter, backlog, QA reports)",
        f"- `apps/` — Código-fonte do produto",
        f"- `project/start.sh` — Script de execução local",
        f"",
        f"---",
        f"",
        f"_Relatório gerado automaticamente pelo Genesis Pipeline_",
    ])
    report = "\n".join(lines)

    if project_id:
        storage = _project_storage()
        if storage and storage.is_enabled():
            try:
                storage.write_doc(project_id, "reports", "quality_report", report, title="Relatório de Qualidade")
            except Exception as e:
                logger.warning("[Quality Report] Falha ao salvar relatório: %s", e)

    return report


def _record_agent_metrics(
    project_id: str | None,
    agent: str,
    response: dict,
    task_id: str | None = None,
    round_num: int = 1,
) -> None:
    """Fire-and-forget: POST token metrics to the API after each agent call."""
    if not project_id:
        return
    base = os.environ.get("API_BASE_URL", "").strip()
    token = os.environ.get("GENESIS_API_TOKEN", "").strip()
    if not base or not token:
        return
    input_tokens = response.get("_input_tokens") or 0
    output_tokens = response.get("_output_tokens") or 0
    if not input_tokens and not output_tokens:
        return  # no usage data — skip (e.g. running in no-API mode)
    try:
        payload = json.dumps({
            "agent": agent,
            "taskId": task_id,
            "round": round_num,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "model": response.get("_model"),
            "durationMs": response.get("_duration_ms"),
            "status": response.get("status"),
        }).encode()
        req = urllib.request.Request(
            f"{base.rstrip('/')}/api/projects/{project_id}/agent-metrics",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        logger.debug("[Metrics] Falha ao registrar métricas do agente %s: %s", agent, e)


def load_spec(spec_path: Path) -> str:
    path = spec_path if spec_path.is_absolute() else REPO_ROOT / spec_path
    if not path.exists():
        raise FileNotFoundError(f"Spec não encontrada: {path}")
    return path.read_text(encoding="utf-8")


def _agents_root() -> Path:
    """Returns the agents root directory.

    If SYSTEM_PROMPTS_OVERRIDE_DIR is set and exists, that directory is used instead
    of the bundled agents/. This allows runtime rollback to a pinned version:

        SYSTEM_PROMPTS_OVERRIDE_DIR=/path/to/agents-v1.2.0

    The override directory must have the same structure as applications/agents/
    (cto/SYSTEM_PROMPT.md, dev/web/.../SYSTEM_PROMPT.md, etc.).

    Override directories can be created by copying the agents/ folder to a versioned path:
        cp -r applications/agents/ /pinned-prompts/agents-v1.2.0/
    """
    override = os.environ.get("SYSTEM_PROMPTS_OVERRIDE_DIR", "").strip()
    if override:
        override_path = Path(override)
        if override_path.exists() and override_path.is_dir():
            return override_path
        else:
            logger.warning(
                "[Prompts] SYSTEM_PROMPTS_OVERRIDE_DIR=%s não encontrado ou não é um diretório — usando padrão", override
            )
    return APPLICATIONS_ROOT / "agents"


# ---------------------------------------------------------------------------
# Chamadas aos agentes
# ---------------------------------------------------------------------------

def call_engineer(
    spec_ref: str,
    spec_content: str,
    request_id: str,
    cto_questionamentos: str | None = None,
    pipeline_ctx: "PipelineContext | None" = None,
) -> dict:
    if pipeline_ctx:
        inputs = pipeline_ctx.build_inputs_for_engineer(cto_questionamentos)
        if spec_content:
            inputs["product_spec"] = spec_content[:15000]
    else:
        inputs = {
            "spec_ref": spec_ref,
            "product_spec": spec_content[:15000] if spec_content else "",
            "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        }
        if cto_questionamentos:
            inputs["cto_questionamentos"] = cto_questionamentos
    message = _build_message_envelope(
        request_id, "Engineer", "generic", "generate_engineering_docs",
        task_id=None, task="Gerar proposta técnica (stacks, squads, dependências).",
        inputs=inputs, existing_artifacts=[], limits={"max_rounds": 3, "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("engineer", message)
    from orchestrator.agents.runtime import run_agent
    engineer_prompt = _agents_root() / "engineer" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=engineer_prompt, message=message, role="ENGINEER")


def _load_spec_template() -> str:
    """Carrega o modelo aceitável de spec (PRODUCT_SPEC_TEMPLATE) para o CTO converter/validar."""
    for rel in ("project/spec/PRODUCT_SPEC_TEMPLATE.md", "spec/PRODUCT_SPEC_TEMPLATE.md"):
        path = REPO_ROOT / rel
        if path.exists():
            return path.read_text(encoding="utf-8")
    return ""


def call_cto(
    spec_ref: str,
    request_id: str,
    engineer_proposal: str = "",
    spec_content: str = "",
    spec_template: str = "",
    backlog_summary: str = "",
    validate_backlog_only: bool = False,
    pipeline_ctx: "PipelineContext | None" = None,
    extra_instruction: str = "",
    force_mode: str = "",
) -> dict:
    if force_mode:
        mode = force_mode
    elif validate_backlog_only:
        mode = "validate_backlog"
    elif engineer_proposal:
        mode = "validate_engineer_docs" if not backlog_summary else "charter_and_proposal"
    else:
        mode = "spec_intake_and_normalize"

    if pipeline_ctx:
        inputs = pipeline_ctx.build_inputs_for_cto(mode, backlog_summary, validate_backlog_only)
        if engineer_proposal:
            inputs["engineer_stack_proposal"] = engineer_proposal[:15000]
        if spec_content:
            inputs["spec_raw"] = spec_content[:20000]
            inputs["product_spec"] = spec_content[:20000]
        if spec_template:
            inputs["spec_template"] = spec_template[:15000]
        if backlog_summary:
            inputs["backlog_summary"] = backlog_summary[:15000]
    else:
        inputs = {"spec_ref": spec_ref, "constraints": ["spec-driven", "paths-resilient", "no-invent"]}
        if engineer_proposal:
            inputs["engineer_stack_proposal"] = engineer_proposal
        if spec_content:
            inputs["spec_raw"] = spec_content[:20000]
            inputs["product_spec"] = spec_content[:20000]
        if spec_template:
            inputs["spec_template"] = spec_template[:15000]
        if backlog_summary:
            inputs["backlog_summary"] = backlog_summary[:15000]
        if validate_backlog_only:
            inputs["validate_backlog_only"] = True
    if extra_instruction:
        inputs["extra_instruction"] = extra_instruction
    message = _build_message_envelope(
        request_id, "CTO", "generic", mode, task_id=None, task="",
        inputs=inputs, existing_artifacts=[], limits={"max_rounds": 3, "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("cto", message)
    from orchestrator.agents.runtime import run_agent
    cto_prompt = _agents_root() / "cto" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=cto_prompt, message=message, role="CTO")


def infer_pm_module_from_engineer_proposal(engineer_proposal: str, spec_content: str = "") -> str:
    """
    Infere o módulo/squad do PM a partir da proposta do Engineer (ou da spec como fallback).

    Usa o LLM para classificar o texto em vez de lista hardcoded de signals — isso garante
    suporte a qualquer linguagem/framework/plataforma sem precisar atualizar código.

    Retorna: 'web' | 'backend' | 'mobile' | 'fullstack'
    Fallback seguro: 'backend' para texto técnico sem sinais visuais claros.
    """
    source_text = (engineer_proposal or "").strip()
    is_blocked_or_empty = (
        not source_text
        or "não contém uma especificação" in source_text.lower()
        or "blocked" in source_text.lower()
        or "json inválido" in source_text.lower()
        or "apenas mensagens de erro" in source_text.lower()
    )

    # Se Engineer falhou, usar a spec original como contexto
    if is_blocked_or_empty:
        source_text = spec_content or ""

    if not source_text.strip():
        return "web"

    # Perguntar ao LLM qual é o módulo correto
    # Isso é uma chamada simples (< 300 tokens in/out) — não usa agentes, direto ao SDK
    try:
        module = _ask_llm_for_module(source_text[:8000])
        logger.info("[Pipeline] Módulo inferido pelo LLM: %s", module)
        return module
    except Exception as e:
        logger.warning("[Pipeline] LLM module inference failed (%s) — usando fallback heurístico", e)
        return _heuristic_module_fallback(source_text)


def _parse_stack_frontmatter(text: str) -> str | None:
    """
    Extrai runtime do frontmatter YAML do BACKLOG.md — custo zero, sem LLM.
    Formato esperado: ---\\nstack:\\n  runtime: python\\n---
    """
    import re as _re
    m = _re.search(r"---\s*\nstack\s*:\s*\n\s+runtime\s*:\s*(\w+)", text, _re.IGNORECASE)
    if m:
        lang = m.group(1).strip().lower()
        logger.info("[StackDetect] Frontmatter → runtime=%s (zero-cost, no LLM)", lang)
        return lang
    return None


def _project_disk_root(project_id: str, product_id: str | None = None) -> Path:
    """I-1: Resolve o path de disco do projeto.

    Com product_id: <FILES_ROOT>/<product_id>/<project_id>/
    Sem product_id: <FILES_ROOT>/<project_id>/   (standalone, backward-compat)

    Prioridade: se o diretório com product_id existir, usa ele.
    Se não, fallback para standalone (suporte a projetos antigos).
    """
    root = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files"))
    if product_id:
        product_path = root / product_id / project_id
        if product_path.exists():
            return product_path
        # Path ainda não existe — retornar o path correto para ser criado
        return product_path
    return root / project_id


def _product_disk_root(product_id: str) -> Path:
    """I-1: Resolve o path de disco da pasta do produto.

    <FILES_ROOT>/<product_id>/
    Contém: docker-compose.yml unificado, .env, contracts/, common-pkg/, e subpastas por projeto.
    """
    root = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files"))
    return root / product_id


def _copy_contract_to_product(project_id: str, product_id: str | None) -> None:
    """I-2: Ao aceitar projeto, copia api_contract.md para <product_id>/contracts/.

    Chamado quando o projeto é marcado como completed/accepted.
    Permite que predecessores encontrem contratos em path centralizado.
    """
    if not product_id:
        return
    try:
        proj_root = _project_disk_root(project_id, product_id)
        contract_src = proj_root / "project" / "api_contract.md"
        if not contract_src.exists():
            return
        product_root = _product_disk_root(product_id)
        contracts_dir = product_root / "contracts"
        contracts_dir.mkdir(parents=True, exist_ok=True)
        # Buscar título do projeto para nomear o arquivo
        charter = ""
        for cp in ["docs/cto_charter.md", "docs/cto_artifact_0.md", "docs/cto/PROJECT_CHARTER.md"]:
            ct = (proj_root / cp)
            if ct.exists():
                charter = ct.read_text(encoding="utf-8", errors="replace")[:200]
                break
        # Usar project_id como nome base
        dest = contracts_dir / f"{project_id[:8]}.api_contract.md"
        import shutil
        shutil.copy2(str(contract_src), str(dest))
        logger.info("[I-2] api_contract.md copiado para %s", dest)
    except Exception as _e:
        logger.debug("[I-2] Falha ao copiar contrato: %s", _e)


def _load_file_from_disk(project_id: str | None, relative_path: str, product_id: str | None = None) -> str:
    """Lê um arquivo do PROJECT_FILES_ROOT. Tenta path com product_id primeiro, depois standalone."""
    if not project_id:
        return ""
    try:
        root = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files"))
        # Tentar com product_id primeiro (nova estrutura)
        if product_id:
            path = root / product_id / project_id / relative_path
            if path.exists() and path.is_file():
                return path.read_text(encoding="utf-8", errors="replace")
        # Fallback: path standalone (backward compat)
        path = root / project_id / relative_path
        if path.exists() and path.is_file():
            return path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        logger.warning("[StackDetect] Falha ao ler %s: %s", relative_path, e)
    return ""


def _ask_llm_for_backend_language(text: str) -> str:
    """Chama LLM isolado para classificar linguagem. Raises em qualquer falha."""
    import os as _os, json as _j
    provider = _os.environ.get("GENESIS_LLM_PROVIDER", "anthropic").lower()
    model = _os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
    prompt = (
        "Analise o texto e responda APENAS com a linguagem/runtime principal do backend:\n"
        "python | nodejs | java | go | rust | php | ruby | other\n\n"
        "Mapas: FastAPI/Flask/Django/SQLAlchemy/Alembic/Pydantic → python; "
        "Express/NestJS/Fastify/Drizzle/Prisma → nodejs; Spring/Quarkus → java; Gin/Echo → go.\n\n"
        "Responda SOMENTE a palavra, sem explicação.\n\n"
        f"Texto:\n{text[:8000]}"
    )
    if provider == "bedrock":
        import boto3  # type: ignore
        region = _os.environ.get("GENESIS_AWS_REGION", "us-east-1")
        client = boto3.client("bedrock-runtime", region_name=region)
        body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 10,
                "messages": [{"role": "user", "content": prompt}]}
        resp = client.invoke_model(modelId=model, body=_j.dumps(body))
        answer = _j.loads(resp["body"].read())["content"][0]["text"].strip().lower()
    else:
        from anthropic import Anthropic
        client = Anthropic(api_key=_os.environ.get("CLAUDE_API_KEY", ""))
        resp = client.messages.create(model=model, max_tokens=10,
                                      messages=[{"role": "user", "content": prompt}])
        answer = resp.content[0].text.strip().lower()
    for v in ("python", "nodejs", "java", "go", "rust", "php", "ruby", "other"):
        if v in answer:
            return v
    raise ValueError(f"LLM returned unrecognized: {answer!r}")


def _detect_backend_stack(
    *,
    project_id: str | None,
    engineer_proposal: str = "",
    charter_fallback: str = "",
    backlog_fallback: str = "",
    module: str = "backend",
) -> dict:
    """
    Detecta linguagem do backend em ordem de precedência (disk-first).

    Fontes em ordem:
      1. BACKLOG.md do PM em disco  ← texto completo, autoritativo
      2. PRODUCT_SPEC.md do CTO em disco
      3. engineer_proposal (texto completo do Engineer)
      4. charter_fallback + backlog_fallback (summaries curtos — último recurso)

    Retorna: {"language": str, "source": str, "confidence": "high"|"medium"|"low"}
    NUNCA retorna default silencioso — raises RuntimeError se todas as fontes falharem.
    """
    # Priority 0: frontmatter YAML in BACKLOG.md — zero-cost, no LLM needed
    _backlog_disk = _load_file_from_disk(project_id, f"docs/pm/{module}/BACKLOG.md")
    if _backlog_disk:
        _fm_lang = _parse_stack_frontmatter(_backlog_disk)
        if _fm_lang:
            return {"language": _fm_lang, "source": "pm_backlog_frontmatter", "confidence": "high"}

    candidates = [
        ("pm_backlog_disk",   _backlog_disk,                                                     "high"),
        ("product_spec_disk", _load_file_from_disk(project_id, "docs/spec/PRODUCT_SPEC.md"),    "high"),
        ("cto_spec_disk",     _load_file_from_disk(project_id, "docs/cto_spec_review.md"),      "high"),
        ("engineer_proposal", engineer_proposal or "",                                           "medium"),
        ("charter_summary",   charter_fallback or "",                                            "low"),
        ("backlog_summary",   backlog_fallback or "",                                            "low"),
    ]

    for source, text, confidence in candidates:
        if not text or len(text.strip()) < 50:
            logger.debug("[StackDetect] Skip source=%s (len=%d)", source, len(text or ""))
            continue
        try:
            lang = _ask_llm_for_backend_language(text)
            logger.info("[StackDetect] ✓ source=%s → language=%s confidence=%s (input_len=%d)",
                        source, lang, confidence, len(text))
            return {"language": lang, "source": source, "confidence": confidence}
        except Exception as e:
            logger.error("[StackDetect] source=%s LLM error: %s — tentando próxima fonte", source, e)

    raise RuntimeError(
        f"[StackDetect] FALHA CRÍTICA: nenhuma fonte produziu classificação válida. "
        f"project_id={project_id} module={module}"
    )


def _resolve_backend_stack(
    pipeline_ctx: "PipelineContext | None",
    project_id: str | None,
    engineer_proposal: str = "",
    charter_summary: str = "",
    backlog_summary: str = "",
    module: str = "backend",
) -> dict:
    """
    Detecta stack uma vez por projeto e cacheia em pipeline_ctx.
    Callers subsequentes recebem o resultado cacheado sem nova chamada LLM.
    """
    if pipeline_ctx is not None and pipeline_ctx.backend_stack is not None:
        logger.info("[StackDetect] Cache hit: %s", pipeline_ctx.backend_stack)
        return pipeline_ctx.backend_stack

    stack = _detect_backend_stack(
        project_id=project_id,
        engineer_proposal=engineer_proposal,
        charter_fallback=charter_summary,
        backlog_fallback=backlog_summary,
        module=module,
    )

    if pipeline_ctx is not None:
        pipeline_ctx.backend_stack = stack

    return stack


# Keep backward compat alias — used in infer_pm_module fallback path (can still call LLM on summaries)
def _detect_backend_language(text: str) -> str:
    """DEPRECATED: usa _resolve_backend_stack com project_id para acesso ao disco."""
    try:
        return _ask_llm_for_backend_language(text)
    except Exception as e:
        logger.warning("[Pipeline] _detect_backend_language fallback failed (%s) — 'nodejs'", e)
    return "nodejs"


def _ask_llm_for_module(text: str) -> str:
    """Chama o LLM para classificar o tipo de produto descrito no texto."""
    import os as _os
    provider = _os.environ.get("GENESIS_LLM_PROVIDER", "anthropic").lower()
    model = _os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")

    prompt = f"""Analise o texto técnico abaixo e responda APENAS com uma das palavras:
web | backend | mobile | fullstack

Critérios:
- web: frontend, landing page, site estático, Next.js sem API, React sem servidor
- backend: API, servidor, banco de dados, endpoints HTTP, CLI tools, scripts — independente da linguagem (Node.js, Python, Go, Java, Rust, etc.)
- mobile: React Native, Flutter, iOS, Android, app móvel
- fullstack: frontend + backend juntos no mesmo projeto

Responda SOMENTE a palavra correspondente, sem ponto final, sem explicação.

Texto:
{text[:3000]}"""

    if provider == "bedrock":
        import boto3  # type: ignore
        region = _os.environ.get("GENESIS_AWS_REGION", "us-east-1")
        client = boto3.client("bedrock-runtime", region_name=region)
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 10,
            "messages": [{"role": "user", "content": prompt}],
        }
        import json as _json
        resp = client.invoke_model(modelId=model, body=_json.dumps(body))
        result = _json.loads(resp["body"].read())
        answer = result["content"][0]["text"].strip().lower()
    else:
        from anthropic import Anthropic
        api_key = _os.environ.get("CLAUDE_API_KEY", "")
        client = Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=model, max_tokens=10,
            messages=[{"role": "user", "content": prompt}],
        )
        answer = resp.content[0].text.strip().lower()

    # Validate answer
    valid = {"web", "backend", "mobile", "fullstack"}
    for v in valid:
        if v in answer:
            return v
    return "backend"  # safe default


def _heuristic_module_fallback(text: str) -> str:
    """Fallback heurístico simples quando o LLM não está disponível."""
    t = text.lower()
    # Se menciona interface visual explicitamente e NÃO menciona API/backend
    has_visual = any(w in t for w in ["landing page", "site estático", "página web", "frontend only"])
    has_backend = any(w in t for w in ["api", "endpoint", "servidor", "server", "backend", "banco de dados", "database"])
    has_mobile = any(w in t for w in ["mobile", "react native", "flutter", "ios", "android"])
    if has_mobile:
        return "mobile"
    if has_backend:
        return "backend"
    if has_visual and not has_backend:
        return "web"
    return "backend"  # default seguro para ambiguidades


def _extract_complexity_hint(charter_text: str) -> str:
    """
    Extrai o campo complexity_hint do PROJECT_CHARTER.md gerado pelo CTO.
    Retorna 'trivial', 'low', 'medium', 'high' ou string vazia se não encontrado.
    """
    if not charter_text:
        return ""
    match = re.search(r"complexity_hint[*\s]*[:\|][*\s]*(trivial|low|medium|high)", charter_text, re.IGNORECASE)
    if match:
        return match.group(1).lower()
    return ""


def _hint_from_response(resp: dict | None, fallback_text: str = "") -> str:
    """
    Extrai complexity_hint de uma resposta do CTO (summary + artefatos + fallback).
    Standalone para reutilização e testabilidade — não depende de escopo local.
    """
    if resp:
        candidate = _extract_complexity_hint(resp.get("summary", ""))
        if candidate:
            return candidate
        for art in resp.get("artifacts", []) or []:
            if not isinstance(art, dict):
                continue
            candidate = _extract_complexity_hint(art.get("content", ""))
            if candidate:
                return candidate
    return _extract_complexity_hint(fallback_text)


def call_pm(
    spec_ref: str,
    charter_summary: str,
    request_id: str,
    module: str = "backend",
    engineer_proposal: str = "",
    cto_questionamentos: str | None = None,
    pipeline_ctx: "PipelineContext | None" = None,
) -> dict:
    # GAP-A1: PM master tem prioridade — especialização dinâmica pelo charter
    # Backward compat: se master não existe, usa pm/{module} legado
    if not (module in ("web", "backend", "mobile")):
        module = "web"
    _pm_master = _agents_root() / "pm" / "SYSTEM_PROMPT.md"
    skill_path = "pm" if _pm_master.exists() else f"pm/{module}"
    if pipeline_ctx:
        pipeline_ctx.current_module = module
        inputs = pipeline_ctx.build_inputs_for_pm(cto_questionamentos)
        if engineer_proposal:
            inputs["engineer_proposal"] = engineer_proposal[:15000]
        if charter_summary:
            inputs["charter"] = charter_summary[:15000]
            inputs["charter_summary"] = charter_summary[:15000]
    else:
        inputs = {
            "spec_ref": spec_ref,
            "charter": charter_summary,
            "charter_summary": charter_summary,
            "module": module,
            "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        }
        if engineer_proposal:
            inputs["engineer_proposal"] = engineer_proposal
        if cto_questionamentos:
            inputs["cto_questionamentos"] = cto_questionamentos

    # Contexto de projetos linkados — PM precisa para criar tasks de integração corretas
    _pm_linked_ctx = getattr(pipeline_ctx, "linked_projects_context", "") if pipeline_ctx else ""
    if _pm_linked_ctx and "linked_projects_context" not in inputs:
        inputs["linked_projects_context"] = _pm_linked_ctx

    # Extrair complexity_hint do charter e expor como campo de primeiro nível nos inputs.
    # O PM Web usa esse campo como âncora primária para FAST-TRACK vs FULL.
    _complexity_hint = _extract_complexity_hint(charter_summary)
    if _complexity_hint:
        inputs["complexity_hint"] = _complexity_hint
        logger.info("[PM] complexity_hint extraído do charter: %s", _complexity_hint)

    inputs["context"] = inputs.get("context") or {}
    inputs["context"]["skill_path"] = skill_path
    message = _build_message_envelope(
        request_id, "PM", module, "generate_backlog",
        task_id=None, task=f"Gerar backlog da squad {module}.",
        inputs=inputs, existing_artifacts=[], limits={"max_rounds": 3, "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("pm", message)
    from orchestrator.agents.runtime import run_agent
    pm_prompt = _agents_root() / "pm" / module / "SYSTEM_PROMPT.md"
    if not pm_prompt.exists():
        pm_prompt = _agents_root() / "pm" / "backend" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=pm_prompt, message=message, role="PM")


def _infer_web_skill_path(context_text: str, project_id: str | None = None) -> str:
    """
    GAP-A1: Se o master dev/SYSTEM_PROMPT.md existe, retorna 'dev' para especialização dinâmica.
    Caso contrário, usa lógica legada de detecção de variant fixa (backward compat).
    """
    # GAP-A1: master tem prioridade — especialização dinâmica pelo charter
    master_path = _agents_root() / "dev" / "SYSTEM_PROMPT.md"
    if master_path.exists():
        return "dev"

    # Legado: detecção de variant fixa (mantido para backward compat se master removido)
    disk_text = ""
    if project_id:
        try:
            project_files_root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
            backlog_path = Path(project_files_root) / project_id / "docs" / "pm" / "web" / "BACKLOG.md"
            if backlog_path.exists():
                disk_text = backlog_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            pass
    combined = ((context_text or "") + " " + disk_text).lower()
    tailwind_path = _agents_root() / "dev" / "web" / "react-next-tailwind" / "SYSTEM_PROMPT.md"
    if "tailwind" in combined and tailwind_path.exists():
        return "dev/web/react-next-tailwind"
    if "material" in combined or "mui" in combined or "material-ui" in combined:
        return "dev/web/react-next-materialui"
    if "next.js" in combined or "nextjs" in combined or "next js" in combined:
        if tailwind_path.exists():
            return "dev/web/react-next-tailwind"
    return "dev/web/react-next-materialui"


def call_dev(
    spec_ref: str,
    charter_summary: str,
    backlog_summary: str,
    request_id: str,
    task_id: str | None = None,
    task: str = "",
    code_refs: list | None = None,
    existing_artifacts: list | None = None,
    task_dict: dict | None = None,
    dependency_code: dict | None = None,
    pipeline_ctx: "PipelineContext | None" = None,
    dev_variant: str = "backend",
    rework_attempt: int = 0,
) -> dict:
    inputs = {
        "spec_ref": spec_ref,
        "charter": charter_summary,
        "charter_summary": charter_summary,
        "backlog": backlog_summary,
        "backlog_summary": backlog_summary,
        "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        "rework_attempt": rework_attempt,  # GAP-P8: escada de modelo/tokens
    }
    if code_refs:
        inputs["code_refs"] = code_refs
    if task_dict:
        inputs["current_task"] = {
            "id": task_dict.get("taskId") or task_dict.get("task_id") or task_id,
            "title": task_dict.get("requirements") or task_dict.get("title") or task_dict.get("name") or task or "",
            "description": task_dict.get("requirements") or task_dict.get("description") or task or "",
            "acceptance_criteria": task_dict.get("acceptance_criteria") or task_dict.get("acceptanceCriteria") or [],
            "fr_ref": task_dict.get("fr_ref") or task_dict.get("frRef") or "",
        }
    if dependency_code:
        inputs["dependency_code"] = dependency_code
    if pipeline_ctx:
        inputs["completed_summary"] = [{"task_id": t, "status": "done"} for t in pipeline_ctx.completed_tasks]
        # Contexto enriquecido de projetos linkados (api_contract.md, curl_examples.sh, RUNBOOK.md)
        if getattr(pipeline_ctx, "linked_projects_context", ""):
            inputs["linked_projects_context"] = pipeline_ctx.linked_projects_context
    # Route to correct skill path based on variant and detected stack
    _pid = (pipeline_ctx.project_id if pipeline_ctx else None) or os.environ.get("PROJECT_ID")
    _web_skill = _infer_web_skill_path(charter_summary + " " + backlog_summary, project_id=_pid)
    # Detect backend language/framework — disk-first (BACKLOG.md > SPEC > summaries)
    _pid = (pipeline_ctx.project_id if pipeline_ctx else None) or os.environ.get("PROJECT_ID")
    _python_prompt_path = "dev/backend/python"
    _python_prompt_exists = (_agents_root() / "dev" / "backend" / "python" / "SYSTEM_PROMPT.md").exists()

    _detected_lang = "nodejs"  # safe default if detection fails
    if dev_variant in ("backend", "backend_python"):
        try:
            _stack = _resolve_backend_stack(
                pipeline_ctx, _pid,
                engineer_proposal=getattr(pipeline_ctx, "engineer_proposal", "") if pipeline_ctx else "",
                charter_summary=charter_summary,
                backlog_summary=backlog_summary,
                module=getattr(pipeline_ctx, "current_module", "backend") if pipeline_ctx else "backend",
            )
            _detected_lang = _stack["language"]
        except RuntimeError as _e:
            logger.error("[call_dev] Stack detection failed: %s — usando nodejs como fallback", _e)

    def _backend_skill() -> str:
        # GAP-A1: master tem prioridade
        if (_agents_root() / "dev" / "SYSTEM_PROMPT.md").exists():
            return "dev"
        if _detected_lang == "python" and _python_prompt_exists:
            return _python_prompt_path
        skill_map_lang = f"dev/backend/{_detected_lang}"
        if (_agents_root() / Path(*skill_map_lang.split("/")) / "SYSTEM_PROMPT.md").exists():
            return skill_map_lang
        return "dev/backend/nodejs"

    # GAP-A1: master tem prioridade para mobile também
    _mobile_skill = "dev" if (_agents_root() / "dev" / "SYSTEM_PROMPT.md").exists() else "dev/mobile/react-native"

    _skill_map = {
        "web": _web_skill,         # "dev" se master existe, legado caso contrário
        "backend": _backend_skill(),
        "backend_python": _backend_skill(),
        "fullstack": _web_skill,
        "mobile": _mobile_skill,
    }
    inputs["context"] = inputs.get("context") or {}
    inputs["context"]["skill_path"] = _skill_map.get(dev_variant, "dev/backend/nodejs")
    message = _build_message_envelope(
        request_id, "Dev", dev_variant, "implement_task",
        task_id=task_id,
        task=task or (task_dict.get("description") if task_dict else "") or "Implementar tarefa conforme backlog e spec.",
        inputs=inputs,
        existing_artifacts=existing_artifacts or [],
        limits={"max_rework": int(os.environ.get("MAX_QA_REWORK", "3")), "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("dev", message)
    from orchestrator.agents.runtime import run_agent
    _skill_path_for_prompt = _skill_map.get(dev_variant, "dev/backend/nodejs")
    dev_prompt = _agents_root() / Path(*_skill_path_for_prompt.split("/")) / "SYSTEM_PROMPT.md"
    if not dev_prompt.exists():
        dev_prompt = _agents_root() / "dev" / "backend" / "nodejs" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=dev_prompt, message=message, role="DEV")


def call_qa(
    spec_ref: str,
    charter_summary: str,
    backlog_summary: str,
    dev_summary: str,
    request_id: str,
    task_id: str | None = None,
    task: str = "",
    code_refs: list | None = None,
    existing_artifacts: list | None = None,
    rework_attempt: int = 0,
    task_delivered_files: list | None = None,  # SOMENTE arquivos entregues por esta task
) -> dict:
    inputs = {
        "spec_ref": spec_ref,
        "charter_summary": charter_summary,
        "backlog_summary": backlog_summary,
        "dev_summary": dev_summary,
        "constraints": ["spec-driven", "paths-resilient"],
        "rework_attempt": rework_attempt,  # escalada de modelo: rework>=1 → Opus 4.7
    }
    if code_refs:
        inputs["code_refs"] = code_refs
    # Escopo de validação: apenas os arquivos que esta task entregou.
    # O QA deve validar SOMENTE esses arquivos — não o projeto inteiro.
    # existing_artifacts serve como contexto de interfaces/tipos existentes.
    if task_delivered_files:
        inputs["task_files"] = [
            {"path": a.get("path", ""), "content": a.get("content", "")[:8000]}
            for a in task_delivered_files
            if isinstance(a, dict) and a.get("path") and a.get("content")
        ]
        inputs["task_scope_instruction"] = (
            f"ESCOPO DE VALIDAÇÃO: valide SOMENTE os {len(task_delivered_files)} arquivo(s) listados em "
            f"'task_files'. NÃO reprove por ausência de arquivos de outras tasks ou EPICs futuros. "
            f"Use 'existing_artifacts' apenas como contexto de interfaces e tipos — nunca como escopo de reprovação."
        )
    message = _build_message_envelope(
        request_id, "QA", "backend", "validate_task",
        task_id=task_id,
        task=task or "Validar artefatos do Dev (veredito QA_PASS ou QA_FAIL).",
        inputs=inputs,
        existing_artifacts=existing_artifacts or [],
        limits={"timeout_sec": 120},
    )
    # GAP-A1: QA master tem prioridade — especialização dinâmica pela spec
    # Quando API_AGENTS_URL está set, o skill_path é resolvido pelo servidor de agentes
    _qa_master = _agents_root() / "qa" / "SYSTEM_PROMPT.md"
    if _qa_master.exists() and not os.environ.get("API_AGENTS_URL"):
        # Modo local: usar master diretamente
        from orchestrator.agents.runtime import run_agent
        return run_agent(system_prompt_path=_qa_master, message=message, role="QA")
    if os.environ.get("API_AGENTS_URL"):
        # Modo HTTP: injetar skill_path=qa para servidor usar master
        message.setdefault("inputs", {}).setdefault("context", {})["skill_path"] = "qa"
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("qa", message)
    from orchestrator.agents.runtime import run_agent
    # Fallback legado: detecção de stack para QA variant
    _qa_pid = os.environ.get("PROJECT_ID")
    _qa_lang = "nodejs"
    try:
        _qa_stack = _detect_backend_stack(
            project_id=_qa_pid,
            engineer_proposal="",
            charter_fallback=charter_summary,
            backlog_fallback=backlog_summary,
        )
        _qa_lang = _qa_stack["language"]
    except (RuntimeError, Exception) as _e:
        logger.warning("[call_qa] Stack detection failed (%s) — usando nodejs QA", _e)
    _python_qa_prompt = _agents_root() / "qa" / "backend" / "python" / "SYSTEM_PROMPT.md"
    if _qa_lang == "python" and _python_qa_prompt.exists():
        qa_prompt = _python_qa_prompt
    else:
        qa_prompt = _agents_root() / "qa" / "backend" / "nodejs" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=qa_prompt, message=message, role="QA")


def call_monitor(spec_ref: str, charter_summary: str, backlog_summary: str, dev_summary: str, qa_summary: str, request_id: str) -> dict:
    inputs = {
        "spec_ref": spec_ref,
        "charter_summary": charter_summary,
        "backlog_summary": backlog_summary,
        "dev_summary": dev_summary,
        "qa_summary": qa_summary,
        "constraints": ["spec-driven"],
    }
    message = _build_message_envelope(
        request_id, "Monitor", "backend", "orchestrate",
        task_id=None, task="Decidir próximo passo (Dev/QA/DevOps) e atualizar estado.",
        inputs=inputs, existing_artifacts=[], limits={"max_rework": int(os.environ.get("MAX_QA_REWORK", "3")), "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("monitor", message)
    from orchestrator.agents.runtime import run_agent
    monitor_prompt = _agents_root() / "monitor" / "backend" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=monitor_prompt, message=message, role="MONITOR")


def _call_autonomous_monitor(project_id: str, task: dict, request_id: str) -> dict:
    """FT-11: Monitor Autônomo — tenta resolver task BLOCKED via Anthropic SDK.
    Retorna dict com outcome: FIXED | GENESIS_BUG | ESCALATE.
    Timeout: 120s. Máx 2 tentativas de fix.
    """
    try:
        import anthropic as _anthropic
    except ImportError:
        logger.warning("[FT-11] anthropic SDK não disponível — pulando Monitor Autônomo")
        return {"outcome": "ESCALATE", "summary": "SDK anthropic não instalado"}

    task_id = task.get("taskId") or task.get("task_id") or ""
    task_desc = task.get("requirements") or task.get("title") or task.get("description") or ""

    # Carregar QA history da task
    _qa_history: list[str] = []
    try:
        _tasks_data, _ = _api_get(f"/api/projects/{project_id}/tasks")
        if isinstance(_tasks_data, list):
            for _t in _tasks_data:
                if (_t.get("taskId") or _t.get("task_id")) == task_id:
                    _qa_report = _t.get("qaReport") or _t.get("qa_report") or ""
                    if _qa_report:
                        _qa_history.append(_qa_report)
                    break
    except Exception:
        pass

    # Montar tree de arquivos do projeto
    _proj_root = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "apps"
    _file_tree = ""
    try:
        _tree_lines = []
        for _p in sorted(_proj_root.rglob("*"))[:60]:
            if _p.is_file() and "node_modules" not in str(_p) and ".next" not in str(_p):
                _tree_lines.append(str(_p.relative_to(_proj_root.parent.parent)))
        _file_tree = "\n".join(_tree_lines)
    except Exception:
        pass

    _monitor_prompt = (
        f"Você é o Monitor Autônomo do Genesis.\n"
        f"Sua única responsabilidade é desbloquear a task abaixo sem modificar nada fora de apps/.\n\n"
        f"TASK ID: {task_id}\n"
        f"TASK DESCRIÇÃO: {task_desc}\n\n"
        f"QA REPORTS (últimas tentativas):\n{chr(10).join(_qa_history) or 'Sem QA reports disponíveis'}\n\n"
        f"ARQUIVOS NO DISCO (apps/):\n{_file_tree or 'Não foi possível listar'}\n\n"
        f"Regras obrigatórias:\n"
        f"1. Leia TODOS os artefatos relevantes antes de qualquer ação\n"
        f"2. Escreva APENAS em: {_proj_root}/\n"
        f"3. Se o problema for bug do Genesis (não do projeto), responda:\n"
        f'   {{"outcome":"GENESIS_BUG","bug_report":{{"description":"...","evidence":"..."}}}}\n'
        f"4. Máximo 2 tentativas de fix — se não resolver, responda:\n"
        f'   {{"outcome":"ESCALATE","summary":"motivo"}}\n'
        f"5. Ao corrigir com sucesso, responda:\n"
        f'   {{"outcome":"FIXED","files_changed":["path1","path2"],"summary":"o que foi corrigido"}}\n'
        f"Responda APENAS com JSON — sem texto adicional."
    )

    _provider = os.environ.get("GENESIS_LLM_PROVIDER", "anthropic").lower()
    _model    = os.environ.get("CLAUDE_MODEL", "us.anthropic.claude-sonnet-4-6")

    for _attempt in range(2):
        try:
            # Suporta Bedrock (padrão do Genesis) e Anthropic API direta
            if _provider == "bedrock":
                import boto3 as _boto3
                import json as _json
                _bedrock = _boto3.client(
                    "bedrock-runtime",
                    region_name=os.environ.get("GENESIS_AWS_REGION", "us-east-1"),
                )
                _body = _json.dumps({
                    "anthropic_version": "bedrock-2023-05-31",
                    "max_tokens": 4096,
                    "messages": [{"role": "user", "content": _monitor_prompt}],
                })
                _resp = _bedrock.invoke_model(modelId=_model, body=_body)
                _parsed = _json.loads(_resp["body"].read())
                _text = _parsed.get("content", [{}])[0].get("text", "")
            else:
                # Anthropic API direta
                _client = _anthropic.Anthropic(api_key=os.environ.get("CLAUDE_API_KEY", ""))
                _response = _client.messages.create(
                    model=_model,
                    max_tokens=4096,
                    messages=[{"role": "user", "content": _monitor_prompt}],
                    timeout=120,
                )
                _text = _response.content[0].text if _response.content else ""

            # Extrair JSON da resposta (comum a todos os providers)
            import json as _json
            _start = _text.find("{")
            _end = _text.rfind("}") + 1
            if _start >= 0 and _end > _start:
                _result = _json.loads(_text[_start:_end])
                _outcome = _result.get("outcome", "ESCALATE")
                logger.info("[FT-11] Monitor Autônomo: task=%s attempt=%d outcome=%s provider=%s",
                            task_id, _attempt + 1, _outcome, _provider)
                if _outcome in ("GENESIS_BUG", "ESCALATE", "FIXED"):
                    return _result
        except Exception as _e:
            logger.warning("[FT-11] Monitor attempt %d falhou (provider=%s): %s", _attempt + 1, _provider, _e)
            if _attempt == 1:
                return {"outcome": "ESCALATE", "summary": f"Monitor falhou após 2 tentativas: {_e}"}

    return {"outcome": "ESCALATE", "summary": "Monitor não retornou resultado válido"}


def _notify_genesis_bug(project_id: str, task_id: str, bug_report: dict) -> None:
    """FT-11: Notifica Zentriz API sobre bug interno do Genesis."""
    try:
        _payload = {
            "project_id": project_id,
            "task_id":    task_id,
            "description": bug_report.get("description", "Bug detectado pelo Monitor Autônomo"),
            "evidence":    bug_report.get("evidence", {}),
            "severity":    "high",
        }
        _api_post("/api/internal/genesis-bug-report", _payload)
        logger.info("[FT-11] Bug report enviado para Zentriz API: task=%s", task_id)
    except Exception as _e:
        logger.warning("[FT-11] Falha ao notificar bug Zentriz: %s", _e)


def call_devops(spec_ref: str, charter_summary: str, backlog_summary: str, request_id: str,
                dev_artifacts: list | None = None, project_id: str | None = None,
                product_id: str | None = None) -> dict:
    inputs = {
        "spec_ref": spec_ref,
        "charter": charter_summary,
        "charter_summary": charter_summary,
        "backlog_summary": backlog_summary,
        "constraints": ["spec-driven", "paths-resilient"],
    }
    # Pass dev artifacts so DevOps can detect the real stack (Next.js, Express, Python, etc.)
    existing = list(dev_artifacts or [])

    # I-5: Injetar docker-compose.yml e api_contract.md dos predecessores como existing_artifacts.
    # DevOps verá a rede, banco compartilhado, portas e nomes exatos — não precisa inventar nada.
    if project_id:
        try:
            _triggers_data, _ = _api_get(f"/api/projects/{project_id}/triggers/predecessors")
            if _triggers_data and isinstance(_triggers_data, list):
                _files_root = os.environ.get("PROJECT_FILES_ROOT", "/project-files").rstrip("/")
                for _pred in _triggers_data[:8]:
                    _pred_id = _pred.get("id", "")
                    _pred_title = _pred.get("title", "unknown")
                    if not _pred_id:
                        continue
                    # Candidatos: nova estrutura (product/project) e legacy
                    _pred_candidates: list[Path] = []
                    if product_id:
                        _pred_candidates += [
                            Path(_files_root) / product_id / _pred_id / "project" / "docker-compose.yml",
                            Path(_files_root) / product_id / _pred_id / "project" / "api_contract.md",
                            Path(_files_root) / product_id / _pred_id / "docs" / "cto_charter.md",
                        ]
                    _pred_candidates += [
                        Path(_files_root) / _pred_id / "project" / "docker-compose.yml",
                        Path(_files_root) / _pred_id / "project" / "api_contract.md",
                        Path(_files_root) / _pred_id / "docs" / "cto_charter.md",
                    ]
                    for _pc in _pred_candidates:
                        try:
                            if _pc.exists():
                                _content = _pc.read_text(encoding="utf-8", errors="replace")[:4000]
                                existing.append({
                                    "path": f"predecessors/{_pred_title}/{_pc.name}",
                                    "content": _content,
                                    "format": "yaml" if _pc.suffix == ".yml" else "markdown",
                                    "purpose": f"Artefato do predecessor '{_pred_title}' — usar como referência para portas, banco, rede e contratos",
                                })
                                logger.info("[I-5] DevOps receberá %s de predecessor %s", _pc.name, _pred_title[:20])
                        except (FileNotFoundError, OSError):
                            pass
        except Exception as _e:
            logger.debug("[I-5] Falha ao carregar artefatos predecessores para DevOps: %s", _e)

    # Trim large content to avoid token overflow — keep path + first 2000 chars of content
    trimmed_artifacts = []
    for a in existing:
        if not isinstance(a, dict):
            continue
        entry = {"path": a.get("path", ""), "format": a.get("format", "code"),
                 "purpose": a.get("purpose", "")}
        content = a.get("content", "")
        entry["content"] = content[:2000] if isinstance(content, str) else str(content)[:2000]
        trimmed_artifacts.append(entry)
    message = _build_message_envelope(
        request_id, "DevOps", "docker", "provision_artifacts",
        task_id=None, task="Analisar artefatos gerados pelo Dev e produzir start.sh + RUNBOOK.md para executar o produto localmente.",
        inputs=inputs, existing_artifacts=trimmed_artifacts, limits={"timeout_sec": 180},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("devops", message)
    from orchestrator.agents.runtime import run_agent
    devops_prompt = _agents_root() / "devops" / "docker" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=devops_prompt, message=message, role="DEVOPS")


# ---------------------------------------------------------------------------
# Persistência de estado e eventos
# ---------------------------------------------------------------------------

def persist_state(spec_ref: str, charter: dict, backlog: dict, events: list) -> None:
    ensure_state_dir()
    state = {
        "spec_ref": spec_ref,
        "charter": charter,
        "backlog": backlog,
        "events": events,
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    # Sempre isolado por project_id — sem path global compartilhado entre projetos
    _pid = os.environ.get("PROJECT_ID")
    _project_state_dir = STATE_DIR / _pid if _pid else STATE_DIR / "default"
    _project_state_dir.mkdir(parents=True, exist_ok=True)
    (_project_state_dir / "current_project.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # Path global removido — nenhum serviço externo lê STATE_DIR/current_project.json diretamente


def emit_event(event_type: str, payload: dict, request_id: str) -> None:
    ensure_state_dir()
    event = {
        "event_type": event_type,
        "request_id": request_id,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "payload": payload,
    }
    # Isolar events.jsonl por project_id
    _pid = os.environ.get("PROJECT_ID")
    _events_dir = STATE_DIR / _pid if _pid else STATE_DIR
    _events_dir.mkdir(parents=True, exist_ok=True)
    events_file = _events_dir / "events.jsonl"
    with open(events_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
    logger.info("Evento emitido: %s", event_type)


def _emit_connect_contracts(
    stage: str,
    pipeline_ctx: "PipelineContext | None",
    project_id: str | None,
    storage,
    request_id: str,
) -> list[str]:
    if not (pipeline_ctx and project_id and storage and storage.is_enabled()):
        return []
    from orchestrator.connect_contracts import build_connect_artifacts_for_stage

    emitted_paths: list[str] = []
    artifacts = build_connect_artifacts_for_stage(pipeline_ctx, stage)
    for artifact in artifacts:
        path = storage.write_connect_artifact(project_id, pipeline_ctx.connect_version, artifact.filename, artifact.to_json())
        if path:
            pipeline_ctx.register_connect_artifact(artifact.project_relative_path, artifact.to_json())
            emitted_paths.append(artifact.project_relative_path)

    if emitted_paths:
        emit_event(
            "connect.contracts.emitted",
            {
                "stage": stage,
                "connect_version": pipeline_ctx.connect_version,
                "paths": emitted_paths,
            },
            request_id,
        )
        logger.info("[Pipeline] Connect artifacts emitidos (%s): %s", stage, emitted_paths)
    return emitted_paths


# ---------------------------------------------------------------------------
# Diálogo (log de passos e erros no portal)
# ---------------------------------------------------------------------------

def _project_id() -> str | None:
    return os.environ.get("PROJECT_ID")


def _build_message_envelope(
    request_id: str,
    agent: str,
    variant: str,
    mode: str,
    task_id: str | None,
    task: str,
    inputs: dict,
    existing_artifacts: list | None = None,
    limits: dict | None = None,
) -> dict:
    """Monta MessageEnvelope completo para o Enforcer (project_id, mode, task_id, inputs, existing_artifacts, limits)."""
    project_id = _project_id() or "default"
    return {
        "request_id": request_id,
        "project_id": project_id,
        "agent": agent,
        "variant": variant or "generic",
        "mode": mode,
        "task_id": task_id,
        "task": task or "",
        "inputs": inputs,
        "existing_artifacts": existing_artifacts or [],
        "limits": limits or {"max_rounds": 3, "max_rework": 3, "timeout_sec": int(os.environ.get("REQUEST_TIMEOUT", "300"))},
        "input": inputs,  # compatibilidade: runtime pode ler input ou inputs
    }


def _post_dialogue(from_agent: str, to_agent: str, event_type: str, summary_human: str, request_id: str) -> None:
    pid = _project_id()
    if not pid:
        return
    from orchestrator.dialogue import post_dialogue
    post_dialogue(pid, from_agent, to_agent, summary_human, event_type=event_type, request_id=request_id)


def _post_step(step_message: str, request_id: str) -> None:
    """Registra um passo no log do portal. Mensagem deve ser em linguagem humana."""
    logger.info("[Pipeline] %s", step_message)
    _post_dialogue("system", "system", "step", step_message, request_id)


def _audit_log(
    agent: str,
    request_id: str,
    response: dict,
    task_id: str | None = None,
    round_num: int = 1,
) -> None:
    """Audit trail por chamada (Blueprint 6 / Fase 4). Log estruturado para rastreabilidade."""
    status = response.get("status", "?")
    artifacts_count = len(response.get("artifacts") or [])
    validator_pass = response.get("validator_pass")
    validation_errors = response.get("validation_errors") or []
    artifacts_paths = response.get("artifacts_paths") or []
    logger.info(
        "[Audit] agent=%s request_id=%s status=%s artifacts_count=%d validator_pass=%s validation_errors=%s artifacts_paths=%s",
        agent, request_id, status, artifacts_count, validator_pass, len(validation_errors), artifacts_paths[:10],
    )
    # Fire-and-forget token metrics recording
    _record_agent_metrics(_project_id(), agent, response, task_id=task_id, round_num=round_num)


def _post_agent_working(agent_key: str, activity_message: str, request_id: str) -> None:
    """Registra que um agente está em execução (LLM processando). Portal pode exibir loading no passo correspondente."""
    logger.info("[Pipeline] %s", activity_message)
    _post_dialogue(agent_key, "system", "agent_working", activity_message, request_id)


def _content_for_doc(response: dict) -> str:
    """
    Extrai texto adequado para gravar em .md a partir do response_envelope do agente.
    A LLM às vezes devolve no campo summary um JSON (envelope inteiro); evita gravar isso como .md.
    """
    raw = (response.get("summary") or "").strip()
    if not raw:
        return ""
    # Se o summary for um JSON (ex.: envelope inteiro), tenta extrair o summary interno
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            if isinstance(data.get("summary"), str):
                inner = data["summary"].strip()
                if inner.startswith("{"):
                    try:
                        data2 = json.loads(inner)
                        if isinstance(data2.get("summary"), str):
                            return data2["summary"]
                    except (json.JSONDecodeError, TypeError):
                        pass
                return inner
            # Fallback: se for dict, monta texto legível
            if isinstance(data, dict) and "summary" not in data:
                return raw
        except (json.JSONDecodeError, TypeError):
            pass
    return raw


def _validate_response_quality(agent: str, response: dict) -> tuple[bool, list[str]]:
    """Delegate para envelope.validate_response_quality (AGENT_LLM_COMMUNICATION_ANALYSIS)."""
    try:
        from orchestrator.envelope import validate_response_quality as _v
        return _v(agent, response)
    except ImportError:
        return True, []


def _is_qa_pass(qa_response: dict) -> bool:
    """Considera QA como aprovado se status ou summary indicarem sucesso (evita QA_FAIL infinito por variação do LLM)."""
    status = (qa_response.get("status") or "").strip().lower()
    summary = (qa_response.get("summary") or "").lower()
    if any(k in status for k in ("pass", "qa_pass", "ok", "aprovado", "success", "done")):
        return True
    if any(k in summary for k in ("aprovado", "passou", "ok", "sem problemas", "approved")):
        return True
    return False


def _qa_has_blocker(qa_response: dict) -> bool:
    """GAP-P2: detecta BLOCKER no relatório do QA — issues que impedem aprovação mesmo após max_rework."""
    text = " ".join([
        qa_response.get("summary") or "",
        _content_for_doc(qa_response) or "",
        str(qa_response.get("artifacts") or ""),
    ]).lower()
    return "[blocker]" in text or "blocker" in text


def _is_timeout_error(exc: BaseException | None, message: str) -> bool:
    """Detecta timeout para exibir mensagem amigável (recorrência: runner→agents HTTP)."""
    if exc is not None:
        if isinstance(exc, TimeoutError):
            return True
        if isinstance(exc, OSError) and "timed out" in str(exc).lower():
            return True
    return "timed out" in (message or "").lower() or "timeout" in (message or "").lower()


def _post_escalation_event(project_id: str, task_id: str, reason: str, request_id: str) -> None:
    """Fire a human escalation notification via the notifications API.

    Called when a task exceeds circuit-breaker or rework limits and needs
    human attention. Non-blocking — failures are logged but not re-raised.
    """
    title = f"Intervenção necessária — {task_id}"
    body_text = f"[{project_id}] {reason} (request_id={request_id})"
    _post_step(f"[ESCALATION] {reason}", request_id)
    try:
        _api_post(
            "/api/notifications",
            {
                "type": "blocked",
                "title": title,
                "body": body_text,
                "project_id": project_id,
            },
        )
    except Exception as exc:
        logger.warning("[Escalation] Falha ao enviar notificação: %s", exc)


def _post_error(message: str, request_id: str, exc: BaseException | None = None) -> None:
    """Registra erro no log do portal. Inclui traceback apenas se SHOW_TRACEBACK=true."""
    body = message
    if exc is not None:
        error_detail = _extract_error_info(exc)
        if error_detail.get("human_message"):
            body = error_detail["human_message"]
        if _is_timeout_error(exc, body):
            body = "O agente demorou mais que o limite (timeout). Tente iniciar o pipeline novamente ou defina REQUEST_TIMEOUT=300 no ambiente do runner."
        if SHOW_TRACEBACK:
            tb_text = error_detail.get("traceback", "")
            if not tb_text:
                tb_text = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
            body += "\n\n--- Traceback (SHOW_TRACEBACK=true) ---\n" + tb_text[:3000]
    elif _is_timeout_error(None, body):
        body = "O agente demorou mais que o limite (timeout). Tente iniciar o pipeline novamente ou defina REQUEST_TIMEOUT=300 no ambiente do runner."
    logger.error("[Pipeline] %s", body[:500])
    _post_dialogue("system", "error", "error", body, request_id)


def _extract_error_info(exc: BaseException) -> dict:
    """Extrai informações estruturadas de erros dos agentes (que usam JSON no message)."""
    msg = str(exc)
    try:
        return json.loads(msg)
    except (json.JSONDecodeError, TypeError):
        return {"error": msg, "human_message": msg}


def _run_local_deploy(project_id: str, devops_response: dict, request_id: str) -> None:
    """
    Executa o produto localmente após o DevOps gerar os artefatos.
    Lê meta.run_command e meta.app_url do response do DevOps.
    Para projetos web: executa o comando e abre o browser quando a porta estiver disponível.
    Roda em background (não bloqueia o pipeline).
    """
    import subprocess
    import threading

    meta = devops_response.get("meta") or {}
    run_command = meta.get("run_command", "").strip()
    app_url = meta.get("app_url", "").strip()

    # Fallback: try to find start.sh in project artifacts
    if not run_command:
        artifacts = devops_response.get("artifacts") or []
        for art in artifacts:
            if isinstance(art, dict) and (art.get("path") or "").endswith("start.sh"):
                run_command = "bash project/start.sh"
                break

    if not run_command:
        _post_step(
            "DevOps não forneceu run_command. Execute manualmente conforme docs/devops/RUNBOOK.md.",
            request_id,
        )
        return

    project_files_root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
    project_dir = Path(project_files_root) / project_id

    if not project_dir.exists():
        _post_step(f"Diretório do projeto não encontrado: {project_dir}. Execute manualmente: {run_command}", request_id)
        return

    # Make start.sh executable if it exists
    start_sh = project_dir / "project" / "start.sh"
    if start_sh.exists():
        try:
            import stat
            start_sh.chmod(start_sh.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        except Exception:
            pass

    # Detect if running inside a Docker container — in that case we cannot run
    # npm/node commands (no Node.js in the Python runner image). Instead, use the
    # HOST_PROJECT_FILES_ROOT env var (set in docker-compose) to build the host path
    # and instruct the user. We still open the browser via `open` which works on macOS host.
    _in_docker = Path("/.dockerenv").exists() or os.environ.get("container", "") != ""
    host_root = os.environ.get("HOST_PROJECT_FILES_ROOT", "").strip()
    if _in_docker and not host_root:
        # Try to infer host path from PROJECT_FILES_ROOT (might be a bind-mount path)
        host_root = project_files_root  # best guess

    if _in_docker:
        # Map container path to host path for the run instruction
        host_project_dir = Path(host_root) / project_id if host_root else project_dir
        host_start_sh = host_project_dir / "project" / "start.sh"
        host_cmd = f"bash '{host_start_sh}'"
        # Garantir que start.sh instrui a instalar deps — não assume node_modules existentes
        # Use special event_type "product_ready" so the portal highlights this message
        _product_ready_msg = (
            f"Produto pronto. Execute no terminal do host:\n{host_cmd}"
            + (f"\nAcesse: {app_url}" if app_url else "")
        )
        _post_dialogue(
            "system", "system", "product_ready",
            _product_ready_msg,
            request_id,
        )
        logger.info("[Pipeline] Produto pronto. Comando: %s", host_cmd)
        logger.info("[Local Deploy] Rodando em container — execute no host: %s", host_cmd)
        # Open browser optimistically (app may already be running or user will start it)
        if app_url:
            def _open_later():
                time.sleep(5)
                try:
                    subprocess.Popen(["open", app_url])
                    logger.info("[Local Deploy] Browser aberto: %s", app_url)
                except Exception as e:
                    logger.warning("[Local Deploy] open browser falhou: %s", e)
            threading.Thread(target=_open_later, daemon=True).start()
        return

    # Garantia de idempotência: se node_modules não existir, instalar antes de executar
    apps_dir = project_dir / "apps"
    if apps_dir.exists() and (apps_dir / "package.json").exists():
        nm = apps_dir / "node_modules"
        if not nm.exists() or not nm.is_dir():
            logger.info("[Local Deploy] node_modules não encontrado — executando npm install antes de iniciar")
            _post_step("Instalando dependências (npm install)...", request_id)
            try:
                install_proc = subprocess.run(
                    ["npm", "install", "--legacy-peer-deps"],
                    cwd=str(apps_dir),
                    capture_output=True,
                    text=True,
                    timeout=300,
                )
                if install_proc.returncode == 0:
                    _post_step("Dependências instaladas com sucesso.", request_id)
                else:
                    logger.warning("[Local Deploy] npm install retornou código %s: %s",
                                   install_proc.returncode, install_proc.stderr[:500])
                    _post_step("npm install retornou erros — tentando iniciar mesmo assim.", request_id)
            except Exception as e:
                logger.warning("[Local Deploy] npm install falhou: %s — continuando", e)

    _post_step(f"DevOps iniciando build e execução local: `{run_command}`", request_id)

    def _open_browser_when_ready(url: str, timeout: int = 120) -> None:
        """Poll the URL until it responds, then open the browser."""
        import urllib.request as _ur
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with _ur.urlopen(url, timeout=3) as r:
                    if r.status < 500:
                        break
            except Exception:
                pass
            time.sleep(2)
        try:
            import subprocess as _sp
            _sp.Popen(["open", url])
            logger.info("[Local Deploy] Browser aberto: %s", url)
            _post_step(f"Aplicação disponível em {url} — browser aberto.", request_id)
        except Exception as e:
            logger.warning("[Local Deploy] Não foi possível abrir o browser: %s", e)
            _post_step(f"Aplicação disponível em {url} — abra no browser manualmente.", request_id)

    # MAX_DEPLOY_WAIT_SECS: quanto tempo (em segundos) o runner aguarda o start.sh antes de
    # encerrar o processo de deploy. O app continua rodando no host; o runner só para de monitorar.
    MAX_DEPLOY_WAIT_SECS = int(os.environ.get("LOCAL_DEPLOY_MAX_WAIT_SECS", "120"))

    def _run() -> None:
        try:
            proc = subprocess.Popen(
                run_command,
                shell=True,
                cwd=str(project_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            logger.info("[Local Deploy] Processo iniciado (pid=%s): %s", proc.pid, run_command)
            if app_url:
                threading.Thread(target=_open_browser_when_ready, args=(app_url,), daemon=True).start()
            lines_read = 0
            for line in proc.stdout:
                if lines_read < 200:
                    logger.info("[Local Deploy] %s", line.rstrip())
                    lines_read += 1
            # Aguardar no máximo MAX_DEPLOY_WAIT_SECS — evita que o runner fique preso
            # indefinidamente num servidor de desenvolvimento que nunca encerra.
            try:
                proc.wait(timeout=MAX_DEPLOY_WAIT_SECS)
                if proc.returncode != 0:
                    _post_step(f"Build/run terminou com código {proc.returncode}. Verifique o RUNBOOK.", request_id)
                else:
                    _post_step("Processo de execução local encerrado normalmente.", request_id)
            except subprocess.TimeoutExpired:
                # App está rodando (timeout é normal para npm run dev / serve).
                # Terminar o monitoramento — o processo continua no host.
                logger.info(
                    "[Local Deploy] Timeout de monitoramento (%ss) atingido — app provavelmente rodando. "
                    "Execute manualmente: %s", MAX_DEPLOY_WAIT_SECS, run_command,
                )
                _post_step(
                    f"App em execução. Para continuar usando, execute no host: {run_command}",
                    request_id,
                )
                try:
                    proc.terminate()
                except Exception:
                    pass
        except Exception as e:
            logger.warning("[Local Deploy] Erro ao executar: %s", e)
            _post_step(f"Erro ao executar localmente: {e}. Execute manualmente: {run_command}", request_id)

    threading.Thread(target=_run, daemon=True).start()


def _patch_project(body: dict) -> bool:
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


def _api_available() -> bool:
    return bool(
        os.environ.get("API_BASE_URL")
        and os.environ.get("GENESIS_API_TOKEN")
        and os.environ.get("PROJECT_ID")
    )


def _api_request(method: str, path: str, body: dict | None = None) -> tuple[dict | list | None, int]:
    base = os.environ.get("API_BASE_URL", "").rstrip("/")
    token = os.environ.get("GENESIS_API_TOKEN")
    if not base or not token:
        return None, 0
    url = f"{base}{path}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            out = json.loads(raw) if raw else None
            return out, resp.status
    except urllib.error.HTTPError as e:
        try:
            out = json.loads(e.read().decode("utf-8"))
        except Exception:
            out = None
        return out, e.code
    except Exception as e:
        logger.warning("Falha na requisição API %s %s: %s", method, path, e)
        return None, 0


def _api_get(path: str) -> tuple[dict | list | None, int]:
    return _api_request("GET", path)


def _api_post(path: str, body: dict) -> tuple[dict | list | None, int]:
    return _api_request("POST", path, body)


def _api_patch(path: str, body: dict) -> tuple[dict | list | None, int]:
    return _api_request("PATCH", path, body)


def _parse_tasks_from_backlog(project_id: str, pm_module: str = "web") -> list[dict]:
    """Parse tasks from the BACKLOG.md generated by PM. Falls back to a single default task."""
    import re as _re
    backlog_paths = [
        Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "docs" / "pm" / pm_module / "BACKLOG.md",
        Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "docs" / "pm" / "web" / "BACKLOG.md",
        Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "docs" / "pm" / "backend" / "BACKLOG.md",
    ]
    owner_role_map = {"web": "DEV_WEB", "backend": "DEV_BACKEND", "mobile": "DEV_MOBILE"}
    owner_role = owner_role_map.get(pm_module, "DEV_WEB")
    module_map = {"web": "web", "backend": "backend", "mobile": "mobile"}
    module = module_map.get(pm_module, "web")

    for backlog_path in backlog_paths:
        if not backlog_path.exists():
            continue
        content = backlog_path.read_text(encoding="utf-8", errors="replace")
        tasks: list[dict] = []
        # Pattern: ## TSK-XX-NNN or | TSK-XX-NNN | or **TSK-XX-NNN**
        task_id_pattern = _re.compile(r'\b(TSK-[A-Z]+-\d+|TSK-\d+)\b')
        seen_ids: set = set()
        lines = content.splitlines()
        i = 0
        while i < len(lines):
            line = lines[i]
            id_match = task_id_pattern.search(line)
            if id_match:
                tid = id_match.group(1)
                if tid not in seen_ids:
                    seen_ids.add(tid)
                    # Extract title from same line (after task_id)
                    title_raw = task_id_pattern.sub("", line).strip(" #|*-:").strip()
                    title = title_raw[:120] if title_raw else f"Implementar {tid}"
                    # Detect owner_role override from line
                    _or = owner_role
                    line_lower = line.lower()
                    if "dev_web" in line_lower or "web" in line_lower:
                        _or = "DEV_WEB"
                    elif "dev_backend" in line_lower or "backend" in line_lower:
                        _or = "DEV_BACKEND"
                    elif "dev_mobile" in line_lower or "mobile" in line_lower:
                        _or = "DEV_MOBILE"
                    _mod = {"DEV_WEB": "web", "DEV_BACKEND": "backend", "DEV_MOBILE": "mobile"}.get(_or, module)
                    tasks.append({
                        "task_id": tid,
                        "module": _mod,
                        "owner_role": _or,
                        "status": "ASSIGNED",
                        "requirements": title,  # API uses 'requirements' as the task title/description field
                    })
            i += 1

        if tasks:
            logger.info("[_parse_tasks_from_backlog] Parsed %d tasks from %s", len(tasks), backlog_path)
            return tasks
        break  # found file but no tasks — fall through to default

    # Fallback: single task based on module
    fallback_id = "TSK-WEB-001" if pm_module == "web" else "TSK-BE-001"
    fallback_role = owner_role_map.get(pm_module, "DEV_WEB")
    logger.warning("[_parse_tasks_from_backlog] No BACKLOG.md found or no tasks parsed — using fallback task %s", fallback_id)
    return [{"task_id": fallback_id, "module": module, "owner_role": fallback_role, "status": "ASSIGNED", "requirements": "Implementar scaffold do projeto"}]


def _seed_tasks(project_id: str, pm_module: str = "web") -> bool:
    tasks = _parse_tasks_from_backlog(project_id, pm_module)

    # TaskState: preservar status de tasks já terminadas (idempotência entre restarts)
    try:
        from orchestrator.task_state import TaskState
        ts = TaskState(project_id).load()
        terminal = ts.terminal_task_ids()
        if terminal:
            tasks = ts.to_seed_tasks(tasks)
            logger.info("[TaskState] %d task(s) terminal(is) preservadas no seed.", len(terminal))
    except Exception as _tse:
        logger.debug("[TaskState] Não foi possível carregar state (não crítico): %s", _tse)

    # TSK-FULL-TEST: skip se charter declarar tsk_full_test: false
    # Regra geral de produto: em produto multi-serviço, apenas o projeto "deploy" tem TSK-FULL-TEST.
    # O CTO pode gravar o charter em vários paths — tentar todos em ordem de prioridade.
    _charter_paths = [
        "docs/cto/PROJECT_CHARTER.md",   # path formal documentado
        "docs/cto_charter.md",            # path real gerado pelo CTO (observado em produção)
        "docs/cto_artifact_0.md",         # path alternativo (primeiro artefato do CTO)
        "project/PROJECT_CHARTER.md",     # fallback
    ]
    _charter_text = ""
    for _cp in _charter_paths:
        _ct = _load_file_from_disk(project_id, _cp)
        if _ct:
            _charter_text = _ct
            logger.debug("[_seed_tasks] Charter encontrado em %s", _cp)
            break
    _skip_full_test = bool(re.search(r"tsk_full_test\s*:\s*false", _charter_text, re.IGNORECASE)) if _charter_text else False
    if _skip_full_test:
        logger.info("[_seed_tasks] tsk_full_test: false no charter — TSK-FULL-TEST omitida para projeto %s", project_id)
    else:
        # TSK-FULL-TEST sempre no fim — visível no portal desde o início, executada após DevOps.
        # Status NEW: upsert posterior (quando DevOps termina) promove para ASSIGNED.
        tasks.append({
            "task_id":   "TSK-FULL-TEST",
            "module":    pm_module or "web",
            "owner_role": "QA",
            "status":    "NEW",
            "requirements": (
                "TSK-FULL-TEST — Validação E2E completa e CORREÇÃO de bugs pelo Claude Code Agent. "
                "Esta é a ÚLTIMA task. O agente DEVE: "
                "(1) build sem erros TypeScript; "
                "(2) executar start.sh e confirmar que o servidor sobe; "
                "(3) chamar TODOS os endpoints da API com token real e verificar HTTP 200; "
                "(4) corrigir QUALQUER bug encontrado — Content-Type, rotas 404, campos errados, CORS; "
                "(5) só marcar APROVADO quando o produto funciona end-to-end de verdade. "
                "Ver prompt completo em project/full-test-prompt.md"
            ),
        })

    path = f"/api/projects/{project_id}/tasks"
    body = {"tasks": tasks}
    data, status = _api_post(path, body)
    if 200 <= status < 300:
        logger.info("[Monitor Loop] %d tarefas criadas para projeto %s (module=%s, inclui TSK-FULL-TEST)", len(tasks), project_id, pm_module)
        return True
    logger.warning("[Monitor Loop] Falha ao criar tarefas: %s %s", status, data)
    return False


def _get_project_status(project_id: str) -> str | None:
    data, status = _api_get(f"/api/projects/{project_id}")
    if status != 200 or not isinstance(data, dict):
        return None
    return data.get("status")


def _get_tasks(project_id: str) -> list:
    data, status = _api_get(f"/api/projects/{project_id}/tasks")
    if status != 200 or not isinstance(data, list):
        return []
    return data


def _update_task(project_id: str, task_id: str, **kwargs) -> bool:
    path = f"/api/projects/{project_id}/tasks/{task_id}"
    data, status = _api_patch(path, kwargs)
    return 200 <= status < 300


def _update_task_status(project_id: str, task_id: str, current_status: str, new_status: str) -> bool:
    """Validate state transition (LEI 9) before patching, then delegate to _update_task."""
    from orchestrator.task_state_machine import VALID_TRANSITIONS
    allowed = VALID_TRANSITIONS.get(current_status, [])
    if new_status not in allowed:
        logging.getLogger(__name__).warning(
            "[LEI 9] Transição inválida ignorada: task=%s %s → %s (permitidas: %s)",
            task_id, current_status, new_status, allowed,
        )
        return False
    return _update_task(project_id, task_id, status=new_status)


def _run_monitor_loop(
    project_id: str,
    spec_ref: str,
    charter_summary: str,
    backlog_summary: str,
    request_id: str,
    pipeline_ctx: "PipelineContext | None" = None,
    run_log=None,
) -> None:
    # run_log é o PipelineRunLog do caller (main) — passado como parâmetro para evitar
    # NameError quando _run_monitor_loop é chamado antes de _run_log ser definido em main().
    _run_log = run_log
    global _shutdown_requested
    signal.signal(signal.SIGTERM, _sigterm_handler)
    storage = _project_storage()
    dev_summary = ""
    qa_summary = ""
    last_dev_artifacts: list = []
    devops_done = False
    # Tarefas marcadas DONE por terem atingido o máximo de reworks do QA (não aprovação)
    tasks_done_after_qa_fail: set[str] = set()
    # Tarefas que não devem mais acionar Dev (circuit breaker ou máximo de BLOCKED sem apps/)
    dev_gave_up_tasks: set[str] = set()

    # TaskState: carrega state persistente para preservar progresso entre restarts
    _task_state = None
    try:
        from orchestrator.task_state import TaskState
        _task_state = TaskState(project_id or "default").load()
    except Exception as _tse:
        logger.debug("[TaskState] Monitor Loop: não foi possível carregar (não crítico): %s", _tse)

    # Restaurar devops_done + corrigir infra tasks não-terminais no boot.
    # Evita re-executar DevOps+TSK-FULL-TEST após restart do Docker.
    if project_id:
        try:
            _all_tasks_boot = _get_tasks(project_id)
            # 1. Restaurar devops_done se TSK-DEVOPS-001 já está DONE no BD
            if not devops_done:
                for _bt in _all_tasks_boot:
                    _bt_id = _bt.get("taskId") or _bt.get("task_id") or ""
                    if _bt_id == "TSK-DEVOPS-001" and _bt.get("status") in ("DONE", "QA_PASS"):
                        devops_done = True
                        logger.info("[Monitor Loop] devops_done restaurado: TSK-DEVOPS-001 já está %s no BD.", _bt.get("status"))
                        break
            # 2. Se devops já concluído, corrigir tasks de infra em estados TRAVADOS → DONE.
            #    Só afeta IN_PROGRESS/WAITING_REVIEW/BLOCKED — não toca NEW/ASSIGNED
            #    (TSK-FULL-TEST pode estar ASSIGNED aguardando execução legítima).
            if devops_done:
                for _bt in _all_tasks_boot:
                    _bt_id = _bt.get("taskId") or _bt.get("task_id") or ""
                    if _bt_id in ("TSK-DEVOPS-001", "TSK-FULL-TEST"):
                        _bt_status = _bt.get("status", "")
                        if _bt_status in ("IN_PROGRESS", "WAITING_REVIEW", "BLOCKED"):
                            _update_task(project_id, _bt_id, status="DONE")
                            logger.info(
                                "[Monitor Loop] %s corrigido %s → DONE (devops já concluído — boot fix, estado travado).",
                                _bt_id, _bt_status,
                            )
        except Exception as _dbe:
            logger.debug("[Monitor Loop] Não foi possível restaurar/corrigir estado no boot: %s", _dbe)
    consecutive_dev_blocked: dict[str, int] = {}
    max_consecutive_dev_blocked = int(os.environ.get("MAX_CONSECUTIVE_DEV_BLOCKED", "5"))
    loop_interval = int(os.environ.get("MONITOR_LOOP_INTERVAL", "20"))
    max_qa_rework = int(os.environ.get("MAX_QA_REWORK", "3"))
    # Reconstruir qa_fail_count do BD para sobreviver a restarts do runner.
    # Conta chamadas QA com status=QA_FAIL por task_id — representa reworks acumulados.
    qa_fail_count: dict[str, int] = {}
    try:
        _qfc_base = os.environ.get("API_BASE_URL", "").strip()
        _qfc_token = os.environ.get("GENESIS_API_TOKEN", "").strip()
        if _qfc_base and _qfc_token and project_id:
            import urllib.request as _ur
            _qfc_req = _ur.Request(
                f"{_qfc_base.rstrip('/')}/api/projects/{project_id}/agent-metrics/qa-fail-counts",
                headers={"Authorization": f"Bearer {_qfc_token}"},
            )
            with _ur.urlopen(_qfc_req, timeout=5) as _qfc_resp:
                _qfc_data = json.loads(_qfc_resp.read())
                qa_fail_count = {k: int(v) for k, v in (_qfc_data or {}).items()}
                if qa_fail_count:
                    logger.info("[Monitor Loop] qa_fail_count restaurado do BD: %s", qa_fail_count)
    except Exception as _qfc_e:
        logger.debug("[Monitor Loop] Não foi possível restaurar qa_fail_count: %s", _qfc_e)
    dev_rework_for_qa: dict[str, int] = {}  # rework_attempt do Dev nesta rodada → QA usa o mesmo
    task_artifacts_for_qa: dict[str, list] = {}  # task_id → artifacts entregues pelo Dev (capturados antes do QA)
    # MONITOR_PARALLEL=true enables concurrent processing of multiple tasks of the
    # same type within a single loop iteration. Default false to preserve behavior.
    monitor_parallel = os.environ.get("MONITOR_PARALLEL", "false").strip().lower() in ("1", "true", "yes")
    _state_lock = threading.Lock() if monitor_parallel else None
    _api_unreachable_count = 0
    MAX_API_UNREACHABLE = 5  # encerrar após 5 falhas consecutivas de API quando devops_done

    while True:
        if _shutdown_requested:
            _post_step("Monitor Loop encerrado (sinal recebido).", request_id)
            break
        status = _get_project_status(project_id)
        if status in ("accepted", "stopped", "completed"):
            _post_step(f"Monitor Loop encerrado: status do projeto é '{status}'.", request_id)
            break
        if status is None:
            _api_unreachable_count += 1
            logger.warning("[Monitor Loop] API inacessível (tentativa %d/%d)", _api_unreachable_count, MAX_API_UNREACHABLE)
            if devops_done and _api_unreachable_count >= MAX_API_UNREACHABLE:
                _post_step("Monitor Loop encerrado: API inacessível após DevOps concluído.", request_id)
                break
        else:
            _api_unreachable_count = 0

        tasks = _get_tasks(project_id)
        try:
            from orchestrator.pipeline_context import validate_backlog_tasks_max_files
            lei8_issues = validate_backlog_tasks_max_files(tasks)
            if lei8_issues:
                logger.warning("[LEI 8] Tasks com mais de 3 arquivos estimados: %s", lei8_issues[:5])
        except Exception:
            pass
        # TSK-FULL-TEST e TSK-DEVOPS-001 são tasks de infraestrutura/pós-entrega:
        # SEMPRE excluídas de pipeline_tasks para não bloquear all_done nem acionar Dev/QA.
        # TSK-FULL-TEST em NEW/ASSIGNED não deve impedir o DevOps de rodar.
        _INFRA_TASKS = {"TSK-FULL-TEST", "TSK-DEVOPS-001"}
        pipeline_tasks = [
            t for t in tasks
            if (t.get("taskId") or t.get("task_id") or "") not in _INFRA_TASKS
        ]
        waiting_review = [t for t in pipeline_tasks if t.get("status") == "WAITING_REVIEW"]
        need_qa = len(waiting_review) > 0
        need_dev = any(
            t.get("status") in ("ASSIGNED", "IN_PROGRESS", "QA_FAIL")
            for t in pipeline_tasks
        )
        # GAP-P8: BLOCKED é terminal — task escalada para humano, Dev não tenta mais.
        # Humano intervém via portal (reprocessar task) para devolver a ASSIGNED.
        _terminal = {"DONE", "QA_PASS", "CANCELLED", "BLOCKED"}
        all_done = bool(pipeline_tasks) and all(t.get("status") in _terminal for t in pipeline_tasks)
        # FT-11: Monitor Autônomo — tentar resolver tasks BLOCKED antes de notificar humano
        _blocked_tasks_raw = [t for t in pipeline_tasks if t.get("status") == "BLOCKED"]
        for _bt in _blocked_tasks_raw:
            _bt_id = _bt.get("taskId") or _bt.get("task_id") or ""
            if _bt.get("monitor_attempted"):
                continue  # já tentou — não tentar novamente
            try:
                _monitor_result = _call_autonomous_monitor(project_id, _bt, request_id)
                if _monitor_result.get("outcome") == "FIXED":
                    _update_task(project_id, _bt_id, status="ASSIGNED", monitor_attempted=True)
                    _post_step(
                        f"🤖 Monitor Autônomo resolveu {_bt_id}: {_monitor_result.get('summary', '')}",
                        request_id,
                    )
                    tasks = _get_tasks(project_id)  # recarregar após fix
                    pipeline_tasks = [t for t in tasks if (t.get("taskId") or t.get("task_id") or "") not in _INFRA_TASKS]
                    all_done = bool(pipeline_tasks) and all(t.get("status") in _terminal for t in pipeline_tasks)
                elif _monitor_result.get("outcome") == "GENESIS_BUG":
                    _update_task(project_id, _bt_id, monitor_attempted=True)
                    _notify_genesis_bug(project_id, _bt_id, _monitor_result.get("bug_report", {}))
                    _post_step(
                        f"🔴 Bug do Genesis detectado em {_bt_id} — equipe Zentriz notificada.",
                        request_id,
                    )
                else:  # ESCALATE ou falha
                    _update_task(project_id, _bt_id, monitor_attempted=True)
            except Exception as _mon_err:
                logger.warning("[FT-11] Monitor Autônomo falhou para task %s: %s", _bt_id, _mon_err)
                try:
                    _update_task(project_id, _bt_id, monitor_attempted=True)
                except Exception:
                    pass
        # Notificar tasks BLOCKED que não foram resolvidas pelo Monitor
        _blocked_tasks = [t.get("taskId") or t.get("task_id") for t in pipeline_tasks if t.get("status") == "BLOCKED"]
        if _blocked_tasks:
            _post_step(
                f"⚠️ {len(_blocked_tasks)} task(s) em BLOCKED (requer revisão humana): "
                f"{', '.join(str(t) for t in _blocked_tasks[:3])}{'...' if len(_blocked_tasks) > 3 else ''}. "
                f"Acesse o portal para reprocessar.",
                request_id,
            )

        if need_qa and waiting_review:
            # In parallel mode process all waiting_review tasks concurrently; in
            # sequential mode (default) only the first task is processed per iteration.
            qa_tasks_batch = waiting_review if monitor_parallel else waiting_review[:1]

            def _run_qa_task(task: dict, _captured_dev_artifacts: list | None = None) -> None:
                tid = task.get("taskId") or task.get("task_id")
                task_desc = task.get("title") or task.get("description") or task.get("name") or ""
                # task_delivered_files: somente o que o Dev entregou para ESTA task.
                # Capturado no momento do dispatch (não via closure para evitar race condition).
                _task_files = [
                    a for a in (_captured_dev_artifacts or [])
                    if isinstance(a, dict) and a.get("path") and a.get("content")
                ] or None
                # QA recebe SOMENTE os arquivos entregues pelo Dev desta task.
                # Ler do disco os mesmos paths para garantir conteúdo não truncado.
                _qa_artifacts: list = []
                if _task_files:
                    _proj_root = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / (project_id or "")
                    for _tf in _task_files:
                        _disk_path = _proj_root / _tf["path"]
                        if _disk_path.exists() and _disk_path.stat().st_size < 200_000:
                            _qa_artifacts.append({
                                "path": _tf["path"],
                                "content": _disk_path.read_text(encoding="utf-8", errors="replace"),
                            })
                        else:
                            _qa_artifacts.append(_tf)
                if not _qa_artifacts:
                    # fallback: apenas os arquivos entregues pelo Dev (sem ler todo o disco)
                    _qa_artifacts = _task_files or (_captured_dev_artifacts or [])
                code_refs = [a.get("path") for a in _qa_artifacts if isinstance(a, dict) and a.get("path")]
                _post_step(f"O Monitor acionou o QA para revisar a tarefa {tid}.", request_id)
                _post_agent_working("qa", "O QA está revisando os artefatos e executando testes.", request_id)
                try:
                    # Simetria: QA usa o mesmo rework_attempt que o Dev usou nesta rodada.
                    # Buscar com tid normalizado — garante match mesmo com diferença de formato.
                    _norm_qa_tid = str(tid).strip() if tid else ""
                    _qa_rework = (
                        dev_rework_for_qa.get(_norm_qa_tid) or
                        dev_rework_for_qa.get(tid) or
                        qa_fail_count.get(tid, 0)
                    )
                    qa_response = call_qa(
                        spec_ref, charter_summary, backlog_summary, dev_summary, request_id,
                        task_id=tid, task=task_desc, code_refs=code_refs, existing_artifacts=_qa_artifacts,
                        rework_attempt=_qa_rework,
                        task_delivered_files=_task_files,
                    )
                    _audit_log("qa", request_id, qa_response, task_id=tid, round_num=_qa_rework + 1)
                    _qa_summary = qa_response.get("summary", "")
                    qa_status = qa_response.get("status", "?")
                    _post_dialogue(
                        "dev", "qa", "qa.review",
                        _get_summary_human("qa.review", "qa", "monitor", _qa_summary[:200]),
                        request_id,
                    )
                    if project_id and storage and storage.is_enabled():
                        storage.write_doc(project_id, "qa", f"report-{tid}", _content_for_doc(qa_response), title=f"QA report {tid}")
                    passed = _is_qa_pass(qa_response)
                    if passed:
                        _update_task(project_id, tid, status="QA_PASS")
                        _update_task_status(project_id, tid, "IN_REVIEW", "DONE")
                        if _task_state:
                            _task_state.mark_done(tid)
                            _task_state.save()
                        with (_state_lock or _NullLock()):
                            qa_fail_count[tid] = 0
                        if pipeline_ctx and last_dev_artifacts:
                            for art in last_dev_artifacts:
                                if isinstance(art, dict) and art.get("path") and art.get("content"):
                                    path_val = (art.get("path") or "").strip()
                                    if path_val.startswith("apps/") or path_val.startswith("docs/"):
                                        pipeline_ctx.register_artifact(path_val, art.get("content", ""), tid)
                        _post_step(f"QA concluiu. Status: {qa_status}. Task {tid} aprovada (DONE).", request_id)
                    else:
                        with (_state_lock or _NullLock()):
                            current_fails = qa_fail_count.get(tid, 0) + 1
                            qa_fail_count[tid] = current_fails
                        if current_fails >= max_qa_rework:
                            # GAP-P2: se QA reportou BLOCKER, marcar como BLOCKED (não DONE)
                            # BLOCKED é visível no portal e não alimenta tasks dependentes
                            _has_blocker = _qa_has_blocker(qa_response)
                            _final_status = "BLOCKED" if _has_blocker else "DONE"
                            _update_task(project_id, tid, status=_final_status)
                            if _task_state:
                                _task_state.mark_qa_fail(tid)
                                _task_state.save()
                            with (_state_lock or _NullLock()):
                                tasks_done_after_qa_fail.add(tid)
                            _label = "BLOCKED (BLOCKER aberto)" if _has_blocker else "DONE (não aprovada)"
                            _post_step(
                                f"QA reportou QA_FAIL (reatempto {current_fails}/{max_qa_rework}). "
                                f"Task {tid} marcada como {_label}.",
                                request_id,
                            )
                            _post_escalation_event(
                                project_id, tid,
                                f"QA atingiu máximo de {current_fails} reworks sem aprovação"
                                + (" — BLOCKER aberto, revisão humana obrigatória." if _has_blocker else ". Revisão humana necessária."),
                                request_id,
                            )
                        else:
                            _update_task_status(project_id, tid, "IN_REVIEW", "QA_FAIL")
                            _post_step(
                                f"QA concluiu. Task {tid} em QA_FAIL (reatempto {current_fails}/{max_qa_rework}).",
                                request_id,
                            )
                except Exception as e:
                    logger.exception("[Monitor Loop] QA falhou para task %s", tid)
                    _post_error(str(e), request_id, e)

            if monitor_parallel and len(qa_tasks_batch) > 1:
                with ThreadPoolExecutor(max_workers=min(len(qa_tasks_batch), 3)) as pool:
                    futures = [
                        pool.submit(_run_qa_task, t, task_artifacts_for_qa.get(str(t.get("taskId") or t.get("task_id") or "").strip()))
                        for t in qa_tasks_batch
                    ]
                    for f in as_completed(futures):
                        f.result()  # re-raise if any raised
            else:
                _qt = qa_tasks_batch[0]
                _qt_id = str(_qt.get("taskId") or _qt.get("task_id") or "").strip()
                _run_qa_task(_qt, task_artifacts_for_qa.get(_qt_id))
            time.sleep(2)
            continue

        if need_dev:
            # GAP-NEW-1: BLOCKED é terminal — não redespachar ao Dev automaticamente.
            # Dev só recebe ASSIGNED/IN_PROGRESS/QA_FAIL; BLOCKED requer intervenção humana.
            dev_task = next(
                (
                    t
                    for t in tasks
                    if t.get("status") in ("ASSIGNED", "IN_PROGRESS", "QA_FAIL")
                    and (t.get("taskId") or t.get("task_id")) not in dev_gave_up_tasks
                ),
                None,
            )
            if dev_task:
                task_id = dev_task.get("taskId") or dev_task.get("task_id")
                task_desc = dev_task.get("requirements") or dev_task.get("title") or dev_task.get("description") or dev_task.get("name") or "Implementar tarefa do backlog."
                _update_task_status(project_id, task_id, dev_task.get("status", "ASSIGNED"), "IN_PROGRESS")
                _post_step("O Monitor acionou o Dev para implementar ou rework.", request_id)
                _post_agent_working("dev", "O Dev está implementando ou corrigindo a tarefa.", request_id)
                try:
                    dep_code = None
                    if pipeline_ctx:
                        depends_on = dev_task.get("depends_on_files") or dev_task.get("dependsOnFiles") or []
                        dep_code = pipeline_ctx.get_dependency_code(depends_on)
                        # GAP-P4: verificar se os arquivos de dependência realmente existem no disco
                        if depends_on and project_id:
                            _proj_root = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id
                            _missing = [
                                f for f in depends_on
                                if f and not (_proj_root / f).exists() and not (_proj_root / "apps" / f).exists()
                            ]
                            if _missing:
                                logger.warning(
                                    "[GAP-P4] depends_on_files ausentes no disco para task %s: %s",
                                    dev_task.get("taskId", "?"), _missing[:5],
                                )
                                _post_step(
                                    f"Aviso: task {dev_task.get('taskId','?')} depende de arquivo(s) não encontrado(s) "
                                    f"no disco: {_missing[:3]}. Dev receberá contexto parcial.",
                                    request_id,
                                )
                    # Limpar pastas paralelas proibidas antes de despachar Dev (Node.js backend)
                    # O Dev frequentemente cria src/modules/, src/repositories/, src/database/ por engano.
                    # Remover antes do despacho garante que o Dev receba existing_artifacts sem lixo.
                    if project_id:
                        _apps_root = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "apps" / "src"
                        _forbidden_dirs = ["modules", "repositories", "database", "controllers", "models", "services", "use-cases", "use_cases"]
                        _valid_dirs = {"db", "domain", "infra", "http", "application", "shared", "routes",
                                       "app.ts", "index.ts"}  # index.ts/app.ts são ficheiros, não pastas
                        if _apps_root.exists():
                            for _fd in _forbidden_dirs:
                                _fpath = _apps_root / _fd
                                if _fpath.exists() and _fpath.is_dir():
                                    # Só remover se já existe a pasta válida equivalente
                                    _has_valid_infra = (_apps_root / "infra").exists()
                                    _has_valid_db = (_apps_root / "db").exists()
                                    _has_valid_app = (_apps_root / "application").exists()
                                    _should_remove = (
                                        (_fd == "repositories" and _has_valid_infra) or
                                        (_fd == "database" and _has_valid_db) or
                                        ((_fd in ("use-cases", "use_cases")) and _has_valid_app) or
                                        _fd in ("modules", "controllers", "models")
                                    )
                                    if _should_remove:
                                        import shutil as _shutil
                                        _shutil.rmtree(_fpath)
                                        logger.info("[PreDispatch] Pasta paralela removida: %s", _fpath)
                                        _post_step(
                                            f"Limpeza: pasta paralela `src/{_fd}/` removida antes do Dev "
                                            f"(código correto em src/infra/ ou src/db/).",
                                            request_id,
                                        )

                    # Derive variant from owner_role (DEV_WEB → web, DEV_MOBILE → mobile, else backend)
                    _owner = (dev_task.get("ownerRole") or dev_task.get("owner_role") or "DEV_BACKEND").upper()
                    _dev_variant = "web" if "WEB" in _owner else ("mobile" if "MOBILE" in _owner else "backend")
                    # Detect backend language — disk-first (cached in pipeline_ctx after first call)
                    # pm_module is not in scope here; use pipeline_ctx.current_module instead
                    _current_module = (pipeline_ctx.current_module if pipeline_ctx else None) or "backend"
                    if _dev_variant == "backend":
                        try:
                            _ml_stack = _resolve_backend_stack(
                                pipeline_ctx, project_id,
                                engineer_proposal=getattr(pipeline_ctx, "engineer_proposal", "") if pipeline_ctx else "",
                                charter_summary=charter_summary,
                                backlog_summary=backlog_summary,
                                module=_current_module,
                            )
                            _ml_lang = _ml_stack["language"]
                            if _ml_lang != "nodejs":
                                _dev_variant = f"backend_{_ml_lang}" if _ml_lang != "other" else "backend"
                                logger.info("[Monitor Loop] Stack detectado: %s (source=%s, confidence=%s) → variant=%s",
                                            _ml_lang, _ml_stack["source"], _ml_stack["confidence"], _dev_variant)
                        except RuntimeError as _ml_e:
                            logger.error("[Monitor Loop] Stack detection FAILED: %s — usando 'backend' (nodejs)", _ml_e)
                    # Load existing apps/ artifacts from disk so Dev has full context
                    _disk_artifacts: list = []
                    try:
                        _apps_root = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "apps"
                        if _apps_root.exists():
                            for _f in sorted(_apps_root.rglob("*")):
                                if _f.is_file() and _f.stat().st_size < 50_000:
                                    _rel = str(_f.relative_to(_apps_root.parent.parent))
                                    _disk_artifacts.append({"path": _rel, "content": _f.read_text(encoding="utf-8", errors="replace")})
                    except Exception:
                        pass
                    # No rework (QA_FAIL), usar artefatos capturados desta task — evita
                    # poluição com last_dev_artifacts de outras tasks processadas no meio.
                    _norm_ea_tid = str(task_id).strip() if task_id else ""
                    _captured_for_rework = task_artifacts_for_qa.get(_norm_ea_tid)
                    _ea = (_captured_for_rework or last_dev_artifacts) if dev_task.get("status") == "QA_FAIL" else _disk_artifacts
                    # Simetria de modelo: Dev e QA usam o mesmo rework_attempt.
                    # Se Dev escalou para Opus, QA também usa Opus nessa rodada.
                    # Normalizar task_id para garantir match com a chave usada pelo QA loop.
                    _task_rework_count = qa_fail_count.get(task_id, 0)
                    # Salvar com task_id normalizado — QA usa o mesmo formato via tid
                    _norm_tid = str(task_id).strip() if task_id else ""
                    dev_rework_for_qa[_norm_tid] = _task_rework_count
                    dev_rework_for_qa[task_id] = _task_rework_count  # fallback duplicado
                    dev_response = call_dev(
                        spec_ref, charter_summary, backlog_summary, request_id,
                        task_id=task_id, task=task_desc, code_refs=[],
                        existing_artifacts=_ea,
                        task_dict=dev_task, dependency_code=dep_code, pipeline_ctx=pipeline_ctx,
                        dev_variant=_dev_variant,
                        rework_attempt=_task_rework_count,
                    )
                    _audit_log("dev", request_id, dev_response, task_id=task_id, round_num=_task_rework_count + 1)
                    dev_summary = dev_response.get("summary", "")
                    dev_status = dev_response.get("status", "?")
                    last_dev_artifacts = dev_response.get("artifacts", [])
                    # Capturar artefatos desta task para o QA — evita race condition com last_dev_artifacts
                    if task_id:
                        task_artifacts_for_qa[str(task_id).strip()] = list(last_dev_artifacts)
                    _post_dialogue(
                        "pm", "dev", "task.assigned",
                        _get_summary_human("task.assigned", "pm", "dev", backlog_summary[:200]),
                        request_id,
                    )
                    _post_dialogue(
                        "dev", "qa", "task.completed",
                        _get_summary_human("task.completed", "dev", "qa", dev_summary[:200]),
                        request_id,
                    )
                    circuit_breaker = dev_response.get("circuit_breaker_open") or ("Circuit breaker" in (dev_summary or ""))
                    if circuit_breaker:
                        _update_task(project_id, task_id, status="DONE")
                        dev_gave_up_tasks.add(task_id)
                        _post_step(
                            "Circuit breaker do Dev aberto. Tarefa marcada como DONE (não aprovada). Intervenção humana necessária.",
                            request_id,
                        )
                        _post_escalation_event(
                            project_id, task_id,
                            "Circuit breaker do Dev aberto após falhas consecutivas. Revisão humana necessária.",
                            request_id,
                        )
                        time.sleep(2)
                        continue
                    _has_apps_artifact = any(
                        (a.get("path") or "").strip().startswith("apps/")
                        for a in (last_dev_artifacts or []) if isinstance(a, dict)
                    )
                    if project_id and storage and storage.is_enabled():
                        storage.write_doc(project_id, "dev", "implementation", _content_for_doc(dev_response), title="Dev implementation")
                        dev_artifacts = last_dev_artifacts
                        try:
                            from orchestrator.envelope import filter_artifacts_by_path_policy
                            dev_artifacts = filter_artifacts_by_path_policy(dev_artifacts, project_id)
                        except ImportError:
                            pass
                        _has_apps_artifact = any(
                            (a.get("path") or "").strip().startswith("apps/")
                            for a in dev_artifacts if isinstance(a, dict)
                        )
                        for i, art in enumerate(dev_artifacts):
                            if not isinstance(art, dict) or not art.get("content"):
                                continue
                            content = art.get("content", "")
                            path_val = (art.get("path") or "").strip()
                            if path_val.startswith("apps/"):
                                try:
                                    storage.write_apps_artifact(project_id, path_val[5:].lstrip("/"), content if isinstance(content, str) else str(content))
                                except Exception as _e:
                                    logger.warning("[Monitor Loop] Falha ao gravar apps artifact: %s", _e)
                            elif path_val.startswith("docs/"):
                                try:
                                    storage.write_doc_by_path(project_id, "dev", path_val[5:].lstrip("/"), content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                                except Exception as _e:
                                    logger.warning("[Monitor Loop] write_doc_by_path falhou, fallback write_doc: %s", _e)
                                    storage.write_doc(project_id, "dev", path_val.replace("/", "_").replace(".", "_")[:60] or f"artifact_{i}", content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                            elif path_val:
                                storage.write_doc(project_id, "dev", f"artifact_{i}", content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                    if _has_apps_artifact:
                        consecutive_dev_blocked[task_id] = 0
                        _update_task(project_id, task_id, status="WAITING_REVIEW")
                        _post_step(f"Dev concluiu. Status: {dev_status}. Task em WAITING_REVIEW.", request_id)
                    else:
                        n = consecutive_dev_blocked.get(task_id, 0) + 1
                        consecutive_dev_blocked[task_id] = n
                        if n >= max_consecutive_dev_blocked:
                            _update_task(project_id, task_id, status="DONE")
                            dev_gave_up_tasks.add(task_id)
                            _post_step(
                                f"Máximo de tentativas do Dev atingido ({n}x sem artefato em apps/). Tarefa marcada como DONE (não aprovada).",
                                request_id,
                            )
                            _post_escalation_event(
                                project_id, task_id,
                                f"Dev atingiu máximo de {n} tentativas sem entregar artefato. Revisão humana necessária.",
                                request_id,
                            )
                        else:
                            _update_task(project_id, task_id, status="BLOCKED")
                            _post_step(
                                f"Dev não entregou artefato em apps/. Task mantida para rework (tentativa {n}/{max_consecutive_dev_blocked}).",
                                request_id,
                            )
                except Exception as e:
                    logger.exception("[Monitor Loop] Dev falhou")
                    _post_error(str(e), request_id, e)
                    _update_task_status(project_id, task_id, "IN_PROGRESS", "BLOCKED")
                time.sleep(2)
                continue

        if all_done and not devops_done:
            # Para projetos triviais (HTML puro, CSS puro, 1 task), DevOps é desperdício —
            # o Dev master já entrega os artefatos prontos sem necessidade de docker/npm.
            # O start.sh trivial é gerado diretamente pelo runner: apenas abrir index.html.
            _is_trivial_project = any(
                (t.get("taskId") or t.get("task_id") or "") == "TSK-TRIVIAL-001"
                for t in tasks
            )
            if _is_trivial_project:
                devops_done = True
                # Gerar start.sh mínimo para HTML estático
                if project_id:
                    try:
                        _trivial_project_dir = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "project"
                        _trivial_project_dir.mkdir(parents=True, exist_ok=True)
                        _trivial_apps_dir = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "apps"
                        _trivial_start_sh = (
                            "#!/bin/bash\n"
                            "# Landing page estática — abrir diretamente no browser\n"
                            f'SCRIPT_DIR=$(dirname "$0")\n'
                            f'INDEX="$SCRIPT_DIR/../apps/index.html"\n'
                            'if [ -f "$INDEX" ]; then\n'
                            '  if command -v open >/dev/null 2>&1; then open "$INDEX"\n'
                            '  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$INDEX"\n'
                            '  else echo "Abra no browser: $INDEX"; fi\n'
                            '  echo "✅ Landing page: file://$(realpath $INDEX)"\n'
                            'else\n'
                            '  echo "[ERRO] index.html não encontrado em $INDEX"; exit 1\n'
                            'fi\n'
                        )
                        (_trivial_project_dir / "start.sh").write_text(_trivial_start_sh, encoding="utf-8")
                        import stat as _stat
                        _sh_path = _trivial_project_dir / "start.sh"
                        _sh_path.chmod(_sh_path.stat().st_mode | _stat.S_IEXEC | _stat.S_IXGRP | _stat.S_IXOTH)
                        logger.info("[Trivial] start.sh gerado em %s", _sh_path)
                    except Exception as _tsh_e:
                        logger.warning("[Trivial] Falha ao gerar start.sh: %s", _tsh_e)
                _post_step("Produto HTML estático pronto. Abra apps/index.html no browser ou execute start.sh.", request_id)
                _post_step(
                    "✅ Produto pronto. Aguardando Aceite — clique em Aceitar para confirmar a entrega ou Parar para encerrar.",
                    request_id,
                )
                _patch_project({"status": "completed", "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")})
                if _run_log:
                    try:
                        _run_log.stop_run(reason="completed")
                    except Exception:
                        pass
                break
            if tasks_done_after_qa_fail:
                _post_step(
                    "Monitor: algumas tarefas não foram aprovadas pelo QA, mas o produto foi gerado. "
                    "Acionando DevOps para gerar start.sh e executar localmente.",
                    request_id,
                )
            if True:  # Always run DevOps when all tasks are done, regardless of QA failures
                # GAP-P5: seed TSK-DEVOPS-001 na tabela de tasks para visibilidade no portal
                if project_id and _api_available():
                    try:
                        _devops_seed_path = f"/api/projects/{project_id}/tasks"
                        _devops_task = [{
                            "task_id":   "TSK-DEVOPS-001",
                            "taskId":    "TSK-DEVOPS-001",
                            "module":    pm_module or "web",
                            "owner_role": "DEVOPS_DOCKER",
                            "ownerRole":  "DEVOPS_DOCKER",
                            "status":    "IN_PROGRESS",
                            "requirements": "Provisionar artefatos de infraestrutura: start.sh, docker-compose.yml, RUNBOOK.md",
                            "depends_on_files": [],
                            "target_route": "infra",
                        }]
                        _d, _s = _api_post(_devops_seed_path, {"tasks": _devops_task})
                        if 200 <= _s < 300:
                            logger.info("[GAP-P5] TSK-DEVOPS-001 criada no portal.")
                    except Exception as _de:
                        logger.debug("[GAP-P5] Seed TSK-DEVOPS-001 falhou (não crítico): %s", _de)
                _post_step("O Monitor acionou o DevOps para provisionamento e execução local.", request_id)
                _post_agent_working("devops", "O DevOps está analisando os artefatos e preparando o ambiente de execução local.", request_id)
                try:
                    # Collect all dev artifacts from disk for DevOps stack detection
                    _all_dev_artifacts: list = []
                    if project_id:
                        try:
                            _apps_root = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "apps"
                            if _apps_root.exists():
                                for _f in sorted(_apps_root.rglob("*")):
                                    if _f.is_file() and _f.stat().st_size < 30_000 and not any(p in str(_f) for p in ("node_modules", ".next", ".git")):
                                        _rel = str(_f.relative_to(_apps_root.parent))
                                        _all_dev_artifacts.append({"path": _rel, "content": _f.read_text(encoding="utf-8", errors="replace")})
                        except Exception as _de:
                            logger.warning("[Monitor Loop] Erro ao coletar dev artifacts para DevOps: %s", _de)
                    _combined_artifacts = _all_dev_artifacts or last_dev_artifacts
                    # I-5: resolver product_id localmente — evita problema de closure com _product_id do main()
                    _devops_product_id: str | None = None
                    try:
                        _devops_product_id = _product_id  # type: ignore[name-defined]
                    except NameError:
                        try:
                            _pd, _ = _api_get(f"/api/projects/{project_id}")
                            if _pd and isinstance(_pd, dict):
                                _devops_product_id = _pd.get("productId") or _pd.get("product_id")
                        except Exception:
                            pass
                    devops_response = call_devops(
                        spec_ref, charter_summary, backlog_summary, request_id,
                        dev_artifacts=_combined_artifacts,
                        project_id=project_id,
                        product_id=_devops_product_id,
                    )
                    _audit_log("devops", request_id, devops_response)
                    devops_summary = devops_response.get("summary", "")
                    _post_dialogue(
                        "monitor", "devops", "devops.deploy",
                        _get_summary_human("devops.deploy", "devops", "cto", devops_summary[:200]),
                        request_id,
                    )
                    if project_id and storage and storage.is_enabled():
                        storage.write_doc(project_id, "devops", "summary", _content_for_doc(devops_response), title="DevOps summary")
                        devops_artifacts = devops_response.get("artifacts", [])
                        try:
                            from orchestrator.envelope import filter_artifacts_by_path_policy
                            devops_artifacts = filter_artifacts_by_path_policy(devops_artifacts, project_id)
                        except ImportError:
                            pass
                        for i, art in enumerate(devops_artifacts):
                            if not isinstance(art, dict) or not art.get("content"):
                                continue
                            content = art.get("content", "")
                            path_val = (art.get("path") or "").strip()
                            if path_val.startswith("project/"):
                                try:
                                    storage.write_project_artifact(project_id, path_val[8:].lstrip("/"), content if isinstance(content, str) else str(content))
                                    if pipeline_ctx:
                                        pipeline_ctx.register_artifact(path_val, content if isinstance(content, str) else str(content))
                                except Exception as _e:
                                    logger.warning("[Monitor Loop] Falha ao gravar project artifact: %s", _e)
                            elif path_val.startswith("docs/"):
                                try:
                                    storage.write_doc_by_path(project_id, "devops", path_val[5:].lstrip("/"), content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                                    if pipeline_ctx:
                                        pipeline_ctx.register_artifact(path_val, content if isinstance(content, str) else str(content))
                                except Exception as _e:
                                    logger.warning("[Monitor Loop] write_doc_by_path devops falhou, fallback write_doc: %s", _e)
                                    storage.write_doc(project_id, "devops", path_val.replace("/", "_").replace(".", "_")[:60] or f"artifact_{i}", content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                                    if pipeline_ctx:
                                        pipeline_ctx.register_artifact(path_val, content if isinstance(content, str) else str(content))
                            elif path_val:
                                storage.write_doc(project_id, "devops", f"artifact_{i}", content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                                if pipeline_ctx:
                                    pipeline_ctx.register_artifact(f"docs/devops/artifact_{i}.md", content if isinstance(content, str) else str(content))
                    if pipeline_ctx:
                        emitted = _emit_connect_contracts("devops", pipeline_ctx, project_id, storage, request_id)
                        if emitted:
                            _post_step(
                                "Artefatos operacionais do Connect emitidos após o DevOps: ObservabilityBaselineManifest, RuntimePassport e KnownSafeActionsPack.",
                                request_id,
                            )
                    devops_done = True
                    # GAP-P5: atualizar TSK-DEVOPS-001 para DONE
                    if project_id and _api_available():
                        try:
                            _update_task(project_id, "TSK-DEVOPS-001", status="DONE")
                        except Exception:
                            pass
                    # Persistir TSK-DEVOPS-001 no TaskState para sobreviver a restarts do runner
                    if _task_state:
                        _task_state.mark_done("TSK-DEVOPS-001")
                        _task_state.save()
                    _post_step("DevOps concluiu artefatos. Iniciando execução local do produto.", request_id)
                    # Run locally: build + serve + open browser
                    if project_id:
                        _run_local_deploy(project_id, devops_response, request_id)

                    # ── TASK-FULL-TEST — Claude Code Agent (end-to-end) ───────────────────
                    # Seed task no portal
                    if project_id and _api_available():
                        try:
                            _api_post(f"/api/projects/{project_id}/tasks", {"tasks": [{
                                "task_id":   "TSK-FULL-TEST",
                                "taskId":    "TSK-FULL-TEST",
                                "module":    "test",
                                "ownerRole": "QA",
                                "requirements": (
                                    "TSK-FULL-TEST — Validação E2E completa e CORREÇÃO de bugs pelo Claude Code Agent. "
                                    "Esta é a ÚLTIMA task. O agente DEVE: "
                                    "(1) build sem erros TypeScript; "
                                    "(2) executar start.sh e confirmar que o servidor sobe; "
                                    "(3) chamar TODOS os endpoints da API com token real e verificar HTTP 200; "
                                    "(4) corrigir QUALQUER bug encontrado — Content-Type, rotas 404, campos errados, CORS; "
                                    "(5) só marcar APROVADO quando o produto funciona end-to-end de verdade. "
                                    "Ver prompt completo em project/full-test-prompt.md"
                                ),
                                "status":    "ASSIGNED",
                                "depends_on_files": [],
                                "target_route": "/",
                            }]})
                        except Exception: pass

                    # Gerar prompt para Claude Code Agent no disco do projeto (host path)
                    _host_root = os.environ.get("HOST_PROJECT_FILES_ROOT", "").strip()
                    _proj_host_dir = Path(_host_root) / project_id if (_host_root and project_id) else None
                    _proj_container_dir = (Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id) if project_id else None

                    _ft_prompt = f"""# TASK-FULL-TEST — Validação E2E e Correção Final

Você é o Claude Code Agent. Esta é a ÚLTIMA task do pipeline — o produto só vai para aceite humano após você garantir que funciona end-to-end de verdade.

## Projeto
- Path: {_proj_host_dir or 'VER PROJECT_FILES_ROOT'}
- Apps: {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}

## REGRA FUNDAMENTAL
Esta task tem 3 fases obrigatórias em sequência. Não avance para a fase seguinte sem concluir a anterior.
Se encontrar um bug: CORRIJA IMEDIATAMENTE antes de continuar. Não liste para corrigir depois.

---

## FASE 1 — Build e TypeScript (BLOCKER se falhar)

```bash
cd {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}
npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -3
npm run build 2>&1 | tail -20
```

- Se houver erros TypeScript: corrija cada um até `npm run build` passar sem erros
- Erros comuns a corrigir:
  - `Property 'X' does not exist on type 'Y'` → campo com nome errado
  - `dialog slotProps.paper` → deve ser `PaperProps` em MUI Dialog
  - `useSearchParams() should be wrapped in a suspense boundary` → adicionar `<Suspense>`
  - `axios.isCancel()` narrowing para `never` → mover cast para depois do bloco isCancel
  - Interface extends AxiosRequestConfig com prop conflitante → adicionar ao Omit<>
  - Função com `err: ValidationIssue[]` recebendo `unknown` → trocar para `err: unknown`

---

## FASE 2 — Servidor e Integração (BLOCKER se falhar)

Execute `project/start.sh` e confirme que o servidor sobe.
Se o projeto tem `linked_projects_context` (consome backend externo), faça TODOS estes testes:

### 2a. Login
```bash
TOKEN=$(curl -s -X POST <BACKEND_URL>/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{{"email":"<SEED_EMAIL>","password":"<SEED_PASSWORD>"}}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{{}}).get('accessToken','FAIL'))")
echo "TOKEN: $TOKEN"
```
- Se retornar 415 → `Content-Type` errado — corrigir para `application/json`
- Se TOKEN=FAIL → verificar campo: backend Fastify retorna `accessToken`, não `token`

### 2b. Varredura de query params (BLOCKER se errado)

Antes de testar os endpoints, varrer os arquivos `src/lib/*.ts` para detectar params inválidos:

```bash
# Detectar 'perPage' — deve ser 'limit'
grep -rn "perPage" {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}/src/lib/ {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}/src/hooks/ {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}/src/components/ 2>/dev/null

# Detectar sort com valores inventados — verificar enum real do backend
grep -rn "sort" {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}/src/lib/ {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}/src/hooks/ 2>/dev/null | grep "newest\\|popular\\|recent"

# Detectar sort com prefixo '-' (Fastify rejeita)
grep -rn "sort.*'-\\|sort.*\"-" {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}/src/lib/ {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}/src/hooks/ 2>/dev/null
```

Se encontrar `perPage`: substituir por `limit` em todos os arquivos.
Se encontrar `sort='newest'` ou outro valor não-listado no backend: substituir pelos valores válidos do schema Zod.
Verificar o schema do backend: `grep -n "sort.*enum\\|z\\.enum" <backend_apps>/src/http/schemas/*.schema.ts`

### 2c. Varredura de hrefs vs pages existentes (BLOCKER se faltando)

```bash
# Listar todos os hrefs que o nav/footer linka
grep -rh 'href="/' {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}/src/components/layout/ 2>/dev/null | grep -oE '"(/[^"?#]+)"' | sort -u

# Listar todas as pages existentes
find {_proj_host_dir / 'apps' if _proj_host_dir else 'apps/'}/src/app -name "page.tsx" 2>/dev/null | sed 's|.*/src/app||' | sed 's|/page.tsx||' | sort
```

Para cada href que não tiver uma page.tsx correspondente: criar página stub com Header + Footer + título.
Exemplo de stub:
```tsx
import Box from '@mui/material/Box'; import Container from '@mui/material/Container'; import Typography from '@mui/material/Typography';
import {{{{ Header }}}} from '@/components/layout/Header'; import {{{{ Footer }}}} from '@/components/layout/Footer';
export default function Route(): JSX.Element {{{{
  return (<Box sx={{{{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}}}>
    <Header /><Box component="main" sx={{{{ flex: 1 }}}}><Container sx={{{{ py: 6 }}}}><Typography variant="h4">Título</Typography></Container></Box><Footer />
  </Box>);
}}}}
```

### 2d. Todos os endpoints que o frontend consome
Para cada rota em `src/lib/*.ts`, executar `curl` com o TOKEN e verificar HTTP 200.
Erros críticos a corrigir:
- HTTP 404 → rota errada. Verificar `app.ts` do backend para prefix real (ex: `/api/admin/orders` não `/api/orders`)
- HTTP 415 → Content-Type errado (deve ser `application/json`)
- HTTP 400/500 com `VALIDATION_ERROR` → param com nome ou valor errado (ex: `perPage` vs `limit`, `sort='newest'` vs enum real)
- CORS error → adicionar porta do frontend ao `CORS_ORIGIN` no `docker-compose.yml` do backend

### 2e. Operações de escrita
Testar ao menos uma operação POST/PATCH/DELETE em cada domínio com dados reais.

---

## FASE 3 — Relatório e Veredito

Grave `docs/qa/QA_REPORT_TSK-FULL-TEST.md` com:
- Bugs encontrados e corrigidos (lista com arquivo, problema, fix)
- Query params verificados (tabela: param enviado → param aceito pelo backend)
- Hrefs verificados (tabela: href → page.tsx existe?)
- Endpoints testados e status (tabela)
- Status final: APROVADO (tudo funciona E2E) ou ISSUES PENDENTES (lista do que ficou)

Só declare APROVADO se:
- `npm run build` passou sem erros
- Nenhum `perPage` ou sort inválido em `src/lib/*.ts`
- Todos os hrefs de nav/footer têm page.tsx correspondente
- Servidor sobe via `start.sh`
- Todos os endpoints retornam 200 com dados reais
- Operações de escrita funcionam

Execute agora sem pedir confirmação.
"""
                    _ft_prompt_path = None
                    if _proj_container_dir and _proj_container_dir.exists():
                        try:
                            _ft_prompt_path = _proj_container_dir / "project" / "full-test-prompt.md"
                            _ft_prompt_path.parent.mkdir(parents=True, exist_ok=True)
                            _ft_prompt_path.write_text(_ft_prompt, encoding="utf-8")
                            logger.info("[TASK-FULL-TEST] Prompt gravado em %s", _ft_prompt_path)
                        except Exception as _ep:
                            logger.debug("[TASK-FULL-TEST] Falha ao gravar prompt: %s", _ep)

                    # Tentar executar Claude Code Agent automaticamente via subprocess no host
                    _ft_executed = False
                    _ft_result_text = ""
                    _claude_bin = os.environ.get("CLAUDE_BIN", "").strip()
                    if not _claude_bin:
                        # Tentar paths comuns
                        for _cp in ["/Users/mac/.local/bin/claude", "/usr/local/bin/claude", "claude"]:
                            if Path(_cp).exists() if "/" in _cp else True:
                                _claude_bin = _cp
                                break

                    # Chamar o full-test-server.py via HTTP (roda no host, tem acesso ao claude CLI)
                    _ft_server_url = os.environ.get(
                        "FULL_TEST_SERVER_URL",
                        "http://host.docker.internal:7878"
                    )
                    if _proj_host_dir:
                        try:
                            import urllib.request as _ur
                            import json as _json
                            _host_prompt_path = str(
                                Path(_host_root) / project_id / "project" / "full-test-prompt.md"
                            ) if _host_root else ""
                            # FT-13: incluir api_key do projeto para que o full-test-server use a chave correta
                            _ft_payload = _json.dumps({
                                "project_id":   project_id or "",
                                "project_path": str(_proj_host_dir),
                                "prompt_path":  _host_prompt_path,
                                "api_key":      os.environ.get("CLAUDE_API_KEY", ""),
                            }).encode()
                            _post_step("🤖 TASK-FULL-TEST: Claude Code Agent iniciado via full-test-server.", request_id)
                            _update_task(project_id, "TSK-FULL-TEST", status="IN_PROGRESS")
                            _ft_req = _ur.Request(
                                f"{_ft_server_url}/run-full-test",
                                data=_ft_payload,
                                headers={"Content-Type": "application/json"},
                                method="POST",
                            )
                            with _ur.urlopen(_ft_req, timeout=660) as _resp:
                                _ft_resp = _json.loads(_resp.read().decode())
                            _ft_result_text = _ft_resp.get("output", "")
                            _ft_executed = True
                            logger.info("[TASK-FULL-TEST] Server respondeu: status=%s approved=%s",
                                        _ft_resp.get("status"), _ft_resp.get("approved"))
                        except Exception as _srv_err:
                            logger.info("[TASK-FULL-TEST] full-test-server indisponível (%s) — modo manual", _srv_err)

                    if _ft_executed and _ft_result_text:
                        # Salvar resultado no disco
                        if _proj_container_dir:
                            try:
                                _ft_report = _proj_container_dir / "docs" / "qa" / "QA_REPORT_TSK-FULL-TEST.md"
                                _ft_report.parent.mkdir(parents=True, exist_ok=True)
                                _ft_report.write_text(f"# TASK-FULL-TEST — Relatório Claude Code Agent\n\n{_ft_result_text}", encoding="utf-8")
                            except Exception: pass
                        _approved = any(w in _ft_result_text.upper() for w in ["APROVADO", "PASSED", "QA_PASS", "ALL CHECKS"])
                        _ft_final_status = "DONE" if _approved else "QA_FAIL"
                        _update_task(project_id, "TSK-FULL-TEST", status=_ft_final_status)
                        # Persistir TSK-FULL-TEST no TaskState para sobreviver a restarts do runner
                        if _task_state:
                            _task_state.set_status("TSK-FULL-TEST", _ft_final_status)
                            _task_state.save()
                        _post_step(
                            f"{'✅' if _approved else '⚠️'} TASK-FULL-TEST (Claude Code): "
                            f"{'aprovada' if _approved else 'issues encontradas — ver QA_REPORT_TSK-FULL-TEST.md'}",
                            request_id,
                        )
                    else:
                        # Claude Code não disponível — instruir execução manual
                        _host_cmd = f"claude --print --dangerously-skip-permissions --cwd '{_proj_host_dir}/apps' \"Execute as instruções em: {Path(_host_root or '') / (project_id or '') / 'project' / 'full-test-prompt.md'}\""
                        _post_step(
                            f"🔍 TASK-FULL-TEST: Execute manualmente o Claude Code Agent para validação e2e:\n{_host_cmd}",
                            request_id,
                        )
                        _update_task(project_id, "TSK-FULL-TEST", status="ASSIGNED")

                    # Mover o stepper do portal para "Pronto" — postar agent_working do devops
                    # para que o portal não fique preso em "Dev/QA" (último agent_working foi do QA da FULL-TEST)
                    _post_agent_working(
                        "devops",
                        "✅ Pipeline concluído. Cyborg iniciando validação externa...",
                        request_id,
                    )

                    # Marcar projeto como pending_cyborg — Cyborg assume a partir daqui
                    _now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
                    _patch_project({"status": "pending_cyborg", "completed_at": _now_iso, "finished_at": _now_iso})
                    logger.info("[Monitor Loop] Projeto marcado como pending_cyborg — Cyborg assumirá validação.")

                    _post_step(
                        "🤖 Cyborg iniciando validação externa. Acompanhe o progresso na seção Cyborg abaixo.",
                        request_id,
                    )

                    # Disparar o Cyborg via full-test-server.py no host
                    _ft_server_url_cyborg = os.environ.get("FULL_TEST_SERVER_URL", "http://host.docker.internal:7878")
                    _proj_type_cyborg = ""
                    try:
                        import urllib.request as _ur_c
                        import json as _jc
                        # Resolver project_type da API
                        _pt_resp, _pt_status = _api_get(f"/api/projects/{project_id}")
                        _proj_type_cyborg = (_pt_resp or {}).get("project_type") or (_pt_resp or {}).get("projectType") or "other"
                        # Resolver product_id para path correto
                        _product_id_cyborg = (_pt_resp or {}).get("product_id") or (_pt_resp or {}).get("productId") or ""
                        _host_root_cyborg = os.environ.get("HOST_PROJECT_FILES_ROOT", "").strip()
                        if _host_root_cyborg and _product_id_cyborg:
                            _cyborg_dir = str(Path(_host_root_cyborg) / _product_id_cyborg / project_id)
                        elif _host_root_cyborg:
                            _cyborg_dir = str(Path(_host_root_cyborg) / project_id)
                        else:
                            _cyborg_dir = str(_proj_container_dir) if _proj_container_dir else ""
                        _cyborg_payload = _jc.dumps({
                            "project_id":      project_id or "",
                            "project_dir":     _cyborg_dir,
                            "project_type":    _proj_type_cyborg,
                            "genesis_api_url": os.environ.get("API_BASE_URL", "http://localhost:3000"),
                            "genesis_token":   os.environ.get("GENESIS_API_TOKEN", ""),
                            "attempt":         1,
                            "api_key":         os.environ.get("CLAUDE_API_KEY", ""),
                        }).encode()
                        _cyborg_req = _ur_c.Request(
                            f"{_ft_server_url_cyborg}/launch-cyborg",
                            data=_cyborg_payload,
                            headers={"Content-Type": "application/json"},
                            method="POST",
                        )
                        with _ur_c.urlopen(_cyborg_req, timeout=15) as _cr:
                            _cyborg_resp = _jc.loads(_cr.read().decode())
                        logger.info("[CYBORG] Lançado: job_id=%s attempt=1", _cyborg_resp.get("job_id"))
                        _post_step(f"🤖 Cyborg lançado (job {_cyborg_resp.get('job_id', '?')}) — validando tentativa 1/5.", request_id)
                    except Exception as _cyborg_err:
                        logger.warning("[CYBORG] Não foi possível lançar Cyborg: %s", _cyborg_err)
                        _post_step(
                            "⚠️ Cyborg indisponível — validação manual necessária. "
                            "Clique em Aceitar para confirmar a entrega.",
                            request_id,
                        )
                        # Fallback: manter pending_cyborg mas sem disparar — usuário pode aceitar manualmente
                    break
                except Exception as e:
                    logger.exception("[Monitor Loop] DevOps falhou")
                    _post_error(str(e), request_id, e)
            time.sleep(2)
            continue

        time.sleep(loop_interval)


# ---------------------------------------------------------------------------
# Pipeline principal
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Runner: spec -> Engineer -> CTO -> PM -> backlog")
    default_spec = "project/spec/PRODUCT_SPEC.md" if (REPO_ROOT / "project" / "spec" / "PRODUCT_SPEC.md").exists() else "spec/PRODUCT_SPEC.md"
    parser.add_argument("--spec", "-s", default=None, help="Caminho relativo ao repo para o spec (FR/NFR)")
    parser.add_argument("--spec-file", "--spec-path", dest="spec_file", metavar="PATH", default=None, help="Caminho absoluto do arquivo de spec (ex.: uploads/<projectId>/arquivo.md)")
    args = parser.parse_args()

    if args.spec_file:
        spec_path = Path(args.spec_file)
        if not spec_path.is_absolute():
            spec_path = spec_path.resolve()
        if not spec_path.exists():
            logger.error("Spec não encontrada: %s", spec_path)
            return 1
        spec_ref = str(spec_path)
    else:
        spec_ref = args.spec or default_spec
        if not (REPO_ROOT / spec_ref).exists():
            logger.error("Spec não encontrada: %s", spec_ref)
            return 1
        spec_path = REPO_ROOT / spec_ref

    request_id = f"runner-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    project_id = _project_id()
    # Inject project_id into all log records for this process
    _ProjectFilter.set_project_id(project_id)
    storage = _project_storage()

    # I-1: Resolver product_id do projeto para estrutura PRODUCT_ID/PROJECT_ID
    _product_id: str | None = None
    if project_id:
        try:
            _proj_data, _ps = _api_get(f"/api/projects/{project_id}")
            if _proj_data and isinstance(_proj_data, dict):
                _product_id = _proj_data.get("productId") or _proj_data.get("product_id") or None
                if _product_id:
                    logger.info("[I-1] Projeto %s pertence ao produto %s — path: %s/%s",
                                project_id[:8], _product_id[:8], _product_id[:8], project_id[:8])
        except Exception as _pe:
            logger.debug("[I-1] Não foi possível resolver product_id: %s", _pe)

    if storage and storage.is_enabled():
        if project_id:
            try:
                from orchestrator.project_storage import ensure_project_dirs
                if ensure_project_dirs(project_id, _product_id):
                    root_desc = f"{_product_id[:8]}/{project_id[:8]}" if _product_id else project_id[:8]
                    logger.info("[Pipeline] Diretórios garantidos: docs/, project/, apps/ para %s", root_desc)
            except Exception as e:
                logger.warning("[Pipeline] ensure_project_dirs: %s", e)
        logger.info(
            "[Pipeline] Armazenamento por projeto ativo: PROJECT_FILES_ROOT=%s",
            os.environ.get("PROJECT_FILES_ROOT", ""),
        )
    else:
        logger.info(
            "[Pipeline] Armazenamento por projeto desativado (PROJECT_FILES_ROOT não definido). "
            "Para gravar artefatos em disco, defina PROJECT_FILES_ROOT e use volume/bind mount no runner."
        )

    logger.info("[Pipeline] Lendo spec: %s", spec_ref)
    spec_content = load_spec(spec_path)

    spec_template_content = _load_spec_template()
    # LEI 11: tentar restaurar checkpoint; senão criar contexto novo
    pipeline_ctx = None
    try:
        from orchestrator.pipeline_context import PipelineContext
        ensure_state_dir()
        loaded = PipelineContext.load_checkpoint(STATE_DIR, project_id or "default")
        if loaded is not None:
            pipeline_ctx = loaded
            logger.info("[Pipeline] Checkpoint restaurado (LEI 11): step=%s, retomando a partir da próxima fase.", pipeline_ctx.current_step)
        else:
            pipeline_ctx = PipelineContext(project_id or "default")
            pipeline_ctx.set_spec_raw(spec_content)
            if spec_template_content:
                pipeline_ctx.set_product_spec_template(spec_template_content)
    except ImportError:
        pipeline_ctx = None

    spec_understood = spec_content
    charter_summary = ""
    engineer_summary = ""
    backlog_summary = ""
    if pipeline_ctx:
        spec_understood = pipeline_ctx.product_spec or spec_content
        charter_summary = pipeline_ctx.charter or ""
        engineer_summary = pipeline_ctx.engineer_proposal or ""
        backlog_summary = pipeline_ctx.backlog or ""
        # Carregar project_type e contexto de projetos linkados da API
        if project_id:
            try:
                _proj_data, _proj_status = _api_get(f"/api/projects/{project_id}")
                if _proj_data and isinstance(_proj_data, dict):
                    _pt = _proj_data.get("projectType") or ""
                    if _pt and not pipeline_ctx.project_type:
                        pipeline_ctx.project_type = str(_pt)
                        logger.info("[Pipeline] project_type=%s", pipeline_ctx.project_type)

                # G-opt3: carregar projetos linkados — contexto rico com artefatos do disco
                if not pipeline_ctx.linked_projects_context:
                    _links_data, _links_status = _api_get(f"/api/projects/{project_id}/links")
                    if _links_data and isinstance(_links_data, list) and len(_links_data) > 0:
                        _ctx_lines = ["## Projetos relacionados a este projeto\n"]
                        _files_root = os.environ.get("PROJECT_FILES_ROOT", "/project-files").rstrip("/")
                        for _lnk in _links_data[:5]:  # max 5 links
                            _direction = _lnk.get("direction", "outgoing")
                            _rel_label = _lnk.get("relation_label", _lnk.get("relation_type", "relacionado"))
                            if _direction == "outgoing":
                                _other_id    = _lnk.get("to_project_id", "")
                                _other_title = _lnk.get("to_title", "")
                                _other_type  = _lnk.get("to_project_type", "")
                                _other_status = _lnk.get("to_status", "")
                            else:
                                _other_id    = _lnk.get("from_project_id", "")
                                _other_title = _lnk.get("from_title", "")
                                _other_type  = _lnk.get("from_project_type", "")
                                _other_status = _lnk.get("from_status", "")
                                _rel_label = f"{_rel_label} (origem)"
                            _ctx_lines.append(
                                f"- **{_other_title}** ({_other_type or 'tipo não especificado'}, "
                                f"status: {_other_status}) — relação: *{_rel_label}*"
                            )
                            _note = _lnk.get("note")
                            if _note:
                                _ctx_lines.append(f"  Nota: {_note}")

                            # Carregar artefatos de contrato do disco do projeto linkado
                            # Prioridade: api_contract.md > curl_examples.sh > RUNBOOK.md > docker-compose.yml
                            if _other_id and _files_root:
                                _linked_root = Path(_files_root) / _other_id
                                _contract_candidates = [
                                    _linked_root / "project" / "api_contract.md",
                                    _linked_root / "project" / "curl_examples.sh",
                                    _linked_root / "docs" / "devops" / "RUNBOOK.md",
                                    _linked_root / "apps" / "docker-compose.yml",
                                    _linked_root / "apps" / "docker-compose.dev.yml",
                                ]
                                _loaded_contracts: list[str] = []
                                _total_chars = 0
                                _MAX_CONTRACT_CHARS = 40_000  # ~10K tokens — suficiente para api_contract completo

                                for _cpath in _contract_candidates:
                                    if _total_chars >= _MAX_CONTRACT_CHARS:
                                        break
                                    try:
                                        _content = _cpath.read_text(encoding="utf-8", errors="replace")
                                        _available = _MAX_CONTRACT_CHARS - _total_chars
                                        if len(_content) > _available:
                                            _content = _content[:_available] + "\n... [truncado por limite de contexto]"
                                        _rel_cpath = str(_cpath.relative_to(_linked_root))
                                        _loaded_contracts.append(
                                            f"\n### `{_rel_cpath}` (projeto: {_other_title})\n\n```\n{_content}\n```"
                                        )
                                        _total_chars += len(_content)
                                        logger.info(
                                            "[LinkedCtx] Carregado %s de projeto %s (%d chars)",
                                            _rel_cpath, _other_id[:8], len(_content),
                                        )
                                    except (FileNotFoundError, OSError):
                                        pass

                                # CONTRACT LAW: api_contract.md é obrigatório para relações uses_backend
                                _api_contract_path = _linked_root / "project" / "api_contract.md"
                                _has_api_contract = _api_contract_path.exists()
                                _link_type_str = _link_type or ""
                                if "uses_backend" in _link_type_str and not _has_api_contract:
                                    # Backend linkado existe mas não tem contrato — avisar fortemente
                                    _ctx_lines.append(
                                        f"\n⚠️ **CONTRACT LAW VIOLATION:** O projeto backend **{_other_title}** "
                                        f"NÃO tem `project/api_contract.md`. "
                                        "Nenhum Dev ou QA pode implementar/validar integração sem o contrato. "
                                        "O backend DEVE gerar este arquivo. Se você é o primeiro projeto rodando, "
                                        "ignore este aviso — o backend ainda será gerado. "
                                        "Se o backend já foi concluído, verificar se o DevOps gerou o api_contract.md."
                                    )
                                    logger.warning(
                                        "[CONTRACT LAW] Backend %s não tem api_contract.md — frontend pode inventar rotas",
                                        _other_id[:8],
                                    )

                                if _loaded_contracts:
                                    # Destacar o api_contract.md se presente
                                    has_contract_md = any("api_contract.md" in c for c in _loaded_contracts)
                                    if has_contract_md:
                                        _ctx_lines.append(
                                            f"\n#### ⚡ CONTRATO OFICIAL DA API — Projeto **{_other_title}**\n"
                                            "**CONTRACT LAW:** Este é o documento de verdade. "
                                            "TODA chamada de API neste projeto frontend DEVE usar EXCLUSIVAMENTE "
                                            "os endpoints, campos e tipos documentados abaixo. "
                                            "Rota não listada aqui = não existe = NEEDS_INFO, nunca inventar:"
                                        )
                                    else:
                                        _ctx_lines.append(
                                            f"\n#### Artefatos de contrato do projeto **{_other_title}**\n"
                                            "Use os arquivos abaixo para garantir que endpoints, schemas, "
                                            "autenticação, porta e formatos de resposta estão exatamente corretos:"
                                        )
                                    _ctx_lines.extend(_loaded_contracts)
                                    _ctx_lines.append(
                                        "\n> **CONTRACT LAW:** Nunca inventar URL, campo, tipo ou shape que não esteja "
                                        "documentado acima. Se um endpoint não constar aqui → NEEDS_INFO. "
                                        "A rota existe no contrato ou não existe no sistema."
                                    )

                        _ctx_lines.append(
                            "\nUse este contexto para garantir consistência de contratos, "
                            "schemas, autenticação e nomenclatura entre os projetos relacionados."
                        )
                        pipeline_ctx.linked_projects_context = "\n".join(_ctx_lines)
                        logger.info("[Pipeline] Contexto de %d projeto(s) linkado(s) carregado.", len(_links_data))

                # ── Predecessores (project_triggers) ──────────────────────────────────
                # Carregar contratos dos projetos que são pré-requisito deste via trigger.
                # Eles já estão completed/accepted (o /run só passou porque passaram na validação).
                # Isso garante que CTO/Engineer/Dev conhecem os schemas e contratos herdados.
                _triggers_data, _trig_status = _api_get(f"/api/projects/{project_id}/triggers/predecessors")
                if not (_triggers_data and isinstance(_triggers_data, list)):
                    # Fallback: buscar direto na tabela via API de projeto (links approach)
                    _triggers_data = []

                if _triggers_data:
                    _files_root = _files_root if '_files_root' in dir() else os.environ.get("PROJECT_FILES_ROOT", "/project-files").rstrip("/")
                    _pred_lines = ["\n## Projetos predecessores (dependências concluídas)\n",
                                   "Estes projetos já foram completados e são pré-requisitos deste. "
                                   "USE seus contratos para derivar schemas, endpoints, autenticação e portas.\n"]
                    _pred_chars = 0
                    _MAX_PRED_CHARS = 60_000  # predecessores podem ser vários — limite generoso
                    for _pred in _triggers_data[:10]:
                        _pred_id    = _pred.get("id", "")
                        _pred_title = _pred.get("title", "")
                        _pred_status = _pred.get("status", "")
                        if not _pred_id:
                            continue
                        _pred_lines.append(f"\n### Predecessor: **{_pred_title}** (status: {_pred_status})\n")
                        _pred_root = Path(_files_root) / _pred_id
                        # Para predecessores carregamos mais artefatos: charter, api_contract, schemas
                        _pred_candidates = [
                            _pred_root / "project" / "api_contract.md",
                            _pred_root / "project" / "curl_examples.sh",
                            _pred_root / "docs" / "cto_artifact_0.md",   # charter real gerado pelo CTO
                            _pred_root / "docs" / "cto_charter.md",       # path alternativo
                            _pred_root / "docs" / "cto" / "PROJECT_CHARTER.md",  # path formal
                            _pred_root / "docs" / "devops" / "RUNBOOK.md",
                            _pred_root / "project" / "api_contract.md",
                        ]
                        for _pcpath in _pred_candidates:
                            if _pred_chars >= _MAX_PRED_CHARS:
                                break
                            try:
                                _pcontent = _pcpath.read_text(encoding="utf-8", errors="replace")
                                _avail = _MAX_PRED_CHARS - _pred_chars
                                if len(_pcontent) > _avail:
                                    _pcontent = _pcontent[:_avail] + "\n... [truncado por limite de contexto]"
                                _rel = str(_pcpath.relative_to(_pred_root))
                                _pred_lines.append(f"\n#### `{_rel}` (de: {_pred_title})\n\n```\n{_pcontent}\n```\n")
                                _pred_chars += len(_pcontent)
                                logger.info("[PredCtx] Carregado %s de predecessor %s (%d chars)", _rel, _pred_id[:8], len(_pcontent))
                            except (FileNotFoundError, OSError):
                                pass

                    if _pred_chars > 0:
                        _pred_lines.append(
                            "\n> **REGRA DE PRODUTO:** Os contratos acima são a fonte de verdade. "
                            "Se este projeto é backend, derive schemas e auth do DB predecessor. "
                            "Se este projeto é frontend/manager, derive endpoints de TODOS os backends predecessores. "
                            "Nunca inventar porta, rota, campo ou tipo que não esteja documentado acima."
                        )
                        _existing = pipeline_ctx.linked_projects_context or ""
                        pipeline_ctx.linked_projects_context = _existing + "\n" + "\n".join(_pred_lines)
                        logger.info("[Pipeline] Contexto de %d predecessor(es) carregado (%d chars).", len(_triggers_data), _pred_chars)

            except Exception as _e:
                logger.debug("[Pipeline] Não foi possível carregar project_type/links: %s", _e)

    # ── FT-10: Modo EVOLUTION — carrega apps/ do projeto pai como existing_artifacts ───────
    # Se o projeto foi criado via POST /evolve, extra contém evolution:true.
    # O runner injeta: (1) codebase do pai como contexto, (2) evolution_request no spec_content.
    _is_evolution = False
    _evolution_request = ""
    _evolution_work_mode = "copy"
    _parent_project_id_evo: str | None = None
    if project_id:
        try:
            _evo_proj_data, _ = _api_get(f"/api/projects/{project_id}")
            _extra = (_evo_proj_data or {}).get("extra") or {}
            if isinstance(_extra, str):
                import json as _json
                try: _extra = _json.loads(_extra)
                except Exception: _extra = {}
            if _extra.get("evolution") is True:
                _is_evolution = True
                _evolution_request   = _extra.get("evolution_request", "")
                _evolution_work_mode = _extra.get("evolution_work_mode", "copy")
                _parent_project_id_evo = _extra.get("evolution_parent_id")
                logger.info("[FT-10] Modo EVOLUTION detectado — request=%s work_mode=%s parent=%s",
                            _evolution_request[:80], _evolution_work_mode,
                            (_parent_project_id_evo or "")[:8])
        except Exception as _evo_e:
            logger.debug("[FT-10] Falha ao detectar modo evolution: %s", _evo_e)

    if _is_evolution and _parent_project_id_evo and pipeline_ctx:
        # Carregar apps/ do projeto pai como existing_artifacts no contexto
        _files_root_evo = os.environ.get("PROJECT_FILES_ROOT", "/project-files").rstrip("/")
        _parent_apps_dir = Path(_files_root_evo) / _parent_project_id_evo / "apps"

        # Determinar product_id do pai para path novo
        try:
            _par_data, _ = _api_get(f"/api/projects/{_parent_project_id_evo}")
            _par_prod = (_par_data or {}).get("productId")
            if _par_prod:
                _parent_apps_dir = Path(_files_root_evo) / _par_prod / _parent_project_id_evo / "apps"
        except Exception:
            pass

        _evo_artifacts: list[dict] = []
        try:
            _MAX_EVO_CHARS = 80_000
            _evo_chars = 0
            # Coletar todos os arquivos de código do pai (excluindo node_modules/.next/dist)
            _skip_dirs = {"node_modules", ".next", "dist", ".git", "__pycache__", ".venv", "venv"}
            for _ap in sorted(_parent_apps_dir.rglob("*")):
                if _evo_chars >= _MAX_EVO_CHARS:
                    break
                if not _ap.is_file():
                    continue
                if any(s in _ap.parts for s in _skip_dirs):
                    continue
                _ext = _ap.suffix.lower()
                if _ext not in {".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".md", ".toml", ".yaml", ".yml", ".env.example", ".sh", ".sql"}:
                    continue
                try:
                    _content = _ap.read_text(encoding="utf-8", errors="replace")
                    _avail = _MAX_EVO_CHARS - _evo_chars
                    if len(_content) > _avail:
                        _content = _content[:_avail] + "\n...[truncado]"
                    _rel_path = str(_ap.relative_to(_parent_apps_dir.parent))
                    _evo_artifacts.append({"path": _rel_path, "content": _content, "format": _ext.lstrip(".")})
                    _evo_chars += len(_content)
                except OSError:
                    pass
            logger.info("[FT-10] %d artefatos do projeto pai carregados (%d chars)", len(_evo_artifacts), _evo_chars)
        except Exception as _ea:
            logger.warning("[FT-10] Falha ao carregar apps/ do pai: %s", _ea)

        # Enriquecer pipeline_ctx com o contexto de evolução
        _evo_ctx = (
            f"\n## CONTEXTO DE EVOLUÇÃO — projeto pai: {_parent_project_id_evo[:8]}\n"
            f"Este projeto É UMA EVOLUÇÃO. O codebase existente está em existing_artifacts.\n"
            f"PEDIDO DE EVOLUÇÃO: {_evolution_request}\n\n"
            f"### REGRAS ABSOLUTAS DE EVOLUÇÃO\n"
            f"1. NUNCA remova recurso existente a menos que a instrução seja EXPLICITAMENTE 'remover X'\n"
            f"2. Adicione SOMENTE o que o pedido pede — nada além\n"
            f"3. Edite arquivos existentes com patch cirúrgico — não reescreva do zero\n"
            f"4. Prefixos de tasks: TSK-EVO- (distingue das tasks originais)\n"
            f"5. O charter deve ter seção '## Delta' listando o que ADICIONA, MANTÉM e REMOVE\n"
            f"6. complexity_hint reflete apenas o delta — não o projeto inteiro\n"
        )
        _existing_linked = pipeline_ctx.linked_projects_context or ""
        pipeline_ctx.linked_projects_context = _existing_linked + _evo_ctx

        # Armazenar artefatos no pipeline_ctx para uso pelos agentes
        if not hasattr(pipeline_ctx, "evolution_artifacts"):
            pipeline_ctx.evolution_artifacts = _evo_artifacts  # type: ignore[attr-defined]

        # Injetar work_mode no spec_content como instrução adicional
        if _evolution_work_mode == "branch":
            # Inicializar git no projeto filho se necessário
            _child_apps = Path(_files_root_evo) / project_id / "apps"
            if _child_apps.exists() and not (_child_apps / ".git").exists():
                try:
                    import subprocess as _sp
                    _sp.run(["git", "init"], cwd=str(_child_apps), check=True, capture_output=True)
                    _sp.run(["git", "checkout", "-b", "main"], cwd=str(_child_apps), capture_output=True)
                    _sp.run(["git", "checkout", "-b", "staging"], cwd=str(_child_apps), capture_output=True)
                    _sp.run(["git", "checkout", "-b", "dev"], cwd=str(_child_apps), capture_output=True)
                    _branch_name = f"evolution/v{(_evo_proj_data or {}).get('versionNumber', 2)}"
                    _sp.run(["git", "checkout", "-b", _branch_name], cwd=str(_child_apps), capture_output=True)
                    logger.info("[FT-10] Git inicializado com branches main/staging/dev/%s em %s",
                                _branch_name, _child_apps)
                except Exception as _ge:
                    logger.warning("[FT-10] Falha ao inicializar git: %s", _ge)

    # Persistir spec em project_id/docs quando PROJECT_FILES_ROOT estiver definido
    if project_id and storage and storage.is_enabled():
        storage.write_spec_doc(project_id, spec_content, spec_ref.replace("/", "_").replace(".", "_")[:80])

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    _pipeline_started_at = now_iso

    # Pipeline Run Log — registrar início da execução
    _run_log = None
    try:
        from orchestrator.pipeline_run_log import PipelineRunLog
        if project_id:
            _run_log = PipelineRunLog(project_id)
            _run_log.start_run(request_id, trigger="api")
    except Exception as _rle:
        logger.debug("[RunLog] Não foi possível inicializar run log (não crítico): %s", _rle)

    _patch_project({"started_at": now_iso, "status": "running"})
    _post_step(
        "Pipeline iniciado. A especificação do produto foi recebida e será analisada pelos agentes.",
        request_id,
    )

    # ── GAP-T1: Pré-classificador trivial — detecta na spec bruta ANTES do CTO ──────────────
    # Sinais inequívocos de trivial: HTML puro, CSS puro, arquivo único, sem backend, sem JS.
    # Se detectado E checkpoint não está avançado (step < 1), vai direto ao Dev.
    # Idempotente: se checkpoint step>=1, o pré-classificador é ignorado (já passou desta fase).
    _pre_trivial_detected = False
    if (not pipeline_ctx or pipeline_ctx.current_step < 1) and spec_content:
        _spec_lower = spec_content.lower()
        _trivial_signals = [
            "html" in _spec_lower and "css" in _spec_lower,
            any(s in _spec_lower for s in ("arquivo único", "single file", "sem javascript", "without javascript", "sem js", "no js", "no javascript")),
            any(s in _spec_lower for s in ("sem backend", "no backend", "without backend", "sem servidor", "no server")),
            any(s in _spec_lower for s in ("html puro", "pure html", "html+css", "html + css", "html/css")),
            any(s in _spec_lower for s in ("sem framework", "no framework", "without framework", "vanilla")),
        ]
        _positive_signals = sum(1 for s in _trivial_signals if s)
        # Remover seções de negação antes de checar complexidade.
        # Estratégia robusta: remover a seção "Não implementar" inteira + linhas de negação.
        import re as _re
        # 1. Remover seção "Não implementar / Do not implement" até o próximo heading
        _spec_no_section = _re.sub(
            r'#+\s*(não implementar|do not implement|not implement)[^\n]*\n(.*?)(?=\n#+|\Z)',
            '', _spec_lower, flags=_re.IGNORECASE | _re.DOTALL
        )
        # 2. Remover linhas que contenham palavras de negação explícita
        _negation_line_pattern = _re.compile(
            r'.*\b(sem |no |without |não |nunca |never )\b.*', _re.IGNORECASE
        )
        _spec_lines_cleaned = [
            line for line in _spec_no_section.splitlines()
            if not _negation_line_pattern.match(line.strip())
        ]
        _spec_without_negations = " ".join(_spec_lines_cleaned)
        # GAP-NEW-2: remover linhas de metadados/hospedagem/restrições antes de checar complexidade.
        # Ex.: "Hospedagem: GitHub Pages, Netlify, S3" ou "Stack: HTML5, CSS3" contêm palavras
        # como "api" (netlify api), "docker" (contexto de infra), "typescript" (menção de stack)
        # mas NÃO indicam complexidade real do produto.
        _meta_line_pattern = _re.compile(
            r'.*\b(hospedagem|hosting|deploy|cdn|netlify|github pages|s3|cloudflare|'
            r'restrições|restrictions|metadados|metadata|stack:|versão:|version:|'
            r'static|estático|estática)\b.*',
            _re.IGNORECASE
        )
        _spec_for_complexity = " ".join(
            line for line in _spec_without_negations.splitlines()
            if not _meta_line_pattern.match(line.strip())
        )
        # Sinais de complexidade real: frameworks, backend, banco, auth — fora de contexto de negação/infra
        _complexity_signals = any(s in _spec_for_complexity for s in (
            "backend", "database", "banco de dados", "autenticação", "authentication",
            "react", "next.js", "vue", "angular", "svelte",
            "graphql", "typescript", "node.js", "python", "django", "fastapi", "flask",
            "docker compose", "kubernetes", "microserviço",
        )) if _positive_signals >= 2 else False
        # "api" e "rest" e "docker" sozinhos não bastam — podem estar em contexto de hospedagem/CDN
        # Só contam como sinal de complexidade se combinados com framework/backend explícito
        if _positive_signals >= 2 and not _complexity_signals:
            _pre_trivial_detected = True
            logger.info("[GAP-T1] Pré-classificador: spec indica trivial (%d sinais). Bypass CTO+Engineer+PM.", _positive_signals)
            _post_step(
                "Spec identificada como trivial pelo pré-classificador. "
                "Passando diretamente ao Dev sem CTO spec review, Engineer ou PM.",
                request_id,
            )
            _patch_project({"complexity_hint": "trivial"})
            # GAP-U4: para trivial pré-detectado, spec_understood é a spec bruta (sem processar pelo CTO)
            # Avançar checkpoint direto para step=2 para evitar regredir em restart
            if pipeline_ctx:
                pipeline_ctx.set_product_spec(spec_content)
                pipeline_ctx.current_step = 2
                pipeline_ctx.save_checkpoint(STATE_DIR)
    # ──────────────────────────────────────────────────────────────────────────────────────────

    cto_spec_response = {}
    cto_response = None
    engineer_response = None
    charter_artifacts = []
    backlog_artifacts = []
    charter_path = STATE_DIR / "PROJECT_CHARTER.md"
    try:
        # ── V2: CTO spec review (LEI 11: pular se current_step >= 1 OU trivial pré-detectado) ──
        if not _pre_trivial_detected and (not pipeline_ctx or pipeline_ctx.current_step < 1):
            _post_step(
                "O CTO está analisando a especificação recebida (conversão para .md e entendimento do projeto).",
                request_id,
            )
            _post_agent_working("cto", "O CTO está revisando e convertendo a spec para o modelo aceitável.", request_id)
            logger.info("[Pipeline] Chamando CTO para revisão da spec (com template)...")
            cto_spec_response = call_cto(
                spec_ref, request_id, engineer_proposal="",
                spec_content=spec_content, spec_template=spec_template_content,
                pipeline_ctx=pipeline_ctx,
            )
            _audit_log("cto", request_id, cto_spec_response)
            spec_understood = _content_for_doc(cto_spec_response) or cto_spec_response.get("summary", "") or spec_content
            for art in cto_spec_response.get("artifacts", []):
                if isinstance(art, dict) and art.get("content"):
                    spec_understood = art.get("content", "").strip() or spec_understood
                    break
            if project_id and storage and storage.is_enabled():
                storage.write_doc(project_id, "cto", "spec_review", spec_understood, title="Spec revisada pelo CTO")
                try:
                    storage.write_doc_by_path(
                        project_id, "cto", "cto/cto_spec_response.json",
                        json.dumps(cto_spec_response, ensure_ascii=False, indent=2),
                        title="CTO spec response (IA)",
                    )
                except Exception as _e:
                    logger.warning("[Pipeline] Falha ao gravar CTO spec response JSON: %s", _e)
            if pipeline_ctx:
                pipeline_ctx.set_product_spec(spec_understood)
                pipeline_ctx.current_step = 1
                pipeline_ctx.save_checkpoint(STATE_DIR)
            _post_step("O CTO concluiu a revisão da spec. Iniciando alinhamento com o Engineer.", request_id)

        # ── V2: Loop CTO ↔ Engineer (LEI 11: pular se current_step >= 2) ───────────────────
        # GAP-T1 + GAP-U4: trivial pré-detectado pula Engineer completamente — sem docs
        max_cto_engineer_rounds = int(os.environ.get("MAX_CTO_ENGINEER_ROUNDS", "3"))
        engineer_summary = engineer_summary or ""
        cto_response = None
        charter_summary = charter_summary or ""

        if not _pre_trivial_detected and (not pipeline_ctx or pipeline_ctx.current_step < 2):
            for round_num in range(1, max_cto_engineer_rounds + 1):
                _post_step(
                    f"Rodada {round_num}/{max_cto_engineer_rounds}: CTO envia spec ao Engineer para proposta técnica (squads e skills).",
                    request_id,
                )
                _post_agent_working("engineer", "O Engineer está gerando a proposta técnica (squads e dependências).", request_id)
                logger.info("[Pipeline] Chamando agente Engineer (rodada %s)...", round_num)
                engineer_response = call_engineer(
                    spec_ref, spec_understood, request_id,
                    cto_questionamentos=None if round_num == 1 else (cto_response.get("summary", "") if cto_response else None),
                    pipeline_ctx=pipeline_ctx,
                )
                _audit_log("engineer", request_id, engineer_response)
                engineer_summary = engineer_response.get("summary", "")
                engineer_status = engineer_response.get("status", "?")
                # GAP-ENG1: ler artefatos do Engineer do disco — mesmo padrão do QA.
                # O summary é 1 linha; o conteúdo real (10-18KB por artefato) fica em docs/engineer/*.md.
                # O CTO precisa do conteúdo completo para aprovar sem REVISION em loop.
                if project_id:
                    try:
                        _eng_docs_dir = Path(os.environ.get("PROJECT_FILES_ROOT", "/project-files")) / project_id / "docs"
                        _eng_parts = []
                        for _ef in sorted(_eng_docs_dir.rglob("engineer_*.md")):
                            if _ef.is_file() and _ef.stat().st_size > 500:
                                _ec = _ef.read_text(encoding="utf-8", errors="replace")
                                # remover cabeçalho "Created by: engineer"
                                _ec = _ec.replace("<!-- Created by: engineer -->\n\n", "").strip()
                                _eng_parts.append(f"### {_ef.name}\n{_ec}")
                        if _eng_parts:
                            _disk_content = "\n\n".join(_eng_parts)[:15000]
                            if len(_disk_content) > len(engineer_summary):
                                engineer_summary = _disk_content
                                logger.info("[GAP-ENG1] engineer_summary enriquecido do disco: %d chars (%d artefatos)",
                                            len(engineer_summary), len(_eng_parts))
                    except Exception as _enge:
                        logger.debug("[GAP-ENG1] Falha ao ler artefatos do Engineer do disco: %s", _enge)
                logger.info("[Pipeline] Engineer respondeu (status: %s, summary_len: %d)", engineer_status, len(engineer_summary))
                _post_dialogue("cto", "engineer", "cto.engineer.request", _get_summary_human("cto.engineer.request", "cto", "engineer", spec_ref[:500]), request_id)
                _post_dialogue("engineer", "cto", "engineer.cto.response", _get_summary_human("engineer.cto.response", "engineer", "cto", engineer_summary[:500]), request_id)
                if pipeline_ctx:
                    pipeline_ctx.set_engineer_proposal(engineer_summary)
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "engineer", "proposal", _content_for_doc(engineer_response), title="Engineer technical proposal")
                    for i, art in enumerate(engineer_response.get("artifacts", [])):
                        if isinstance(art, dict) and art.get("content"):
                            name = (Path(art.get("path", "")).stem if art.get("path") else f"artifact_{i}").replace(".", "_") or f"artifact_{i}"
                            storage.write_doc(project_id, "engineer", name, art.get("content", ""), title=art.get("purpose", name))

                _post_step("O CTO está validando a proposta e elaborando o Charter (ou preparando questionamentos).", request_id)
                _post_agent_working("cto", "O CTO está elaborando o Charter do projeto.", request_id)
                logger.info("[Pipeline] Chamando agente CTO (charter/validação)...")
                cto_response = call_cto(
                    spec_ref, request_id, engineer_proposal=engineer_summary, spec_content=spec_understood,
                    pipeline_ctx=pipeline_ctx,
                )
                _audit_log("cto", request_id, cto_response)
                if project_id and storage and storage.is_enabled():
                    try:
                        storage.write_doc_by_path(
                            project_id, "cto", f"cto/cto_charter_response_round{round_num}.json",
                            json.dumps(cto_response, ensure_ascii=False, indent=2),
                            title="CTO charter response (IA)",
                        )
                    except Exception as _e:
                        logger.warning("[Pipeline] Falha ao gravar CTO charter response JSON: %s", _e)
                charter_summary = cto_response.get("summary", "")
                charter_artifacts = cto_response.get("artifacts", [])
                cto_status = cto_response.get("status", "?")
                logger.info("[Pipeline] CTO respondeu (status: %s)", cto_status)
                if cto_status and str(cto_status).upper() == "OK":
                    _post_step("O CTO aprovou a proposta e finalizou o Charter. Seguindo para o PM.", request_id)
                    break
                if round_num == max_cto_engineer_rounds:
                    _post_step("Máximo de rodadas CTO↔Engineer atingido. Usando última versão do Charter.", request_id)
                    break
                _post_step("O CTO enviou questionamentos ao Engineer. Nova rodada.", request_id)

            charter_path = STATE_DIR / "PROJECT_CHARTER.md"
            charter_content = f"# Project Charter (gerado pelo CTO)\n\n{_content_for_doc(cto_response) or charter_summary}\n"
            if project_id and storage and storage.is_enabled():
                p = storage.write_doc(project_id, "cto", "charter", _content_for_doc(cto_response), title="Project Charter")
                if p:
                    charter_path = p
                for i, art in enumerate(charter_artifacts):
                    if isinstance(art, dict) and art.get("content"):
                        storage.write_doc(
                            project_id, "cto", f"artifact_{i}", art.get("content", ""),
                            title=art.get("purpose", f"Artifact {i}"),
                        )
            if charter_summary:
                ensure_state_dir()
                charter_path.write_text(charter_content, encoding="utf-8")
                logger.info("[Pipeline] Charter persistido: %s", charter_path)
            if pipeline_ctx:
                pipeline_ctx.set_charter(charter_summary)
                emitted = _emit_connect_contracts("charter", pipeline_ctx, project_id, storage, request_id)
                if emitted:
                    _post_step(
                        "Artefatos iniciais do Connect emitidos após o Charter: SystemPassport e OwnershipManifest.",
                        request_id,
                    )
                pipeline_ctx.current_step = 2
                pipeline_ctx.save_checkpoint(STATE_DIR)

        cto_status = cto_response.get("status", "?") if cto_response else "?"
        engineer_status = engineer_response.get("status", "?") if engineer_response else "?"

        # ── G1/G2: Validação de complexity_hint — BLOCKER antes do PM ──────────────────────────
        # GAP-T1: se trivial pré-detectado, complexity_hint já está definido — pular BLOCKER
        # Idempotente: se step>=3 o charter já foi validado em run anterior; não bloquear.
        if _pre_trivial_detected:
            _complexity_hint_for_patch = "trivial"
        else:
            _complexity_hint_for_patch = _hint_from_response(cto_response, charter_summary)
        if not _complexity_hint_for_patch and (not pipeline_ctx or pipeline_ctx.current_step < 3):
            _hint_retry_rounds = int(os.environ.get("MAX_HINT_RETRY_ROUNDS", "2"))
            for _hint_round in range(1, _hint_retry_rounds + 1):
                _post_step(
                    f"Charter sem complexity_hint (BLOCKER). Solicitando revisão ao CTO "
                    f"(tentativa {_hint_round}/{_hint_retry_rounds}).",
                    request_id,
                )
                logger.warning(
                    "[Pipeline] complexity_hint ausente no charter. Solicitando revisão ao CTO (round %d/%d).",
                    _hint_round, _hint_retry_rounds,
                )
                _cto_hint_response = call_cto(
                    spec_ref, request_id,
                    engineer_proposal=engineer_summary,
                    spec_content=spec_understood,
                    force_mode="charter_and_proposal",
                    pipeline_ctx=pipeline_ctx,
                    extra_instruction=(
                        "ATENÇÃO: o charter anterior não contém o campo obrigatório `complexity_hint`. "
                        "Reescreva o PROJECT_CHARTER.md incluindo a seção:\n\n"
                        "## Complexity Hint\n\n"
                        "**complexity_hint:** trivial | low | medium | high\n"
                        "**routes_estimated:** N\n"
                        "**reasoning:** <1 linha>\n\n"
                        "Sem esse campo o PM não consegue decidir FAST-TRACK vs FULL "
                        "e gera backlogs superdimensionados."
                    ),
                )
                _audit_log("cto", request_id, _cto_hint_response)
                _new_hint = _hint_from_response(_cto_hint_response)
                if _new_hint:
                    charter_summary = _cto_hint_response.get("summary", "") or charter_summary
                    charter_artifacts = _cto_hint_response.get("artifacts", []) or charter_artifacts
                    _complexity_hint_for_patch = _new_hint
                    # P8: atualizar pipeline_ctx com o charter revisado para checkpoint consistente
                    if pipeline_ctx:
                        pipeline_ctx.set_charter(charter_summary)
                        pipeline_ctx.save_checkpoint(STATE_DIR)
                    logger.info("[Pipeline] complexity_hint obtido na revisão: %s", _new_hint)
                    _post_step(
                        f"CTO incluiu complexity_hint: {_new_hint}. Prosseguindo para o PM.",
                        request_id,
                    )
                    break
                if _hint_round == _hint_retry_rounds:
                    _post_error(
                        "Charter sem complexity_hint após todas as tentativas de revisão. "
                        "Pipeline interrompido — verifique o SYSTEM_PROMPT do CTO.",
                        request_id, None,
                    )
                    _patch_project({"status": "failed"})
                    return

        if _complexity_hint_for_patch:
            _patch_project({"complexity_hint": _complexity_hint_for_patch})
        # ─────────────────────────────────────────────────────────────────────────────────────

        emit_event("project.created", {"spec_ref": spec_ref, "constraints": {}, "engineer_summary": engineer_summary[:300]}, request_id)
        _post_dialogue(
            "cto", "pm", "project.created",
            _get_summary_human("project.created", "cto", "pm", charter_summary[:300]),
            request_id,
        )

        # ── Passo 3: PM + loop CTO↔PM (LEI 11: pular se current_step >= 3) ──
        pm_response = None
        pm_status = "?"
        # Default: se step>=3 (checkpoint restaurado), usar current_module do contexto
        pm_module = (pipeline_ctx.current_module if pipeline_ctx else None) or "backend"

        # ── Trivial fast-path: complexidade trivial → bypass Engineer+PM, 1 task direto ──
        # GAP-T1: _pre_trivial_detected bypassa também sem charter_summary
        _complexity_hint_val = _extract_complexity_hint(charter_summary) or ("trivial" if _pre_trivial_detected else "")
        if _complexity_hint_val == "trivial" and (not pipeline_ctx or pipeline_ctx.current_step < 3):
            _post_step(
                "Complexidade trivial detectada. Bypass do PM: 1 task gerada diretamente pelo CTO → Dev (sem backlog, sem rodadas).",
                request_id,
            )
            pm_module = infer_pm_module_from_engineer_proposal(engineer_summary, spec_content=spec_content)
            _owner_role = {"web": "DEV_WEB", "mobile": "DEV_MOBILE"}.get(pm_module, "DEV_BACKEND")
            _trivial_task = {
                "task_id":   "TSK-TRIVIAL-001",   # snake_case — padrão esperado pela API
                "taskId":    "TSK-TRIVIAL-001",   # camelCase — fallback para compatibilidade
                "module":    pm_module,
                "owner_role": _owner_role,
                "ownerRole":  _owner_role,
                "status":    "ASSIGNED",
                "requirements": (charter_summary or spec_content)[:800],
                "depends_on_files": [],
                "target_route": "/",
            }
            backlog_summary = f"[TRIVIAL] 1 task — {(charter_summary or spec_content)[:300]}"
            backlog_artifacts = []
            pm_status = "OK"
            if project_id and storage and storage.is_enabled():
                _trivial_backlog_content = (
                    f"# Backlog — Trivial\n\n"
                    f"**Modo:** TRIVIAL (complexity_hint=trivial, 1 task)\n\n"
                    f"## TSK-TRIVIAL-001\n\n"
                    f"**Título:** Implementação direta (trivial)\n\n"
                    f"**Requisitos:**\n\n{(charter_summary or spec_content)[:800]}\n\n"
                    f"**depends_on_files:** []\n\n"
                    f"**target_route:** /\n"
                )
                storage.write_doc(project_id, "pm", "backlog", _trivial_backlog_content, title="Backlog Trivial")
            if pipeline_ctx:
                pipeline_ctx.set_backlog(backlog_summary)
                if hasattr(pipeline_ctx, "current_module"):
                    pipeline_ctx.current_module = pm_module
                pipeline_ctx.current_step = 3
                pipeline_ctx.save_checkpoint(STATE_DIR)
            # Seed a task trivial diretamente, sem _seed_tasks (que lê BACKLOG.md do disco)
            if project_id and _api_available():
                _trivial_seed_path = f"/api/projects/{project_id}/tasks"
                _trivial_seed_body = {"tasks": [_trivial_task]}
                _trivial_data, _trivial_status = _api_post(_trivial_seed_path, _trivial_seed_body)
                if 200 <= _trivial_status < 300:
                    logger.info("[Trivial] Task TSK-TRIVIAL-001 criada via API.")
                else:
                    logger.warning("[Trivial] Falha ao criar task via API (status %s); continuando.", _trivial_status)
                _run_monitor_loop(project_id, spec_ref, charter_summary, backlog_summary, request_id, pipeline_ctx=pipeline_ctx, run_log=_run_log)
                if _run_log:
                    try:
                        _proj_status = _get_project_status(project_id) or "stopped"
                        _reason = "accepted" if _proj_status == "accepted" else ("sigterm" if _shutdown_requested else "stopped")
                        _run_log.stop_run(reason=_reason)
                    except Exception:
                        pass
            persist_state(
                spec_ref=spec_ref,
                charter={"summary": charter_summary, "artifacts": charter_artifacts},
                backlog={"summary": backlog_summary, "artifacts": backlog_artifacts},
                events=["project.created", "task.assigned", "task.completed", "qa.review"],
            )
            return

        if not pipeline_ctx or pipeline_ctx.current_step < 3:
            max_cto_pm_rounds = int(os.environ.get("MAX_CTO_PM_ROUNDS", "3"))
            cto_pm_questionamentos = None
            for pm_round in range(1, max_cto_pm_rounds + 1):
                _post_step(
                    f"O PM está gerando o backlog do módulo (rodada {pm_round}/{max_cto_pm_rounds}).",
                    request_id,
                )
                _post_agent_working("pm", "O PM está gerando o backlog (tarefas e critérios de aceitação).", request_id)
                pm_module = infer_pm_module_from_engineer_proposal(engineer_summary, spec_content=spec_content)
                logger.info("[Pipeline] Chamando agente PM (módulo %s inferido da proposta do Engineer, rodada %s)...", pm_module, pm_round)
                pm_response = call_pm(
                    spec_ref, charter_summary, request_id,
                    module=pm_module, engineer_proposal=engineer_summary,
                    cto_questionamentos=cto_pm_questionamentos,
                    pipeline_ctx=pipeline_ctx,
                )
                _audit_log("pm", request_id, pm_response)
                backlog_summary = pm_response.get("summary", "")
                backlog_artifacts = pm_response.get("artifacts", [])
                pm_status = pm_response.get("status", "?")
                logger.info("[Pipeline] PM respondeu (status: %s)", pm_status)
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "pm", "backlog", _content_for_doc(pm_response), title="Backlog")
                    for i, art in enumerate(backlog_artifacts):
                        if not isinstance(art, dict) or not art.get("content"):
                            continue
                        path_val = (art.get("path") or "").strip()
                        content = art.get("content", "")
                        title = art.get("purpose", f"Artifact {i}")
                        if path_val.startswith("docs/"):
                            try:
                                storage.write_doc_by_path(project_id, "pm", path_val[5:].lstrip("/"), content, title=title)
                            except Exception as _e:
                                logger.warning("[Pipeline] write_doc_by_path PM falhou, fallback: %s", _e)
                                storage.write_doc(project_id, "pm", f"artifact_{i}", content, title=title)
                        else:
                            storage.write_doc(project_id, "pm", f"artifact_{i}", content, title=title)
                _post_step("O CTO está validando o backlog do PM.", request_id)
                _post_agent_working("cto", "O CTO está validando o backlog.", request_id)
                cto_backlog_response = call_cto(
                    spec_ref, request_id,
                    backlog_summary=backlog_summary,
                    validate_backlog_only=True,
                    pipeline_ctx=pipeline_ctx,
                )
                cto_backlog_ok = (str(cto_backlog_response.get("status", "")).upper() == "OK")
                # GAP-P1/Q1: validar LEI 8 antes de aprovar o backlog — se PM gerou tasks com
                # mais de 3 arquivos estimados, forçar nova rodada com instrução explícita.
                if cto_backlog_ok and backlog_summary:
                    try:
                        from orchestrator.pipeline_context import validate_backlog_tasks_max_files
                        _lei8_tasks = _get_tasks(project_id) if project_id else []
                        _lei8_issues = validate_backlog_tasks_max_files(_lei8_tasks) if _lei8_tasks else []
                        if not _lei8_issues:
                            # Também verificar no texto do backlog via heurística de arquivos estimados
                            import re as _re
                            _estimated = _re.findall(r"estimated_files[^\d]*(\d+)", backlog_summary, _re.IGNORECASE)
                            _lei8_issues = [f"task com {n} arquivos estimados" for n in _estimated if int(n) > 3]
                        if _lei8_issues and pm_round < max_cto_pm_rounds:
                            _post_step(
                                f"LEI 8 violada: {len(_lei8_issues)} task(s) com mais de 3 arquivos. "
                                f"PM deve decompor antes de avançar (rodada {pm_round}/{max_cto_pm_rounds}).",
                                request_id,
                            )
                            logger.warning("[GAP-P1] LEI 8: %s — devolvendo ao PM.", _lei8_issues[:3])
                            cto_backlog_ok = False
                            cto_pm_questionamentos = (
                                "BLOCKER LEI 8: as seguintes tasks têm mais de 3 arquivos estimados: "
                                + str(_lei8_issues[:5])
                                + ". Decompor cada uma em sub-tasks de no máximo 3 arquivos antes de entregar o backlog."
                            )
                            continue
                    except Exception as _lei8_e:
                        logger.debug("[GAP-P1] LEI 8 check falhou (não crítico): %s", _lei8_e)
                if cto_backlog_ok:
                    _post_step("O CTO aprovou o backlog. Acionando a squad.", request_id)
                    break
                if pm_round == max_cto_pm_rounds:
                    _has_pm_artifacts = any(
                        (a.get("path") or "").strip().startswith("docs/pm/")
                        for a in (backlog_artifacts or []) if isinstance(a, dict)
                    )
                    if _has_pm_artifacts:
                        _post_step("Máximo de rodadas CTO↔PM atingido. Usando último backlog.", request_id)
                    else:
                        _post_step("Máximo de rodadas CTO↔PM atingido. PM não entregou artefatos formais (docs/pm/); usando resumo disponível.", request_id)
                    break
                cto_pm_questionamentos = cto_backlog_response.get("summary", "") or _content_for_doc(cto_backlog_response)
                _post_step("O CTO enviou ajustes ao PM. Nova rodada.", request_id)

            if pipeline_ctx:
                pipeline_ctx.set_backlog(backlog_summary)
                emitted = _emit_connect_contracts("backlog", pipeline_ctx, project_id, storage, request_id)
                if emitted:
                    _post_step(
                        "ServiceManifest(s) do Connect emitidos após a aprovação do backlog.",
                        request_id,
                    )
                pipeline_ctx.current_step = 3
                pipeline_ctx.save_checkpoint(STATE_DIR)
        _post_step(
            f"O PM concluiu a geração do backlog. O módulo está planejado com tarefas e prioridades. Status: {pm_status}.",
            request_id,
        )
        emit_event("module.planned", {"spec_ref": spec_ref, "backlog_summary": backlog_summary[:200]}, request_id)
        _post_dialogue(
            "pm", "cto", "module.planned",
            _get_summary_human("module.planned", "pm", "cto", backlog_summary[:200]),
            request_id,
        )

        # ── Fase 2: Monitor Loop (quando API e PROJECT_ID definidos) ───
        if project_id and _api_available():
            _post_step(
                "Squad criada. Iniciando Monitor Loop: Dev/QA/DevOps serão acionados até você aceitar o projeto ou parar.",
                request_id,
            )
            seed_ok = _seed_tasks(project_id, pm_module=pm_module)
            if not seed_ok:
                # Verificar se as tasks foram criadas mesmo com erro (upsert parcial)
                # Isso acontece quando ON CONFLICT DO UPDATE falha em alguma task mas outras são inseridas.
                _existing_tasks = _get_tasks(project_id)
                if _existing_tasks:
                    logger.warning("[Monitor Loop] _seed_tasks retornou False mas %d tasks já existem — continuando.", len(_existing_tasks))
                    seed_ok = True
                else:
                    _post_error("Falha ao criar tarefas iniciais na API.", request_id, None)
                    _patch_project({"status": "failed"})
            if seed_ok:
                # GAP-NEW-3: PM rodou completo mas complexity_hint=trivial → PM gerou N tasks
                # quando deveria ter gerado 1. Consolidar em 1 task única antes do Monitor Loop
                # para evitar 7 tasks para uma landing page estática.
                _hint_after_pm = _extract_complexity_hint(charter_summary) or ("trivial" if _pre_trivial_detected else "")
                if _hint_after_pm == "trivial" and project_id and _api_available():
                    _all_pm_tasks = _get_tasks(project_id)
                    _active_pm_tasks = [t for t in _all_pm_tasks if t.get("status") not in ("DONE", "QA_PASS", "CANCELLED")]
                    if len(_active_pm_tasks) > 3:
                        logger.info(
                            "[GAP-NEW-3] complexity_hint=trivial mas PM gerou %d tasks. Consolidando em 1 task.",
                            len(_active_pm_tasks),
                        )
                        _post_step(
                            f"Complexidade trivial com {len(_active_pm_tasks)} tasks do PM — consolidando em 1 task para evitar overhead desnecessário.",
                            request_id,
                        )
                        # Cancelar todas as tasks do PM
                        for _t in _active_pm_tasks:
                            _tid = _t.get("taskId") or _t.get("task_id")
                            if _tid:
                                _update_task(project_id, _tid, status="CANCELLED")
                        # Criar 1 task consolidada com todos os requisitos do backlog
                        _owner_role = {"web": "DEV_WEB", "mobile": "DEV_MOBILE"}.get(pm_module, "DEV_BACKEND")
                        _consolidated_reqs = "\n".join(
                            f"- {t.get('requirements') or t.get('title') or t.get('taskId','?')}"
                            for t in _active_pm_tasks
                        )
                        _consolidated_task = {
                            "task_id":   "TSK-TRIVIAL-001",
                            "taskId":    "TSK-TRIVIAL-001",
                            "module":    pm_module,
                            "owner_role": _owner_role,
                            "ownerRole":  _owner_role,
                            "status":    "ASSIGNED",
                            "requirements": f"[TRIVIAL CONSOLIDADO — {len(_active_pm_tasks)} tasks unificadas]\n\n{charter_summary[:600]}\n\nTasks originais:\n{_consolidated_reqs[:600]}",
                            "depends_on_files": [],
                            "target_route": "/",
                        }
                        _api_post(f"/api/projects/{project_id}/tasks", {"tasks": [_consolidated_task]})
                        backlog_summary = f"[TRIVIAL CONSOLIDADO] 1 task — {len(_active_pm_tasks)} tasks do PM unificadas. {charter_summary[:300]}"
                _run_monitor_loop(project_id, spec_ref, charter_summary, backlog_summary, request_id, pipeline_ctx=pipeline_ctx, run_log=_run_log)
                # Após o Monitor Loop, marcar projeto como completed se todas as tasks estiverem DONE.
                # Sem isso o portal fica mostrando status=running mesmo com tudo concluído.
                if project_id:
                    try:
                        _post_loop_tasks = _get_tasks(project_id)
                        _terminal_set = {"DONE", "QA_PASS", "CANCELLED", "BLOCKED"}
                        _all_terminal = bool(_post_loop_tasks) and all(t.get("status") in _terminal_set for t in _post_loop_tasks)
                        _current_proj_status = _get_project_status(project_id)
                        if _all_terminal and _current_proj_status not in ("accepted", "completed", "stopped", "failed"):
                            _completed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
                            _patch_project({"status": "completed", "completed_at": _completed_at, "finished_at": _completed_at})
                            logger.info("[Pipeline] Projeto marcado como completed (todas tasks terminais).")
                    except Exception as _pls_e:
                        logger.warning("[Pipeline] Falha ao marcar projeto completed pós-loop: %s", _pls_e)
                # Pipeline Run Log — fechar run após Monitor Loop (stopped/accepted/sigterm)
                if _run_log:
                    try:
                        _proj_status = _get_project_status(project_id) or "stopped"
                        _reason = "accepted" if _proj_status == "accepted" else ("completed" if _proj_status == "completed" else ("sigterm" if _shutdown_requested else "stopped"))
                        _run_log.stop_run(reason=_reason)
                    except Exception:
                        pass
            persist_state(
                spec_ref=spec_ref,
                charter={"summary": charter_summary, "artifacts": charter_artifacts},
                backlog={"summary": backlog_summary, "artifacts": backlog_artifacts},
                events=["cto.engineer.request", "engineer.cto.response", "project.created", "module.planned", "task.assigned", "task.completed", "qa.review", "monitor.health", "devops.deploy"],
            )
            _post_step("Monitor Loop encerrado. Aceite o projeto no portal ou revise o status.", request_id)
            out = {
                "request_id": request_id,
                "spec_ref": spec_ref,
                "engineer_status": engineer_status,
                "cto_status": cto_status,
                "pm_status": pm_status,
                "charter_path": str(charter_path),
                "state_path": str(STATE_DIR / (os.environ.get("PROJECT_ID") or "default") / "current_project.json"),
                "monitor_loop": True,
            }
            if project_id and storage and storage.is_enabled():
                out["project_docs_root"] = str(storage.get_docs_dir(project_id))
                out["project_artifacts_root"] = str(storage.get_project_dir(project_id))
            print(json.dumps(out, indent=2))
            return 0

        # ── Passo 4: Dev (fluxo sequencial quando sem API/PROJECT_ID) ──
        run_full_stack = os.environ.get("PIPELINE_FULL_STACK", "true").strip().lower() in ("1", "true", "yes")
        dev_status = pm_status
        qa_status = "-"
        monitor_status = "-"
        devops_status = "-"
        dev_summary = ""
        qa_summary = ""
        monitor_summary = ""
        devops_summary = ""

        if run_full_stack:
            dev_artifacts: list = []
            dev_code_refs: list = []
            _post_step(
                "O Dev está recebendo o backlog e o charter para gerar a implementação e evidências.",
                request_id,
            )
            _post_agent_working("dev", "O Dev está gerando a implementação e evidências.", request_id)
            logger.info("[Pipeline] Chamando agente Dev...")
            try:
                dev_response = call_dev(spec_ref, charter_summary, backlog_summary, request_id)
                dev_summary = dev_response.get("summary", "")
                dev_status = dev_response.get("status", "?")
                dev_artifacts = dev_response.get("artifacts", [])
                dev_code_refs = [a.get("path") for a in dev_artifacts if isinstance(a, dict) and a.get("path")]
                logger.info("[Pipeline] Dev respondeu (status: %s)", dev_status)
                _post_step(
                    f"O Dev concluiu. Status: {dev_status}. Resumo: {dev_summary[:150]}...",
                    request_id,
                )
                _post_dialogue(
                    "pm", "dev", "task.assigned",
                    _get_summary_human("task.assigned", "pm", "dev", backlog_summary[:200]),
                    request_id,
                )
                _post_dialogue(
                    "dev", "qa", "task.completed",
                    _get_summary_human("task.completed", "dev", "qa", dev_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "dev", "implementation", _content_for_doc(dev_response), title="Dev implementation")
                    for i, art in enumerate(dev_artifacts):
                        if isinstance(art, dict) and art.get("content"):
                            content = art.get("content", "")
                            path_key = art.get("path") or f"artifact_{i}"
                            if path_key.startswith("apps/"):
                                storage.write_apps_artifact(project_id, path_key[5:].lstrip("/"), content if isinstance(content, str) else str(content))
                                if pipeline_ctx:
                                    pipeline_ctx.register_artifact(path_key, content if isinstance(content, str) else str(content))
                            elif path_key.startswith("docs/"):
                                storage.write_doc_by_path(project_id, "dev", path_key[5:].lstrip("/"), content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                                if pipeline_ctx:
                                    pipeline_ctx.register_artifact(path_key, content if isinstance(content, str) else str(content))
                            elif art.get("path"):
                                storage.write_doc(project_id, "dev", f"artifact_{i}", content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                                if pipeline_ctx:
                                    pipeline_ctx.register_artifact(f"docs/dev/artifact_{i}.md", content if isinstance(content, str) else str(content))
                            else:
                                storage.write_doc(project_id, "dev", f"artifact_{i}", content, title=art.get("purpose", f"Artifact {i}"))
                                if pipeline_ctx:
                                    pipeline_ctx.register_artifact(f"docs/dev/artifact_{i}.md", content if isinstance(content, str) else str(content))
            except Exception as e:
                logger.exception("[Pipeline] Dev falhou")
                dev_status = "FAIL"
                _post_error(str(e), request_id, e)

            # ── Passo 5: QA ──────────────────────────────────────────────
            _post_step(
                "O QA está validando o trabalho do Dev e gerando relatório de qualidade.",
                request_id,
            )
            _post_agent_working("qa", "O QA está validando artefatos e gerando relatório de qualidade.", request_id)
            logger.info("[Pipeline] Chamando agente QA...")
            try:
                qa_response = call_qa(
                    spec_ref, charter_summary, backlog_summary, dev_summary, request_id,
                    task_id=None, task="", code_refs=dev_code_refs, existing_artifacts=dev_artifacts,
                )
                qa_summary = qa_response.get("summary", "")
                qa_status = qa_response.get("status", "?")
                qa_artifacts = qa_response.get("artifacts", [])
                logger.info("[Pipeline] QA respondeu (status: %s)", qa_status)
                _post_step(
                    f"O QA concluiu. Status: {qa_status}. Resumo: {qa_summary[:150]}...",
                    request_id,
                )
                _post_dialogue(
                    "dev", "qa", "qa.review",
                    _get_summary_human("qa.review", "qa", "monitor", qa_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "qa", "report", _content_for_doc(qa_response), title="QA report")
                    for i, art in enumerate(qa_artifacts):
                        if isinstance(art, dict) and art.get("content"):
                            storage.write_doc(project_id, "qa", f"artifact_{i}", art.get("content", ""), title=art.get("purpose", f"Artifact {i}"))
            except Exception as e:
                logger.exception("[Pipeline] QA falhou")
                qa_status = "FAIL"
                _post_error(str(e), request_id, e)

            # ── Passo 6: Monitor ──────────────────────────────────────────
            _post_step(
                "O Monitor está consolidando o status e gerando o health do projeto.",
                request_id,
            )
            _post_agent_working("monitor", "O Monitor está consolidando o status e o health do projeto.", request_id)
            logger.info("[Pipeline] Chamando agente Monitor...")
            try:
                monitor_response = call_monitor(spec_ref, charter_summary, backlog_summary, dev_summary, qa_summary, request_id)
                monitor_summary = monitor_response.get("summary", "")
                monitor_status = monitor_response.get("status", "?")
                logger.info("[Pipeline] Monitor respondeu (status: %s)", monitor_status)
                _post_step(
                    f"O Monitor concluiu. Status: {monitor_status}.",
                    request_id,
                )
                _post_dialogue(
                    "monitor", "pm", "monitor.health",
                    _get_summary_human("monitor.health", "monitor", "pm", monitor_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "monitor", "health", _content_for_doc(monitor_response), title="Monitor health")
            except Exception as e:
                logger.exception("[Pipeline] Monitor falhou")
                monitor_status = "FAIL"
                _post_error(str(e), request_id, e)

            # ── Passo 7: DevOps ───────────────────────────────────────────
            # GAP-P5: seed TSK-DEVOPS-001 no portal antes de chamar o DevOps (fluxo Passo 7)
            if project_id and _api_available():
                try:
                    _d7_seed_path = f"/api/projects/{project_id}/tasks"
                    _d7_task = [{
                        "task_id":   "TSK-DEVOPS-001",
                        "taskId":    "TSK-DEVOPS-001",
                        "module":    "infra",
                        "requirements": "Provisionar artefatos de infraestrutura: Dockerfile, docker-compose.yml, start.sh, RUNBOOK.md",
                        "status":    "IN_PROGRESS",
                        "ownerRole": "DEVOPS_DOCKER",
                        "depends_on_files": [],
                        "target_route": "infra",
                    }]
                    _d7, _d7s = _api_post(_d7_seed_path, {"tasks": _d7_task})
                    if 200 <= _d7s < 300:
                        logger.info("[GAP-P5/Passo7] TSK-DEVOPS-001 criada no portal.")
                except Exception as _d7e:
                    logger.debug("[GAP-P5/Passo7] Seed TSK-DEVOPS-001 falhou (não crítico): %s", _d7e)
            _post_step(
                "O DevOps está gerando Dockerfile, docker-compose e artefatos de infraestrutura.",
                request_id,
            )
            _post_agent_working("devops", "O DevOps está gerando artefatos de infraestrutura.", request_id)
            logger.info("[Pipeline] Chamando agente DevOps...")
            try:
                devops_response = call_devops(spec_ref, charter_summary, backlog_summary, request_id)
                devops_summary = devops_response.get("summary", "")
                devops_status = devops_response.get("status", "?")
                devops_artifacts = devops_response.get("artifacts", [])
                logger.info("[Pipeline] DevOps respondeu (status: %s)", devops_status)
                _post_step(
                    f"O DevOps concluiu. Status: {devops_status}.",
                    request_id,
                )
                _post_dialogue(
                    "monitor", "devops", "devops.deploy",
                    _get_summary_human("devops.deploy", "devops", "cto", devops_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "devops", "summary", _content_for_doc(devops_response), title="DevOps summary")
                    for i, art in enumerate(devops_artifacts):
                        if isinstance(art, dict):
                            content = art.get("content")
                            path_key = art.get("path") or f"artifact_{i}"
                            if content and path_key.startswith("project/"):
                                storage.write_project_artifact(project_id, path_key[8:].lstrip("/"), content if isinstance(content, str) else str(content))
                                if pipeline_ctx:
                                    pipeline_ctx.register_artifact(path_key, content if isinstance(content, str) else str(content))
                            elif content and path_key.startswith("docs/"):
                                storage.write_doc_by_path(project_id, "devops", path_key[5:].lstrip("/"), content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                                if pipeline_ctx:
                                    pipeline_ctx.register_artifact(path_key, content if isinstance(content, str) else str(content))
                            elif content and path_key:
                                storage.write_project_artifact(project_id, path_key, content if isinstance(content, str) else str(content))
                                if pipeline_ctx:
                                    pipeline_ctx.register_artifact(f"project/{path_key.lstrip('/')}", content if isinstance(content, str) else str(content))
                            elif content:
                                storage.write_doc(project_id, "devops", f"artifact_{i}", content, title=art.get("purpose", f"Artifact {i}"))
                                if pipeline_ctx:
                                    pipeline_ctx.register_artifact(f"docs/devops/artifact_{i}.md", content if isinstance(content, str) else str(content))
                    if pipeline_ctx:
                        emitted = _emit_connect_contracts("devops", pipeline_ctx, project_id, storage, request_id)
                        if emitted:
                            _post_step(
                                "Artefatos operacionais do Connect emitidos após o DevOps: ObservabilityBaselineManifest, RuntimePassport e KnownSafeActionsPack.",
                                request_id,
                            )
                # GAP-P5/Passo7: atualizar TSK-DEVOPS-001 para DONE
                if project_id and _api_available():
                    try:
                        _update_task(project_id, "TSK-DEVOPS-001", status="DONE")
                    except Exception:
                        pass
            except Exception as e:
                logger.exception("[Pipeline] DevOps falhou")
                devops_status = "FAIL"
                _post_error(str(e), request_id, e)

        # ── Persistir estado ──────────────────────────────────────────
        events_list = ["cto.engineer.request", "engineer.cto.response", "project.created", "module.planned"]
        if run_full_stack:
            events_list.extend(["task.assigned", "task.completed", "qa.review", "monitor.health", "devops.deploy"])
        persist_state(
            spec_ref=spec_ref,
            charter={"summary": charter_summary, "artifacts": charter_artifacts},
            backlog={"summary": backlog_summary, "artifacts": backlog_artifacts},
            events=events_list,
        )
        logger.info("[Pipeline] Estado persistido em orchestrator/state/current_project.json")

        completed_at_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

        # G46: Self-learning — extrair padrões de QA_FAIL dos reports deste projeto
        try:
            from orchestrator.knowledge_extractor import extract_knowledge
            _api_url = os.environ.get("API_BASE_URL", "")
            _api_tok  = os.environ.get("GENESIS_API_TOKEN", "")
            _kresult  = extract_knowledge(project_id or "default", _api_url, _api_tok)
            if _kresult.get("extracted", 0) > 0:
                logger.info(
                    "[G46] Knowledge extraído: %d padrão(ões), %d QA_FAILs, stack=%s",
                    _kresult["extracted"], _kresult.get("qa_fails", 0), _kresult.get("stack", "?"),
                )
                _post_dialogue(
                    "genesis", "human", "knowledge.extracted",
                    f"[Aprendizado automático] {_kresult['extracted']} padrão(ões) identificado(s) nos QA reports. "
                    f"Aguardando revisão humana antes de propor mudanças nos SYSTEM_PROMPTs.",
                    request_id,
                )
        except Exception as _ke:
            logger.warning("[G46] Extração de knowledge falhou (não crítico): %s", _ke)

        # Generate quality report before marking completed
        try:
            _tasks_done = len(pipeline_ctx.completed_tasks) if pipeline_ctx else 0
            _tasks_total = len(pipeline_ctx.all_tasks) if (pipeline_ctx and hasattr(pipeline_ctx, "all_tasks")) else _tasks_done
            _generate_quality_report(
                project_id=project_id,
                spec_ref=spec_ref,
                pipeline_ctx=pipeline_ctx,
                started_at=_pipeline_started_at,
                completed_at=completed_at_iso,
                tasks_done=_tasks_done,
                tasks_total=_tasks_total,
            )
        except Exception as _qr_err:
            logger.warning("[Quality Report] Erro ao gerar relatório: %s", _qr_err)

        _patch_project({
            "status": "completed",
            "completed_at": completed_at_iso,
            "finished_at": completed_at_iso,
            "charter_summary": charter_summary,
            "backlog_summary": backlog_summary[:2000] if backlog_summary else None,
        })

        # Pipeline Run Log — registrar fim bem-sucedido
        if _run_log:
            try:
                _tasks_done_log = len(pipeline_ctx.completed_tasks) if pipeline_ctx else 0
                _tasks_total_log = len(pipeline_ctx.all_tasks) if (pipeline_ctx and hasattr(pipeline_ctx, "all_tasks")) else _tasks_done_log
                _run_log.stop_run(
                    reason="completed",
                    metrics={"tasks_done": _tasks_done_log, "tasks_total": _tasks_total_log},
                )
            except Exception as _rle:
                logger.debug("[RunLog] stop_run falhou (não crítico): %s", _rle)

        pipeline_desc = "Engineer → CTO → PM"
        if run_full_stack:
            pipeline_desc += " → Dev → QA → Monitor → DevOps"
        _post_step(
            f"Pipeline concluído com sucesso! A especificação passou por {pipeline_desc}. "
            "Os documentos foram gerados e, quando configurado, salvos em PROJECT_FILES_ROOT.",
            request_id,
        )

        out = {
            "request_id": request_id,
            "spec_ref": spec_ref,
            "engineer_status": engineer_status,
            "cto_status": cto_status,
            "pm_status": pm_status,
            "charter_path": str(charter_path),
            "state_path": str(STATE_DIR / (os.environ.get("PROJECT_ID") or "default") / "current_project.json"),
        }
        if run_full_stack:
            out["dev_status"] = dev_status
            out["qa_status"] = qa_status
            out["monitor_status"] = monitor_status
            out["devops_status"] = devops_status
        if project_id and storage and storage.is_enabled():
            out["project_docs_root"] = str(storage.get_docs_dir(project_id))
            out["project_artifacts_root"] = str(storage.get_project_dir(project_id))
        print(json.dumps(out, indent=2))
        return 0

    except Exception as e:
        logger.exception("[Pipeline] Falha no pipeline")
        error_info = _extract_error_info(e)
        human_msg = error_info.get("human_message", f"Erro no pipeline: {e}")
        _post_error(human_msg, request_id, e)
        completed_at_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        _patch_project({"status": "failed", "completed_at": completed_at_iso})
        # Pipeline Run Log — registrar falha
        if _run_log:
            try:
                _run_log.stop_run(reason="error", metrics={"error": str(e)[:500]})
            except Exception:
                pass
        raise


if __name__ == "__main__":
    sys.exit(main())
