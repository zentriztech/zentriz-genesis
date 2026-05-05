# Zentriz Genesis — outputs pós-deploy

output "portal_url" {
  description = "URL do Portal Genesis Web"
  value       = "https://${var.subdomain}.${var.domain}"
}

output "api_url" {
  description = "URL da API Genesis"
  value       = "https://${var.subdomain}.${var.domain}/api"
}

output "api_health" {
  description = "Endpoint de health da API"
  value       = "https://${var.subdomain}.${var.domain}/api/health"
}

output "ssh_command" {
  description = "Comando SSH para acessar a instância"
  value       = "ssh -i ~/.ssh/zentriz_id ubuntu@${aws_eip.genesis.public_ip}"
}

output "public_ip" {
  description = "Elastic IP público"
  value       = aws_eip.genesis.public_ip
}

output "instance_id" {
  description = "ID da instância EC2"
  value       = aws_instance.genesis.id
}

output "secret_arn" {
  description = "ARN do secret no Secrets Manager"
  value       = aws_secretsmanager_secret.genesis.arn
}

output "cloudwatch_log_group" {
  description = "Log group CloudWatch"
  value       = aws_cloudwatch_log_group.genesis.name
}

output "environment" {
  value = var.environment
}

output "aws_region" {
  value = var.aws_region
}

output "ecr_registry" {
  description = "Registry ECR (prefixo para todas as imagens)"
  value       = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
}

output "ecr_repositories" {
  description = "URIs completos dos repositórios ECR"
  value       = { for k, v in aws_ecr_repository.genesis : k => v.repository_url }
}

output "push_script" {
  description = "Comando para fazer push das imagens locais — rode após terraform apply"
  value       = "bash project/infra/aws/ecr-push.sh ${var.aws_account_id} ${var.aws_region}"
}
