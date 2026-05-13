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

export type FinalResultDetail = {
  readonly recorded: boolean;
  readonly sessionId: string | null;
  readonly recordedAt: string | null;
  readonly text: string | null;
  readonly metadata: JsonRecord;
  readonly urls: readonly string[];
};

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
