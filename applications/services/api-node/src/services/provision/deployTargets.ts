/**
 * deployTargets.ts — Item 2 (corrigido): matriz de ALVOS de deploy na nuvem do TENANT.
 *
 * O deploy passa a ser uma escolha explícita no cockpit:
 *   (a) QUAL conexão de cloud do tenant (AWS/Azure/GCP de settings/cloud);
 *   (b) QUAL formato de deploy — condicional ao TIPO DE PROJETO e viável POR NUVEM;
 *   (c) expiração (prazo com teardown p/ demo, permanente p/ produção).
 *
 * O GitHub é quem EXECUTA o deploy (Genesis prepara workflow+secrets, dispara e MONITORA/
 * auto-cura até o GitHub retornar OK). Este módulo é a FONTE ÚNICA de:
 *   - `viableFormatsForProjectType` — quais formatos fazem sentido p/ o tipo do projeto
 *     (corrige o bug histórico de mobile cair em "S3 static");
 *   - `PROVIDER_FORMAT_LABELS` — o nome do serviço em CADA nuvem (nomes diferentes por cloud);
 *   - `getCloudDeployWorkflow` — o YAML do workflow (12 = 4 formatos × 3 nuvens), com
 *     `workflow_dispatch` (Genesis dispara sob demanda) e `run-name` carimbado com o id do
 *     deploy (p/ o monitor correlacionar o run);
 *   - `getCloudTeardownWorkflow` — o YAML de destruição (p/ demo com prazo).
 *
 * Fase 1 (v1): container, site estático, VM, serverless/functions.
 * Fase 2 (fora daqui): App Runner / App Service / App Engine; cross-account (GATE 2).
 *
 * IMPORTANTE (honestidade de escopo): os templates de estático/VM/serverless são
 * "convention-based" (nome do recurso derivado do repo, cria-se-ausente onde é barato).
 * O de container espelha o template já provado em produção (ECS/Container Apps/Cloud Run).
 * VM assume uma instância pré-existente alvo (tag Name=<repo> ou secret de host/instância).
 */

export type DeployFormat = "container" | "static" | "vm" | "serverless";
export type CloudProvider = "aws" | "azure" | "gcp";

export const DEPLOY_FORMATS: DeployFormat[] = ["container", "static", "vm", "serverless"];

/** Nome do serviço-alvo em cada nuvem (nomes próprios por cloud — Jean: "cada cloud tem modelos de nomes diferentes"). */
export const PROVIDER_FORMAT_LABELS: Record<CloudProvider, Record<DeployFormat, string>> = {
  aws: {
    container:  "ECS Fargate (ECR)",
    static:     "S3 static website",
    vm:         "EC2 (via SSM)",
    serverless: "Lambda",
  },
  azure: {
    container:  "Container Apps (ACR)",
    static:     "Static Web Apps / Blob",
    vm:         "Virtual Machine (via run-command)",
    serverless: "Azure Functions",
  },
  gcp: {
    container:  "Cloud Run (GCR)",
    static:     "Cloud Storage website",
    vm:         "Compute Engine (via SSH)",
    serverless: "Cloud Functions",
  },
};

export const PROVIDER_LABEL: Record<CloudProvider, string> = {
  aws: "AWS", azure: "Azure", gcp: "Google Cloud",
};

/**
 * Formatos VIÁVEIS por TIPO DE PROJETO (Jean: "atenção nos tipos de projetos").
 * Corrige o defeito histórico: mobile/lib/infra NÃO têm formato de deploy de nuvem
 * (mobile sai por kit; lib por source-only; infra é o próprio kit) — antes caíam em S3.
 *
 * Regras (project_type canônico do policies.json v0.5.0):
 *   frontend_* / landing / static  → static (site) [+ container p/ SSR quando aplicável]
 *   backend_api* / backend_graphql → container, vm, serverless
 *   backend_worker / bot_*         → serverless, container   (fila/cron/bot)
 *   fullstack_*                    → container, vm           (multi-serviço; nem static nem 1 função)
 *   mobile_* / lib_* / infra_* / other → []  (sem deploy de nuvem — kit/source-only)
 */
