# Geração de Imagens com IA

## 0. Metadados
- **Produto:** ArtGen — geração e edição de imagens a partir de prompts com controle de créditos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que usuários criem imagens a partir de descrições textuais, explorem variações, editem por máscara e gerenciem créditos de uso.

## 2. Personas
- Designer — gera imagens para projetos, explora variações e exporta resultados.
- Usuário casual — cria imagens por hobby, testa prompts e compartilha na galeria.
- Administrador — gerencia planos de créditos e monitora uso.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e créditos iniciais
DADO um novo usuário cadastrado, QUANDO confirma e-mail e faz login, ENTÃO recebe 50 créditos gratuitos.

### FR-02 — Geração de imagem por prompt com parâmetros
DADO um usuário com créditos disponíveis, QUANDO envia prompt "gato astronauta" com estilo "realista" e resolução "1024x1024", ENTÃO a imagem é gerada em até 30 segundos e consome 10 créditos.

### FR-03 — Galeria de resultados por usuário
DADO um usuário autenticado, QUANDO acessa a galeria, ENTÃO vê todas as imagens geradas com data, prompt e opção de baixar ou excluir.

### FR-04 — Variações de imagem existente
DADO um usuário com uma imagem gerada, QUANDO solicita 4 variações, ENTÃO o sistema cria novas versões consumindo 2 créditos por variação.

### FR-05 — Edição por máscara (inpainting)
DADO um usuário com imagem gerada, QUANDO desenha máscara e envia novo prompt "adicionar óculos de sol", ENTÃO a área marcada é regenerada mantendo o restante.

### FR-06 — Compra de créditos
DADO um usuário sem créditos, QUANDO escolhe pacote de 500 créditos e confirma pagamento, ENTÃO o saldo é atualizado e ele recebe recibo por e-mail.

### FR-07 — Histórico de uso e saldo
DADO um usuário autenticado, QUANDO acessa "Meu saldo", ENTÃO vê créditos disponíveis e histórico de gerações com custo de cada uma.

## 4. Requisitos Não-Funcionais
- Geração em até 30 segundos para resolução padrão. API de inferência com fila para gerenciar picos. Disponibilidade 99%. Imagens armazenadas por 90 dias. PII (e-mail, pagamento) nunca em logs.

## 5. Regras de Negócio
- Créditos não expiram. Usuário sem créditos só pode visualizar galeria. Resolução maior consome mais créditos (512x512=5, 1024x1024=10, 2048x2048=20). Máximo 10 gerações simultâneas por usuário.

## 6. Modelo de Dados
- users(id, email, password_hash, credits_balance)
- generations(id, user_id, prompt, style, resolution, image_url, credits_used, created_at)
- credit_transactions(id, user_id, amount, type, description, created_at)
- payment_orders(id, user_id, credits_purchased, amount_paid, status, paid_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + Canvas API para máscara. Backend: Fastify + PostgreSQL + fila RabbitMQ para inferência. IA: Stable Diffusion via Replicate ou Amazon Bedrock. Storage: S3 para imagens.
