> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · G — Fase 0': CI real (0.2) e infra de teste de front (0.6)

2026-11-04 · worktree `/home/ubuntu/workspace/current/zentriz/.worktrees/g-e2` · branch `evo/e2` (a partir de `dev`) · 3 commits locais, sem push.
Plano: [EVOLUIR-PROJETO-BANCADA-plano.md](../plans/EVOLUIR-PROJETO-BANCADA-plano.md) (v2, Fase 0').

**Estado declarado**
- 0.2 CI: **preparado** (`ci-evolution.yml` nunca executado no GitHub Actions). Cada comando de cada job foi **validado localmente**.
- 0.6 front: **validado localmente** (1 teste de componente + migração do `rolesLogic` + 1 E2E verdes). Não há execução em CI.

## 1. Commits

| Commit | Conteúdo |
|---|---|
| `e63a5f7` | `test(web)`: Vitest + RTL + jsdom + Playwright no portal (0.6) |
| `cdc3cfc` | `fix(api)`: regenera `api-node/package-lock.json` (achado: `npm ci` falhava) |
| `25923f1` | `ci`: `ci-evolution.yml`, `scripts/ci/pytest_known_failures.py`, `known-env-failures.txt` (0.2) |

## 2. Achados e decisões

1. **`npm ci` do api-node estava quebrado.** O `package-lock.json` estava dessincronizado do `package.json` (`lock file's @aws-sdk/client-sesv2@3.974.0 does not satisfy 3.1161.0`, e dezenas de outros `@aws-sdk/*`/`@smithy/*`). O job `api-node` do `ci.yml` nunca passaria da instalação. Corrigido com `npm install --package-lock-only` (lock de 6407 → ~5650 linhas; 463 → 410 entradas, pois pacotes transitivos duplicados/obsoletos saíram). Validado com `npm ci` limpo + tsc + vitest completo em Node 20 e 22. **Revisar o diff do lock antes de ir a `main`** (mudança de versões transitivas do AWS SDK).
2. **Arquivo novo `ci-evolution.yml` em vez de editar o `ci.yml`.** Motivos: o `ci.yml` tem o job `validate` (docker compose + terraform) cuja viabilidade em `dev`/PR não pude validar aqui; manter o `ci.yml` intocado preserva o gate atual de `main`. Custo: o job `api-node` do `ci.yml` fica redundante (roda em `main` junto com o novo) e deve ser removido quando o novo workflow for adotado (decisão do Jean).
3. **`DATABASE_URL` só no passo de migrations.** Com `DATABASE_URL` definida no job inteiro, `src/integration.test.ts` sai do modo em memória e exige o seed de produção (6 testes de login com 401 — reproduzido localmente). Os testes `*.pg.integration` usam apenas `PG_TEST_URL`.
4. **Como o venv `/tmp/pyv` foi montado:** `python3 -m venv /tmp/pyv` (Python 3.12.3) com versões **soltas/novas** (anthropic 2.4.0, fastapi 0.162, pytest 9.2…), sem usar `requirements.txt`/`constraints.txt`. Para o CI usei o conjunto **pinado da imagem**: `pip install -r applications/orchestrator/agents/requirements.txt -c applications/orchestrator/agents/constraints.txt pytest` (anthropic 1.3.0, etc.). **As mesmas 23 falhas ocorrem nos dois ambientes** (diff das listas vazio), logo não são problema de versão de dependência.
5. **As 23 falhas conhecidas** (`applications/orchestrator/tests/known-env-failures.txt`, com causa observada no cabeçalho): 16 × `spec_validator sem modelo: nenhum slot de LLM resolvido` (+3 × HTTP 422 em vez de 400) — testes assumem slot de LLM resolvível, ausente em ambiente limpo (Lei dos slots); 2 × `schema Connect indisponível (ZENTRIZ_CONNECT_ROOT)` — exigem o repo irmão `zentriz-connect`; 1 × `_default_product_spec_cap("DEV")` = 20000 (esperado > 40000). Arquivos: `test_spec_validator.py` (13), `test_prompt_census_invoke_raw_gap146.py` (4), `test_thinking_arm_gap144.py` (2), `test_connect_contracts.py` (2), `test_spec_dossier_downstream.py` (1), `test_workbench_llm_config.py` (1). Corrigir cada teste e esvaziar a lista é pendência rastreada.
6. **Guarda das falhas conhecidas:** `scripts/ci/pytest_known_failures.py` roda `pytest.main` com plugin coletor. Falha fora da lista, erro de coleta ou pytest abortado ⇒ exit 1; falha listada ⇒ tolerada e impressa; item da lista que passa ⇒ aviso (`--strict-stale` torna erro). Foi exercitada em negativo: na 1ª tentativa a lista estava com prefixo `FAILED ` errado e o script devolveu exit 1 listando as 23 como "NOVA FALHA"; corrigida, devolveu exit 0.
7. **Postgres efêmero:** os testes só aceitam `localhost:55432`. Havia um container `g01-pg-test` de outra frente nessa porta (que depois sumiu); usei um container próprio `e2-pg-ci` (`pgvector/pgvector:pg16`) e o **removi ao final** (porta 55432 livre, confirmado).
8. **E2E:** `@playwright/test` com `launchOptions.executablePath` vindo de `CHROMIUM_PATH` (local, sem instalar navegador) e, no CI, `npx playwright install --with-deps chromium`. Sobe `next start` (o Next avisa que `output: standalone` prefere `node .next/standalone/server.js`; funciona, mas pode ser trocado depois). O teste intercepta `/api/**` (API simulada, 401) e abre `/login` do build real.
9. **Observação de segurança (fora do escopo):** `app/login/page.tsx` e `app/login/genesis/page.tsx` têm e-mail/senha pré-preenchidos no estado inicial do formulário. Não alterei; vale revisar.

## 3. Arquivos

- `.github/workflows/ci-evolution.yml` (novo) · `.gitignore` (+`test-results/`, `playwright-report/`)
- `scripts/ci/pytest_known_failures.py` · `applications/orchestrator/tests/known-env-failures.txt` (novos; arquivo novo na pasta de testes, nenhum teste existente editado)
- `applications/services/api-node/package-lock.json` (regenerado)
- `applications/apps/genesis-web/`: `vitest.config.ts`, `setupTests.ts`, `playwright.config.ts`, `e2e/login.spec.ts`, `components/llm/LlmSlotEditor.test.tsx` (novos); `components/llm/rolesLogic.test.ts` (só cabeçalho: agora roda por `npm test`); `package.json` (scripts `test`, `test:watch`, `typecheck`, `test:e2e`; devDeps vitest ^2.1.9, @vitejs/plugin-react, jsdom, @testing-library/{react,jest-dom,user-event}, @playwright/test) e `package-lock.json` (inclui bumps de patch do `@babel/*`).

## 4. Jobs do workflow e saídas reais (reprodução local)

Sintaxe: `python3 -c "import yaml; yaml.safe_load(...)"` OK (3 jobs: `api-node`, `orchestrator`, `genesis-web`; gatilhos push/PR em `dev` e `main`); `actionlint` não existe aqui (não instalei nada global). Reprodução em cópia limpa do worktree (`/tmp/e2-run`, instalação limpa).

**api-node** (Node 20.20.2 e 22; Postgres `pgvector/pgvector:pg16` em 55432)
```
npm ci                      -> added 338 packages
apply-migrations-test.ts    -> 140 "Migration applied" (1->140); 2ª execução: "All migrations up to date"
tsc --noEmit                -> TSC=0
vitest run (PG_TEST_URL)    -> Test Files 201 passed (201) | Tests 3527 passed | 1 skipped (3528)
vitest run pg.integration   -> 4 arquivos, 25 testes passed (role-verify 1, reorder 6, costSource 6, skillFeedback 12)
npm run build               -> BUILD=0
npm run lint                -> 123 errors/1 warning pré-existentes (no job: continue-on-error, informativo)
```

**orchestrator** (Python 3.12.3, venv novo com requirements+constraints do agents)
```
pip install -r requirements.txt -c constraints.txt pytest -> ok (58 pacotes)
pytest applications/orchestrator/tests (cru)               -> 23 failed, 1146 passed, 2 skipped
python scripts/ci/pytest_known_failures.py -- applications/orchestrator/tests -q
  -> pytest exit 1 | falhas 23 | conhecidas 23 -> "OK: 0 falhas novas; 23 conhecidas toleradas." EXIT=0
```

**genesis-web** (Node 20.20.2, `npm ci` limpo: 889 pacotes)
```
tsc --noEmit        -> TSC=0
npm run lint        -> exit 0 (5 warnings react-hooks, pré-existentes)
npm test            -> 2 arquivos, 36 testes passed (rolesLogic 32 + LlmSlotEditor 4)
npm run build       -> BUILD=0
npm run test:e2e    -> 1 passed (login.spec.ts, ~0,3 s) com CHROMIUM_PATH=chromium-1234
```
Baseline do portal antes das mudanças (Node 22): tsc 0, lint 0 (5 warnings), `next build` ok — idêntico depois.

## 5. Pendências

- **Executar no GitHub Actions** (única forma de declarar "CI verde"): primeiro run pode revelar diferenças de runner (ex.: `playwright install --with-deps`, tempo do `npm ci`, cache). Até lá, o aceite 0.2 do plano ("verde em CI") **não está cumprido**, só preparado.
- Remover o job `api-node` redundante do `ci.yml` ao adotar o novo (decisão do Jean); revisar o diff do `api-node/package-lock.json`.
- Corrigir as 23 falhas conhecidas e esvaziar `known-env-failures.txt`; usar `--strict-stale` depois.
- Lint do api-node (123 erros) é débito; hoje informativo.
- Testes do tipo "E2E com API real" e mais cobertura de componentes ficam para as fases seguintes (3.x do plano).
- Container `Dockerfile` do portal faz `npm ci` incluindo devDeps novas (imagem de build um pouco maior); não testei `docker build` (restrição).
