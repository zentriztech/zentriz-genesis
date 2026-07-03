#!/usr/bin/env python3
"""
backfill_project_type.py — T-18 Wave 0

Migra projetos existentes que têm `extra->>'project_type'` fora do canônico
via API HTTP do api-node (respeita auth, logs, RLS).

Comportamento por caso:

  1. project_type já canônico             → NO-OP (skip)
  2. project_type em type_aliases         → PATCH extra.project_type = canônico,
                                             extra.project_type_original = raw,
                                             extra.project_type_migrated_at = ISO
  3. project_type desconhecido/vazio      → NÃO faz guess. PATCH:
                                             extra.project_type_needs_manual_review = true,
                                             extra.project_type_original = raw

Uso:

  # Dry-run (default) — mostra o que seria feito sem escrever
  GENESIS_API_URL=http://localhost:3000 GENESIS_API_TOKEN=<jwt> \\
    python3 scripts/backfill_project_type.py

  # Aplicar em staging
  GENESIS_API_URL=... GENESIS_API_TOKEN=<jwt> \\
    python3 scripts/backfill_project_type.py --apply

  # Aplicar em prod (após validação em staging)
  GENESIS_API_URL=https://genesis.zentriz.com.br GENESIS_API_TOKEN=<jwt> \\
    python3 scripts/backfill_project_type.py --apply --confirm-prod

Pré-requisitos:
  - policies.json gerado (ou POLICIES_JSON_PATH exportado)
  - GENESIS_API_URL + GENESIS_API_TOKEN exportados (token de admin)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
POLICIES_CANDIDATES = [
    Path(os.environ["POLICIES_JSON_PATH"]) if os.environ.get("POLICIES_JSON_PATH") else None,
    REPO_ROOT / "applications" / "services" / "api-node" / "src" / "generated" / "policies.json",
    Path.cwd() / "applications" / "services" / "api-node" / "src" / "generated" / "policies.json",
]


def load_policies() -> dict:
    for cand in POLICIES_CANDIDATES:
        if cand and cand.exists():
            with open(cand, encoding="utf-8") as f:
                return json.load(f)
    print("❌ policies.json não encontrado. Candidatos verificados:", file=sys.stderr)
    for cand in POLICIES_CANDIDATES:
        if cand:
            print(f"   - {cand}", file=sys.stderr)
    print("   Rode: python3 scripts/generate_policies_json.py", file=sys.stderr)
    print("   Ou exporte: POLICIES_JSON_PATH=<path>", file=sys.stderr)
    sys.exit(2)


def resolve(raw: str, policies: dict) -> tuple[str, str]:
    """Retorna (canonical, status): already_canonical | aliased | unknown | empty."""
    if not raw or not raw.strip():
        return "", "empty"
    r = raw.strip()
    types = policies.get("types", {})
    aliases = policies.get("type_aliases", {})
    if r in types and r != "_default":
        return r, "already_canonical"
    if r in aliases:
        return aliases[r], "aliased"
    return r, "unknown"


def api_request(method: str, url: str, token: str, body: dict | None = None) -> dict:
    data = None
    if body is not None:
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, method=method, data=data)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body_bytes = resp.read()
            if not body_bytes:
                return {}
            return json.loads(body_bytes.decode())
    except urllib.error.HTTPError as e:
        print(f"❌ {method} {url} → HTTP {e.code}: {e.read().decode()[:400]}", file=sys.stderr)
        raise


def list_projects(api_url: str, token: str) -> list[dict]:
    """Lista projetos via /api/projects — retorna todos que o token pode ver."""
    return api_request("GET", f"{api_url.rstrip('/')}/api/projects", token) or []


def patch_project_extra(api_url: str, token: str, project_id: str, patch: dict) -> None:
    """
    Aplica patch em projects.extra via /api/projects/:id/extra (novo endpoint T-18).
    Fallback: se endpoint não existir (404), usa /api/projects/:id/patch-extra ou
    imprime SQL sugerido para operador manual.
    """
    url = f"{api_url.rstrip('/')}/api/projects/{project_id}/extra"
    try:
        api_request("PATCH", url, token, patch)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"   (endpoint /api/projects/:id/extra ausente — SQL manual: UPDATE projects SET extra = extra || '{json.dumps(patch)}'::jsonb WHERE id = '{project_id}';)")
        else:
            raise


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Executa PATCH (default: dry-run)")
    ap.add_argument("--confirm-prod", action="store_true", help="Confirma execução em produção")
    ap.add_argument("--limit", type=int, default=0, help="Limita quantidade (0 = todos)")
    args = ap.parse_args()

    api_url = os.environ.get("GENESIS_API_URL", "").rstrip("/")
    token = os.environ.get("GENESIS_API_TOKEN", "")
    if not api_url or not token:
        print("❌ GENESIS_API_URL + GENESIS_API_TOKEN obrigatórios", file=sys.stderr)
        return 2

    policies = load_policies()
    version = policies.get("version", "?")
    print("─────────────────────────────────────────────────────────")
    print(f" backfill_project_type — policy v{version}")
    print(f" API: {api_url}")
    print(f" Modo: {'APPLY' if args.apply else 'DRY-RUN'}")
    print("─────────────────────────────────────────────────────────")

    if args.apply and "genesis.zentriz.com.br" in api_url and not args.confirm_prod:
        print("❌ GENESIS_API_URL aponta para produção. Use --confirm-prod para confirmar.", file=sys.stderr)
        return 1

    print("\nBuscando projetos...")
    projects = list_projects(api_url, token)
    if args.limit > 0:
        projects = projects[:args.limit]
    print(f"Total projetos visíveis: {len(projects)}\n")

    counters = {"already_canonical": 0, "aliased": 0, "unknown": 0, "empty": 0, "no_type": 0}
    changes: list[tuple[str, str, str, str]] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for p in projects:
        pid = p.get("id", "")
        title = p.get("title", "?")
        # A API retorna projectType (camelCase) no envelope
        pt = p.get("projectType") or ""
        if not pt:
            counters["no_type"] += 1
            continue

        canonical, status = resolve(pt, policies)
        counters[status] += 1

        if status == "already_canonical":
            continue

        if status == "aliased":
            patch = {
                "project_type": canonical,
                "project_type_original": pt,
                "project_type_migrated_at": now_iso,
            }
            changes.append((pid, title, pt, f"→ {canonical}"))
            if args.apply:
                patch_project_extra(api_url, token, pid, patch)
            continue

        if status == "unknown":
            patch = {
                "project_type_needs_manual_review": True,
                "project_type_original": pt,
                "project_type_migrated_at": now_iso,
            }
            changes.append((pid, title, pt, "MANUAL_REVIEW"))
            if args.apply:
                patch_project_extra(api_url, token, pid, patch)

    print(f" Sem project_type:       {counters['no_type']:>4}")
    print(f" Já canônico:            {counters['already_canonical']:>4}")
    print(f" Resolvidos via alias:   {counters['aliased']:>4}")
    print(f" Desconhecidos (review): {counters['unknown']:>4}")
    print(f" Vazios (review):        {counters['empty']:>4}")

    if changes:
        print(f"\n Mudanças ({'aplicadas' if args.apply else 'seriam aplicadas'}) — {len(changes)} projetos:")
        for pid, title, before, after in changes[:30]:
            print(f"   {pid[:8]}  {title[:40]:40}  {before:30} {after}")
        if len(changes) > 30:
            print(f"   ... e mais {len(changes) - 30} projetos")

    if not args.apply:
        print("\n(dry-run — nenhuma mudança escrita. Rode com --apply para executar.)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
