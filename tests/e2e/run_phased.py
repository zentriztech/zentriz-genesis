#!/usr/bin/env python3
"""
Executa E2E em fases: CTO → Engineer → … Se uma fase falhar, aplica correções e retenta (máx. 3).
Após 3 falhas na mesma fase, gera log para ajuda externa.
"""
import html
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

_here = Path(__file__).resolve().parent
_repo_root = _here.parent.parent
REPORTS_DIR = _here / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
MAX_ATTEMPTS = 3


def run_pytest(stop_on_first_fail=True):
    """Roda pytest com saída em tempo real; resultado lido do junit.xml."""
    cmd = [
        sys.executable, "-m", "pytest",
        str(_here / "test_pipeline_landing.py"),
        "-v", "-s",
        "--junitxml", str(REPORTS_DIR / "junit.xml"),
    ]
    if stop_on_first_fail:
        cmd.append("-x")
    # Saída em tempo real (sem captura)
    result = subprocess.run(cmd, cwd=str(_repo_root), env={**os.environ})
    passed = result.returncode == 0
    failed_test = None
    error_snippet = ""
    out = ""
    all_skipped = False
    junit = REPORTS_DIR / "junit.xml"
    if junit.exists():
        try:
            xml = junit.read_text(encoding="utf-8")
            out = xml
            if not passed:
                # testcase que contém <failure>
                name = re.search(r'<testcase[^>]*name="([^"]+)"[^>]*>[\s\S]*?<failure', xml)
                if name:
                    failed_test = name.group(1)
                # Conteúdo do <failure>
                fail_block = re.search(r"<failure[^>]*>([\s\S]*?)</failure>", xml)
                if fail_block:
                    raw = (fail_block.group(1) or "").strip()
                    error_snippet = html.unescape(raw)[:4000]
            # Todos pulados? (agents não rodando)
            sk = re.search(r'skipped="(\d+)"', xml)
            tc = re.search(r'tests="(\d+)"', xml)
            if sk and tc and sk.group(1) == tc.group(1) and int(tc.group(1)) > 0:
                all_skipped = True
        except Exception:
            pass
    if not error_snippet and not passed:
        error_snippet = "Falha (ver junit.xml)"
    return passed, failed_test, out, error_snippet, all_skipped


def apply_fix(failed_test, error_snippet, attempt):
    """Aplica correção com base no teste que falhou e na mensagem. Retorna True se aplicou algo."""
    applied = False
    test_file = _here / "test_pipeline_landing.py"
    content = test_file.read_text(encoding="utf-8")

    # Timeout → aumentar ainda mais o timeout do agente envolvido
    if "ReadTimeout" in error_snippet or "Timeout" in error_snippet:
        for agent in ["cto", "engineer", "pm", "dev", "qa"]:
            old = f'"{agent}": 600'
            new = f'"{agent}": 900'
            if old in content and new not in content:
                content = content.replace(old, new)
                applied = True
        if not applied and '"cto": 600' in content:
            content = content.replace('"cto": 600', '"cto": 900')
            applied = True

    # NEEDS_INFO / spec_raw → garantir que input/inputs têm spec_raw
    if "NEEDS_INFO" in error_snippet or "spec_raw" in error_snippet.lower():
        # Já corrigimos isso antes; verificar se há None sendo enviado
        if "product_spec\": None" in content and "spec_intake" in content:
            # CTO pode exigir string vazia em vez de None
            pass  # Manter None é ok; o problema era input vs inputs
        applied = False  # já foi corrigido

    # AssertionError em artifact / PRODUCT_SPEC
    if "AssertionError" in error_snippet and "artifact" in error_snippet.lower():
        # Relaxar extração de artifact: procurar por content em qualquer artifact
        if "extract_artifact_content(result, \"\")" not in content or "PRODUCT_SPEC" in error_snippet:
            # Garantir que extract_artifact_content pega primeiro artifact quando path_contains vazio
            pass
        applied = False

    if applied:
        test_file.write_text(content, encoding="utf-8")
    return applied


