# Zentriz Genesis — AWS EC2 Deploy (Docker Compose)
# Provisionamento para demo/staging: 1 EC2 t3.large + EIP + SG + Secrets Manager
# Para escalar para ECS Fargate, ver docs/ROADMAP_ECS.md

terraform {
  required_version = ">= 1.5"

  # Descomente após criar o bucket de state
  # backend "s3" {
  #   bucket         = "zentriz-genesis-tfstate"
  #   key            = "aws/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "zentriz-genesis-tflock"
  # }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Provider único — Conta A (EC2, ECR, Secrets Manager, Route53 zentriz.com.br)
provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
  default_tags {
    tags = {
      Project     = "zentriz-genesis"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ──────────────────────────────────────────────
# DATA SOURCES
# ──────────────────────────────────────────────

data "aws_availability_zones" "available" {
  state = "available"
}

# Ubuntu 24.04 LTS (amd64) — última versão publicada pela Canonical
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ──────────────────────────────────────────────
# VPC E REDE
# ──────────────────────────────────────────────

resource "aws_vpc" "genesis" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${var.namespace}-vpc" }
}

resource "aws_internet_gateway" "genesis" {
  vpc_id = aws_vpc.genesis.id
  tags   = { Name = "${var.namespace}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.genesis.id
  cidr_block              = var.subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false # usamos EIP dedicado

  tags = { Name = "${var.namespace}-subnet-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.genesis.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.genesis.id
  }

  tags = { Name = "${var.namespace}-rt-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ──────────────────────────────────────────────
# SECURITY GROUP
# ──────────────────────────────────────────────

resource "aws_security_group" "genesis" {
  name        = "${var.namespace}-sg"
  description = "Genesis EC2: HTTPS (443), HTTP (80 certbot), SSH"
  vpc_id      = aws_vpc.genesis.id

  # SSH — restrito ao IP do administrador
  ingress {
    description = "SSH admin"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.admin_cidr_blocks
  }

  # HTTPS — portal + API via Nginx reverse proxy
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP — apenas para desafio ACME do Certbot
  ingress {
    description = "HTTP Certbot ACME"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Portas internas dos containers — sem acesso externo
  ingress {
    description = "Containers internos"
    from_port   = 3000
    to_port     = 8001
    protocol    = "tcp"
    self        = true
  }

  egress {
    description = "Saida irrestrita"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.namespace}-sg" }
}

# ──────────────────────────────────────────────
# SECRETS MANAGER
# ──────────────────────────────────────────────

resource "aws_secretsmanager_secret" "genesis" {
  name                    = "${var.namespace}/${var.environment}/env"
  description             = "Variáveis sensíveis do Genesis"
  recovery_window_in_days = 0 # permite remoção imediata em demo

  tags = { Name = "${var.namespace}-secrets" }
}

resource "aws_secretsmanager_secret_version" "genesis" {
  secret_id = aws_secretsmanager_secret.genesis.id

  secret_string = jsonencode({
    JWT_SECRET               = var.jwt_secret
    PGPASSWORD               = var.pg_password
    GENESIS_API_TOKEN        = var.genesis_api_token
    BEDROCK_ACCESS_KEY_ID    = var.bedrock_access_key_id
    BEDROCK_SECRET_ACCESS_KEY = var.bedrock_secret_access_key
  })

  lifecycle {
    # Evita que o Terraform sobrescreva após rotação manual
    ignore_changes = [secret_string]
  }
}

# ──────────────────────────────────────────────
# IAM — ROLE PARA EC2 (acesso ao Secrets Manager)
# ──────────────────────────────────────────────

resource "aws_iam_role" "genesis_ec2" {
  name = "${var.namespace}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "genesis_ec2_policy" {
  name = "${var.namespace}-ec2-policy"
  role = aws_iam_role.genesis_ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Secrets Manager — JWT, PG password, API token
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = aws_secretsmanager_secret.genesis.arn
      },
      {
        # S3 — download do bootstrap script
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.bootstrap.arn}/bootstrap.sh"
      },
      {
        # ECR — pull das imagens Genesis
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchCheckLayerAvailability"
        ]
        Resource = "*"
      },
      {
        # CloudWatch Logs — logs dos containers
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/zentriz/genesis/*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "genesis" {
  name = "${var.namespace}-instance-profile"
  role = aws_iam_role.genesis_ec2.name
}

# ──────────────────────────────────────────────
# KEY PAIR SSH
# ──────────────────────────────────────────────

resource "aws_key_pair" "genesis" {
  key_name   = "${var.namespace}-key"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

# ──────────────────────────────────────────────
# EC2 INSTANCE
# ──────────────────────────────────────────────

resource "aws_instance" "genesis" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.genesis.id]
  key_name               = aws_key_pair.genesis.key_name
  iam_instance_profile   = aws_iam_instance_profile.genesis.name

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    delete_on_termination = true
    encrypted             = true
  }

  # user_data mínimo: baixa e executa o bootstrap completo do S3
  # (o script renderizado excede o limite de 16KB do EC2 user_data)
  user_data = base64encode(join("\n", [
    "#!/bin/bash",
    "# Instala AWS CLI v2 (não vem pré-instalado no Ubuntu 24.04)",
    "curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip",
    "apt-get install -y unzip > /dev/null 2>&1",
    "unzip -q /tmp/awscliv2.zip -d /tmp",
    "/tmp/aws/install",
    "# Baixa e executa bootstrap em background (libera cloud-init imediatamente)",
    "aws s3 cp s3://${aws_s3_bucket.bootstrap.bucket}/bootstrap.sh /tmp/bootstrap.sh --region ${var.aws_region}",
    "nohup bash /tmp/bootstrap.sh >> /var/log/zentriz-bootstrap.log 2>&1 &",
  ]))

  # Aguarda user_data terminar antes de declarar "ready"
  user_data_replace_on_change = true

  tags = { Name = "${var.namespace}-server" }

  depends_on = [aws_internet_gateway.genesis]
}

# ──────────────────────────────────────────────
# ELASTIC IP — URL estável para demo
# ──────────────────────────────────────────────

resource "aws_eip" "genesis" {
  domain = "vpc"
  tags   = { Name = "${var.namespace}-eip" }
}

resource "aws_eip_association" "genesis" {
  instance_id   = aws_instance.genesis.id
  allocation_id = aws_eip.genesis.id
}

# ──────────────────────────────────────────────
# ROUTE53 — record A genesis.zentriz.com.br → Elastic IP
# ──────────────────────────────────────────────

data "aws_route53_zone" "zentriz" {
  name         = var.domain
  private_zone = false
}

resource "aws_route53_record" "genesis" {
  zone_id = data.aws_route53_zone.zentriz.zone_id
  name     = "${var.subdomain}.${var.domain}"
  type     = "A"
  ttl      = 60
  records  = [aws_eip.genesis.public_ip]
}

# ──────────────────────────────────────────────
# S3 — bootstrap script (user_data excede 16KB; script fica no S3)
# ──────────────────────────────────────────────

resource "aws_s3_bucket" "bootstrap" {
  bucket        = "${var.namespace}-bootstrap-${var.aws_account_id}"
  force_destroy = true

  tags = { Name = "${var.namespace}-bootstrap" }
}

resource "aws_s3_bucket_public_access_block" "bootstrap" {
  bucket                  = aws_s3_bucket.bootstrap.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "bootstrap_script" {
  bucket  = aws_s3_bucket.bootstrap.id
  key     = "bootstrap.sh"
  content = templatefile("${path.module}/user_data.sh.tpl", {
    namespace           = var.namespace
    environment         = var.environment
    aws_region          = var.aws_region
    secret_arn          = aws_secretsmanager_secret.genesis.arn
    github_repo_url     = var.github_repo_url
    github_repo_branch  = var.github_repo_branch
    project_files_dir   = var.project_files_dir
    bedrock_model_id    = var.bedrock_model_id
    bedrock_region      = var.bedrock_region
    pg_user             = var.pg_user
    pg_database         = var.pg_database
    next_public_api_url = "https://${var.subdomain}.${var.domain}"
    domain              = var.domain
    subdomain           = var.subdomain
    aws_account_id      = var.aws_account_id
    pg_password         = var.pg_password
  })
  etag = md5(templatefile("${path.module}/user_data.sh.tpl", {
    namespace           = var.namespace
    environment         = var.environment
    aws_region          = var.aws_region
    secret_arn          = aws_secretsmanager_secret.genesis.arn
    github_repo_url     = var.github_repo_url
    github_repo_branch  = var.github_repo_branch
    project_files_dir   = var.project_files_dir
    bedrock_model_id    = var.bedrock_model_id
    bedrock_region      = var.bedrock_region
    pg_user             = var.pg_user
    pg_database         = var.pg_database
    next_public_api_url = "https://${var.subdomain}.${var.domain}"
    domain              = var.domain
    subdomain           = var.subdomain
    aws_account_id      = var.aws_account_id
    pg_password         = var.pg_password
  }))
}

# ──────────────────────────────────────────────
# ECR — 4 repositórios (api, runner, agents, genesis-web)
# postgres e redis são imagens públicas — não precisam de ECR
# ──────────────────────────────────────────────

locals {
  ecr_images = ["api", "runner", "agents", "genesis-web"]
}

resource "aws_ecr_repository" "genesis" {
  for_each             = toset(local.ecr_images)
  name                 = "${var.namespace}/${each.key}"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = { Name = "${var.namespace}-${each.key}" }
}

resource "aws_ecr_lifecycle_policy" "genesis" {
  for_each   = aws_ecr_repository.genesis
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Manter apenas as 3 últimas imagens"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 3
      }
      action = { type = "expire" }
    }]
  })
}

# ──────────────────────────────────────────────
# CLOUDWATCH LOG GROUP
# ──────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "genesis" {
  name              = "/zentriz/genesis/${var.environment}"
  retention_in_days = 7

  tags = { Name = "${var.namespace}-logs" }
}
