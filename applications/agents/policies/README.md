# Zentriz Genesis — Project Types Policy

> Fonte única de política técnica por `project_type`. Consumida em runtime pelos
> agentes (CTO, Engineer, PM, DevOps, Dev, QA, Cyborg V3, Monitor).
> **Versão:** 0.1.0 · **Status Wave 0:** MVP (5 tipos-piloto)

---

## 1. Por que existe

O Genesis expõe ~50 `project_type` no portal (`spec/page.tsx`) mas até Wave 0
o valor era **metadata de UI sem dispatch de comportamento** — os agentes não
adaptavam a geração conforme o tipo escolhido.

Consequências reais observadas:

- **OrienteMe V4/V7** (`frontend_dashboard`) → home renderizada como scaffold em vez de redirect + dashboard
- **Projeto `54967064`** → PM Backend gerou 0 tasks para produto Web
- **Telegram** → salvou tipos fantasma (`mobile_app`, `static_site`, `frontend_webapp`) que quebravam `_resolve_runbook_type`

Este pacote transforma política implícita em **artefato lido em runtime**.

---

## 2. Arquitetura

```
                    project_types.yaml (fonte única, sob PR)
                              │
                    ┌─────────┴─────────────────────────────┐
                    │                                       │
       build-time (pnpm build hook)              runtime (Python)
                    │                                       │
                    ▼                                       ▼
   applications/services/api-node/src/           applications/orchestrator/
     generated/policies.json  (commited)           pipeline_context.py
                    │                                       │
      ┌─────────────┼──────────────┐                        │
      ▼             ▼              ▼                        ▼
  telegram.ts   portal            api-node          inputs["type_policy"]
                                                            │
                                                            ▼
                                                    ┌───────┴───────┐
                                                    │  Agentes      │
                                                    ├───────────────┤
                                                    │ CTO           │  Gate T-TYPE-COMPLIANCE
                                                    │ Engineer      │  required_routes.strict
                                                    │ PM (3 files)  │  seed backlog
                                                    │ DevOps        │  scaffold obrigatório
                                                    │ Dev (5-7)     │  Wave 1
                                                    │ QA            │  Wave 1 (fingerprint)
                                                    │ Cyborg V3     │  Wave 2
                                                    └───────────────┘
```

---

## 3. Precedência formal (INVIOLÁVEL)

Quando houver conflito entre camadas de decisão, respeitar exatamente esta
ordem — do maior peso para o menor:

```
CONTRACT LAW (Charter + LEI 13)  >  user Delta (LEI EVO)  >  type_policy  >  spec
```

### Por que essa ordem

| Camada | Motivo do peso |
|---|---|
| **CONTRACT LAW** (Charter + LEI 13) | Charter é o contrato aprovado do produto. LEI 13 (Porta e Stack) é declarada explicitamente no Charter e é inviolável. Nada abaixo pode sobrescrevê-la. |
| **user Delta** (LEI EVO) | Em Evolution, o usuário edita o produto — `## Delta` REMOVE explícito **JAMAIS** é bloqueado por `required_routes.strict`. Policy apenas registra `type_policy_delta_removed{route}` para telemetria. |
| **type_policy** | Política técnica compartilhada. Vence spec quando spec é ambígua ou omissa. Nunca vence Charter/Delta. |
| **spec** | Requisitos do produto — vence tudo abaixo, mas cede para as três camadas acima quando conflitar. |

### Exemplos

- Charter declara `stack: [Python + FastAPI]` → policy `stack_when_charter_silent: [Node + Fastify]` **não aplica**.
- Usuário faz `## Delta REMOVE /reports` em Evolution → mesmo `/reports` estando em `required_routes.strict`, policy **apenas registra métrica**.
- Spec pede `hero-section` em produto declarado `frontend_dashboard` → policy `forbidden_patterns: ["hero-section"]` **vence**; Dev emite `NEEDS_INFO` ao CTO.

