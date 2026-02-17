# Secrets e variáveis de ambiente — Zentriz Genesis

> Onde e como guardar chaves (ex.: Claude API) e listagem completa das variáveis de ambiente iniciais.

---

## Regra de ouro

**Nunca commitar segredos no repositório.** Use variáveis de ambiente e arquivos ignorados pelo Git. O arquivo `.env` está no [.gitignore](../.gitignore).

---

## Lista completa de variáveis (item 0)

| Variável | Obrigatório | Propósito | Exemplo / default |
|----------|-------------|-----------|-------------------|
| **CLAUDE_API_KEY** | Sim (para agentes) | Chave da API Anthropic; usada pelos agentes (CTO, PM, QA, DevOps, Monitor) para chamadas ao LLM. | (obter em console.anthropic.com) |
| **CLAUDE_MODEL** | Não | Modelo Claude a usar. | `claude-3-5-sonnet-20241022` |
| **ANTHROPIC_API_URL** | Não | URL base da API Anthropic (override; default da SDK). | (deixar vazio para default) |
| **DOCKER_NAMESPACE** | Não | Namespace do projeto para Docker e k8s (containers, redes, volumes). | `zentriz-genesis` |
| **API_BASE_URL** | Não (local) | URL base da API do produto (Voucher) para smoke tests e integrações. | `http://localhost:3000` |
| **LOG_LEVEL** | Não | Nível de log do runtime dos agentes (Python). | `INFO` |
| **REQUEST_TIMEOUT** | Não | Timeout em segundos para chamadas à API Claude. | `120` |

Template: [.env.example](../.env.example). Copie para `.env` e preencha os valores.

---

## Local (desenvolvimento)

| O quê | Onde |
|------|------|
| Chave **Claude API** e demais segredos | Variáveis no arquivo **`.env`** na raiz do projeto |
| Configurações não sensíveis | Mesmo `.env` ou valores default no código |

**Passos:**

1. Copie o template: `cp .env.example .env`
2. Edite `.env` e preencha pelo menos `CLAUDE_API_KEY` (e outras variáveis conforme necessidade).
3. O arquivo `.env` **não** será commitado.

---

## Em cloud (staging / produção)

- Usar **secrets manager** do provedor (AWS Secrets Manager, Parameter Store, Azure Key Vault, GCP Secret Manager).
- Injetar no runtime como **variáveis de ambiente** (ex.: Kubernetes Secrets, Lambda/Cloud Run env).
- Nunca colocar chaves em código ou em repositório.

---

## Resumo

| Ambiente | Onde guardar |
|----------|--------------|
| **Local** | Arquivo `.env` (gitignored); variáveis conforme tabela acima |
| **Cloud** | Secrets manager do provedor → env vars no runtime |

Ver também: [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) (seção 13).
