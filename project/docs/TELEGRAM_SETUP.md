# Telegram Bot — Setup e Operação

> FT-09 | Bot: @zgenezis_bot | Implementado em 2026-05-05

---

## Pré-requisitos

- Domínio com HTTPS (já disponível em `https://genesis.zentriz.com.br`)
- `TELEGRAM_BOT_TOKEN` obtido via @BotFather
- Gerar `TELEGRAM_WEBHOOK_SECRET` e `TELEGRAM_WEBHOOK_PATH`

---

## 1. Gerar variáveis de ambiente

```bash
# Webhook secret (valida que requests vêm do Telegram)
python3 -c "import uuid; print(uuid.uuid4())"

# Webhook path (URL não-previsível)
python3 -c "import uuid; print('wh/' + str(uuid.uuid4()))"
```

Adicionar ao `.env` da EC2 (`/opt/zentriz-genesis/.env`):

```env
TELEGRAM_BOT_TOKEN=<token do BotFather>
TELEGRAM_WEBHOOK_SECRET=<uuid gerado acima>
TELEGRAM_WEBHOOK_PATH=wh/<uuid gerado acima>
```

---

## 2. Registrar webhook no Telegram

Após subir a API com as variáveis configuradas, executar **uma vez**:

```bash
BOT_TOKEN="<seu token>"
WEBHOOK_SECRET="<seu secret>"
WEBHOOK_PATH="wh/<seu path uuid>"
DOMAIN="https://genesis.zentriz.com.br"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${DOMAIN}/api/telegram/${WEBHOOK_PATH}\",
    \"secret_token\": \"${WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\"],
    \"drop_pending_updates\": true
  }" | python3 -m json.tool
```

Resposta esperada:
```json
{ "ok": true, "result": true, "description": "Webhook was set" }
```

---

## 3. Verificar webhook ativo

```bash
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool
```

Verificar que `url` aponta para o domínio correto e `pending_update_count` é 0.

---

## 4. Deploy na EC2

```bash
# SSH na EC2
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113

# Editar .env
nano /opt/zentriz-genesis/.env
# Adicionar: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_WEBHOOK_PATH

# Rebuild e restart da API
cd /opt/zentriz-genesis
docker compose up -d --build api

# Verificar logs
docker compose logs api --tail=50 -f
```

---

## 5. Testar vinculação

1. Acessar o portal Genesis → **Configurações → Telegram**
2. Clicar em **Vincular Telegram**
3. Copiar o comando `/start XXXXXX`
4. Enviar o comando para `@zgenezis_bot` no Telegram
5. Confirmar mensagem de sucesso no bot
6. Portal deve detectar vinculação automaticamente (polling 3s)

---

## 6. Comandos disponíveis no bot

| Comando | Descrição |
|---------|-----------|
| `/status` | Lista projetos ativos do tenant |
| `/tasks <id>` | Tasks pendentes de um projeto |
| `/log <id>` | Últimas 10 mensagens do pipeline |
| `/stop <id>` | Interrompe pipeline (requer confirmação 4 dígitos) |
| `/accept <id>` | Aceita projeto finalizado (requer confirmação) |
| `/reject <id>` | Rejeita projeto (requer confirmação) |
| `/unlink` | Remove vinculação do chat |
| `/help` | Lista de comandos |

> Usar os primeiros 8 caracteres do UUID do projeto como `<id>`.

---

## 7. Eventos que disparam notificação push

| Evento | Mensagem |
|--------|----------|
| Pipeline concluído | `✅ Projeto aceito: <título>` |
| Projeto rejeitado | `❌ Projeto rejeitado: <título>` |
| Task BLOCKED | `⚠️ <título da notificação>` |
| Alerta de sistema | `🚨 <título da notificação>` |

---

## 8. Segurança

- Webhook protegido por `X-Telegram-Bot-Api-Secret-Token` — requests sem o header são rejeitados com 401
- Comandos destrutivos (`/stop`, `/accept`, `/reject`) exigem confirmação com código de 4 dígitos válido por 60s
- 3 tentativas incorretas → bloqueio do chat_id por 1 hora
- Rate limiting: 10 comandos/minuto por chat_id
- Ações executadas com token JWT de curta duração (2 min) do usuário vinculado — tenant isolation automático
- Nenhum dado sensível (código-fonte, tokens, env vars) é enviado para o Telegram

---

## 9. Remover webhook (se necessário)

```bash
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook" | python3 -m json.tool
```
