# RUNBOOK FULLSTACK — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Fullstack**:
`fullstack_webapp`, `fullstack_saas`, `fullstack_ecommerce`, `fullstack_erp`,
`fullstack_marketplace`, `fullstack_crm`, `fullstack_lms`, `fullstack_fintech`,
`fullstack_healthtech`, `fullstack_proptech`

---

Projetos fullstack combinam backend + frontend no mesmo repositório/compose.
Execute os checks de RUNBOOK_backend.md **e** RUNBOOK_frontend.md nesta ordem:

1. Backend sobe e passa no smoke test
2. Frontend sobe e se conecta ao backend
3. Fluxo integrado funciona (login → listagem de dados reais → ação principal)

## Checks adicionais (integração)

### FASE 3 — Smoke test integrado

**Backend health:**
```bash
BACKEND_PORT=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -i "api.*port\|backend.*port" | grep -oE '[0-9]{4,5}' | head -1)
curl -sf http://localhost:$BACKEND_PORT/api/health
```

**Frontend carrega e se conecta:**
```bash
FRONTEND_PORT=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -i "frontend.*port\|web.*port\|porta.*web" | grep -oE '[0-9]{4,5}' | head -1)
curl -sf http://localhost:$FRONTEND_PORT | grep -i "<html\|<!DOCTYPE"
```

**Login via frontend → token → dados do backend:**
- Login com credenciais seed
- Navegar para a listagem principal
- Verificar que dados seed aparecem (não "Nenhum registro")

### Bugs críticos adicionais (fullstack)

- [ ] **B-FS-01**: `NEXT_PUBLIC_API_URL` hardcoded para produção em dev → deve vir de `.env`
- [ ] **B-FS-02**: CORS do backend não aceita origem do frontend → verificar `CORS_ORIGIN` no env
- [ ] **B-FS-03**: Frontend aponta para porta errada do backend → confirmar via `docker compose ps`
- [ ] **B-FS-04**: `docker-compose.yml` sem `depends_on` do frontend para o backend → frontend pode subir antes do backend estar pronto

### Critério PASS Fullstack

- [ ] Backend health 200
- [ ] `tsc --noEmit` sem erros no frontend
- [ ] Login funciona end-to-end (frontend → backend → token → dados)
- [ ] Listagem principal exibe dados seed reais
- [ ] Sem card "Offline" ou "Serviço indisponível"
- [ ] Sem CORS error nos logs do browser (verificar nos logs do container frontend)
