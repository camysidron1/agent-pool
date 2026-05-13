type ServiceImage = {
  readonly service: "api" | "orchestrator" | "web";
  readonly dockerfile: string;
  readonly repository: string;
};

const SERVICES: readonly ServiceImage[] = [
  { service: "api", dockerfile: "apps/api/Dockerfile", repository: "agent-pool-api" },
  { service: "orchestrator", dockerfile: "apps/orchestrator/Dockerfile", repository: "agent-pool-orchestrator" },
  { service: "web", dockerfile: "apps/web/Dockerfile", repository: "agent-pool-web" },
];

type CliOptions = {
  readonly region: string;
  readonly accountId: string | null;
  readonly registry: string | null;
  readonly tag: string | null;
  readonly platform: string;
  readonly push: boolean;
  readonly login: boolean;
  readonly attest: boolean;
  readonly dryRun: boolean;
};

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}

export async function main(args: readonly string[]): Promise<void> {
  const options = parseArgs(args);
  const region = options.region;
  const accountId = options.accountId ?? (options.registry ? null : await readAwsAccountId());
  const registry = options.registry ?? `${accountId}.dkr.ecr.${region}.amazonaws.com`;
  const tag = options.tag ?? (await readGitSha());
  const images = SERVICES.map((service) => ({
    ...service,
    image: `${registry}/${service.repository}:${tag}`,
    command: buildDockerCommand({ ...service, image: `${registry}/${service.repository}:${tag}` }, options),
  }));

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, region, registry, tag, images }, null, 2)}\n`);
    return;
  }

  if (options.login) {
    await loginToEcr({ region, registry });
  }

  for (const image of images) {
    await run(image.command);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: false, region, registry, tag, images }, null, 2)}\n`);
}

function parseArgs(args: readonly string[]): CliOptions {
  let region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || "us-east-1";
  let accountId = process.env.AWS_ACCOUNT_ID?.trim() || null;
  let registry = process.env.ECR_REGISTRY?.trim() || null;
  let tag = process.env.IMAGE_TAG?.trim() || null;
  let platform = process.env.IMAGE_PLATFORM?.trim() || "linux/amd64";
  let push = true;
  let login = true;
  let attest = process.env.IMAGE_ATTESTATIONS?.trim() !== "false";
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--region":
        region = readFlag(args, (index += 1), arg);
        break;
      case "--account-id":
        accountId = readFlag(args, (index += 1), arg);
        break;
      case "--registry":
        registry = readFlag(args, (index += 1), arg);
        break;
      case "--tag":
        tag = readFlag(args, (index += 1), arg);
        break;
      case "--platform":
        platform = readFlag(args, (index += 1), arg);
        break;
      case "--load":
        push = false;
        break;
      case "--push":
        push = true;
        break;
      case "--no-login":
        login = false;
        break;
      case "--no-attest":
        attest = false;
        break;
      case "--dry-run":
      case "--plan":
        dryRun = true;
        login = false;
        break;
      default:
        throw new Error(`unknown images:build-push argument: ${arg}`);
    }
  }

  return { region, accountId, registry, tag, platform, push, login, attest, dryRun };
}

function buildDockerCommand(
  image: ServiceImage & { readonly image: string },
  options: Pick<CliOptions, "attest" | "platform" | "push">,
): readonly string[] {
  const command = ["docker", "buildx", "build", "--platform", options.platform, "-f", image.dockerfile, "-t", image.image, "."];
  if (options.push && options.attest) {
    command.push("--provenance=true", "--sbom=true");
  }
  command.push(options.push ? "--push" : "--load");
  return command;
}

function readFlag(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function readAwsAccountId(): Promise<string> {
  const output = await run(["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"], { capture: true });
  const accountId = output.trim();
  if (!/^\d{12}$/.test(accountId)) throw new Error(`aws sts returned an invalid account id: ${accountId}`);
  return accountId;
}

async function readGitSha(): Promise<string> {
  return (await run(["git", "rev-parse", "--short=12", "HEAD"], { capture: true })).trim();
}

async function loginToEcr(input: { readonly region: string; readonly registry: string }): Promise<void> {
  const password = await run(["aws", "ecr", "get-login-password", "--region", input.region], { capture: true });
  const login = Bun.spawn(["docker", "login", "--username", "AWS", "--password-stdin", input.registry], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  login.stdin.write(password);
  login.stdin.end();
  const exitCode = await login.exited;
  if (exitCode !== 0) throw new Error(`docker login failed with exit code ${exitCode}`);
}

async function run(command: readonly string[], options: { readonly capture?: boolean } = {}): Promise<string> {
  const child = Bun.spawn(command, {
    stdout: options.capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = options.capture ? await new Response(child.stdout).text() : "";
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  return output;
}
