output "monthly_budget_name" {
  value = aws_budgets_budget.monthly.name
}

output "monthly_budget_limit_usd" {
  value = var.monthly_budget_limit_usd
}

output "cost_anomaly_monitor_arn" {
  value = aws_ce_anomaly_monitor.services.arn
}

output "alerts_configured" {
  value = local.alerts_configured
}
