# Zentriz Genesis — variáveis AWS EC2 deploy
# Preencha terraform.tfvars (não commitar) ou use -var ao chamar terraform apply

# ──────────────────────────────────────────────
# INFRA BÁSICA
# ──────────────────────────────────────────────

variable "aws_region" {
  description = "Região AWS"
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS CLI profile da Conta A (onde sobe EC2, ECR, Secrets Manager)"
  type        = string
  default     = "zentriz"
}


variable "aws_account_id" {
  description = "ID da conta AWS onde o ECR será criado (Conta A)"
  type        = string
  # Obtenha com: aws sts get-caller-identity --query Account --output text
}

variable "environment" {
  description = "Ambiente: dev, staging, prod"
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment deve ser dev, staging ou prod."
  }
}

variable "namespace" {
  description = "Prefixo de recursos AWS"
  type        = string
  default     = "zentriz-genesis"
}

variable "vpc_cidr" {
  description = "CIDR da VPC"
  type        = string
  default     = "10.10.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR da subnet pública"
  type        = string
  default     = "10.10.1.0/24"
}

# ──────────────────────────────────────────────
# EC2
# ──────────────────────────────────────────────

variable "instance_type" {
  description = "Tipo de instância EC2"
  type        = string
  default     = "t3.large" # 2 vCPU, 8 GB RAM — mínimo para 6 containers + runner Python

  validation {
    condition     = contains(["t3.medium", "t3.large", "t3.xlarge", "t3a.large", "t3a.xlarge"], var.instance_type)
    error_message = "Use t3.medium (demo leve), t3.large (recomendado) ou t3.xlarge (projetos pesados)."
  }
}

variable "root_volume_size_gb" {
  description = "Tamanho do volume raiz (GB) — imagens Docker + artefatos gerados"
  type        = number
  default     = 40
}

variable "ssh_public_key_path" {
  description = "Path do arquivo .pub para acesso SSH à instância"
  type        = string
  default     = "~/.ssh/zentriz-genesis-aws.pub"
}

variable "admin_cidr_blocks" {
  description = "CIDRs autorizados para SSH (ex: [\"SEU_IP/32\"])"
  type        = list(string)
  default     = ["0.0.0.0/0"] # restrinja para seu IP em produção
}

# ──────────────────────────────────────────────
# REPOSITÓRIO
# ──────────────────────────────────────────────

variable "github_repo_url" {
  description = "URL HTTPS do repositório Genesis"
  type        = string
  default     = "https://github.com/zentriz-id/zentriz-genesis.git"
}

variable "github_repo_branch" {
  description = "Branch a fazer checkout"
  type        = string
  default     = "main"
}

# ──────────────────────────────────────────────
# APLICAÇÃO
# ──────────────────────────────────────────────

variable "project_files_dir" {
  description = "Diretório no host EC2 para artefatos gerados pelo pipeline"
  type        = string
  default     = "/opt/zentriz-files"
}

variable "domain" {
  description = "Domínio raiz hospedado no Route53 da Conta A"
  type        = string
  default     = "zentriz.com.br"
}

variable "subdomain" {
  description = "Subdomínio do Genesis"
  type        = string
  default     = "genesis"
}

variable "bedrock_model_id" {
  description = "Model ID do Bedrock (ex: anthropic.claude-sonnet-4-5, anthropic.claude-sonnet-4-6)"
  type        = string
  default     = "anthropic.claude-sonnet-4-5"
}

variable "bedrock_region" {
  description = "Região AWS onde o modelo Bedrock está habilitado (pode diferir da região da EC2)"
  type        = string
  default     = "us-east-1"
}

variable "pg_user" {
  description = "Usuário PostgreSQL"
  type        = string
  default     = "genesis"
}

variable "pg_database" {
  description = "Database PostgreSQL"
  type        = string
  default     = "zentriz_genesis"
}

# ──────────────────────────────────────────────
# SECRETS (sensíveis — não commitar valores)
# Credenciais da Conta B (Bedrock com créditos) — ficam no Secrets Manager da Conta A
# A EC2 lê o secret via instance profile e injeta nos containers via .env
# ──────────────────────────────────────────────

variable "bedrock_access_key_id" {
  description = "AWS Access Key ID da conta com créditos Bedrock (Conta B)"
  type        = string
  sensitive   = true
}

variable "bedrock_secret_access_key" {
  description = "AWS Secret Access Key da conta com créditos Bedrock (Conta B)"
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT secret para a API (string longa aleatória)"
  type        = string
  sensitive   = true
  default     = "" # se vazio, user_data gera automaticamente com openssl
}

variable "pg_password" {
  description = "Senha PostgreSQL"
  type        = string
  sensitive   = true
  default     = "genesis_staging"
}

variable "genesis_api_token" {
  description = "Token interno runner→API (GENESIS_API_TOKEN)"
  type        = string
  sensitive   = true
  default     = "" # se vazio, user_data gera automaticamente
}
