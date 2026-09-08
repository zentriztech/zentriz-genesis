> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# 💡 IDEIA EM MATURAÇÃO — Rename `Genesis` → `Genesiz`

> **STATUS: IDEIA. NADA FOI DECIDIDO NEM EXECUTADO.**
> Este documento é apenas um levantamento de escopo/impacto para amadurecer a ideia.
> Não é um ADR, não é um plano aprovado. Nenhum arquivo, infra, DNS ou banco foi alterado.
> Data do levantamento: **2026-08-31**.

---

## 1. A ideia

Trocar o nome do produto-carro-chefe **Genesis → Genesiz** (com `z` no final), para
usar o **`Z` do ZentriZ** e reforçar o sistema de marca — a mesma simbologia do `Z`
celebrada pelo easter egg "A Ciência de um Nome" no landpage.

**Motivação estratégica (a favor):**
- "Genesis" é genérico e praticamente **impossível de possuir** (SEGA, GM, bancos, cripto, biotech, dezenas de SaaS) → SEO/trademark/navegação sofrem. "Genesiz" é único e defensável.
- Reforça a **arquitetura de marca no Z** do ZentriZ.
- **Pronúncia idêntica** — "Genesis" já termina com som /s/~/z/; o `z` é troca puramente visual. Zero confusão fonética.

**Riscos (contra):**
- Percepção "gimmick" (misspelling estilo Flickr/Tumblr) para comprador enterprise/C-level — mitigável se a narrativa do `Z` estiver visível.
- **Custo de troca em sistema vivo** com tenants pagantes (Cabral/Salif já receberam credenciais apontando para o domínio atual).
- Consistência do portfólio: **Auto Care quebra o padrão** de `Z`-final.

**Precedente no próprio ecossistema:** o rename **Deadpool → Auto Care** foi *só texto visível* —
rotas/identificadores/serviços internos seguiram sendo "Deadpool". Mesmo playbook se aplica aqui.

---

## 2. Mapa de impacto por camada (levantado em 2026-08-31)

### 🟢 Camada 1 — Landpage (site público) · baixo risco, alto valor
Repo `zentriz-landpage`. **~113 ocorrências em 12 arquivos.**

| Onde | O que é | Tipo |
|---|---|---|
| `pages/Products/Genesis.tsx` (37), `AutonomySuite.tsx` (54), `Home.tsx`, `Index.tsx` | Marketing, títulos, descrições | Visível |
| `locales/{pt,en}/translation.json` (25+25) | Strings i18n | Visível |
| `App.tsx` → rota `/products/genesis` | URL pública | Semi-visível (301) |
| `Header.tsx`, `LeadForm.tsx`, `generate-sitemap.mjs` | Nav, form, sitemap | Misto |

**Custo:** ~1-2h. **Risco:** mínimo (texto + 1 rota com 301). Reversível.

### 🟡 Camada 2 — Portal/Produto · misto; núcleo é alto risco
Repo `zentriz-autonomy-suite/zentriz-genesis`. **1383 ocorrências em 288 arquivos.**

| Sub-camada | Volume | Tipo | Risco |
|---|---|---|---|
| UI do portal (`genesis-web/app`, `/src`) | ~14 arquivos | Visível (títulos, labels) | 🟢 Baixo |
| Docs/RFC/planos internos (prosa) | ~56 arquivos | Interno-doc | 🟢 Baixo |
| **DB**: `zentriz_genesis`, `POSTGRES_USER: genesis` | — | Interno-acoplado | 🔴 Alto (migração de dados) |
| **Docker**: project name `zentriz-genesis`; volumes `zentriz-genesis_{pgdata,redis,uploads,deadpool_state}`; serviços `genesis-web`/`api-node` | — | Interno-acoplado | 🔴 Alto (recriar volumes = perda de estado se malfeito) |
| **Env vars** `GENESIS_*` (`GENESIS_API_URL/TOKEN`, `GENESIS_LLM_PROVIDER`, `GENESIS_AWS_REGION`, `GENESIS_FOUNDRY_DISABLE_THINKING`…) | dezenas | Interno-acoplado | 🔴 Alto (contrato runtime API↔orchestrator) |
| Migrations (`020_genesis_runtime_config.sql`), IAM (`genesis-s3-deployer-policy.json`) | — | Interno-acoplado | 🔴 Alto |

### 🟡 Camada 3 — Docs/ADRs/Marketing · só prosa
- `autonomy-suite/docs`: **144 arquivos**. **ADRs**: ~10 citam Genesis (ADR-018/019/023…). marketing-decks/campanha: 3.
- **Regra dos ADRs:** não se reescreve ADR antigo (numeração global imutável) — cria-se **ADR novo** registrando a decisão do rename. Risco baixo, volume alto de edição.

### 🔴 Camada 4 — Infra viva (produção) · não está em arquivo, é estado real
Da memória do projeto (prod NÃO foi verificado neste levantamento, a pedido):

| Recurso | Valor atual | Impacto |
|---|---|---|
| **DNS** | `genesis.zentriz.com.br` (login `/login/tenant`, signup `/tenant/signup`) | Novo subdomínio + 301; e-mails de credencial já enviados apontam pro antigo |
| **ECR** | imagens `zentriz-genesis-<svc>:latest` | Criar repos novos + reapontar todo o deploy |
| **EC2 prod** | path `/opt/zentriz-genesis`, `.env.deadpool-aws` | Renomear path quebra scripts/compose |
| **GitHub** | repo do produto | rename de repo (GH cria redirects, mas CI/remotes atualizam) |

---

## 3. Leitura custo × valor

- **Marca visível (cliente vê):** Camadas 1, 3-marketing, UI da 2, DNS → **~85% do valor, ~15% do risco.**
- **Tripas internas (invisível ao cliente):** DB, Docker, env vars `GENESIS_*`, ECR, paths, IAM → **~15% do valor, ~85% do risco**, em sistema com tenants pagantes e pipeline de deploy frágil (build-based, retag ECR exato — gotchas documentados).

---

## 4. Recomendação (SE/QUANDO amadurecer para decisão)

1. **Fazer:** marca visível (landpage + UI portal + docs-prosa + marketing) e **DNS com 301** do antigo.
2. **Manter como codinome:** `genesis` em DB, Docker, env vars `GENESIS_*`, ECR, paths, IAM — zero valor de marca, todo o risco (idem Deadpool→Auto Care).
3. **Registrar** a decisão num **ADR novo** quando decidida.

Caminho mais barato e reversível para começar (se decidir): **Camada 1 (landpage)**.

---

## 5. Perguntas em aberto (a resolver antes de qualquer decisão)

- [ ] `Z`-final é **regra do portfólio** (todos os produtos) ou **exceção do flagship**? (Auto Care quebra o padrão.)
- [ ] Estratégia de domínio: novo `genesiz.zentriz.com.br` com 301, ou migração dura?
- [ ] Vale o custo de troca agora, com clientes já onboarded no nome atual?
- [ ] Timing: antes ou depois de estabilizar a base de tenants?
