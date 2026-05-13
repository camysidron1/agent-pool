locals {
  name              = "${var.name_prefix}-${var.environment}"
  alerts_configured = length(var.alert_subscriber_emails) > 0
  budget_notifications = local.alerts_configured ? {
    for threshold in var.budget_alert_thresholds_percent : "actual-${threshold}" => {
      notification_type = "ACTUAL"
      threshold         = threshold
    }
  } : {}
}

resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly-cost"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = local.budget_notifications

    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = notification.value.notification_type
      subscriber_email_addresses = var.alert_subscriber_emails
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
    }
  }

  dynamic "notification" {
    for_each = local.alerts_configured ? { forecasted = true } : {}

    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = "FORECASTED"
      subscriber_email_addresses = var.alert_subscriber_emails
      threshold                  = 100
      threshold_type             = "PERCENTAGE"
    }
  }
}

resource "aws_ce_anomaly_monitor" "services" {
  name              = "${local.name}-service-cost-anomalies"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "email" {
  count = local.alerts_configured ? 1 : 0

  name             = "${local.name}-cost-anomaly-email"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  dynamic "subscriber" {
    for_each = toset(var.alert_subscriber_emails)

    content {
      address = subscriber.value
      type    = "EMAIL"
    }
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_absolute_threshold_usd)]
    }
  }
}