export function viableFormatsForProjectType(projectType: string | null | undefined): DeployFormat[] {
  const pt = (projectType ?? "").toLowerCase().trim();
  if (!pt) return ["container", "static"]; // desconhecido: opções neutras mais comuns

  // Mobile / bibliotecas / infra não deployam em nuvem por este fluxo.
  if (pt.startsWith("mobile")) return [];
  if (pt.startsWith("lib")) return [];
  if (pt.startsWith("infra")) return [];
  if (pt === "other" || pt === "_default") return ["container", "static"];

  if (pt.startsWith("fullstack")) return ["container", "vm"];

  // Frontends puros / sites: estático primeiro; container p/ quem precisa de SSR/edge.
  // (fullstack_* — inclusive fullstack_ecommerce — já foi tratado acima por startsWith("fullstack").)
  if (pt.startsWith("frontend") || pt.includes("landing") || pt.includes("static") || pt.includes("dashboard") || pt.includes("ecommerce")) {
    return ["static", "container"];
  }

  if (pt.startsWith("backend")) {
    if (pt.includes("worker")) return ["serverless", "container"];
    return ["container", "vm", "serverless"];
  }

  if (pt.startsWith("bot")) return ["serverless", "container"];

  // Fallback conservador.
  return ["container", "static"];
}

/** Um formato viável já resolvido para uma nuvem específica (value = enviado ao backend). */
export interface DeployOption {
  format: DeployFormat;
  label: string;        // nome do serviço nessa nuvem
  recommended: boolean; // 1º da lista viável = recomendado
}

/**
 * Opções de deploy para (tipo de projeto × nuvem). Todos os formatos v1 são suportados
 * pelos 3 provedores, então a interseção é só a lista viável do tipo. Mantido como função
 * (não constante) porque a viabilidade por-cloud pode divergir na Fase 2.
 */
export function deployOptionsFor(projectType: string | null | undefined, provider: CloudProvider): DeployOption[] {
  const viable = viableFormatsForProjectType(projectType);
  return viable.map((format, i) => ({
    format,
    label: PROVIDER_FORMAT_LABELS[provider][format],
    recommended: i === 0,
  }));
}

/** Formato é válido para (tipo × nuvem)? Guard do backend antes de disparar. */
export function isFormatViable(
  projectType: string | null | undefined,
  provider: CloudProvider,
  format: DeployFormat,
): boolean {
  return deployOptionsFor(projectType, provider).some((o) => o.format === format);
}

// ── Workflow templates (12 = 4 formatos × 3 nuvens) ────────────────────────────
//
// Todos: trigger `workflow_dispatch` (Genesis dispara), `run-name` com o id do deploy
// (correlação no monitor), branch de deploy escolhido no dispatch (checkout default do ref).
// Nome do arquivo é ESTÁVEL por (provider,format) p/ o dispatch/monitor achar sempre.

export function deployWorkflowFileName(): string {
  // Um único arquivo por repo — o formato/nuvem escolhido é materializado aqui.
  return "genesis-deploy.yml";
}
export function teardownWorkflowFileName(): string {
  return "genesis-teardown.yml";
}
export function deployWorkflowPath(): string {
  return `.github/workflows/${deployWorkflowFileName()}`;
}
export function teardownWorkflowPath(): string {
  return `.github/workflows/${teardownWorkflowFileName()}`;
}

const DISPATCH_HEADER = (title: string) => `name: ${title}
run-name: ${title} · \${{ github.event.inputs.genesis_deploy_id }}
on:
  workflow_dispatch:
    inputs:
      genesis_deploy_id:
        description: "Genesis deploy id (correlação)"
        required: false
        default: ""
      genesis_git_sha:
        description: "SHA/ref a fazer checkout (vazio = ref do dispatch — Bloco 4 M5: deploy/rollback por SHA)"
        required: false
        default: ""
`;
// Bloco 4 (M5): checkout do código no SHA exato do deploy (redeploy pós-merge / rollback por SHA).
// Fallback para o ref do dispatch quando `genesis_git_sha` vem vazio (deploy manual comum) —
// preserva o comportamento anterior. Aplicado a TODOS os checkouts dos templates abaixo.

