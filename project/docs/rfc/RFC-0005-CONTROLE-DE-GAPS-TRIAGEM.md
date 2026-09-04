> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# RFC-0005 — Controle de GAPs na Bancada: triagem por finding (Ativos | Ignorados | Resolvidos | Refutados)

| Campo | Valor |
|---|---|
| Status | **v2 — APROVADO para execução** (v1 = análise; decisões D-G1..D-G4 fechadas pelo Jean em 2026-09-04 nas recomendações; v2 incorpora a adversarial do desenho — §12 — e a pesquisa de estado da arte — §13) |
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

Sem identidade não há triagem que sobreviva a uma re-validação. **Título livre do LLM não serve como identidade**: o próprio `spec_validator.py` documenta ~60% de churn entre análises e o consolidador de multi-voto agrupa por título lowercase — "Falta modelo de dados" × "Modelo de dados ausente" tem Jaccard 0,33. A identidade tem de vir de campos que **nós controlamos no contrato de saída**:

```
fingerprint = sha256( file · "|" · source · "|" · category · "|" · normalize(anchor) )   → 32 hex
```

- **`category`** (taxonomia fechada, exigida do validador e do Stage A): `security_gap` · `missing_data_model` · `contract_undefined` · `infra_undefined` · `ambiguous_fr` · `no_acceptance_criteria` · `missing_nfr` · `scope_conflict` · `stack_inconsistent` · `connect_declaration_gap` · `prompt_injection` · `structural` (Stage A) · `other`. Espelha as 6 lentes do prompt do Stage B; `parseStageBFindings` normaliza (desconhecido → `other`).
- **`anchor`** = o que o finding aponta na spec (heading `## …`, `FR-NN`, nome de entidade/rota) — string curta pedida ao validador ("cite o FR/seção/entidade"); Stage A usa o id da regra (`archetype_unknown`, `empty_spec`, `rfc_no_gherkin`…). `normalize()` = lowercase → sem acentos → sem pontuação → espaços colapsados.
- **Fora** do fingerprint: `line`, `rationale`, `severity`, **título**. Severidade que sobe warning→blocker **mantém** a triagem, mas a UI avisa ("severidade mudou").
- **Fallback** (findings antigos sem `category`/`anchor`, ou anchor vazio): `file|source|category|normalize(title)`; depois similaridade de tokens do título (Jaccard ≥ 0,8) **dentro do mesmo `file`+`category`**. Falhou → volta a Ativo, humano re-triagem em 1 clique. Embedding semântico só v2.

## 4. Modelo de dados

**Migration 081 — `spec_finding_triage`** (1 linha por decisão viva; histórico via `revoked_at`):

