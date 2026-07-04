"""
Testes T-08/T-09: type_fingerprint — grep semântico com synonyms_pt_br.
"""
from __future__ import annotations

import pytest


def test_fingerprint_pass_when_required_tokens_present(tmp_path):
    from orchestrator.type_fingerprint import check_fingerprint

    apps = tmp_path / "apps"
    apps.mkdir()
    (apps / "app.ts").write_text('import fastify from "fastify";\nconst app = fastify();\napp.get("/health", () => ({data: {ok: true}}));')
    (apps / "drizzle.config.ts").write_text('export default { schema: "./schema.ts" };')

    policy = {
        "fingerprint": {
            "required_tokens": {
                "strong": ["fastify", "drizzle", "/health"],
                "soft":   ["helmet"],
            },
            "forbidden_tokens": ["prisma"],
            "synonyms_pt_br": {},
        }
    }

    r = check_fingerprint(tmp_path, policy)
    assert r["pass"] is True
    assert r["missing_strong"] == []
    assert r["forbidden_found"] == []
    assert "helmet" in r["missing_soft"]  # WARN, mas pass=True


def test_fingerprint_fail_when_strong_missing(tmp_path):
    from orchestrator.type_fingerprint import check_fingerprint

    apps = tmp_path / "apps"
    apps.mkdir()
    (apps / "app.ts").write_text('const x = 1;')  # nada relevante

    policy = {
        "fingerprint": {
            "required_tokens": {
                "strong": ["fastify", "drizzle"],
                "soft":   [],
            },
            "forbidden_tokens": [],
            "synonyms_pt_br": {},
        }
    }

    r = check_fingerprint(tmp_path, policy)
    assert r["pass"] is False
    assert "fastify" in r["missing_strong"]
    assert "drizzle" in r["missing_strong"]


def test_fingerprint_fail_when_forbidden_found(tmp_path):
    from orchestrator.type_fingerprint import check_fingerprint

    apps = tmp_path / "apps"
    apps.mkdir()
    (apps / "index.ts").write_text('import { PrismaClient } from "@prisma/client";')

    policy = {
        "fingerprint": {
            "required_tokens": {"strong": [], "soft": []},
            "forbidden_tokens": ["prisma"],
            "synonyms_pt_br": {},
        }
    }

    r = check_fingerprint(tmp_path, policy)
    assert r["pass"] is False
    assert "prisma" in r["forbidden_found"]


def test_fingerprint_synonyms_pt_br_avoid_false_positive(tmp_path):
    """
    Produto PT-BR usa /painel em vez de /dashboard.
    Sem synonyms, marca FAIL.
    Com synonyms {dashboard: [painel]}, deve passar.
    """
    from orchestrator.type_fingerprint import check_fingerprint

    apps = tmp_path / "apps"
    apps.mkdir()
    (apps / "layout.tsx").write_text('export default function Layout() { return <div>/painel</div>; }')

    # SEM synonyms → strong missing
    policy_no_syn = {
        "fingerprint": {
            "required_tokens": {"strong": ["dashboard"], "soft": []},
            "forbidden_tokens": [],
            "synonyms_pt_br": {},
        }
    }
    r1 = check_fingerprint(tmp_path, policy_no_syn)
    assert r1["pass"] is False
    assert "dashboard" in r1["missing_strong"]

    # COM synonyms → satisfaz
    policy_with_syn = {
        "fingerprint": {
            "required_tokens": {"strong": ["dashboard"], "soft": []},
            "forbidden_tokens": [],
            "synonyms_pt_br": {"dashboard": ["painel", "gerenciador"]},
        }
    }
    r2 = check_fingerprint(tmp_path, policy_with_syn)
    assert r2["pass"] is True
    assert r2["missing_strong"] == []


def test_fingerprint_skips_node_modules(tmp_path):
    """node_modules não deve poluir grep — se tiver Prisma lá, não conta."""
    from orchestrator.type_fingerprint import check_fingerprint

    apps = tmp_path / "apps"
    apps.mkdir()
    nm = apps / "node_modules" / "@prisma"
    nm.mkdir(parents=True)
    (nm / "client.js").write_text("module.exports = PrismaClient;")  # ignorado
    (apps / "app.ts").write_text('import fastify from "fastify";')

    policy = {
        "fingerprint": {
            "required_tokens": {"strong": ["fastify"], "soft": []},
            "forbidden_tokens": ["prismaclient"],  # não bate — está em node_modules
            "synonyms_pt_br": {},
        }
    }

    r = check_fingerprint(tmp_path, policy)
    assert r["pass"] is True
    assert r["forbidden_found"] == []


def test_fingerprint_empty_policy_returns_pass(tmp_path):
    """Policy vazia (ou sem fingerprint) → pass trivial."""
    from orchestrator.type_fingerprint import check_fingerprint

    (tmp_path / "apps").mkdir()
    r = check_fingerprint(tmp_path, {})
    assert r["pass"] is True
    assert r["missing_strong"] == []
    assert r["forbidden_found"] == []


def test_fingerprint_short_token_uses_word_boundary(tmp_path):
    """
    Token curto 'bot' NÃO deve bater com 'bottom', 'robot', 'about' etc.
    """
    from orchestrator.type_fingerprint import check_fingerprint

    apps = tmp_path / "apps"
    apps.mkdir()
    (apps / "layout.tsx").write_text('const bottom = "footer"; const about = "info";')

    policy = {
        "fingerprint": {
            "required_tokens": {"strong": ["bot"], "soft": []},
            "forbidden_tokens": [],
            "synonyms_pt_br": {},
        }
    }
    r = check_fingerprint(tmp_path, policy)
    # 'bot' não bate com 'bottom' nem 'about' — deve marcar como missing
    assert r["pass"] is False
    assert "bot" in r["missing_strong"]