---

## 4. Schema do YAML

```yaml
version: "<semver>"

type_aliases:
  <alias>: <canonical_type>   # normaliza saídas legadas antes de resolver policy

defaults:                     # herdado por todos os tipos
  scaffold: [...]
  required_routes:
    strict: []                # BLOCKER se ausente no Charter/inventário
    expected: []              # WARN se ausente
  required_components: []
  forbidden_patterns: []
  smell_signals: []
  fingerprint:
    required_tokens:
      strong: []              # FAIL se ausente no código gerado
      soft: []                # WARN se ausente
    forbidden_tokens: []      # FAIL se presente
    synonyms_pt_br: {}        # equivalências para evitar falso positivo em produtos PT-BR
  meta:
    requires_runbook: false
    warn_on_default: false
    blocks_generation: false

groups:                       # herança intermediária universal → group → type
  backend: {...}
  frontend: {...}
  fullstack: {...}
  mobile: {...}
  bot: {...}

types:
  <type_id>:
    inherit_from: <group|null>
    labels:
      pt_br: "..."
      en: "..."
    scaffold: [...]           # ADITIVO ao pai
    required_routes:
      strict: [...]           # ADITIVO ao pai
      expected: [...]
    required_components: [...]
    forbidden_patterns: [...]
    fingerprint:
      required_tokens:
        strong: [...]
        soft: [...]
      forbidden_tokens: [...]
      synonyms_pt_br: {...}
    stack_when_charter_silent: [...]
    smell_signals: [...]
    meta:
      requires_runbook: bool
      warn_on_default: bool
      blocks_generation: bool
```

### Regra de merge

Listas são **UNIÃO ADITIVA** entre defaults → group → type. Nunca subtração.
Exemplo: `frontend_dashboard` herda de `frontend` que herda de `defaults` —
o `forbidden_tokens` final é a união dos 3 níveis.

---

## 5. Fallback estrito — `_default` vs `other`

Dois-e-único-caminho de bypass:

| Situação | Resolução | Comportamento |
|---|---|---|
| Charter declara tipo do YAML | Type específico | Aplica policy do tipo |
| Charter declara tipo válido mas fora do piloto | Alias → tipo canônico OU cai em `other` | Se `other`: exige `RUNBOOK.md` + `## Motivação` no Charter |
| Charter omite `project_type` ou declara tipo desconhecido sem alias | `_default` | **BLOCKER** — força REVISION obrigatória do CTO |

`_default` **não é escape hatch silencioso**:
- `forbidden_patterns: ["*"]` — nenhum código pode ser gerado
- `meta.blocks_generation: true` — pipeline emite REVISION antes do Engineer arrancar

---

## 6. Feature flag `POLICY_ENFORCEMENT_ENABLED`

Env var lida no loader e propagada em `inputs["type_policy"]["enforcement_mode"]`.

| Valor | Comportamento |
|---|---|
| `false` (default até baseline) | Policy é carregada, gates emitem WARN, nenhum BLOCKER de policy dispara |
| `true` | Gates T-TYPE-COMPLIANCE + fingerprint funcionam como BLOCKER |

Rollback: alternar env var em <2 min sem redeploy de app.

---

## 7. Política de linguagem (PT-BR / EN)

**Regra:** chaves em EN, valores técnicos em EN, PT-BR apenas em campos dedicados.

| Campo | Idioma | Motivo |
|---|---|---|
| Chaves do YAML | EN | Padrão universal, evita ambiguidade |
| `scaffold[]` (paths) | EN | Reflete nomes reais no disco |
| `required_routes[]` | EN | URLs são invariantes técnicas |
| `forbidden_patterns[]` | EN | Match em código-fonte |
| `fingerprint.required_tokens[]` | EN | Grep em código-fonte |
| `labels.pt_br` | PT-BR | Exibição no portal |
| `fingerprint.synonyms_pt_br{}` | PT-BR | Evita falso positivo quando produto é PT-BR |

