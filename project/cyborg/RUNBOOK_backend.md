# RUNBOOK BACKEND — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Backend**:
`backend_api`, `backend_graphql`, `backend_grpc`, `backend_websocket`, `backend_serverless`,
`backend_microservice`, `backend_worker`, `backend_data_pipeline`, `backend_event_driven`,
`backend_auth_service`, `backend_notification`, `backend_file_storage`, `backend_search`,
`backend_payment`, `backend_cms_api`, `backend_analytics_api`, `backend_ai_ml`

---

## FASE 1 — Artefatos obrigatórios

```bash
# Verificar existência de cada item
ls $PROJECT_DIR/apps/Dockerfile
ls $PROJECT_DIR/project/docker-compose.yml
ls $PROJECT_DIR/apps/src/          # entry point do código
ls $PROJECT_DIR/apps/package.json
ls $PROJECT_DIR/project/api_contract.md  # BLOCKER se ausente

# Banco de dados: migrations e seed
ls $PROJECT_DIR/apps/drizzle/migrations/*.sql 2>/dev/null \
  || ls $PROJECT_DIR/apps/src/db/migrations/*.sql 2>/dev/null \
  || echo "FALTANDO: migrations SQL"

ls $PROJECT_DIR/apps/seed.mjs 2>/dev/null \
  || ls $PROJECT_DIR/apps/seeds/ 2>/dev/null \
  || ls $PROJECT_DIR/apps/src/db/seed.ts 2>/dev/null \
  || echo "FALTANDO: seed"
```

Se `api_contract.md` ausente → **BLOCKER** — projeto não pode ser aceito sem contrato.

---

## FASE 2 — Build TypeScript

```bash
cd $PROJECT_DIR/apps
npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -5
npm run build 2>&1 | tail -30
```

**ZERO erros de TypeScript são tolerados.** Se houver erros:
1. Leia a mensagem de erro
2. Identifique o arquivo e linha
3. Corrija
4. Repita até `npm run build` passar sem erros

Erros comuns e fix:
- `Property 'X' does not exist on type 'Y'` → campo com nome errado no type
- `details: {}` em Fastify schema → `details: { type: 'object' }`
- `findAll is not a function` → Drizzle usa `findMany`
- `Cannot find module` → dependência faltando no `package.json`

---

## FASE 3 — Infraestrutura

```bash
cd $PROJECT_DIR/project
docker compose up -d

# Aguardar até 90s
for i in $(seq 1 18); do
  HEALTHY=$(docker compose ps --format json 2>/dev/null \
    | python3 -c "import sys,json; ps=json.load(sys.stdin); \
      all_ok = all(p.get('Health','') in ['healthy',''] and p.get('State','') in ['running','exited'] \
        for p in (ps if isinstance(ps,list) else [ps])); print('YES' if all_ok else 'NO')" 2>/dev/null)
  [ "$HEALTHY" = "YES" ] && break
  echo "[$i/18] Aguardando containers... (5s)"
  sleep 5
done

docker compose ps
docker compose logs --tail=50
```

Se container em crash loop:
```bash
docker compose logs <service_name> --tail=100
# Leia a causa → corrija o arquivo → docker compose build <service> → docker compose up -d
```

---

## FASE 4 — Auto-descoberta de rotas

**Descobrir automaticamente todas as rotas do projeto:**

```bash
# Fastify — extrair rotas registradas
grep -rh "app\.get\|app\.post\|app\.patch\|app\.put\|app\.delete\|router\.get\|router\.post\|router\.patch\|router\.delete" \
  $PROJECT_DIR/apps/src/routes/ $PROJECT_DIR/apps/src/http/ 2>/dev/null \
  | grep -oE "'[^']+'" | sort -u

# Express — idem
grep -rh "router\.\(get\|post\|patch\|put\|delete\)" \
  $PROJECT_DIR/apps/src/ 2>/dev/null \
  | grep -oE "'[^']+'" | sort -u

# Ler api_contract.md para complementar
cat $PROJECT_DIR/project/api_contract.md | grep "^| GET\|^| POST\|^| PATCH\|^| DELETE\|^| PUT" | awk '{print $2, $4}'
```

Montar lista completa: `ROUTES=(<rota_1> <rota_2> ...)`.

---

## FASE 5 — E2E completo de endpoints

### 5.1 — Setup: obter token

