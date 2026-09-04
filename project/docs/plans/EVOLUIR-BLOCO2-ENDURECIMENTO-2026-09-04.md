> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir — Bloco 2: endurecimento do que já existe (plano v1, 2026-09-04)

| Campo | Valor |
|---|---|
| Status | **v2 — adversarial do plano incorporada (§ Adversarial); pesquisa em § Pesquisa; APROVADO para execução na ordem H1 → H2 → H3 → H7 → H5 → H6 → H4** |
| Base | Fases 1+2 do Evoluir em `dev` (E1 `a04ed50` … E5-fix `ced7df4`); memória `genesis-evoluir-fase1-implementacao-2026-09-04.md` |
| Fora deste bloco | bloco 3 (DevOps condicional, reconciliação sobre `apps/`, PASS_TO_PASS real, painel E6 completo) e bloco 4 (merge automático, redeploy cloud, Deadpool pós-merge, Dev em diff) |

## Itens (ordem proposta = menor risco/maior valor primeiro)

| # | Item | Estado atual (fato) | Desenho v1 | Aceite |
|---|---|---|---|---|
| H1 | **Supersessão visível** | pai vira `archived` + `extra.superseded_by`; listagens filtram `status <> 'archived'` (`projects.ts:145/175/205`, `projects/page.tsx:441`) → "sumiu meu projeto" | `GET /api/projects/:id` já expõe `extra`; **listagens passam a incluir `archived` com `superseded_by`** como linha "Substituído por vN" (badge, link ao filho); no filho, chip "Substitui vN" (`extra.supersedes`) com link ao pai; `/versions` mostra a cadeia com a versão corrente marcada | pai não desaparece; 1 clique leva ao filho e vice-versa |
| H2 | **Republicar** (`evolution_push_pending`) | E5 grava a flag quando o push falha; não há caminho de retomada | `POST /api/projects/:id/evolution/republish` (tenant_admin/dono; só se `extra.evolution_push_pending`): reexecuta `runEvolutionAcceptFlow` parcial (push + supersessão), limpa a flag; botão no projeto quando a flag existe; idempotente (branch/PR já existentes → reaproveita) | push falho → botão → sucesso → pai supersedido e flag limpa |
| H3 | **Planner de RFC persistido** | job em memória (`evolutionPlanner.ts` `_jobs` Map) morre no restart; poll do front para em 404 | tabela `evolution_plan_jobs` (migration 082: id, project_id, owner_user_id, status, request, result JSONB, error, created_at, finished_at) — mesmo padrão da 076 (`product_proposals`); reaper no boot marca `running` órfãos como `error` ("reinício"); `activePlanJobFor` via SQL | restart da API durante o planejamento → job vira `error` com mensagem clara; histórico consultável |
| H4 | **Deleções propagam** para `evolution/vN` | `pushProjectFiles` usa `createTree({ base_tree })` → só adiciona/atualiza | `pushProjectFiles(opts.syncDeletes=true)`: lista a árvore do branch (`git/trees?recursive=1`), e para cada path presente no remoto e ausente no `apps/` local adiciona entrada `{ path, mode:"100644", type:"blob", sha:null }` (Git Data API: `sha: null` remove). Só no push de evolução (push inicial não precisa); pular `.github/workflows/*` (gerados pelo Genesis) | arquivo removido no filho desaparece no branch remoto; workflows preservados |
| H5 | **`_exported_symbols` mais completo** | cego a `export { a, b }`, `export * from`, `export default function()` anônimo, `module.exports = {…}`/`exports.x`, Python `__all__` | regexes adicionais (TS/JS: `export {a, b as c}` → a,c; `export default` anônimo → `default`; `module.exports = { a, b }`/`exports.a =`; Python: `__all__ = [...]` sobrepõe def/class). Falso-negativo → falso-positivo controlado: se `export *` existir, não acusar remoção (ré-exportação opaca) | testes por linguagem; refactor legítimo continua sem violação |
| H6 | **Tasks do pai herdadas** | `_seed_tasks` não conhece tasks do pai; PM incremental gera só `TSK-EVO-*` | no run de evolução, `_seed_tasks` importa as tasks DONE/QA_PASS do pai (via `GET /api/projects/<pai>/tasks`) como `status=DONE`, `inherited_from=<pai>`, sem execução; portal mostra "herdada" | filho lista tasks do pai como concluídas + as novas; Dev/QA nunca reexecutam herdadas |
| H7 | **"Novo RFC a partir do modelo"** | template em `GET /api/spec-templates/rfc`; UI não tem atalho | botão na árvore da Bancada (só em evolução): cria `docs/rfc/RFC-NNNN-<slug>.md` com o template (número = `products.next_rfc_seq` alocado via endpoint `POST /api/projects/:id/rfc-from-template {slug}`), abre no editor | 1 clique gera RFC numerado a partir do modelo |

## Adversarial do plano (2026-09-04) — GAPs fechados na v2

