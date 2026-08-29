# Gestão de Documentos (DMS)

## 0. Metadados
- **Produto:** DocVault — sistema de gestão documental com versionamento, busca full-text e controle de permissões
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de gestão de documentos empresariais que centraliza armazenamento, versiona alterações, indexa conteúdo para busca e controla acesso granular por pasta e documento. Substitui compartilhamentos de rede e elimina risco de perda de documentos críticos.

## 2. Personas
- Colaborador — faz upload de documentos, organiza em pastas, compartilha com equipe.
- Gestor de equipe — cria pastas departamentais, define permissões de leitura/escrita por usuário ou grupo.
- Auditor — consulta histórico de versões, identifica quem alterou documentos regulatórios.

## 3. Requisitos Funcionais (FR)

### FR-01 — Upload e organização em pastas
DADO um colaborador autenticado com permissão de escrita, QUANDO faz upload de arquivo para pasta e informa título e tags, ENTÃO o sistema armazena o documento, extrai metadados (tamanho, tipo MIME) e indexa conteúdo para busca.

### FR-02 — Versionamento automático de documento
DADO um documento já publicado, QUANDO um usuário com permissão faz upload de nova versão do mesmo arquivo, ENTÃO o sistema cria versão incremental (v2, v3...), preserva versões anteriores e marca a mais recente como ativa.

### FR-03 — Busca full-text por conteúdo e metadados
DADO um colaborador autenticado, QUANDO digita termo de busca, ENTÃO o sistema retorna documentos que contenham o termo no conteúdo (OCR para PDFs) ou metadados (título, tags, autor), respeitando permissões do usuário.

### FR-04 — Controle de permissões granular
DADO um gestor com permissão de administrador de pasta, QUANDO configura permissões de pasta ou documento individual, ENTÃO define por usuário ou grupo se pode visualizar, baixar, editar ou excluir, e as regras são aplicadas imediatamente.

### FR-05 — Histórico de versões e rollback
DADO um auditor visualizando documento, QUANDO acessa histórico de versões, ENTÃO visualiza lista de todas as versões com data, autor e tamanho, podendo baixar versão anterior ou promovê-la a versão ativa (rollback).

### FR-06 — Compartilhamento externo temporário
DADO um colaborador proprietário de documento, QUANDO gera link de compartilhamento externo informando prazo de validade, ENTÃO o sistema cria token de acesso público com expiração e permite download sem autenticação até a data limite.

## 4. Requisitos Não-Funcionais
- Busca full-text retorna resultados em menos de 1 segundo para índice de até 100.000 documentos.
- Disponibilidade de 99,8% para subsistema de upload e download.
- Documentos armazenados cifrados em repouso (AES-256) em storage S3 com versionamento nativo.
- PII em documentos (contratos, RH) nunca exposta em logs de auditoria, apenas hash do documento.
- Sistema suporta upload de arquivos até 100MB por documento.

## 5. Regras de Negócio
- Apenas proprietário ou administrador de pasta pode excluir documento (exclusão lógica, versões preservadas por 90 dias).
- Versões antigas ocupam storage mas não contam para limite de espaço do tenant (cobrado apenas versão ativa).
- Documento sem acesso por 2 anos é automaticamente arquivado (cold storage S3 Glacier).
- Busca só retorna documentos para os quais usuário tem ao menos permissão de leitura.

## 6. Modelo de Dados
- folders(id, parent_folder_id, name, owner_id, created_at)
- documents(id, folder_id, title, filename, storage_key, current_version, uploaded_by_id, tags)
- document_versions(id, document_id, version_number, storage_key, size_bytes, uploaded_by_id, uploaded_at)
- permissions(id, resource_type, resource_id, user_id, permission_type)
- external_shares(id, document_id, token, expires_at, created_by_id)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para interface de navegação e upload; drag-and-drop de pastas.
- Backend: Fastify + PostgreSQL para metadados; S3 para storage de documentos; Elasticsearch para busca full-text.
- Integração: Tika para extração de conteúdo de PDFs; Lambda para processamento assíncrono de OCR.
