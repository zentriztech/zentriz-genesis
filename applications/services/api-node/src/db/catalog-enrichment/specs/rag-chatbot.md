# Chatbot Corporativo com RAG

## 0. Metadados
- **Produto:** DocuBot — assistente inteligente com recuperação aumentada para base de conhecimento empresarial
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Responder perguntas de colaboradores sobre políticas, processos e documentação técnica usando busca semântica em base vetorial, com citação de fontes. Reduz carga de suporte e melhora acesso ao conhecimento organizacional.

## 2. Personas
- Administrador — faz upload de documentos, monitora qualidade das respostas e ajusta parâmetros.
- Colaborador — faz perguntas em linguagem natural e recebe respostas contextualizadas.
- Analista de qualidade — revisa respostas marcadas como insatisfatórias e enriquece a base.

## 3. Requisitos Funcionais (FR)

### FR-01 — Ingestão e processamento de documentos
DADO um administrador autenticado, QUANDO faz upload de PDF ou DOCX, ENTÃO o sistema extrai texto, divide em chunks de 512 tokens com overlap de 50 e armazena metadados.

### FR-02 — Geração e indexação de embeddings
DADO chunks processados, QUANDO o worker de indexação roda, ENTÃO gera embeddings vetoriais via modelo de embedding e persiste em banco vetorial com índice HNSW.

### FR-03 — Busca semântica e recuperação de contexto
DADO uma pergunta do colaborador, QUANDO o sistema processa a query, ENTÃO gera embedding da pergunta, busca top-5 chunks mais similares e monta contexto para o LLM.

### FR-04 — Geração de resposta com citação de fontes
DADO contexto recuperado, QUANDO o LLM gera resposta, ENTÃO a resposta inclui trechos relevantes e referências aos documentos originais com número da página.

### FR-05 — Histórico de conversas por usuário
DADO um colaborador autenticado, QUANDO acessa o histórico, ENTÃO visualiza suas últimas 50 conversas com timestamps e pode retomar qualquer uma delas.

### FR-06 — Feedback de qualidade e marcação de respostas
DADO uma resposta gerada, QUANDO o colaborador marca como inadequada, ENTÃO o sistema registra feedback e prioriza revisão pelo analista de qualidade.

### FR-07 — Dashboard de métricas de uso
DADO um administrador, QUANDO acessa o dashboard, ENTÃO visualiza total de perguntas, taxa de satisfação, documentos mais consultados e tempo médio de resposta.

## 4. Requisitos Não-Funcionais
- Busca semântica < 300ms p95, geração de resposta < 3s p95.
- Suporte a 100 usuários simultâneos.
- Base vetorial escalável até 100 mil chunks.
- Dados de conversas privados por usuário (sem acesso cruzado).

## 5. Regras de Negócio
- Chunks com menos de 50 tokens são descartados (ruído).
- Respostas nunca devem inventar informação fora do contexto recuperado.
- Documentos marcados como confidenciais só são indexados para grupos autorizados.
- Feedback negativo em 3 respostas do mesmo documento aciona revisão manual.

## 6. Modelo de Dados
- documents(id, filename, upload_date, status, metadata)
- chunks(id, document_id, text, page_number, token_count)
- embeddings(id, chunk_id, vector, indexed_at)
- conversations(id, user_id, created_at)
- messages(id, conversation_id, role, content, chunks_used, feedback)
- users(id, email, name, department)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + markdown rendering.
- Backend: FastAPI + PostgreSQL + pgvector.
- LLM: Claude 3.5 Sonnet via Bedrock.
- Embeddings: Cohere Embed v3 ou Voyage AI.
- Worker: Python com Celery para ingestão assíncrona.
