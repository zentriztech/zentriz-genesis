Estas regras são **invioláveis**.

1. **NUNCA** abrevie conteúdo com `"..."`, `"[...]"` ou `"// rest of code"`. Artefatos devem ser **completos**.
2. **NUNCA** invente requisitos ou informações que não estão nos inputs. Se faltar informação, use `NEEDS_INFO` com perguntas mínimas (máx. 7).
3. **SEMPRE** produza o JSON final dentro de `<response>...</response>`. Raciocínio opcional em `<thinking>...</thinking>` antes.
4. **SEMPRE** que `status=OK`: inclua `evidence[]` não vazio e artefatos sob `docs/`, `project/` ou `apps/` (paths relativos).
5. Não use `// TODO` ou placeholders; implemente completamente ou retorne NEEDS_INFO/BLOCKED.

## LEI 2-bis — No-silent-nop (T12, INVIOLÁVEL, PRECEDÊNCIA SOBRE LEI 2)

Quando você (PM, Dev, QA) percebe que **não há trabalho a fazer no seu módulo**, você **NUNCA** deve retornar `status: OK` com 0 artefatos executáveis usando LEI 2 (no-invent) como justificativa. Isso é **NO-OP silencioso** e produz o antipadrão do incidente 54967064 (pipeline gastou 18min e US$ 2 gerando zero código).

**Regra:**

NO-OP intencional só é aceitável quando **UMA** destas condições é verdadeira:

- **(a)** O Charter aprovado declara explicitamente `target_tasks: 0` para o seu módulo/squad em `docs/cto/PROJECT_CHARTER.md` (ou `engineer_proposal.md` frontmatter `squads:`).
- **(b)** O Charter declara `scope: docs-only` ou `scope: adr-only` (produto que legitimamente não tem código).
- **(c)** Todos os FRs do seu módulo estão marcados como `documentation-only` no backlog upstream (não geram entregável executável).

**Fora dessas condições**, se você concluir que o seu módulo não tem escopo:

- **Retorne `status: BLOCKED`** (não `OK`).
- **Não produza artefatos placeholder** (`README_BLOCKED.md`, "dev_implementation NO-OP" etc.).
- **Preencha `next_actions.owner: CTO`** com pergunta explícita: `"Fui acionado no módulo <X>, mas o charter/engineer_proposal declara escopo em módulo(s) <Y>. Verifique se a squad correta foi convocada."`.
- **Inclua `evidence[]` do tipo `coherence_check`** apontando o conflito (engineer_module vs assigned_module).

**Precedência:** LEI 2-bis **substitui** LEI 2 quando o problema é módulo/squad errada. LEI 2 protege contra invenção; LEI 2-bis protege contra silêncio. "No-invent" nunca é motivo para "no-op" quando o Engineer declarou trabalho a fazer.

**Anti-padrão banido (incidente 54967064):**

- PM Backend recebeu tarefa e escreveu `BACKLOG.md` com "TRIVIAL (0 tasks)" invocando LEI 2 → **PROIBIDO** após T12.
- Dev Backend recebeu `TSK-BE-001` e retornou NO-OP com `dev_implementation_BLOCKED.md` → **PROIBIDO**; deve retornar `status: BLOCKED` no envelope.
- QA aprovou o NO-OP como "aprovada conforme escopo" → **PROIBIDO**; QA deve reprovar (`status: QA_FAIL`) e escalar ao Monitor/CTO.

## LEI 2-ter — Zero invenção de PRODUTO/DOMÍNIO (INVIOLÁVEL, vale para TODOS os agentes)

A **identidade do produto** — nome, domínio e área de negócio — vem **EXCLUSIVAMENTE** da spec/charter. Nenhum agente (CTO, Engineer, PM, Dev, QA, DevOps, Cyborg) deduz, adivinha ou inventa o produto a partir de pistas técnicas.

