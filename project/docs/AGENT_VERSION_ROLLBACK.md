# Agent Version Rollback — Runbook

## Visão Geral

Os SYSTEM_PROMPTs dos agentes (CTO, Engineer, PM, Dev, QA, DevOps, Monitor) são arquivos `.md` versionados no repositório Git em `applications/agents/`. O runner lê esses arquivos em tempo de execução via `_agents_root()`.

Para fazer rollback de uma versão problemática de agente **sem reiniciar o serviço**, use `SYSTEM_PROMPTS_OVERRIDE_DIR`.

---

## Como Criar uma Versão Pinada

```bash
# 1. Copie os agents/ atuais para um diretório versionado
cp -r applications/agents/ /pinned-prompts/agents-v$(date +%Y%m%d)/

# Ou a partir de um commit específico:
git show <commit>:applications/agents/cto/SYSTEM_PROMPT.md > /pinned-prompts/agents-v1.2.0/cto/SYSTEM_PROMPT.md
```

---

## Como Ativar Rollback

### Opção 1 — Variável de ambiente no .env

```bash
# .env (ou docker-compose override)
SYSTEM_PROMPTS_OVERRIDE_DIR=/pinned-prompts/agents-v1.2.0
```

O runner usa este diretório para TODOS os agentes. Se o diretório não existir, cai silenciosamente para o padrão.

### Opção 2 — Rollback via git

```bash
# Reverter apenas o prompt do CTO para o commit anterior
git checkout <commit-hash> -- applications/agents/cto/SYSTEM_PROMPT.md
git commit -m "fix(agents): rollback CTO prompt para v<commit>"
# Reiniciar runner para usar o novo prompt
docker compose restart runner
```

---

## Rollback Parcial (um agente específico)

Para reverter apenas um agente (ex.: QA Web regrediu), use git:

```bash
git log --oneline -- applications/agents/qa/web/react/SYSTEM_PROMPT.md
git show <commit>:applications/agents/qa/web/react/SYSTEM_PROMPT.md > /tmp/qa-web-v1.md
diff /tmp/qa-web-v1.md applications/agents/qa/web/react/SYSTEM_PROMPT.md
git checkout <commit> -- applications/agents/qa/web/react/SYSTEM_PROMPT.md
git commit -m "fix(agents): rollback QA Web prompt"
```

---

## Verificar Qual Versão Está Ativa

```bash
# No runner em execução:
docker compose exec runner env | grep SYSTEM_PROMPTS_OVERRIDE_DIR
# Se vazio → usando agents/ do repositório atual (default)

# Ver hash do commit dos prompts:
git log --oneline -5 -- applications/agents/
```

---

## Histórico de Versões dos Prompts

| Data | Agente | Commit | Mudança |
|------|--------|--------|---------|
| 2026-04-24 | CTO | `1f0484f` | Adicionada seção Design Tokens (G07) |
| 2026-04-24 | PM Web | `98ee7cc` | Fast-track mode para landing pages (G08) |
| 2026-04-24 | Dev Backend Node.js | `05362b3` | SYSTEM_PROMPT completo (G09) |
| 2026-04-24 | QA Web | `3534134` | Checklist visual 30 itens (G10) |
| 2026-04-24 | QA Backend | `a1312aa` | Checklist segurança + API contracts (G11) |
| 2026-04-24 | DevOps Docker | `cddd08f` | Gate: always install deps before start (G01) |

---

## Alertas

- `SYSTEM_PROMPTS_OVERRIDE_DIR` afeta **todos** os projetos no mesmo runner.
- Para rollback de um único projeto, a opção git é preferível.
- Sempre testar rollback em staging antes de aplicar em produção.
