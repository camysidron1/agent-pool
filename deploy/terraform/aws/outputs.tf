output "aws_region" {
  value = var.aws_region
}

output "cluster_name" {
  value = aws_eks_cluster.agent_pool.name
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --region ${var.aws_region} --name ${aws_eks_cluster.agent_pool.name}"
}

output "app_url" {
  value = "https://${var.app_hostname}"
}

output "route53_zone_id" {
  value = local.route53_zone_id
}

output "route53_name_servers" {
  description = "Delegate your domain to these nameservers if Terraform created the hosted zone and your registrar is outside Route53."
  value       = local.route53_name_servers
}

output "acm_certificate_arn" {
  value = local.acm_certificate_arn
}

output "ecr_repository_urls" {
  value = { for service, repository in aws_ecr_repository.agent_pool : service => repository.repository_url }
}

output "storage_class_name" {
  value = kubernetes_storage_class_v1.gp3.metadata[0].name
}

output "aws_load_balancer_controller_role_arn" {
  value = try(aws_iam_role.aws_load_balancer_controller[0].arn, null)
}

output "external_dns_role_arn" {
  value = try(aws_iam_role.external_dns[0].arn, null)
}

output "monthly_budget_name" {
  value = try(module.cost_guardrails[0].monthly_budget_name, null)
}

output "monthly_budget_limit_usd" {
  value = try(module.cost_guardrails[0].monthly_budget_limit_usd, null)
}

output "cost_anomaly_monitor_arn" {
  value = try(module.cost_guardrails[0].cost_anomaly_monitor_arn, null)
}

output "cost_alerts_configured" {
  value = try(module.cost_guardrails[0].alerts_configured, false)
}
