# Análise do fluxo completo do agente CTO

> Este documento descreve: (1) como o CTO se comunica com a IA (o que enviamos e se há template de retorno); (2) se o CTO recebe da IA no formato ideal; (3) quem grava em disco e onde (`/Users/mac/zentriz-files` ou `PROJECT_FILES_ROOT`). Objetivo: fluxo completo e claro para o agente CTO.

---

## Resumo para leigo

- **O que é:** O “agente CTO” é um fluxo que envia o texto da sua ideia/spec para uma IA (Claude). A IA deve devolver um documento estruturado (PRODUCT_SPEC) em formato combinado (JSON com status, resumo e “artefatos” = arquivos com conteúdo).
- **O que enviamos:** Enviamos o texto da spec **dentro da mensagem** (não como anexo separado) e um **template** que diz à IA como deve ser o documento de saída e em qual formato responder (JSON com artefatos).
- **O que recebemos:** A IA responde com esse JSON. Nosso sistema lê o JSON, valida (conteúdo completo, sem atalhos como “…”) e, se estiver ok, usa os artefatos; se falhar, tenta pedir correção à IA até 2 vezes e, se ainda falhar, devolve **BLOCKED** (bloqueado).
- **Onde grava:** Se estiver configurada a pasta dos projetos (`PROJECT_FILES_ROOT`) e um `project_id`, o runner ou o próprio serviço dos agentes grava os arquivos gerados pelo CTO em disco (ex.: `/Users/mac/zentriz-files/<project_id>/docs/`).

---

## Por que o agente pode não estar “gerando” artefatos?

Em muitos casos a IA **até gera** artefatos, mas o sistema **não os aceita** e devolve status **BLOCKED** (ou FAIL). As causas mais comuns:

