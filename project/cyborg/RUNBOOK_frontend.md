# RUNBOOK FRONTEND — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Frontend**:
`frontend_webapp`, `frontend_pwa`, `frontend_landing`, `frontend_institutional`,
`frontend_blog`, `frontend_ecommerce`, `frontend_dashboard`, `frontend_design_system`

---

## FASE 1 — Artefatos obrigatórios

```bash
ls $PROJECT_DIR/apps/Dockerfile
ls $PROJECT_DIR/project/docker-compose.yml
ls $PROJECT_DIR/apps/src/ 2>/dev/null || ls $PROJECT_DIR/apps/app/ 2>/dev/null   # entry point
ls $PROJECT_DIR/apps/tsconfig.json
ls $PROJECT_DIR/apps/package.json

# Libs de API (obrigatório se consome backend)
ls $PROJECT_DIR/apps/src/lib/ 2>/dev/null || ls $PROJECT_DIR/apps/src/api/ 2>/dev/null || \
  echo "WARN: diretório de libs de API não encontrado"
```

---

## FASE 2 — Build TypeScript

```bash
cd $PROJECT_DIR/apps
npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -5
npx tsc --noEmit 2>&1 | head -60
```

**ZERO erros de TypeScript são tolerados.** Erros comuns e fix:

- `Property 'X' does not exist on type 'Y'` → campo com nome errado no type (ex: `stockLevel` vs `stock`)
- `useSearchParams() should be wrapped in a suspense boundary` → adicionar `<Suspense>` ao redor
- `dialog slotProps.paper` → deve ser `PaperProps` em MUI Dialog
- `axios.isCancel()` narrowing para `never` → mover cast para depois do bloco isCancel
- Interface com prop conflitante em AxiosRequestConfig → adicionar ao `Omit<>`
- `err: ValidationIssue[]` recebendo `unknown` → trocar para `err: unknown`

---

## FASE 3 — Infraestrutura

```bash
cd $PROJECT_DIR/project
docker compose up -d
sleep 15
docker compose ps
docker compose logs --tail=50
```

Se build falhar: ler log → identificar módulo com erro → corrigir → `docker compose build` → `up -d`.

---

## FASE 4 — Auto-descoberta do escopo

### 4.1 — Descobrir todas as páginas (rotas de tela)

```bash
# Next.js App Router
find $PROJECT_DIR/apps/src/app -name "page.tsx" -o -name "page.ts" 2>/dev/null \
  | sed "s|$PROJECT_DIR/apps/src/app||;s|/page\.tsx\?$||;s|^\.$|/|" \
  | sort

# Next.js Pages Router
find $PROJECT_DIR/apps/pages -name "*.tsx" -not -name "_*" 2>/dev/null \
  | sed "s|$PROJECT_DIR/apps/pages||;s|\.tsx$||" \
  | sort

# React Router (SPA)
grep -rh "path=" $PROJECT_DIR/apps/src/ 2>/dev/null \
  | grep -oE 'path="[^"]+"' | sort -u
```

### 4.2 — Descobrir todos os endpoints chamados nas libs

```bash
# Extrair todos os paths de chamadas HTTP nas libs de API
grep -rh "\.(get\|post\|patch\|put\|delete)\(" \
  $PROJECT_DIR/apps/src/lib/ $PROJECT_DIR/apps/src/api/ 2>/dev/null \
  | grep -oE "('|\")[/a-zA-Z0-9_\-]+('|\")" | sort -u

# Extrair também de hooks e stores
grep -rh "apiClient\.\|axios\.\|fetch(" \
  $PROJECT_DIR/apps/src/ 2>/dev/null \
  | grep -oE "('|\")[/a-zA-Z0-9_\-]+('|\")" | sort -u
```

### 4.3 — Ler o contrato do backend vinculado

```bash
# O contrato do backend vinculado (linked_projects_context) está disponível em:
ls $PROJECT_DIR/project/connect/*/service-manifest.*.json 2>/dev/null | head -5

# Ler o api_contract.md do backend vinculado (se disponível no contexto)
BACKEND_ID=$(cat $PROJECT_DIR/project/connect/*/runtime-passport.json 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); \
    deps=[dep['pathOrTarget'] for dep in d.get('dependencies',{}).get('services',[]) if dep.get('critical')]; \
    print(deps[0] if deps else '')" 2>/dev/null)

echo "Backend vinculado: $BACKEND_ID"
```

---

## FASE 5 — E2E completo

### 5.1 — Cada página retorna HTTP correto

