/**
 * terraformRenderer.ts — DM-T5 (Fase A). Renderer Terraform do modo source_only.
 *
 * A partir da IR (DM-T3), gera um módulo terraform/ apply-ready que ESPELHA a infra que
 * os drivers SDK provisionam em produção: ECR por serviço, ECS Fargate cluster+service+
 * task-def, RDS PostgreSQL (quando db.kind=rds), ALB + target group + listener 443/80.
 *
 * Puro, determinístico, sem AWS. Alvo primário: ecs_fargate (default). app_runner/ec2
 * emitem um bloco de aviso explícito (follow-up) em vez de HCL incorreto — nunca "mente".
 *
 * Segredos: nunca embutidos. Referências a var.db_password / var.jwt_secret (o cliente
 * preenche em terraform.tfvars). Espelha a decisão "zero plaintext" do GATE 1.
 */

import type { ProvisionPlanIR, PlanService } from "../provisionPlanIR.js";
import type { RenderedFile } from "./composeRenderer.js";

function tfName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function renderVariables(plan: ProvisionPlanIR): string {
  const lines = [
    'variable "aws_region" {',
    '  type    = string',
    '  default = "us-east-1"',
    '}',
    'variable "image_tag" {',
    '  type    = string',
    '  default = "latest"',
    '}',
  ];
  if (plan.db.kind === "rds") {
    lines.push('variable "db_password" {', '  type      = string', '  sensitive = true', '}');
  }
  lines.push('variable "jwt_secret" {', '  type      = string', '  sensitive = true', '}');
  return lines.join("\n") + "\n";
}

function renderProviderAndNetwork(): string {
  return [
    'terraform {',
    '  required_providers {',
    '    aws = { source = "hashicorp/aws", version = "~> 5.0" }',
    '  }',
    '}',
    'provider "aws" {',
    '  region = var.aws_region',
    '}',
    '# Rede: usa a VPC default da conta + subnets públicas (zero-NAT, como o GATE 1).',
    'data "aws_vpc" "default" { default = true }',
    'data "aws_subnets" "public" {',
    '  filter {',
    '    name   = "vpc-id"',
    '    values = [data.aws_vpc.default.id]',
    '  }',
    '}',
  ].join("\n") + "\n";
}

function renderEcr(plan: ProvisionPlanIR): string {
  return plan.services.map((s) => [
    `resource "aws_ecr_repository" "${tfName(s.name)}" {`,
    `  name         = "${s.imageRepo}"`,
    '  force_delete = true',
    '}',
  ].join("\n")).join("\n\n") + "\n";
}

function renderRds(plan: ProvisionPlanIR): string {
  if (plan.db.kind !== "rds") return "";
  return [
    '# Banco gerenciado (produção). Em demo/source_only o padrão é sidecar no compose.',
    'resource "aws_db_subnet_group" "main" {',
    '  name       = "genesis-${var.image_tag}"',
    '  subnet_ids = data.aws_subnets.public.ids',
    '}',
    'resource "aws_db_instance" "main" {',
    '  identifier             = "genesis-db"',
    '  engine                 = "postgres"',
    `  engine_version         = "${plan.db.version}"`,
    '  instance_class         = "db.t3.micro"',
    '  allocated_storage      = 20',
    '  db_name                = "' + (plan.db.databases[0] ?? "appdb") + '"',
    '  username               = "genesis"',
    '  password               = var.db_password',
    '  db_subnet_group_name   = aws_db_subnet_group.main.name',
    '  storage_encrypted      = true',
    '  deletion_protection    = true',
    '  skip_final_snapshot    = false',
    '  final_snapshot_identifier = "genesis-db-final"',
    '}',
  ].join("\n") + "\n";
}

