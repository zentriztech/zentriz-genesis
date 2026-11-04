> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (O): correções da revisão adversarial (M) — segurança, flags por tenant, anexos e runner

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `evo/g2` (a partir da `dev`, base `58aa1ce`) · **Worktree:** `.worktrees/g-g2` · **Papel:** executor das correções do lote "segurança, flags, anexos e runner". Nada em produção, sem push, sem deploy, Guard intocado. Tokens dos testes são **falsos**. Documento de origem: [M](EVOLUIR-PROJETO-M-revisao-adversarial-fase1.md); desenho: [H](EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md); fases [I](EVOLUIR-PROJETO-I-fase1-claim-indices-orcamento.md), [J](EVOLUIR-PROJETO-J-fase1-anexos-e-heranca.md), [K](EVOLUIR-PROJETO-K-fase1-transicoes-e-promocao.md), [L](EVOLUIR-PROJETO-L-fase1-reconciliador.md). Caminhos relativos a `applications/services/api-node/src/` (api) e `applications/orchestrator/` (runner).

## 1. Resultado por achado

| Achado | Correção | Teste | Estado |
|---|---|---|---|
| **M-01** (ALTA) token no erro do `git fetch` | `githubPush.ts`: header de auth por `GIT_CONFIG_COUNT/KEY_0/VALUE_0` no env do `git` (`gitAuthEnv`), fora do argv. `lib/redactSecrets.ts` (`redactSecrets`/`safeErrorMessage`): mascara `Authorization: Basic/Bearer`, `Basic <b64>`, `x-access-token:…`, `ghs_/ghp_/…`, `github_pat_`, credencial em URL, `http.extraheader=…` e segredos literais. Aplicado a todos os `error` do `githubPush.ts` (fetch, git-link, checkout, push, Deadpool), à linha de erro do `/evolve` legado em `routes/projects.ts` (só o `evolutionSourceError`, mais uma barreira final antes de gravar/responder), a `s3StaticDeploy.ts` e `deployBackendCloud.ts`. Migration **147** saneia `projects.extra` e `project_dialogue` já gravados. O caminho novo (`evolveClaim.ts`) herda o erro já limpo do `githubPush.ts` (arquivo da outra frente, não tocado). | `githubPush.redaction.test.ts` (5): controle prova que o `-c` no argv **vaza** na mensagem do `execFile`; com servidor HTTP local que registra o `Authorization`, o `git fetch` falha, o servidor **recebe** `Basic <b64>` (a auth segue funcionando) e o token falso/base64 não aparece em `fetchAndResetBranch`, `gitLinkProjectFolder` nem no argv. `revisaoM.flags…` (migration 147: mascara, idempotente, JSON válido). | **Resolvido** (ver §4: resíduos fora do escopo) |
| **M-03** (ALTA) flags por tenant | `services/featureFlags.ts`: resolução única. **Precedência: tenant explícito > global em `genesis_runtime_config` > env (default de plataforma) > off**; linha inválida é ignorada com aviso e cai ao nível seguinte; erro de banco ⇒ off. `evolveFlags`, `ticketTransitions`, `evolutionPromote` e `ticketAttachments` passam a usá-la (o env **não** sobrepõe mais o tenant). `ATTACHMENTS_STRICT` é resolvida por tenant em `routes/tickets.ts`, `services/tickets.ts` e `GET …/spec-files`. Novo `GET /api/projects/:id/effective-flags` (`routes/projectFlags.ts`) entrega ao runner `{attachmentsStrict, taskInheritTransitive, sources}` do tenant do projeto. Runner: `_effective_flag` (cache 30 s); não lê mais as duas variáveis do próprio env. | `featureFlags.test.ts` (11); `evolveFlags.test.ts` (reescrito: env nunca vence o tenant); PG: precedência em 6 degraus lido pelo contrato do runner, api e runner coerentes (spec-files filtra/mantém conforme o tenant), as 3 flags já por tenant respeitam o tenant sobre o env; pytest `test_m03_*` (2). | **Resolvido**, exceto o job do reconciliador (§4) |
| **R2** escrita de flags | As 6 chaves entram em `CONFIG_KEYS` com `adminOnly` (faixa 0–1; `EVOLVE_RECONCILER` 0–2). `PUT` e `DELETE` de `runtimeConfig.ts` ⇒ 403 `ADMIN_ONLY_KEY` para `tenant_admin`; `GET` expõe `adminOnly`. Verificado: antes, as chaves nem estavam em `CONFIG_KEYS` (só SQL manual as gravava); a guarda impede que o registro abra a brecha. Chaves comuns seguem liberadas ao `tenant_admin`. | PG: 6 chaves × 403, DELETE 403 sem apagar o override do admin, `zentriz_admin` 200, valor 2 em chave bool ⇒ 400, `AGENT_TIMEOUT_PM` 200. | **Resolvido** |
| **M-08** | `load_spec_all`: com estrito efetivo, `status != 200`, corpo não-lista, status 0 e exceção em `_api_get` ⇒ `SpecReadError` (o `main` já o trata como falha explícita, sem cair em `load_spec`). Lista vazia com 200 continua `""`. Flags indisponíveis (transporte/5xx): `SpecReadError` na leitura da spec; `off` na herança. | pytest: `test_m08_*` (4 parametrizados + 3). | **Resolvido** |
| **M-14** | Download: `Content-Type` pela extensão (`application/pdf`, `msword`, `…wordprocessingml.document`, `text/plain; charset=utf-8`, `text/markdown; charset=utf-8`; resto `application/octet-stream`), `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment; filename="<ASCII>"; filename*=UTF-8''<pct>`. Vale com a flag `off` também (correção de segurança; só muda cabeçalho). | PG: `.txt` declarado `text/html` sai `text/plain`, `nosniff`, nome com emoji/CJK ⇒ 200 (antes 500); png ⇒ octet-stream. Unit: CRLF/aspas no nome. | **Resolvido** |
| **M-16** | Decisão: **recusar** (não marcar), código `ATTACHMENT_ACTIVE_CONTENT` (400 com a lista). `.docx`: `vbaProject.bin` (busca bruta + diretório central) ou `macroEnabled`/`vbaProject` no `[Content_Types].xml` (lido com `inflateRawSync`, teto de saída 1 MiB; acima disso recusa como suspeito). PDF: `/JavaScript`, `/JS`, `/Launch` fora de streams, nomes com escape `#xx` normalizados; `/OpenAction` sozinho é aceito (ir-para-página é benigno e comum). | `ticketAttachments.active.test.ts` (11) + PG de rota (docm renomeado, PDF com JS recusados; limpos 201). | **Resolvido** (limite: ações dentro de object streams comprimidos não são vistas sem descompressão; o conversor futuro precisa de sandbox) |
| **M-17** | Teto do multipart em constantes únicas (`MULTIPART_MAX_FILES=10`, `…_FILE_BYTES=10 MiB`) usadas em `app.ts`, nas faixas de `CONFIG_KEYS` e em `loadAttachmentLimits` (`ATTACHMENT_MAX_TOTAL_BYTES` ≤ 100 MiB). Com a flag efetiva `on`, `FST_REQ_FILE_TOO_LARGE`/`FST_FILES_LIMIT` viram `400 ATTACHMENT_INVALID` com `errors[]`; com `off` o erro histórico segue. | PG: 10 MiB+1 ⇒ `ATTACHMENT_TOO_LARGE`; 11 arquivos ⇒ `ATTACHMENT_TOO_MANY`; `off` ⇒ erro histórico; `PUT` 11 / 10 MiB+1 ⇒ 400. | **Resolvido** (streaming com aborto antecipado não feito: o multipart já limita em memória a 10×10 MiB) |
| **M-18** | Comentários: `143_…sql` ("-- 141" → 143), `145_…sql` (numeração final), `services/tickets.ts:72`, `ticketAttachments.ts`. | — | **Resolvido** |
| **M-19** | `GET /api/projects/:id/ticket-attachments` ⇒ 404 com `ATTACHMENTS_STRICT` efetivo `off`; `GET /api/admin/evolve-reconciler/findings` ⇒ 404 com o modo off. A autorização vem **antes** (403 `tenant_admin`, 404 de outro tenant). | PG (tickets + reconciliador); teste do reconciliador ajustado. | **Resolvido** (rota do reconciliador lê o modo por `resolveReconcilerMode`) |
| **M-24** | Rótulo de fallback `TSK-INH-X<8hex>-…`; `_INH_FALLBACK_RE`; o resumo agrupa como "origem sem versão registrada (pai X…)". | pytest `test_m24_*`; teste do rótulo antigo atualizado. | **Resolvido** |

