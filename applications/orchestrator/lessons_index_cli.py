"""
CLI helper para rodar o indexer de lições (consome outbox → embeddings).

Uso:
    # Bedrock (default; usa a role da instância):
    DATABASE_URL=postgresql://... \
        python -m applications.orchestrator.lessons_index_cli

    # Offline/CI (embedding determinístico, sem rede):
    DATABASE_URL=... RAG_EMBED_PROVIDER=hash \
        python -m applications.orchestrator.lessons_index_cli --force

    # Consulta semântica ad-hoc:
    python -m applications.orchestrator.lessons_index_cli --search "erro de build no NestJS"

Chamável por jobs (cron/outbox worker) ou manualmente após projetos ACCEPTED.
Saída em JSON parseável (stdout).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Indexer de lições (RAG).")
    parser.add_argument("--limit", type=int, default=200,
                        help="Máximo de eventos/lições por rodada.")
    parser.add_argument("--force", action="store_true",
                        help="Indexa lições sem vetor mesmo sem evento pendente na outbox.")
    parser.add_argument("--search", default=None,
                        help="Em vez de indexar, roda uma busca semântica com este texto.")
    parser.add_argument("--project-id", default=None,
                        help="Escopo de projeto para --search (default: só globais).")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from orchestrator.lessons_indexer import run_indexer, semantic_search, active_model_id

    if args.search:
        hits = semantic_search(args.search, project_id=args.project_id, limit=args.limit)
        print(json.dumps({
            "mode": "search", "model_id": active_model_id(),
            "query": args.search, "hits": hits,
        }, ensure_ascii=False, indent=2))
        return 0

    result = run_indexer(limit=args.limit, force=args.force)
    print(json.dumps({"mode": "index", **result}, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
