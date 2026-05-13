variable "aws_region" {
  type        = string
  description = "AWS region for Agent Pool infrastructure."
  default     = "us-east-1"
}

variable "name_prefix" {
  type        = string
  description = "Prefix used for AWS and Kubernetes infrastructure names."
  default     = "agent-pool"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name_prefix))
    error_message = "name_prefix must be lowercase kebab-case and 2-31 characters long."
  }
}

variable "environment" {
  type        = string
  description = "Short environment name included in tags and cluster names."
  default     = "mvp"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "environment must be lowercase kebab-case and 2-21 characters long."
  }
}

variable "route53_zone_name" {
  type        = string
  description = "Public DNS zone name, for example example.com."
  nullable    = false

  validation {
    condition     = length(trimspace(var.route53_zone_name)) > 0
    error_message = "route53_zone_name is required."
  }
}

variable "create_route53_zone" {
  type        = bool
  description = "Create the public Route53 hosted zone. Set false to look up an existing public hosted zone."
  default     = true
}

variable "validate_acm_certificate" {
  type        = bool
  description = "Wait for ACM DNS validation. For a newly delegated external domain, create the hosted zone first, delegate nameservers, then enable this."
  default     = true
}

variable "app_hostname" {
  type        = string
  description = "Single public Agent Pool hostname, for example agent-pool.example.com."
  nullable    = false

  validation {
    condition     = length(trimspace(var.app_hostname)) > 0
    error_message = "app_hostname is required."
  }
}

variable "kubernetes_version" {
  type        = string
  description = "EKS Kubernetes control-plane version."
  default     = "1.31"
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the Agent Pool VPC."
  default     = "10.42.0.0/16"
}

variable "az_count" {
  type        = number
  description = "Number of availability zones to use."
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "cluster_endpoint_public_access_cidrs" {
  type        = list(string)
  description = "CIDR blocks allowed to reach the EKS public API endpoint."
  default     = ["0.0.0.0/0"]
}

variable "node_instance_types" {
  type        = list(string)
  description = "Managed node group instance types."
  default     = ["t3.large"]
}

variable "node_desired_size" {
  type        = number
  description = "Desired managed node count."
  default     = 1
}

variable "node_min_size" {
  type        = number
  description = "Minimum managed node count."
  default     = 1
}

variable "node_max_size" {
  type        = number
  description = "Maximum managed node count."
  default     = 2
}

variable "enable_external_dns" {
  type        = bool
  description = "Install ExternalDNS with Route53 permissions so app overlays can create the public hostname."
  default     = true
}

variable "enable_aws_load_balancer_controller" {
  type        = bool
  description = "Install AWS Load Balancer Controller for ALB-backed Kubernetes ingress."
  default     = true
}

variable "enable_cost_guardrails" {
  type        = bool
  description = "Create AWS Budgets and Cost Anomaly Detection guardrails. Member accounts require payer-account billing access before enabling this."
  default     = true
}

variable "monthly_budget_limit_usd" {
  type        = number
  description = "Monthly AWS account budget for the Agent Pool MVP environment."
  default     = 150

  validation {
    condition     = var.monthly_budget_limit_usd > 0 && var.monthly_budget_limit_usd <= 500
    error_message = "monthly_budget_limit_usd must be between 1 and 500 for the MVP deployment."
  }
}

variable "budget_alert_thresholds_percent" {
  type        = list(number)
  description = "Budget notification thresholds. Notifications are only created when cost_alert_emails is non-empty."
  default     = [50, 80, 100]

  validation {
    condition     = length(var.budget_alert_thresholds_percent) > 0 && alltrue([for threshold in var.budget_alert_thresholds_percent : threshold > 0 && threshold <= 200])
    error_message = "budget_alert_thresholds_percent must contain percentage values between 1 and 200."
  }
}

variable "cost_alert_emails" {
  type        = list(string)
  description = "Optional email subscribers for AWS Budget and Cost Anomaly notifications. Leave empty to create guardrails without email subscriptions."
  default     = []

  validation {
    condition     = alltrue([for email in var.cost_alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))])
    error_message = "cost_alert_emails must contain valid email addresses."
  }
}

variable "anomaly_absolute_threshold_usd" {
  type        = number
  description = "Minimum absolute USD impact before Cost Anomaly Detection sends a notification subscription."
  default     = 25

  validation {
    condition     = var.anomaly_absolute_threshold_usd > 0
    error_message = "anomaly_absolute_threshold_usd must be greater than zero."
  }
}
