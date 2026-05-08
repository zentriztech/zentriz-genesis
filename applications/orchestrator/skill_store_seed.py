"""
skill_store_seed.py — Parseia todos os SYSTEM_PROMPTs existentes e os insere
no skill store como skills do tipo 'stack' com status='trusted' e source='seed'.

Cada arquivo SYSTEM_PROMPT.md vira UMA skill representando o prompt completo
daquela especialização. Skills do tipo hard_rule já foram inseridas pela migration
022 e NÃO são duplicadas por este script.

Uso:
  cd applications/orchestrator
  python skill_store_seed.py [--dry-run] [--api-url http://localhost:3333]

Requisitos: requests, GENESIS_API_TOKEN no env
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    print("pip install requests", file=sys.stderr)
    sys.exit(1)

# ── Mapeamento path relativo → (role, stack_key, category, ttl_days) ──────────
# Cada entrada mapeia o caminho relativo dentro de agents/ para os metadados
# que serão gravados no banco.
PROMPT_MAP: list[dict] = [
    # Dev master (especialização dinâmica pelo charter)
    {
        "path": "dev/SYSTEM_PROMPT.md",
        "role": "dev", "stack_key": "generic",
        "category": "stack", "ttl_days": 180,
        "title": "Dev master — especialização dinâmica",
        "slug": "dev.generic.master",
    },
    {
        "path": "dev/backend/nodejs/SYSTEM_PROMPT.md",
        "role": "dev", "stack_key": "nodejs",
        "category": "stack", "ttl_days": 180,
        "title": "Dev Backend Node.js (Express/Fastify + Drizzle)",
        "slug": "dev.nodejs.backend-full",
    },
    {
        "path": "dev/backend/python/SYSTEM_PROMPT.md",
        "role": "dev", "stack_key": "python-fastapi",
        "category": "stack", "ttl_days": 180,
        "title": "Dev Backend Python FastAPI + asyncpg",
        "slug": "dev.python-fastapi.backend-full",
    },
    {
        "path": "dev/web/react-next-materialui/SYSTEM_PROMPT.md",
        "role": "dev", "stack_key": "react-next-materialui",
        "category": "stack", "ttl_days": 180,
        "title": "Dev Frontend Next.js + MUI (Material UI)",
        "slug": "dev.react-next-materialui.frontend-full",
    },
    {
        "path": "dev/web/react-next-tailwind/SYSTEM_PROMPT.md",
        "role": "dev", "stack_key": "react-next-tailwind",
        "category": "stack", "ttl_days": 180,
        "title": "Dev Frontend Next.js + Tailwind CSS",
        "slug": "dev.react-next-tailwind.frontend-full",
    },
    {
        "path": "dev/mobile/react-native/SYSTEM_PROMPT.md",
        "role": "dev", "stack_key": "react-native",
        "category": "stack", "ttl_days": 180,
        "title": "Dev Mobile React Native (CLI, sem Expo)",
        "slug": "dev.react-native.mobile-full",
    },
    # QA
    {
        "path": "qa/SYSTEM_PROMPT.md",
        "role": "qa", "stack_key": "generic",
        "category": "stack", "ttl_days": 180,
        "title": "QA master — especialização dinâmica",
        "slug": "qa.generic.master",
    },
    {
        "path": "qa/backend/nodejs/SYSTEM_PROMPT.md",
        "role": "qa", "stack_key": "nodejs",
        "category": "stack", "ttl_days": 180,
        "title": "QA Backend Node.js/Fastify",
        "slug": "qa.nodejs.backend-full",
    },
    {
        "path": "qa/backend/python/SYSTEM_PROMPT.md",
        "role": "qa", "stack_key": "python-fastapi",
        "category": "stack", "ttl_days": 180,
        "title": "QA Backend Python FastAPI",
        "slug": "qa.python-fastapi.backend-full",
    },
    {
        "path": "qa/backend/lambdas/SYSTEM_PROMPT.md",
        "role": "qa", "stack_key": "lambdas",
        "category": "stack", "ttl_days": 90,
        "title": "QA Backend Serverless Lambdas",
        "slug": "qa.lambdas.backend-full",
    },
    {
        "path": "qa/web/react/SYSTEM_PROMPT.md",
        "role": "qa", "stack_key": "react-next",
        "category": "stack", "ttl_days": 180,
        "title": "QA Frontend React/Next.js",
        "slug": "qa.react-next.frontend-full",
    },
    {
        "path": "qa/mobile/react-native/SYSTEM_PROMPT.md",
        "role": "qa", "stack_key": "react-native",
        "category": "stack", "ttl_days": 180,
        "title": "QA Mobile React Native",
        "slug": "qa.react-native.mobile-full",
    },
    # PM
    {
        "path": "pm/SYSTEM_PROMPT.md",
        "role": "pm", "stack_key": "generic",
        "category": "stack", "ttl_days": 90,
        "title": "PM master — especialização dinâmica",
        "slug": "pm.generic.master",
    },
    {
        "path": "pm/backend/SYSTEM_PROMPT.md",
        "role": "pm", "stack_key": "backend",
        "category": "stack", "ttl_days": 90,
        "title": "PM Backend",
        "slug": "pm.backend.full",
    },
    {
        "path": "pm/web/SYSTEM_PROMPT.md",
        "role": "pm", "stack_key": "web",
        "category": "stack", "ttl_days": 90,
        "title": "PM Frontend Web",
        "slug": "pm.web.full",
    },
    {
        "path": "pm/mobile/SYSTEM_PROMPT.md",
        "role": "pm", "stack_key": "mobile",
        "category": "stack", "ttl_days": 90,
        "title": "PM Mobile",
        "slug": "pm.mobile.full",
    },
    # DevOps
    {
        "path": "devops/SYSTEM_PROMPT.md",
        "role": "devops", "stack_key": "generic",
        "category": "stack", "ttl_days": 180,
        "title": "DevOps master",
        "slug": "devops.generic.master",
    },
    {
        "path": "devops/docker/SYSTEM_PROMPT.md",
        "role": "devops", "stack_key": "docker",
        "category": "stack", "ttl_days": 180,
        "title": "DevOps Docker (docker-compose + Dockerfile)",
        "slug": "devops.docker.full",
    },
    {
        "path": "devops/aws/SYSTEM_PROMPT.md",
        "role": "devops", "stack_key": "aws",
        "category": "stack", "ttl_days": 180,
        "title": "DevOps AWS",
        "slug": "devops.aws.full",
    },
    {
        "path": "devops/azure/SYSTEM_PROMPT.md",
        "role": "devops", "stack_key": "azure",
        "category": "stack", "ttl_days": 180,
        "title": "DevOps Azure",
        "slug": "devops.azure.full",
    },
    {
        "path": "devops/gcp/SYSTEM_PROMPT.md",
        "role": "devops", "stack_key": "gcp",
        "category": "stack", "ttl_days": 180,
        "title": "DevOps GCP",
        "slug": "devops.gcp.full",
    },
    # Engineer / CTO
    {
        "path": "engineer/SYSTEM_PROMPT.md",
        "role": "engineer", "stack_key": "generic",
        "category": "stack", "ttl_days": None,
        "title": "Engineer — proposta técnica e arquitetura",
        "slug": "engineer.generic.full",
    },
    {
        "path": "cto/SYSTEM_PROMPT.md",
        "role": "cto", "stack_key": "generic",
        "category": "stack", "ttl_days": None,
        "title": "CTO — charter e governança",
        "slug": "cto.generic.full",
    },
    # Monitor
    {
        "path": "monitor/backend/SYSTEM_PROMPT.md",
        "role": "dev", "stack_key": "monitor-backend",
        "category": "stack", "ttl_days": 180,
        "title": "Monitor Backend",
        "slug": "monitor.backend.full",
    },
    {
        "path": "monitor/web/SYSTEM_PROMPT.md",
        "role": "dev", "stack_key": "monitor-web",
        "category": "stack", "ttl_days": 180,
        "title": "Monitor Web",
        "slug": "monitor.web.full",
    },
    {
        "path": "monitor/mobile/SYSTEM_PROMPT.md",
        "role": "dev", "stack_key": "monitor-mobile",
        "category": "stack", "ttl_days": 180,
        "title": "Monitor Mobile",
        "slug": "monitor.mobile.full",
    },
]

# skills.md dos subdiretórios — inseridos como skills de domínio
SKILLS_MD_MAP: list[dict] = [
    {
        "path": "engineer/skills.md",
        "role": "engineer", "stack_key": "generic",
        "category": "domain", "ttl_days": None,
        "title": "Engineer skills — competências técnicas",
        "slug": "engineer.generic.skills",
    },
    {
        "path": "cto/skills.md",
        "role": "cto", "stack_key": "generic",
        "category": "domain", "ttl_days": None,
        "title": "CTO skills — competências de governance",
        "slug": "cto.generic.skills",
    },
    {
        "path": "devops/docker/skills.md",
        "role": "devops", "stack_key": "docker",
        "category": "domain", "ttl_days": 180,
        "title": "DevOps Docker skills",
        "slug": "devops.docker.skills",
    },
    {
        "path": "pm/backend/skills.md",
        "role": "pm", "stack_key": "backend",
        "category": "domain", "ttl_days": 90,
        "title": "PM Backend skills",
        "slug": "pm.backend.skills",
    },
    {
        "path": "pm/web/skills.md",
        "role": "pm", "stack_key": "web",
        "category": "domain", "ttl_days": 90,
        "title": "PM Web skills",
        "slug": "pm.web.skills",
    },
    {
        "path": "monitor/backend/skills.md",
        "role": "dev", "stack_key": "monitor-backend",
        "category": "domain", "ttl_days": 180,
        "title": "Monitor Backend skills",
        "slug": "monitor.backend.skills",
    },
]


def compute_origin_ref(content: str) -> str:
    return "seed-" + hashlib.sha256(content.encode()).hexdigest()[:8]


def seed_skills(api_url: str, token: str, agents_root: Path, dry_run: bool) -> None:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    all_entries = PROMPT_MAP + SKILLS_MD_MAP
    seeded = 0
    skipped = 0
    missing = 0

    for entry in all_entries:
        file_path = agents_root / entry["path"]
        if not file_path.exists():
            print(f"  SKIP (not found): {entry['path']}")
            missing += 1
            continue

        body_md = file_path.read_text(encoding="utf-8").strip()
        if not body_md:
            print(f"  SKIP (empty): {entry['path']}")
            skipped += 1
            continue

        payload = {
            "slug":       entry["slug"],
            "role":       entry["role"],
            "category":   entry["category"],
            "stack_key":  entry["stack_key"],
            "title":      entry["title"],
            "body_md":    body_md,
            "hard_rule":  False,
            "source":     "seed",
            "origin_ref": compute_origin_ref(body_md),
            "ttl_days":   entry["ttl_days"],
            "status":     "trusted",
        }

        print(f"  {'[DRY-RUN] ' if dry_run else ''}→ {entry['slug']} ({entry['role']}/{entry['stack_key']}) {len(body_md)} chars")

        if dry_run:
            seeded += 1
            continue

        resp = requests.post(f"{api_url}/api/skills", headers=headers, json=payload, timeout=30)
        if resp.status_code == 201:
            seeded += 1
        elif resp.status_code == 409:
            # Já existe — tentar PATCH para atualizar body_md
            skill_id = _get_skill_id_by_slug(api_url, headers, entry["slug"])
            if skill_id:
                patch_resp = requests.patch(
                    f"{api_url}/api/skills/{skill_id}",
                    headers=headers,
                    json={"body_md": body_md, "origin_ref": compute_origin_ref(body_md)},
                    timeout=30,
                )
                if patch_resp.status_code == 200:
                    print(f"    ↻ updated: {entry['slug']}")
                    seeded += 1
                else:
                    print(f"    ✗ patch failed {patch_resp.status_code}: {patch_resp.text[:200]}")
                    skipped += 1
            else:
                skipped += 1
        else:
            print(f"    ✗ error {resp.status_code}: {resp.text[:300]}")
            skipped += 1

    print(f"\nSeed completo: {seeded} upserted, {skipped} erros, {missing} não encontrados")
    if dry_run:
        print("(dry-run: nenhuma escrita no banco)")


def _get_skill_id_by_slug(api_url: str, headers: dict, slug: str) -> str | None:
    try:
        resp = requests.get(f"{api_url}/api/skills", headers=headers,
                            params={"slug": slug}, timeout=10)
        if resp.ok:
            rows = resp.json().get("data", [])
            for row in rows:
                if row.get("slug") == slug:
                    return row["id"]
    except Exception:
        pass
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed do Skill Store Genesis a partir dos SYSTEM_PROMPTs")
    parser.add_argument("--dry-run", action="store_true", help="Listar sem gravar")
    parser.add_argument("--api-url", default=os.environ.get("GENESIS_API_URL", "http://localhost:3333"),
                        help="URL base da Genesis API")
    parser.add_argument("--agents-root", default=None,
                        help="Caminho para applications/agents/ (detectado automaticamente)")
    args = parser.parse_args()

    token = os.environ.get("GENESIS_API_TOKEN", "")
    if not token and not args.dry_run:
        print("Erro: GENESIS_API_TOKEN não definido. Exporte antes de rodar.", file=sys.stderr)
        sys.exit(1)

    # Auto-detectar agents root
    if args.agents_root:
        agents_root = Path(args.agents_root)
    else:
        # Assumir que o script está em applications/orchestrator/
        script_dir = Path(__file__).resolve().parent
        candidates = [
            script_dir.parent / "agents",
            script_dir.parent.parent / "applications" / "agents",
        ]
        agents_root = next((c for c in candidates if c.exists()), None)
        if not agents_root:
            print(f"Erro: agents/ não encontrado. Tente --agents-root <caminho>", file=sys.stderr)
            sys.exit(1)

    print(f"Agents root: {agents_root}")
    print(f"API URL: {args.api_url}")
    print(f"Dry run: {args.dry_run}")
    print()

    seed_skills(
        api_url=args.api_url,
        token=token,
        agents_root=agents_root,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
