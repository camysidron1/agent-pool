resource "aws_iam_role" "aws_load_balancer_controller" {
  count = var.enable_aws_load_balancer_controller ? 1 : 0
  name  = "${local.cluster_name}-aws-lbc"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.agent_pool.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${local.oidc_issuer}:aud" = "sts.amazonaws.com"
            "${local.oidc_issuer}:sub" = "system:serviceaccount:kube-system:aws-load-balancer-controller"
          }
        }
      }
    ]
  })
}

resource "aws_iam_policy" "aws_load_balancer_controller" {
  count = var.enable_aws_load_balancer_controller ? 1 : 0
  name  = "${local.cluster_name}-aws-lbc"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "iam:CreateServiceLinkedRole",
          "ec2:DescribeAccountAttributes",
          "ec2:DescribeAddresses",
          "ec2:DescribeAvailabilityZones",
          "ec2:DescribeCoipPools",
          "ec2:DescribeInstances",
          "ec2:DescribeInternetGateways",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeTags",
          "ec2:DescribeVpcs",
          "ec2:GetCoipPoolUsage",
          "ec2:GetSecurityGroupsForVpc",
          "ec2:DescribeVpcPeeringConnections",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupIngress",
          "ec2:CreateSecurityGroup",
          "ec2:CreateTags",
          "ec2:DeleteTags",
          "ec2:DeleteSecurityGroup",
          "elasticloadbalancing:AddListenerCertificates",
          "elasticloadbalancing:AddTags",
          "elasticloadbalancing:CreateListener",
          "elasticloadbalancing:CreateLoadBalancer",
          "elasticloadbalancing:CreateRule",
          "elasticloadbalancing:CreateTargetGroup",
          "elasticloadbalancing:DeleteListener",
          "elasticloadbalancing:DeleteLoadBalancer",
          "elasticloadbalancing:DeleteRule",
          "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:DescribeListenerCertificates",
          "elasticloadbalancing:DescribeListenerAttributes",
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeLoadBalancerAttributes",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeSSLPolicies",
          "elasticloadbalancing:DescribeTags",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetGroupAttributes",
          "elasticloadbalancing:DescribeTargetHealth",
          "elasticloadbalancing:ModifyListener",
          "elasticloadbalancing:ModifyLoadBalancerAttributes",
          "elasticloadbalancing:ModifyRule",
          "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:ModifyTargetGroupAttributes",
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:RemoveListenerCertificates",
          "elasticloadbalancing:RemoveTags",
          "elasticloadbalancing:SetIpAddressType",
          "elasticloadbalancing:SetSecurityGroups",
          "elasticloadbalancing:SetSubnets",
          "elasticloadbalancing:SetWebAcl",
          "acm:DescribeCertificate",
          "acm:ListCertificates",
          "iam:GetServerCertificate",
          "iam:ListServerCertificates",
          "cognito-idp:DescribeUserPoolClient",
          "waf-regional:GetWebACL",
          "waf-regional:GetWebACLForResource",
          "waf-regional:AssociateWebACL",
          "waf-regional:DisassociateWebACL",
          "wafv2:GetWebACL",
          "wafv2:GetWebACLForResource",
          "wafv2:AssociateWebACL",
          "wafv2:DisassociateWebACL",
          "shield:DescribeProtection",
          "shield:GetSubscriptionState",
          "shield:CreateProtection",
          "shield:DeleteProtection"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "aws_load_balancer_controller" {
  count      = var.enable_aws_load_balancer_controller ? 1 : 0
  role       = aws_iam_role.aws_load_balancer_controller[0].name
  policy_arn = aws_iam_policy.aws_load_balancer_controller[0].arn
}

resource "kubernetes_service_account_v1" "aws_load_balancer_controller" {
  count = var.enable_aws_load_balancer_controller ? 1 : 0

  metadata {
    name      = "aws-load-balancer-controller"
    namespace = "kube-system"
    annotations = {
      "eks.amazonaws.com/role-arn" = aws_iam_role.aws_load_balancer_controller[0].arn
    }
  }

  depends_on = [aws_eks_node_group.agent_pool]
}

resource "helm_release" "aws_load_balancer_controller" {
  count      = var.enable_aws_load_balancer_controller ? 1 : 0
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  namespace  = "kube-system"

  set {
    name  = "clusterName"
    value = aws_eks_cluster.agent_pool.name
  }

  set {
    name  = "region"
    value = var.aws_region
  }

  set {
    name  = "vpcId"
    value = aws_vpc.agent_pool.id
  }

  set {
    name  = "serviceAccount.create"
    value = "false"
  }

  set {
    name  = "serviceAccount.name"
    value = kubernetes_service_account_v1.aws_load_balancer_controller[0].metadata[0].name
  }

  depends_on = [
    aws_iam_role_policy_attachment.aws_load_balancer_controller,
    kubernetes_service_account_v1.aws_load_balancer_controller,
  ]
}

resource "aws_iam_role" "external_dns" {
  count = var.enable_external_dns ? 1 : 0
  name  = "${local.cluster_name}-external-dns"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.agent_pool.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${local.oidc_issuer}:aud" = "sts.amazonaws.com"
            "${local.oidc_issuer}:sub" = "system:serviceaccount:kube-system:external-dns"
          }
        }
      }
    ]
  })
}

resource "aws_iam_policy" "external_dns" {
  count = var.enable_external_dns ? 1 : 0
  name  = "${local.cluster_name}-external-dns"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "route53:ChangeResourceRecordSets"
        ]
        Resource = "arn:aws:route53:::hostedzone/${local.route53_zone_id}"
      },
      {
        Effect = "Allow"
        Action = [
          "route53:ListHostedZones",
          "route53:ListResourceRecordSets"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "external_dns" {
  count      = var.enable_external_dns ? 1 : 0
  role       = aws_iam_role.external_dns[0].name
  policy_arn = aws_iam_policy.external_dns[0].arn
}

resource "kubernetes_service_account_v1" "external_dns" {
  count = var.enable_external_dns ? 1 : 0

  metadata {
    name      = "external-dns"
    namespace = "kube-system"
    annotations = {
      "eks.amazonaws.com/role-arn" = aws_iam_role.external_dns[0].arn
    }
  }

  depends_on = [aws_eks_node_group.agent_pool]
}

resource "helm_release" "external_dns" {
  count      = var.enable_external_dns ? 1 : 0
  name       = "external-dns"
  repository = "https://kubernetes-sigs.github.io/external-dns/"
  chart      = "external-dns"
  namespace  = "kube-system"

  set {
    name  = "provider.name"
    value = "aws"
  }

  set {
    name  = "policy"
    value = "upsert-only"
  }

  set {
    name  = "registry"
    value = "txt"
  }

  set {
    name  = "txtOwnerId"
    value = local.cluster_name
  }

  set {
    name  = "domainFilters[0]"
    value = local.zone_name
  }

  set {
    name  = "serviceAccount.create"
    value = "false"
  }

  set {
    name  = "serviceAccount.name"
    value = kubernetes_service_account_v1.external_dns[0].metadata[0].name
  }

  depends_on = [
    aws_iam_role_policy_attachment.external_dns,
    kubernetes_service_account_v1.external_dns,
  ]
}

resource "kubernetes_storage_class_v1" "gp3" {
  metadata {
    name = "gp3"
  }

  storage_provisioner    = "ebs.csi.aws.com"
  reclaim_policy         = "Retain"
  volume_binding_mode    = "WaitForFirstConsumer"
  allow_volume_expansion = true

  parameters = {
    type      = "gp3"
    encrypted = "true"
  }

  depends_on = [aws_eks_addon.ebs_csi]
}
