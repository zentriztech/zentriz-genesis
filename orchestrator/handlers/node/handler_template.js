/**
 * Handler Template (Node.js)
 * - Recebe evento padronizado
 * - Decide ação
 * - Emite novo evento
 *
 * Observação: adapte para AWS/Azure/GCP.
 */

export async function handler(event) {
  // Tradução: validação básica (guard rails)
  if (!event?.event_type || !event?.project_id || !event?.request_id) {
    throw new Error("Evento inválido: campos obrigatórios ausentes");
  }

  // Tradução: roteamento por tipo de evento
  switch (event.event_type) {
    case "task.assigned":
      // Tradução: executar tarefa e emitir task.completed
      return {
        ...event,
        event_type: "task.completed",
        payload: {
          task_id: event.payload?.task_id,
          artifacts: []
        }
      };

    default:
      // Tradução: evento ignorado
      return { ok: true, ignored: true };
  }
}
