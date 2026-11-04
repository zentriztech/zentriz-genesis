"""Tarefa 0.3 do plano EVOLUIR-PROJETO-BANCADA (v2) — reprodução, no lado Python (runner), dos defeitos:

  (c) anexo binário (png/xlsx/pdf) derruba `load_spec_all` (runner.py ~951-965): `read_text(utf-8)` estrito dentro
      de `try/except Exception` que devolve "" ⇒ o caller (runner.py ~5558) cai em `load_spec(spec_path)` e a
      ÁRVORE inteira de spec some em silêncio (só o arquivo primário sobrevive);
  (e) herança de tasks de UM nível (`_inherit_parent_tasks`, runner.py ~3894-3926, pula `TSK-INH-*`) e geração do ID
      `TSK-INH-<resto>` sem a versão de origem ⇒ `TSK-INH-EVO-001` repete entre versões (o upsert da API é por
      `(project_id, task_id)`, routes/projects.ts ~540: a segunda sobrescreve a primeira).

Convenção: cada teste afirma o comportamento CORRETO/DESEJADO. `xfail(strict=True)` = defeito PROVADO (a asserção
correta falha hoje; quando a tarefa 1.x corrigir, o XPASS estrito vira falha e o marcador deve ser removido).
Teste normal = comportamento já correto (refutação) ou controle/caracterização.
Sem rede, sem LLM, sem API real: `_api_get`/`_api_post` são substituídos por fakes em memória.
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

import orchestrator.runner as runner


# ───────────────────────── helpers reutilizáveis (fases 1' em diante) ─────────────────────────

def make_png_bytes() -> bytes:
    """PNG mínimo: assinatura + bytes que NÃO são UTF-8 válido (0xff/0xfe/0x80)."""
    return b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\xff\xfe\x80\xc3\x28" + bytes(range(128, 160))


def make_xlsx_bytes() -> bytes:
    """Pasta .xlsx real (zip com [Content_Types].xml + planilha), comprimida (deflate) ⇒ bytes altos."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types>" + "<Default Extension='xml'/>" * 20 + "</Types>")
        z.writestr("xl/workbook.xml", "<workbook>" + "<sheet name='Entregas'/>" * 50 + "</workbook>")
    return buf.getvalue()


def make_pdf_bytes() -> bytes:
    """PDF mínimo com a linha de comentário binário (%âãÏÓ) que a especificação recomenda."""
    return b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"


def assert_not_utf8(raw: bytes) -> None:
    with pytest.raises(UnicodeDecodeError):
        raw.decode("utf-8")


class FakeSpecApi:
    """Fake de `/api/projects/:id/spec-files` — a lista que o runner concatena (inclui anexos, como a API real)."""

    def __init__(self, tmp_path: Path):
        self.tmp = tmp_path
        self.entries: list[dict] = []

    def add(self, filename: str, content: bytes | str, rel_dir: str = "", mime: str = "text/markdown", primary: bool = False) -> Path:
        d = self.tmp / rel_dir if rel_dir else self.tmp
        d.mkdir(parents=True, exist_ok=True)
        p = d / filename
        p.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
        self.entries.append({"filename": filename, "filePath": str(p), "mimeType": mime, "relDir": rel_dir, "isPrimary": primary})
        return p

    def install(self, monkeypatch) -> None:
        monkeypatch.setattr(runner, "_api_get", lambda path: (list(self.entries), 200))


class FakeTaskStore:
    """Fake em memória de `GET/POST /api/projects/:id/tasks` com o MESMO upsert por (project_id, task_id)
    de `routes/projects.ts` ~540 (a 2ª escrita sobrescreve `requirements` e `module/owner_role`; status terminal é preservado)."""

    def __init__(self) -> None:
        self.tasks: dict[str, dict[str, dict]] = {}

    def seed(self, project_id: str, task_id: str, status: str = "DONE", requirements: str = "", module: str = "backend", owner_role: str = "DEV_BACKEND") -> None:
        self.tasks.setdefault(project_id, {})[task_id] = {
            "taskId": task_id, "status": status, "module": module, "ownerRole": owner_role, "requirements": requirements,
        }

    def install(self, monkeypatch) -> None:
        def api_get(path: str):
            pid = path.split("/")[3]
            return list(self.tasks.get(pid, {}).values()), 200

        def api_post(path: str, body: dict):
            pid = path.split("/")[3]
            for t in body["tasks"]:
                cur = self.tasks.setdefault(pid, {}).get(t["task_id"])
                st = cur["status"] if cur and cur["status"] in ("DONE", "QA_PASS", "QA_FAIL", "BLOCKED") else t.get("status", "ASSIGNED")
                self.tasks[pid][t["task_id"]] = {
                    "taskId": t["task_id"], "status": st, "module": t.get("module", "backend"),
                    "ownerRole": t.get("owner_role", "DEV_BACKEND"), "requirements": t.get("requirements") or (cur or {}).get("requirements", ""),
                }
            return {}, 201

        monkeypatch.setattr(runner, "_api_get", api_get)
        monkeypatch.setattr(runner, "_api_post", api_post)

    def ids(self, project_id: str) -> list[str]:
        return sorted(self.tasks.get(project_id, {}))

    def text(self, project_id: str) -> str:
        return "\n".join(t["requirements"] for t in self.tasks.get(project_id, {}).values())


