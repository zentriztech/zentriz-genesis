#!/usr/bin/env python3
"""
Teste avulso: verifica se consegue conectar e fazer uma chamada simples ao Claude
usando CLAUDE_API_KEY (carregada do .env da raiz do repo ou do ambiente).

Uso (na raiz do repo):
  python tests/python/test_claude_connection.py
  # ou
  python -m tests.python.test_claude_connection   # com PYTHONPATH=.
"""
from pathlib import Path
import os
import sys
import traceback

# Carregar .env da raiz do repositório
_repo_root = Path(__file__).resolve().parent.parent.parent
_dotenv = _repo_root / ".env"
if _dotenv.exists():
    try:
        from dotenv import load_dotenv
        load_dotenv(_dotenv)
    except ImportError:
        pass

def main() -> int:
    api_key = os.environ.get("CLAUDE_API_KEY")
    if not api_key:
        print("ERRO: CLAUDE_API_KEY não definida. Defina no .env ou no ambiente.", file=sys.stderr)
        return 1

    try:
        from anthropic import Anthropic
    except ImportError:
        print("ERRO: Instale o pacote anthropic: pip install anthropic", file=sys.stderr)
        return 1

    model = os.environ.get("CLAUDE_MODEL", "claude-3-5-sonnet-20241022")
    print(f"Conectando ao Claude (modelo: {model})...", flush=True)
    client = Anthropic(api_key=api_key)

    try:
        response = client.messages.create(
            model=model,
            max_tokens=256,
            system="Você responde apenas com uma frase curta e objetiva.",
            messages=[{"role": "user", "content": "Responda em uma linha: qual é o resultado de 2 + 2?"}],
            timeout=30,
        )
    except Exception as e:
        # Mensagem da fonte (API) em destaque — para interpretação humana e por agentes
        fonte_msg = None
        if hasattr(e, "body") and isinstance(getattr(e, "body"), dict):
            body = getattr(e, "body")
            if isinstance(body.get("error"), dict) and isinstance(body["error"].get("message"), str):
                fonte_msg = body["error"]["message"]
            elif isinstance(body.get("message"), str):
                fonte_msg = body["message"]
        if not fonte_msg and hasattr(e, "message") and isinstance(getattr(e, "message"), str):
            fonte_msg = getattr(e, "message")
        if not fonte_msg and hasattr(e, "response"):
            try:
                r = getattr(e, "response")
                if hasattr(r, "json"):
                    data = r.json()
                    if isinstance(data.get("error"), dict) and isinstance(data["error"].get("message"), str):
                        fonte_msg = data["error"]["message"]
                    elif isinstance(data.get("message"), str):
                        fonte_msg = data["message"]
            except Exception:
                pass
        if not fonte_msg:
            fonte_msg = str(e)

        sep = "=" * 72
        print(sep, file=sys.stderr)
        print("[FONTE — Mensagem da API / erro]", file=sys.stderr)
        print(sep, file=sys.stderr)
        print(fonte_msg, file=sys.stderr)
        print(sep, file=sys.stderr)
        print("Traceback (stack):", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1

    text = response.content[0].text if response.content else ""
    print("Resposta do Claude:")
    print(text)
    print("\nOK — conexão e chamada realizadas com sucesso.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