**Exemplo de uso do `synonyms_pt_br`:**

Um dashboard OrienteMe em PT-BR usa `/painel` em vez de `/dashboard`.
Sem synonyms, QA fingerprint marca FAIL falso.
Com `synonyms_pt_br.dashboard: [painel, gerenciador]`, o token `dashboard`
OU `painel` OU `gerenciador` satisfazem o requisito.

---

## 8. Como versionar / evoluir o YAML

**Sem CI dedicado, sem CHANGELOG separado.** Apenas:

1. **Bump obrigatório** de `version` (semver) a cada mudança
2. **Linha no PR description** com "Type Policy: bump X → Y — [motivo em 1 linha]"
3. Regenerar `policies.json` (build hook do api-node)
4. Sync check T-01f valida YAML ↔ portal

**Regras de bump:**

- **PATCH** (0.1.0 → 0.1.1): correção de typo, ajuste de synonym, adição de smell_signal
- **MINOR** (0.1.0 → 0.2.0): novo tipo, novo alias, nova regra em `forbidden_patterns`
- **MAJOR** (0.1.0 → 1.0.0): mudança em precedência, remoção de tipo, break de schema

---

## 9. Guardrails preservados (NÃO REGREDIR)

Esta policy é **aditiva**. Todos os gates/regras existentes permanecem ativos:

- Gates CTO: T-INVENTORY, T-ROUTE-COVERAGE, T-NAV-COVERAGE, Complexity+Scope
- LEIs 10-14, LEI EVO
- Bugs Python 1-9 (`backend_api_python.forbidden_patterns`)
- Bugs Node/Drizzle N1-N8, P1-P13, F1-F6 (`backend_api.forbidden_patterns`)
- Regras W1-W15 Dev MUI + L1-L19 Manager (`frontend_dashboard.required_components`)
- `feedback_port_check` (`start.sh` com `lsof` obrigatório em todos os scaffolds)
- `feedback_pm_task_title` (título 3-10 palavras — intocado por esta policy)

Ver `docs/05-analyses/2026-07-03-project-type-policy/00-plano-v2-final.md` §7 para tabela completa.

---

## 10. Wave 0 — Escopo atual (v0.1.0)

**Tipos ativos:** 5 (Wave 0 MVP)

| Tipo | Grupo | Alias entradas |
|---|---|---|
| `backend_api` | backend | `backend_api_node` |
| `backend_api_python` | backend | — (stack incompatível com `backend_api`) |
| `frontend_dashboard` | frontend | `web_app`, `frontend_web`, `frontend_webapp` |
| `frontend_landing` | frontend | `static_site`, `landing_page` |
| `other` | — | — |
| `_default` | — | fallback estrito, REVISION obrigatória |

**Total: 9 aliases** cobrindo saídas de `detectProjectType` (telegram) + legado.

**Waves futuras** (ver plano v2 completo):
- **Wave 1** (v0.2.0): +3 tipos (`fullstack_saas`, `mobile_crossplatform`, `bot_chat`) + Dev/QA consomem + fingerprint check + Monitor + Skill Store
- **Wave 2** (v0.3.0): +8 subtipos com override + Cyborg V3 recebe policy + Portal via hook

---

## 11. Referências

- Plano v2 final: `docs/05-analyses/2026-07-03-project-type-policy/00-plano-v2-final.md`
- Decisão arquitetural (Wave 2): `docs/01-ecosystem/adr/ADR-016-project-type-policy.md` (a criar)
- Bugs codificados:
  - Python: `memory/feedback_python_fastapi_bugs.md`
  - Node/Drizzle: `memory/feedback_nodejs_drizzle_bugs.md`
  - Manager: `memory/feedback_manager_integration_learnings.md`
  - Genesis SYSTEM_PROMPTs 2026-05-01: `memory/feedback_genesis_system_prompt_updates_2026_05_01.md`
