locals {
  cluster_name = "${var.name_prefix}-${var.environment}"
  zone_name    = trimsuffix(var.route53_zone_name, ".")
  az_names     = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  az_map       = { for index, az in local.az_names : az => index }
  oidc_issuer  = replace(aws_eks_cluster.agent_pool.identity[0].oidc[0].issuer, "https://", "")
  route53_zone_id = (
    var.create_route53_zone
    ? aws_route53_zone.agent_pool[0].zone_id
    : data.aws_route53_zone.agent_pool[0].zone_id
  )
  route53_name_servers = (
    var.create_route53_zone
    ? aws_route53_zone.agent_pool[0].name_servers
    : data.aws_route53_zone.agent_pool[0].name_servers
  )
  acm_certificate_arn = (
    var.validate_acm_certificate
    ? aws_acm_certificate_validation.agent_pool[0].certificate_arn
    : aws_acm_certificate.agent_pool.arn
  )

  ecr_repositories = {
    api          = "${var.name_prefix}-api"
    orchestrator = "${var.name_prefix}-orchestrator"
    web          = "${var.name_prefix}-web"
  }

  tags = {
    Project     = "agent-pool"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

module "cost_guardrails" {
  count  = var.enable_cost_guardrails ? 1 : 0
  source = "./modules/cost-guardrails"

  name_prefix                     = var.name_prefix
  environment                     = var.environment
  monthly_budget_limit_usd        = var.monthly_budget_limit_usd
  budget_alert_thresholds_percent = var.budget_alert_thresholds_percent
  alert_subscriber_emails         = var.cost_alert_emails
  anomaly_absolute_threshold_usd  = var.anomaly_absolute_threshold_usd
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_route53_zone" "agent_pool" {
  count = var.create_route53_zone ? 0 : 1

  name         = local.zone_name
  private_zone = false
}

resource "aws_route53_zone" "agent_pool" {
  count = var.create_route53_zone ? 1 : 0

  name = local.zone_name

  tags = {
    Name = local.zone_name
  }
}

resource "aws_vpc" "agent_pool" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = local.cluster_name
  }
}

resource "aws_internet_gateway" "agent_pool" {
  vpc_id = aws_vpc.agent_pool.id

  tags = {
    Name = "${local.cluster_name}-igw"
  }
}

resource "aws_subnet" "public" {
  for_each = local.az_map

  vpc_id                  = aws_vpc.agent_pool.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, each.value)
  map_public_ip_on_launch = true

  tags = {
    Name                                          = "${local.cluster_name}-public-${each.key}"
    "kubernetes.io/cluster/${local.cluster_name}" = "shared"
    "kubernetes.io/role/elb"                      = "1"
  }
}

resource "aws_subnet" "private" {
  for_each = local.az_map

  vpc_id            = aws_vpc.agent_pool.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, each.value + var.az_count)

  tags = {
    Name                                          = "${local.cluster_name}-private-${each.key}"
    "kubernetes.io/cluster/${local.cluster_name}" = "shared"
    "kubernetes.io/role/internal-elb"             = "1"
  }
}

resource "aws_eip" "nat" {
  domain = "vpc"

  depends_on = [aws_internet_gateway.agent_pool]

  tags = {
    Name = "${local.cluster_name}-nat"
  }
}

resource "aws_nat_gateway" "agent_pool" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[local.az_names[0]].id

  depends_on = [aws_internet_gateway.agent_pool]

  tags = {
    Name = "${local.cluster_name}-nat"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.agent_pool.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.agent_pool.id
  }

  tags = {
    Name = "${local.cluster_name}-public"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.agent_pool.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.agent_pool.id
  }

  tags = {
    Name = "${local.cluster_name}-private"
  }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}

resource "aws_ecr_repository" "agent_pool" {
  for_each = local.ecr_repositories

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "agent_pool" {
  for_each = aws_ecr_repository.agent_pool

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the latest 30 pushed images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_acm_certificate" "agent_pool" {
  domain_name       = var.app_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.agent_pool.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = local.route53_zone_id
}

resource "aws_acm_certificate_validation" "agent_pool" {
  count = var.validate_acm_certificate ? 1 : 0

  certificate_arn         = aws_acm_certificate.agent_pool.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_iam_role" "eks_cluster" {
  name = "${local.cluster_name}-eks-cluster"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "eks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "agent_pool" {
  name     = local.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.cluster_endpoint_public_access_cidrs
    subnet_ids              = concat(values(aws_subnet.public)[*].id, values(aws_subnet.private)[*].id)
  }

  depends_on = [aws_iam_role_policy_attachment.eks_cluster]
}

resource "aws_iam_role" "eks_nodes" {
  name = "${local.cluster_name}-eks-nodes"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "eks_node_worker" {
  role       = aws_iam_role.eks_nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "eks_node_cni" {
  role       = aws_iam_role.eks_nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "eks_node_ecr" {
  role       = aws_iam_role.eks_nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_eks_node_group" "agent_pool" {
  cluster_name    = aws_eks_cluster.agent_pool.name
  node_group_name = "${local.cluster_name}-default"
  node_role_arn   = aws_iam_role.eks_nodes.arn
  subnet_ids      = values(aws_subnet.private)[*].id
  instance_types  = var.node_instance_types

  scaling_config {
    desired_size = var.node_desired_size
    min_size     = var.node_min_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_node_worker,
    aws_iam_role_policy_attachment.eks_node_cni,
    aws_iam_role_policy_attachment.eks_node_ecr,
  ]
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.agent_pool.name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_update = "OVERWRITE"
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name                = aws_eks_cluster.agent_pool.name
  addon_name                  = "kube-proxy"
  resolve_conflicts_on_update = "OVERWRITE"
}

resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.agent_pool.name
  addon_name                  = "coredns"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_node_group.agent_pool]
}

data "tls_certificate" "oidc" {
  url = aws_eks_cluster.agent_pool.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "agent_pool" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.agent_pool.identity[0].oidc[0].issuer
}

resource "aws_iam_role" "ebs_csi" {
  name = "${local.cluster_name}-ebs-csi"

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
            "${local.oidc_issuer}:sub" = "system:serviceaccount:kube-system:ebs-csi-controller-sa"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name                = aws_eks_cluster.agent_pool.name
  addon_name                  = "aws-ebs-csi-driver"
  service_account_role_arn    = aws_iam_role.ebs_csi.arn
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_iam_role_policy_attachment.ebs_csi]
}
