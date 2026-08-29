# CRM de Vendas

## 0. Metadados
- **Produto:** SalesHub — CRM para gestão de oportunidades e funil de vendas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar relacionamento com clientes potenciais e oportunidades de venda ao longo de um funil configurável. Centralizar contatos, atividades e histórico de negociações para aumentar taxa de conversão e produtividade do time comercial.

## 2. Personas
- Vendedor — registra contatos, qualifica leads e avança negociações pelo funil.
- Gestor comercial — configura etapas do funil, monitora pipeline e analisa conversão.
- Representante de suporte — consulta histórico de clientes para atendimento contextualizado.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado com perfil vendedor ou gestor, QUANDO informa credenciais válidas, ENTÃO recebe token JWT e acessa o dashboard com permissões do seu perfil.

### FR-02 — Cadastro de contas e contatos
DADO um vendedor autenticado, QUANDO cadastra uma conta empresa com CNPJ único e associa contatos com e-mail/telefone, ENTÃO a conta fica disponível para vinculação a oportunidades.

### FR-03 — Gestão de oportunidades no funil
DADO um vendedor com uma conta ativa, QUANDO cria uma oportunidade com valor estimado e a associa a um estágio do funil, ENTÃO a oportunidade aparece no quadro Kanban e pode ser arrastada entre estágios.

### FR-04 — Atividades e lembretes
DADO uma oportunidade aberta, QUANDO o vendedor registra uma atividade com tipo (ligação, reunião, e-mail) e agenda um lembrete, ENTÃO o sistema notifica o responsável no horário definido.

### FR-05 — Configuração de funil
DADO um gestor autenticado, QUANDO cria ou reordena estágios do funil com nome e probabilidade de fechamento, ENTÃO o funil atualizado é aplicado a todas as oportunidades novas e existentes.

### FR-06 — Relatório de conversão
DADO um gestor, QUANDO filtra oportunidades por período e vendedor, ENTÃO visualiza taxa de conversão por estágio, tempo médio de permanência e valor total do pipeline.

### FR-07 — Histórico de interações
DADO um contato com histórico, QUANDO qualquer usuário consulta o contato, ENTÃO visualiza linha do tempo cronológica com todas as atividades e mudanças de estágio das oportunidades relacionadas.

## 4. Requisitos Não-Funcionais
- API REST responde em < 500ms (p95) para operações de consulta e < 1s para relatórios agregados.
- Disponibilidade de 99,5% em horário comercial.
- Dados de contato (e-mail, telefone, CNPJ) nunca aparecem em logs nem em tokens JWT.
- Suporte a 100 usuários simultâneos e até 50.000 oportunidades ativas por tenant.

## 5. Regras de Negócio
- CNPJ de conta é único por tenant; tentativa de duplicação retorna erro 409.
- Oportunidade só pode retroceder de estágio com justificativa obrigatória registrada no histórico.
- Oportunidade marcada como "perdida" ou "ganha" sai do funil ativo mas permanece no histórico.
- Lembrete é enviado via e-mail e notificação in-app no horário agendado.

## 6. Modelo de Dados
- accounts(id, tenant_id, name, cnpj, industry, created_at)
- contacts(id, account_id, name, email, phone, role)
- deals(id, account_id, owner_id, stage_id, value, probability, status, created_at, closed_at)
- stages(id, tenant_id, name, order, win_probability)
- activities(id, deal_id, user_id, type, description, scheduled_at, completed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI 7 (drag-and-drop com dnd-kit).
- Backend: Fastify + PostgreSQL (índices em tenant_id, account_id, stage_id).
- Cache: Redis para contadores de pipeline e taxa de conversão.
