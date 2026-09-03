"""
executor_bridge.py — Fase 3 (rota B, Lei 8): roteamento do executor NÃO-CONFIÁVEL.

Centraliza PARA ONDE despachar os jobs que rodam código não-confiável do cliente
(`/cyborg-build`, `/cyborg-engineer`, `/cyborg-claude-code`, `/run-full-test`) e COMO
preparar o job quando o executor roda num HOST B remoto e isolado.

Modelo (decisão do Jean — Opção A / Split):
  - O control plane CONFIÁVEL (onde este orquestrador roda) tem o GENESIS_API_TOKEN admin.
  - Os endpoints de DEPLOY (/launch-s3-deploy, /launch-backend-deploy) carregam credenciais
    e FICAM no control plane (via FULL_TEST_SERVER_URL) — NUNCA vão para o Host B.
  - Os endpoints NÃO-CONFIÁVEIS vão para UNTRUSTED_EXECUTOR_URL (Host B) quando setado.

Garantias de segurança:
  - O token admin onipotente NUNCA viaja para o Host B: no caminho remoto mandamos só
    o X-FTS-Token do Host B; o Authorization Bearer admin só é enviado no caminho co-locado.
  - O token de PROJETO escopado (svc:runner + projectId, TTL 6h) é cunhado AQUI (control
    plane, com o admin) e injetado no payload como `genesis_token` — o FTS remoto o usa via
    `_resolve_scoped_token` sem precisar de token admin.
  - Os arquivos do job são embarcados por-job (tar.gz → /ingest-project); nada de volume
    compartilhado (evita vazamento cross-tenant de código).

OFF por padrão: sem UNTRUSTED_EXECUTOR_URL (ou igual a FULL_TEST_SERVER_URL) o executor é
co-locado e tudo se comporta byte-idêntico ao legado (prepare_untrusted_job é no-op).
"""
from __future__ import annotations

import base64
import io
import json
import os
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

# Diretórios/arquivos que NÃO devem viajar no tarball (pesados/derivados/segredos de build).
_TAR_EXCLUDE_DIRS = {
    "node_modules", ".next", ".git", "dist", "build", ".turbo",
    "coverage", ".cache", ".vercel", ".output", "out", ".parcel-cache",
}
_TAR_EXCLUDE_NAMES = {".DS_Store"}
# Teto do tarball descomprimido gerado (anti-acidente); o FTS tem seu próprio teto no ingest.
_TAR_MAX_BYTES = int(os.environ.get("INGEST_MAX_BYTES", str(300 * 1024 * 1024)))


def _full_test_url() -> str:
    return os.environ.get("FULL_TEST_SERVER_URL", "http://host.docker.internal:7878").rstrip("/")


def executor_url() -> str:
    """URL do FTS que roda o CÓDIGO NÃO-CONFIÁVEL. Default = FULL_TEST_SERVER_URL (co-locado)."""
    return (os.environ.get("UNTRUSTED_EXECUTOR_URL", "").rstrip("/")) or _full_test_url()


def executor_is_remote() -> bool:
    """True quando o executor roda num host separado (Host B), i.e. UNTRUSTED_EXECUTOR_URL
    está setado E é diferente do FULL_TEST_SERVER_URL local."""
    u = os.environ.get("UNTRUSTED_EXECUTOR_URL", "").rstrip("/")
    return bool(u) and u != _full_test_url()


def _admin_token() -> str:
    return (os.environ.get("GENESIS_API_TOKEN") or os.environ.get("GENESIS_INTERNAL_TOKEN") or "").strip()


def _fts_token_for_executor() -> str:
    """Token de auth do FTS. No caminho REMOTO usa o token do Host B
    (UNTRUSTED_EXECUTOR_FTS_TOKEN) se presente; senão cai no FTS_AUTH_TOKEN. No caminho
    co-locado usa o FTS_AUTH_TOKEN local. Mantê-los distintos garante que, se o executor
    vazar o token do Host B, ele não alcança o FTS do control plane (que tem os deploys)."""
    if executor_is_remote():
        return (os.environ.get("UNTRUSTED_EXECUTOR_FTS_TOKEN") or os.environ.get("FTS_AUTH_TOKEN") or "").strip()
    return (os.environ.get("FTS_AUTH_TOKEN") or "").strip()


def mint_scoped_token(project_id: str, timeout: float = 15.0) -> str:
    """Cunha um token de PROJETO (svc:runner + projectId) via POST /api/internal/cyborg-token,
    autenticando com o token admin (que fica SÓ no control plane). Retorna "" em falha."""
    admin = _admin_token()
    if not admin:
        return ""
    base = os.environ.get("API_BASE_URL", "http://api:3000").rstrip("/")
    url = f"{base}/api/internal/cyborg-token"
    data = json.dumps({"projectId": project_id}).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json",
        "X-Internal-Token": admin,
        "Authorization": f"Bearer {admin}",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read().decode())
            return (resp.get("token") or "").strip()
    except Exception:
        return ""


def _iter_files(proj_dir: Path):
    """Caminha proj_dir pulando diretórios excluídos (poda in-place p/ não descer em node_modules)."""
    for dirpath, dirnames, filenames in os.walk(proj_dir):
        dirnames[:] = [d for d in dirnames if d not in _TAR_EXCLUDE_DIRS]
        for fn in filenames:
            if fn in _TAR_EXCLUDE_NAMES:
                continue
            yield Path(dirpath) / fn


