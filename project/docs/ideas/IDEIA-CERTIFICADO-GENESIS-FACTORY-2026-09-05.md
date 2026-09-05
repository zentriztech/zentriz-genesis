> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Ideia — Certificado "Genesis Factory" na Bancada de Spec

**Data:** 2026-09-05 · **Status:** 💡 ideia em maturação — **nada decidido, nada implementado**
**Pedido (verbatim do Jean):** *"adicionar uma flag certificadora no Produto de Spec da Bancada, no sentido de informar se o modelo já é aceitável por parte da fábrica e exibir no card do produto de spec e outros locais um tipo de certificado Genesis Factory para sinalizar que o projeto agora tem suas especificações no modelo que a fábrica aceita e quando for promovido existe uma maior garantia de sucesso na fabricação."*

---

## 1. Por que isto é necessário (o defeito que existe HOJE, medido no código)

A Bancada **já exibe** um selo de prontidão — e ele **mente**.

`applications/services/api-node/src/services/specEnrichment.ts:145` calcula:

```ts
const level: Readiness["level"] =
  titleOk && techOk && depsOk ? "ready" : titleOk && techOk ? "almost" : "not_ready";
```

São **quatro** sinais rasos (título não-placeholder, `extra->>'project_type'` preenchido, predecessores concluídos, existência de histórico para estimativa). E o portal usa isso como promessa: `apps/genesis-web/app/(dashboard)/specs/page.tsx:461` agrupa a spec na coluna **"Pronto para promover"** quando `readiness.level === "ready"`.

Só que quem decide de verdade é o **choke-point da fábrica**, `services/runnerDispatch.ts` — que aplica, em ordem:

| # | Gate | Função | O readiness de hoje sabe? |
|---|------|--------|---------------------------|
| 1 | Evolução com RFC válido | `evaluateEvolutionGate` | ❌ |
| 2 | Dependências (contrato em disco, não só status) | `checkDependencyGate` | ⚠️ parcial (só status) |
| 3 | Orçamento de LLM do tenant | `budgetExceededMessage` | ❌ |
| 4 | **Validação adversarial da spec** (hash-bound) | `checkSpecValidationGate` | ❌ |
| 5 | Spec existe em disco e é legível | `project_spec_files.file_path` | ❌ |
| 6 | **Conteúdo real** (anti-template/placeholder) | `checkSpecContentReady` | ❌ |
| 7 | Slot de concorrência | `reserveSlot` | ❌ |

Consequência prática: um card pode exibir **"Pronto · 100%"** e a promoção ser recusada com `SPEC_NOT_VALIDATED`, `SPEC_VALIDATION_BLOCKED`, `SPEC_WARNINGS_UNACKED` ou `spec-template/placeholder`. É exatamente a "garantia de sucesso" invertida — o selo hoje **aumenta** a confiança onde ela não existe.

O certificado pedido pelo Jean resolve isso desde que obedeça a **uma regra**: *o selo não pode ter opinião própria — ele é a projeção positiva dos MESMOS gates que a fábrica aplica.*

---

## 2. O que já existe e pode ser reaproveitado (nada aqui precisa ser inventado)

| Peça | Onde | O que entrega ao certificado |
|------|------|------------------------------|
| `spec_validation_runs` (migr. 074) | `status passed/failed`, `findings JSONB`, **`spec_hash`**, `acked_role/acked_at` | veredito adversarial + **vínculo com o conteúdo** (o selo expira sozinho quando a spec muda) |
| `checkSpecValidationGate` | `services/specValidation.ts:514` | a decisão canônica, incluindo triagem RFC-0005 e ack de warnings |
| `spec_finding_triage` (migr. 081/083) | `enrichRunFindings` | só GAP **ativo** conta; ignorado/refutado (auditado) não bloqueia |
| `computeCurrentSpecHash` | `specValidation.ts:114` | hash do que está **em disco** — a verdade, não o editor |
| `checkSpecContentReady` | `services/specContentGate.ts` | anti-template (incidente Cabral 2026-08-29) |
| `connect.yaml` / SpecConnectDeclaration | `config/connect/v1.3.0/spec-connect-declaration.schema.json` + R4 | o "modelo que a fábrica aceita" em forma **machine-readable** |
| `checkDependencyGate` | `services/dependencyGate.ts` | contratos dos predecessores |
| `Readiness`/`ReadinessBadge` | `specEnrichment.ts` + `components/SpecEnrichment.tsx` | ponto de exibição já existente (card, diálogo de promoção) |
| validação por **produto** | 074 aceita `product_id` XOR `project_id` | permite o selo no card do **produto** (o pedido do Jean) |

