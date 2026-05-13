variable "name_prefix" {
  type        = string
  description = "Prefix used for AWS infrastructure names."
}

variable "environment" {
  type        = string
  description = "Short environment name included in cost guardrail names."
}

variable "monthly_budget_limit_usd" {
  type        = number
  description = "Monthly AWS account budget amount in USD."
}

variable "budget_alert_thresholds_percent" {
  type        = list(number)
  description = "Budget notification thresholds. Notifications are only created when alert_subscriber_emails is non-empty."
}

variable "alert_subscriber_emails" {
  type        = list(string)
  description = "Optional email subscribers for AWS Budget and Cost Anomaly notifications."
  default     = []
}

variable "anomaly_absolute_threshold_usd" {
  type        = number
  description = "Minimum absolute USD impact before Cost Anomaly Detection sends a notification subscription."
}