```sql
CREATE TABLE spec_finding_triage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('ignored','refuted')),
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('accepted_risk','out_of_scope','will_fix_later','by_design','mitigated','duplicate','false_positive')),
  reason        TEXT NOT NULL DEFAULT '',      -- texto livre; ≥ 20 chars obrigatório só para blocker
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

- **`resolved` não é coluna**: é derivado. Para não **flapar** com a variância do LLM, um finding só é "resolvido" quando está **ausente em ≥ 2 runs consecutivas** com status `passed|failed` (runs `superseded|error|interrupted|running` não contam); finding do Stage A (determinístico) resolve em 1 run. Arquivo removido/renomeado → resolvido com marca explícita "arquivo removido". Reaparecer → sai de Resolvidos e volta a Ativo (ou à sua triagem viva). Janela: últimas 10 runs válidas.
- `spec_validation_runs` fica **intacta** (snapshot imutável). Cada finding devolvido pela API ganha `fingerprint` calculado em leitura (sem migrar dados antigos).
- **`ack` por run permanece exatamente como está** (hash-bound, sem criar triagens): semântica "reconheço para ESTA versão" não pode virar "ignorar para sempre" por baixo do pano. O atalho em lote da D-G4 é uma ação **explícita** na UI: "Ignorar todos os warnings ativos" (`triage-bulk`, `reason_code` único, prazo opcional).
- `reason_code = false_positive` só é válido com `state = refuted`.

## 5. Política e governança (D4 continua valendo)

- Papéis reais do sistema: `user` · `tenant_admin` · `zentriz_admin` (`users.role`, migration 001). **Não existe `owner`.**
- **Warning/info**: qualquer usuário do tenant com acesso ao projeto pode ignorar/refutar; `reason_code` obrigatório.
- **Blocker**: ignorar ou refutar exige `tenant_admin` **e** `reason_code` + texto ≥ 20 caracteres; gera `governance_audit` (`gap_ignored_blocker` / `gap_refuted_blocker`, snapshot com `reason_code`) e notificação Telegram do tenant (padrão dos eventos de governança). Reativar audita (`gap_reactivated`). `zentriz_admin` é conta de gestão: **não triagem** (RFC-0002 A.1).
- **Não triáveis (lista fechada):** todo blocker `source = stage_a` (spec vazia, arquétipo desconhecido, teto de arquivos, RFC de evolução inválido) e Stage B `category = prompt_injection`. Só se corrigem; a UI mostra "não triável" e a API responde 409 `FINDING_NOT_TRIAGEABLE`.
- **Gate `checkSpecValidationGate`**: bloqueia se existir **blocker ATIVO** na run do `spec_hash` atual. Blockers ignorados/refutados (triáveis) não bloqueiam — a decisão está auditada e visível na aba. Warnings ativos continuam exigindo `ack` (ou triagem individual). `force_promote` continua existindo.
- Ignorado com `expires_at` vencido volta a Ativo automaticamente (job existente `reapOrphanValidationRuns`/`autoValidateDirtySpecs` ganha um passo) — v2.

## 6. Efeitos nos consumidores (todos determinísticos)

| Consumidor | Hoje | Proposto |
|---|---|---|
| `GET /api/specs/:id/validation` | `latestRun.findings[]` | + `fingerprint` e `triage{state,reason,actor,at,expiresAt}` por finding; + `resolved[]` (com `lastSeenRunId`); + `counts{active,ignored,refuted,resolved,blockersActive}` |
| Badge da aba / `onFindingsChange` / `fetchGapCounts` / `GapWarningChip` | `findings.length` | `gapCount = active` + novo `gapCountIgnored` (cards do `/specs` somam os dois separadamente; `specEnrichment.test.ts` atualizado de propósito) |
| Promover à Fábrica (type-to-confirm) | `gapCount > 0` | `counts.active > 0` |
| Resolver GAPs (`specChat.ts` `findingsBlock`; guard 409) | todos; 409 se `findings.length === 0` | só **Ativos**; anexa **Refutados** como "não tratar / não reintroduzir"; guard e botão usam `active` ("Sem GAPs ativos · N ignorados") |
| Validador Stage B (`spec_validator.py` + `specValidation.ts`) | sem memória | contrato de saída ganha `category` + `anchor`; input ganha `known_false_positives[]` (file/category/anchor/title/reason); se re-emitir equivalente **triável**, o backend **auto-aplica** `refuted` por fingerprint (não vira Ativo) e incrementa `recurrence_count`; nunca auto-refuta não triáveis |
| Auditoria (`/settings/audit`) | ack/force | + ações `gap_ignored*`, `gap_refuted*`, `gap_reactivated` com `reason_code`; coluna `recurrence_count` |
| Evolução (`/evolve`, E1) | herda arquivos | **herda as triagens vivas do pai imediato** (`inherited_from`; a cadeia já trouxe as da raiz); revogação local no filho vence e não é recopiada |
| Aprendizado (feedback "ensinar Genesis e Deadpool") | — | v2: agregado de refutações por título normalizado alimenta a calibração do validador (lesson store), cross-tenant sem PII |

## 7. API

```
GET    /api/specs/:id/validation                          → enriquecido (§6)
POST   /api/specs/:id/findings/:fingerprint/triage        { state: 'ignored'|'refuted', reason, expiresAt? }  → 201
DELETE /api/specs/:id/findings/:fingerprint/triage        → reativa (revoked_at) → 200
POST   /api/specs/:id/findings/triage-bulk                { fingerprints[], state, reason }  (atalho "ignorar todos os warnings")
```

Corpo do `POST`: `{ state, reason_code, reason?, expiresAt? }`. Guardas: acesso ao projeto (tenant), `SPEC_EDITABLE_STATUSES` **não** se aplica (triar não edita a spec), sem token de serviço, política de blocker e lista de não triáveis (§5). Idempotência: `POST` sobre triagem viva do mesmo estado → 200 sem duplicar; estado diferente → revoga a anterior e cria a nova **na mesma transação** (`SELECT … FOR UPDATE` na linha viva) — histórico preservado.

## 8. UI — `SpecValidationPanel`

- Abas **Ativos (n) | Ignorados (n) | Resolvidos (n) | Refutados (n)**, ordenadas por severidade e arquivo (filtro por arquivo já existe no painel).
- Menu ⋮ por finding: **Ignorar** (`reason_code` + texto; prazo opcional), **Refutar** (`reason_code`), **Reativar** (nas abas Ignorados/Refutados). Blocker mostra a exigência de papel/motivo antes de abrir o diálogo; não triável mostra "corrija a spec" sem menu.
- Ação em lote explícita: **"Ignorar todos os warnings ativos"** (D-G4). O botão "Reconhecer avisos" (ack) continua com a semântica atual.
- Refutados: mostram `recurrence_count`; ≥ 3 → alerta "o validador insiste neste ponto — revise a refutação".
- Resolvidos: só leitura, com "visto pela última vez em <run/data>", marca "arquivo removido" quando for o caso, e marcador "voltou" quando reaparece.
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
| **G1 backend** | migration 081; `category`/`anchor` no `ValidationFinding` (Stage A com ids de regra; `parseStageBFindings` normaliza); `fingerprint()` + fallbacks; `projectFindingsState()` (ativos/ignorados/refutados/resolvidos com regra de 2 runs); `GET` enriquecido; endpoints triage (single/bulk/delete, transação); lista de não triáveis; gate, `fetchGapCounts` (+`gapCountIgnored`), guard do Resolver GAPs usando `active`; auditoria + Telegram de blocker; herança no `/evolve` | validar → ignorar warning → re-validar: continua Ignorado (mesmo com título reformulado, se `category|anchor` casam); 1 ausência ≠ resolvido, 2 ausências = resolvido; blocker Stage A → 409 `FINDING_NOT_TRIAGEABLE`; blocker triável por `user` → 403, por `tenant_admin` com motivo → gate passa e audita; ack não cria triagens; guard do Resolver GAPs com ativos=0/ignorados>0 → 409 |
| **G2 validador** | `category` + `anchor` no contrato de saída do `spec_validator.py` (prompt + consolidador de votos agrupa por `category|anchor`, não por título); auto-refute **pós-processamento** por fingerprint no backend (só triáveis) + `recurrence_count`; **sem** lista de "não reporte" no prompt (pesquisa §13) | refutado não reaparece como Ativo em 3 runs seguidas; `recurrence_count` cresce e aparece na UI/auditoria |
| **G3 UI** | abas, menu ⋮ com `reason_code`, bulk "Ignorar todos os warnings ativos", contadores, chips (`gapCount`/`gapCountIgnored` nos cards), `recurrence_count` | fluxo completo sem recarregar a página; contraste/mobile ok |

## 11. Decisões — FECHADAS pelo Jean (2026-09-04, "seguir a recomendação")

- **D-G1** Blocker triável pode ser ignorado/refutado por **`tenant_admin`** com `reason_code` + motivo ≥ 20 chars + auditoria + Telegram (o papel `owner` citado na v1 não existe).
- **D-G2** **Resolvido é só derivado** (regra de 2 runs consecutivas; Stage A em 1).
- **D-G3** **Herdar triagens vivas do pai imediato** na evolução; revogação local vence.
- **D-G4** `ack` por run **mantido intacto** (hash-bound); o atalho em lote é a ação explícita "Ignorar todos os warnings ativos".

## 12. Adversarial do desenho (2026-09-04) — GAPs fechados nesta v2

| # | Achado | Fechamento |
|---|---|---|
| A (P1) | fingerprint por título frágil (~60% churn documentado no validador) | `category` + `anchor` no contrato de saída; título só fallback (§3) |
| B (P1) | "resolvido" derivado flapa com a variância do LLM | ausência em ≥ 2 runs `passed\|failed` consecutivas; Stage A em 1; arquivo removido explícito (§4) |
| C (P1) | blockers estruturais do Stage A ignoráveis por tenant_admin | lista fechada de não triáveis + `prompt_injection` (§5) |
| D (P2) | ack em lote mudaria a semântica hash-bound silenciosamente | ack intacto; bulk explícito na UI (§4, §8) |
| E (P2) | `owner` não é papel | política só `tenant_admin` (§5) |
| F (P2) | motivo livre é teatro | `reason_code` fechado; texto ≥ 20 só para blocker (§4, §7) |
| G (P2) | herança: pai imediato × raiz; revogação local | pai imediato; revogado no filho não volta (§6) |
| H (P2) | guard 409 do Resolver GAPs e botão | `active`; "Sem GAPs ativos · N ignorados" (§6) |
| I (P2) | auto-refute esconde erro humano | `recurrence_count` visível, alerta ≥ 3, sem auto-refute em não triáveis (§6, §8) |
| J (P3) | TOCTOU revogar/inserir | transação + `FOR UPDATE` (§7) |
| K (P3) | testes/cards assumem `findings.length` | `gapCount` + `gapCountIgnored`; `specEnrichment.test.ts` e `specs/page.tsx` atualizados (§6) |
| L (P3) | faltavam Telegram, `reason_code` na auditoria, lesson store | Telegram em blocker; `reason_code` no snapshot; lesson store declarado **v2** (§5, §6) |

Testes obrigatórios (aceite do G1/G2): churn de título com mesmo `category|anchor` casa; 1 ausência ≠ resolvido e 2 = resolvido; blocker Stage A → 409; `user` em blocker → 403; herança + revogação local; ack não cria triagens; guard 409 com ativos = 0 e ignorados > 0.

## 13. Pesquisa — estado da arte (2026-09-04) e o que muda na v2

Fontes primárias: SonarQube (`Tracker.java`, line hash, *Fixed* automático, backdating), GitHub code scanning / SARIF 2.1.0 (`partialFingerprints`, `dismissed_reason` obrigatório, `baselineState`), Semgrep (`match_based_id` sem linha; `nosemgrep` **ainda gera** o finding e é auto-triado), Snyk (`.snyk` `expires`/`reason`, restrição de quem ignora), DefectDojo (`hash_code`, **False Positive History**, *Risk Acceptance* com expiração e reativação), OpenVEX/Trivy/Grype (`not_affected` exige `justification` enumerada); literatura LLM (SkipAnalyzer, BugLens, ZeroFalse, CR-Bench, CodeRabbit in-the-wild: LLM como *adjudicador com evidência* reduz FP; "não reporte X" no prompt tende a sobre-suprimir) — detalhes em `memory/genesis-gaps-triagem-rfc0005-analise-2026-09-04.md`.

| Lição | Aplicação na v2 |
|---|---|
| Resolvido é derivado, nunca clicado (Sonar/GitHub/Semgrep) | mantido (D-G2) com regra anti-flapping (§4) |
| Fingerprint independente de posição, calculado **server-side** (Semgrep `match_based_id`; GitHub duplica sem fingerprint) | `file\|source\|category\|anchor`, nunca `line`; nunca pelo LLM (§3) |
| Cascata de matching relaxante (Sonar `Tracker`) | exato → `file\|category\|título normalizado` → Jaccard no mesmo `file+category` (§3) |
| **Supressão é pós-processamento**, não memória do modelo (DefectDojo FP History, `nosemgrep`) | **G2 muda:** o validador continua gerando; o backend auto-triagem por fingerprint (`refuted` → não vira Ativo; `recurrence_count++`). Refutados **não** entram no prompt como "não reporte" — no máximo como contexto de calibração por categoria (v2) |
| Motivo obrigatório com taxonomia fechada (GitHub, OpenVEX) | `reason_code` fechado + `mitigated` adicionado: `accepted_risk` · `out_of_scope` · `will_fix_later` · `by_design` · `mitigated` · `duplicate` · `false_positive` (só `refuted`) |
| Expiração só para risco aceito, que **reativa** ao vencer (Snyk/DefectDojo); FP é permanente até o trecho mudar | `expires_at` só em `ignored`; job reativa e notifica; `refuted` sem prazo |
| Política por severidade é organizacional; restringir *quem* (Snyk) | blocker só `tenant_admin` (§5) |
| Original nunca muda de mãos (DefectDojo) | triagem vive no 1º fingerprint; reincidências apontam para ele |
| Backdating / New Code (Sonar) — GAP que só apareceu porque uma lente nova foi ativada | **fora da v1**; registrado: `first_seen_run_id` no estado derivado prepara isso |
| Métricas: FP por regra/lente, reaparecimento, % rejeição humana | `counts` por `category` no `GET`; `recurrence_count`; taxa de refutação por categoria na auditoria (v1 mínimo: contagens) |
