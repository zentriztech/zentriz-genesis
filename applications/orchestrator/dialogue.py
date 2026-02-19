"""
Persistência do log de diálogo no Genesis API (POST /api/projects/:id/dialogue).
Quando API_BASE_URL, PROJECT_ID e GENESIS_API_TOKEN estão definidos, o runner
registra cada interação entre agentes com um resumo em linguagem humana.
"""
import json
import logging
import os
import urllib.request

logger = logging.getLogger(__name__)

AGENT_LABELS = {
    "cto": "CTO",
    "engineer": "Engineer",
    "pm_backend": "PM Backend",
    "pm_web": "PM Web",
    "pm_mobile": "PM Mobile",
    "dev_backend": "Dev Backend",
    "dev_backend_nodejs": "Dev Backend Node.js",
    "qa_backend": "QA Backend",
    "qa_backend_nodejs": "QA Backend Node.js",
    "devops_docker": "DevOps Docker",
    "monitor_backend": "Monitor Backend",
    "system": "Sistema",
    "error": "Erro",
}


def _label(agent_id: str) -> str:
    return AGENT_LABELS.get(agent_id, agent_id.replace("_", " ").title())


def build_summary_human(
    event_type: str,
    from_agent: str,
    to_agent: str,
    payload_snippet: str = "",
) -> str:
    """Gera um resumo em linguagem natural para o log de diálogo."""
    from_l = _label(from_agent)
    to_l = _label(to_agent)
    snippet_preview = payload_snippet[:150].strip()
    if snippet_preview and len(payload_snippet) > 150:
        snippet_preview += "..."

    templates = {
        "cto.engineer.request": (
            "O CTO enviou a especificação do projeto ao Engineer para que ele defina "
            "as equipes, squads técnicas e dependências necessárias para a implementação."
        ),
        "engineer.cto.response": (
            "O Engineer finalizou a análise técnica e entregou ao CTO a proposta com squads, "
            "equipes recomendadas e dependências do projeto."
            + (f" Resumo: {snippet_preview}" if snippet_preview else "")
        ),
        "project.created": (
            "O CTO consolidou o Charter do projeto com base na proposta do Engineer. "
            "O Charter define escopo, prioridades e estrutura organizacional."
            + (f" Resumo: {snippet_preview}" if snippet_preview else "")
        ),
        "module.planned": (
            "O PM Backend gerou o backlog completo do módulo com tarefas, prioridades "
            "e critérios de aceitação, pronto para os desenvolvedores."
            + (f" Resumo: {snippet_preview}" if snippet_preview else "")
        ),
        "task.assigned": f"{from_l} atribuiu uma tarefa ao {to_l}.",
        "task.completed": f"{from_l} concluiu a tarefa e reportou ao {to_l}.",
        "qa.review": (
            f"{from_l} realizou a revisão de qualidade dos artefatos."
            + (f" Resumo: {snippet_preview}" if snippet_preview else "")
        ),
        "devops.deploy": (
            f"{from_l} está preparando os artefatos de infraestrutura (Docker/k8s)."
            + (f" Resumo: {snippet_preview}" if snippet_preview else "")
        ),
        "monitor.health": (
            f"{from_l} consolidou o status e o health do projeto."
            + (f" Resumo: {snippet_preview}" if snippet_preview else "")
        ),
    }

    if event_type in templates:
        return templates[event_type]
    if from_agent and to_agent:
        return f"{from_l} enviou informações ao {to_l}."
    return f"Evento: {event_type}" if event_type else "Interação entre agentes."


def _call_summary_llm(from_agent: str, to_agent: str, event_type: str, payload_snippet: str) -> str | None:
    url = os.environ.get("SUMMARY_LLM_URL")
    if not url:
        return None
    try:
        body = json.dumps({
            "from_agent": from_agent,
            "to_agent": to_agent,
            "event_type": event_type,
            "payload_snippet": payload_snippet[:2000],
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            if 200 <= resp.status < 300:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("summary_human") or None
    except Exception as e:
        logger.warning("Falha ao chamar serviço de resumo LLM: %s", e)
    return None


def get_summary_human(
    event_type: str,
    from_agent: str,
    to_agent: str,
    payload_snippet: str = "",
) -> str:
    summary = _call_summary_llm(from_agent, to_agent, event_type, payload_snippet)
    if summary:
        return summary
    return build_summary_human(event_type, from_agent, to_agent, payload_snippet)


def post_dialogue(
    project_id: str,
    from_agent: str,
    to_agent: str,
    summary_human: str,
    event_type: str | None = None,
    request_id: str | None = None,
) -> bool:
    """
    Envia POST /api/projects/:id/dialogue quando API_BASE_URL, PROJECT_ID e GENESIS_API_TOKEN estão definidos.
    Retorna True se a requisição foi bem-sucedida.
    """
    base = os.environ.get("API_BASE_URL")
    token = os.environ.get("GENESIS_API_TOKEN")
    if not base or not project_id or not token:
        return False
    url = f"{base.rstrip('/')}/api/projects/{project_id}/dialogue"
    body = {
        "from_agent": from_agent,
        "to_agent": to_agent,
        "summary_human": summary_human,
        "event_type": event_type,
        "request_id": request_id,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if 200 <= resp.status < 300:
                logger.info("[Diálogo] %s → %s (%s): %s", from_agent, to_agent, event_type or "-", summary_human[:100])
                return True
    except Exception as e:
        logger.warning("[Diálogo] Falha ao persistir na API: %s", e)
    return False
