# RUNBOOK BACKEND — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Backend**:
`backend_api`, `backend_graphql`, `backend_grpc`, `backend_websocket`, `backend_serverless`,
`backend_microservice`, `backend_worker`, `backend_data_pipeline`, `backend_event_driven`,
`backend_auth_service`, `backend_notification`, `backend_file_storage`, `backend_search`,
`backend_payment`, `backend_cms_api`, `backend_analytics_api`, `backend_ai_ml`

---

## Checks específicos de Backend

### FASE 1 — Artefatos obrigatórios

- [ ] `Dockerfile` presente e com multi-stage build
- [ ] `docker-compose.yml` com `container_name` definido
- [ ] `src/` com entry point (`index.ts`, `main.ts`, `app.ts` ou equivalente)
- [ ] `package.json` com `start` script (ou `Makefile` para Python)
- [ ] `src/db/migrations/` com pelo menos 1 arquivo `.sql` (se projeto usa banco)
- [ ] `seed.mjs` ou `seeds/` copiado no Dockerfile (se projeto usa banco)

### FASE 2 — Infraestrutura

```bash
cd $PROJECT_DIR && docker compose up -d
# Aguardar até 90s
for i in $(seq 1 18); do
  STATUS=$(docker compose ps --format json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Health','') or d.get('State',''))" 2>/dev/null)
  echo "[$i] $STATUS"
  [[ "$STATUS" == *"healthy"* || "$STATUS" == *"running"* ]] && break
  sleep 5
done
docker compose logs --tail=50
```

Se container reiniciando em loop: `docker compose logs <service>` → identifique o erro → corrija.

### FASE 3 — Smoke test Backend

**Health check:**
```bash
PORT=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -i "porta\|port" | grep -oE '[0-9]{4,5}' | head -1)
curl -sf http://localhost:$PORT/health || curl -sf http://localhost:$PORT/api/health
```

**Autenticação (se projeto tem auth):**
```bash
# Credenciais do RUNBOOK.md
curl -sf -X POST http://localhost:$PORT/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<EMAIL_SEED>","password":"<SENHA_SEED>"}' | python3 -m json.tool
# Deve retornar { data: { token: "..." } }
```

**CRUD principal:**
```bash
# GET listagem — deve retornar array com dados seed
curl -sf -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/<recurso-principal>
# Deve retornar { data: [...], total: N }
```

**Generic Search (obrigatório em projetos com banco):**
```bash
curl -sf -H "Authorization: Bearer $TOKEN" \
  "http://localhost:$PORT/api/<recurso>?limit=5&offset=0" | python3 -m json.tool
# Deve retornar { data: [...], total: N, limit: 5, offset: 0 }
```

### Bugs críticos para verificar (checklist obrigatório)

- [ ] **B-NODE-01**: `npm ci` com erro de lockfile → trocar por `npm install --legacy-peer-deps`
- [ ] **B-NODE-02**: CORS ausente → verificar `fastify-cors` ou `cors` registrado antes das rotas
- [ ] **B-NODE-03**: Rate limiter quebrando testes → verificar se está desabilitado em `NODE_ENV=test`
- [ ] **B-NODE-04**: Stack divergente → confirmar framework bate com charter (Fastify vs Express)
- [ ] **B-NODE-05**: `findAll` inexistente no Drizzle → deve ser `findMany`
- [ ] **B-NODE-06**: Rotas não registradas no `app.ts` → verificar `app.register(routes)`
- [ ] **B-NODE-07**: Seed não copiado no Dockerfile → `COPY seeds/ ./seeds/`
- [ ] **B-PY-01**: `setuptools` faltando no requirements → adicionar antes de rodar pip
- [ ] **B-PY-02**: Pydantic com campo em lowercase que deveria ser uppercase → verificar models
- [ ] **B-PY-03**: Prefixo de rota duplicado (`/api/api/`) → checar `prefix` no router
- [ ] **B-PY-04**: `asyncpg` com ENUM → usar `str` no Python, cast no SQL
- [ ] **B-PY-05**: `python-multipart` ausente para form upload → adicionar ao requirements

### Critério PASS Backend

- [ ] Container sobe sem reinicialização
- [ ] `/health` retorna 200
- [ ] Login retorna `{ data: { token } }` (se auth presente)
- [ ] GET do recurso principal retorna dados seed
- [ ] Generic search retorna `{ data, total, limit, offset }`
- [ ] Sem 500 nos logs dos últimos 60s
