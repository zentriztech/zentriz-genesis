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

#### Módulo de vendas (quando projeto tem tabela `sales`)

- [ ] **B-SALES-1**: Tabela `sales` sem `payment_method` ou `code`

  ```bash
  # Detectar:
  docker exec <db_container> psql -U postgres <db> -c "\d sales" | grep -E "payment_method|code"
  # Se vazio → adicionar via ALTER TABLE e corrigir o schema Drizzle:
  # ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_method varchar(30);
  # ALTER TABLE sales ADD COLUMN IF NOT EXISTS code varchar(20);
  ```

- [ ] **B-SALES-2**: `GET /sales/:id` retorna `{ data: { sale: {}, items: [] } }` aninhado em vez de shape flat

  ```bash
  # Detectar:
  curl -s -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/sales/<id> \
    | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('NESTED' if 'sale' in d else 'FLAT')"
  # Se NESTED → editar o handler GET /sales/:id para retornar shape flat:
  # { ...saleDto, subtotal, items: items.map(toSaleItemDto) }
  ```

- [ ] **B-SALES-3**: `GET /products` retorna `category: null` mesmo com produtos categorizados

  ```bash
  # Detectar:
  curl -s -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/products?limit=1 \
    | python3 -c "import sys,json; p=json.load(sys.stdin)['data']; print(p[0].get('category') if p else 'NO_DATA')"
  # Se None → o repository.findProducts não faz leftJoin com categories
  # Fix: adicionar .leftJoin(categories, eq(products.categoryId, categories.id)) na query
  ```

- [ ] **B-SALES-4**: `GET /categories` retorna `productCount: 0` e `parent: null` mesmo com dados

  ```bash
  # Detectar:
  curl -s -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/categories?limit=3 \
    | python3 -c "import sys,json; cs=json.load(sys.stdin)['data']; print([(c['name'], c.get('productCount',0)) for c in cs])"
  # Se todos com 0 → subquery usa ${categories.id} parametrizado em vez de 'categories.id' raw
  # Fix: usar sql\`(SELECT COUNT(*)::int FROM products p WHERE p.category_id = categories.id)\`
  ```

- [ ] **B-SALES-5**: Alias de rota retorna array raw sem `meta`

  ```bash
  # Detectar (ex: /api/stock-movements):
  curl -s -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/stock-movements?limit=5 \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('meta') else 'RAW_ARRAY')"
  # Se RAW_ARRAY → handler do alias retorna resultado cru do service
  # Fix: envolver em paginated(data.map(toDto), total, page, limit)
  ```

- [ ] **B-SALES-6**: Endpoint `/api/auth/me` retorna 404 (rota correta é `/api/users/me`)

  ```bash
  # Detectar:
  curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/auth/me
  # Se 404 → rota registrada como /users/me; corrigir nas chamadas do frontend
  curl -s -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/users/me | python3 -m json.tool | head -5
  ```

### Critério PASS Backend

- [ ] Container sobe sem reinicialização
- [ ] `/health` retorna 200
- [ ] Login retorna `{ data: { token } }` (se auth presente)
- [ ] GET do recurso principal retorna dados seed
- [ ] Generic search retorna `{ data, total, limit, offset }`
- [ ] Sem 500 nos logs dos últimos 60s
