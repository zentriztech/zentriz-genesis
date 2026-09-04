> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# RFC-0005 — Controle de GAPs na Bancada: triagem por finding (Ativos | Ignorados | Resolvidos | Refutados)

| Campo | Valor |
|---|---|
| Status | **RASCUNHO — análise arquitetural para decisão** (nada implementado) |
| Data | 2026-09-04 |
| Autor | Jean Ol'Bar + Claude (Genesis) |
| Estende | RFC-0004 (validação adversarial em 2 estágios, gate `SPEC_VALIDATION_GATE`, aba GAPs, ack por run) |
| Pedido | "na lista de GAPs o usuário pode marcar como ignorar, porém eles continuam na lista em uma categoria abaixo (Ativos \| Ignorados \| Resolvidos \| Refutados), como novo controle de GAPs" |

---

## 1. Problema

A aba **GAPs** mostra os `findings` da **última run** de validação e trata a lista como um bloco indivisível:

- **Sem identidade entre runs.** `spec_validation_runs.findings` (JSONB, migration 074) é um *snapshot* por `spec_hash`. Cada "Validar" gera uma lista nova; nada liga o finding de hoje ao de ontem. Logo não existe "este GAP eu já vi", "este sumiu", "este voltou".
- **Decisão humana é por run, não por finding.** O único controle é o `ack` (`POST /api/specs/:id/validation/:runId/ack`): reconhece **todos** os warnings de uma vez, sem motivo, e morre na próxima run (novo `spec_hash` → novo ack). Blockers só saem por `force_promote` de `zentriz_admin` (auditado).
- **Contagens e agentes não distinguem nada.** `fetchGapCounts` (`specEnrichment.ts`) e o badge da aba usam `findings.length`; o botão **Promover à Fábrica** exige type-to-confirm quando `gapCount > 0`; **Resolver GAPs** envia a lista inteira ao CTO; o validador (Stage B, triagem Haiku + refutação Sonnet + `SPEC_VALIDATOR_VOTES`) **não tem memória** do que o humano já refutou — reapresenta o mesmo falso positivo a cada rodada (churn).

Consequência: o humano é forçado a "resolver" GAPs que decidiu conviver (risco aceito) ou que considera errados, só para o número baixar; e o validador não aprende com as refutações.

## 2. Objetivo

Um **controle de GAPs por finding**, com quatro categorias visíveis e semântica precisa:

| Categoria | Quem decide | Significado | Conta no gate? | Conta no badge? | Vai ao Resolver GAPs? |
|---|---|---|---|---|---|
| **Ativos** | ninguém (padrão) | finding presente na run atual, sem triagem | sim (blocker bloqueia) | sim | sim |
| **Ignorados** | humano, com motivo | risco aceito / fora do momento — **dívida visível** | não (ver política §5) | não (aparece como "· N ignorados") | não |
| **Refutados** | humano, com motivo | falso positivo do validador — **realimenta o validador** | não | não | sim, como "não tratar / não levantar de novo" |
| **Resolvidos** | **derivado** (sistema) | estava numa run anterior e **sumiu** na run atual | — | não | não |

Princípio (RFC-0004 §4, inalterado): **estado é determinístico e vive no banco; o LLM só opina**. A triagem humana nunca é inferida por LLM e nunca é apagada por uma nova run.

## 3. Identidade estável do finding (o coração do desenho)

Sem identidade não há triagem que sobreviva a uma re-validação. Proposta: **fingerprint determinístico**

```
fingerprint = sha256( file · "|" · source · "|" · normalize(title) )   → 16 bytes hex
normalize(t) = lowercase → remover acentos → remover pontuação/dígitos → colapsar espaços
```

- **Fora** do fingerprint: `line`, `rationale`, `severity` (mudam entre runs sem o GAP mudar). Severidade que sobe de warning→blocker **mantém** a triagem, mas gera aviso ("severidade mudou").
- **Fallback tolerante** (o LLM reformula títulos): se um finding novo não casa por fingerprint exato, procurar triagem no **mesmo arquivo** com similaridade de tokens do título (Jaccard ≥ 0,8). Determinístico, barato, sem LLM. Se ainda falhar, o GAP volta a Ativo e o humano re-triagem em 1 clique — custo aceitável; **v2**: fingerprint semântico por embedding.
- Incluir `file` evita que "Falta modelo de dados" em `contratos.md` herde a triagem de `spec.md`.

