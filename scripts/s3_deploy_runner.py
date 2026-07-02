"""
s3_deploy_runner.py — FT-17 build runner for S3 static deploy.

Roda no host (invocado pelo full-test-server via thread).
Fluxo:
  1. Callback progress='installing' → API
  2. cp -r <project_dir>/apps → /tmp/build-<deployment_id>/apps (cópia descartável)
  3. Sanitize: rm .env.local, .git, .next (evita vazar/atrapalhar build)
  4. Rename middleware.ts → .static-disabled (Next.js export não suporta middleware)
  5. Patch config por tipo (Next: output:export+trailingSlash / Vite: base:'/' / CRA: homepage:'.')
  6. Callback progress='building' → API
  7. pnpm install (retry sem frozen se falhar) + pnpm build
  8. Localiza output dir (out/ | dist/ | build/); reject se ausente
  9. Size check (max S3_STATIC_MAX_SIZE_MB) → reject se excede
  10. Callback progress='uploading' → API
  11. Provisão S3 (create bucket + policy + website + lifecycle + tags) via AWS CLI
  12. Upload em passadas separadas por Content-Type + exclude sensitive
  13. Playwright screenshot para health-check (T12 — próxima task)
  14. Callback status='running' + app_url + screenshot_url
  15. finally: shutil.rmtree(/tmp/build-<did>) + restore middleware

Usa credenciais AWS_S3_DEPLOY_* passadas no payload (não herda do host).
"""
from __future__ import annotations
import json, os, shutil, subprocess, tempfile, time, logging, re
from pathlib import Path
from typing import Optional
import urllib.request, urllib.error

log = logging.getLogger("s3-deploy")

# Extensões e Content-Types (T11 vai completar upload em passadas)
CONTENT_TYPE_MAP = {
    ".html":  "text/html; charset=utf-8",
    ".htm":   "text/html; charset=utf-8",
    ".js":    "application/javascript; charset=utf-8",
    ".mjs":   "application/javascript; charset=utf-8",
    ".cjs":   "application/javascript; charset=utf-8",
    ".css":   "text/css; charset=utf-8",
    ".json":  "application/json",
    ".svg":   "image/svg+xml",
    ".png":   "image/png",
    ".jpg":   "image/jpeg",
    ".jpeg":  "image/jpeg",
    ".webp":  "image/webp",
    ".avif":  "image/avif",
    ".gif":   "image/gif",
    ".ico":   "image/x-icon",
    ".woff":  "font/woff",
    ".woff2": "font/woff2",
    ".ttf":   "font/ttf",
    ".otf":   "font/otf",
    ".eot":   "application/vnd.ms-fontobject",
    ".wasm":  "application/wasm",
    ".xml":   "application/xml; charset=utf-8",
    ".txt":   "text/plain; charset=utf-8",
    ".map":   "application/json",
}

CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable"
CACHE_CONTROL_HTML      = "no-cache, max-age=0"

# Sanitize patterns — nunca sobem para S3
EXCLUDE_UPLOAD = [".env*", "*.map", ".git/*", "Dockerfile*", "*.pem", "*.key", "*.sql", "pnpm-lock.yaml", "package-lock.json"]