---

## 3. Desenho v1 (proposta)

### 3.1 O que o certificado afirma — e o que NÃO afirma

> **Certificado Genesis Factory** — *"a especificação deste projeto está no formato que a fábrica aceita e passou a validação adversarial vigente para o conteúdo atual."*

Não afirma (e o texto do selo precisa dizer isso): que a fabricação vai dar certo, que o custo caberá no orçamento, que há slot, nem que as dependências já estão prontas **no momento da promoção** (isso muda com o tempo — é gate de runtime, não certificado).

### 3.2 Os 5 selos (níveis)

| Nível | Chip | Quando |
|-------|------|--------|
| `certified` | 🏅 **Certificado Genesis Factory** (verde, filled) | todos os checks obrigatórios ✅ para o `spec_hash` **atual** |
| `certified_with_acks` | 🏅 Certificado **com ressalvas** (verde, outlined) | idem, mas passou com warnings **reconhecidos** (ack) ou GAPs triados |
| `stale` | ⏳ Certificado **vencido** (cinza) | havia certificado, mas o `spec_hash` mudou → revalidar |
| `blocked` | ⛔ **Não certificado** (vermelho) | algum check obrigatório reprovou (mostra qual) |
| `unknown` | — sem chip | nunca validado (não inventa veredito) |

### 3.3 Checks do certificado (todos derivados de função existente, zero heurística nova)

| Check | Fonte | Obrigatório? |
|-------|-------|--------------|
| C1 — spec existe e é legível em disco | `computeCurrentSpecHash` ≠ null | ✅ |
| C2 — conteúdo real (não template) | `checkSpecContentReady` | ✅ |
| C3 — validação adversarial do hash atual | `spec_validation_runs` + `checkSpecValidationGate` | ✅ |
| C4 — zero GAP **blocker ativo** | `enrichRunFindings` + triagem | ✅ |
| C5 — warnings ativos reconhecidos (ack) | `acked_role/acked_at` | ✅ (rebaixa para `certified_with_acks`) |
| C6 — `connect.yaml` presente e válido contra o schema v1.3.0 | R4 / `spec-connect-declaration.schema.json` | **D2 (a decidir)** |
| C7 — tipo/stack declarados | `extra->>'project_type'` | ✅ (já existe no readiness) |
| C8 — dependências concluídas | `checkDependencyGate` | ❌ informativo (muda com o tempo) |
| C9 — orçamento/slot | budget + slot | ❌ **fora do certificado** (runtime, não spec) |

### 3.4 Onde aparece

1. Card da spec em `/specs` (troca o `ReadinessBadge` por `FactoryCertificateBadge`, com o readiness atual virando detalhe interno);
2. Diálogo de **Promover** (o selo e, se `blocked`, o motivo exato — hoje o usuário descobre pelo erro);
3. Card do **produto** em `/products`: agregado — `certified` só se **todos** os projetos do produto estiverem `certified`/`certified_with_acks` (e mostra `n/m certificados`);
4. Aba **GAPs** da Bancada: o selo como estado-alvo do trabalho de resolução;
5. Dashboard: contador "projetos certificados" (mesma fonte, zero query nova).

### 3.5 Persistência: **derivar, não guardar** (com um cache barato)

Uma tabela `spec_certificates` seria uma segunda fonte de verdade — e certificado desatualizado é pior que certificado nenhum. Proposta: **função pura derivada** (`computeFactoryCertificate`), calculada sob demanda a partir de `spec_validation_runs` + `project_spec_files` + triagem, e **cacheada** por `(project_id, spec_hash)` no `ttlCache` já existente (`src/lib/ttlCache.ts`). Emissão auditável (quem/quando) já vive em `acked_by/acked_role/acked_at` da run.

---

## 4. Revisão adversarial do próprio desenho (R1 → o que ele quebra)