# ───────────────────────── (c) anexo binário × load_spec_all ─────────────────────────

SPEC_PRIMARIA = "# Spec do produto\n\nTEXTO-PRIMARIO: o app lista entregas.\n"
SPEC_EXTRA = "# Contratos\n\nTEXTO-EXTRA: o endpoint GET /entregas pagina por cursor.\n"

BINARIOS = {
    "print.png": (make_png_bytes, "image/png"),
    "planilha.xlsx": (make_xlsx_bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    "manual.pdf": (make_pdf_bytes, "application/pdf"),
}


def _build_tree(tmp_path: Path, monkeypatch, binary: str | None) -> None:
    api = FakeSpecApi(tmp_path)
    api.add("spec-evolution-v2.md", SPEC_PRIMARIA, primary=True)
    api.add("contratos.md", SPEC_EXTRA, rel_dir="docs")
    api.add("request.md", "# TK-0001\n\nQuero exportar CSV.\n", rel_dir="tickets/TK-0001")
    if binary:
        maker, mime = BINARIOS[binary]
        raw = maker()
        assert_not_utf8(raw)  # pré-condição do teste: o anexo REALMENTE não decodifica como UTF-8
        api.add(binary, raw, rel_dir="tickets/TK-0001/anexos", mime=mime)
    api.install(monkeypatch)


def test_controle_arvore_so_de_texto_concatena_todos_os_arquivos(tmp_path, monkeypatch):
    _build_tree(tmp_path, monkeypatch, binary=None)
    out = runner.load_spec_all("p")
    assert "TEXTO-PRIMARIO" in out and "TEXTO-EXTRA" in out and "# [tickets/TK-0001/request.md]" in out


@pytest.mark.parametrize("binario", sorted(BINARIOS))
@pytest.mark.xfail(
    strict=True,
    reason="DEFEITO 0.3-c: anexo binário faz read_text(utf-8) levantar UnicodeDecodeError dentro do try/except de load_spec_all "
           "(runner.py:~951-965), que devolve '' em silêncio — o caller cai em load_spec(spec_path) e perde a árvore. "
           "Remover o xfail quando corrigido (tarefa 1.5).",
)
def test_anexo_binario_nao_apaga_a_spec_em_silencio(tmp_path, monkeypatch, binario):
    """Desejado: ou ERRO explícito, ou a spec de texto intacta. NUNCA '' silencioso."""
    _build_tree(tmp_path, monkeypatch, binary=binario)
    try:
        out = runner.load_spec_all("p")
    except Exception:
        return  # erro explícito é aceitável (plano 1.5); o proibido é devolver vazio sem avisar
    assert out != "", "load_spec_all devolveu '' (fallback silencioso para o arquivo primário)"
    assert "TEXTO-PRIMARIO" in out and "TEXTO-EXTRA" in out


def test_evidencia_anexo_binario_devolve_vazio_e_o_caller_so_ve_o_primario(tmp_path, monkeypatch, caplog):
    """CARACTERIZAÇÃO (estado atual, verde): o fallback silencioso existe — só um WARNING no log, sem erro."""
    _build_tree(tmp_path, monkeypatch, binary="print.png")
    with caplog.at_level("WARNING"):
        out = runner.load_spec_all("p")
    assert out == ""
    assert any("[load_spec_all] Falha ao carregar spec files" in r.message for r in caplog.records)
    # O caller (runner.py:~5558) faz `if not spec_content: spec_content = load_spec(spec_path)` — só o arquivo primário:
    assert runner.load_spec(Path(tmp_path / "spec-evolution-v2.md")) == SPEC_PRIMARIA
    assert "TEXTO-EXTRA" not in runner.load_spec(Path(tmp_path / "spec-evolution-v2.md"))


@pytest.mark.xfail(
    strict=True,
    reason="DEFEITO 0.3-c: mesmo caminho com UM único arquivo na lista (só o anexo binário) — UnicodeDecodeError engolido, retorno ''. "
           "Remover o xfail quando corrigido (tarefa 1.5).",
)
def test_unico_arquivo_binario_tambem_nao_e_silencioso(tmp_path, monkeypatch):
    api = FakeSpecApi(tmp_path)
    api.add("print.png", make_png_bytes(), mime="image/png")
    api.install(monkeypatch)
    try:
        out = runner.load_spec_all("p")
    except Exception:
        return
    assert out != ""


# ───────────────────────── (e) herança de tasks: um nível e colisão de ID ─────────────────────────

def test_controle_heranca_de_um_nivel_funciona_como_documentado(monkeypatch):
    store = FakeTaskStore(); store.install(monkeypatch)
    store.seed("v1", "TSK-BE-001", requirements="CRUD de entregas")
    assert runner._inherit_parent_tasks("v2", "v1") == 1
    assert store.ids("v2") == ["TSK-INH-BE-001"]


@pytest.mark.xfail(
    strict=True,
    reason="DEFEITO 0.3-e: _inherit_parent_tasks pula TSK-INH-* do pai (runner.py:~3911) ⇒ herança de UM nível: a v3 não conhece "
           "o trabalho da v1. Remover o xfail quando corrigido (tarefa 1.6).",
)
def test_heranca_transitiva_v3_conhece_o_trabalho_da_v1(monkeypatch):
    store = FakeTaskStore(); store.install(monkeypatch)
    store.seed("v1", "TSK-BE-001", requirements="CRUD de entregas")
    runner._inherit_parent_tasks("v2", "v1")                              # v2 herda a TSK-BE-001 da v1
    store.seed("v2", "TSK-EVO-001", requirements="Exportar CSV")           # trabalho próprio da v2 (aceito)
    runner._inherit_parent_tasks("v3", "v2")                              # v3 herda da v2
    assert "CRUD de entregas" in store.text("v3"), f"v3 perdeu o trabalho da v1; tasks herdadas: {store.ids('v3')}"
    assert "Exportar CSV" in store.text("v3")


@pytest.mark.xfail(
    strict=True,
    reason="DEFEITO 0.3-e: o ID herdado é 'TSK-INH-<resto>' sem a versão de origem; TSK-EVO-001 reinicia a cada versão ⇒ colisão "
           "(e, sem o skip de INH, o upsert (project_id, task_id) sobrescreveria). Remover o xfail quando corrigido (tarefa 1.6).",
)
def test_v4_guarda_as_duas_TSK_EVO_001_de_origens_diferentes_sem_colisao(monkeypatch):
    store = FakeTaskStore(); store.install(monkeypatch)
    # v3 (pai da v4) tem a EVO-001 da v2 (herdada) e a EVO-001 da própria v3 (aceita)
    store.seed("v3", "TSK-INH-EVO-001", requirements="[HERDADA da versão anterior — TSK-EVO-001] origem v2: exportar CSV")
    store.seed("v3", "TSK-EVO-001", requirements="origem v3: filtro por data")
    runner._inherit_parent_tasks("v4", "v3")
    text = store.text("v4")
    assert "origem v2" in text and "origem v3" in text, f"v4 perdeu uma das EVO-001; tasks herdadas: {store.ids('v4')}"


def test_evidencia_id_herdado_nao_carrega_a_versao_de_origem(monkeypatch):
    """CARACTERIZAÇÃO (verde): duas versões-pai diferentes com TSK-EVO-001 geram o MESMO ID herdado no filho;
    com o upsert por (project_id, task_id) a segunda sobrescreve os requisitos da primeira."""
    store = FakeTaskStore(); store.install(monkeypatch)
    store.seed("v2", "TSK-EVO-001", requirements="origem v2: exportar CSV")
    store.seed("v3", "TSK-EVO-001", requirements="origem v3: filtro por data")
    runner._inherit_parent_tasks("child", "v2")
    runner._inherit_parent_tasks("child", "v3")
    assert store.ids("child") == ["TSK-INH-EVO-001"]                       # um só ID para duas origens
    assert "origem v3" in store.text("child") and "origem v2" not in store.text("child")   # a 2ª sobrescreveu a 1ª
