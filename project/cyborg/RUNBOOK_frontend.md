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

### Critério PASS Frontend

- [ ] `tsc --noEmit` sem erros
- [ ] Container sobe sem erro de build
- [ ] Página inicial retorna HTML (200)
- [ ] Login redireciona para dashboard com token válido (se auth presente)
- [ ] Sem erro 500 ou tela branca nos logs
- [ ] Sem card "Offline" ou "Serviço indisponível" na UI
