import { connect, type Socket } from "net";
import {
  serializeMessage,
  parseMessage,
  createRequest,
  type DaemonResponse,
} from "./protocol";

export interface DaemonClientOptions {
  socketPath: string;
  timeoutMs?: number;
  onPush?: (msg: DaemonResponse) => void;
  onDisconnect?: () => void;
}

/**
 * Client for communicating with the daemon over Unix socket.
 * Returns null from connect() on failure so callers can fall back to direct store access.
 */
export class DaemonClient {
  private socketPath: string;
  private timeoutMs: number;
  private socket: Socket | null = null;
  private buffer = "";
  private pendingRequests = new Map<
    string,
    { resolve: (r: DaemonResponse) => void; reject: (e: Error) => void }
  >();
  private pushHandler: ((msg: DaemonResponse) => void) | null;
  private disconnectHandler: (() => void) | null;

  constructor(options: DaemonClientOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.pushHandler = options.onPush ?? null;
    this.disconnectHandler = options.onDisconnect ?? null;
  }

  /** Register a handler for unsolicited push messages from the daemon. */
  onPush(handler: (msg: DaemonResponse) => void): void {
    this.pushHandler = handler;
  }

  /** Register a handler that fires when the socket closes. */
  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  /**
   * Try to connect to the daemon socket.
   * Returns true on success, false if daemon is not available.
   */
  async connect(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const sock = connect(this.socketPath);
      const timeout = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, this.timeoutMs);

      sock.on("connect", () => {
        clearTimeout(timeout);
        this.socket = sock;
        this.setupListeners();
        resolve(true);
      });

      sock.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  private setupListeners(): void {
    if (!this.socket) return;

    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(newlineIdx + 1);
        const msg = parseMessage(line);
        if (msg && "id" in msg) {
          const resp = msg as DaemonResponse;
          const pending = this.pendingRequests.get(resp.id);
          if (pending) {
            this.pendingRequests.delete(resp.id);
            pending.resolve(resp);
          } else if (this.pushHandler) {
            this.pushHandler(resp);
          }
        }
      }
    });

    this.socket.on("error", () => {
      this.rejectAll("Socket error");
    });

    this.socket.on("close", () => {
      this.rejectAll("Socket closed");
      this.socket = null;
      if (this.disconnectHandler) this.disconnectHandler();
    });
  }

  private rejectAll(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  /**
   * Send a request and wait for a response.
   * Throws if not connected or on timeout.
   */
  async request(method: string, params?: any): Promise<DaemonResponse> {
    if (!this.socket) {
      throw new Error("Not connected to daemon");
    }

    const req = createRequest(method, params);

    return new Promise<DaemonResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(req.id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.timeoutMs);

      this.pendingRequests.set(req.id, {
        resolve: (resp) => {
          clearTimeout(timeout);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.socket!.write(serializeMessage(req));
    });
  }

  /**
   * Close the connection.
   */
  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.rejectAll("Client closed");
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}
