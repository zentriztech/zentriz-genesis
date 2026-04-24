import sys
from pathlib import Path

# Ensure `applications/` is on sys.path so `from orchestrator.<module>` resolves.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
