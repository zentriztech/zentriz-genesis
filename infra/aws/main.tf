# Zentriz Genesis — AWS (base)
# Terraform mínimo: backend para state, variáveis por ambiente (dev/staging/prod).
# Recursos (EKS, RDS, etc.) serão adicionados conforme evolução do projeto.

terraform {
  required_version = ">= 1.0"

  # Backend remoto (descomente e configure para trabalho em equipe)
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

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "zentriz-genesis"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Placeholder: recurso mínimo para validar apply (opcional)
# resource "aws_s3_bucket" "tfstate" {
#   bucket = "zentriz-genesis-tfstate-${var.environment}"
# }
