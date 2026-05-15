import type {
  PublicRuntimeReadinessCheck,
  PublicRuntimeReadinessLink,
  PublicRuntimeReadinessStatus,
  PublicRuntimeReadinessSummary,
} from "./api";

export type RuntimeReadinessTone = "ready" | "blocked" | "warning" | "unknown";

export type RuntimeReadinessView = {
  readonly status: PublicRuntimeReadinessStatus;
  readonly tone: RuntimeReadinessTone;
  readonly statusLabel: string;
  readonly title: string;
  readonly body: string;
  readonly markerClassName: string;
  readonly missingPrerequisites: readonly string[];
  readonly visibleChecks: readonly PublicRuntimeReadinessCheck[];
  readonly links: readonly PublicRuntimeReadinessLink[];
};

export function summarizeRuntimeReadiness(readiness: PublicRuntimeReadinessSummary | null): RuntimeReadinessView {
  if (!readiness) {
    return {
      status: "unknown",
      tone: "unknown",
      statusLabel: "Unknown",
      title: "Runtime readiness",
      body: "Runtime readiness has not been loaded yet.",
      markerClassName: getRuntimeReadinessMarkerClass("unknown"),
      missingPrerequisites: [],
      visibleChecks: [],
      links: [],
    };
  }

  const tone = getRuntimeReadinessTone(readiness.status);
  return {
    status: readiness.status,
    tone,
    statusLabel: labelRuntimeReadinessStatus(readiness.status),
    title: `${readiness.runtimeProvider.toUpperCase()} ${readiness.agentRunnerMode}`,
    body: summarizeRuntimeReadinessBody(readiness),
    markerClassName: getRuntimeReadinessMarkerClass(readiness.status),
    missingPrerequisites: sanitizePrerequisites(readiness.missingPrerequisites),
    visibleChecks: getVisibleRuntimeReadinessChecks(readiness),
    links: dedupeRuntimeReadinessLinks(readiness.links),
  };
}

export function getRuntimeReadinessTone(status: PublicRuntimeReadinessStatus): RuntimeReadinessTone {
  switch (status) {
    case "ready":
      return "ready";
    case "blocked":
      return "blocked";
    case "warning":
      return "warning";
    case "unknown":
      return "unknown";
  }
}

export function getRuntimeReadinessMarkerClass(status: PublicRuntimeReadinessStatus): string {
  return `runtime-readiness-marker runtime-readiness-marker-${getRuntimeReadinessTone(status)}`;
}

export function getVisibleRuntimeReadinessChecks(
  readiness: PublicRuntimeReadinessSummary,
  limit = 4,
): readonly PublicRuntimeReadinessCheck[] {
  const prioritized = [
    ...readiness.checks.filter((check) => check.status === "block"),
    ...readiness.checks.filter((check) => check.status === "warn"),
    ...readiness.checks.filter((check) => check.status === "unknown"),
    ...readiness.checks.filter((check) => check.status === "pass"),
  ];
  return prioritized.slice(0, Math.max(0, limit));
}

function summarizeRuntimeReadinessBody(readiness: PublicRuntimeReadinessSummary): string {
  if (readiness.status === "ready") {
    return readiness.lastSmoke.status === "available"
      ? `Ready. Latest smoke task ${readiness.lastSmoke.taskStatus ?? "recorded"}.`
      : "Ready for live E2B smoke testing; no smoke task has been recorded yet.";
  }
  if (readiness.status === "blocked") {
    return readiness.missingPrerequisites.length > 0
      ? `${readiness.missingPrerequisites.length} prerequisite(s) missing before live sandbox testing.`
      : "Runtime readiness is blocked by one or more checks.";
  }
  if (readiness.status === "warning") {
    return readiness.warnings[0] ?? "Runtime readiness has warnings to review before live sandbox testing.";
  }

  return "Runtime readiness could not be determined from the current configuration.";
}

function labelRuntimeReadinessStatus(status: PublicRuntimeReadinessStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "blocked":
      return "Blocked";
    case "warning":
      return "Warning";
    case "unknown":
      return "Unknown";
  }
}

function sanitizePrerequisites(values: readonly string[]): readonly string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => !/agent-pool\.db|WEB_SANDBOX_DB_PATH|token=|password=|secret=/i.test(value))
    .slice(0, 6);
}

function dedupeRuntimeReadinessLinks(links: readonly PublicRuntimeReadinessLink[]): readonly PublicRuntimeReadinessLink[] {
  const seen = new Set<string>();
  const safeLinks: PublicRuntimeReadinessLink[] = [];

  for (const link of links) {
    const key = `${link.kind}:${link.href}`;
    if (seen.has(key)) continue;
    if (!link.href.startsWith("/api/public/")) continue;
    seen.add(key);
    safeLinks.push(link);
  }

  return safeLinks.slice(0, 4);
}