## 2. Decisões

1. **Env vira default, não kill switch.** Segui o enunciado (tenant > global > env). Consequência registrada: `EVOLVE_CLAIM=off` no compose **não desliga** mais um tenant que tenha linha `1`; o desligamento de emergência é gravar `0` (global ou por tenant) por `PUT` do `zentriz_admin`. Se o Jean quiser um kill switch por env (revisão M sugeria `off` de emergência), é uma variável separada — não implementada.
2. **Uma só função de resolução** (`resolveFlag`) para api e runner; o runner recebe booleano pronto. Menor ponto escolhido: rota nova `…/effective-flags` (o token do runner já é escopado a `/api/projects/:id/*`; não alterei o formato de `spec-files`, que o portal consome).
3. **Fail-closed só onde importa:** flags indisponíveis (transporte/5xx, duas tentativas) param a **leitura da spec** (`SpecReadError`); na herança de tasks viram `off` (comportamento anterior). 404/405/501/401/403 = API sem a rota ⇒ `off` com aviso.
4. **`EVOLVE_RECONCILER` é job de plataforma**: só o nível global entra (zentriz_admin não tem tenant). Valores 0=off, 1=shadow, 2=on.
5. **M-16 recusa**, não marca: não há coluna para a marca e nada converte arquivo no servidor hoje.
6. **Migration 147** (a numeração 146 não é usada; novas frentes começam em 161, S-08): UPDATE condicional, sem `DO $$` e sem `;` em literais.