/**
 * `repoName` é interpolado em blocos `run:` (shell) e em nomes de recurso dos templates.
 * Ele vem do repo criado pelo GitHub (já restrito a [A-Za-z0-9._-]), mas re-validamos aqui
 * (defense-in-depth) antes de templetizar: se a convenção de nome afrouxar no futuro, isto
 * impede injeção de shell no workflow que roda com as credenciais de cloud do tenant.
 */
const SAFE_REPO_NAME = /^[A-Za-z0-9._-]+$/;
function assertSafeRepoName(repoName: string): void {
  if (!SAFE_REPO_NAME.test(repoName)) {
    throw new Error(`repoName inválido para template de deploy: '${repoName}'`);
  }
}

/**
 * Retorna o YAML do workflow de deploy para (provider, format), com workflow_dispatch.
 * `repoName` nomeia o recurso por convenção (bucket/função/serviço/imagem).
 */
export function getCloudDeployWorkflow(
  provider: CloudProvider,
  format: DeployFormat,
  repoName: string,
): string {
  assertSafeRepoName(repoName);
  const key = `${provider}:${format}`;
  const builder = DEPLOY_TEMPLATES[key];
  if (!builder) {
    // Nunca deve acontecer (12 combos cobertos); fallback defensivo = container.
    return DEPLOY_TEMPLATES[`${provider}:container`](repoName);
  }
  return builder(repoName);
}

/** YAML do teardown (destruição) para (provider, format). Usado só p/ demo com prazo. */
export function getCloudTeardownWorkflow(
  provider: CloudProvider,
  format: DeployFormat,
  repoName: string,
): string {
  assertSafeRepoName(repoName);
  const key = `${provider}:${format}`;
  const builder = TEARDOWN_TEMPLATES[key];
  if (!builder) return TEARDOWN_TEMPLATES[`${provider}:container`](repoName);
  return builder(repoName);
}

// Auth steps reutilizáveis por nuvem (secrets já sincronizados por cloudConnector).
const AUTH_AWS = `      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ secrets.AWS_REGION }}`;
const AUTH_AZURE = `      - uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_CREDENTIALS }}`;
const AUTH_GCP = `      - uses: google-github-actions/auth@v2
        with:
          credentials_json: \${{ secrets.GCP_SA_KEY }}
      - uses: google-github-actions/setup-gcloud@v2`;

type TemplateBuilder = (repoName: string) => string;

