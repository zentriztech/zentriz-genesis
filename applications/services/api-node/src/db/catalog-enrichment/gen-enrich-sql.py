#!/usr/bin/env python3
"""Gera enrich-catalog.sql com UPDATEs dollar-quoted (psql real, NÃO o runner naive).
Cada UPDATE usa uma tag $md_NN$ única por slug; verifica que o markdown não contém a tag.
Envolve tudo em BEGIN/COMMIT para atomicidade. Slugs são kebab-case (sem aspas)."""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
NEW = os.path.join(HERE, "specs")
OUT = os.path.join(HERE, "enrich-catalog.sql")

files = sorted(f for f in os.listdir(NEW) if f.endswith(".md"))
assert len(files) == 81, f"esperava 81, achei {len(files)}"

lines = [
    "-- enrich-catalog.sql — atualiza spec_catalog.template_markdown com specs enriquecidas.",
    "-- Aplicar com psql REAL (dollar-quoting), NUNCA pelo runner naive de migrations.",
    "-- Gerado automaticamente. Atômico (BEGIN/COMMIT). Idempotente (UPDATE por slug).",
    "BEGIN;",
]
for i, fn in enumerate(files):
    slug = fn[:-3]
    if not re.fullmatch(r"[a-z0-9-]+", slug):
        sys.exit(f"slug inseguro: {slug}")
    md = open(os.path.join(NEW, fn), encoding="utf-8").read().rstrip() + "\n"
    tag = f"$md_{i:02d}$"
    if tag in md:
        sys.exit(f"colisão de tag {tag} em {slug}")
    lines.append(f"UPDATE spec_catalog SET template_markdown = {tag}{md}{tag} WHERE slug = '{slug}';")

lines.append("COMMIT;")
open(OUT, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print(f"OK: {OUT} ({len(files)} UPDATEs, {os.path.getsize(OUT)} bytes)")
