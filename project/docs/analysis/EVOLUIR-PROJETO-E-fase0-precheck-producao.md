> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada — Fase 0', tarefa 0.4: pré-checagem de produção (somente leitura)

Data: 2026-11-04 · Fonte: produção (`ip-10-10-1-167`), transação `READ ONLY`, sem credenciais nem conteúdo; ids em hash. Autorizada pelo Jean (OK para a Fase 0').

| Item | Resultado (medido) | Consequência para o plano |
|---|---|---|
| `tickets` | **0 linhas** | Backfill de `card_state` trivial; nada a migrar; risco de migração baixíssimo |
| `ticket_attachments` | 0 linhas, 0 bytes | Sem anexos legados para sanear |
| `project_spec_files` | 138 arquivos em 62 projetos | Volume pequeno; backfill de `spec_origin` barato |
| Projetos de evolução (com pai) | **1** (versão 2, `archived`); 61 raízes (versão 1) | Pouquíssimo histórico de evolução em produção: o fluxo quase não foi usado |
| Duplicatas `(parent_project_id, version_number)` | **nenhuma** | O índice único parcial (tarefa 1.2) pode ser criado sem saneamento |
| Pais com mais de um filho vivo | **nenhum** | O índice "um filho materializado vivo por pai" é seguro |
| Filho `archived` guardando número de versão | 1 | Confirma a necessidade do índice **parcial** (`status NOT IN ('failed','archived')`) |

Limites: não conferi `failed` (nenhum filho `failed` existe); o fluxo de evolução tem uso real quase nulo, então os defeitos de corrida e de anexo não têm ocorrência histórica em produção e dependem da reprodução em teste (tarefa 0.3).