const DEPLOY_TEMPLATES: Record<string, TemplateBuilder> = {
  // ───────────────────────── AWS ─────────────────────────
  "aws:container": (repo) => `${DISPATCH_HEADER("Genesis Deploy · AWS ECS")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_AWS}
      - uses: aws-actions/amazon-ecr-login@v2
      - name: Build and push image
        run: |
          REGISTRY="\${{ secrets.AWS_ECR_REGISTRY }}"
          if [ -z "$REGISTRY" ]; then
            ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
            REGISTRY="$ACCOUNT.dkr.ecr.\${{ secrets.AWS_REGION }}.amazonaws.com"
          fi
          aws ecr describe-repositories --repository-names ${repo} >/dev/null 2>&1 || aws ecr create-repository --repository-name ${repo} >/dev/null
          IMAGE_URI="$REGISTRY/${repo}:\${{ github.sha }}"
          docker build -t "$IMAGE_URI" .
          docker push "$IMAGE_URI"
      - name: Force new ECS deployment
        run: |
          aws ecs update-service \\
            --cluster "\${{ secrets.AWS_ECS_CLUSTER }}" \\
            --service ${repo} \\
            --force-new-deployment \\
            --region "\${{ secrets.AWS_REGION }}"
`,

  "aws:static": (repo) => `${DISPATCH_HEADER("Genesis Deploy · AWS S3 static")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_AWS}
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Build static site
        working-directory: .
        run: |
          if [ -f package.json ]; then
            npm ci || npm install
            npm run build || echo "no build script — serving as-is"
          fi
      - name: Resolve build output dir
        id: out
        run: |
          for d in dist build out .output/public .; do
            if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then echo "dir=$d" >> "$GITHUB_OUTPUT"; break; fi
          done
      - name: Ensure bucket and sync
        run: |
          # S3 exige nome lowercase, sem '_', 3-63 chars. Normaliza (determinístico; igual ao teardown).
          BUCKET=$(printf '%s' "${repo}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed -E 's/^-+//; s/-+$//' | cut -c1-63)
          aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || aws s3 mb "s3://$BUCKET" --region "\${{ secrets.AWS_REGION }}"
          aws s3 website "s3://$BUCKET" --index-document index.html --error-document index.html || true
          aws s3 sync "\${{ steps.out.outputs.dir }}" "s3://$BUCKET" --delete
          echo "Site: http://$BUCKET.s3-website.\${{ secrets.AWS_REGION }}.amazonaws.com"
`,

  "aws:serverless": (repo) => `${DISPATCH_HEADER("Genesis Deploy · AWS Lambda")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_AWS}
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Package function
        working-directory: .
        run: |
          [ -f package.json ] && (npm ci --omit=dev || npm install --omit=dev) || true
          zip -qr /tmp/function.zip . -x "*.git*"
      - name: Create or update Lambda
        run: |
          FN="${repo}"
          ROLE_NAME="genesis-lambda-\${FN}"
          ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text 2>/dev/null || true)
          if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
            ROLE_ARN=$(aws iam create-role --role-name "$ROLE_NAME" \\
              --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \\
              --query Role.Arn --output text)
            aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
            sleep 10
          fi
          if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
            aws lambda update-function-code --function-name "$FN" --zip-file fileb:///tmp/function.zip
          else
            aws lambda create-function --function-name "$FN" --runtime nodejs20.x \\
              --handler index.handler --role "$ROLE_ARN" --zip-file fileb:///tmp/function.zip --timeout 30
          fi
`,

  "aws:vm": (repo) => `${DISPATCH_HEADER("Genesis Deploy · AWS EC2 (SSM)")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_AWS}
      - name: Resolve target instance
        id: ec2
        run: |
          IID="\${{ secrets.AWS_EC2_INSTANCE_ID }}"
          if [ -z "$IID" ]; then
            IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=${repo}" "Name=instance-state-name,Values=running" \\
              --query "Reservations[0].Instances[0].InstanceId" --output text)
          fi
          if [ -z "$IID" ] || [ "$IID" = "None" ]; then echo "No target EC2 instance (set AWS_EC2_INSTANCE_ID or tag Name=${repo})"; exit 1; fi
          echo "iid=$IID" >> "$GITHUB_OUTPUT"
      - name: Deploy via SSM (pull + build + run in Docker)
        run: |
          aws ssm send-command --instance-ids "\${{ steps.ec2.outputs.iid }}" \\
            --document-name "AWS-RunShellScript" \\
            --comment "Genesis deploy ${repo}" \\
            --parameters 'commands=["set -e","cd /opt/${repo} 2>/dev/null || (sudo mkdir -p /opt/${repo} && cd /opt/${repo})","sudo git clone \${{ github.server_url }}/\${{ github.repository }} . 2>/dev/null || sudo git pull","sudo docker build -t ${repo}:latest .","sudo docker rm -f ${repo} 2>/dev/null || true","sudo docker run -d --restart unless-stopped --name ${repo} -p 80:3000 ${repo}:latest"]' \\
            --region "\${{ secrets.AWS_REGION }}"
`,

  // ───────────────────────── Azure ─────────────────────────
  "azure:container": (repo) => `${DISPATCH_HEADER("Genesis Deploy · Azure Container Apps")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_AZURE}
      - name: Build and push to ACR
        run: |
          ACR=$(az acr list -g "\${{ secrets.AZURE_RESOURCE_GROUP }}" --query "[0].loginServer" -o tsv)
          az acr build --registry "$ACR" --image ${repo}:\${{ github.sha }} .
      - name: Update Container App
        run: |
          ACR=$(az acr list -g "\${{ secrets.AZURE_RESOURCE_GROUP }}" --query "[0].loginServer" -o tsv)
          az containerapp update \\
            --name "\${{ secrets.AZURE_CONTAINER_APP }}" \\
            --resource-group "\${{ secrets.AZURE_RESOURCE_GROUP }}" \\
            --image "$ACR/${repo}:\${{ github.sha }}"
`,

  "azure:static": (repo) => `${DISPATCH_HEADER("Genesis Deploy · Azure Blob static")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_AZURE}
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Build static site
        working-directory: .
        run: |
          if [ -f package.json ]; then npm ci || npm install; npm run build || echo "no build script"; fi
      - name: Resolve output dir
        id: out
        run: |
          for d in dist build out .output/public .; do
            if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then echo "dir=$d" >> "$GITHUB_OUTPUT"; break; fi
          done
      - name: Upload to Blob \$web
        run: |
          RG="\${{ secrets.AZURE_RESOURCE_GROUP }}"
          ACC=$(echo "${repo}" | tr -cd 'a-z0-9' | cut -c1-24)
          az storage account show -n "$ACC" -g "$RG" >/dev/null 2>&1 || az storage account create -n "$ACC" -g "$RG" --sku Standard_LRS
          az storage blob service-properties update --account-name "$ACC" --static-website --index-document index.html --404-document index.html
          az storage blob upload-batch --account-name "$ACC" -d '\$web' -s "\${{ steps.out.outputs.dir }}" --overwrite
          az storage account show -n "$ACC" -g "$RG" --query "primaryEndpoints.web" -o tsv
`,

  "azure:serverless": (repo) => `${DISPATCH_HEADER("Genesis Deploy · Azure Functions")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_AZURE}
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Build
        working-directory: .
        run: |
          [ -f package.json ] && (npm ci || npm install) || true
          npm run build || echo "no build script"
      - name: Deploy Function App
        run: |
          RG="\${{ secrets.AZURE_RESOURCE_GROUP }}"
          APP="\${{ secrets.AZURE_FUNCTION_APP }}"
          if [ -z "$APP" ]; then APP="${repo}"; fi
          az functionapp deployment source config-zip -g "$RG" -n "$APP" --src <(zip -qr - . && cat) 2>/dev/null || \\
          (zip -qr /tmp/fn.zip . && az functionapp deployment source config-zip -g "$RG" -n "$APP" --src /tmp/fn.zip)
`,

  "azure:vm": (repo) => `${DISPATCH_HEADER("Genesis Deploy · Azure VM (run-command)")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_AZURE}
      - name: Deploy via VM run-command
        run: |
          RG="\${{ secrets.AZURE_RESOURCE_GROUP }}"
          VM="\${{ secrets.AZURE_VM_NAME }}"
          if [ -z "$VM" ]; then VM="${repo}"; fi
          az vm run-command invoke -g "$RG" -n "$VM" --command-id RunShellScript \\
            --scripts "set -e" "cd /opt/${repo} 2>/dev/null || (sudo mkdir -p /opt/${repo} && cd /opt/${repo})" \\
            "sudo git clone \${{ github.server_url }}/\${{ github.repository }} . 2>/dev/null || sudo git pull" \\
            "sudo docker build -t ${repo}:latest ." \\
            "sudo docker rm -f ${repo} 2>/dev/null || true" \\
            "sudo docker run -d --restart unless-stopped --name ${repo} -p 80:3000 ${repo}:latest"
`,

  // ───────────────────────── GCP ─────────────────────────
  "gcp:container": (repo) => `${DISPATCH_HEADER("Genesis Deploy · GCP Cloud Run")}jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_GCP}
      - name: Build and push image
        run: |
          gcloud auth configure-docker gcr.io --quiet
          IMG="gcr.io/\${{ secrets.GCP_PROJECT_ID }}/${repo}:\${{ github.sha }}"
          docker build -t "$IMG" .
          docker push "$IMG"
      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy ${repo} \\
            --image "gcr.io/\${{ secrets.GCP_PROJECT_ID }}/${repo}:\${{ github.sha }}" \\
            --region "\${{ secrets.GCP_REGION }}" \\
            --platform managed \\
            --allow-unauthenticated \\
            --project "\${{ secrets.GCP_PROJECT_ID }}"
`,

  "gcp:static": (repo) => `${DISPATCH_HEADER("Genesis Deploy · GCP Cloud Storage static")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_GCP}
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Build static site
        working-directory: .
        run: |
          if [ -f package.json ]; then npm ci || npm install; npm run build || echo "no build script"; fi
      - name: Resolve output dir
        id: out
        run: |
          for d in dist build out .output/public .; do
            if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then echo "dir=$d" >> "$GITHUB_OUTPUT"; break; fi
          done
      - name: Ensure bucket and sync
        run: |
          BUCKET="${repo}-\${{ secrets.GCP_PROJECT_ID }}"
          gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || gcloud storage buckets create "gs://$BUCKET" --project "\${{ secrets.GCP_PROJECT_ID }}"
          gcloud storage rsync -r "\${{ steps.out.outputs.dir }}" "gs://$BUCKET"
          gcloud storage buckets update "gs://$BUCKET" --web-main-page-suffix=index.html --web-error-page=index.html || true
          echo "Site: https://storage.googleapis.com/$BUCKET/index.html"
`,

  "gcp:serverless": (repo) => `${DISPATCH_HEADER("Genesis Deploy · GCP Cloud Functions")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_GCP}
      - name: Deploy Cloud Function (gen2)
        run: |
          gcloud functions deploy ${repo} \\
            --gen2 \\
            --runtime nodejs20 \\
            --region "\${{ secrets.GCP_REGION }}" \\
            --source . \\
            --entry-point handler \\
            --trigger-http \\
            --allow-unauthenticated \\
            --project "\${{ secrets.GCP_PROJECT_ID }}"
`,

  "gcp:vm": (repo) => `${DISPATCH_HEADER("Genesis Deploy · GCP Compute Engine (SSH)")}jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_GCP}
      - name: Deploy via gcloud compute ssh
        run: |
          ZONE="\${{ secrets.GCP_ZONE }}"
          if [ -z "$ZONE" ]; then ZONE="\${{ secrets.GCP_REGION }}-a"; fi
          gcloud compute ssh ${repo} --zone "$ZONE" --project "\${{ secrets.GCP_PROJECT_ID }}" --quiet --command="\\
            set -e; \\
            cd /opt/${repo} 2>/dev/null || (sudo mkdir -p /opt/${repo} && cd /opt/${repo}); \\
            sudo git clone \${{ github.server_url }}/\${{ github.repository }} . 2>/dev/null || sudo git pull; \\
            sudo docker build -t ${repo}:latest .; \\
            sudo docker rm -f ${repo} 2>/dev/null || true; \\
            sudo docker run -d --restart unless-stopped --name ${repo} -p 80:3000 ${repo}:latest"
`,
};

