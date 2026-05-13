import { normalizeBaseUrl, PUBLIC_OPERATOR_ID_HEADER, type PublicEventSummary } from "./api";

export type ProjectEventSubscriptionOptions = {
  readonly baseUrl?: string;
  readonly operatorId: string;
  readonly projectId: string;
  readonly fetchImpl?: typeof fetch;
  readonly fallbackIntervalMs?: number;
  readonly onEvent: (event: PublicEventSummary) => void;
  readonly onFallbackRefresh: () => void;
  readonly onError?: (error: unknown) => void;
};

export type ParsedSseEvents = {
  readonly events: readonly PublicEventSummary[];
  readonly remainder: string;
};

export function projectEventsUrl(baseUrl: string | undefined, projectId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/public/projects/${encodeURIComponent(projectId)}/events`;
}

export function shouldRefreshBoardForEvent(event: PublicEventSummary, projectId: string): boolean {
  if (event.projectId !== projectId) return false;
  if (event.type.startsWith("task.")) return true;
  if (event.type.startsWith("session.")) return true;
  if (event.type.startsWith("command.")) return true;
  if (event.type.startsWith("steering.")) return true;
  if (event.type.startsWith("artifact.")) return true;
  if (event.type.startsWith("note.")) return true;

  return false;
}

export function subscribeProjectEvents(options: ProjectEventSubscriptionOptions): () => void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  function startFallback(error: unknown): void {
    options.onError?.(error);
    if (closed || fallbackTimer || (options.fallbackIntervalMs ?? 5000) <= 0) return;

    fallbackTimer = setInterval(options.onFallbackRefresh, options.fallbackIntervalMs ?? 5000);
  }

  void (async () => {
    try {
      const response = await fetchImpl(projectEventsUrl(options.baseUrl, options.projectId), {
        credentials: "include",
        headers: {
          accept: "text/event-stream",
          [PUBLIC_OPERATOR_ID_HEADER]: options.operatorId,
        },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        startFallback(new Error(`project event stream failed with status ${response.status}`));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!closed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.remainder;

        for (const event of parsed.events) {
          options.onEvent(event);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) startFallback(error);
    }
  })();

  return () => {
    closed = true;
    controller.abort();
    if (fallbackTimer) clearInterval(fallbackTimer);
  };
}

export function parseSseEvents(buffer: string): ParsedSseEvents {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const chunks = normalized.split("\n\n");
  const remainder = chunks.pop() ?? "";
  const events: PublicEventSummary[] = [];

  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");

    if (!data) continue;

    try {
      events.push(JSON.parse(data) as PublicEventSummary);
    } catch {
      // Ignore malformed SSE payloads and continue parsing later events.
    }
  }

  return { events, remainder };
}