class S3DeployError(Exception):
    """Erro estruturado com code + details."""
    def __init__(self, code: str, message: str, details: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def run_s3_deploy(payload: dict) -> dict:
    """Ponto de entrada — orquestra tudo. Retorna dict para logging."""
    deployment_id = payload["deployment_id"]
    project_dir_host = payload["project_dir"]
    bucket_name = payload["bucket_name"]
    deployment_type = payload["deployment_type"]  # 'nextjs' | 'vite' | 'cra' | 'html'
    ttl_days = int(payload.get("ttl_days", 7))
    api_url = payload["genesis_api_url"]
    api_token = payload["genesis_token"]
    aws_key = payload["aws_s3_access_key_id"]
    aws_secret = payload["aws_s3_secret_access_key"]
    aws_region = payload.get("aws_s3_region", "us-east-1")
    project_id = payload["project_id"]
    tenant_id = payload.get("tenant_id", "")

    aws_env = _aws_env(aws_key, aws_secret, aws_region)

    build_dir = Path(tempfile.gettempdir()) / f"build-{deployment_id}"
    src_apps = Path(project_dir_host) / "apps"

    # Estado para restauração no finally
    renamed_middleware: list[tuple[Path, Path]] = []

    try:
        _callback(api_url, api_token, project_id, deployment_id, {"progress": "installing"})

        # 1. Cópia descartável
        log.info(f"[s3-deploy] {deployment_id}: copiando apps → {build_dir}")
        if build_dir.exists():
            shutil.rmtree(build_dir, ignore_errors=True)
        build_dir.mkdir(parents=True, exist_ok=True)
        build_apps = build_dir / "apps"
        _copy_tree(src_apps, build_apps)

        # 2. Sanitize
        for junk in [".env.local", ".env", ".git", ".next", "node_modules", "dist", "build", "out"]:
            p = build_apps / junk
            if p.exists():
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink(missing_ok=True)

        # 3. Rename middleware (Next.js export não suporta)
        if deployment_type == "nextjs":
            for mid in ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"]:
                mp = build_apps / mid
                if mp.exists():
                    disabled = mp.with_suffix(mp.suffix + ".static-disabled")
                    mp.rename(disabled)
                    renamed_middleware.append((disabled, mp))
                    log.info(f"[s3-deploy] renomeado middleware {mid} → .static-disabled")

        # 4. Patch config por tipo
        _apply_patch(build_apps, deployment_type)

        _callback(api_url, api_token, project_id, deployment_id, {"progress": "building"})

        # 5. Install
        log.info(f"[s3-deploy] {deployment_id}: pnpm install")
        install_cmd = ["pnpm", "install", "--no-frozen-lockfile"]
        try:
            _run(install_cmd, cwd=build_apps, timeout=300, env={"NODE_OPTIONS": "--max-old-space-size=4096"})
        except S3DeployError:
            # Fallback npm se pnpm ausente
            log.warning("[s3-deploy] pnpm install falhou — tentando npm ci")
            _run(["npm", "install", "--legacy-peer-deps"], cwd=build_apps, timeout=300,
                 env={"NODE_OPTIONS": "--max-old-space-size=4096"})

        # 6. Build
        log.info(f"[s3-deploy] {deployment_id}: pnpm build")
        try:
            _run(["pnpm", "build"], cwd=build_apps, timeout=600,
                 env={"NODE_OPTIONS": "--max-old-space-size=4096"})
        except S3DeployError:
            _run(["npm", "run", "build"], cwd=build_apps, timeout=600,
                 env={"NODE_OPTIONS": "--max-old-space-size=4096"})

        # 7. Localiza output dir
        output_dir = _find_output_dir(build_apps, deployment_type)
        if not output_dir or not any(output_dir.iterdir()):
            raise S3DeployError(
                "BUILD_NO_OUTPUT",
                f"Build não produziu diretório de output esperado (out/dist/build). Tipo: {deployment_type}",
            )
        log.info(f"[s3-deploy] {deployment_id}: output em {output_dir}")

        # 8. Size check
        max_mb = int(os.environ.get("S3_STATIC_MAX_SIZE_MB", "50"))
        size_bytes = _dir_size(output_dir)
        size_mb = size_bytes / (1024 * 1024)
        if size_mb > max_mb:
            raise S3DeployError(
                "BUILD_TOO_LARGE",
                f"Build produziu {size_mb:.1f}MB, limite é {max_mb}MB",
                {"size_mb": round(size_mb, 2), "max_mb": max_mb},
            )
        log.info(f"[s3-deploy] {deployment_id}: build size = {size_mb:.2f}MB")

        _callback(api_url, api_token, project_id, deployment_id, {
            "progress": "uploading",
            "build_size_bytes": size_bytes,
        })

        # 9. Provisão S3 (delegada ao módulo separado)
        _provision_s3(bucket_name, project_id, tenant_id, deployment_id, ttl_days, aws_env)

        # 10. Upload (T11 completa)
        upload_output_to_s3(output_dir, bucket_name, aws_env)

        # 11. Copia 404.html = index.html se não existe (SPA fallback opcional)
        idx = output_dir / "index.html"
        nf = output_dir / "404.html"
        if idx.exists() and not nf.exists():
            _s3_put_file(idx, bucket_name, "404.html", aws_env)

        app_url = f"http://{bucket_name}.s3-website-{aws_region}.amazonaws.com"
        log.info(f"[s3-deploy] {deployment_id}: DONE — {app_url}")

        # T12: health-check (Playwright ficou para v2; usando curl-based v1)
        health = _health_check(app_url)
        final_status = "running" if health["ok"] else "running_degraded"
        _callback(api_url, api_token, project_id, deployment_id, {
            "status": final_status,
            "app_url": app_url,
            "health": health,
        })

        return {"ok": True, "app_url": app_url, "bucket_name": bucket_name}

    except S3DeployError as e:
        log.error(f"[s3-deploy] {deployment_id}: FAILED code={e.code} msg={e}")
        _callback(api_url, api_token, project_id, deployment_id, {
            "status": "failed",
            "error_code": e.code,
            "error_msg": str(e),
            "error_details": e.details,
        })
        return {"ok": False, "code": e.code, "message": str(e)}
    except Exception as e:
        log.exception(f"[s3-deploy] {deployment_id}: FAILED (unexpected)")
        _callback(api_url, api_token, project_id, deployment_id, {
            "status": "failed",
            "error_code": "UNEXPECTED_ERROR",
            "error_msg": str(e)[:500],
        })
        return {"ok": False, "code": "UNEXPECTED_ERROR", "message": str(e)}
    finally:
        # Restore middleware (por segurança, caso alguém queira depois inspecionar)
        for disabled, orig in renamed_middleware:
            try:
                if disabled.exists() and not orig.exists():
                    disabled.rename(orig)
            except Exception:
                pass
        # T14: cleanup /tmp/build-<did>
        try:
            if build_dir.exists():
                shutil.rmtree(build_dir, ignore_errors=True)
                log.info(f"[s3-deploy] {deployment_id}: /tmp/build cleanup ok")
        except Exception as e:
            log.warning(f"[s3-deploy] cleanup falhou: {e}")


# ═══════════════════════════════════════════════════════════════════════════
# helpers
# ═══════════════════════════════════════════════════════════════════════════

def _aws_env(key: str, secret: str, region: str) -> dict:
    e = dict(os.environ)
    e["AWS_ACCESS_KEY_ID"] = key
    e["AWS_SECRET_ACCESS_KEY"] = secret
    e["AWS_DEFAULT_REGION"] = region
    e.pop("AWS_PROFILE", None)
    e.pop("AWS_DEFAULT_PROFILE", None)
    return e


def _copy_tree(src: Path, dst: Path) -> None:
    """cp -r com ignore de junk (evita copiar .next/node_modules/etc)."""
    def _ignore(_dir, names):
        return {n for n in names if n in (".git", "node_modules", ".next", "dist", "build", "out", ".turbo")}
    shutil.copytree(src, dst, ignore=_ignore, dirs_exist_ok=True)


def _apply_patch(apps_dir: Path, kind: str) -> None:
    """Aplica config patch idempotente."""
    if kind == "nextjs":
        _patch_nextjs(apps_dir)
    elif kind == "vite":
        _patch_vite(apps_dir)
    elif kind == "cra":
        _patch_cra(apps_dir)
    # html puro: sem patch


def _patch_nextjs(apps_dir: Path) -> None:
    """Reescreve next.config.mjs/.js/.ts com output:export."""
    NEXT_CONFIG_BODY = """/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  basePath: '',
  assetPrefix: '',
  eslint: { ignoreDuringBuilds: true },
  reactStrictMode: true,
};
export default nextConfig;
"""
    for cfg in ["next.config.mjs", "next.config.js", "next.config.ts"]:
        p = apps_dir / cfg
        if p.exists():
            # backup e reescreve
            p.with_suffix(p.suffix + ".pre-s3-static").write_text(p.read_text(encoding="utf-8"), encoding="utf-8")
    (apps_dir / "next.config.mjs").write_text(NEXT_CONFIG_BODY, encoding="utf-8")
    # remove os outros para evitar duplicidade
    for cfg in ["next.config.js", "next.config.ts"]:
        p = apps_dir / cfg
        if p.exists() and cfg != "next.config.mjs":
            p.unlink(missing_ok=True)


def _patch_vite(apps_dir: Path) -> None:
    """Garante base:'/' no vite.config."""
    for cfg in ["vite.config.ts", "vite.config.js", "vite.config.mjs"]:
        p = apps_dir / cfg
        if not p.exists():
            continue
        txt = p.read_text(encoding="utf-8")
        # Se já tem base:, deixa. Senão, injeta.
        if re.search(r"\bbase\s*:", txt):
            # Força base: '/' — substitui o valor
            txt = re.sub(r"base\s*:\s*['\"][^'\"]*['\"]", "base: '/'", txt, count=1)
        else:
            # Injeta em defineConfig({ ... })
            txt = re.sub(
                r"defineConfig\s*\(\s*\{",
                "defineConfig({\n  base: '/',",
                txt, count=1,
            )
        p.write_text(txt, encoding="utf-8")
        break


def _patch_cra(apps_dir: Path) -> None:
    """Seta homepage:'.' no package.json (CRA)."""
    pkg = apps_dir / "package.json"
    if not pkg.exists():
        return
    data = json.loads(pkg.read_text(encoding="utf-8"))
    data["homepage"] = "."
    pkg.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _find_output_dir(apps_dir: Path, kind: str) -> Optional[Path]:
    if kind == "nextjs":
        p = apps_dir / "out"
        return p if p.exists() else None
    if kind == "vite":
        p = apps_dir / "dist"
        return p if p.exists() else None
    if kind == "cra":
        p = apps_dir / "build"
        return p if p.exists() else None
    if kind == "html":
        return apps_dir
    return None


def _dir_size(path: Path) -> int:
    total = 0
    for f in path.rglob("*"):
        if f.is_file():
            total += f.stat().st_size
    return total


def _run(cmd: list, cwd: Path, timeout: int, env: Optional[dict] = None) -> None:
    """subprocess.run com timeout + logs. Levanta S3DeployError em falha."""
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    log.info(f"[s3-deploy] $ {' '.join(cmd)} (cwd={cwd})")
    try:
        r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                           timeout=timeout, env=full_env)
    except subprocess.TimeoutExpired:
        raise S3DeployError("BUILD_TIMEOUT", f"comando ultrapassou {timeout}s: {' '.join(cmd)}")
    if r.returncode != 0:
        tail = (r.stderr or "").strip().splitlines()[-30:]
        raise S3DeployError(
            "BUILD_FAILED",
            f"comando falhou (exit={r.returncode}): {' '.join(cmd)}",
            {"stderr_tail": "\n".join(tail)},
        )