def _build_tar_b64(proj_dir: Path) -> str:
    """Empacota proj_dir (arcnames relativos) em tar.gz e devolve base64. Exclui pesados/derivados.
    Segue arquivos regulares apenas (ignora symlinks para não vazar/escapar)."""
    buf = io.BytesIO()
    total = 0
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for f in _iter_files(proj_dir):
            if f.is_symlink() or not f.is_file():
                continue
            arcname = str(f.relative_to(proj_dir))
            try:
                size = f.stat().st_size
            except OSError:
                continue
            total += size
            if total > _TAR_MAX_BYTES:
                raise RuntimeError(f"projeto excede teto de tarball ({_TAR_MAX_BYTES} bytes)")
            tf.add(str(f), arcname=arcname, recursive=False)
    return base64.b64encode(buf.getvalue()).decode()


def _fts_headers() -> dict:
    """Cabeçalhos p/ o executor. X-FTS-Token SEMPRE. Authorization admin SÓ co-locado —
    jamais mandamos o token admin onipotente pela rede a um host não-confiável."""
    headers = {"Content-Type": "application/json"}
    tok = _fts_token_for_executor()
    if tok:
        headers["X-FTS-Token"] = tok
    if not executor_is_remote():
        admin = _admin_token()
        if admin:
            headers["Authorization"] = f"Bearer {admin}"
    return headers


def _post(url: str, body: dict, timeout: int) -> tuple[int, str]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers=_fts_headers())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return 0, f"error: {e}"


def ship_project(project_id: str, prod_id: str | None, proj_dir: Path, timeout: int = 120) -> str:
    """Embarca os arquivos do projeto no executor remoto via /ingest-project. Fail-closed:
    levanta RuntimeError em falha (o job não deve rodar sem os arquivos certos no Host B).
    Retorna o caminho absoluto do projeto no executor remoto (campo `target` do ingest)."""
    if not proj_dir.exists():
        raise RuntimeError(f"proj_dir inexistente para embarque: {proj_dir}")
    tar_b64 = _build_tar_b64(proj_dir)
    status, text = _post(f"{executor_url()}/ingest-project", {
        "project_id": project_id, "prod_id": prod_id or "", "tar_gz_b64": tar_b64,
    }, timeout)
    if status != 200:
        raise RuntimeError(f"/ingest-project falhou ({status}): {text[:400]}")
    try:
        return (json.loads(text).get("target") or "").strip()
    except Exception:
        return ""


def prepare_untrusted_job(payload: dict, project_id: str, prod_id: str | None,
                          proj_dir: Path) -> dict:
    """Prepara um job NÃO-CONFIÁVEL para despacho.
    - Co-locado (local): NO-OP — devolve o payload inalterado (legado byte-idêntico).
    - Remoto (Host B): cunha o token escopado (com o admin, aqui no control plane) e o injeta
      como `genesis_token`; embarca os arquivos do projeto. Fail-closed: RuntimeError em falha."""
    if not executor_is_remote():
        return payload
    token = mint_scoped_token(project_id)
    if not token:
        raise RuntimeError("não foi possível cunhar token escopado p/ executor remoto (fail-closed)")
    ship_project(project_id, prod_id, proj_dir)
    out = dict(payload)
    out["genesis_token"] = token
    return out


def dispatch(path: str, payload: dict, project_id: str, prod_id: str | None,
             proj_dir: Path, timeout: int) -> tuple[int, str]:
    """Prepara (se remoto) e despacha um job não-confiável ao executor. Retorna (status, text)
    como o `_http` dos orquestradores (0 em erro de transporte)."""
    body = prepare_untrusted_job(payload, project_id, prod_id, proj_dir)
    return _post(f"{executor_url()}{path}", body, timeout)


def dispatch_full_test(base_payload: dict, project_id: str, prod_id: str | None,
                       proj_dir: Path, prompt_rel: str, timeout: int) -> tuple[int, str]:
    """Despacha /run-full-test ao executor não-confiável.

    O /run-full-test lê `project_path`/`prompt_path` do FILESYSTEM do executor (não é o
    layout prod_id/project_id do cyborg). No caminho REMOTO (Host B): embarca os arquivos,
    usa o `target` devolvido pelo /ingest-project como `project_path`, reescreve o
    `prompt_path` para <target>/<prompt_rel>, injeta o token escopado e REMOVE credenciais
    que não devem viajar (api_key — o Host B usa Bedrock via instance role). No caminho
    co-locado: NO-OP (payload byte-idêntico ao legado)."""
    if not executor_is_remote():
        return _post(f"{executor_url()}/run-full-test", base_payload, timeout)
    target = ship_project(project_id, prod_id, proj_dir)
    if not target:
        raise RuntimeError("/ingest-project não devolveu `target` p/ /run-full-test remoto (fail-closed)")
    token = mint_scoped_token(project_id)
    if not token:
        raise RuntimeError("não foi possível cunhar token escopado p/ /run-full-test remoto (fail-closed)")
    body = dict(base_payload)
    body["project_path"] = target
    body["prompt_path"] = f"{target.rstrip('/')}/{prompt_rel.lstrip('/')}"
    body["genesis_token"] = token
    body.pop("api_key", None)  # segredo do control plane — nunca ao Host B
    return _post(f"{executor_url()}/run-full-test", body, timeout)