function renderEcsFargate(plan: ProvisionPlanIR): string {
  const parts: string[] = [
    'resource "aws_ecs_cluster" "main" { name = "genesis" }',
    '# Roles de execução/task (mínimas). Ajuste conforme necessidade.',
    'resource "aws_iam_role" "exec" {',
    '  name               = "genesis-exec-${var.image_tag}"',
    '  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })',
    '}',
    'resource "aws_iam_role_policy_attachment" "exec_managed" {',
    '  role       = aws_iam_role.exec.name',
    '  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"',
    '}',
  ];
  for (const s of plan.services) {
    const n = tfName(s.name);
    const dbEnv = s.databaseName && plan.db.kind === "rds"
      ? `        { name = "DATABASE_URL", value = "postgresql://genesis:\${var.db_password}@\${aws_db_instance.main.address}:5432/${s.databaseName}" },\n`
      : "";
    parts.push([
      `resource "aws_ecs_task_definition" "${n}" {`,
      `  family                   = "genesis-${n}"`,
      '  requires_compatibilities = ["FARGATE"]',
      '  network_mode             = "awsvpc"',
      '  cpu                      = "256"',
      '  memory                   = "512"',
      '  execution_role_arn       = aws_iam_role.exec.arn',
      '  runtime_platform {',
      '    cpu_architecture        = "X86_64"',
      '    operating_system_family = "LINUX"',
      '  }',
      '  container_definitions = jsonencode([{',
      `    name      = "${s.name}"`,
      `    image     = "\${aws_ecr_repository.${n}.repository_url}:\${var.image_tag}"`,
      '    essential = true',
      `    portMappings = [{ containerPort = ${s.port} }]`,
      '    environment = [',
      dbEnv +
      '        { name = "JWT_SECRET", value = var.jwt_secret },\n' +
      `        { name = "PORT", value = "${s.port}" },`,
      '        { name = "NODE_ENV", value = "production" }',
      '    ]',
      '  }])',
      '}',
      `resource "aws_ecs_service" "${n}" {`,
      `  name            = "genesis-${n}"`,
      '  cluster         = aws_ecs_cluster.main.id',
      `  task_definition = aws_ecs_task_definition.${n}.arn`,
      '  desired_count   = 1',
      '  launch_type     = "FARGATE"',
      '  network_configuration {',
      '    subnets          = data.aws_subnets.public.ids',
      '    security_groups  = [aws_security_group.task.id]',
      '    assign_public_ip = true',
      '  }',
      s.needsIngress ? `  load_balancer {
    target_group_arn = aws_lb_target_group.${n}.arn
    container_name   = "${s.name}"
    container_port   = ${s.port}
  }
  depends_on = [aws_lb_listener.https]` : "",
      '}',
    ].filter(Boolean).join("\n"));
  }
  return parts.join("\n\n") + "\n";
}

