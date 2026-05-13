import type { PublicEventSummary, PublicLogStreamSummary, PublicTaskDetail } from "./api";
import { summarizeLogStream } from "./board";

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