```bash
PORT=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -iE "porta|port" | grep -oE '[0-9]{4,5}' | head -1)

# Páginas públicas → devem retornar 200
for PAGE in /login /; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT$PAGE")
  echo "$PAGE → HTTP $CODE"
  [ "$CODE" != "200" ] && echo "  FAIL: esperado 200, got $CODE"
done

# Páginas protegidas → devem retornar 200 ou 307/302 (redirect para login)
PAGES=$(find $PROJECT_DIR/apps/src/app -path "*/(protected)*/page.tsx" 2>/dev/null \
  | sed "s|$PROJECT_DIR/apps/src/app/(protected)||;s|/page\.tsx$||" | sort)

for PAGE in $PAGES; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT$PAGE")
  echo "$PAGE → HTTP $CODE"
  [ "$CODE" != "200" ] && [ "$CODE" != "307" ] && [ "$CODE" != "302" ] && \
    echo "  FAIL: esperado 200/307/302, got $CODE"
done
```

### 5.2 — Cada endpoint chamado existe no backend

Para cada endpoint descoberto na FASE 4.2:

```bash
BACKEND_URL=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -iE "backend.*url|api.*url|NEXT_PUBLIC_API" \
  | grep -oE 'https?://[^"]+' | head -1)
[ -z "$BACKEND_URL" ] && BACKEND_URL="http://localhost:$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -iE 'backend.*port|api.*port' | grep -oE '[0-9]{4,5}' | head -1)"

TOKEN=$(curl -s -X POST "$BACKEND_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$(grep -iE 'email|usuario' $PROJECT_DIR/project/RUNBOOK.md | grep '@' | grep -oE '[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}' | head -1)\",\"password\":\"$(grep -iE 'senha|password' $PROJECT_DIR/project/RUNBOOK.md | grep -oE '[A-Za-z0-9@#$%!_\-\.]{6,}' | head -1)\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('accessToken','FAIL'))")

# Testar cada endpoint
for ENDPOINT in $ENDPOINTS; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "$BACKEND_URL$ENDPOINT")
  echo "$ENDPOINT → HTTP $CODE"
  [ "$CODE" = "404" ] && echo "  BUG: endpoint não existe no backend → corrigir path na lib"
  [ "$CODE" = "500" ] && echo "  BUG: erro interno no backend ao chamar $ENDPOINT"
done
```

### 5.3 — Contratos respeitados: campos do backend batem com os tipos do frontend

```bash
# Verificar que toProduct() tem fallback para ambos os shapes
grep -n "price\|salePrice\|stockLevel\|stockQuantity\|minStock" \
  $PROJECT_DIR/apps/src/lib/*.ts $PROJECT_DIR/apps/src/types/*.ts 2>/dev/null \
  | grep "toProduct\|normalize\|mapProduct" | head -10

# Se só houver UM nome de campo (sem ??) → normalização incompleta
grep -c "??\|??" $PROJECT_DIR/apps/src/lib/*.ts 2>/dev/null | grep "0" && \
  echo "WARN: lib sem fallback ?? — pode quebrar com backends de stack diferente"

# Verificar que roles usam slugs do enum (não PT-BR)
grep -rn "gerente\|vendedor\|administrador" $PROJECT_DIR/apps/src/ 2>/dev/null \
  | grep "roles\|role" | head -5 && echo "BUG B-FE-12: roles em PT-BR"

# Verificar AppShell com xs:0
grep -n "ml:" $PROJECT_DIR/apps/src/components/layout/AppShell.tsx 2>/dev/null \
  | grep -v "xs" && echo "WARN B-FE-13: margin-left sem xs:0 explícito"

# Verificar escapes unicode literais
grep -rl "\\\\u[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]" \
  $PROJECT_DIR/apps/src/ 2>/dev/null | head -5 && echo "BUG B-FE-14: escapes \\uXXXX literais"
```

### 5.4 — Testar o fluxo E2E completo (integrado)

Se o frontend consome um backend (linked project), testar o fluxo completo:

