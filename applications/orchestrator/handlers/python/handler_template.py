"""
Handler Template (Python)
- Recebe evento padronizado
- Decide ação
- Emite novo evento

Observação: adapte para AWS/Azure/GCP.
"""

from typing import Dict, Any

def handler(event: Dict[str, Any], context: Any = None) -> Dict[str, Any]:
    # Tradução: validação básica (guard rails)
    if not event.get("event_type") or not event.get("project_id") or not event.get("request_id"):
        raise ValueError("Evento inválido: campos obrigatórios ausentes")

    event_type = event["event_type"]

    # Tradução: roteamento por tipo de evento
    if event_type == "task.assigned":
        # Tradução: executar tarefa e emitir task.completed
        return {
            **event,
            "event_type": "task.completed",
            "payload": {
                "task_id": event.get("payload", {}).get("task_id"),
                "artifacts": []
            }
        }

    # Tradução: evento ignorado
    return {"ok": True, "ignored": True}
