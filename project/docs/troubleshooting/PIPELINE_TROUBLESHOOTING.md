# Pipeline: quando "não acontece nada"

> Checklist e onde ver logs quando o usuário clica em **Iniciar pipeline** e nada parece acontecer.

---

## 1. Fluxo esperado (Pipeline V2)

1. Usuário acessa **Enviar spec** (/spec), envia um arquivo .md (e opcionalmente título).
2. A API cria o projeto e grava o arquivo em `UPLOAD_DIR/<project_id>/` e insere em `project_spec_files`.
3. Usuário é redirecionado para **Meus projetos** → projeto → clica em **Iniciar pipeline**.
4. Frontend chama `POST /api/projects/:id/run`.
5. API valida acesso, status e existência de spec .md; chama o **runner** (RUNNER_SERVICE_URL ou RUNNER_COMMAND).
6. Runner inicia o subprocess e executa **fluxo V2**: CTO spec review → loop CTO↔Engineer (max 3) → PM → seed tasks → Monitor Loop (Dev/QA/DevOps); responde 202.
7. API atualiza o projeto para `status=running` e retorna 202 ao frontend.
8. O portal faz polling do projeto e do diálogo; o runner grava passos no diálogo via API.

Se algo falha em 4–7, o frontend mostra a mensagem de erro da API em vermelho. Se 7 retorna 202 mas o runner não grava diálogo, o status fica "running" e a tela não avança. Ver [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](../plans/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md).

---

## 2. Cenários comuns e onde olhar

| Sintoma | Possível causa | Onde ver |
|--------|----------------|----------|
| Botão **Iniciar pipeline** não aparece | Status do projeto não permite run (ex.: já `running` ou `accepted`). | Na tela do projeto: qual é o **status** exibido? Deve ser um de: draft, spec_submitted, pending_conversion, cto_charter, pm_backlog, stopped, failed. |
| Erro no portal: "Adicione uma spec em Markdown ao projeto" | Nenhum arquivo .md associado ao projeto em `project_spec_files`. | Projeto criado sem passar por **Enviar spec**? Ou spec enviada em outro formato (.doc, .pdf)? Só .md é considerado para o run. |
| Erro no portal: "Pipeline não pode ser iniciado com status X" | Status atual não está em `ALLOWED_STATUS_FOR_RUN`. | Ver status na tela. Se for `running`, aguardar ou usar **Parar** antes de **Reiniciar**. |
| Erro no portal: "Nenhum runner configurado" | API sem `RUNNER_SERVICE_URL` nem `RUNNER_COMMAND`. | No container da API: `RUNNER_SERVICE_URL` (ex.: `http://runner:8001`) deve estar definido. Ver `docker compose logs api` e variáveis. |
| Erro no portal: "Falha ao chamar serviço runner" ou mensagem do runner | Runner não respondeu 2xx ou arquivo de spec não existe no container do runner. | **Logs da API:** `docker compose logs api --tail=100`. **Logs do runner:** `docker compose logs runner --tail=100`. Se o runner retornar 400 por "Arquivo de spec não encontrado", API e runner não compartilham o mesmo volume de uploads. |
| Retorna 202 "Pipeline iniciado" mas nada aparece no diálogo | Runner iniciou o processo mas o processo caiu (ex.: spec não encontrada, erro de import, env faltando). | **Logs do runner (stderr do subprocess):** `docker compose logs runner --tail=200`. Procurar por `FileNotFoundError`, `ModuleNotFoundError`, `CLAUDE_API_KEY`, `PROJECT_ID`, etc. |
| Erro no portal: **"timed out"** ou **"O agente demorou mais que o limite (timeout)"** | O runner cortou a conexão HTTP com o serviço de agentes antes do agente terminar (ex.: CTO com 2 repairs = 3 chamadas LLM). | Defina **`REQUEST_TIMEOUT=300`** no `.env` do runner (e recrie o container). O runner faz até 2 retentativas em timeout; se ainda falhar, o agente pode estar lento — verifique `docker compose logs runner` e o terminal do `start-agents-host.sh`. |

---

## 3. Logs em tempo real (Docker)

```bash
# API — requisições e erros do pipeline
docker compose logs api -f --tail=50

# Runner — serviço HTTP e stderr do processo do pipeline
docker compose logs runner -f --tail=100

# Todos os serviços
docker compose logs -f --tail=30
```

Após clicar em **Iniciar pipeline**, na API deve aparecer algo como:

- `[Pipeline] POST /run recebido` (projectId)
- `[Pipeline] Spec encontrada, disparando runner`
- `[Pipeline] Chamando runner service`
- `[Pipeline] Runner iniciado com sucesso (202)` **ou** `[Pipeline] Runner retornou erro` / `[Pipeline] Falha ao chamar runner`

No runner:

- `[Runner] POST /run projectId=... specPath=...`
- `Runner iniciado em background pid=... projectId=...` **ou** erro 400 (spec não encontrada)

Se o subprocess do runner cair logo após iniciar, o traceback sai em `docker compose logs runner`.

