# Érica Cosméticos — Landing Page Institucional

## Visão geral

Site institucional estático para a loja **Érica Cosméticos**, especializada em produtos de beleza e cosméticos. O objetivo é apresentar a marca, destacar os produtos e converter visitantes em clientes via WhatsApp ou formulário de contato.

Sem backend, sem API, sem autenticação. Front-end estático.

---

## Stack

- **Framework:** Next.js 14 (static export / SSG)
- **Estilo:** Tailwind CSS
- **Linguagem:** TypeScript
- **Deploy:** Vercel ou qualquer CDN estático

---

## Páginas e seções

### 1. Hero

- Logo da Érica Cosméticos
- Tagline: "Beleza que transforma, qualidade que você sente"
- Botão CTA principal: "Conheça nossos produtos" → ancora para seção de produtos
- Botão secundário: "Fale conosco no WhatsApp" → link externo WhatsApp

### 2. Sobre nós

- Texto de apresentação da loja (2–3 parágrafos)
- Missão: oferecer produtos de qualidade acessíveis
- Valores: qualidade, cuidado, confiança
- Imagem ilustrativa (placeholder)

### 3. Produtos em destaque

- Grid de 6 cards de produtos
- Cada card: foto (placeholder), nome do produto, categoria, descrição curta, badge "Mais vendido" (opcional)
- Categorias: Skincare, Maquiagem, Cabelos, Perfumaria, Corpo, Unhas
- Sem carrinho, sem preço — foco em apresentação

### 4. Por que escolher a Érica Cosméticos

- 3 diferenciais em cards horizontais:
  1. Produtos originais e certificados
  2. Atendimento personalizado
  3. Entrega rápida para todo o Brasil

### 5. Depoimentos

- 3 depoimentos fictícios de clientes
- Nome, foto avatar (placeholder), texto curto, avaliação em estrelas

### 6. Contato

- Formulário simples: nome, e-mail, mensagem — apenas visual (sem backend)
- Botão WhatsApp com número placeholder
- Endereço fictício, e-mail fictício, horário de funcionamento
- Mapa embed (Google Maps placeholder)

### 7. Footer

- Logo
- Links rápidos: Sobre, Produtos, Contato
- Redes sociais: Instagram, Facebook, TikTok (ícones + links placeholder)
- Copyright

---

## Design

- **Paleta de cores:** rosa (#F4A7B9), branco (#FFFFFF), rose gold (#B76E79), cinza claro (#F9F9F9)
- **Tipografia:** Inter (corpo), Playfair Display (títulos)
- **Tom:** feminino, elegante, acessível, acolhedor
- **Responsivo:** mobile-first

---

## Requisitos técnicos

- Responsivo (mobile, tablet, desktop)
- SEO básico: meta tags, Open Graph, título por página
- Acessibilidade: alt em imagens, contraste adequado
- Sem dependências de backend
- Build estático exportável (`next export` ou `output: 'export'`)

---

## Fora do escopo

- E-commerce (carrinho, pagamento, checkout)
- Autenticação
- CMS ou painel admin
- API própria
- Blog
