# Assinatura Eletrônica

## 0. Metadados
- **Produto:** SignFlow — plataforma de assinatura eletrônica de documentos com validade jurídica e trilha de auditoria
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
API e interface web para empresas enviarem documentos digitais para assinatura eletrônica por múltiplos signatários, com ordem de assinatura, lembretes automáticos, carimbo de tempo e trilha de auditoria imutável, substituindo papel e reconhecimento de firma.

## 2. Personas
- Sistema corporativo integrado — consome a API para enviar contratos, propostas e termos de aceite.
- Signatário — recebe link por e-mail, visualiza o documento, assina eletronicamente e recebe cópia assinada.
- Gestor de contratos — monitora status de documentos pendentes, envia lembretes e baixa trilha de auditoria para arquivamento.

## 3. Requisitos Funcionais (FR)
### FR-01 — Upload de documento e definição de signatários
DADO um usuário autenticado via API Key, QUANDO envia POST /documents com upload de PDF e lista de signatários (nome, e-mail, ordem), ENTÃO o sistema registra o documento, gera hash SHA-256 do arquivo original, envia e-mail com link único para cada signatário respeitando a ordem, e retorna o document_id.

### FR-02 — Ordem de assinatura e fila de espera
DADO signatários com ordem definida (1, 2, 3), QUANDO o signatário de ordem 1 acessa o link e assina, ENTÃO o sistema libera o link para o signatário de ordem 2 e envia e-mail de notificação; signatários de ordem posterior recebem status "aguardando assinatura anterior".

### FR-03 — Assinatura com carimbo de tempo confiável
DADO um signatário acessando o link válido, QUANDO visualiza o documento, marca a checkbox de aceite dos termos e clica em "Assinar", ENTÃO o sistema registra a assinatura com timestamp ICP-Brasil (carimbo de tempo RFC 3161), e-mail do signatário, IP de origem e user-agent, vincula ao documento e notifica o próximo signatário ou finaliza o processo.

### FR-04 — Lembretes automáticos para signatários pendentes
DADO um documento com signatários pendentes, QUANDO o sistema executa job diário de lembretes, ENTÃO identifica signatários que não assinaram há mais de 48 horas, envia e-mail de lembrete com link direto, e registra o evento na trilha de auditoria.

### FR-05 — Trilha de auditoria e documento final
DADO um documento com todas as assinaturas concluídas, QUANDO o gestor requisita GET /documents/:id/audit-trail, ENTÃO a API retorna JSON com eventos cronológicos (upload, envios, visualizações, assinaturas, lembretes) incluindo timestamps, IPs e hashes; a requisição GET /documents/:id/signed-pdf retorna o PDF original com página de assinaturas anexada e QR Code para verificação pública.

## 4. Requisitos Não-Funcionais
- Assinatura processada em < 2s; carimbo de tempo com latência < 5s para autoridade certificadora.
- Hash do documento verificável publicamente via GET /verify/:document_id sem autenticação.
- Disponibilidade 99,9%; armazenamento imutável de documentos originais e assinados por 10 anos (conformidade legal).
- Dados de signatários (e-mail, IP) protegidos por LGPD; acesso restrito ao criador do documento.

## 5. Regras de Negócio
- Um signatário só pode assinar uma vez; tentativa de re-assinatura é rejeitada.
- Link de assinatura expira em 30 dias; após expiração, criador pode reenviar gerando novo link e token.
- Documentos com ordem de assinatura não permitem salto de signatário; assinatura paralela (sem ordem) libera todos simultaneamente.
- Alteração no PDF após upload invalida o processo; hash do arquivo é verificado antes de cada assinatura.

## 6. Modelo de Dados
- documents(id, title, original_file_url, original_file_hash_sha256, status, created_by_user_id, created_at, completed_at)
- signers(id, document_id, name, email, signing_order, token, status, link_sent_at, signed_at, ip_address, user_agent)
- signatures(id, signer_id, timestamp_rfc3161, signature_hash, status)
- audit_trail(id, document_id, event_type, event_data_json, timestamp, ip_address)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL + Bull (jobs de lembrete). Carimbo de tempo: integração com autoridade certificadora ICP-Brasil (ex: Safeweb, Valid). Storage: S3 com versionamento e retenção. Auth via API Key.
