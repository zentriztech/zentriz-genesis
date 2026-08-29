# Chat em Tempo Real

## 0. Metadados
- **Produto:** LiveChat — troca de mensagens em tempo real com salas, presença e histórico persistente
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que usuários criem salas de chat, troquem mensagens instantâneas com indicador de digitação e presença online, e mantenham histórico persistente. Facilitar colaboração síncrona em equipes.

## 2. Personas
- Usuário — entra em salas, envia mensagens e acompanha presença de colegas.
- Administrador de sala — cria sala e gerencia membros.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de sala
DADO um usuário autenticado, QUANDO cria sala com nome único, ENTÃO a sala é persistida e o criador vira administrador.

### FR-02 — Ingresso em sala
DADO um usuário, QUANDO entra em sala pública ou recebe convite, ENTÃO vira membro e recebe histórico das últimas 100 mensagens.

### FR-03 — Envio de mensagem
DADO um membro conectado, QUANDO envia texto, ENTÃO a mensagem é persistida e transmitida em tempo real via WebSocket a todos os membros online.

### FR-04 — Indicador de digitação
DADO um membro digitando, QUANDO envia evento de digitação via WebSocket, ENTÃO outros membros visualizam indicador por 3 segundos.

### FR-05 — Presença online
DADO um membro conectado, QUANDO estabelece WebSocket, ENTÃO aparece como online para demais membros; ao desconectar, muda para offline.

### FR-06 — Histórico persistente
DADO um membro, QUANDO entra em sala, ENTÃO carrega mensagens anteriores paginadas com scroll infinito.

### FR-07 — Notificação push
DADO um membro offline, QUANDO recebe mensagem em sala que participa, ENTÃO recebe notificação push no dispositivo se registrado.

## 4. Requisitos Não-Funcionais
- Latência de mensagem <100ms p95; disponibilidade 99,5%. WebSocket com reconexão automática. PII (conteúdo de mensagens) nunca exposto em logs externos.

## 5. Regras de Negócio
- Sala pública visível a todos; sala privada exige convite.
- Mensagem persistida antes de broadcast via WebSocket — garante entrega mesmo se destinatário offline.
- Indicador de presença atualizado a cada 30s de heartbeat WebSocket.

## 6. Modelo de Dados
- rooms(id, name, is_public, created_by)
- memberships(room_id, user_id, joined_at, role)
- messages(id, room_id, user_id, text, created_at)
- presence(user_id, room_id, status, last_seen)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Socket.io client. Backend: Fastify + PostgreSQL + Socket.io (Node.js) para WebSocket. Redis para pub/sub entre instâncias do backend.