## 4. Modelo de dados

**Migration 081 — `spec_finding_triage`** (1 linha por decisão viva; histórico via `revoked_at`):

```sql
CREATE TABLE spec_finding_triage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('ignored','refuted')),
  reason        TEXT NOT NULL,                 -- obrigatório (≥ 20 chars para blocker)
  severity_at   TEXT NOT NULL,                 -- severidade no momento da decisão
  finding_snapshot JSONB NOT NULL,             -- title/file/rationale como estavam
  spec_hash_at  TEXT NOT NULL,
  actor_user_id UUID, actor_role TEXT NOT NULL,
  expires_at    TIMESTAMPTZ,                   -- só ignored: dívida com prazo (v2)
  inherited_from UUID,                         -- evolução: triagem copiada do pai
  recurrence_count INTEGER NOT NULL DEFAULT 0, -- quantas runs re-emitiram um refutado
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ, revoked_by UUID
);
CREATE UNIQUE INDEX uq_finding_triage_live ON spec_finding_triage (project_id, fingerprint) WHERE revoked_at IS NULL;
```

- **`resolved` não é coluna**: é derivado comparando a run atual com as runs anteriores do projeto (janela: últimas 10 runs **ou** desde a última promoção). Finding que reaparece → sai de Resolvidos e volta a Ativo (ou à sua triagem viva, se houver). Não se mente sobre resolução.
- `spec_validation_runs` fica **intacta** (snapshot imutável). Cada finding devolvido pela API ganha `fingerprint` calculado em leitura (sem migrar dados antigos).
- `ack` por run (colunas `acked_*`) **permanece** para compatibilidade; passa a ser um atalho que cria triagens `ignored` em lote com motivo único ("reconhecido em bloco") — ou é aposentado (decisão D-G4).

## 5. Política e governança (D4 continua valendo)

- **Warning/info**: qualquer autor com escrita na spec pode ignorar/refutar; motivo obrigatório.
- **Blocker**: ignorar ou refutar exige `tenant_admin`/`owner` **e** motivo ≥ 20 caracteres; gera `governance_audit` (`gap_ignored_blocker` / `gap_refuted_blocker`). Reativar também audita (`gap_reactivated`). `zentriz_admin` continua conta de gestão (não triagem — RFC-0002 A.1).
- **Gate `checkSpecValidationGate`**: bloqueia se existir **blocker ATIVO** na run do `spec_hash` atual. Blockers ignorados/refutados não bloqueiam — a decisão está auditada e visível na aba. `force_promote` continua existindo para o caso "não quero triar um por um".
- Ignorado com `expires_at` vencido volta a Ativo automaticamente (job existente `reapOrphanValidationRuns`/`autoValidateDirtySpecs` ganha um passo) — v2.

## 6. Efeitos nos consumidores (todos determinísticos)

| Consumidor | Hoje | Proposto |
|---|---|---|
| `GET /api/specs/:id/validation` | `latestRun.findings[]` | + `fingerprint` e `triage{state,reason,actor,at,expiresAt}` por finding; + `resolved[]` (com `lastSeenRunId`); + `counts{active,ignored,refuted,resolved,blockersActive}` |
| Badge da aba / `onFindingsChange` / `fetchGapCounts` / `GapWarningChip` | `findings.length` | `counts.active` (texto secundário "· N ignorados") |
| Promover à Fábrica (type-to-confirm) | `gapCount > 0` | `counts.active > 0` |
| Resolver GAPs (`specChat.ts` `findingsBlock`) | todos | só **Ativos**; anexa **Refutados** como "não tratar / não reintroduzir" |
| Validador Stage B (`specValidation.ts`) | sem memória | recebe `known_false_positives[]` (title/file/reason) no input; se re-emitir equivalente, o backend **auto-aplica** a triagem `refuted` por fingerprint (não vira Ativo) e incrementa `recurrence_count` |
| Auditoria (`/settings/audit`) | ack/force | + ações `gap_ignored*`, `gap_refuted*`, `gap_reactivated` |
| Evolução (`/evolve`, E1) | herda arquivos | **herda triagens vivas** do pai (`inherited_from`) — a spec é a mesma; sem isso a evolução renasce com todos os GAPs "ativos" |
| Aprendizado (feedback "ensinar Genesis e Deadpool") | — | v2: agregado de refutações por título normalizado alimenta a calibração do validador (lesson store), cross-tenant sem PII |

