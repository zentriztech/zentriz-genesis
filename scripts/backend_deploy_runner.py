"""
backend_deploy_runner.py — G1-T11 (GATE 1): build+push da imagem backend para o ECR.

Roda no HOST (invocado pelo full-test-server via thread) porque só o host tem
docker + aws-cli — espelho EXATO do s3_deploy_runner.py, mas o alvo é uma imagem
de container no ECR (não um bucket S3).

Fluxo (única etapa docker do provisionamento backend):
  1. Callback progress='installing' → API
  2. git clone (branch dev, installation token, sem persistir token em disco)
  3. Localiza o diretório do serviço (apps/ OU raiz); exige Dockerfile presente
  4. Callback progress='building' → API
  5. docker build --platform linux/amd64 --tag <ecr_uri>:<tag>
  6. aws ecr create-repository (idempotente: captura RepositoryAlreadyExistsException)
  7. aws ecr get-login-password | docker login
  8. Callback progress='pushing' → API
  9. docker push <ecr_uri>:<tag>
  10. aplica tags zentriz:* no repositório ECR (replica s3_deploy_runner:451-456)
  11. Callback progress='pushed' + image_uri  → API (o orquestrador SDK segue daqui)
  12. finally: shutil.rmtree(/tmp/backend-build-<did>)

NÃO cria ECS/RDS/ALB: isso é o control-plane SDK in-process (deployBackendCloud, G1-T12).
Este runner faz SÓ a etapa docker+push, que precisa do host.

Usa credenciais AWS passadas no payload (não herda do host). GATE 1 = conta Zentriz.
"""
from __future__ import annotations
import json, os, shutil, subprocess, tempfile, time, logging
from pathlib import Path
from typing import Optional
import urllib.request, urllib.error

log = logging.getLogger("backend-deploy")


