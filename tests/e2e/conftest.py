"""
Fixtures compartilhadas para testes E2E do pipeline.
Ref: project/docs/E2E_PIPELINE_TEST_GUIDE.md
"""
import os
import sys
from datetime import datetime

# Permitir importar validators (tests/e2e/validators/)
_here = os.path.dirname(os.path.abspath(__file__))
_repo_root = os.path.dirname(os.path.dirname(_here))
if _here not in sys.path:
    sys.path.insert(0, _here)
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

# Spec oficial: project/spec/spec_landing_zentriz.txt
SPEC_FILE = os.path.join(_repo_root, "project", "spec", "spec_landing_zentriz.txt")

REPORTS_DIR = os.path.join(_here, "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)


def pytest_sessionfinish(session, exitstatus):
    """Grava resumo em tests/e2e/reports/ ao final da execução (E2E_CORRECTION_PLAN Fase 4)."""
    try:
        import re
        from pathlib import Path
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = Path(REPORTS_DIR) / ("summary_%s.txt" % ts)
        total = passed = failed = skipped = 0
        junit_path = Path(REPORTS_DIR) / "junit.xml"
        if junit_path.exists():
            xml = junit_path.read_text(encoding="utf-8")
            total_m = re.search(r'tests="(\d+)"', xml)
            failed_m = re.search(r'failures="(\d+)"', xml)
            sk_m = re.search(r'skipped="(\d+)"', xml)
            if total_m:
                total = int(total_m.group(1))
            if failed_m:
                failed = int(failed_m.group(1))
            if sk_m:
                skipped = int(sk_m.group(1))
            passed = max(0, total - failed - skipped)
        content = (
            "E2E Pipeline Landing — Resumo\n"
            + "=" * 40 + "\n"
            + "Data: %s\n" % datetime.now().isoformat()
            + "Exit status: %s\n" % exitstatus
            + "Total: %d | Passed: %d | Failed: %d | Skipped: %d\n" % (total, passed, failed, skipped)
            + "JUnit: %s\n" % os.path.join(REPORTS_DIR, "junit.xml")
        )
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        last_run = Path(REPORTS_DIR) / "summary_last_run.txt"
        try:
            with open(last_run, "w", encoding="utf-8") as f:
                f.write("E2E Pipeline Landing — Última execução\n")
                f.write("=" * 40 + "\n")
                f.write(content.split("=" * 40 + "\n", 1)[-1])
        except Exception:
            pass
    except Exception:
        pass
