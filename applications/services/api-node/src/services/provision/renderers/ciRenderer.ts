/**
 * ciRenderer.ts — DM-T7 (Fase A). Renderer GitHub Actions + DEPLOY.md do modo source_only.
 *
 * A partir da IR (DM-T3), gera:
 *   - .github/workflows/deploy.yml — build+push de cada imagem no ECR (OIDC, sem chave
 *     estática) e, quando produção/ecs, update dos services ECS; matriz por serviço.
 *   - DEPLOY.md — índice que explica os caminhos do kit (local via Compose, AWS via
 *     Terraform, cluster via k8s, CI/CD via Actions) e qual escolher.
 *
 * Puro, determinístico, sem AWS. Sem segredos embutidos (usa secrets do GitHub +
 * OIDC role-to-assume, referenciado por ${{ secrets.* }}).
 */

import type { ProvisionPlanIR } from "../provisionPlanIR.js";
import type { RenderedFile } from "./composeRenderer.js";

function renderWorkflow(plan: ProvisionPlanIR): string {
  const services = plan.services.map((s) => `          - { name: "${s.name}", repo: "${s.imageRepo}", dir: "apps/${s.name === "app" ? "" : s.name}" }`).join("\n");
  const isEcs = plan.runtimeTarget === "ecs_fargate";
  return [
    "name: deploy",
    "on:",
    "  push:",
    "    branches: [ main ]",
    "  workflow_dispatch: {}",
    "permissions:",
    "  id-token: write   # OIDC — sem chave estática",
    "  contents: read",
    "env:",
    "  AWS_REGION: ${{ vars.AWS_REGION || 'us-east-1' }}",
    "jobs:",
    "  build-push:",
    "    runs-on: ubuntu-latest",
    "    strategy:",
    "      matrix:",
    "        service:",
    services,
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: Configure AWS (OIDC)",
    "        uses: aws-actions/configure-aws-credentials@v4",
    "        with:",
    "          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}",
    "          aws-region: ${{ env.AWS_REGION }}",
    "      - name: Login ECR",
    "        id: ecr",
    "        uses: aws-actions/amazon-ecr-login@v2",
    "      - name: Build & push",
    "        run: |",
    "          IMAGE=\"${{ steps.ecr.outputs.registry }}/${{ matrix.service.repo }}:${{ github.sha }}\"",
    "          docker build --platform linux/amd64 -t \"$IMAGE\" \"${{ matrix.service.dir }}\"",
    "          docker push \"$IMAGE\"",
    ...(isEcs ? [
      "      - name: Update ECS service",
      "        run: |",
      "          aws ecs update-service --cluster genesis \\",
      "            --service \"genesis-${{ matrix.service.name }}\" --force-new-deployment || \\",
      "            echo \"service ainda não existe — rode o terraform/ primeiro\"",
    ] : []),
    "",
  ].join("\n");
}

function renderDeployMd(plan: ProvisionPlanIR): string {
  const svcList = plan.services.map((s) => `- \`${s.name}\` (${s.role}, porta ${s.port})`).join("\n");
  const dbLine =
    plan.db.kind === "rds" ? "PostgreSQL gerenciado (RDS) em produção; Postgres local no Compose."
    : plan.db.kind === "sidecar" ? "PostgreSQL junto com a aplicação (sidecar), descartável."
    : plan.db.kind === "external" ? "Banco externo — informe `DATABASE_URL`."
    : "Sem banco de dados.";
  return [
    "# Deploy — kit gerado pelo Genesis",
    "",
    `Este produto tem ${plan.services.length} serviço(s):`,
    svcList,
    "",
    `**Banco:** ${dbLine}`,
    "",
    "Escolha um caminho:",
    "",
    "## 🖥️ Rodar local (mais rápido)",
    "```sh",
    "cp .env.example .env   # preencha os segredos",
    "docker compose up --build",
    "```",
    "Veja `RUN.md` para detalhes.",
    "",
    "## ☁️ AWS com Terraform",
    "```sh",
    "cd terraform",
    "cp terraform.tfvars.example terraform.tfvars   # preencha",
    "terraform init && terraform apply",
    "```",
    "Provisiona " + (plan.runtimeTarget === "ecs_fargate" ? "ECS Fargate + ALB" + (plan.db.kind === "rds" ? " + RDS" : "") : plan.runtimeTarget) + ". A saída `alb_dns_name` é o endereço do balanceador.",
    "",
    "## ☸️ Kubernetes",
    "```sh",
    "# preencha os segredos em k8s/kustomization.yaml (secretGenerator)",
    "kubectl apply -k k8s/",
    "```",
    "",
    "## 🔄 CI/CD (GitHub Actions)",
    "O workflow `.github/workflows/deploy.yml` faz build+push das imagens a cada push na `main`.",
    "Configure no repositório:",
    "- secret `AWS_DEPLOY_ROLE_ARN` (role OIDC com permissão de ECR/ECS)",
    "- variable `AWS_REGION` (opcional; default us-east-1)",
    "",
    "> Segredos nunca vão versionados: use `.env` (local), `terraform.tfvars` (Terraform),",
    "> Secret do k8s e secrets do GitHub (CI). Os arquivos de exemplo trazem apenas placeholders.",
    "",
  ].join("\n");
}

/** Bundle CI/CD + DEPLOY.md do modo source_only. */
export function renderCiBundle(plan: ProvisionPlanIR): RenderedFile[] {
  return [
    { path: ".github/workflows/deploy.yml", content: renderWorkflow(plan) },
    { path: "DEPLOY.md", content: renderDeployMd(plan) },
  ];
}
