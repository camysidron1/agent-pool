import { describe, test, expect } from "bun:test";
import {
  serializeMessage,
  parseMessage,
  createRequest,
  createResponse,
  isRequest,
  isResponse,
  type DaemonRequest,
  type DaemonResponse,
} from "../../../src/daemon/protocol";

describe("Protocol", () => {
  describe("serializeMessage", () => {
    test("serializes request to ndjson", () => {
      const req: DaemonRequest = { id: "1", method: "task.list" };
      const result = serializeMessage(req);
      expect(result).toBe('{"id":"1","method":"task.list"}\n');
    });

    test("serializes response with result", () => {
      const resp: DaemonResponse = { id: "1", result: { ok: true } };
      const result = serializeMessage(resp);
      expect(result).toEndWith("\n");
      expect(JSON.parse(result)).toEqual({ id: "1", result: { ok: true } });
    });

    test("serializes response with error", () => {
      const resp: DaemonResponse = { id: "1", error: "not found" };
      const result = serializeMessage(resp);
      expect(JSON.parse(result)).toEqual({ id: "1", error: "not found" });
    });
  });

  describe("parseMessage", () => {
    test("parses valid request", () => {
      const msg = parseMessage('{"id":"1","method":"task.list"}');
      expect(msg).toEqual({ id: "1", method: "task.list" });
    });

    test("parses valid response", () => {
      const msg = parseMessage('{"id":"1","result":[]}');
      expect(msg).toEqual({ id: "1", result: [] });
    });

    test("trims whitespace and newlines", () => {
      const msg = parseMessage('  {"id":"1","method":"status"}  \n');
      expect(msg).toEqual({ id: "1", method: "status" });
    });

    test("returns null for empty string", () => {
      expect(parseMessage("")).toBeNull();
    });

    test("returns null for whitespace-only", () => {
      expect(parseMessage("   ")).toBeNull();
    });

    test("returns null for invalid JSON", () => {
      expect(parseMessage("{not json}")).toBeNull();
    });

    test("returns null for non-object JSON", () => {
      expect(parseMessage('"hello"')).toBeNull();
    });

    test("returns null for array JSON", () => {
      expect(parseMessage("[1,2,3]")).toBeNull();
    });

    test("returns null for object without id", () => {
      expect(parseMessage('{"method":"test"}')).toBeNull();
    });

    test("returns null for null JSON", () => {
      expect(parseMessage("null")).toBeNull();
    });
  });

  describe("createRequest", () => {
    test("creates request with method", () => {
      const req = createRequest("task.list");
      expect(req.id).toBeString();
      expect(req.method).toBe("task.list");
      expect(req.params).toBeUndefined();
    });

    test("creates request with params", () => {
      const req = createRequest("task.add", { description: "test" });
      expect(req.method).toBe("task.add");
      expect(req.params).toEqual({ description: "test" });
    });

    test("generates unique IDs", () => {
      const r1 = createRequest("a");
      const r2 = createRequest("b");
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe("createResponse", () => {
    test("creates response with result", () => {
      const resp = createResponse("req-1", { tasks: [] });
      expect(resp).toEqual({ id: "req-1", result: { tasks: [] } });
    });

    test("creates response with error", () => {
      const resp = createResponse("req-1", undefined, "bad request");
      expect(resp).toEqual({ id: "req-1", error: "bad request" });
    });

    test("creates minimal response (id only)", () => {
      const resp = createResponse("req-1");
      expect(resp).toEqual({ id: "req-1" });
    });
  });

  describe("isRequest / isResponse", () => {
    test("identifies request", () => {
      const req: DaemonRequest = { id: "1", method: "status" };
      expect(isRequest(req)).toBe(true);
      expect(isResponse(req)).toBe(false);
    });

    test("identifies response", () => {
      const resp: DaemonResponse = { id: "1", result: {} };
      expect(isRequest(resp)).toBe(false);
      expect(isResponse(resp)).toBe(true);
    });
  });

  describe("round-trip", () => {
    test("serialize → parse preserves request", () => {
      const original = createRequest("task.claim", { agentId: "a1" });
      const serialized = serializeMessage(original);
      const parsed = parseMessage(serialized);
      expect(parsed).toEqual(original);
    });

    test("serialize → parse preserves response", () => {
      const original = createResponse("r1", { status: "ok" });
      const serialized = serializeMessage(original);
      const parsed = parseMessage(serialized);
      expect(parsed).toEqual(original);
    });
  });
});
