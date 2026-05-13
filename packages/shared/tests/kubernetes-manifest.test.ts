import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type KubernetesObject = {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
  };
  readonly spec?: unknown;
  readonly data?: Readonly<Record<string, string>>;
  readonly stringData?: Readonly<Record<string, string>>;
};

type Container = {
  readonly name: string;
  readonly image?: string;
  readonly env?: readonly EnvVar[];
  readonly args?: readonly string[];
  readonly volumeMounts?: readonly VolumeMount[];
  readonly securityContext?: Readonly<Record<string, unknown>>;
};

type EnvVar = {
  readonly name: string;
  readonly value?: string;
  readonly valueFrom?: unknown;
};

type VolumeMount = {
  readonly name: string;
  readonly mountPath: string;
  readonly readOnly?: boolean;
};

type Volume = {
  readonly name: string;
  readonly persistentVolumeClaim?: {
    readonly claimName: string;
    readonly readOnly?: boolean;
  };
  readonly configMap?: {
    readonly name: string;
  };
};

type PodSpec = {
  readonly containers?: readonly Container[];
  readonly volumes?: readonly Volume[];
  readonly securityContext?: Readonly<Record<string, unknown>>;
};

const MANIFEST_PATH = join(process.cwd(), "deploy", "kubernetes", "agent-pool.production.json");
const SQLITE_CLAIM = "agent-pool-sqlite";
const LEGACY_TUI_DB_PATH = ".agent-pool/data/agent-pool.db";