---

## 4. "Reiniciar" / "Iniciar" sem movimentação

Se você clicou em **Reiniciar do início** ou **Iniciar pipeline** e não vê mudança:

1. **Erro em vermelho ou no Alert**  
   Se aparecer mensagem de erro (ex.: "Adicione uma spec em Markdown", "Falha ao chamar serviço runner"), a requisição falhou. Corrija o que a mensagem indicar.

2. **Status mudou para "Em execução" mas o log não aparece**  
   A API retornou 202 e o projeto ficou `running`, mas o processo do runner pode ter caído ao iniciar. Verifique:
   - `docker compose logs runner --tail=150` — procure por `FileNotFoundError`, `ModuleNotFoundError`, traceback do Python.
   - O runner precisa do **arquivo de spec** no path que a API enviou (volume `zentriz-genesis_uploads:/shared/uploads` no runner). Se o path estiver errado, o runner_server devolve 400 e a API devolve 500 (e o portal mostra o erro).

3. **Nada mudou (continua "Reiniciar" / status antigo)**  
   Pode ser falha na requisição (rede, CORS, 401) ou o refetch do projeto falhou. Abra o DevTools (F12) → Aba **Rede**, clique de novo em Reiniciar e veja:
   - `POST .../api/projects/.../run` → status **202** = sucesso; a partir daí o frontend atualiza o status para "running" mesmo que o GET do projeto falhe.
   - Se for **400/404/409/500/503**, a resposta (Preview) traz a mensagem que o portal deve exibir.

4. **Agentes no host**  
   Se você usa `./start-agents-host.sh`, o **agents** não deve estar rodando no Docker (use `./deploy-docker.sh --host-agents`). O runner (no Docker) chama os agentes em `http://host.docker.internal:8000`. Confirme que o script no host está rodando e que não há outro processo na porta 8000.

---

## 5. Projeto específico (ex.: 62c90c3f-53fa-4500-9026-762db08f8360)

Para um `project_id` determinado:

1. **Spec existe?** Na API (ou no banco): existe linha em `project_spec_files` com `project_id` e `filename` terminando em `.md`? O `file_path` deve ser um path que o **container do runner** consiga ler (ex.: `/shared/uploads/<project_id>/<arquivo>.md`).
2. **Status do projeto:** `SELECT id, status, started_at FROM projects WHERE id = '62c90c3f-53fa-4500-9026-762db08f8360';`
3. **Volume de uploads:** API e runner precisam do mesmo volume (ex.: `zentriz-genesis_uploads:/shared/uploads`). O `file_path` gravado pela API é relativo a `UPLOAD_DIR`; no Docker, `UPLOAD_DIR=/shared/uploads`.
4. Rodar os logs acima e clicar de novo em **Iniciar pipeline** para ver em tempo real as mensagens `[Pipeline]` e `[Runner]`.

---

## 6. Artefatos e Monitor/DevOps

### 6.1 Arquivos .md com conteúdo JSON (corrigido)

**Sintoma:** Em `PROJECT_FILES_ROOT/<project_id>/docs/` os arquivos (engineer_proposal.md, cto_charter.md, etc.) contêm um trecho JSON (request_id, agent, status, summary) em vez de texto legível.

**Causa:** A LLM às vezes devolve no campo `summary` do response_envelope um JSON (o envelope inteiro serializado). O runner gravava esse valor direto no .md.

**Correção:** O runner passou a usar `_content_for_doc(response)`: extrai o texto do `summary`; se o conteúdo for JSON, faz parse e usa o campo `summary` interno. Os .md passam a receber apenas o texto legível.

### 6.2 DevOps acionado após QA rejeitar 3 vezes (corrigido)

**Sintoma:** O QA rejeitou a tarefa 3 vezes (QA_FAIL, reatempto 1/3, 2/3, 3/3). A tarefa foi marcada DONE por "máximo de reworks atingido", mas o Monitor acionou o DevOps para provisionamento.

**Causa:** A condição para chamar DevOps era apenas "todas as tasks estão DONE". Não havia distinção entre "DONE por aprovação do QA" e "DONE por limite de reworks".

**Correção:** O Monitor mantém o conjunto `tasks_done_after_qa_fail` (task_ids marcadas DONE após atingir MAX_QA_REWORK). Só aciona DevOps quando todas as tasks estão DONE **e** nenhuma está nesse conjunto. Caso contrário, publica no diálogo: "Monitor: uma ou mais tarefas não foram aprovadas pelo QA após o máximo de reworks. DevOps não será acionado. Revise o projeto ou aceite o estado atual no portal."

---

## 7. Referências

- Variáveis de ambiente (runner, API, agents): [SECRETS_AND_ENV.md](../SECRETS_AND_ENV.md)
- Fluxo dos agentes e LLM: [AGENTS_AND_LLM_FLOW.md](../AGENTS_AND_LLM_FLOW.md)
- API pipeline: `applications/services/api-node/src/routes/pipeline.ts`
- Runner service: `applications/orchestrator/runner_server.py`