## 3. Saídas reais

```
Ambiente: Postgres pgvector/pgvector:pg16 na porta 55441 (container g2-pg, derrubado ao final); migrations 1→147 aplicadas.

vitest completo (PG 55441)
  ANTES  : Test Files 4 failed | 206 passed (210) · Tests 3670 passed | 26 skipped (3696) · 1 erro não tratado (57P01, flake M-10)
  DEPOIS : Test Files 4 failed | 210 passed (214) · Tests 3708 passed | 26 skipped (3734) · 0 erros
  Os 4 arquivos que falham são os mesmos nas duas medições e dependem da porta 55432 (llm.reorder, llm.role-verify,
  costSource, skillFeedback: "PG_TEST_URL deve apontar para … localhost:55432"). Sem relação com este lote.
  +4 arquivos, +38 testes: githubPush.redaction (5), featureFlags (11), ticketAttachments.active (11), revisaoM.flags.pg (9),
  mais ajustes em evolveFlags/ticketAttachments/evolveReconciler.pg.
tsc --noEmit: EXIT 0

pytest (applications/orchestrator, /tmp/pyv)
  ANTES  : 23 failed, 1177 passed, 2 skipped
  DEPOIS : 23 failed, 1186 passed, 2 skipped   (diff da lista FAILED = vazio: as mesmas 23 falhas de ambiente)
  1ª tentativa do DEPOIS achou 1 regressão minha (test_guard_denial_c1_integration: o servidor falso devolve HTTP 501 à rota
  nova e eu tratava 5xx como "indisponível"); corrigido tratando 405/501 como "API sem a rota" (off).

Evidências [O-…] dos testes PG:
  M03-precedencia: nada → default · env=on → true(env) · env=on+global=0 → false(global) · +A=1 → A true(tenant), B false(global)
  M14 : txt → "text/plain; charset=utf-8", nosniff, cd = attachment; filename="relat_rio __ __.txt"; filename*=UTF-8''relat%C3%B3rio%20%F0%9F%98%80%20%E6%97%A5%E6%9C%AC.txt ; png → application/octet-stream
  M17 : {"big":[400,"ATTACHMENT_TOO_LARGE"],"many":[400,"ATTACHMENT_TOO_MANY"]}
  M01-migration147: "Command failed: git -C /x -c http.extraheader=Authorization: Basic [REDACTED] fetch --depth=1 -q origin dev"
```

Commits (locais, em `evo/g2`): `7cb5781` (M-01), `426af54` (API: M-03, R2, M-14, M-16, M-17, M-18, M-19), `e317880` (runner: M-03, M-08, M-24) e o commit deste relatório.

## 4. Pendências e limites (não resolvido, com o motivo)

- **Job do reconciliador ainda lê só o env (M-03 parcial).** `services/evolveReconciler.ts` (`reconcilerMode` em `runReconcilerPass` e `startReconcilerWorker`) é da frente g-g1 e não foi editado. Pronto para eles: `resolveReconcilerMode(pool, env)` em `featureFlags.ts`. Troca de 3 linhas: `const mode = await resolveReconcilerMode(pool, env)` em `runReconcilerPass` e o worker sempre agendar o timer (o modo passa a mudar sem deploy). Até lá a **rota** `findings` mostra o modo da config, mas o **job** segue o env; a convivência não quebra nada com tudo `off`. O M-22 (namespace do lock) também é desse arquivo.
- **Resíduos de M-01 fora do escopo permitido:** `routes/projects.ts:~1236` (`Falha ao gerar token GitHub: ${err.message}`, erro de **emissão** do token, sem indício de vazamento do valor) e `scripts/backend_deploy_runner.py` / `scripts/s3_deploy_runner.py` (usam `-c …extraheader` no argv do `git clone`, mas só devolvem o `stderr`, que não repete o argv; o token cru é mascarado, o base64 não). Recomendo trocar para `GIT_CONFIG_*` e mascarar o base64 também.
- **Ordem de commits:** os hunks de `routes/projects.ts` foram separados (M-01 no primeiro commit, M-03 no segundo); os demais arquivos mistos (`tickets.ts`, `ticketAttachments.ts`, `runtimeConfig.ts`, `app.ts`) estão no commit da API.
- **PG compartilhado:** por engano o `apply-migrations-test` e uma suíte rodaram uma vez na porta **55432**, que pertence ao container `g1-pg` da outra frente (ela estava ocupada). Efeito: a migration 147 (aditiva e idempotente) foi aplicada ao banco efêmero deles e a suíte deixou fixtures ali. Descartável, mas a g-g1 deve saber. Depois disso usei só a 55441.
- **Não verificado:** emissão real de `git fetch` contra o GitHub; execução do pipeline real do runner contra uma api com as flags; o conversor futuro de anexos.
