"""
Persistência do log de diálogo no Genesis API (POST /api/projects/:id/dialogue).
Quando API_BASE_URL, PROJECT_ID e GENESIS_API_TOKEN estão definidos, o runner
registra cada interação entre agentes com um resumo em linguagem humana.

O resumo pode ser gerado por template (padrão) ou por um serviço LLM externo
(SUMMARY_LLM_URL) que recebe from_agent, to_agent, event_type e payload e retorna summary_human.
"""
import json
import logging
import os
import urllib.request

logger = logging.getLogger(__name__)

# Nomes amigáveis para geração de frases em português
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
}


def _label(agent_id: str) -> str:
    return AGENT_LABELS.get(agent_id, agent_id.replace("_", " ").title())


def build_summary_human(
    event_type: str,
    from_agent: str,
    to_agent: str,
    payload_snippet: str = "",
) -> str:
    """
    Gera um resumo em linguagem natural para o log de diálogo.
    Pode ser substituído por chamada a um serviço LLM (SUMMARY_LLM_URL).
    """
    from_l = _label(from_agent)
    to_l = _label(to_agent)

    templates = {
        "cto.engineer.request": f"O CTO enviou a especificação do projeto ao Engineer para definir as equipes e stacks técnicas necessárias.",
        "engineer.cto.response": f"O Engineer entregou a proposta técnica (stacks, equipes e dependências) ao CTO.",
        "project.created": "O CTO consolidou o Charter do projeto com base na proposta do Engineer.",
        "module.planned": "O PM Backend gerou o backlog do módulo com base no Charter.",
    }
    if event_type in templates:
        return templates[event_type]
    # Genérico
    if from_agent and to_agent:
        return f"{from_l} enviou informação para {to_l}."
    return f"Evento: {event_type}" if event_type else "Interação entre agentes."


def _call_summary_llm(from_agent: str, to_agent: str, event_type: str, payload_snippet: str) -> str | None:
    """Chama serviço LLM externo (SUMMARY_LLM_URL) para gerar summary_human. Retorna None em falha."""
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
    """Obtém resumo em linguagem humana: tenta LLM se configurado, senão usa template."""
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
                logger.info("Diálogo persistido: %s → %s", from_agent, to_agent)
                return True
    except Exception as e:
        logger.warning("Falha ao persistir diálogo na API: %s", e)
    return False