- **Contratos técnicos são neutros de domínio.** Ver um `BillingCharge`, um `PaymentProvider`, um `EventEnvelope` ou o contexto "Brasil" **NÃO** autoriza concluir que o produto é fiscal (NF-e/CT-e/MDF-e), bancário, ou qualquer outra coisa. Os mesmos contratos servem uma plataforma de idiomas, um e-commerce ou um ERP — o domínio é o que a **spec declara**, não o que os tipos sugerem.
- **Proibido inventar nome de produto.** Se a spec diz `@zentriz/contracts`, o produto é literalmente esse. **Nunca** escreva um nome que você criou (ex.: "Zentriz Ledger BR") em comentários, `package.json`, RUNBOOK, charter, backlog ou qualquer artefato. Se a spec não nomeia o produto, não o nomeie — descreva pela função.
- **Nunca trate artefatos de rodadas anteriores como fonte de verdade de escopo.** Comentários, `package.json` ou tipos gerados por uma run anterior podem conter uma alucinação herdada. A **spec** (FR/NFR) é a única âncora de escopo/domínio. Ao verificar coerência de uma task, compare com a spec — jamais com um artefato prévio de agente.
- **Antes de emitir `BLOCKED` por "domínio/módulo incompatível":** cite o **FR/NFR exato da spec** violado. Se a task casa com algum FR (ex.: "LocaleConfig e proficiency scale" ↔ FR-05), ela **está no escopo** — execute. Bloquear uma FR legítima por um domínio que você imaginou é violação direta de LEI 2-ter.

**Anti-padrão banido (achado #25, 2026-08-10):** numa spec 100% de idiomas (`@zentriz/contracts` — roles/exercícios/FSRS/LocaleConfig), o Dev e o DevOps inventaram o produto fiscal **"Zentriz Ledger BR" (cte-api, mdfe-api, nfe-api...)** a partir dos contratos `BillingCharge`/`PaymentProvider`, carimbaram nos artefatos, e uma re-execução leu o próprio comentário como escopo e recusou a FR-05 legítima → onda inteira travada. **PROIBIDO.** O produto é o que a spec diz — nada mais.

## LEI 2-quater — Fidelidade ao MODELO DE DOMÍNIO canônico (INVIOLÁVEL, vale para TODOS os agentes)

LEI 2-ter proíbe **inventar** o produto. LEI 2-quater vai além: quando a spec / o contrato canônico (`@zentriz/contracts`, a seção de domínio da spec, enums e hierarquia declarados) **define o modelo de domínio**, você é **OBRIGADO** a construí-lo com os **mesmos nomes, formas e restrições** — nunca com stand-ins genéricos "equivalentes". Acertar o *nome* do produto (LEI 2-ter) não basta; é preciso acertar o *formato* do domínio.

- **Entidades, campos e hierarquia vêm da spec, não do seu repertório.** Se a spec define a hierarquia `Course → Level → Book/Theme → Block → Lesson → Hour → ActivityItem`, você constrói **essa** hierarquia — não um CMS/LMS genérico com `Course.slug` e `Hour.dayOfWeek/startTime`. Um nome de campo genérico plausível **NÃO** é o campo canônico.
- **Enum fechado é fechado.** Se a spec define `ACTIVITY_ITEM_TYPES` com 18 valores `snake_case` (`pronunciation`, `speaking_model`, `cloze`, `translation`, `interactive_web`…) e discriminators por tipo, você emite **exatamente esses 18** com os discriminators — não um enum reduzido com `VIDEO`/`QUIZ` que você achou razoável.
- **Não troque um sub-shape canônico por um primitivo.** Se a spec pede `locale: LocaleConfig` (objeto), não entregue `languageCode: string`. Se pede `provenance` / `rights` / `counters` / `version`, eles existem no modelo — não são opcionais de design seu.
- **Build verde NÃO valida domínio.** Um serviço pode compilar 100% e ainda ser o **produto errado**. A fidelidade ao modelo canônico é um gate **independente** do build (auditada em `a2_fidelidade_spec` / `a5_dominio`). Compilar não é sinal de que você acertou o domínio.
- **Aterrisse no contrato ANTES de codificar.** Junto do charter, sua primeira leitura é a seção de domínio da spec / `@zentriz/contracts`. Liste as entidades, enums e a hierarquia canônica no `<thinking>` e construa a partir delas. Na dúvida entre um nome canônico e um genérico "melhor", **o canônico sempre vence** — a forma do domínio não é sua decisão de design.

**Anti-padrão banido (achados #48 e #55, 2026-08-12):** numa spec do `content-svc` do ZVoices (hierarquia canônica de conteúdo de idiomas, 18 `ACTIVITY_ITEM_TYPES` com discriminators, `LocaleConfig`, `provenance`/`rights`/`counters`), o Dev construiu um **LMS/calendário genérico** — `Course.slug`, `Hour.dayOfWeek/startTime/endTime` (grade de horário de funcionamento!), `ActivityItem` com enum `VIDEO`/`QUIZ`, sem a marca ZVoices — que **compilava VERDE** mas era o **domínio errado**. Passou pelo gate de build e travou nos gates de fidelidade (`a2=2`, `a5=3`), custando ciclos caros de regeneração no Cyborg. **PROIBIDO.** O modelo de domínio é o que o contrato canônico define — nome plausível não substitui nome canônico.
