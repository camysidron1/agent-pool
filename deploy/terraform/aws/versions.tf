terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.16"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}

data "aws_eks_cluster_auth" "agent_pool" {
  name = aws_eks_cluster.agent_pool.name
}

provider "kubernetes" {
  host                   = aws_eks_cluster.agent_pool.endpoint
  cluster_ca_certificate = base64decode(aws_eks_cluster.agent_pool.certificate_authority[0].data)
  token                  = data.aws_eks_cluster_auth.agent_pool.token
}

provider "helm" {
  kubernetes {
    host                   = aws_eks_cluster.agent_pool.endpoint
    cluster_ca_certificate = base64decode(aws_eks_cluster.agent_pool.certificate_authority[0].data)
    token                  = data.aws_eks_cluster_auth.agent_pool.token
  }
}
