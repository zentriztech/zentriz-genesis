> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Enriquecimento do catálogo da Bancada (`spec_catalog`)

## Contexto

O catálogo da Bancada (`spec_catalog`, semeado pelas migrações `043`/`051`) tinha 81
templates **finos** (média ~409 caracteres): FRs em linha única, **sem** critérios de
aceitação Gherkin (DADO/QUANDO/ENTÃO), sem `project_type` explícito, sem NFRs/modelo de
dados/regras de negócio. Ao usar um desses modelos e promover à fábrica, o pipeline tinha
material pobre para gerar um projeto de qualidade.

Este pacote **enriquece os 81 templates** para specs completas e prontas para a fábrica:
metadados com `project_type`, visão, personas, **FRs com Gherkin concreto e exemplos**,
requisitos não-funcionais, regras de negócio, modelo de dados e stack sugerida. Todos os 81
passam o gate `checkSpecContentReady` (ver `../services/specContentGate.ts`).

## Conteúdo

| Arquivo | Papel |
|---------|-------|
| `specs/<slug>.md` | 81 specs enriquecidas (uma por slug do catálogo) |
| `backup-pre-enrich.json` | Dump dos 81 registros **antes** do enriquecimento (rollback) |
| `gen-enrich-sql.py` | Gera `enrich-catalog.sql` a partir de `specs/` (dollar-quoting) |
| `enrich-catalog.sql` | 81 `UPDATE spec_catalog SET template_markdown=…` (gerado) |

## Por que SQL dollar-quoted e **não** uma migração `NNN_*.sql`

O runner de migrações (`db/init.ts`) faz **split ingênuo por `;`** e remove linhas iniciadas
por `--`. 60 dos 81 markdowns contêm `;` — embuti-los numa migração corromperia o conteúdo.
Por isso o enriquecimento é aplicado por **`psql` real** (que respeita `$tag$…$tag$`),
**fora** do runner de migrações.

## Como aplicar (PROD)

```bash
# regenerar o SQL a partir das specs versionadas
python3 gen-enrich-sql.py
# copiar para o host de prod e aplicar via psql dentro do container do Postgres
scp -i ~/.ssh/zentriz_id enrich-catalog.sql ubuntu@3.220.66.113:/tmp/enrich-catalog.sql
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113 \
  'sudo docker exec -i zentriz-genesis-postgres-1 psql -U genesis -d zentriz_genesis' \
  < enrich-catalog.sql
```

Idempotente (UPDATE por slug); re-aplicar apenas reescreve o mesmo conteúdo. Atômico
(`BEGIN`/`COMMIT`).

## Rollback

`backup-pre-enrich.json` contém o `template_markdown` original de cada slug. Para reverter,
gere UPDATEs a partir desse JSON (mesmo padrão dollar-quoted) e aplique via `psql`.
