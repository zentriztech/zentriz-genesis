# Transcrição e Resumo de Áudio

## 0. Metadados
- **Produto:** VoiceScribe — transcrição automática, diarização e extração de itens de ação de reuniões
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Receber uploads de áudio (reuniões, entrevistas), transcrever com diarização por locutor, gerar resumo executivo e extrair itens de ação com responsáveis. Reduzir tempo de documentação pós-reunião.

## 2. Personas
- Participante de reunião — envia áudio e recebe transcrição completa.
- Gestor — consulta resumo e itens de ação atribuídos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Upload e fila
DADO um usuário autenticado, QUANDO faz upload de arquivo de áudio até 2GB, ENTÃO o sistema cria registro em fila e inicia transcrição assíncrona.

### FR-02 — Transcrição com diarização
DADO um áudio em fila, QUANDO o worker processa, ENTÃO gera transcrição com timestamp e identificação de locutores distintos.

### FR-03 — Resumo executivo
DADO uma transcrição completa, QUANDO invoca LLM, ENTÃO gera resumo de 3 parágrafos com decisões principais.

### FR-04 — Extração de itens de ação
DADO uma transcrição, QUANDO processa com LLM, ENTÃO identifica tarefas com responsável e prazo mencionados.

### FR-05 — Busca no texto
DADO um usuário com transcrições, QUANDO pesquisa termo, ENTÃO retorna trechos de transcrições que contêm a palavra com contexto.

### FR-06 — Notificação de conclusão
DADO um áudio em processamento, QUANDO finaliza transcrição, ENTÃO envia e-mail ao usuário com link para visualização.

## 4. Requisitos Não-Funcionais
- Transcrição de áudio de 1h em até 5min; disponibilidade 99,5%. Áudio armazenado criptografado; transcrições de reuniões confidenciais com controle de acesso.

## 5. Regras de Negócio
- Áudio em formato não suportado gera erro antes de entrar em fila.
- Diarização limitada a 10 locutores distintos.
- Resumo e itens de ação só gerados após transcrição completa.

## 6. Modelo de Dados
- recordings(id, user_id, filename, duration_seconds, status, created_at)
- transcripts(id, recording_id, speaker_id, start_time, end_time, text)
- summaries(id, recording_id, summary_text)
- action_items(id, recording_id, task, assignee, due_date)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL + RabbitMQ. Worker Python com Whisper ou API de transcrição (AWS Transcribe, Google Speech-to-Text). LLM para resumo e extração (Claude via Bedrock).
