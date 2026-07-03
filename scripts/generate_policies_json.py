#!/usr/bin/env python3
"""
generate_policies_json.py

Converte applications/agents/policies/project_types.yaml → JSON commited em
applications/services/api-node/src/generated/policies.json.

Consumidores JSON:
- api-node/src/routes/telegram.ts   (normalizar tipo antes de persistir)
- api-node/src/routes/projects.ts   (endpoints que expõem tipo)
- genesis-web/spec/page.tsx         (via hook — Wave 2 T-16)

Idempotente: rodar 2x produz o mesmo JSON byte-a-byte (chaves ordenadas,
indent 2, sem trailing whitespace).

Uso:
  python3 scripts/generate_policies_json.py           # gera arquivo
  python3 scripts/generate_policies_json.py --check   # exit 1 se JSON está drifted
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
YAML_PATH = REPO_ROOT / "applications" / "agents" / "policies" / "project_types.yaml"
JSON_PATH = REPO_ROOT / "applications" / "services" / "api-node" / "src" / "generated" / "policies.json"


def load_yaml() -> dict:
    try:
        import yaml
    except ImportError:
        print("❌ pyyaml não instalado. `pip install pyyaml`.", file=sys.stderr)
        sys.exit(2)
    if not YAML_PATH.exists():
        print(f"❌ YAML não encontrado em {YAML_PATH}", file=sys.stderr)
        sys.exit(2)
    with open(YAML_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f)


def serialize(data: dict) -> str:
    """
    Ordenação determinística + indent 2 + trailing newline.
    Necessário para o modo --check bater byte-a-byte.
    """
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="Exit 1 se JSON está drifted em relação ao YAML")
    args = ap.parse_args()

    data = load_yaml()
    new_content = serialize(data)

    if args.check:
        if not JSON_PATH.exists():
            print(f"❌ JSON não existe em {JSON_PATH} (rode `generate_policies_json.py` sem --check)")
            return 1
        current = JSON_PATH.read_text(encoding="utf-8")
        if current != new_content:
            print("❌ policies.json está OUT OF SYNC com project_types.yaml")
            print("   Rode: python3 scripts/generate_policies_json.py")
            return 1
        print(f"✓ policies.json em sincronia com YAML v{data.get('version', '?')}")
        return 0

    JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    JSON_PATH.write_text(new_content, encoding="utf-8")
    print(f"✓ Gerou {JSON_PATH.relative_to(REPO_ROOT)} ({len(new_content):,} chars)")
    print(f"   Tipos:   {len(data.get('types', {}))}")
    print(f"   Aliases: {len(data.get('type_aliases', {}))}")
    print(f"   Version: {data.get('version', '?')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