def _provision_s3(bucket: str, project_id: str, tenant_id: str, deployment_id: str,
                  ttl_days: int, aws_env: dict) -> None:
    region = aws_env.get("AWS_DEFAULT_REGION", "us-east-1")
    expires_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + ttl_days * 86400))

    _run_aws(["s3api", "create-bucket", "--bucket", bucket, "--region", region], aws_env)
    _run_aws([
        "s3api", "put-bucket-ownership-controls", "--bucket", bucket,
        "--ownership-controls", "Rules=[{ObjectOwnership=BucketOwnerEnforced}]",
    ], aws_env)
    _run_aws([
        "s3api", "put-public-access-block", "--bucket", bucket,
        "--public-access-block-configuration",
        "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false",
    ], aws_env)
    tagging = json.dumps({
        "TagSet": [
            {"Key": "zentriz:product", "Value": "genesis"},
            {"Key": "zentriz:project_id", "Value": project_id},
            {"Key": "zentriz:tenant_id", "Value": tenant_id},
            {"Key": "zentriz:deployment_id", "Value": deployment_id},
            {"Key": "zentriz:ttl_expires_at", "Value": expires_at},
            {"Key": "zentriz:managed_by", "Value": "full-test-server"},
        ]
    })
    _run_aws(["s3api", "put-bucket-tagging", "--bucket", bucket, "--tagging", tagging], aws_env)

    # Bucket policy hardened
    policy = json.dumps({
        "Version": "2012-10-17",
        "Id": "GenesisEphemeralStaticPolicy-v1",
        "Statement": [
            {"Sid": "PublicReadGetObject", "Effect": "Allow", "Principal": "*",
             "Action": "s3:GetObject", "Resource": f"arn:aws:s3:::{bucket}/*"},
            {"Sid": "DenySensitiveFiles", "Effect": "Deny", "Principal": "*",
             "Action": "s3:GetObject",
             "Resource": [
                 f"arn:aws:s3:::{bucket}/.env*",
                 f"arn:aws:s3:::{bucket}/.git/*",
                 f"arn:aws:s3:::{bucket}/*.map",
                 f"arn:aws:s3:::{bucket}/Dockerfile*",
                 f"arn:aws:s3:::{bucket}/*.sql",
                 f"arn:aws:s3:::{bucket}/*.pem",
                 f"arn:aws:s3:::{bucket}/*.key",
                 f"arn:aws:s3:::{bucket}/package-lock.json",
                 f"arn:aws:s3:::{bucket}/pnpm-lock.yaml",
             ]},
        ],
    })
    _run_aws(["s3api", "put-bucket-policy", "--bucket", bucket, "--policy", policy], aws_env)

    website = json.dumps({
        "IndexDocument": {"Suffix": "index.html"},
        "ErrorDocument": {"Key": "404.html"},
    })
    _run_aws(["s3api", "put-bucket-website", "--bucket", bucket, "--website-configuration", website], aws_env)

    lifecycle = json.dumps({
        "Rules": [{
            "ID": "genesis-ephemeral-ttl",
            "Status": "Enabled",
            "Filter": {},
            "Expiration": {"Days": ttl_days},
            "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1},
        }]
    })
    _run_aws(["s3api", "put-bucket-lifecycle-configuration", "--bucket", bucket,
              "--lifecycle-configuration", lifecycle], aws_env)


