# RUNBOOK FULLSTACK — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Fullstack**:
`fullstack_webapp`, `fullstack_saas`, `fullstack_ecommerce`, `fullstack_erp`,
`fullstack_marketplace`, `fullstack_crm`, `fullstack_lms`, `fullstack_fintech`,
`fullstack_healthtech`, `fullstack_proptech`

---

Projetos fullstack combinam backend + frontend no mesmo repositório/compose.
Execute as fases de **RUNBOOK_backend.md** e **RUNBOOK_frontend.md** nesta ordem:

1. Backend: FASE 1–6 completas (build, infra, E2E, contrato)
2. Frontend: FASE 1–6 completas (build, infra, E2E, contrato)
3. Integração: checks adicionais abaixo

---

## Checks adicionais de integração

### FASE 5 — E2E integrado (além dos E2E individuais)

**Backend sobe e health OK:**
```bash
BACKEND_PORT=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -iE "api.*port|backend.*port" | grep -oE '[0-9]{4,5}' | head -1)
curl -sf http://localhost:$BACKEND_PORT/api/health | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status','ERR'))"
```

**Frontend carrega e se conecta:**
```bash
FRONTEND_PORT=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -iE "frontend.*port|web.*port|porta.*web" | grep -oE '[0-9]{4,5}' | head -1)
curl -sf http://localhost:$FRONTEND_PORT | grep -ic "<html\|<!DOCTYPE" | grep -q "1" && echo "PASS: HTML" || echo "FAIL: sem HTML"
```

**Variáveis de ambiente do frontend apontam para o backend correto:**
```bash
grep "NEXT_PUBLIC_API\|VITE_API\|REACT_APP_API" $PROJECT_DIR/project/docker-compose.yml \
  | grep "$BACKEND_PORT" || echo "WARN: NEXT_PUBLIC_API_URL pode não apontar para a porta correta do backend"
```

**Fluxo completo login → dados reais → ação:**
```bash
TOKEN=$(curl -s -X POST http://localhost:$BACKEND_PORT/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"<SEED_EMAIL>\",\"password\":\"<SEED_PASS>\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('accessToken','FAIL'))")

# Recurso principal tem dados seed
MAIN=$(grep "^| GET" $PROJECT_DIR/project/api_contract.md 2>/dev/null | head -1 | awk '{print $4}')
[ -n "$MAIN" ] && curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$BACKEND_PORT$MAIN?limit=3" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); items=d.get('data',[]); print('items:', len(items), '| meta:', bool(d.get('meta')))"

# Frontend redireciona para login ao acessar rota protegida sem token
CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$FRONTEND_PORT/dashboard)
echo "Dashboard sem auth → HTTP $CODE (esperado 307/302)"
```

### Bugs críticos adicionais (fullstack)

- [ ] **B-FS-01**: `NEXT_PUBLIC_API_URL` hardcoded para produção em dev → deve vir de `.env`
- [ ] **B-FS-02**: CORS do backend não aceita origem do frontend → verificar `CORS_ORIGIN` no env do compose
- [ ] **B-FS-03**: Frontend aponta para porta errada do backend → confirmar via `docker compose ps`
- [ ] **B-FS-04**: `docker-compose.yml` sem `depends_on` do frontend para o backend → frontend pode tentar conectar antes do backend estar pronto

---

## Critério de PASS Fullstack

- [ ] Todos os critérios de PASS Backend
- [ ] Todos os critérios de PASS Frontend
- [ ] `NEXT_PUBLIC_API_URL` correto no `docker-compose.yml`
- [ ] Login funciona end-to-end (frontend → backend → token → dados seed visíveis)
- [ ] Página protegida carrega com dados reais (não empty state)
- [ ] CORS sem erro nos logs do container backend após chamadas do frontend