describe("production Kubernetes manifest", () => {
  test("defines production control-plane workloads and services", async () => {
    const { items } = await loadManifest();

    expect(objectNames(items, "Deployment")).toEqual([
      "agent-pool-api",
      "agent-pool-orchestrator",
      "agent-pool-web",
      "agent-pool-prometheus",
    ]);
    expect(objectNames(items, "StatefulSet")).toEqual(["agent-pool-rabbitmq", "agent-pool-blob"]);
    expect(objectNames(items, "Service")).toEqual([
      "agent-pool-api",
      "agent-pool-orchestrator",
      "agent-pool-web",
      "agent-pool-rabbitmq",
      "agent-pool-blob",
      "agent-pool-prometheus",
    ]);
    expect(objectNames(items, "PersistentVolumeClaim")).toEqual([
      "agent-pool-sqlite",
      "agent-pool-sqlite-backups",
      "agent-pool-rabbitmq-data",
      "agent-pool-blob-data",
      "agent-pool-prometheus-data",
    ]);
    expect(findObject(items, "Secret", "agent-pool-secrets").metadata.namespace).toBe("agent-pool");
    expect(findObject(items, "ConfigMap", "agent-pool-config").metadata.namespace).toBe("agent-pool");
    expect(findObject(items, "ConfigMap", "agent-pool-prometheus-config").metadata.namespace).toBe("agent-pool");
    expect(findObject(items, "Job", "agent-pool-blob-bootstrap").metadata.namespace).toBe("agent-pool");
    expect(findObject(items, "CronJob", "agent-pool-sqlite-backup").metadata.namespace).toBe("agent-pool");
    expect(findObject(items, "Ingress", "agent-pool").metadata.namespace).toBe("agent-pool");
  });

  test("keeps SQLite persistence backend-owned and away from the orchestrator", async () => {
    const { items, text } = await loadManifest();
    const api = findObject(items, "Deployment", "agent-pool-api");
    const orchestrator = findObject(items, "Deployment", "agent-pool-orchestrator");
    const backup = findObject(items, "CronJob", "agent-pool-sqlite-backup");
    const apiContainer = findContainer(api, "api");
    const backupContainer = findContainer(backup, "backup");

    expect(envValue(apiContainer, "AGENT_POOL_WEB_SANDBOX_DB_PATH")).toBe("/var/lib/agent-pool/web-sandbox.db");
    expect(volumeClaimNames(api)).toContain(SQLITE_CLAIM);
    expect(volumeClaimNames(backup)).toContain(SQLITE_CLAIM);
    expect(findVolumeMount(backupContainer, "sqlite-data")).toMatchObject({
      mountPath: "/sqlite",
      readOnly: true,
    });

    const sqliteMountOwners = items
      .filter((item) => volumeClaimNames(item).includes(SQLITE_CLAIM))
      .map((item) => `${item.kind}/${item.metadata.name}`);

    expect(sqliteMountOwners).toEqual(["Deployment/agent-pool-api", "CronJob/agent-pool-sqlite-backup"]);

    const orchestratorText = JSON.stringify(orchestrator);
    expect(orchestratorText).not.toContain("AGENT_POOL_WEB_SANDBOX_DB_PATH");
    expect(orchestratorText).not.toContain("web-sandbox.db");
    expect(orchestratorText).not.toContain(SQLITE_CLAIM);
    expect(orchestratorText).not.toContain("/var/lib/agent-pool");
    expect(orchestratorText).not.toContain("@agent-pool/db");
    expect(orchestratorText).not.toContain("bun:sqlite");

    expect(text).not.toContain(LEGACY_TUI_DB_PATH);
    expect(text).not.toContain(`~/${LEGACY_TUI_DB_PATH}`);
  });

  test("wires auth secrets RabbitMQ blob storage and Prometheus", async () => {
    const { items } = await loadManifest();
    const config = findObject(items, "ConfigMap", "agent-pool-config").data ?? {};
    const secret = findObject(items, "Secret", "agent-pool-secrets").stringData ?? {};
    const prometheusConfig = findObject(items, "ConfigMap", "agent-pool-prometheus-config").data?.["prometheus.yml"] ?? "";
    const apiContainer = findContainer(findObject(items, "Deployment", "agent-pool-api"), "api");
    const orchestratorContainer = findContainer(findObject(items, "Deployment", "agent-pool-orchestrator"), "orchestrator");
    const blobStatefulSet = findObject(items, "StatefulSet", "agent-pool-blob");
    const blobBootstrap = findContainer(findObject(items, "Job", "agent-pool-blob-bootstrap"), "mc");
    const prometheus = findObject(items, "Deployment", "agent-pool-prometheus");
    const prometheusContainer = findContainer(prometheus, "prometheus");

    expect(config).toMatchObject({
      AUTH_MODE: "local",
      RABBITMQ_PROJECT_TASK_QUEUE_PREFIX: "project-tasks",
      RABBITMQ_PROJECT_CONTROL_QUEUE_PREFIX: "project-control",
      STORAGE_ADAPTER: "blob",
      STORAGE_BUCKET: "agent-pool-artifacts",
      BLOB_ENDPOINT_URL: "http://agent-pool-blob.agent-pool.svc.cluster.local:9000",
      RUNTIME_PROVIDER: "fake",
      COMPOSE_SMOKE_ENABLED: "true",
    });
    expect(Object.keys(secret).sort()).toEqual([
      "E2B_API_KEY",
      "GITHUB_TOKEN",
      "INTERNAL_SERVICE_TOKEN",
      "MINIO_ROOT_PASSWORD",
      "MINIO_ROOT_USER",
      "OPERATOR_DISPLAY_NAME",
      "OPERATOR_EMAIL",
      "OPERATOR_ID",
      "OPERATOR_PASSWORD",
      "PUBLIC_AUTH_SESSION_SECRET",
      "RABBITMQ_DEFAULT_PASS",
      "RABBITMQ_DEFAULT_USER",
      "RABBITMQ_MANAGEMENT_URL",
      "RABBITMQ_URL",
    ]);

    expect(envVar(apiContainer, "INTERNAL_SERVICE_TOKEN")?.valueFrom).toMatchObject({
      secretKeyRef: { name: "agent-pool-secrets", key: "INTERNAL_SERVICE_TOKEN" },
    });
    expect(envVar(apiContainer, "OPERATOR_ID")?.valueFrom).toMatchObject({
      secretKeyRef: { name: "agent-pool-secrets", key: "OPERATOR_ID" },
    });
    expect(envVar(apiContainer, "OPERATOR_PASSWORD")?.valueFrom).toMatchObject({
      secretKeyRef: { name: "agent-pool-secrets", key: "OPERATOR_PASSWORD" },
    });
    expect(envVar(apiContainer, "PUBLIC_AUTH_SESSION_SECRET")?.valueFrom).toMatchObject({
      secretKeyRef: { name: "agent-pool-secrets", key: "PUBLIC_AUTH_SESSION_SECRET" },
    });
    expect(envVar(apiContainer, "RABBITMQ_URL")?.valueFrom).toMatchObject({
      secretKeyRef: { name: "agent-pool-secrets", key: "RABBITMQ_URL" },
    });
    expect(envVar(orchestratorContainer, "RABBITMQ_MANAGEMENT_URL")?.valueFrom).toMatchObject({
      secretKeyRef: { name: "agent-pool-secrets", key: "RABBITMQ_MANAGEMENT_URL" },
    });
    expect(envVar(orchestratorContainer, "OPERATOR_ID")?.valueFrom).toMatchObject({
      secretKeyRef: { name: "agent-pool-secrets", key: "OPERATOR_ID" },
    });
    expect(envVar(orchestratorContainer, "RUNTIME_PROVIDER")?.valueFrom).toMatchObject({
      configMapKeyRef: { name: "agent-pool-config", key: "RUNTIME_PROVIDER" },
    });
    expect(envVar(orchestratorContainer, "COMPOSE_SMOKE_PROJECT_ID")?.valueFrom).toMatchObject({
      configMapKeyRef: { name: "agent-pool-config", key: "COMPOSE_SMOKE_PROJECT_ID" },
    });
    expect(envVar(orchestratorContainer, "E2B_API_KEY")?.valueFrom).toMatchObject({
      secretKeyRef: { name: "agent-pool-secrets", key: "E2B_API_KEY", optional: true },
    });
    expect(envVar(orchestratorContainer, "GITHUB_TOKEN")?.valueFrom).toMatchObject({
      secretKeyRef: { name: "agent-pool-secrets", key: "GITHUB_TOKEN", optional: true },
    });

    expect(volumeClaimNames(blobStatefulSet)).toEqual(["agent-pool-blob-data"]);
    expect(blobBootstrap.args?.join(" ")).toContain("agent-pool/agent-pool-artifacts");
    expect(podSpec(prometheus).securityContext).toMatchObject({ fsGroup: 65534, fsGroupChangePolicy: "OnRootMismatch" });
    expect(prometheusContainer.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: 65534,
    });
    expect(prometheusConfig).toContain("job_name: agent-pool-api");
    expect(prometheusConfig).toContain("agent-pool-api.agent-pool.svc.cluster.local:3000");
    expect(prometheusConfig).toContain("job_name: agent-pool-orchestrator");
    expect(prometheusConfig).toContain("agent-pool-orchestrator.agent-pool.svc.cluster.local:3001");
  });

  test("keeps checked-in deployment config fake-provider safe and placeholder-only", async () => {
    const { items, text } = await loadManifest();
    const secret = findObject(items, "Secret", "agent-pool-secrets").stringData ?? {};
    const config = findObject(items, "ConfigMap", "agent-pool-config").data ?? {};

    expect(config.RUNTIME_PROVIDER).toBe("fake");
    expect(config.E2B_TEMPLATE_ID).toBe("");
    expect(text).not.toMatch(/github-secret|e2b-secret|service-secret|compose-internal-service-token|test-service-token/);
    expect(text).not.toMatch(/docker compose|kubectl|bun:sqlite|openApiDatabase|openWebSandboxDatabase/);

    for (const [key, value] of Object.entries(secret)) {
      if (["OPERATOR_ID", "OPERATOR_EMAIL", "OPERATOR_DISPLAY_NAME", "RABBITMQ_DEFAULT_USER", "MINIO_ROOT_USER"].includes(key)) {
        expect(value).not.toContain("<");
        continue;
      }

      expect(value).toContain("<");
      expect(value).toContain(">");
    }
  });

  test("uses explicit app image placeholders instead of latest tags", async () => {
    const { items } = await loadManifest();
    const appImages = [
      findContainer(findObject(items, "Deployment", "agent-pool-api"), "api").image,
      findContainer(findObject(items, "Deployment", "agent-pool-orchestrator"), "orchestrator").image,
      findContainer(findObject(items, "Deployment", "agent-pool-web"), "web").image,
    ];

    expect(appImages).toEqual([
      "agent-pool-api:replace-with-git-sha",
      "agent-pool-orchestrator:replace-with-git-sha",
      "agent-pool-web:replace-with-git-sha",
    ]);

    for (const image of appImages) {
      expect(image).not.toEndWith(":latest");
    }
  });
});

