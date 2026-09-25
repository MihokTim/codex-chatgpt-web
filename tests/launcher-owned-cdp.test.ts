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
