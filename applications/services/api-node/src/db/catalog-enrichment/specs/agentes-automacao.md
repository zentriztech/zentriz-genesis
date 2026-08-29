# Automação com Agentes de IA

## 0. Metadados
- **Produto:** AgentFlow — orquestrador de agentes autônomos com ferramentas, memória e aprovação humana
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Executar fluxos de trabalho autônomos onde agentes de IA realizam tarefas complexas com acesso a ferramentas (APIs, bancos, arquivos), registram rastros de execução e solicitam aprovação humana em passos sensíveis.

## 2. Personas
- Arquiteto de automação — define agentes, ferramentas e objetivos de fluxo.
- Operador — monitora execuções, aprova passos sensíveis e analisa custos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa painel de definição de agentes.

### FR-02 — Definição de agente com ferramentas
DADO um arquiteto autenticado, QUANDO cria agente com nome, objetivo e lista de ferramentas (ex.: http_request, sql_query), ENTÃO o sistema valida schema e registra agente como disponível.

### FR-03 — Execução de fluxo autônomo
DADO um agente configurado, QUANDO o usuário dispara execução com payload de entrada, ENTÃO o orquestrador inicia run e enfileira primeira tarefa.

### FR-04 — Chamada de ferramenta pelo agente
DADO um agente em execução, QUANDO o LLM decide invocar ferramenta com parâmetros, ENTÃO o sistema valida, executa e retorna resultado ao agente.

### FR-05 — Aprovação humana em passo sensível
DADO um agente que requer aprovação (ex.: delete, pagamento), QUANDO atinge passo marcado como sensível, ENTÃO pausa execução e notifica operador; prossegue somente após aprovação.

### FR-06 — Registro de rastros e custos
DADO uma execução finalizada, QUANDO o operador consulta histórico, ENTÃO vê lista de passos (timestamp, ferramenta, input/output, tokens, custo LLM).

### FR-07 — Gestão de memória entre runs
DADO um agente com memória habilitada, QUANDO inicia novo run do mesmo contexto, ENTÃO carrega histórico de interações anteriores para continuidade.

## 4. Requisitos Não-Funcionais
- API responde em < 500ms p95 (exceto execução LLM). Disponibilidade 99,5%. Logs auditáveis (quem aprovou, quando). PII nunca em logs. Rate limiting por tenant para evitar custo descontrolado.

## 5. Regras de Negócio
- Ferramenta só executável se agente tem permissão. Passo sem aprovação em 24h expira e falha run. Custo LLM contabilizado por tenant. Memória limitada a 100 interações por contexto.

## 6. Modelo de Dados
- agents(id, name, objective, tools, requires_approval, created_by)
- tools(id, name, schema, endpoint)
- runs(id, agent_id, status, started_at, finished_at, total_cost, created_by)
- steps(id, run_id, order, tool_name, input, output, tokens_in, tokens_out, cost, status, created_at)
- approvals(id, step_id, approved_by, approved_at, notes)
- memory(id, agent_id, context_id, interaction_history)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL + fila (BullMQ/Redis) para orquestração assíncrona. LLM: Anthropic Claude SDK com streaming. Ferramentas: HTTP client (axios), SQL connector (pg).