```bash
PORT=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -iE "porta|port" | grep -oE '[0-9]{4,5}' | head -1)
SEED_EMAIL=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -iE "email|usuario|user" | grep "@" | grep -oE '[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}' | head -1)
SEED_PASS=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -iE "senha|password|pass" | grep -oE '[A-Za-z0-9@#$%!_\-\.]{6,}' | head -1)

TOKEN=$(curl -s -X POST http://localhost:$PORT/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$SEED_EMAIL\",\"password\":\"$SEED_PASS\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); \
    print(d.get('data',{}).get('accessToken', d.get('data',{}).get('token','FAIL')))")

echo "TOKEN: ${TOKEN:0:30}..."
[ "$TOKEN" = "FAIL" ] && echo "ERRO: login falhou — verificar credenciais e rota de auth"
```

### 5.2 — Testar cada rota da lista

Para cada rota descoberta na FASE 4, execute:

```bash
# GET endpoints (listagens)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:$PORT/api/<rota>?page=1&limit=5" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
code = d.get('code','ok')
data = d.get('data')
meta = d.get('meta')
has_data = data is not None and (isinstance(data, list) and len(data) >= 0 or isinstance(data, dict))
print(f'STATUS: {code} | data: {type(data).__name__} | meta: {bool(meta)}')
if code not in ['ok','OK'] and code != 'ok':
    print(f'  FAIL → {d}')
"

# GET byId (detalhe)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:$PORT/api/<rota>/<seed_id>" \
  | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('STATUS:', d.get('code','ok'), '| id:', d.get('data',{}).get('id','?')[:8] if isinstance(d.get('data'),dict) else '?')
"

# POST (criação)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '<payload_minimo_valido>' \
  "http://localhost:$PORT/api/<rota>" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('STATUS:', d.get('code','ok'), '| created:', bool(d.get('data')))"

# PATCH (atualização)
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '<campo_alteravel>' \
  "http://localhost:$PORT/api/<rota>/<seed_id>" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('STATUS:', d.get('code','ok'))"
```

**Critério por endpoint:**
- `200/201/204` → PASS
- `404` → rota não existe ou ID errado → investigar e corrigir
- `400` → payload inválido → ajustar payload de teste ou corrigir validação
- `401/403` → autenticação/autorização → verificar token e role
- `500` → bug no handler → ler logs `docker compose logs` → corrigir

### 5.3 — Verificar dados seed em todas as tabelas principais

```bash
# Para cada tabela relevante do projeto
DB_CONTAINER=$(docker compose -f $PROJECT_DIR/project/docker-compose.yml ps --format json \
  | python3 -c "import sys,json; ps=json.load(sys.stdin); \
    dbs=[p['Name'] for p in (ps if isinstance(ps,list) else [ps]) if 'db' in p['Name'] or 'postgres' in p['Image'] or 'mysql' in p['Image']]; \
    print(dbs[0] if dbs else '')" 2>/dev/null)

# PostgreSQL
docker exec $DB_CONTAINER psql -U postgres <db_name> -c "
SELECT schemaname, tablename, n_live_tup
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;" 2>/dev/null

# MySQL
docker exec $DB_CONTAINER mysql -uroot -proot <db_name> -e "
SELECT table_name, table_rows FROM information_schema.tables
WHERE table_schema = DATABASE() ORDER BY table_rows DESC;" 2>/dev/null
```

**Critério:** tabelas principais com `n_live_tup > 0` (seed aplicado). Se vazio → seed falhou → investigar e rodar seed manualmente.

### 5.4 — Verificar rotas de autenticação completas

```bash
# /users/me (não /auth/me)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/users/me \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('me:', d.get('data',{}).get('email','ERR'), '| code:', d.get('code','ok'))"

# Proteger rota sem token — deve retornar 401
curl -s http://localhost:$PORT/api/$(grep -m1 "GET.*auth\|protected" $PROJECT_DIR/project/api_contract.md | awk '{print $4}' | tr -d '/' | head -1) \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('sem token:', d.get('code','?'))"
```

### 5.5 — Verificar módulos específicos por tipo de projeto

**Se projeto tem `sales` / vendas:**
```bash
# Tabela tem payment_method e code
docker exec $DB_CONTAINER psql -U postgres <db> \
  -c "\d sales" 2>/dev/null | grep -E "payment_method|code" || echo "FALTANDO: payment_method/code na tabela sales"

# GET /sales/:id retorna shape flat (não aninhado)
SALE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/sales?limit=1 \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')")
[ -n "$SALE_ID" ] && curl -s -H "Authorization: Bearer $TOKEN" http://localhost:$PORT/api/sales/$SALE_ID \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('FLAT' if 'items' in d else 'NESTED_BUG')"
```

**Se projeto tem `products` / produtos:**
```bash
# GET /products retorna category join
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/products?limit=1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; \
    p=d[0] if d else {}; print('category:', p.get('category','NULL_BUG'))"
```

