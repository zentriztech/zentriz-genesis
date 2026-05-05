# RUNBOOK BOT — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Automação / Bots**:
`bot_chat`, `bot_scraper`, `bot_automation`, `integration`

---

## FASE 1 — Artefatos obrigatórios

- [ ] Entry point claro (`index.ts`, `bot.ts`, `main.py`)
- [ ] `docker-compose.yml` presente (se serviço persistente)
- [ ] `.env.example` com variáveis necessárias documentadas
- [ ] Para bots de chat: token de bot em variável de ambiente (nunca hardcoded)
- [ ] Para scrapers: URL alvo configurável via env, não hardcoded

## FASE 1.1 — Segurança obrigatória

```bash
# Verificar que não há tokens hardcoded
grep -rE "(token|secret|key|password)\s*=\s*['\"][^$'\"{]+" $PROJECT_DIR/src/ \
  | grep -v "node_modules\|\.git\|test\|spec\|example" | head -10
```

Se encontrar credencial hardcoded: mover para variável de ambiente — BLOCKER.

## FASE 2 — Infraestrutura

```bash
cd $PROJECT_DIR && docker compose up -d
sleep 10
docker compose logs --tail=30
```

Para bots de chat: o bot vai tentar conectar ao servidor externo (Telegram/Discord). Se token não estiver no `.env`, container vai logar erro de conexão — isso é esperado e não é FAIL se o código está correto.

## FASE 3 — Smoke test Bot

**Integração (connector/integration):**
```bash
PORT=$(cat $PROJECT_DIR/project/RUNBOOK.md | grep -i "porta\|port" | grep -oE '[0-9]{4,5}' | head -1)
curl -sf http://localhost:$PORT/health
curl -sf http://localhost:$PORT/api/status
```

**Scraper:** testar com URL de exemplo segura (não produção):
```bash
# Se tiver endpoint de teste
curl -sf -X POST http://localhost:$PORT/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

## Bugs críticos

- [ ] **B-BOT-01**: Token hardcoded no código → mover para env
- [ ] **B-BOT-02**: Bot sem tratamento de erro em webhook → crash ao receber payload malformado
- [ ] **B-BOT-03**: Rate limiting ausente em scraper → pode ser bloqueado pelo alvo
- [ ] **B-BOT-04**: `integration` sem retry em falha de API externa → perda silenciosa de dados

## Critério PASS Bot

- [ ] Sem credencial hardcoded
- [ ] Container sobe sem crash (erro de conexão a serviço externo é OK se token não configurado)
- [ ] Health endpoint responde (se presente)
- [ ] Código de tratamento de erro presente nos handlers principais
