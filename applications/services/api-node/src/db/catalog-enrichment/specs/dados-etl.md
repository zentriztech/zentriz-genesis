# Pipeline de Dados ETL

## 0. Metadados
- **Produto:** DataFlow ETL — orquestrador de extração, transformação e carga de dados empresariais
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Conectar múltiplas fontes de dados (APIs, bancos, arquivos), aplicar transformações configuráveis, validar qualidade e carregar em data warehouse, com agendamento e reprocessamento sob demanda.

## 2. Personas
- Engenheiro de dados — configura conectores, transforma dados e monitora falhas.
- Analista de BI — consulta datasets carregados e aciona reprocessamento se detectar inconsistência.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de conectores de origem
DADO um engenheiro autenticado, QUANDO cadastra uma origem com tipo (postgres/api/s3), credenciais e query/path, ENTÃO o sistema valida conectividade e salva a configuração com status "ativo".

### FR-02 — Definição de transformações
DADO um engenheiro, QUANDO define uma transformação com expressão SQL ou Python, ENTÃO a transformação é salva e pode ser aplicada a qualquer dataset extraído.

### FR-03 — Agendamento de jobs
DADO um job configurado com origem, transformações e destino, QUANDO o engenheiro define um cron (ex: diário às 2h), ENTÃO o job é agendado e executa automaticamente, gerando uma run com status e logs.

### FR-04 — Validação de qualidade dos dados
DADO uma run em execução, QUANDO aplica regras de qualidade (ex: campo não-nulo, valor dentro de range), ENTÃO a run falha se a taxa de violação superar o limiar configurado e notifica o responsável.

### FR-05 — Reprocessamento de run falhada
DADO uma run com status "falha", QUANDO o engenheiro aciona reprocessamento, ENTÃO o job é re-executado a partir da etapa que falhou, mantendo histórico de tentativas.

### FR-06 — Monitoramento e alertas
DADO um job crítico, QUANDO uma run demora mais que o SLA configurado ou falha 3 vezes consecutivas, ENTÃO o sistema envia alerta via e-mail e Slack ao time de dados.

## 4. Requisitos Não-Funcionais
- Jobs processam até 10 milhões de linhas/hora. Disponibilidade 99,7%. Credenciais de origem cifradas em repouso (AES-256). Logs de dados sensíveis mascarados.

## 5. Regras de Negócio
- Job não inicia se há run ativa da mesma configuração. Reprocessamento só permitido em runs com status "falha" ou "parcial". Datasets carregados com timestamp de ingestão e hash de conteúdo para idempotência.

## 6. Modelo de Dados
- sources(id, tipo, config_json, credentials_encrypted, status)
- jobs(id, nome, source_id, transformations, destination_id, cron, sla_minutes)
- runs(id, job_id, started_at, finished_at, status, rows_processed, error_log)
- datasets(id, run_id, destination_table, row_count, hash, loaded_at)

## 7. Stack sugerida
- Backend: Python com FastAPI. Orquestrador: Celery + Redis. Data processing: Pandas ou PySpark. Database: PostgreSQL para metadados, S3 para staging. Monitoramento: Prometheus + Grafana.
