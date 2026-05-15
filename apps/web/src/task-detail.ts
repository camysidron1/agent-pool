import type { JsonRecord, PublicArtifactSummary, PublicEventSummary, PublicLogStreamSummary, PublicSessionSummary, PublicTaskDetail } from "./api";
import { summarizeLogStream } from "./board";

const ARTIFACT_KIND_ORDER = ["document", "file", "link", "log", "final_response_url"] as const;

export type RawLogEntry = {
  readonly id: string;
  readonly stream: string;
  readonly sequence: number | null;
  readonly text: string;
  readonly observedAt: string | null;
  readonly createdAt: string;
};

export type ScrollMetrics = {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
};

export type ArtifactGroup = {
  readonly kind: string;
  readonly label: string;
  readonly artifacts: readonly PublicArtifactSummary[];
};

export type AttemptTimelineItem = {
  readonly session: PublicSessionSummary;
  readonly isLatest: boolean;
  readonly title: string;
  readonly timing: string;
  readonly heartbeat: string;
};

export type SessionInitializationMilestone = {
  readonly id: "sandbox" | "repository" | "setup" | "agent";
  readonly label: string;
  readonly status: "pending" | "running" | "done" | "skipped" | "failed";
  readonly detail: string | null;
};

export type SecurityLifecycleBadge = {
  readonly id: string;
  readonly label: string;
  readonly tone: "neutral" | "good" | "warning" | "danger";
};

export type SecurityTimelineTone = "allowed" | "denied" | "warning" | "blocked";

export type SecurityTimelineItem = {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly tone: SecurityTimelineTone;
  readonly observedAt: string | null;
  readonly securityKind: string;
};

export type FinalResultDetail = {
  readonly recorded: boolean;
  readonly sessionId: string | null;
  readonly recordedAt: string | null;
  readonly text: string | null;
  readonly metadata: JsonRecord;
  readonly urls: readonly string[];
};

export function getSessionInitializationMilestones(
  task: PublicTaskDetail,
  session: PublicSessionSummary | null,
): readonly SessionInitializationMilestone[] {
  if (!session) {
    return [
      { id: "sandbox", label: "Set up cloud container", status: "pending", detail: null },
      { id: "repository", label: "Cloned repository", status: task.runtimeSource ? "pending" : "skipped", detail: task.runtimeSource?.repositoryUrl ?? null },
      { id: "setup", label: "Run setup script", status: "skipped", detail: "No setup script configured." },
      { id: "agent", label: "Started Codex", status: "pending", detail: null },
    ];
  }

  const terminalFailed = session.status === "failed" || session.status === "canceled";
  const sandboxReady = Boolean(session.runtimeSessionId) || ["running", "succeeded", "failed", "canceled"].includes(session.status);
  const codexStarted = hasCodexStartEvent(task, session);

  return [
    {
      id: "sandbox",
      label: "Set up cloud container",
      status: sandboxReady ? "done" : session.status === "starting" ? "running" : terminalFailed ? "failed" : "pending",
      detail: session.runtimeSessionId ? `Sandbox ${session.runtimeSessionId}` : null,
    },
    {
      id: "repository",
      label: "Cloned repository",
      status: task.runtimeSource ? (sandboxReady ? "done" : terminalFailed ? "failed" : "pending") : "skipped",
      detail: task.runtimeSource ? `${task.runtimeSource.repositoryUrl} @ ${task.runtimeSource.baseRef}` : "No GitHub source configured.",
    },
    {
      id: "setup",
      label: "Run setup script",
      status: "skipped",
      detail: "No setup script configured.",
    },
    {
      id: "agent",
      label: "Started Codex",
      status: codexStarted ? "done" : session.status === "running" ? "running" : terminalFailed ? "failed" : "pending",
      detail: readSessionRunner(task, session) ?? null,
    },
  ];
}