async function loadManifest(): Promise<{ readonly text: string; readonly items: readonly KubernetesObject[] }> {
  const text = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(text) as { readonly kind?: unknown; readonly items?: unknown };

  expect(manifest.kind).toBe("List");
  expect(Array.isArray(manifest.items)).toBe(true);

  return {
    text,
    items: manifest.items as readonly KubernetesObject[],
  };
}

function objectNames(items: readonly KubernetesObject[], kind: string): readonly string[] {
  return items.filter((item) => item.kind === kind).map((item) => item.metadata.name);
}

function findObject(items: readonly KubernetesObject[], kind: string, name: string): KubernetesObject {
  const item = items.find((candidate) => candidate.kind === kind && candidate.metadata.name === name);
  if (!item) throw new Error(`missing Kubernetes object: ${kind}/${name}`);
  return item;
}

function findContainer(item: KubernetesObject, name: string): Container {
  const container = podSpec(item).containers?.find((candidate) => candidate.name === name);
  if (!container) throw new Error(`missing container ${name} in ${item.kind}/${item.metadata.name}`);
  return container;
}

function podSpec(item: KubernetesObject): PodSpec {
  const spec = item.spec as Record<string, unknown> | undefined;
  if (!spec) return {};

  if (item.kind === "Deployment" || item.kind === "StatefulSet") {
    return readPath(spec, ["template", "spec"]) as PodSpec;
  }

  if (item.kind === "Job") {
    return readPath(spec, ["template", "spec"]) as PodSpec;
  }

  if (item.kind === "CronJob") {
    return readPath(spec, ["jobTemplate", "spec", "template", "spec"]) as PodSpec;
  }

  return {};
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) return {};
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function volumeClaimNames(item: KubernetesObject): readonly string[] {
  return (podSpec(item).volumes ?? [])
    .map((volume) => volume.persistentVolumeClaim?.claimName)
    .filter((claimName): claimName is string => Boolean(claimName));
}

function findVolumeMount(container: Container, name: string): VolumeMount | null {
  return container.volumeMounts?.find((candidate) => candidate.name === name) ?? null;
}

function envVar(container: Container, name: string): EnvVar | null {
  return container.env?.find((candidate) => candidate.name === name) ?? null;
}

function envValue(container: Container, name: string): string | undefined {
  return envVar(container, name)?.value;
}
