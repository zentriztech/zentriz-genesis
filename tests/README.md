# Testes avulsos

Pasta para testes manuais e scripts de verificação (Python, Node, shell, etc.), fora da suíte de testes automatizados do projeto.

## Estrutura

- **python/** — Scripts e testes em Python (ex.: conexão com Claude, APIs).
- *(futuro)* **node/** — Scripts em Node/TypeScript.
- *(futuro)* Outros conforme necessidade.

## Como rodar

- Execute a partir da **raiz do repositório** (ou ajuste caminhos/`.env` conforme o script).
- Variáveis de ambiente: use o `.env` da raiz; muitos scripts carregam automaticamente.

## Python

Requisitos: `anthropic`, `python-dotenv` (ou env já definido).

```bash
cd /caminho/para/zentriz-genesis
pip install -r tests/python/requirements.txt   # ou: pip install anthropic python-dotenv
python tests/python/test_claude_connection.py
```

- **test_claude_connection.py** — Verifica conectividade com a API Claude: carrega `CLAUDE_API_KEY` do `.env` da raiz, envia um prompt simples e exibe a resposta. Útil para validar chave e rede (incl. dentro de Docker).
