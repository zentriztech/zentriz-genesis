"""
checklist_seed.py — popula context_cache com 19 checklists de bugs conhecidos.

Idempotente: usa INSERT ... ON CONFLICT (cache_key) DO UPDATE.
Pode ser executado múltiplas vezes com segurança.

Uso:
    python -m applications.orchestrator.checklist_seed
    # ou diretamente: python applications/orchestrator/checklist_seed.py

Requer: DATABASE_URL apontando para o Postgres do Genesis com migration 025 aplicada.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Catálogo de checklists — fonte de verdade
# ─────────────────────────────────────────────────────────────────────────────

# 6 bugs Python/FastAPI (memory: feedback_python_fastapi_bugs)
PYTHON_FASTAPI_CHECKLISTS: list[dict[str, Any]] = [
    {
        "slug": "python.setuptools-80",
        "stack": "python-fastapi",
        "title": "setuptools >= 80 quebra pip install -e",
        "rule": "Pinar setuptools<80 no Dockerfile/requirements quando usar pip install -e .",
    },
    {
        "slug": "python.pydantic.uppercase",
        "stack": "python-fastapi",
        "title": "Pydantic v2 — uppercase em ConfigDict",
        "rule": "Use model_config = ConfigDict(str_to_lower=False) e nunca defina enums em uppercase como string.",
    },
    {
        "slug": "python.fastapi.router-prefix-duplicado",
        "stack": "python-fastapi",
        "title": "Prefixo duplicado em include_router",
        "rule": "Nunca defina prefix tanto em APIRouter(prefix=...) quanto em include_router(..., prefix=...).",
    },
    {
        "slug": "python.fastapi.asyncpg.enum-native",
        "stack": "python-fastapi",
        "title": "ENUM PostgreSQL com asyncpg",
        "rule": "Use sa.Enum(..., create_type=False) e crie o tipo via Alembic com op.execute(\"CREATE TYPE ...\").",
    },
    {
        "slug": "python.fastapi.python-multipart",
        "stack": "python-fastapi",
        "title": "python-multipart obrigatório para uploads",
        "rule": "Adicione python-multipart em requirements.txt sempre que usar UploadFile/Form em FastAPI.",
    },
    {
        "slug": "python.fastapi.insomnia-format",
        "stack": "python-fastapi",
        "title": "Exportar coleção Insomnia (não Postman)",
        "rule": "Gerar arquivo `insomnia.json` no formato Insomnia v4 export, não Postman collection v2.",
    },
]

# 13 bugs Node.js/Drizzle (memory: feedback_nodejs_drizzle_bugs)
NODEJS_DRIZZLE_CHECKLISTS: list[dict[str, Any]] = [
    {
        "slug": "nodejs.drizzle.repositorios-ausentes",
        "stack": "nodejs-drizzle",
        "title": "Repositórios ausentes em src/repositories",
        "rule": "Cada tabela do schema.ts deve ter um repository correspondente exportado em src/repositories/index.ts.",
    },
    {
        "slug": "nodejs.drizzle.migrations-vazias",
        "stack": "nodejs-drizzle",
        "title": "Migration vazia gerada por drizzle-kit",
        "rule": "Após drizzle-kit generate, verifique se o SQL não está vazio. Se estiver, ajuste schema.ts e regenere.",
    },
    {
        "slug": "nodejs.express.errSchema-details-vazio",
        "stack": "nodejs-express",
        "title": "errSchema com details:{} vazio",
        "rule": "Não envie details como objeto vazio; quando não houver detalhes, omita a chave inteira.",
    },
    {
        "slug": "nodejs.express.204-sem-type",
        "stack": "nodejs-express",
        "title": "Resposta 204 sem content-type no schema",
        "rule": "204 No Content NÃO tem body; declare apenas { 204: {} } no schema OpenAPI/zod.",
    },
    {
        "slug": "nodejs.drizzle.seed-fora-dockerfile",
        "stack": "nodejs-drizzle",
        "title": "seed.mjs fora do Dockerfile",
        "rule": "Inclua scripts de seed (seed.mjs, seed.ts) no COPY do Dockerfile final.",
    },
    {
        "slug": "nodejs.drizzle.findall-vs-findmany",
        "stack": "nodejs-drizzle",
        "title": "findAll não existe em Drizzle — usar findMany",
        "rule": "O Drizzle expõe db.query.<tabela>.findMany(). Padronize repositories para findMany.",
    },
    {
        "slug": "nodejs.express.rotas-nao-registradas",
        "stack": "nodejs-express",
        "title": "Rotas não registradas em app.ts",
        "rule": "Para cada router criado, registre via app.use(prefix, router) em src/app.ts ANTES dos middlewares de erro.",
    },
    {
        "slug": "nodejs.fastify.drizzle.mysql-uniques",
        "stack": "nodejs-fastify",
        "title": "Fastify+Drizzle+MySQL — UNIQUEs implícitas",
        "rule": "MySQL não cria índice UNIQUE automaticamente em colunas marcadas .unique() do Drizzle; declare explicitamente em uniqueIndex.",
    },
    {
        "slug": "nodejs.express.body-parser-limit",
        "stack": "nodejs-express",
        "title": "Limite default do body-parser muito baixo",
        "rule": "Configure express.json({ limit: '5mb' }) e express.urlencoded({ extended: true, limit: '5mb' }).",
    },
    {
        "slug": "nodejs.cors-pre-route",
        "stack": "nodejs-express",
        "title": "CORS configurado depois das rotas",
        "rule": "app.use(cors(...)) DEVE vir antes de qualquer app.use(router). Ordem importa.",
    },
    {
        "slug": "nodejs.drizzle.dialect-misconfigured",
        "stack": "nodejs-drizzle",
        "title": "Dialect errado em drizzle.config.ts",
        "rule": "Confirme dialect: 'postgresql' (com tt) ou 'mysql' — não 'postgres'.",
    },
    {
        "slug": "nodejs.zod.errSchema-required",
        "stack": "nodejs-express",
        "title": "errSchema sem required em campos obrigatórios",
        "rule": "z.object({ message: z.string(), code: z.string() }) — não use .optional() em campos sempre presentes.",
    },
    {
        "slug": "nodejs.healthcheck-not-implemented",
        "stack": "nodejs-express",
        "title": "Healthcheck /health não implementado",
        "rule": "Toda API exposta no docker-compose precisa de GET /health retornando { status: 'ok' } sem auth.",
    },
]

ALL_CHECKLISTS: list[dict[str, Any]] = (
    PYTHON_FASTAPI_CHECKLISTS + NODEJS_DRIZZLE_CHECKLISTS
)


# ─────────────────────────────────────────────────────────────────────────────
# Seed
# ─────────────────────────────────────────────────────────────────────────────

def _open_pg():
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        # fallback: montar DSN a partir de PG* env vars (padrão do runner Docker)
        host = os.environ.get("PGHOST", "localhost")
        port = os.environ.get("PGPORT", "5432")
        user = os.environ.get("PGUSER", "genesis")
        password = os.environ.get("PGPASSWORD", "genesis_dev")
        dbname = os.environ.get("PGDATABASE", "zentriz_genesis")
        db_url = f"postgresql://{user}:{password}@{host}:{port}/{dbname}"
    try:
        import psycopg2  # type: ignore
        return psycopg2.connect(db_url)
    except ImportError:
        pass
    try:
        import psycopg  # type: ignore
        return psycopg.connect(db_url)
    except ImportError:
        pass
    # último recurso: urllib-based via requests para API Node (sem driver nativo)
    raise RuntimeError("psycopg2 ou psycopg não encontrado — instale um deles.")


def _build_payload(items: list[dict[str, Any]], stack: str) -> dict[str, Any]:
    return {
        "schemaVersion": "1.1.0",
        "role": "dev",
        "stackKey": stack,
        "connectVersion": os.environ.get("CONNECT_VERSION_PIN", "1.1.0"),
        "mode": "live",
        "bugChecklists": items,
    }


def _estimate_tokens(payload: dict[str, Any]) -> int:
    return max(1, len(json.dumps(payload, ensure_ascii=False)) // 4)


def seed_all(ttl_days: int = 365) -> dict[str, int]:
    """Insere/atualiza checklists em context_cache. Retorna contagens."""
    by_stack: dict[str, list[dict[str, Any]]] = {}
    for item in ALL_CHECKLISTS:
        by_stack.setdefault(item["stack"], []).append(item)

    expires_at = datetime.now(timezone.utc) + timedelta(days=ttl_days)

    inserted = 0
    updated = 0
    conn = _open_pg()
    try:
        with conn:
            with conn.cursor() as cur:
                for stack, items in by_stack.items():
                    payload = _build_payload(items, stack)
                    cache_key = f"cag:dev:{stack}:checklist-bugs"
                    tokens = _estimate_tokens(payload)
                    cur.execute(
                        """
                        INSERT INTO context_cache
                            (cache_key, role, connect_version, project_id,
                             stack_key, category, payload, payload_tokens, expires_at)
                        VALUES (%s, 'dev', %s, NULL, %s, 'checklist',
                                %s::jsonb, %s, %s)
                        ON CONFLICT (cache_key) DO UPDATE
                           SET payload         = EXCLUDED.payload,
                               payload_tokens  = EXCLUDED.payload_tokens,
                               connect_version = EXCLUDED.connect_version,
                               expires_at      = EXCLUDED.expires_at
                         RETURNING (xmax = 0) AS inserted
                        """,
                        (
                            cache_key,
                            os.environ.get("CONNECT_VERSION_PIN", "1.1.0"),
                            stack,
                            json.dumps(payload, ensure_ascii=False),
                            tokens,
                            expires_at,
                        ),
                    )
                    was_inserted = cur.fetchone()[0]
                    if was_inserted:
                        inserted += 1
                    else:
                        updated += 1
    finally:
        try:
            conn.close()
        except Exception:
            pass

    return {"inserted": inserted, "updated": updated, "total": len(by_stack)}


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        result = seed_all()
        logger.info(
            "[checklist_seed] OK — %d inseridos, %d atualizados, %d stacks",
            result["inserted"], result["updated"], result["total"],
        )
        return 0
    except Exception as exc:
        logger.error("[checklist_seed] FAIL — %s", exc, exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
