/**
 * Newline-delimited JSON protocol for daemon communication over Unix socket.
 */

export interface DaemonRequest {
  id: string;
  method: string;
  params?: any;
}

export interface DaemonResponse {
  id: string;
  result?: any;
  error?: string;
}

export type DaemonMessage = DaemonRequest | DaemonResponse;

let nextId = 0;

/**
 * Serialize a message to ndjson (JSON + newline).
 */
export function serializeMessage(msg: DaemonMessage): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Parse a single ndjson line into a message.
 * Returns null on invalid JSON.
 */
export function parseMessage(line: string): DaemonMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("id" in parsed) || typeof parsed.id !== "string") return null;
    return parsed as DaemonMessage;
  } catch {
    return null;
  }
}

/**
 * Create a request message with auto-generated ID.
 */
export function createRequest(method: string, params?: any): DaemonRequest {
  return { id: `req-${++nextId}`, method, params };
}

/**
 * Create a response message for a given request ID.
 */
export function createResponse(
  id: string,
  result?: any,
  error?: string
): DaemonResponse {
  const resp: DaemonResponse = { id };
  if (result !== undefined) resp.result = result;
  if (error !== undefined) resp.error = error;
  return resp;
}

/**
 * Check if a message is a request (has method field).
 */
export function isRequest(msg: DaemonMessage): msg is DaemonRequest {
  return "method" in msg;
}

/**
 * Check if a message is a response (has result or error, no method).
 */
export function isResponse(msg: DaemonMessage): msg is DaemonResponse {
  return !("method" in msg);
}
