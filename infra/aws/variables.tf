# Variáveis por ambiente (dev / staging / prod)

variable "aws_region" {
  description = "Região AWS"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Ambiente: dev, staging, prod"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment deve ser dev, staging ou prod."
  }
}

variable "namespace" {
  description = "Namespace do projeto (ex.: zentriz-genesis)"
  type        = string
  default     = "zentriz-genesis"
}
