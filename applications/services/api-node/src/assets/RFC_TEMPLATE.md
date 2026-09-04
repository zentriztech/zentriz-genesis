# RFC-0001 — <título curto da funcionalidade>

> Modelo de RFC de EVOLUÇÃO (Zentriz Genesis · Bancada). Salve como `docs/rfc/RFC-NNNN-<slug>.md` no
> projeto de evolução. Um RFC por funcionalidade. A fábrica só aceita a promoção com: critérios de
> aceite em Gherkin + `## Impacto` com `files_allowed`. Palavras normativas seguem RFC 2119
> (MUST/SHOULD/MAY = DEVE/DEVERIA/PODE).

- **Status:** proposed | accepted | superseded
- **Data:** AAAA-MM-DD
- **Autor:** <nome/e-mail>
- **Versão-alvo:** vN (SemVer: PATCH | MINOR | MAJOR)

## Sumário
Em 2-4 frases: o que muda para o usuário e por quê.

## Motivação
Problema/oportunidade de negócio. Evidências (pedidos, métricas, incidentes).

## Escopo
**Inclui:** …
**Não-objetivos (fora de escopo):** … (obrigatório listar — é a base do controle de escopo da fábrica)

## Requisitos
- REQ-01 — O sistema DEVE …
- REQ-02 — O sistema DEVERIA …
- REQ-03 — O sistema PODE …

## Critérios de aceite (Gherkin — um por requisito MUST)
### Cenário: <nome>
- **Dado** <estado conhecido do sistema>
- **Quando** <uma ação do usuário/sistema>
- **Então** <resultado OBSERVÁVEL — resposta HTTP, tela, evento, arquivo>

## Compatibilidade
- Tipo (SemVer): MINOR
- breaking: false
- API/eventos: só ADITIVO (novos endpoints/campos opcionais). Se remover/renomear → `breaking: true` e seção `Deprecated`/`Removed` no CHANGELOG.
- Dados: sem migração | expand → migrate → contract (3 tasks)

## Impacto (escopo de arquivos que a fábrica PODE tocar)
```yaml
files_allowed:
  - "apps/api/src/reports/**"
  - "apps/api/src/routes/reports.ts"
  - "apps/web/src/pages/reports/**"
  - "tests/**"
```
Módulos afetados: <lista>. Qualquer arquivo fora desta lista exige nova rodada do RFC (a fábrica NÃO expande o escopo sozinha).

## Contrato Connect (se mudar)
- Interfaces novas: …
- Eventos publicados/consumidos: …
- Dependências novas: …
(Atualize também o `connect.yaml` do projeto.)

## Questões em aberto
- …