def test_summarize_result_pass(tmp_path):
    from orchestrator.type_fingerprint import check_fingerprint, summarize_result

    (tmp_path / "apps").mkdir()
    r = check_fingerprint(tmp_path, {})
    s = summarize_result(r, "backend_api")
    assert "PASS" in s
    assert "backend_api" in s


def test_summarize_result_fail_lists_missing(tmp_path):
    from orchestrator.type_fingerprint import check_fingerprint, summarize_result

    apps = tmp_path / "apps"
    apps.mkdir()
    (apps / "x.ts").write_text("nothing here")

    policy = {"fingerprint": {"required_tokens": {"strong": ["fastify"], "soft": []}, "forbidden_tokens": [], "synonyms_pt_br": {}}}
    r = check_fingerprint(tmp_path, policy)
    s = summarize_result(r, "backend_api")
    assert "FAIL" in s
    assert "fastify" in s


def test_stub_page_detected_as_fail(tmp_path):
    """L-DEV-2/4: página 'em desenvolvimento' numa rota admin = FAIL."""
    from orchestrator.type_fingerprint import check_stub_pages

    apps = tmp_path / "apps" / "src" / "app" / "atendimentos"
    apps.mkdir(parents=True)
    (apps / "page.tsx").write_text(
        "'use client';\nexport default function P(){ return <Alert>Página em desenvolvimento. Deve listar atendimentos.</Alert>; }"
    )
    r = check_stub_pages(tmp_path)
    assert r["pass"] is False
    assert any("atendimentos" in s for s in r["stubs_found"])


def test_institutional_short_page_not_stub(tmp_path):
    """Página /sobre curta NÃO é stub (é simples por design)."""
    from orchestrator.type_fingerprint import check_stub_pages

    apps = tmp_path / "apps" / "src" / "app" / "sobre"
    apps.mkdir(parents=True)
    (apps / "page.tsx").write_text(
        "'use client';\nexport default function Sobre(){ return <Container>Fundada em 2017...</Container>; }"
    )
    r = check_stub_pages(tmp_path)
    assert r["pass"] is True


def test_real_page_not_stub(tmp_path):
    """Página com implementação real (sem markers) não é stub."""
    from orchestrator.type_fingerprint import check_stub_pages

    apps = tmp_path / "apps" / "src" / "app" / "dashboard"
    apps.mkdir(parents=True)
    (apps / "page.tsx").write_text(
        "'use client';\nimport KpiCard from '@/components/KpiCard';\nexport default function D(){ return <KpiCard/>; }"
    )
    r = check_stub_pages(tmp_path)
    assert r["pass"] is True


def test_responsive_pass_when_breakpoints_present(tmp_path):
    """Mobile-first LEI: app com breakpoints MUI passa."""
    from orchestrator.type_fingerprint import check_responsive

    apps = tmp_path / "apps" / "src" / "app" / "dashboard"
    apps.mkdir(parents=True)
    (apps / "page.tsx").write_text(
        "'use client';\nexport default function D(){ return <Grid xs={12} md={6}><Box sx={{ display: { xs: 'block', md: 'flex' } }}/></Grid>; }"
    )
    r = check_responsive(tmp_path)
    assert r["applicable"] is True
    assert r["pass"] is True


def test_responsive_fail_when_no_breakpoints(tmp_path):
    """Mobile-first LEI: app web sem NENHUM breakpoint = FAIL (BLOCKER)."""
    from orchestrator.type_fingerprint import check_responsive, check_fingerprint

    apps = tmp_path / "apps" / "src" / "app" / "dashboard"
    apps.mkdir(parents=True)
    (apps / "page.tsx").write_text(
        "'use client';\nexport default function D(){ return <div style={{width:1200}}>fixo</div>; }"
    )
    r = check_responsive(tmp_path)
    assert r["applicable"] is True
    assert r["pass"] is False
    # e reprova o fingerprint agregado
    fp = check_fingerprint(tmp_path, {})
    assert fp["responsive_missing"] is True
    assert fp["pass"] is False


def test_responsive_na_for_backend(tmp_path):
    """Backend (sem apps/src/app) não é penalizado — N/A."""
    from orchestrator.type_fingerprint import check_responsive

    apps = tmp_path / "apps"
    apps.mkdir(parents=True)
    (apps / "app.ts").write_text('import fastify from "fastify";')
    r = check_responsive(tmp_path)
    assert r["applicable"] is False
    assert r["pass"] is True


def test_responsive_via_appshell_shared_layout(tmp_path):
    """Responsividade concentrada no AppShell compartilhado conta para o app todo."""
    from orchestrator.type_fingerprint import check_responsive

    app = tmp_path / "apps" / "src" / "app" / "dashboard"
    app.mkdir(parents=True)
    (app / "page.tsx").write_text("'use client';\nexport default function D(){ return <div>KPIs</div>; }")
    comp = tmp_path / "apps" / "src" / "components"
    comp.mkdir(parents=True)
    (comp / "AppShell.tsx").write_text(
        "import { useMediaQuery } from '@mui/material';\nexport function AppShell(){ const m = useMediaQuery('(max-width:900px)'); return null; }"
    )
    r = check_responsive(tmp_path)
    assert r["applicable"] is True
    assert r["pass"] is True  # AppShell responsivo cobre o app