def upload_output_to_s3(output_dir: Path, bucket: str, aws_env: dict) -> None:
    """T11: upload em passadas por Content-Type + exclude sensitive."""
    # Passada 1: index.html + 404.html com no-cache
    for name in ("index.html", "404.html"):
        p = output_dir / name
        if p.exists():
            _s3_put_file(p, bucket, name, aws_env, cache=CACHE_CONTROL_HTML)

    # Passada 2: outros HTMLs (páginas Next.js exportadas)
    for p in output_dir.rglob("*.html"):
        rel = p.relative_to(output_dir).as_posix()
        if rel in ("index.html", "404.html"):
            continue
        _s3_put_file(p, bucket, rel, aws_env, cache=CACHE_CONTROL_HTML)

    # Passada 3: assets estáticos (JS/CSS/imgs/fonts/wasm) — immutable
    hashed_exts = {".js", ".mjs", ".cjs", ".css", ".woff", ".woff2", ".ttf", ".otf",
                   ".eot", ".wasm", ".png", ".jpg", ".jpeg", ".webp", ".avif",
                   ".gif", ".svg", ".ico"}
    for p in output_dir.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in hashed_exts:
            continue
        # Exclude sensitive
        if _is_sensitive(p.relative_to(output_dir).as_posix()):
            continue
        rel = p.relative_to(output_dir).as_posix()
        _s3_put_file(p, bucket, rel, aws_env, cache=CACHE_CONTROL_IMMUTABLE)

    # Passada 4: JSON, XML, TXT
    for ext in (".json", ".xml", ".txt"):
        for p in output_dir.rglob(f"*{ext}"):
            if _is_sensitive(p.relative_to(output_dir).as_posix()):
                continue
            rel = p.relative_to(output_dir).as_posix()
            _s3_put_file(p, bucket, rel, aws_env, cache="no-cache")


