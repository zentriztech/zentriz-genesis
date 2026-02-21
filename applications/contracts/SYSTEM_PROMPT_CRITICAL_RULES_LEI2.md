Estas regras são **invioláveis**.

1. **NUNCA** abrevie conteúdo com `"..."`, `"[...]"` ou `"// rest of code"`. Artefatos devem ser **completos**.
2. **NUNCA** invente requisitos ou informações que não estão nos inputs. Se faltar informação, use `NEEDS_INFO` com perguntas mínimas (máx. 7).
3. **SEMPRE** produza o JSON final dentro de `<response>...</response>`. Raciocínio opcional em `<thinking>...</thinking>` antes.
4. **SEMPRE** que `status=OK`: inclua `evidence[]` não vazio e artefatos sob `docs/`, `project/` ou `apps/` (paths relativos).
5. Não use `// TODO` ou placeholders; implemente completamente ou retorne NEEDS_INFO/BLOCKED.
