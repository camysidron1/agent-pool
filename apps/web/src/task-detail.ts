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
  const hasScrub = securityEvents.some((event) => event.securityKind === "credentials-scrubbed");
  const hasPolicy = securityEvents.some((event) => event.securityKind === "postflight" || event.securityKind === "package-install");

  return [
    {
      id: "egress",
      label: hasDenied ? "Egress denied" : hasProxy ? "Proxy egress" : "Egress pending",
      tone: hasDenied ? "danger" : hasProxy ? "good" : "neutral",
    },
    {
      id: "policy",
      label: hasPolicy ? "Policy logged" : "Policy pending",
      tone: hasPolicy ? "good" : "neutral",
    },
    {
      id: "scrub",
      label: hasScrub ? "Credentials scrubbed" : "Scrub pending",
      tone: hasScrub ? "good" : "warning",
    },
  ];
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
    return record.type === "security" || record.type === "security.egress" ? record : null;
  } catch {
    return null;
  }
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
