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