const TEARDOWN_TEMPLATES: Record<string, TemplateBuilder> = {
  "aws:container": (repo) => `${DISPATCH_HEADER("Genesis Teardown · AWS ECS")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.genesis_git_sha || github.ref }}
${AUTH_AWS}
      - name: Scale service to zero
        run: |
          aws ecs update-service --cluster "\${{ secrets.AWS_ECS_CLUSTER }}" --service ${repo} --desired-count 0 --region "\${{ secrets.AWS_REGION }}" || true
          aws ecr delete-repository --repository-name ${repo} --force --region "\${{ secrets.AWS_REGION }}" || true
`,
  "aws:static": (repo) => `${DISPATCH_HEADER("Genesis Teardown · AWS S3")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_AWS}
      - name: Delete bucket
        run: |
          # Mesma normalização do deploy (S3 lowercase, sem '_', 3-63 chars).
          BUCKET=$(printf '%s' "${repo}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed -E 's/^-+//; s/-+$//' | cut -c1-63)
          aws s3 rb "s3://$BUCKET" --force || true
`,
  "aws:serverless": (repo) => `${DISPATCH_HEADER("Genesis Teardown · AWS Lambda")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_AWS}
      - name: Delete function
        run: aws lambda delete-function --function-name ${repo} || true
`,
  "aws:vm": (repo) => `${DISPATCH_HEADER("Genesis Teardown · AWS EC2")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_AWS}
      - name: Stop container on instance
        run: |
          IID="\${{ secrets.AWS_EC2_INSTANCE_ID }}"
          if [ -z "$IID" ]; then IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=${repo}" "Name=instance-state-name,Values=running" --query "Reservations[0].Instances[0].InstanceId" --output text); fi
          [ -n "$IID" ] && [ "$IID" != "None" ] && aws ssm send-command --instance-ids "$IID" --document-name "AWS-RunShellScript" --parameters 'commands=["sudo docker rm -f ${repo} || true"]' --region "\${{ secrets.AWS_REGION }}" || true
`,
  "azure:container": (repo) => `${DISPATCH_HEADER("Genesis Teardown · Azure Container Apps")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_AZURE}
      - name: Deactivate container app revision
        run: az containerapp update --name "\${{ secrets.AZURE_CONTAINER_APP }}" --resource-group "\${{ secrets.AZURE_RESOURCE_GROUP }}" --min-replicas 0 --max-replicas 0 || true
`,
  "azure:static": (repo) => `${DISPATCH_HEADER("Genesis Teardown · Azure Blob")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_AZURE}
      - name: Delete storage account
        run: |
          ACC=$(echo "${repo}" | tr -cd 'a-z0-9' | cut -c1-24)
          az storage account delete -n "$ACC" -g "\${{ secrets.AZURE_RESOURCE_GROUP }}" --yes || true
`,
  "azure:serverless": (repo) => `${DISPATCH_HEADER("Genesis Teardown · Azure Functions")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_AZURE}
      - name: Delete function app
        run: |
          APP="\${{ secrets.AZURE_FUNCTION_APP }}"; [ -z "$APP" ] && APP="${repo}"
          az functionapp delete -g "\${{ secrets.AZURE_RESOURCE_GROUP }}" -n "$APP" || true
`,
  "azure:vm": (repo) => `${DISPATCH_HEADER("Genesis Teardown · Azure VM")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_AZURE}
      - name: Stop container on VM
        run: |
          VM="\${{ secrets.AZURE_VM_NAME }}"; [ -z "$VM" ] && VM="${repo}"
          az vm run-command invoke -g "\${{ secrets.AZURE_RESOURCE_GROUP }}" -n "$VM" --command-id RunShellScript --scripts "sudo docker rm -f ${repo} || true" || true
`,
  "gcp:container": (repo) => `${DISPATCH_HEADER("Genesis Teardown · GCP Cloud Run")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_GCP}
      - name: Delete Cloud Run service
        run: gcloud run services delete ${repo} --region "\${{ secrets.GCP_REGION }}" --project "\${{ secrets.GCP_PROJECT_ID }}" --quiet || true
`,
  "gcp:static": (repo) => `${DISPATCH_HEADER("Genesis Teardown · GCP Cloud Storage")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_GCP}
      - name: Delete bucket
        run: gcloud storage rm -r "gs://${repo}-\${{ secrets.GCP_PROJECT_ID }}" --project "\${{ secrets.GCP_PROJECT_ID }}" || true
`,
  "gcp:serverless": (repo) => `${DISPATCH_HEADER("Genesis Teardown · GCP Cloud Functions")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_GCP}
      - name: Delete function
        run: gcloud functions delete ${repo} --gen2 --region "\${{ secrets.GCP_REGION }}" --project "\${{ secrets.GCP_PROJECT_ID }}" --quiet || true
`,
  "gcp:vm": (repo) => `${DISPATCH_HEADER("Genesis Teardown · GCP Compute Engine")}jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
${AUTH_GCP}
      - name: Stop container on instance
        run: |
          ZONE="\${{ secrets.GCP_ZONE }}"; [ -z "$ZONE" ] && ZONE="\${{ secrets.GCP_REGION }}-a"
          gcloud compute ssh ${repo} --zone "$ZONE" --project "\${{ secrets.GCP_PROJECT_ID }}" --quiet --command="sudo docker rm -f ${repo} || true" || true
`,
};