**Se projeto tem `categories` / categorias:**
```bash
# GET /categories retorna parent e productCount
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/categories?limit=3" \
  | python3 -c "import sys,json; cs=json.load(sys.stdin)['data']; \
    [print(c['name'], '| productCount:', c.get('productCount','MISSING'), '| parent:', c.get('parent','MISSING')) for c in cs]"
```

**Se projeto tem `stock` / estoque:**
```bash
# Alias /stock-movements retorna meta
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/stock-movements?limit=5" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('meta:', d.get('meta','MISSING — BUG: alias sem paginated()'))"
```

---

## FASE 6 — Validação do contrato de API

O `api_contract.md` é um artefato **obrigatório**. Sem ele, projetos frontend não conseguem ser implementados corretamente.

```bash
# Verificar existência
ls $PROJECT_DIR/project/api_contract.md || { echo "BLOCKER: api_contract.md ausente"; exit 1; }

# Verificar completude mínima
grep -c "^| GET\|^| POST\|^| PATCH\|^| DELETE\|^| PUT" $PROJECT_DIR/project/api_contract.md
# Deve ter pelo menos N linhas onde N = número de rotas testadas

# Verificar seção de autenticação
grep -i "users/me\|auth/login\|accessToken" $PROJECT_DIR/project/api_contract.md || \
  echo "WARN: contrato sem documentação de autenticação"

# Verificar que as rotas testadas estão documentadas
for ROUTE in $ROUTES; do
  grep -q "$ROUTE" $PROJECT_DIR/project/api_contract.md || \
    echo "CONTRATO INCOMPLETO: rota $ROUTE não documentada"
done
```

Se o contrato estiver ausente ou incompleto → **gerar/completar** antes de aceitar.

---

## Checklist obrigatório de bugs Node.js + Drizzle (verificar e corrigir)

| # | Check | Comando de detecção | Fix |
|---|-------|-------------------|-----|
| B-NODE-01 | `npm ci` com erro de lockfile | `cat apps/Dockerfile \| grep "npm ci"` | Trocar por `npm install --legacy-peer-deps` |
| B-NODE-02 | CORS ausente | `grep -r "cors" apps/src/app.ts` | Registrar `fastify-cors` / `cors` antes das rotas |
| B-NODE-03 | Rate limiter em dev | `grep -r "rateLimit\|rate_limit" apps/src/` | Desabilitar em `NODE_ENV !== 'production'` |
| B-NODE-04 | Stack divergente | `grep -r "express\|fastify\|nestjs" apps/package.json` | Confirmar vs charter |
| B-NODE-05 | `findAll` inexistente | `grep -rn "\.findAll(" apps/src/` | Substituir por `.findMany()` |
| B-NODE-06 | Rotas não registradas | `grep -rn "Routes\|routes" apps/src/app.ts` | `app.register(xxxRoutes)` |
| B-NODE-07 | Seed fora do Dockerfile | `grep "seed" apps/../project/docker-compose.yml` | `COPY seed.mjs ./` no Dockerfile |
| B-SALES-1 | `sales` sem `payment_method`/`code` | `\d sales` no banco | `ALTER TABLE` + schema Drizzle |
| B-SALES-2 | GET /sales/:id shape aninhado | `curl GET /sales/:id \| grep "\"sale\""` | Reescrever handler para shape flat |
| B-SALES-3 | GET /products sem join category | `curl GET /products \| grep category` | `leftJoin(categories)` no repository |
| B-SALES-4 | GET /categories sem productCount | `curl GET /categories \| grep productCount` | SQL raw para subquery correlacionada |
| B-SALES-5 | Alias sem `paginated()` | `curl GET /alias \| grep meta` | Envolver com `paginated()` |
| B-SALES-6 | `/auth/me` retorna 404 | `curl GET /api/auth/me` | Usar `/api/users/me` |

---

## Critério de PASS Backend

- [ ] `npm run build` sem erros TypeScript
- [ ] Todos os containers `healthy`
- [ ] `GET /health` retorna `{ data: { status: 'ok' } }`
- [ ] Login retorna `accessToken` (campo exato)
- [ ] `GET /users/me` com token válido retorna dados do usuário
- [ ] **Todos** os endpoints do `api_contract.md` testados e passando
- [ ] Tabelas principais com dados seed (n_live_tup > 0)
- [ ] `api_contract.md` presente e cobrindo todas as rotas testadas
- [ ] Sem erro 500 nos logs após todos os testes
- [ ] `grep -rn "\\\\u[0-9a-fA-F]{4}" apps/src/` retorna vazio