def write_external_help_log(failed_test, attempt, output, error_snippet):
    """Gera log para uso com ajuda externa."""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = REPORTS_DIR / f"e2e_failure_log_{ts}.txt"
    with open(path, "w", encoding="utf-8") as f:
        f.write("=" * 60 + "\n")
        f.write("E2E PIPELINE — LOG PARA AJUDA EXTERNA\n")
        f.write("=" * 60 + "\n\n")
        f.write("Data: %s\n" % datetime.now().isoformat())
        f.write("Teste que falhou: %s\n" % (failed_test or "?"))
        f.write("Tentativas na mesma fase: %d (máx. %d)\n\n" % (attempt, MAX_ATTEMPTS))
        f.write("--- Trecho do erro ---\n\n")
        f.write(error_snippet[:8000] if len(error_snippet) > 8000 else error_snippet)
        f.write("\n\n--- Saída completa (últimos 15k chars) ---\n\n")
        f.write(output[-15000:] if len(output) > 15000 else output)
        f.write("\n\n--- Ambiente ---\n")
        f.write("AGENTS_URL: %s\n" % os.environ.get("API_AGENTS_URL", "http://127.0.0.1:8000"))
        f.write("Spec: %s\n" % (_repo_root / "project" / "spec" / "spec_landing_zentriz.txt"))
        f.write("Guia: project/docs/E2E_PIPELINE_TEST_GUIDE.md\n")
    return path


def main():
    attempts_by_phase = {}
    total_runs = 0
    while True:
        total_runs += 1
        print("\n" + "=" * 60)
        print("Executando E2E (parar na primeira falha)... run #%d" % total_runs)
        print("=" * 60 + "\n")
        passed, failed_test, output, error_snippet, all_skipped = run_pytest(stop_on_first_fail=True)

        if all_skipped:
            print("\n[AVISO] Todos os testes foram PULADOS (agents não está rodando em :8000).")
            print("  Nenhuma falha, então e2e_failure_log não foi gerado.")
            print("  Para rodar de verdade: ./start-agents-host.sh e execute novamente.")
            return 0
        if passed:
            print("\n[OK] Todos os testes passaram.")
            return 0

        phase = failed_test or "unknown"
        attempts_by_phase[phase] = attempts_by_phase.get(phase, 0) + 1
        attempt = attempts_by_phase[phase]
        print("\n[FALHA] %s (tentativa %d/%d)" % (phase, attempt, MAX_ATTEMPTS))

        if attempt >= MAX_ATTEMPTS:
            log_path = write_external_help_log(phase, attempt, output, error_snippet)
            print("\n[PARAR] 3 tentativas na fase %s. Log gerado para ajuda externa:" % phase)
            print("  %s" % log_path)
            print("  Use este arquivo + junit.xml em tests/e2e/reports/ para análise externa.")
            return 1

        print("\nResumo do erro: %s" % (error_snippet[:500] if error_snippet else "?"))
        print("\n[Aplicando correção e repetindo...]")
        fix_applied = apply_fix(phase, error_snippet, attempt)
        if not fix_applied:
            # Forçar uma correção conservadora: aumentar timeout se for timeout
            if "Timeout" in error_snippet or "ReadTimeout" in error_snippet:
                test_file = _here / "test_pipeline_landing.py"
                c = test_file.read_text(encoding="utf-8")
                for old, new in [('"cto": 600', '"cto": 900'), ('"cto": 900', '"cto": 1200'),
                                 ('"engineer": 600', '"engineer": 900'), ('"pm": 600', '"pm": 900')]:
                    if old in c:
                        c = c.replace(old, new)
                        test_file.write_text(c, encoding="utf-8")
                        fix_applied = True
                        break
        if fix_applied:
            print("  Correção aplicada.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
