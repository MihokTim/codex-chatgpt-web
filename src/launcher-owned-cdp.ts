import type { ConnectOverCDPTransport } from "playwright-core";

type CdpCommand = { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown> };

export interface LauncherOwnedCdpDiagnostics {
  state: "unopened" | "connecting" | "open" | "closing" | "closed";
  receivedMessages: number;
  queuedMessages: number;
  lastReceivedAgoMs: number | null;
  pendingCommands: number;
  oldestPending: Array<{ method: string; ageMs: number }>;
  failure?: "socket-error" | "invalid-json" | "dispatch-error";
}

/** Attach only the descriptor-owned page, never initialize every tab in the shared browser. */
export function ownedTargetCommand(message: object, targetId: string): object {
  const command = message as CdpCommand;
  if (command.sessionId === undefined && command.method === "Target.setAutoAttach"
    && command.params?.autoAttach === true) {
    // attachToTarget emits the real attachedToTarget event and acknowledges the original
    // command id. Child-frame auto-attach commands retain their session and pass unchanged.
    return { id: command.id, method: "Target.attachToTarget", params: { targetId, flatten: true } };
  }
  return message;
}

/** Public Playwright transport API; closing it disconnects only this client's CDP socket. */
export class LauncherOwnedCdpTransport implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private socket?: WebSocket;
  private pending: object[] = [];
  private incoming: string[] = [];
  private dispatchScheduled = false;
  private commands = new Map<number, { method: string; sentAt: number }>();
  private receivedMessages = 0;
  private lastReceivedAt?: number;
  private failure?: LauncherOwnedCdpDiagnostics["failure"];
  private closed = false;
  private notified = false;
  private resolveDisconnection!: () => void;
  readonly disconnected = new Promise<void>(resolve => { this.resolveDisconnection = resolve; });

  constructor(private readonly endpoint: string, private readonly targetId: string) {
    const url = new URL(endpoint);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || !url.pathname.startsWith("/devtools/browser/")) {
      throw new Error("Launcher owned CDP transport requires a loopback browser WebSocket");
    }
    if (!targetId.trim()) throw new Error("Launcher owned CDP transport requires a native target id");
  }

  open(): void {
    if (this.closed) { queueMicrotask(() => this.notifyClosed()); return; }
    if (this.socket) return;
    const socket = this.socket = new WebSocket(this.endpoint);
    socket.addEventListener("open", () => {
      if (this.closed) { socket.close(); return; }
      for (const message of this.pending.splice(0)) socket.send(JSON.stringify(message));
    });
    socket.addEventListener("message", event => {
      if (this.closed) return;
      this.receivedMessages++;
      this.lastReceivedAt = Date.now();
      this.incoming.push(String(event.data));
      this.scheduleDispatch();
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      this.pending = [];
      this.incoming = [];
      this.notifyClosed();
    });
    socket.addEventListener("error", () => { this.failure = "socket-error"; this.close(); });
  }

  send(message: object): void {
    if (this.closed) throw new Error("Launcher owned CDP connection is closed");
    // Chromium installs transport callbacks before its first command; unlike WebKit,
    // its public custom-transport implementation does not call the optional open hook.
    if (!this.socket) this.open();
    const command = ownedTargetCommand(message, this.targetId);
    const { id, method } = command as CdpCommand;
    if (typeof id === "number" && typeof method === "string") {
      this.commands.set(id, {
        // Only protocol method names enter diagnostics, never arguments, target/session ids,
        // URLs, errors from Chromium, or returned page content.
        method: /^[A-Za-z]{1,40}\.[A-Za-z]{1,60}$/.test(method) ? method : "unknown",
        sentAt: Date.now(),
      });
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
    else this.pending.push(command);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.incoming = [];
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.notifyClosed();
    else {
      // Playwright treats onclose as physical disconnection. Wait for the socket's
      // close event so a replacement cannot race an old transport still closing.
      try { this.socket.close(); } catch { /* A connecting socket reports close/error. */ }
    }
  }

  diagnostics(): LauncherOwnedCdpDiagnostics {
    const now = Date.now();
    return {
      state: !this.socket ? (this.closed ? "closed" : "unopened")
        : this.socket.readyState === WebSocket.CLOSED ? "closed"
          : this.closed ? "closing" : this.socket.readyState === WebSocket.OPEN ? "open" : "connecting",
      receivedMessages: this.receivedMessages,
      queuedMessages: this.incoming.length,
      lastReceivedAgoMs: this.lastReceivedAt === undefined ? null : Math.max(0, now - this.lastReceivedAt),
      pendingCommands: this.commands.size,
      oldestPending: [...this.commands.values()].slice(0, 8)
        .map(command => ({ method: command.method, ageMs: Math.max(0, now - command.sentAt) })),
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  private scheduleDispatch(): void {
    if (this.dispatchScheduled || this.closed || !this.incoming.length) return;
    this.dispatchScheduled = true;
    // Like Playwright's WebSocketTransport, give each protocol message its own task.
    // A native WebSocket can deliver several messages in one callback; dispatching them
    // synchronously lets later context/target events overtake command promise continuations.
    // Schedule one at a time so this guarantee also holds in Bun's immediate queue.
    setImmediate(() => {
      this.dispatchScheduled = false;
      if (this.closed) return;
      const data = this.incoming.shift();
      if (data === undefined) return;
      let message: { id?: number };
      try { message = JSON.parse(data); }
      catch { this.failure = "invalid-json"; this.close(); return; }
      if (typeof message?.id === "number") this.commands.delete(message.id);
      try { this.onmessage?.(message); }
      catch { this.failure = "dispatch-error"; this.close(); }
      this.scheduleDispatch();
    });
  }

  private notifyClosed(): void {
    this.resolveDisconnection();
    if (this.notified || !this.onclose) return;
    this.notified = true;
    this.onclose?.("Launcher owned CDP connection closed");
  }
}
