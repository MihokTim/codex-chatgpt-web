import { expect, test } from "bun:test";
import { LauncherOwnedCdpTransport, ownedTargetCommand } from "../src/launcher-owned-cdp";

test("owned CDP attaches only the bound root target and preserves child-frame auto-attach", () => {
  const root = { id: 7, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } };
  expect(ownedTargetCommand(root, "owned-native-target")).toEqual({
    id: 7, method: "Target.attachToTarget", params: { targetId: "owned-native-target", flatten: true },
  });
  const child = { ...root, sessionId: "owned-frame-session" };
  expect(ownedTargetCommand(child, "owned-native-target")).toBe(child);
  const detach = { ...root, params: { autoAttach: false } };
  expect(ownedTargetCommand(detach, "owned-native-target")).toBe(detach);
  const command = { id: 8, method: "Page.getFrameTree", sessionId: "owned-frame-session" };
  expect(ownedTargetCommand(command, "owned-native-target")).toBe(command);
});

test("owned CDP validates endpoint authority and disconnects exactly once before opening", async () => {
  for (const endpoint of ["ws://example.com:9222/devtools/browser/x", "ws://127.0.0.1:9222/devtools/page/x", "ws://user:password@127.0.0.1:9222/devtools/browser/x"]) {
    expect(() => new LauncherOwnedCdpTransport(endpoint, "target")).toThrow("loopback browser WebSocket");
  }
  const transport = new LauncherOwnedCdpTransport("ws://127.0.0.1:9222/devtools/browser/fixture", "target");
  transport.close();
  await transport.disconnected;
  let closes = 0;
  transport.onclose = () => { closes++; };
  transport.open();
  await Promise.resolve();
  transport.close();
  expect(closes).toBe(1);
  expect(() => transport.send({ id: 1, method: "Browser.getVersion" })).toThrow("closed");
});

test("owned CDP drains promise continuations between batched protocol messages", async () => {
  const OriginalWebSocket = globalThis.WebSocket;
  let socket: EventTarget;
  class BatchedWebSocket extends EventTarget {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    constructor() { super(); socket = this; }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  globalThis.WebSocket = BatchedWebSocket as unknown as typeof WebSocket;
  const transport = new LauncherOwnedCdpTransport("ws://127.0.0.1:9222/devtools/browser/fixture", "target");
  try {
    const order: string[] = [];
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    transport.onmessage = message => {
      const id = (message as { id: number }).id;
      expect(transport.diagnostics().pendingCommands).toBe(2 - id);
      order.push(`message:${id}`);
      void Promise.resolve().then(() => { order.push(`continuation:${id}`); if (id === 2) complete(); });
    };
    transport.send({ id: 1, method: "Runtime.evaluate", sessionId: "private-session", params: { expression: "private-page-data" } });
    transport.send({ id: 2, method: "Page.getFrameTree", params: { privateToken: "private-token" } });
    const before = transport.diagnostics();
    expect(before.oldestPending.map(command => command.method)).toEqual(["Runtime.evaluate", "Page.getFrameTree"]);
    expect(JSON.stringify(before)).not.toContain("private");
    // A WebSocket implementation may dispatch multiple CDP frames from one network callback.
    socket!.dispatchEvent(new MessageEvent("message", { data: '{"id":1,"result":{}}' }));
    socket!.dispatchEvent(new MessageEvent("message", { data: '{"id":2,"result":{}}' }));
    await completed;
    expect(order).toEqual(["message:1", "continuation:1", "message:2", "continuation:2"]);
    expect(transport.diagnostics()).toMatchObject({ receivedMessages: 2, pendingCommands: 0, queuedMessages: 0 });
    socket!.dispatchEvent(new MessageEvent("message", { data: '{"id":3}' }));
    transport.close();
    await new Promise(resolve => setImmediate(resolve));
    expect(order).toHaveLength(4);
    expect(transport.diagnostics().state).toBe("closed");
  } finally {
    transport.close();
    await transport.disconnected;
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test("owned CDP exposes only a fixed failure code for malformed peer data", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request, { data: undefined })) return; return new Response(null, { status: 404 }); },
    websocket: { message(socket) { socket.send("private-invalid-json"); } },
  });
  const transport = new LauncherOwnedCdpTransport(`ws://127.0.0.1:${server.port}/devtools/browser/fixture`, "target");
  try {
    transport.send({ id: 1, method: "Runtime.evaluate", params: { expression: "private-expression" } });
    await transport.disconnected;
    const diagnostic = transport.diagnostics();
    expect(diagnostic).toMatchObject({ state: "closed", failure: "invalid-json", pendingCommands: 1 });
    expect(diagnostic.oldestPending.map(command => command.method)).toEqual(["Runtime.evaluate"]);
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  } finally { transport.close(); server.stop(true); }
});
