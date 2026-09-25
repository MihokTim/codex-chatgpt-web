import type { ConnectOverCDPTransport } from "playwright-core";

type CdpCommand = { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown> };

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
  private closed = false;
  private notified = false;

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
      try { this.onmessage?.(JSON.parse(String(event.data))); }
      catch { this.close(); }
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      this.pending = [];
      this.notifyClosed();
    });
    socket.addEventListener("error", () => this.close());
  }

  send(message: object): void {
    if (this.closed) throw new Error("Launcher owned CDP connection is closed");
    // Chromium installs transport callbacks before its first command; unlike WebKit,
    // its public custom-transport implementation does not call the optional open hook.
    if (!this.socket) this.open();
    const command = ownedTargetCommand(message, this.targetId);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
    else this.pending.push(command);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.notifyClosed();
    else {
      // Playwright treats onclose as physical disconnection. Wait for the socket's
      // close event so a replacement cannot race an old transport still closing.
      try { this.socket.close(); } catch { /* A connecting socket reports close/error. */ }
    }
  }

  private notifyClosed(): void {
    if (this.notified || !this.onclose) return;
    this.notified = true;
    this.onclose?.("Launcher owned CDP connection closed");
  }
}