function renderAlb(plan: ProvisionPlanIR): string {
  const ingress = plan.services.filter((s) => s.needsIngress);
  if (ingress.length === 0) return "";
  const parts: string[] = [
    'resource "aws_security_group" "alb" {',
    '  name   = "genesis-alb"',
    '  vpc_id = data.aws_vpc.default.id',
    '  ingress { from_port = 80  to_port = 80  protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] }',
    '  ingress { from_port = 443 to_port = 443 protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] }',
    '  egress  { from_port = 0   to_port = 0   protocol = "-1"  cidr_blocks = ["0.0.0.0/0"] }',
    '}',
    'resource "aws_security_group" "task" {',
    '  name   = "genesis-task"',
    '  vpc_id = data.aws_vpc.default.id',
    '  ingress { from_port = 0 to_port = 65535 protocol = "tcp" security_groups = [aws_security_group.alb.id] }',
    '  egress  { from_port = 0 to_port = 0 protocol = "-1" cidr_blocks = ["0.0.0.0/0"] }',
    '}',
    'resource "aws_lb" "main" {',
    '  name               = "genesis-alb"',
    '  load_balancer_type = "application"',
    '  security_groups    = [aws_security_group.alb.id]',
    '  subnets            = data.aws_subnets.public.ids',
    '}',
    '# TLS: informe o ARN de um certificado ACM já emitido para o domínio.',
    'variable "acm_certificate_arn" { type = string, default = "" }',
  ];
  for (const s of ingress) {
    const n = tfName(s.name);
    parts.push([
      `resource "aws_lb_target_group" "${n}" {`,
      `  name        = "gen-${n}"`,
      `  port        = ${s.port}`,
      '  protocol    = "HTTP"',
      '  target_type = "ip"',
      '  vpc_id      = data.aws_vpc.default.id',
      '  health_check {',
      `    path    = "${s.healthPath}"`,
      '    matcher = "200-399"',
      '  }',
      '}',
    ].join("\n"));
  }
  const root = ingress.find((s) => s.isRoot) ?? ingress[0];
  parts.push([
    'resource "aws_lb_listener" "https" {',
    '  load_balancer_arn = aws_lb.main.arn',
    '  port              = 443',
    '  protocol          = "HTTPS"',
    '  certificate_arn   = var.acm_certificate_arn',
    '  default_action {',
    '    type             = "forward"',
    `    target_group_arn = aws_lb_target_group.${tfName(root.name)}.arn`,
    '  }',
    '}',
    'resource "aws_lb_listener" "http_redirect" {',
    '  load_balancer_arn = aws_lb.main.arn',
    '  port              = 80',
    '  protocol          = "HTTP"',
    '  default_action {',
    '    type = "redirect"',
    '    redirect { port = "443", protocol = "HTTPS", status_code = "HTTP_301" }',
    '  }',
    '}',
  ].join("\n"));
  // Regras de path para os demais serviços (ordem por especificidade já vem da IR).
  let priority = 10;
  for (const s of ingress) {
    if (s.isRoot) continue;
    const n = tfName(s.name);
    parts.push([
      `resource "aws_lb_listener_rule" "${n}" {`,
      '  listener_arn = aws_lb_listener.https.arn',
      `  priority     = ${priority}`,
      `  action { type = "forward", target_group_arn = aws_lb_target_group.${n}.arn }`,
      `  condition { path_pattern { values = ["${s.routePrefix.replace(/\/$/, "")}/*"] } }`,
      '}',
    ].join("\n"));
    priority += 10;
  }
  return parts.join("\n\n") + "\n";
}

function renderOutputs(plan: ProvisionPlanIR): string {
  if (plan.externalPorts.length === 0) return "";
  return [
    'output "alb_dns_name" {',
    '  value       = aws_lb.main.dns_name',
    '  description = "Aponte seu domínio (CNAME/ALIAS) para este DNS."',
    '}',
  ].join("\n") + "\n";
}

/** Bundle Terraform completo do modo source_only. */
export function renderTerraformBundle(plan: ProvisionPlanIR): RenderedFile[] {
  // Alvos não-Fargate: aviso explícito (follow-up), sem HCL incorreto.
  if (plan.runtimeTarget === "app_runner" || plan.runtimeTarget === "ec2") {
    return [{
      path: "terraform/README.md",
      content: `# Terraform — alvo ${plan.runtimeTarget}\n\n` +
        `O gerador Terraform do GATE 1 cobre ECS Fargate (padrão). Para ${plan.runtimeTarget}, ` +
        `use o kit Docker Compose (roda local/EC2) ou o Kubernetes, ou solicite o módulo ${plan.runtimeTarget}.\n`,
    }];
  }
  const main = [
    "# Gerado pelo Genesis (source_only). Espelha a infra do provisionamento automático.",
    "# Preencha terraform.tfvars e rode: terraform init && terraform apply",
    "",
    renderProviderAndNetwork(),
    renderEcr(plan),
    renderRds(plan),
    renderAlb(plan),
    renderEcsFargate(plan),
    renderOutputs(plan),
  ].filter((s) => s.trim()).join("\n");
  return [
    { path: "terraform/main.tf", content: main },
    { path: "terraform/variables.tf", content: renderVariables(plan) },
    { path: "terraform/terraform.tfvars.example", content:
        `aws_region = "us-east-1"\nimage_tag  = "latest"\njwt_secret = "troque"\n` +
        (plan.db.kind === "rds" ? `db_password = "troque"\n` : "") +
        (plan.externalPorts.length ? `acm_certificate_arn = ""\n` : "") },
  ];
}