| Causa | O que acontece | O que fazer |
|-------|----------------|-------------|
| **1. Conteúdo “muito curto”** | Regra de qualidade exige que cada artefato tenha **pelo menos 100 caracteres** quando status é OK. Se a IA devolver um texto muito curto (ex.: só um título), o sistema rejeita e tenta repair; após 2 tentativas vira BLOCKED. | Reforçar no prompt que o artefato deve ser **documento completo** (todas as seções ## 0–9 do template), não resumo. |
| **2. Reticências ou “…”** | Não é permitido conteúdo com `...` ou `[...]` (abreviações). Se a IA colocar “o resto do documento...” no `content`, a validação falha → repair → BLOCKED. | Já está no PROTOCOL: “NEVER abbreviate content with '...'”. Se continuar, pode relaxar temporariamente a regra em `validate_response_quality` para spec_intake ou dar mais uma rodada de repair. |
| **3. JSON quebrado (aspas no texto)** | O `content` do artefato é um texto dentro do JSON. Se esse texto tiver aspas (`"`) sem escape (`\"`), o JSON fica inválido e o parse pode falhar → resposta vira FAIL com `artifacts: []`. | Já existe parse resiliente que tenta recuperar o `content` mesmo com aspas; se ainda falhar, a IA precisa escapar corretamente (LEI 4 no prompt). |
| **4. IA devolve NEEDS_INFO ou BLOCKED** | A própria IA pode responder “preciso de mais informações” (NEEDS_INFO) ou “não consigo prosseguir” (BLOCKED) **sem** preencher artefatos. Nesse caso o sistema aceita a resposta, mas você recebe status NEEDS_INFO/BLOCKED e lista vazia (ou quase) de artefatos. | Melhorar a spec de entrada (mais contexto, seções claras) ou ajustar o prompt para que, em caso de dúvida, a IA ainda preencha o template com “TBD:” e devolva o artefato. |
| **5. Path errado** | O artefato deve ter `path` começando com `docs/`, `project/` ou `apps/`. Para spec_intake esperamos `docs/spec/PRODUCT_SPEC.md`. Se a IA devolver outro path (ex.: `PRODUCT_SPEC.md`), a validação falha → repair → BLOCKED. | O prompt já exige o path; em último caso conferir se o modo enviado é realmente `spec_intake_and_normalize`. |

**Resumo:** Na prática, “não está gerando artefatos” costuma ser: **(a)** IA gerando conteúdo que **não passa** na nossa validação (curto, com “…”) e aí o sistema devolve BLOCKED; **(b)** IA devolvendo NEEDS_INFO/BLOCKED sem artefatos; ou **(c)** JSON inválido e parse falhando (menos comum após o parse resiliente). Para melhorar: spec de entrada mais completa, prompt reforçando “documento completo sem abreviações”, e (se quiser) relaxar um pouco a regra de “muito curto” ou dar mais uma tentativa de repair para o modo spec_intake.

---

## Por que a IA demora e por que PRODUCT_SPEC.md saiu vazio?

### Lentidão (6–10 min por chamada)

- **Prompt grande:** System = CTO SYSTEM_PROMPT + PROTOCOL_SHARED + **template completo** PRODUCT_SPEC; user = spec inteira. O modelo recebe muitos tokens e gera muitos (max_tokens até 12.000 no spec_intake).
- **Modelo:** Se `CLAUDE_MODEL_SPEC` ou `CLAUDE_MODEL` for um modelo mais pesado (ex.: opus), a latência sobe.
- **Repairs:** Com `MAX_REPAIRS > 0`, cada falha de validação gera uma nova chamada à API (até 2 repairs), somando tempo.
- **Uma única geração longa:** Mesmo sem repair, uma resposta completa em spec_intake pode levar centenas de segundos.

### PRODUCT_SPEC.md só com “...” ou vazio

- A IA **devolveu** o artifact com `"content": "..."` (literalmente três pontos) em vez do documento completo. O sistema **rejeitou** (validação “muito curto” e “reticências”) e marcou status **BLOCKED**, mas **ainda assim gravou** esse conteúdo trivial em disco, gerando um arquivo quase vazio (cabeçalho `<!-- Created by: cto -->` + “...”).
- **Ajuste feito:** O agents **não grava** artefatos cujo conteúdo seja trivial (vazio, “...”, “[...]” ou &lt; 20 caracteres). Assim, quando a IA devolver placeholder, o arquivo PRODUCT_SPEC.md não é criado/sobrescrito com lixo.
- **Causa raiz (truncamento):** O arquivo `raw_response_*.txt` mostrou que a IA **sim** gerou o PRODUCT_SPEC completo no início da resposta; a resposta foi **truncada** (sem `</response>`) por limite de tokens. O parse falhava e devolvia FAIL ou a IA reenviou "..." no repair. **Ajuste no parse (envelope.py):** (1) Se não existir `</response>`, extraímos JSON parcial a partir de `<response>`. (2) No extrator de `"content"`, se a string acabar sem aspa de fecho, retornamos conteúdo parcial. (3) Fechamos o JSON com `}\n  ]\n}` quando o último content vai até o fim. Com isso o envelope e o artifact parcial são recuperados. Para reduzir truncamento: aumentar `CLAUDE_MAX_TOKENS_SPEC_INTAKE` (ex.: 16000).
- Para **avaliar** o que a IA mandou antes do parse: use **resposta bruta** em `docs/cto/raw_response_<request_id>.txt` (ver abaixo).

### Arquivos gravados para inspeção

| Arquivo | Conteúdo |
|--------|----------|
| `docs/cto/raw_response_<request_id>.txt` | **Resposta bruta da IA** (texto exato da API), gravada **antes** de qualquer parse, no momento em que o runtime recebe a resposta. |
| `docs/cto/cto_response_<request_id>.json` | Response envelope **após** parse/validação (o que o agente entrega ao caller). |
| `docs/manifest.json` | Manifest dos documentos do projeto (lista de arquivos criados). |

---

## 1. O que o CTO envia à IA (Claude)

### 1.1 Canais de entrada

O serviço **agents** monta duas partes para cada chamada ao Claude:

| Parte | Conteúdo | Fonte |
|-------|----------|--------|
| **System prompt** | SYSTEM_PROMPT do CTO + PROTOCOL_SHARED + **Template Obrigatório** (PRODUCT_SPEC) + regras LEI 2 | `runtime.build_system_prompt()` |
| **User message** | Tarefa, modo, spec do projeto em `<user_provided_content>`, restrições, limites, instrução de responder com `<thinking>` e JSON em `<response>` | `runtime.build_user_message()` |

- **Não há “anexos” separados**: a API do Claude recebe apenas texto (system + user). A spec e o template são **inseridos no texto** da mensagem.
- O **template** que a IA deve preencher já é enviado: o conteúdo de `project/spec/PRODUCT_SPEC_TEMPLATE.md` é anexado ao system prompt como “## Template Obrigatório: PRODUCT_SPEC”. Assim a IA sabe a estrutura do documento que deve devolver (seções ## 0 … ## 9, FRs, NFRs, etc.).
- O **formato de retorno** (ResponseEnvelope) também é enviado: o contrato está em `contracts/SYSTEM_PROMPT_PROTOCOL_SHARED.md` (incluído em todos os SYSTEM_PROMPT), com JSON de exemplo (status, summary, artifacts com path/content, evidence, next_actions) e regras LEI 4 (escaping em `content`). Ou seja: **já damos um “template” para a IA saber o que devolver**.

### 1.2 Dados excessivos?

- A spec é limitada no código (ex.: `spec_raw` até 20.000 caracteres no runner; no runtime há cap de 30.000 para o bloco de spec no user message).
- O template e o protocolo são necessários para a IA produzir o artefato correto e o JSON válido. Não se considera envio excessivo para o propósito do CTO (spec intake e charter).

**Conclusão (1):** Enviamos o template do PRODUCT_SPEC e o contrato ResponseEnvelope no system prompt; a spec vai no user message dentro de `<user_provided_content>`. Não há anexos à parte; o formato esperado de retorno está definido e enviado.

---

## 2. O que o CTO recebe da IA e no que formato

### 2.1 Formato esperado

- A IA deve devolver **um único JSON** no formato ResponseEnvelope dentro de `<response>...</response>`:
  - `status`, `summary`, `artifacts[]` (cada um com `path`, `content`, opcionalmente `format`, `purpose`), `evidence[]`, `next_actions`.
- Para o modo `spec_intake_and_normalize`, o CTO exige pelo menos um artefato com path `docs/spec/PRODUCT_SPEC.md` e conteúdo completo (sem reticências; gates de qualidade no envelope).

### 2.2 Problemas conhecidos e mitigação

| Problema | Efeito | Mitigação atual |
|----------|--------|------------------|
| Aspas não escapadas dentro de `artifacts[].content` | JSON inválido → parse falha (LEI 4) | `envelope.resilient_json_parse` com extrator robusto do valor de `content` (Tentativa 2) |
| Conteúdo “muito curto” ou com reticências | Validação de qualidade falha → BLOCKED/repair | Regra de qualidade (ex.: ≥100 chars, sem `...`); repair prompt pede correção |
| IA não segue exatamente o JSON (next_actions como objeto vs array) | Normalização | `_normalize_response_envelope` no runtime preenche defaults e adapta |

Ou seja: **forçamos** o formato (ResponseEnvelope) via prompt e validação; quando a IA devolve JSON quebrado por escaping, o parse robusto tenta recuperar; quando a qualidade falha, o fluxo pode resultar em BLOCKED ou nova tentativa (repair).

**Conclusão (2):** O CTO recebe da IA o que precisa (status, summary, artifacts com path e content, evidence, next_actions). O formato é o ResponseEnvelope; quando a IA não obedece totalmente (escaping, qualidade), o sistema tenta reparar (parse resiliente + repair) ou devolve BLOCKED. O CTO consegue processar o que foi parseado e validado.

---

## 3. Quem grava em disco e onde

### 3.1 Variável de ambiente e raiz dos arquivos

- **`PROJECT_FILES_ROOT`**: define a raiz onde ficam os projetos (ex.: `/Users/mac/zentriz-files`).
- Cada projeto tem pasta `<PROJECT_FILES_ROOT>/<project_id>/` com subpastas `docs/`, `project/`, `apps/` (conforme `project_storage`).

### 3.2 Quem persiste hoje

| Cenário | Quem grava? | Onde |
|---------|-------------|------|
| **Pipeline completo (runner)** | **Runner** | Após cada agente, se `project_id` e `storage.is_enabled()` (i.e. `PROJECT_FILES_ROOT` definido): `project_storage.write_doc`, `write_doc_by_path`, `write_project_artifact`, `write_spec_doc`, etc. |
| **POST /invoke/cto sozinho** (teste e2e ou API direta) | **Ninguém** (antes desta análise) | O serviço agents só devolve o JSON; não gravava em disco. |

- Para o **modo spec_intake**: o runner, após o CTO, grava um único doc “spec_review” com o conteúdo entendido (primeiro artifact ou summary), além da spec original via `write_spec_doc`. Não grava cada artifact do CTO pelo path (ex.: `docs/spec/PRODUCT_SPEC.md`) nesse passo.
- Para o **modo charter** (CTO após Engineer): o runner grava “charter” e cada artifact do CTO como `artifact_0`, `artifact_1`, etc., em `docs/`.

### 3.3 Fluxo completo desejado para o CTO

Para que o agente CTO tenha um **fluxo completo** incluindo gravação em disco:

1. **Via runner (já existe):** Com `PROJECT_FILES_ROOT` e `project_id`, o runner já persiste spec, spec_review e artefatos do CTO (charter e artifacts) em `<PROJECT_FILES_ROOT>/<project_id>/docs/`.
2. **Via POST /invoke/cto sozinho:** Foi adicionada **persistência opcional no serviço agents** (`server._persist_cto_artifacts_if_enabled`): se a requisição tiver `project_id` (no body ou em `input.project_id`) e `PROJECT_FILES_ROOT` estiver definido **no container do agents**, após `run_agent` o agents grava cada artifact do CTO em disco (respeitando path: `docs/`, `project/`, `apps/`). Assim testes ou chamadas diretas também deixam os arquivos em `/Users/mac/zentriz-files` (ou na raiz configurada). Para isso, defina `PROJECT_FILES_ROOT` (e opcionalmente `PROJECT_ID`) no ambiente do serviço agents.

3. **Resposta da IA em JSON (para avaliação):** Sempre que há `project_id` e `PROJECT_FILES_ROOT`, a **resposta completa** da IA (response_envelope) é gravada em `docs/cto/cto_response_<request_id>.json` (agents) ou em `docs/cto/cto_spec_response.json` / `docs/cto/cto_charter_response_round<N>.json` (runner). Assim é possível avaliar o que a IA devolveu mesmo quando o sistema rejeita (BLOCKED/FAIL).

Assim, o CTO tanto no pipeline quanto em chamada isolada pode **processar a resposta da IA e gravar fisicamente** em `<PROJECT_FILES_ROOT>/<project_id>/`.

---

## 4. Resumo do fluxo completo CTO

1. **Entrada:** Runner ou cliente envia message_envelope (request_id, mode, inputs com spec_raw, spec_template, etc.; opcional project_id).
2. **System prompt:** CTO SYSTEM_PROMPT + PROTOCOL_SHARED (contrato ResponseEnvelope + LEI 4) + Template Obrigatório PRODUCT_SPEC.
3. **User message:** Tarefa, modo, spec em `<user_provided_content>`, restrições, instrução de saída em `<thinking>` e `<response>`.
4. **Claude:** Responde com texto; runtime extrai JSON de `<response>`, aplica parse resiliente (incluindo content com aspas não escapadas), valida envelope e qualidade.
5. **Saída:** ResponseEnvelope (status, summary, artifacts, evidence, next_actions) devolvido ao caller.
6. **Gravação em disco:**
   - **Runner:** Com `PROJECT_FILES_ROOT` e project_id, persiste spec, spec_review e artefatos do CTO em `project_storage`.
   - **Agents (chamada direta):** Com `project_id` no body e `PROJECT_FILES_ROOT` definido, persiste cada artifact do CTO em `<PROJECT_FILES_ROOT>/<project_id>/docs/` (ou project/ conforme path), após `run_agent`.

Referências: [AGENTS_AND_LLM_FLOW.md](../AGENTS_AND_LLM_FLOW.md), [CTO_SPEC_TEST_FLOW.md](../../tests/e2e/CTO_SPEC_TEST_FLOW.md), [SYSTEM_PROMPT_PROTOCOL_SHARED.md](../../../applications/contracts/SYSTEM_PROMPT_PROTOCOL_SHARED.md).