## 7. API

```
GET    /api/specs/:id/validation                          → enriquecido (§6)
POST   /api/specs/:id/findings/:fingerprint/triage        { state: 'ignored'|'refuted', reason, expiresAt? }  → 201
DELETE /api/specs/:id/findings/:fingerprint/triage        → reativa (revoked_at) → 200
POST   /api/specs/:id/findings/triage-bulk                { fingerprints[], state, reason }  (atalho "ignorar todos os warnings")
```

Guardas: acesso ao projeto (tenant), `SPEC_EDITABLE_STATUSES` **não** se aplica (triar não edita a spec), sem token de serviço, política de blocker (§5). Idempotência: `POST` sobre triagem viva do mesmo estado → 200 sem duplicar; estado diferente → revoga a anterior e cria a nova (histórico preservado).

## 8. UI — `SpecValidationPanel`

- Abas **Ativos (n) | Ignorados (n) | Resolvidos (n) | Refutados (n)**, ordenadas por severidade e arquivo (filtro por arquivo já existe no painel).
- Menu ⋮ por finding: **Ignorar** (motivo; prazo opcional), **Refutar** (motivo), **Reativar** (nas abas Ignorados/Refutados). Blocker mostra a exigência de papel/motivo antes de abrir o diálogo.
- Resolvidos: só leitura, com "visto pela última vez em <run/data>" e marcador "voltou" quando reaparece.
- Cabeçalho: "3 ativos · 2 ignorados · 1 refutado · 5 resolvidos". Badge da aba GAPs = ativos.
- Cards do `/specs`: `GapWarningChip` com ativos; tooltip com os demais.

## 9. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Fingerprint frágil (LLM reformula o título) | fallback Jaccard no mesmo arquivo (§3); re-triagem custa 1 clique; embedding em v2 |
| "Ignorar" vira bypass do gate | motivo obrigatório, política por papel para blocker, auditoria D4, aba Ignorados sempre visível (dívida), `expires_at` |
| Refutar em massa para "limpar" | refutação de blocker só tenant_admin; `recurrence_count` expõe o padrão na auditoria |
| Resolvidos explodem em projetos antigos | janela de 10 runs / desde a última promoção; paginação |
| Divergência entre badge, gate e chat | uma única função `projectFindingsState(projectId)` no backend alimenta os três (fonte única) |

## 10. Plano de execução (1 rodada autônoma, adversarial por PR)

| PR | Escopo | Aceite |
|---|---|---|
| **G1 backend** | migration 081; `fingerprint()` + `normalizeTitle()` + fallback Jaccard; `projectFindingsState()`; `GET` enriquecido; endpoints triage (single/bulk/delete); gate, `fetchGapCounts`, Resolver GAPs usando `active`; auditoria de blocker; herança no `/evolve` | validar → ignorar warning → re-validar: continua Ignorado; blocker ignorado por autor comum → 403; por tenant_admin com motivo → gate passa e audita |
| **G2 validador** | `known_false_positives` no input do Stage B; auto-refute por fingerprint + `recurrence_count` | refutado não reaparece como Ativo em 3 runs seguidas |
| **G3 UI** | abas, menu ⋮, diálogos de motivo, contadores, chips | fluxo completo sem recarregar a página; contraste/mobile ok |

## 11. Decisões para o Jean (com recomendação)

- **D-G1** Blocker pode ser **ignorado/refutado por `tenant_admin`/`owner` com motivo + auditoria** (recomendado) — ou só `zentriz_admin` (mantém o status quo do `force_promote`, mas contradiz "gestão não autora").
- **D-G2** **Resolvido é derivado** pelo sistema (recomendado) — ou também manual ("marcar resolvido").
- **D-G3** **Herdar triagens na evolução** (recomendado) — ou começar limpo.
- **D-G4** `ack` por run: **manter como atalho "ignorar todos os warnings" em lote** (recomendado) — ou aposentar.
