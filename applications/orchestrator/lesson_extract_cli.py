"""
CLI helper para extrair lições de um projeto sob demanda.

Uso:
    DATABASE_URL=postgresql://... RAG_ENABLED=live \
        python -m applications.orchestrator.lesson_extract_cli <project_id>

    # Modo dry-run (não persiste)
    DATABASE_URL=... RAG_ENABLED=shadow \
        python -m applications.orchestrator.lesson_extract_cli <project_id>

Chamável também por jobs (cron/outbox worker) ou manualmente após project ACCEPTED.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Optional


def _load_dialogue(project_id: str) -> Optional[str]:
    """Carrega diálogo agregado do projeto via DB."""
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        return None
    try:
        try:
            import psycopg2  # type: ignore
            conn = psycopg2.connect(db_url)
        except ImportError:
            import psycopg  # type: ignore
            conn = psycopg.connect(db_url)
    except Exception as exc:
        logging.warning("[lesson_extract_cli] sem DB: %s", exc)
        return None

    try:
        with conn:
            with conn.cursor() as cur:
                # project_dialogue pode ter schema variado; tentar campos comuns.
                cur.execute(
                    "SELECT to_regclass('public.project_dialogue') IS NOT NULL"
                )
                if not cur.fetchone()[0]:
                    return None
                cur.execute(
                    """
                    SELECT COALESCE(
                       string_agg(message, E'\\n' ORDER BY created_at),
                       ''
                    )
                      FROM project_dialogue
                     WHERE project_id = %s::uuid
                    """,
                    (project_id,),
                )
                row = cur.fetchone()
                return (row[0] if row else "") or ""
    except Exception as exc:
        logging.warning("[lesson_extract_cli] erro lendo diálogo: %s", exc)
        return None
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extrai lições de um projeto.")
    parser.add_argument("project_id", help="UUID do projeto")
    parser.add_argument("--stack-key", default="generic")
    parser.add_argument("--text", default=None,
                        help="Texto inline para extrair (em vez do project_dialogue do DB)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from orchestrator.lesson_extractor import LessonExtractor

    text = args.text or _load_dialogue(args.project_id) or ""
    if not text.strip():
        print(
            f"[WARN] Nenhum texto disponível para project={args.project_id}",
            file=sys.stderr,
        )
        return 1

    extractor = LessonExtractor()
    lessons = extractor.extract(text, project_id=args.project_id, stack_key=args.stack_key)
    print(f"Mode: {extractor.mode}")
    print(f"Extracted: {len(lessons)}")
    for ln in lessons:
        print(f"  - {ln.slug}: {ln.title} (conf={ln.confidence:.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
