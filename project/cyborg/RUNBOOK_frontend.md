# RUNBOOK FRONTEND — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Frontend**:
`frontend_webapp`, `frontend_pwa`, `frontend_landing`, `frontend_institutional`,
`frontend_blog`, `frontend_ecommerce`, `frontend_dashboard`, `frontend_design_system`

---

## Checks específicos de Frontend

### FASE 1 — Artefatos obrigatórios

- [ ] `Dockerfile` presente (multi-stage: build + nginx/node serve)
- [ ] `docker-compose.yml` com porta mapeada
- [ ] `src/` ou `app/` com entry point (`main.tsx`, `App.tsx`, `page.tsx`)
- [ ] `tsconfig.json` presente
- [ ] Arquivo de rotas ou pages definido
- [ ] `src/lib/` ou `src/api/` com clientes de API tipados

### FASE 1.1 — TypeScript obrigatório

```bash
cd $PROJECT_DIR && npx tsc --noEmit 2>&1 | head -40
```

Se houver erros de tipo: corrija antes de subir containers. Erros de tipo são BLOCKER.

### FASE 2 — Infraestrutura

```bash
cd $PROJECT_DIR && docker compose up -d
sleep 15
docker compose logs --tail=50
```

Se build falhar: leia o log, identifique o módulo com erro, corrija.

### FASE 3 — Smoke test Frontend

**Página carrega:**
```bash
PORT=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -i "porta\|port" | grep -oE '[0-9]{4,5}' | head -1)
curl -sf http://localhost:$PORT | grep -i "<html\|<!DOCTYPE" | head -3
# Deve retornar HTML — não erro 502 ou página em branco
```

**Login funciona (se app tem auth):**
- Abrir `http://localhost:$PORT/login`
- Credenciais do RUNBOOK.md
- Deve redirecionar para dashboard sem erros no console

### Bugs críticos para verificar (checklist obrigatório)

- [ ] **B-FE-01**: `createApiClient` chamado com paths que já têm `/api/` → paths não devem ter prefixo (o client adiciona)
- [ ] **B-FE-02**: Login usa campo `username` em vez de `email` → verificar o form e o endpoint
- [ ] **B-FE-03**: Token lido de `response.token` em vez de `response.data?.token` → todos os endpoints Genesis retornam `{ data: T }`
- [ ] **B-FE-04**: `user.name` sem fallback → usar `user.name ?? user.email?.split('@')[0] ?? ''`
- [ ] **B-FE-05**: Rota em `src/lib/*.ts` não existe no `api_contract.md` do backend → CONTRACT LAW — BLOCKER
- [ ] **B-FE-06**: `unwrap()` ausente ao acessar resposta do backend → toda resposta Genesis é `{ data: T }`
- [ ] **B-FE-07**: `globals.css` ou arquivo base de estilo faltando → criar com conteúdo mínimo

#### Manager/Dashboard com módulo de produtos, vendas e estoque

- [ ] **B-FE-08**: `toProduct()` não normaliza ambos os shapes (Postgres e MySQL)

  ```bash
  # Detectar — verificar se a função tem fallback ?? para campos alternativos:
  grep -n "stockLevel\|salePrice\|stockQuantity" apps/src/types/api.ts apps/src/lib/*.ts 2>/dev/null | head -10
  # Se só houver um shape (ex: só 'salePrice', sem 'price') → a função quebra com backend Postgres
  # Fix: usar parseFloat(String(r.price ?? r.salePrice ?? 0))
  #       Number(r.stockLevel ?? r.stockQuantity ?? 0)
  #       r.sku ?? r.code ?? null
  #       typeof r.active === 'boolean' ? r.active : r.status === 'active'
  ```

- [ ] **B-FE-09**: Lib de detalhe de venda espera shape aninhado `{ sale, items }` mas backend retorna flat

  ```bash
  # Detectar:
  grep -n "\.sale\." apps/src/lib/salesApi.ts apps/src/app/**/vendas/**/*.tsx 2>/dev/null | head -5
  # Se encontrar → lib acessa data.sale.status em vez de data.status
  # Fix: getSale() deve retornar { ...data, subtotal } sem desempacotar 'sale'
  ```

- [ ] **B-FE-10**: Valores de select de movimentação de estoque usam strings PT-BR em vez do enum

  ```bash
  # Detectar:
  grep -rn "saida\|ajuste_negativo\|devolucao\|entrada" apps/src/ 2>/dev/null | grep -v "label\|Label\|//\|LABEL"
  # Se encontrar como value de MenuItem → são slugs inválidos; backend rejeita com 400
  # Fix: values DEVEM ser 'in', 'out', 'adjustment', 'return' — os labels em PT-BR ficam só no campo label
  ```

- [ ] **B-FE-11**: Campo de form mapeado com nome errado para o payload do backend

  ```bash
  # Detectar (ex: reason vs notes):
  grep -n "reason\|motivo\|descricao" apps/src/lib/inventoryApi.ts apps/src/lib/*Api.ts 2>/dev/null | head -10
  # Verificar se o nome do campo no payload bate com o campo aceito pelo backend
  # Fix: converter explicitamente no toPayload(): { notes: form.reason }
  ```

- [ ] **B-FE-12**: Roles em guards de menu escritos em PT-BR

  ```bash
  # Detectar:
  grep -rn "gerente\|vendedor\|administrador" apps/src/ 2>/dev/null | grep "roles\|role" | head -10
  # Se encontrar como valor de role → usuarios autenticados não enxergam os itens
  # Fix: usar os slugs exatos do authStore: 'admin' | 'manager' | 'employee'
  ```

- [ ] **B-FE-13**: AppShell sem `xs: 0` no `margin-left`

  ```bash
  # Detectar:
  grep -n "ml:" apps/src/components/layout/AppShell.tsx 2>/dev/null | grep -v "xs"
  # Se encontrar ml sem xs → conteúdo pode vazar para mobile
  # Fix: ml: { xs: 0, md: SIDEBAR_W + 'px' }
  ```

- [ ] **B-FE-14**: Escape sequences `\uXXXX` literais em arquivos TypeScript/TSX

  ```bash
  # Detectar:
  grep -rl "\\\\u[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]" apps/src/ 2>/dev/null | head -5
  # Se encontrar → caracteres quebrados na UI do usuário final
  # Fix automático:
  python3 -c "
  import re, os, glob
  for f in glob.glob('apps/src/**/*.ts*', recursive=True):
      t = open(f).read()
      n = re.sub(r'\\\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1),16)), t)
      if n != t: open(f,'w').write(n); print('fixed:', f)
  "
  ```

### Critério PASS Frontend

- [ ] `tsc --noEmit` sem erros
- [ ] Container sobe sem erro de build
- [ ] Página inicial retorna HTML (200)
- [ ] Login redireciona para dashboard com token válido (se auth presente)
- [ ] Sem erro 500 ou tela branca nos logs
- [ ] Sem card "Offline" ou "Serviço indisponível" na UI