| # | Achado | Fechamento |
|---|---|---|
| A (P1) | H2: `runEvolutionAcceptFlow` chama `finalizeEvolutionChangelog` sempre → republicar dobra a versão (1.1.0 → 1.2.0) | guarda: se `extra.evolution_version` existe **e** o CHANGELOG já tem `## [versão]`, pula o passo 1 e reusa; `republish` = push + supersessão; flag `evolution_push_pending` só limpa com `push.ok`; permitido a `tenant_admin` ou dono |
| B (P1) | H1: `/versions` resolve só 2 saltos (`rootId = avô ?? pai`) | usar `resolveLineageRoot`; `isCurrent` = último `accepted` não supersedido; expor `supersededBy/supersedes` por versão |
| C (P1) | H4: `Dockerfile`, `docker-entrypoint.sh`, `.dockerignore` vêm de `project/` (não existem em `apps/` local) e `.github/workflows/*` é gerado → seriam apagados | lista protegida fixa + deleções num **único batch final**; `getTree(recursive)` com `truncated` → abortar deleções e logar |
| D (P2) | H4: "local é a fonte" é falso — o Deadpool commita direto no remoto | só apagar paths que EXISTIAM no clone local (`git -C apps ls-files HEAD`) e não existem mais no disco; nunca paths só-remotos |
| E (P2) | H6: herdadas inflam o progresso do card e não chegam ao PM | `module='inherited'`? — CHECK só aceita backend/web/mobile → usar prefixo `TSK-INH-*` + `evidence='inherited:<pai>'`, excluídas do contador (como TSK-DEVOPS/FULL-TEST) e do Dev/QA; passadas ao PM como "entregues na versão anterior" |
| F (P2) | H2: push idempotente ✓ mas commit vazio possível | aceito; documentado |
| G (P2) | H3: concorrência entre réplicas | índice único parcial `(project_id) WHERE status IN ('pending','running')`; reaper no boot → `interrupted` ("reinício do servidor"); front trata `interrupted` como erro recuperável |
| H (P2) | H5: regras | `export *` opaco só no arquivo que o contém; `module.exports = require()` opaco; `as` alias exporta o alias; `default` anônimo → `default`; `export type {}` e destructuring fora do v1 |
| I (P3) | H7: status/RBAC | reusar `guardWrite`/`SPEC_EDITABLE_STATUSES` (exportar), `denyCreationForManagement`; só em `extra.evolution`; `slugify` do planner |
| J (P3) | H1: `archived` manual × supersedido | filtro `status <> 'archived' OR extra->>'superseded_by' IS NOT NULL` nos 3 SELECTs e no web |

## Pesquisa (2026-09-04) — grounding e o que muda

Fontes: GitHub REST Git Data (trees: `base_tree` + `sha: null` = deleção oficial; `sha`/`content` exclusivos; `GET trees?recursive=1` limite 100k entradas/7 MB com `truncated`); Git FAQ (diretórios vazios não existem — subtree some sozinho); es-module-lexer / cjs-module-lexer (padrões congelados, "best-effort", re-export `require()` opaco), ts-morph (`getExportedDeclarations` resolve `export *` mas exige Program), Python `__all__` (só literal é seguro), Go spec (identificador Lu); pg-boss (`singleton`/`stately` = 1 ativo por chave; `expireIn` → stale) e graphile-worker (`jobKey`, at-least-once); UX: Figma (restaurar é não destrutivo), Vercel (Skipped/rollback visíveis + Undo), Terraform (estados terminais com causa), Jira (links bidirecionais inward/outward), npm deprecate (mantém versão, só avisa).

| Lição | Aplicação |
|---|---|
| Deleção oficial via `sha:null`+`base_tree`; checar `truncated` | H4 como planejado; `truncated` → abortar deleções |
| Exports: lexer + "opaco", nunca inventar nome | H5: `export *`/`module.exports = require()` opacos por arquivo; Python só `__all__` literal; Go regex Lu |
| Idempotência de job = índice parcial único em estados vivos; reaper marca órfão como terminal legível, nunca retoma | H3: `UNIQUE (project_id) WHERE status IN ('pending','running')`; boot → `interrupted` ("reinício do servidor"); "Reexecutar" cria job NOVO |
| Supersessão = link bidirecional com rótulos inversos; nunca esconder o anterior; estado terminal com causa e ação inversa | H1: `superseded_by` ↔ `supersedes` nas duas telas; pai continua listado com rótulo "Substituído por vN"; H2 "Republicar" é a ação inversa visível do push falho |

## Riscos conhecidos a validar na adversarial
- H1: incluir `archived` nas listagens pode reexibir projetos arquivados manualmente (sem `superseded_by`) — filtrar só os supersedidos.
- H4: `sha: null` em `createTree` exige `base_tree`; entradas de diretório vazio; limite de 100 entradas por chamada? (batches já existem no `pushProjectFiles`); risco de apagar arquivos que o Deadpool criou no remoto e não estão no local — o local É a fonte (clone do E1) — aceitável?
- H6: tasks herdadas contam para métricas/valor (project_delivered)? Marcar `inherited` para não contar.
- H3: migração de jobs em voo no deploy (não há) — ok.
