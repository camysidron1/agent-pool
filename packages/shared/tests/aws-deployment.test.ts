import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const LEGACY_TUI_DB_PATH = "~/.agent-pool/data/agent-pool.db";

describe("AWS deployment foundation", () => {
  test("Terraform defines AWS substrate without owning app workloads", async () => {
    const terraform = await readDirectoryText("deploy/terraform/aws", /\.tf$/);
    const lockfile = await readText("deploy/terraform/aws/.terraform.lock.hcl");

    expect(terraform).toContain('resource "aws_vpc" "agent_pool"');
    expect(terraform).toContain('module "cost_guardrails"');
    expect(terraform).toContain('resource "aws_eks_cluster" "agent_pool"');
    expect(terraform).toContain('resource "aws_eks_node_group" "agent_pool"');
    expect(terraform).toContain("desired_size = var.node_desired_size");
    expect(terraform).toContain("max_size     = var.node_max_size");
    expect(terraform).toContain('resource "aws_ecr_repository" "agent_pool"');
    expect(terraform).toContain('image_tag_mutability = "IMMUTABLE"');
    expect(terraform).toContain("scan_on_push = true");
    expect(terraform).toContain('resource "aws_route53_zone" "agent_pool"');
    expect(terraform).toContain('data "aws_route53_zone" "agent_pool"');
    expect(terraform).toContain("create_route53_zone");
    expect(terraform).toContain("route53_name_servers");
    expect(terraform).toContain('resource "aws_acm_certificate" "agent_pool"');
    expect(terraform).toContain('resource "aws_route53_record" "certificate_validation"');
    expect(terraform).toContain("validate_acm_certificate");
    expect(terraform).toContain('resource "aws_eks_addon" "ebs_csi"');
    expect(terraform).toContain('resource "helm_release" "aws_load_balancer_controller"');
    expect(terraform).toContain('resource "helm_release" "external_dns"');
    expect(terraform).toContain('resource "kubernetes_storage_class_v1" "gp3"');

    expect(terraform).not.toContain('resource "kubernetes_deployment');
    expect(terraform).not.toContain('resource "kubernetes_stateful_set');
    expect(terraform).not.toContain('resource "aws_db_instance"');
    expect(terraform).not.toContain('resource "aws_mq_broker"');
    expect(terraform).not.toContain(LEGACY_TUI_DB_PATH);

    expect(lockfile).toContain('provider "registry.terraform.io/hashicorp/aws"');
    expect(lockfile).toContain('provider "registry.terraform.io/hashicorp/kubernetes"');
    expect(lockfile).toContain("h1:");
  });

  test("Terraform cost guardrails are module-owned and email-optional", async () => {
    const rootVariables = await readText("deploy/terraform/aws/variables.tf");
    const rootOutputs = await readText("deploy/terraform/aws/outputs.tf");
    const moduleTerraform = await readDirectoryText("deploy/terraform/aws/modules/cost-guardrails", /\.tf$/);
    const tfvarsExample = await readText("deploy/terraform/aws/terraform.tfvars.example");

    expect(rootVariables).toContain('variable "monthly_budget_limit_usd"');
    expect(rootVariables).toContain('variable "enable_cost_guardrails"');
    expect(rootVariables).toContain("Member accounts require payer-account billing access");
    expect(rootVariables).toContain("monthly_budget_limit_usd <= 500");
    expect(rootVariables).toContain('variable "cost_alert_emails"');
    expect(rootVariables).toContain("default     = []");
    expect(rootVariables).toContain("default     = 1");
    expect(rootVariables).toContain("default     = 2");

    const rootTerraform = await readDirectoryText("deploy/terraform/aws", /^main\.tf$/);
    expect(rootTerraform).toContain("count  = var.enable_cost_guardrails ? 1 : 0");

    expect(moduleTerraform).toContain('resource "aws_budgets_budget" "monthly"');
    expect(moduleTerraform).toContain('budget_type  = "COST"');
    expect(moduleTerraform).toContain('time_unit    = "MONTHLY"');
    expect(moduleTerraform).toContain('resource "aws_ce_anomaly_monitor" "services"');
    expect(moduleTerraform).toContain('monitor_dimension = "SERVICE"');
    expect(moduleTerraform).toContain('resource "aws_ce_anomaly_subscription" "email"');
    expect(moduleTerraform).toContain("count = local.alerts_configured ? 1 : 0");
    expect(moduleTerraform).toContain("for_each = local.alerts_configured");
    expect(moduleTerraform).toContain("subscriber_email_addresses = var.alert_subscriber_emails");

    expect(rootOutputs).toContain('output "monthly_budget_name"');
    expect(rootOutputs).toContain("try(module.cost_guardrails[0].monthly_budget_name, null)");
    expect(rootOutputs).toContain('output "cost_anomaly_monitor_arn"');
    expect(rootOutputs).toContain('output "cost_alerts_configured"');

    expect(tfvarsExample).toContain("enable_cost_guardrails   = false");
    expect(tfvarsExample).toContain("monthly_budget_limit_usd = 150");
    expect(tfvarsExample).toContain("cost_alert_emails        = []");
    expect(tfvarsExample).not.toContain("alerts@example.com");
  });

  test("container packaging uses non-root runtime images and supply-chain guardrails", async () => {
    const apiDockerfile = await readText("apps/api/Dockerfile");
    const orchestratorDockerfile = await readText("apps/orchestrator/Dockerfile");
    const webDockerfile = await readText("apps/web/Dockerfile");
    const buildScript = await readText("deploy/images/build-and-push.ts");
    const dockerignore = await readText(".dockerignore");

    expect(apiDockerfile).toContain("FROM oven/bun:1.2.23");
    expect(apiDockerfile).toContain("bun install --frozen-lockfile --production --ignore-scripts");
    expect(apiDockerfile).toContain("find apps packages -name node_modules -type d -prune -exec rm -rf {} +");
    expect(apiDockerfile).toContain("USER bun");
    expect(apiDockerfile).toContain("HEALTHCHECK");
    expect(apiDockerfile).toContain('CMD ["bun", "run", "apps/api/src/index.ts"]');

    expect(orchestratorDockerfile).toContain("FROM oven/bun:1.2.23");
    expect(orchestratorDockerfile).toContain("bun install --frozen-lockfile --production --ignore-scripts");
    expect(orchestratorDockerfile).toContain("find apps packages -name node_modules -type d -prune -exec rm -rf {} +");
    expect(orchestratorDockerfile).toContain("USER bun");
    expect(orchestratorDockerfile).toContain("HEALTHCHECK");
    expect(orchestratorDockerfile).toContain('CMD ["bun", "run", "apps/orchestrator/src/index.ts"]');

    expect(webDockerfile).toContain("FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime");
    expect(webDockerfile).toContain("find apps packages -name node_modules -type d -prune -exec rm -rf {} +");
    expect(webDockerfile).toContain("HEALTHCHECK");
    expect(webDockerfile).not.toContain("USER root");

    expect(buildScript).toContain("git\", \"rev-parse\", \"--short=12\", \"HEAD");
    expect(buildScript).toContain("--provenance=true");
    expect(buildScript).toContain("--sbom=true");
    expect(buildScript).toContain("--dry-run");
    expect(buildScript).not.toContain("E2B_API_KEY");
    expect(buildScript).not.toContain("GITHUB_TOKEN");
    expect(buildScript).not.toContain("INTERNAL_SERVICE_TOKEN");

    expect(dockerignore).toContain("node_modules");
    expect(dockerignore).toContain("agent-docs");
    expect(dockerignore).toContain("*.tfstate");
  });

  test("AWS Kustomize overlay routes public paths to the right services", async () => {
    const kustomization = await readText("deploy/kubernetes/kustomization.yaml");
    const ingressPatch = JSON.parse(await readText("deploy/kubernetes/overlays/aws/patches/ingress-alb.json")) as readonly JsonPatch[];
    const storagePatch = await readText("deploy/kubernetes/overlays/aws/patches/pvc-storage-class.json");
    const securityPatch = await readText("deploy/kubernetes/overlays/aws/patches/api-security-context.json");

    expect(kustomization).toContain("- agent-pool.production.json");
    expect(kustomization).toContain("000000000000.dkr.ecr.us-east-1.amazonaws.com/agent-pool-api");
    expect(kustomization).toContain("newTag: replace-with-git-sha");
    expect(kustomization).not.toContain("newTag: latest");
    expect(kustomization).toContain("data.BRIDGE_CALLBACK_BASE_URL");
    expect(kustomization).toContain("data.API_PUBLIC_URL");
    expect(kustomization).toContain("alb.ingress.kubernetes.io/certificate-arn");
    expect(kustomization).toContain("external-dns.alpha.kubernetes.io/hostname");

    const annotations = readPatchValue<Record<string, string>>(ingressPatch, "/metadata/annotations");
    expect(annotations["alb.ingress.kubernetes.io/scheme"]).toBe("internet-facing");
    expect(annotations["alb.ingress.kubernetes.io/target-type"]).toBe("ip");
    expect(annotations["alb.ingress.kubernetes.io/ssl-redirect"]).toBe("443");

    const paths = readPatchValue<readonly IngressPath[]>(ingressPatch, "/spec/rules/0/http/paths");
    expect(paths.map((path) => path.path)).toEqual(["/api", "/internal", "/callbacks", "/steering", "/health", "/metrics", "/"]);
    expect(paths.filter((path) => path.backend.service.name === "agent-pool-api").map((path) => path.path)).toEqual([
      "/api",
      "/internal",
      "/callbacks",
      "/steering",
      "/health",
      "/metrics",
    ]);
    expect(paths.at(-1)?.backend.service.name).toBe("agent-pool-web");

    expect(storagePatch).toContain('"/spec/storageClassName"');
    expect(storagePatch).toContain('"gp3"');
    expect(securityPatch).toContain('"fsGroup"');
    expect(securityPatch).toContain('"runAsNonRoot"');
    expect(`${kustomization}\n${JSON.stringify(ingressPatch)}\n${storagePatch}\n${securityPatch}`).not.toContain(LEGACY_TUI_DB_PATH);
  });
});

type JsonPatch = {
  readonly op: string;
  readonly path: string;
  readonly value?: unknown;
};

type IngressPath = {
  readonly path: string;
  readonly backend: {
    readonly service: {
      readonly name: string;
    };
  };
};

async function readText(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), "utf8");
}

async function readDirectoryText(path: string, pattern: RegExp): Promise<string> {
  const root = join(process.cwd(), path);
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) return readDirectoryText(entryPath, pattern);
      if (entry.isFile() && pattern.test(entry.name)) return readText(entryPath);
      return "";
    }),
  );

  return files.join("\n");
}

function readPatchValue<T>(patches: readonly JsonPatch[], path: string): T {
  const patch = patches.find((candidate) => candidate.path === path);
  if (!patch) throw new Error(`missing patch for ${path}`);
  return patch.value as T;
}