```bash
echo "=== FLUXO E2E ==="

# 1. Login via backend
echo "1. Login..."
TOKEN=$(curl -s -X POST "$BACKEND_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"<SEED_EMAIL>","password":"<SEED_PASS>"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('accessToken','FAIL'))")
[ "$TOKEN" = "FAIL" ] && echo "  FAIL: login" || echo "  PASS: token obtido"

# 2. /users/me
echo "2. /users/me..."
ME=$(curl -s -H "Authorization: Bearer $TOKEN" "$BACKEND_URL/api/users/me" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('email','FAIL'))")
[ "$ME" = "FAIL" ] && echo "  FAIL: /users/me" || echo "  PASS: $ME"

# 3. Listagem principal (primeiro recurso do contrato)
echo "3. Listagem principal..."
MAIN_ROUTE=$(grep "^| GET" $PROJECT_DIR/project/api_contract.md 2>/dev/null | head -1 | awk '{print $4}')
[ -n "$MAIN_ROUTE" ] && \
  curl -s -H "Authorization: Bearer $TOKEN" "$BACKEND_URL$MAIN_ROUTE?limit=3" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); \
    items=d.get('data',[]); \
    print('  PASS: ' + str(len(items)) + ' items | meta: ' + str(bool(d.get('meta'))))" \
  || echo "  SKIP: contrato sem rota GET"

# 4. Página protegida carrega
echo "4. Página protegida..."
FIRST_PROTECTED=$(find $PROJECT_DIR/apps/src/app -path "*/(protected)*" -name "page.tsx" 2>/dev/null | head -1 \
  | sed "s|$PROJECT_DIR/apps/src/app/(protected)||;s|/page\.tsx$||")
[ -n "$FIRST_PROTECTED" ] && \
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT$FIRST_PROTECTED") && \
  echo "  $FIRST_PROTECTED → HTTP $CODE" || echo "  SKIP: sem páginas protegidas"
```

---

## FASE 6 — Validação de contratos

```bash
# Frontend consome backend? Verificar contrato vinculado
cat $PROJECT_DIR/project/full-test-prompt.md 2>/dev/null | grep -i "contrato\|contract\|linked" | head -5

# Cada endpoint chamado nas libs deve existir no api_contract.md do backend
for ENDPOINT in $ENDPOINTS; do
  grep -q "$ENDPOINT" $PROJECT_DIR/project/api_contract.md 2>/dev/null || \
    echo "CONTRATO VIOLADO: $ENDPOINT não está no api_contract.md do backend"
done
```

---

## Checklist obrigatório de bugs Frontend (verificar e corrigir)

| # | Check | Detecção | Fix |
|---|-------|---------|-----|
| B-FE-01 | Paths com `/api/` duplicado | `grep "'/api/" apps/src/lib/` | Remover prefixo (client já adiciona) |
| B-FE-02 | Login com campo `username` | `grep "username" apps/src/` | Trocar por `email` |
| B-FE-03 | Token lido de `response.token` | `grep "\.token" apps/src/lib/auth` | Usar `response.data.accessToken` |
| B-FE-04 | `user.name` sem fallback | `grep "user\.name" apps/src/` | `user.name ?? user.email.split('@')[0]` |
| B-FE-05 | Rota inexistente no contrato | loop sobre endpoints vs contrato | Corrigir path ou adicionar ao backend |
| B-FE-06 | `.data` não desempacotado | `grep "res\." apps/src/lib/` | `getApiData(res)` em vez de `res.data` |
| B-FE-07 | `globals.css` faltando | `ls apps/src/app/globals.css` | Criar com conteúdo mínimo |
| B-FE-08 | `toProduct()` sem fallback `??` | `grep "??" apps/src/lib/*.ts` | Normalizar ambos os shapes |
| B-FE-09 | `getSale()` espera shape aninhado | `grep "\.sale\." apps/src/lib/` | Consumir shape flat |
| B-FE-10 | Slugs PT-BR em select values | `grep "saida\|ajuste_negativo" apps/src/` | Usar `in/out/adjustment/return` |
| B-FE-11 | Campo form ≠ campo payload | `grep "reason\|motivo" apps/src/lib/` | Mapear explicitamente no toPayload |
| B-FE-12 | Roles em PT-BR | `grep "gerente\|vendedor" apps/src/` | Usar slugs do `UserRole` |
| B-FE-13 | AppShell sem `xs:0` | `grep "ml:" apps/src/components/layout/` | `ml: { xs: 0, md: SIDEBAR_W }` |
| B-FE-14 | Escapes `\uXXXX` literais | `grep -rl "\\\\u[0-9a-fA-F]{4}" apps/src/` | Script Python de decode |

**Fix automático para B-FE-14:**
```python
import re, glob
for f in glob.glob('apps/src/**/*.ts*', recursive=True):
    t = open(f).read()
    n = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1),16)), t)
    if n != t: open(f,'w').write(n); print('fixed:', f)
```

---

## Critério de PASS Frontend

- [ ] `tsc --noEmit` sem erros
- [ ] Container sobe sem erro de build
- [ ] Todas as páginas retornam 200 ou redirect de auth esperado (307/302)
- [ ] Todos os endpoints chamados nas libs existem no backend e retornam 2xx
- [ ] Fluxo E2E completo: login → dados reais → página protegida carrega
- [ ] `toProduct()` e demais normalizers aceitam o shape real do backend
- [ ] Roles em guards usam slugs exatos do `UserRole`
- [ ] `grep -rl "\\\\u[0-9a-fA-F]{4}" apps/src/` retorna vazio
- [ ] Sem card "Offline", "Serviço indisponível" ou tela branca nos checks de página