export function getRawLogEntries(task: PublicTaskDetail): readonly RawLogEntry[] {
  return task.events
    .filter((event) => event.type === "session.output")
    .map(readRawLogEntry)
    .filter((entry): entry is RawLogEntry => entry !== null)
    .sort((left, right) => {
      const sequenceDelta = (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
      if (sequenceDelta !== 0) return sequenceDelta;

      return Date.parse(left.createdAt) - Date.parse(right.createdAt);
    });
}

export function getSecurityLifecycleBadges(task: PublicTaskDetail): readonly SecurityLifecycleBadge[] {
  const securityEvents = getRawLogEntries(task)
    .map((entry) => parseSecurityLog(entry.text))
    .filter((entry): entry is JsonRecord => entry !== null);
  const hasProxy = securityEvents.some((event) => event.securityKind === "egress" && event.allowed === true);
  const hasDenied = securityEvents.some((event) => event.securityKind === "egress" && event.allowed === false);
  const hasScrubFailure = securityEvents.some((event) => String(event.securityKind) === "credentials-scrub-failed" || (String(event.securityKind) === "credentials-scrubbed" && event.allowed === false));
  const hasScrub = securityEvents.some((event) => String(event.securityKind) === "credentials-scrub-succeeded" || String(event.securityKind) === "credentials-scrubbed");
  const hasDeniedPolicy = securityEvents.some((event) => String(event.securityKind) === "command-policy" && event.allowed === false);
  const hasPolicy = securityEvents.some((event) =>
    ["postflight", "package-install", "package-registry", "command-policy"].includes(String(event.securityKind)),
  );
  const snapshotDecision = [...securityEvents].reverse().find((event) => event.securityKind === "snapshot-decision");
  const snapshotStatus = typeof snapshotDecision?.snapshotEligibilityStatus === "string" ? snapshotDecision.snapshotEligibilityStatus : null;

  return [
    {
      id: "egress",
      label: hasDenied ? "Egress denied" : hasProxy ? "Proxy egress" : "Egress pending",
      tone: hasDenied ? "danger" : hasProxy ? "good" : "neutral",
    },
    {
      id: "policy",
      label: hasDeniedPolicy ? "Command denied" : hasPolicy ? "Policy logged" : "Policy pending",
      tone: hasDeniedPolicy ? "danger" : hasPolicy ? "good" : "neutral",
    },
    {
      id: "scrub",
      label: hasScrubFailure ? "Scrub failed" : hasScrub ? "Credentials scrubbed" : "Scrub pending",
      tone: hasScrubFailure ? "danger" : hasScrub ? "good" : "warning",
    },
    {
      id: "snapshot",
      label: snapshotStatus === "clean" ? "Snapshot clean" : snapshotStatus === "risk" ? "Snapshot risk" : snapshotStatus === "ineligible" ? "Snapshot skipped" : "Snapshot pending",
      tone: snapshotStatus === "clean" ? "good" : snapshotStatus === "risk" ? "warning" : snapshotStatus === "ineligible" ? "warning" : "neutral",
    },
  ];
}

export function getSecurityTimeline(task: PublicTaskDetail): readonly SecurityTimelineItem[] {
  const latestSession = task.latestSession ?? [...task.sessions].sort(compareSessions).at(-1) ?? null;
  const entries: SecurityTimelineInternalItem[] = [];
  let order = 0;

  if (latestSession && isSessionStarted(latestSession)) {
    const startedAt = latestSession.startedAt ?? latestSession.createdAt;
    entries.push({
      id: `${latestSession.id}:sandbox-created`,
      label: "Sandbox created",
      detail: latestSession.runtimeSessionId ? `Provider sandbox ${sanitizeSecurityValue(latestSession.runtimeSessionId)}` : `Session ${sanitizeSecurityValue(latestSession.id)}`,
      tone: "allowed",
      observedAt: startedAt,
      securityKind: "sandbox-created",
      order: order++,
    });

    if (task.runtimeSource) {
      entries.push({
        id: `${latestSession.id}:repo-cloned`,
        label: "Repository cloned",
        detail: `${sanitizeSecurityValue(task.runtimeSource.repositoryUrl)} @ ${sanitizeSecurityValue(task.runtimeSource.baseRef)}`,
        tone: "allowed",
        observedAt: startedAt,
        securityKind: "repository-cloned",
        order: order++,
      });
    }

    if (task.runtimeSource?.commandProfile) {
      entries.push({
        id: `${latestSession.id}:policy-loaded`,
        label: "Command policy loaded",
        detail: sanitizeSecurityValue(task.runtimeSource.commandProfile),
        tone: "allowed",
        observedAt: startedAt,
        securityKind: "command-policy-loaded",
        order: order++,
      });
    }
  }

  getRawLogEntries(task).forEach((entry, index) => {
    const payload = parseSecurityLog(entry.text);
    if (!payload) return;
    entries.push({
      id: `${entry.id}:security`,
      label: labelSecurityTimelineEvent(payload),
      detail: formatSecurityTimelineDetail(payload),
      tone: toneSecurityTimelineEvent(payload),
      observedAt: entry.observedAt ?? entry.createdAt,
      securityKind: String(payload.securityKind ?? "security"),
      order: 1000 + index,
    });
  });

  for (const event of task.events) {
    if (event.type === "session.cleanup" || event.type === "session.cleanup.idempotent") {
      entries.push({
        id: `${event.id}:bridge-cleanup`,
        label: "Bridge cleanup callback",
        detail: "Sandbox process reported cleanup complete",
        tone: "allowed",
        observedAt: event.createdAt,
        securityKind: "bridge-cleanup",
        order: 8000 + order++,
      });
    }
    if (event.type === "runtime_sandbox.cleanup_succeeded") {
      entries.push({
        id: `${event.id}:sandbox-destroyed`,
        label: "Sandbox destroyed",
        detail: "Provider cleanup completed",
        tone: "allowed",
        observedAt: event.createdAt,
        securityKind: "sandbox-destroyed",
        order: 9000 + order++,
      });
    }
    if (event.type === "runtime_sandbox.cleanup_failed") {
      entries.push({
        id: `${event.id}:sandbox-destroy-failed`,
        label: "Sandbox destroy failed",
        detail: formatEventFailureDetail(event.payload),
        tone: "blocked",
        observedAt: event.createdAt,
        securityKind: "sandbox-destroy-failed",
        order: 9000 + order++,
      });
    }
  }

  return entries
    .sort((left, right) => compareTimelineItems(left, right))
    .map(({ order: _order, ...item }) => item);
}

export function formatRawLogEntries(entries: readonly RawLogEntry[]): string {
  return entries.map((entry) => entry.text).join("");
}

export function summarizeLogFallback(logStreams: readonly PublicLogStreamSummary[]): readonly string[] {
  return logStreams.map(summarizeLogStream);
}

export function shouldFollowRawLogScroll(metrics: ScrollMetrics, thresholdPx = 24): boolean {
  const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceFromBottom <= thresholdPx;
}

export function groupArtifacts(artifacts: readonly PublicArtifactSummary[]): readonly ArtifactGroup[] {
  const grouped = new Map<string, PublicArtifactSummary[]>();
  for (const artifact of artifacts) {
    const group = grouped.get(artifact.kind) ?? [];
    group.push(artifact);
    grouped.set(artifact.kind, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => artifactKindRank(left) - artifactKindRank(right) || left.localeCompare(right))
    .map(([kind, items]) => ({
      kind,
      label: labelArtifactKind(kind),
      artifacts: [...items].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.uri.localeCompare(right.uri)),
    }));
}

export function getArtifactTitle(artifact: PublicArtifactSummary): string {
  return artifact.title?.trim() || artifact.uri.split("/").filter(Boolean).at(-1) || artifact.uri;
}

export function getArtifactStatus(artifact: PublicArtifactSummary): string {
  const status =
    readMetadataString(artifact, "status") ??
    readMetadataString(artifact, "externalStatus") ??
    readMetadataString(artifact, "state");
  return status ?? "unknown";
}

export function getArtifactHref(artifact: PublicArtifactSummary): string | null {
  if (/^https?:\/\//i.test(artifact.uri)) return artifact.uri;

  const metadataUrl = readMetadataString(artifact, "url");
  return metadataUrl && /^https?:\/\//i.test(metadataUrl) ? metadataUrl : null;
}

export function canPreviewArtifact(artifact: PublicArtifactSummary): boolean {
  return artifact.kind === "document";
}

export function getAttemptTimeline(task: PublicTaskDetail): readonly AttemptTimelineItem[] {
  const latestSessionId = task.latestSession?.id ?? task.sessions.at(-1)?.id ?? null;

  return [...task.sessions]
    .sort((left, right) => left.attemptNumber - right.attemptNumber || Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((session) => ({
      session,
      isLatest: session.id === latestSessionId,
      title: `Attempt ${session.attemptNumber}`,
      timing: formatAttemptTiming(session),
      heartbeat: formatAttemptHeartbeat(session),
    }));
}

export function getFinalResultDetail(task: PublicTaskDetail): FinalResultDetail {
  const session = [...task.sessions].reverse().find((candidate) => candidate.finalResponseRecordedAt || candidate.finalResponseText) ?? null;
  const urls = task.artifacts.filter((artifact) => artifact.kind === "final_response_url").map((artifact) => artifact.uri);

  return {
    recorded: Boolean(session?.finalResponseRecordedAt || session?.finalResponseText || urls.length > 0),
    sessionId: session?.id ?? null,
    recordedAt: session?.finalResponseRecordedAt ?? null,
    text: session?.finalResponseText ?? null,
    metadata: session?.finalResponseMetadata ?? {},
    urls,
  };
}

function readRawLogEntry(event: PublicEventSummary): RawLogEntry | null {
  const text = readPayloadString(event, "text");
  if (text === null) return null;

  return {
    id: event.id,
    stream: readPayloadString(event, "stream") ?? "combined",
    sequence: readPayloadNumber(event, "sequence"),
    text,
    observedAt: readPayloadString(event, "observedAt"),
    createdAt: event.createdAt,
  };
}

function parseSecurityLog(text: string): JsonRecord | null {
  const firstLine = text.split("\n").find((line) => line.trim().startsWith("{"));
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as JsonRecord;
    return record.type === "security" || record.type === "security.egress" || record.type === "security.package" ? record : null;
  } catch {
    return null;
  }
}

type SecurityTimelineInternalItem = SecurityTimelineItem & {
  readonly order: number;
};

function compareSessions(left: PublicSessionSummary, right: PublicSessionSummary): number {
  return left.attemptNumber - right.attemptNumber || Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function isSessionStarted(session: PublicSessionSummary): boolean {
  return Boolean(session.runtimeSessionId) || ["starting", "running", "succeeded", "failed", "canceled", "lost"].includes(session.status);
}

function compareTimelineItems(left: SecurityTimelineInternalItem, right: SecurityTimelineInternalItem): number {
  const leftTime = left.observedAt ? Date.parse(left.observedAt) : Number.MAX_SAFE_INTEGER;
  const rightTime = right.observedAt ? Date.parse(right.observedAt) : Number.MAX_SAFE_INTEGER;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return left.order - right.order;
}

function labelSecurityTimelineEvent(event: JsonRecord): string {
  const kind = String(event.securityKind ?? "");
  switch (kind) {
    case "dependency-install-started":
      return "Install started";
    case "dependency-install-finished":
      return "Install complete";
    case "dependency-install-failed":
      return "Install blocked";
    case "package-install":
      return "Package install audit";
    case "package-registry":
      return event.allowed === false ? "Package denied" : "Package allowed";
    case "command-policy":
      return event.allowed === false ? "Command denied" : "Command allowed";
    case "egress":
    case "egress-denied":
      return event.allowed === false ? "Egress denied" : "Egress allowed";
    case "credentials-scrub-started":
      return "Credential scrub started";
    case "credentials-scrub-succeeded":
    case "credentials-scrubbed":
      return event.allowed === false ? "Credential scrub failed" : "Credentials scrubbed";
    case "credentials-scrub-failed":
      return "Credential scrub failed";
    case "snapshot-decision":
      return "Snapshot decision";
    case "postflight":
      return "Postflight checks";
    default:
      return kind ? labelFromKebab(kind) : "Security event";
  }
}

function toneSecurityTimelineEvent(event: JsonRecord): SecurityTimelineTone {
  const kind = String(event.securityKind ?? "");
  if (kind === "dependency-install-failed" || kind === "credentials-scrub-failed") return "blocked";
  if (kind === "snapshot-decision") {
    const status = String(event.snapshotEligibilityStatus ?? "");
    if (status === "risk" || status === "ineligible") return "warning";
    if (event.allowed === false) return "warning";
    return "allowed";
  }
  if (event.allowed === false) {
    if (kind === "credentials-scrubbed") return "blocked";
    return "denied";
  }
  if (event.decision === "denied") return "denied";
  if (event.decision === "failed") return "blocked";
  if (event.lockfileChanged === true) return "warning";
  return "allowed";
}

function formatSecurityTimelineDetail(event: JsonRecord): string | null {
  const parts: string[] = [];
  const kind = String(event.securityKind ?? "");

  appendSecurityPart(parts, "policy", event.policy);
  appendSecurityPart(parts, "host", event.host);
  appendSecurityPart(parts, "method", event.method);
  appendSecurityPart(parts, "command", event.command);
  appendSecurityPart(parts, "registry", event.registryHost);
  appendPackagePart(parts, event);
  appendSecurityPart(parts, "reason", event.reason);
  appendSecurityPart(parts, "status", event.snapshotEligibilityStatus);
  appendSecurityPart(parts, "risk", event.snapshotRiskReasons);
  appendSecurityPart(parts, "remaining", event.remainingCount);

  if (event.lockfileChanged === true) parts.push("lockfile changed");
  if (event.lockfileChanged === false && kind.startsWith("dependency-install")) parts.push("lockfile unchanged");

  return parts.length > 0 ? parts.join(" · ") : null;
}

function appendPackagePart(parts: string[], event: JsonRecord): void {
  const packageName = safeSecurityPart("package", event.packageName);
  if (!packageName) return;

  const requested = safeSecurityPart("requested", event.requestedVersion);
  const resolved = safeSecurityPart("resolved", event.resolvedVersion);
  if (requested || resolved) {
    parts.push(`package ${packageName}${requested ? ` requested ${requested}` : ""}${resolved ? ` resolved ${resolved}` : ""}`);
    return;
  }

  parts.push(`package ${packageName}`);
}

function appendSecurityPart(parts: string[], label: string, value: unknown): void {
  const safe = safeSecurityPart(label, value);
  if (!safe) return;
  parts.push(`${label} ${safe}`);
}

function safeSecurityPart(label: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const values = value.map((entry) => sanitizeSecurityValue(entry, label)).filter(Boolean);
    return values.length > 0 ? values.join(", ") : null;
  }
  const safe = sanitizeSecurityValue(value, label);
  return safe || null;
}

function sanitizeSecurityValue(value: unknown, key = ""): string {
  if (/token|secret|password|key|proxy/i.test(key)) return "[redacted]";
  const raw = typeof value === "string" ? value : String(value);
  return raw
    .replace(/\/\/([^:/\s]+):([^@\s]+)@/g, "//$1:[redacted]@")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|e2b_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/\b(?:short-lived-github-token|codex-secret|bridge-token|session-secret)\b/gi, "[redacted]");
}

function formatEventFailureDetail(payload: JsonRecord): string | null {
  return safeSecurityPart("reason", payload.errorMessage ?? payload.reason ?? payload.error) ?? "Provider cleanup did not complete";
}

function labelFromKebab(value: string): string {
  return value
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function hasCodexStartEvent(task: PublicTaskDetail, session: PublicSessionSummary): boolean {
  return task.events.some(
    (event) =>
      event.sessionId === session.id &&
      event.type === "session.output" &&
      typeof event.payload.text === "string" &&
      /codex runner starting|AGENT_POOL_BRIDGE_RUNNER.+codex|command\.started/i.test(event.payload.text),
  ) || readSessionRunner(task, session) === "codex";
}

function readSessionRunner(task: PublicTaskDetail, session: PublicSessionSummary): string | null {
  const metadataRunner = session.finalResponseMetadata.runner;
  if (typeof metadataRunner === "string" && metadataRunner.trim()) return metadataRunner.trim();
  const output = task.events.find(
    (event) =>
      event.sessionId === session.id &&
      event.type === "session.output" &&
      typeof event.payload.text === "string" &&
      event.payload.text.includes("codex runner starting"),
  );
  return output ? "codex" : null;
}

function readPayloadString(event: PublicEventSummary, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" ? value : null;
}

function readPayloadNumber(event: PublicEventSummary, key: string): number | null {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function artifactKindRank(kind: string): number {
  const index = ARTIFACT_KIND_ORDER.findIndex((candidate) => candidate === kind);
  return index === -1 ? ARTIFACT_KIND_ORDER.length : index;
}

function labelArtifactKind(kind: string): string {
  switch (kind) {
    case "final_response_url":
      return "Final Response URLs";
    case "document":
      return "Documents";
    case "file":
      return "Files";
    case "link":
      return "Links";
    case "log":
      return "Logs";
    default:
      return kind.replace(/_/g, " ");
  }
}

function readMetadataString(artifact: PublicArtifactSummary, key: string): string | null {
  const value = artifact.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatAttemptTiming(session: PublicSessionSummary): string {
  if (session.startedAt && session.endedAt) return `${session.startedAt} to ${session.endedAt}`;
  if (session.startedAt) return `started ${session.startedAt}`;
  if (session.endedAt) return `ended ${session.endedAt}`;
  return `created ${session.createdAt}`;
}

function formatAttemptHeartbeat(session: PublicSessionSummary): string {
  if (session.lostAt) return `lost ${session.lostAt}`;
  if (session.staleAt) return `stale ${session.staleAt}`;
  if (session.lastHeartbeatAt) return `${session.heartbeatStatus} ${session.lastHeartbeatAt}`;
  return session.heartbeatStatus;
}