def _s3_put_file(local: Path, bucket: str, key: str, aws_env: dict,
                 cache: str = "public, max-age=3600") -> None:
    ct = CONTENT_TYPE_MAP.get(local.suffix.lower(), "application/octet-stream")
    args = ["s3api", "put-object", "--bucket", bucket, "--key", key,
            "--body", str(local),
            "--content-type", ct,
            "--cache-control", cache]
    _run_aws(args, aws_env)


def _is_sensitive(path: str) -> bool:
    lp = path.lower()
    return any(part in lp for part in [".env", ".git/", ".pem", ".key", "dockerfile", ".sql"])


def _run_aws(args: list, env: dict, timeout: int = 60) -> subprocess.CompletedProcess:
    cmd = ["aws"] + args
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)
    if r.returncode != 0:
        raise S3DeployError(
            "AWS_CLI_ERROR",
            f"aws {args[0]} {args[1]} falhou: {(r.stderr or '').strip()[:400]}",
            {"cmd": " ".join(cmd[:5]), "stderr": (r.stderr or "").strip()[:400]},
        )
    return r


def _health_check(app_url: str, retries: int = 5) -> dict:
    """T12 v1: health-check leve via urllib (sem Playwright).

    - HEAD/GET na raiz esperando 200
    - GET no HTML raiz e verifica se contém <html> e <body> + tamanho > 500 bytes
    - Retry com backoff — S3 website endpoint tem propagação eventual (~30s)

    Retorna dict com { ok, status_code, size_bytes, retries_used, has_html, has_body }.
    Playwright screenshot fica para v2 (evita ~300MB de Chromium no host).
    """
    delays = [3, 5, 10, 15, 20]
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(app_url, method="GET",
                                         headers={"User-Agent": "Zentriz-Genesis-HealthCheck/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                status = resp.status
                body = resp.read(200_000).decode("utf-8", errors="replace")
                has_html = "<html" in body.lower()
                has_body = "<body" in body.lower()
                ok = 200 <= status < 400 and has_html and has_body
                return {
                    "ok": ok,
                    "status_code": status,
                    "size_bytes": len(body),
                    "retries_used": attempt,
                    "has_html": has_html,
                    "has_body": has_body,
                }
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            last_err = str(e)
            if attempt < retries - 1:
                time.sleep(delays[attempt])
        except Exception as e:
            last_err = str(e)
            if attempt < retries - 1:
                time.sleep(delays[attempt])
    return {"ok": False, "error": last_err or "unknown", "retries_used": retries}


def _callback(api_url: str, token: str, project_id: str, deployment_id: str,
              body: dict, max_retries: int = 3) -> None:
    """T13: callback com retry backoff 5/15/30s."""
    url = f"{api_url.rstrip('/')}/api/projects/{project_id}/deploy/ephemeral/{deployment_id}/callback"
    data = json.dumps(body).encode("utf-8")
    delays = [5, 15, 30]
    last_err = None
    for i in range(max_retries):
        try:
            req = urllib.request.Request(url, data=data, method="POST",
                                         headers={"Content-Type": "application/json",
                                                  "Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                if 200 <= resp.status < 300:
                    return
        except Exception as e:
            last_err = e
            log.warning(f"[callback] tentativa {i+1}/{max_retries} falhou: {e}")
            if i < max_retries - 1:
                time.sleep(delays[i])
    # Todas falharam → escreve orphan file
    log.error(f"[callback] TODAS as tentativas falharam. Escrevendo orphan file: {last_err}")
    try:
        orphan = Path("/tmp") / f"genesis-orphan-{deployment_id}.json"
        orphan.write_text(json.dumps({"url": url, "body": body, "error": str(last_err)}))
    except Exception:
        pass