| # | Risco | Severidade | Tratamento proposto |
|---|-------|-----------|---------------------|
| A1 | **Teatro de certificado**: o selo divergir do gate real e virar uma segunda implementação (é o bug de hoje, só mais bonito) | 🔴 alto | O certificado **chama** `checkSpecValidationGate`/`checkSpecContentReady`; teste obrigatório: *para o mesmo projeto, `certified` ⇔ o dispatch não recusa por motivo de spec* |
| A2 | Gate está **OFF** em prod (`SPEC_VALIDATION_GATE=off`) → o selo prometeria uma barreira que não existe | 🔴 alto | O certificado avalia os checks **independente da flag** (ele é informativo) e o chip diz "com o gate desligado, a promoção não é barrada" |
| A3 | **Falsa garantia de fabricação**: spec perfeita ainda falha na fábrica (custo, LLM, infra, dependência externa) | 🟠 médio | Texto do selo fala de **formato aceito**, nunca de sucesso garantido; C8/C9 ficam fora ou informativos |
| A4 | Custo: validar 58 projetos para pintar cards = LLM caro | 🟠 médio | O certificado **não dispara** validação; se não houver run para o hash atual → `unknown`. Validar continua sendo ação explícita (ou do modo autônomo) |
| A5 | **Staleness silenciosa** — spec editada, selo verde | 🔴 alto | Vínculo obrigatório com `spec_hash` do disco; sem run para o hash atual → `stale`/`unknown`. Nunca "verde por inércia" |
| A6 | Selo no **produto** vira média enganosa (20 de 22 certificados parece "quase pronto", mas 2 blockers derrubam a promoção do produto) | 🟠 médio | Agregado é **AND**, com contagem explícita `n/m`; nunca porcentagem sozinha |
| A7 | `certified_with_acks` ser lido como certificado pleno (o ack é humano e pode ser leviano) | 🟡 baixo | Chip visualmente distinto (outlined) + tooltip com quem reconheceu e quando |
| A8 | Multi-tenant: certificado de um tenant vazar em contagem global do dashboard | 🟠 médio | Toda query já é escopada por tenant; teste explícito (família do P0 de vazamento cross-tenant de 2026-09-03) |
| A9 | Os **28 projetos com `file_path` relativo** (D1) reprovam C1 em massa e o dashboard nasce vermelho | 🟡 baixo | É verdade útil, não bug: são exatamente os projetos sem spec em disco. Depende do backfill D1 (em execução hoje) |
| A10 | C6 (`connect.yaml`) obrigatório reprovaria quase todo o acervo atual (specs anteriores ao R4) | 🟠 médio | **D2**: obrigatório só para projeto criado depois do R4, ou selo separado "Connect-ready" |
| A11 | Selo como gate implícito: alguém ligar "só promove se certificado" e travar a operação | 🟠 médio | Certificado nasce **100% informativo**; qualquer uso como gate = flag própria, decidida depois |

---

## 5. GAPs / decisões que precisam do Jean (D1–D5)

| # | Decisão | Opções | Recomendação |
|---|---------|--------|--------------|
| **D1** | O certificado **substitui** o `ReadinessBadge` ou convive com ele? | (a) substitui (readiness vira detalhe) · (b) convive (2 chips) | **(a)** — dois selos concorrentes confundem, e o readiness atual é o que mente hoje |
| **D2** | `connect.yaml` válido é **obrigatório** para certificar? | (a) obrigatório · (b) selo separado "Connect-ready" · (c) informativo | **(b)** — não invalida o acervo pré-R4 e mantém o Connect visível como meta |
| **D3** | Escopo da 1ª entrega | (a) só projeto · (b) projeto + produto · (c) + dashboard | **(b)** — o pedido do Jean cita o card do produto; dashboard depois |
| **D4** | O certificado pode virar **gate** de promoção? | (a) nunca · (b) sim, atrás de flag nova · (c) sim, reusando `SPEC_VALIDATION_GATE` | **(a) agora**, reabrir depois de medir |
| **D5** | Nome exibido | (a) "Certificado Genesis Factory" · (b) "Genesis Factory Ready" · (c) "Pronto para a Fábrica" | **(a)** em PT-BR, com "Genesis Factory" como marca do selo |

---

## 6. Esboço de implementação (só depois de D1–D5)

- **PR1** — `services/factoryCertificate.ts`: `computeFactoryCertificate(db, projectId)` puro + testado, reusando os gates; nenhuma rota nova (entra no payload de `/api/specs` e `/api/products`).
- **PR2** — agregado por produto + cache `(project_id, spec_hash)`.
- **PR3** — `components/FactoryCertificateBadge.tsx` + troca nos 3 pontos de exibição (card, promover, GAPs).
- **PR4** — teste de coerência selo↔dispatch (A1) e testes de tenant (A8).
- Flag: `FACTORY_CERTIFICATE=off` até o Jean aprovar o que aparece na tela.

---

## 7. Estado

Nada implementado. Este documento é o resultado da etapa **pesquisa + adversarial** da regra "pesquisa → adversarial → fechar GAPs → implementar → validar". Próximo passo: o Jean responder D1–D5.
