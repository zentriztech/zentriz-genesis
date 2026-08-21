> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Canva Connect (OAuth2 + PKCE) — Registro do App e Ativação no Genesis

Runbook para registrar o **app OAuth do Canva** no Developer Portal da Zentriz e ativar a
conexão "1 clique" nas **Ferramentas UI/UX** do Genesis (Item 3). Enquanto o app não estiver
configurado, o portal continua funcionando no modo _fallback_ (colar um access token manual);
com o app configurado, o tenant conecta o Canva sem manipular tokens à mão.

---

## 1. Como o fluxo funciona (visão do código)

1. O usuário (tenant_admin/zentriz_admin) abre **Ferramentas UI/UX → Conectar → aba Canva**.
2. O front consulta `GET /api/tenant/uiux-connections/canva/config`; se `{configured:true}`,
   mostra o botão **"Conectar com Canva"** em vez do campo de token manual.
3. Ao clicar, o front chama `GET /api/tenant/uiux-connections/canva/authorize` → o backend gera
   um par **PKCE** + um `state` de uso único (tabela `canva_oauth_states`, TTL 10 min) e devolve a
   `authorizeUrl`. O browser é redirecionado ao Canva.
4. Após o consent, o Canva redireciona para o **callback público**
   `GET /api/tenant/uiux-connections/canva/callback?code=…&state=…`. O backend valida/consome o
   `state` (atômico), troca o `code` por tokens (Authorization Code + PKCE, client confidencial via
   HTTP Basic), resolve o `account_ref` e cria a conexão com credenciais **cifradas em AES-256-GCM**.
5. O browser volta a `/settings/ui-ux?canva=connected` (ou `?canva=error&reason=…`).
6. Nas extrações e listagens, `ensureFreshUiuxCreds` renova o access token via `refresh_token`
   automaticamente (skew de 60 s) e persiste o novo token cifrado.

> **Limitação conhecida (macro, não micro):** a Connect API do Canva **não** expõe a árvore de
> elementos de um design (ao contrário do Figma). A extração gera o nível **macro** disponível
> (título, nº de páginas, dimensões, links). Está documentado no `renderCanvaSpecMarkdown`.

---

## 2. Registro do app no Canva Developer Portal

1. Acesse **https://www.canva.com/developers/** com a conta Canva da Zentriz e crie uma
   **Integration** do tipo _Public_ (ou _Private_ se for uso interno restrito).
2. Em **OAuth / Redirect URLs**, cadastre **exatamente** o redirect URI que o Genesis usa
   (ver §3). Qualquer divergência (barra final, http×https, host) faz o Canva rejeitar o callback.
3. Em **Scopes**, habilite (mesmo conjunto do `CANVA_SCOPES`):
   - `design:meta:read`
   - `design:content:read`
   - `folder:read`
   - `asset:read`
   - `profile:read`
4. Copie o **Client ID** e gere o **Client Secret** (guarde o secret com segurança — só aparece 1×).
5. Publique/ative a integração conforme exigência do Canva (algumas exigem review para _public_).

---

## 3. Redirect URI

O Genesis deriva o redirect URI de `GENESIS_PUBLIC_URL` quando `CANVA_REDIRECT_URI` está vazio:

```
${GENESIS_PUBLIC_URL}/api/tenant/uiux-connections/canva/callback
```

Em produção (`GENESIS_PUBLIC_URL=https://genesis.zentriz.com.br`), o valor a cadastrar é:

```
https://genesis.zentriz.com.br/api/tenant/uiux-connections/canva/callback
```

Se preferir fixar explicitamente, defina `CANVA_REDIRECT_URI` com esse mesmo valor. **Precisa ser
HTTPS público** — o Canva não aceita `localhost`/`http` para apps públicos.

---

## 4. Variáveis de ambiente (api-node)

Adicione ao `.env` (não commitar; ver `.env.example`):

| Variável | Obrigatória | Descrição |
|----------|:----------:|-----------|
| `CANVA_CLIENT_ID` | sim | Client ID do app OAuth |
| `CANVA_CLIENT_SECRET` | sim | Client Secret — **sensível**, nunca logar/commitar |
| `CANVA_REDIRECT_URI` | recomendada | redirect URI exato; se vazio, deriva de `GENESIS_PUBLIC_URL` |
| `GENESIS_PUBLIC_URL` | sim (se sem `CANVA_REDIRECT_URI`) | base pública https do portal |
| `CREDENTIALS_ENCRYPTION_KEY` | sim (prod) | chave AES-256-GCM (64 hex) — já usada por Figma/cloud |
| `CANVA_SCOPES` | não | default = os 5 escopos acima |
| `CANVA_AUTHORIZE_URL` | não | default `https://www.canva.com/api/oauth/authorize` |
| `CANVA_TOKEN_URL` | não | default `https://api.canva.com/rest/v1/oauth/token` |
| `CANVA_POST_AUTH_URL` | não | default `/settings/ui-ux` (retorno do browser) |

Após preencher, **reinicie o serviço api** para carregar as variáveis. Confirme com:

```
curl -s https://genesis.zentriz.com.br/api/tenant/uiux-connections/canva/config
# → {"configured":true}
```

---

## 5. Validação ponta a ponta

1. Portal → **Ferramentas UI/UX → Conectar → Canva**: deve aparecer **"Conectar com Canva"**.
2. Clique → autorize no Canva → volte ao portal com **"Canva conectado com sucesso."**.
3. Novo card Canva na lista; botão **testar credenciais** deve retornar OK.
4. No **form de spec**, selecione a conta Canva + projetos e gere a spec — o arquivo
   `10-uiux-spec.md` (macro) entra no bundle.

## 6. Troubleshooting

| Sintoma (`?canva=error&reason=…`) | Causa provável |
|-----------------------------------|----------------|
| `not_configured` | `CANVA_CLIENT_ID/SECRET` ausentes ou redirect não determinável |
| `invalid_state` / `expired_state` | state já usado ou > 10 min; refaça o fluxo |
| `denied` | usuário cancelou o consent no Canva |
| `exchange_failed` | redirect URI divergente do cadastrado, secret errado ou escopos negados |
| `slot_limit` | tenant já tem 6 conexões UI/UX ativas |