class BackendDeployError(Exception):
    """Erro estruturado com code + details (espelha S3DeployError)."""
    def __init__(self, code: str, message: str, details: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def run_backend_deploy(payload: dict) -> dict:
    """Ponto de entrada — orquestra clone+build+push ECR. Retorna dict para logging."""
    deployment_id = payload["deployment_id"]
    project_id = payload["project_id"]
    tenant_id = payload.get("tenant_id", "")
    api_url = payload["genesis_api_url"]
    api_token = payload["genesis_token"]
    aws_key = payload.get("aws_access_key_id", "")
    aws_secret = payload.get("aws_secret_access_key", "")
    aws_region = payload.get("aws_region", "us-east-1")
    aws_profile = payload.get("aws_profile", "")

    # ECR: nome do repo determinístico + tag da imagem (deployment_id[:8] por default).
    ecr_repo_name = payload["ecr_repo_name"]
    image_tag = payload.get("image_tag") or deployment_id[:8]

    # Fonte do build = repositório GitHub do projeto (branch dev por default).
    git_clone_url = payload.get("git_clone_url", "")
    git_branch = payload.get("git_branch", "dev")
    git_token = payload.get("git_installation_token", "")
    git_repo_full_name = payload.get("git_repo_full_name", "")
    if not git_clone_url or not git_token:
        raise BackendDeployError(
            "REPO_REQUIRED",
            "Deploy backend exige repositório GitHub configurado. Backend deveria ter validado antes.",
        )

    aws_env = _aws_env(aws_key, aws_secret, aws_region, aws_profile)
    build_dir = Path(tempfile.gettempdir()) / f"backend-build-{deployment_id}"

    try:
        _callback(api_url, api_token, project_id, deployment_id, {"progress": "installing"})

        # 1. Clone do repositório GitHub (fonte de verdade).
        log.info(f"[backend-deploy] {deployment_id}: clone {git_repo_full_name}@{git_branch}")
        if build_dir.exists():
            shutil.rmtree(build_dir, ignore_errors=True)
        build_dir.mkdir(parents=True, exist_ok=True)
        clone_dir = build_dir / "repo"
        _git_clone(git_clone_url, git_token, git_branch, clone_dir, deployment_id)

        # 2. Localiza o diretório do serviço. Single-service: apps/ (convenção Genesis)
        #    ou service_dir explícito no payload (multi-serviço, [EXT] T24).
        service_subdir = (payload.get("service_dir") or "").strip("/")
        if service_subdir:
            svc_dir = clone_dir / service_subdir
        else:
            svc_dir = clone_dir / "apps" if (clone_dir / "apps").exists() else clone_dir

        # O build CONTEXT é svc_dir (onde vivem package.json, src/). O DOCKERFILE, porém,
        # pode estar em project/ (convenção do pipeline Genesis — DevOps gera project/Dockerfile
        # com "Context de build: ../apps"). Além disso o Dockerfile de project/ faz
        # `COPY docker-entrypoint.sh` — que também vive em project/, não em apps/. Como o
        # docker build só enxerga arquivos DENTRO do context, quando o Dockerfile está em
        # project/ copiamos Dockerfile + entrypoint (e afins) para dentro de svc_dir antes
        # do build. É determinístico e espelha o que o full-test já faz com sucesso.
        dockerfile = svc_dir / "Dockerfile"
        if not dockerfile.exists():
            project_dir = clone_dir / "project"
            root_df = clone_dir / "Dockerfile"
            src_dir = project_dir if (project_dir / "Dockerfile").exists() else (clone_dir if root_df.exists() else None)
            if src_dir is None:
                raise BackendDeployError(
                    "DOCKERFILE_MISSING",
                    f"Sem Dockerfile em {svc_dir}, project/ ou raiz do repo. "
                    f"Backend elegível exige Dockerfile (backendDeployDetector).",
                    {"repo": git_repo_full_name, "service_dir": service_subdir or "apps"},
                )
            # Copia Dockerfile + arquivos de infra que o Dockerfile pode COPY-ar (entrypoint,
            # .dockerignore) do dir de origem para o context svc_dir (não sobrescreve se já existir lá).
            import shutil as _shutil
            for _fname in ("Dockerfile", "docker-entrypoint.sh", ".dockerignore"):
                _src = src_dir / _fname
                _dst = svc_dir / _fname
                if _src.exists() and not _dst.exists():
                    _shutil.copy2(_src, _dst)
                    log.info(f"[backend-deploy] {deployment_id}: copiado {_fname} de {src_dir.name}/ para o context {svc_dir.name}/")
            dockerfile = svc_dir / "Dockerfile"
            if not dockerfile.exists():
                raise BackendDeployError(
                    "DOCKERFILE_MISSING",
                    f"Dockerfile encontrado em {src_dir.name}/ mas falha ao copiar para o context {svc_dir}.",
                    {"repo": git_repo_full_name},
                )
        log.info(f"[backend-deploy] {deployment_id}: Dockerfile={dockerfile.relative_to(clone_dir)} context={svc_dir.name}")

        # 3. Determina a URI do ECR (account resolvido via STS get-caller-identity).
        account_id = payload.get("aws_account_id") or _get_account_id(aws_env)
        ecr_registry = f"{account_id}.dkr.ecr.{aws_region}.amazonaws.com"
        ecr_uri = f"{ecr_registry}/{ecr_repo_name}"
        image_uri = f"{ecr_uri}:{image_tag}"

        # 4. Build da imagem (amd64 — obrigatório p/ ECS Fargate na conta Zentriz).
        _callback(api_url, api_token, project_id, deployment_id, {"progress": "building"})
        log.info(f"[backend-deploy] {deployment_id}: docker build {image_uri}")
        _run(
            ["docker", "buildx", "build", "--platform", "linux/amd64",
             "--tag", image_uri, "-f", str(dockerfile), str(svc_dir)],
            timeout=900, deployment_id=deployment_id, phase="build",
        )  # -f explícito + context svc_dir: Dockerfile já garantido dentro do context acima

        # 5. Cria o repositório ECR — IDEMPOTENTE (captura RepositoryAlreadyExistsException).
        _ensure_ecr_repo(ecr_repo_name, project_id, tenant_id, deployment_id, aws_env)

        # 6. Login no registry ECR e push.
        _ecr_login(ecr_registry, aws_env, deployment_id)
        _callback(api_url, api_token, project_id, deployment_id, {"progress": "pushing"})
        log.info(f"[backend-deploy] {deployment_id}: docker push {image_uri}")
        _run(["docker", "push", image_uri], timeout=600, deployment_id=deployment_id, phase="push")

        # 7. Callback final — o control-plane SDK (deployBackendCloud) segue daqui.
        _callback(api_url, api_token, project_id, deployment_id, {
            "progress": "pushed",
            "image_uri": image_uri,
            "ecr_repo_uri": ecr_uri,
            "image_tag": image_tag,
        })
        log.info(f"[backend-deploy] {deployment_id}: pushed {image_uri}")
        return {"ok": True, "image_uri": image_uri}

    except BackendDeployError as e:
        log.error(f"[backend-deploy] {deployment_id} falhou [{e.code}]: {e}")
        _callback(api_url, api_token, project_id, deployment_id, {
            "status": "failed", "error_code": e.code, "error_msg": str(e), "error_details": e.details,
        })
        return {"ok": False, "code": e.code, "error": str(e)}
    except Exception as e:
        log.exception(f"[backend-deploy] {deployment_id} crashed: {e}")
        _callback(api_url, api_token, project_id, deployment_id, {
            "status": "failed", "error_code": "RUNNER_CRASH", "error_msg": str(e)[:400],
        })
        return {"ok": False, "code": "RUNNER_CRASH", "error": str(e)}
    finally:
        shutil.rmtree(build_dir, ignore_errors=True)


# ── AWS / ECR helpers ────────────────────────────────────────────────────────

def _aws_env(key: str, secret: str, region: str, profile: str = "") -> dict:
    """Monta o env AWS p/ os subprocessos (aws-cli/docker) usando as credenciais da Zentriz.

    Ordem: (1) se houver chave/secret explícitas → usa-as e limpa AWS_PROFILE; (2) senão,
    se houver profile → usa AWS_PROFILE (cadeia default via ~/.aws); (3) senão, deixa o
    ambiente do host intacto → a cadeia default do SDK resolve (instance role/SSO/env já
    presente). "Usar as AWS Secrets da Zentriz" = não forçar chaves vazias sobre o host.
    """
    e = dict(os.environ)
    e["AWS_DEFAULT_REGION"] = region
    if key and secret:
        e["AWS_ACCESS_KEY_ID"] = key
        e["AWS_SECRET_ACCESS_KEY"] = secret
        e.pop("AWS_PROFILE", None)
        e.pop("AWS_DEFAULT_PROFILE", None)
    elif profile:
        e["AWS_PROFILE"] = profile
        # não seta chaves vazias (quebraria o profile)
        e.pop("AWS_ACCESS_KEY_ID", None)
        e.pop("AWS_SECRET_ACCESS_KEY", None)
    # else: mantém o env do host como está (instance role / SSO / env herdado).
    return e


def _get_account_id(aws_env: dict) -> str:
    r = _run_aws(["sts", "get-caller-identity", "--query", "Account", "--output", "text"], aws_env)
    return (r.stdout or "").strip()


def _ensure_ecr_repo(repo_name: str, project_id: str, tenant_id: str,
                     deployment_id: str, aws_env: dict) -> None:
    """Cria o repositório ECR de forma idempotente.

    Padrão do plano: chamar create-repository e capturar RepositoryAlreadyExistsException
    (segundo run do mesmo projeto NÃO duplica repo). Aplica tags zentriz:* como o S3 runner.
    """
    tags = (
        f"Key=zentriz:product,Value=genesis "
        f"Key=zentriz:project_id,Value={project_id} "
        f"Key=zentriz:tenant_id,Value={tenant_id} "
        f"Key=zentriz:deployment_id,Value={deployment_id} "
        f"Key=zentriz:managed_by,Value=full-test-server"
    )
    cmd = ["aws", "ecr", "create-repository", "--repository-name", repo_name,
           "--image-tag-mutability", "MUTABLE", "--tags"] + tags.split(" ")
    r = subprocess.run(cmd, capture_output=True, text=True, env=aws_env, timeout=60)
    if r.returncode == 0:
        log.info(f"[backend-deploy] ECR repo criado: {repo_name}")
        return
    stderr = (r.stderr or "")
    if "RepositoryAlreadyExistsException" in stderr:
        log.info(f"[backend-deploy] ECR repo já existe (idempotente): {repo_name}")
        # Reconcilia as tags no repo existente (best-effort, não bloqueia).
        try:
            acct = _get_account_id(aws_env)
            region = aws_env.get("AWS_DEFAULT_REGION", "us-east-1")
            arn = f"arn:aws:ecr:{region}:{acct}:repository/{repo_name}"
            _run_aws(["ecr", "tag-resource", "--resource-arn", arn, "--tags"] + tags.split(" "), aws_env)
        except Exception as te:
            log.warning(f"[backend-deploy] tag-resource best-effort falhou: {te}")
        return
    raise BackendDeployError(
        "ECR_CREATE_FAILED",
        f"aws ecr create-repository falhou: {stderr.strip()[:400]}",
        {"repo": repo_name},
    )


def _ecr_login(registry: str, aws_env: dict, deployment_id: str) -> None:
    """docker login no ECR via get-login-password (token temporário, não vaza)."""
    pw = _run_aws(["ecr", "get-login-password"], aws_env).stdout.strip()
    r = subprocess.run(
        ["docker", "login", "--username", "AWS", "--password-stdin", registry],
        input=pw, capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        raise BackendDeployError(
            "ECR_LOGIN_FAILED",
            f"docker login no ECR falhou: {(r.stderr or '').strip()[:300]}",
        )
    log.info(f"[backend-deploy] {deployment_id}: docker login OK em {registry}")


def _run_aws(args: list, env: dict, timeout: int = 60) -> subprocess.CompletedProcess:
    cmd = ["aws"] + args
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)
    if r.returncode != 0:
        raise BackendDeployError(
            "AWS_CLI_ERROR",
            f"aws {args[0]} {args[1] if len(args) > 1 else ''} falhou: {(r.stderr or '').strip()[:400]}",
            {"cmd": " ".join(cmd[:5])},
        )
    return r


# ── docker / git helpers ─────────────────────────────────────────────────────

def _run(cmd: list, timeout: int, deployment_id: str, phase: str) -> None:
    """Executa comando; erro vira BackendDeployError com stderr truncado."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise BackendDeployError(f"{phase.upper()}_TIMEOUT", f"{phase} excedeu {timeout}s")
    if r.returncode != 0:
        raise BackendDeployError(
            f"{phase.upper()}_FAILED",
            f"{cmd[0]} {phase} falhou (exit {r.returncode}): {(r.stderr or '').strip()[:500]}",
        )
    log.info(f"[backend-deploy] {deployment_id}: {phase} OK")


def _git_clone(clone_url: str, token: str, branch: str, dst: Path, deployment_id: str) -> None:
    """Clona um repo GitHub com token de instalação via HTTPS (não persiste token).

    Espelha s3_deploy_runner._git_clone: header AUTHORIZATION basic, depth=1, timeout 180s.
    """
    if not clone_url.startswith("https://github.com/"):
        raise BackendDeployError("CLONE_URL_INVALID", f"clone_url deve ser https://github.com/... : {clone_url}")
    auth_header = f"AUTHORIZATION: basic {_b64('x-access-token:' + token)}"
    cmd = [
        "git",
        "-c", f"http.https://github.com/.extraheader={auth_header}",
        "clone", "--depth", "1", "--branch", branch, clone_url, str(dst),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        raise BackendDeployError("CLONE_TIMEOUT", "git clone excedeu 180s")
    if r.returncode != 0:
        stderr = (r.stderr or "").replace(token, "<REDACTED>")[:400]
        raise BackendDeployError("CLONE_FAILED", f"git clone falhou (exit {r.returncode}): {stderr.strip()}",
                                 {"branch": branch})
    log.info(f"[backend-deploy] {deployment_id}: clone concluído em {dst}")


def _b64(s: str) -> str:
    import base64
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


def _callback(api_url: str, token: str, project_id: str, deployment_id: str,
              body: dict, max_retries: int = 3) -> None:
    """Callback com retry backoff 5/15/30s → rota de backend (tabela backend_deployments).

    Espelha s3_deploy_runner._callback, mas o path é /deploy/backend/ (criado em G1-T12).
    Em falha total escreve orphan file p/ reconciliação.
    """
    url = f"{api_url.rstrip('/')}/api/projects/{project_id}/deploy/backend/{deployment_id}/callback"
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
            log.warning(f"[backend-callback] tentativa {i+1}/{max_retries} falhou: {e}")
            if i < max_retries - 1:
                time.sleep(delays[i])
    log.error(f"[backend-callback] TODAS as tentativas falharam. Orphan file: {last_err}")
    try:
        orphan = Path("/tmp") / f"genesis-backend-orphan-{deployment_id}.json"
        orphan.write_text(json.dumps({"url": url, "body": body, "error": str(last_err)}))
    except Exception:
        pass
