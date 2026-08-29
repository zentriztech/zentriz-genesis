# Portal Imobiliário

## 0. Metadados
- **Produto:** ImobiFinder — portal de anúncios imobiliários conectando compradores, locatários e corretores
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma web e mobile para corretores publicarem imóveis com fotos e detalhes, interessados buscarem por filtros avançados e agendarem visitas, reduzindo tempo de venda e aumentando alcance de anúncios.

## 2. Personas
- Corretor imobiliário — cadastra imóveis, publica anúncios, recebe leads e agenda visitas.
- Comprador/locatário — busca imóveis por bairro, preço e características, favorita anúncios e solicita contato.
- Administrador da imobiliária — aprova anúncios, monitora performance de corretores e gerencia planos de destaque.

## 3. Requisitos Funcionais (FR)
### FR-01 — Autenticação e perfis de usuário
DADO um usuário cadastrado com e-mail e senha, QUANDO informa credenciais válidas, ENTÃO recebe um token de sessão e acessa funcionalidades conforme seu perfil (comprador, corretor ou administrador).

### FR-02 — Cadastro de imóveis com fotos e características
DADO um corretor autenticado, QUANDO cadastra um imóvel informando tipo (casa, apartamento, terreno), endereço, valor, área útil, quartos, vagas e upload de até 20 fotos, ENTÃO o sistema registra o imóvel com status "rascunho" e permite publicação após aprovação do administrador.

### FR-03 — Busca de imóveis por filtros
DADO um comprador no portal, QUANDO informa filtros de tipo de negócio (venda ou locação), faixa de preço, bairro, número de quartos e área mínima, ENTÃO o sistema retorna lista paginada de imóveis que atendem aos critérios, ordenados por relevância e data de publicação.

### FR-04 — Galeria de fotos e tour virtual
DADO um imóvel publicado com fotos, QUANDO o comprador visualiza o anúncio, ENTÃO o sistema exibe galeria responsiva com navegação por thumbnails, zoom e indicador de foto principal; se houver tour virtual 360°, exibe player embarcado.

### FR-05 — Solicitação de contato e agendamento de visita
DADO um comprador interessado em um imóvel, QUANDO clica em "Agendar visita" e preenche nome, telefone, e-mail e horário preferencial, ENTÃO o sistema registra o lead, notifica o corretor responsável por e-mail e WhatsApp, e o corretor recebe o pedido no painel de agendamentos.

### FR-06 — Painel do corretor com leads e visitas
DADO um corretor autenticado, QUANDO acessa o painel de controle, ENTÃO visualiza lista de leads recebidos (novos, em negociação, visitados, convertidos), imóveis publicados, estatísticas de visualizações e funil de conversão.

## 4. Requisitos Não-Funcionais
- Busca de imóveis retorna resultados em < 300ms; cache de filtros comuns.
- Upload de fotos suporta até 5MB por imagem; resize automático para thumbnail e alta resolução.
- Disponibilidade 99,5%; imagens servidas via CDN.
- Dados de contato de leads visíveis apenas para o corretor responsável e administrador.

## 5. Regras de Negócio
- Um imóvel só pode ser publicado após aprovação do administrador; imóveis reprovados retornam a "rascunho" com motivo.
- Endereço completo do imóvel só é exibido para usuários autenticados; busca pública mostra apenas bairro.
- Leads duplicados (mesmo e-mail para o mesmo imóvel em < 7 dias) são agrupados e não notificam novamente.
- Imóveis sem fotos não podem ser publicados; mínimo 3 fotos obrigatório.

## 6. Modelo de Dados
- users(id, email, name, phone, role, status)
- properties(id, owner_user_id, type, transaction_type, price, address, neighborhood, area_sqm, bedrooms, bathrooms, parking_spots, description, status, published_at)
- property_media(id, property_id, file_url, media_type, display_order, is_primary)
- leads(id, property_id, inquirer_name, inquirer_email, inquirer_phone, message, preferred_visit_time, status, created_at)
- favorites(id, user_id, property_id, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Leaflet (mapas). Backend: Fastify + PostgreSQL + PostGIS (busca geográfica) + Redis (cache). Auth JWT. Storage: S3 + CloudFront.
