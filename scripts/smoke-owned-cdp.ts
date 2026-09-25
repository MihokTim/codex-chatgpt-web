import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { defaultChromeExecutable } from "../src/config";
import { connectLauncherBrowserHost, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { LauncherOwnedCdpTransport } from "../src/launcher-owned-cdp";

// A new disposable profile; no authenticated browser, user task, or account is accessed.
const root = mkdtempSync(join(tmpdir(), "cgw-owned-cdp-smoke-"));
const profile = join(root, "isolated-profile");
const output = process.argv[2] ? resolve(process.argv[2]) : undefined;
const report: Record<string, unknown> = { isolatedProfile: true };
const protocol: object[] = [];
const originalSend = LauncherOwnedCdpTransport.prototype.send;
const originalOpen = LauncherOwnedCdpTransport.prototype.open;
LauncherOwnedCdpTransport.prototype.send = function(message) {
  const command = message as { id?: number; method?: string; sessionId?: string };
  protocol.push({ direction: "send", id: command.id, method: command.method, session: command.sessionId?.slice(-6) });
  return originalSend.call(this, message);
};
LauncherOwnedCdpTransport.prototype.open = function() {
  const onmessage = this.onmessage;
  this.onmessage = message => {
    const response = message as { id?: number; method?: string; sessionId?: string; error?: { message: string } };
    protocol.push({ direction: "receive", id: response.id, method: response.method, session: response.sessionId?.slice(-6), error: response.error?.message });
    onmessage?.(message);
  };
  return originalOpen.call(this);
};
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
let fixtureServer: ReturnType<typeof Bun.serve> | undefined;
let silentServer: ReturnType<typeof Bun.serve> | undefined;
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
const phase = (name: string) => { report.phase = name; console.log(`owned-cdp-smoke ${name}`); };
async function bounded<T>(operation: Promise<T>, label: string, timeout = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Smoke phase timed out: ${label}`)), timeout);
  })]); } finally { if (timer) clearTimeout(timer); }
}
try {
  phase("launch");
  context = await chromium.launchPersistentContext(profile, {
    executablePath: defaultChromeExecutable(), headless: true,
    args: ["--remote-debugging-port=0", "--site-per-process"],
  });
  const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
  const endpoint = `http://127.0.0.1:${port}`;
  phase("fixtures");
  const owned = await context.newPage();
  await owned.goto('data:text/html,<input id="text"><input id="file" type="file"><button id="button" onclick="this.textContent=\'clicked\'">click</button>');
  const targetSession = await context.newCDPSession(owned);
  const { targetInfo } = await targetSession.send("Target.getTargetInfo");
  await targetSession.detach();
  fixtureServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Unrelated test tab", { headers: { "content-type": "text/html" } }) });
  const unrelated = await context.newPage();
  await unrelated.goto(`http://127.0.0.1:${fixtureServer.port}`);
  const debuggerSession = await context.newCDPSession(unrelated);
  phase("busy-unrelated");
  const busyStart = performance.now();
  let busyFinished = false;
  const busy = debuggerSession.send("Runtime.evaluate", { expression: "const until = Date.now() + 5000; while (Date.now() < until) {}" })
    .finally(() => { busyFinished = true; });
  void busy.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 50));
  phase("broad-connection-baseline");
  const baselineStart = performance.now();
  try {
    const broad = await chromium.connectOverCDP(endpoint, { timeout: 1_500, noDefaults: true });
    report.broadConnection = "completed";
    await broad.close();
  } catch { report.broadConnection = "timed-out"; }
  report.broadConnectionMs = Math.round(performance.now() - baselineStart);
  const descriptor = join(root, "launcher-browser.json");
  const surfaceId = "o".repeat(32);
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "development", pid: process.pid, endpoint,
    control: { endpoint, token: "isolated-fixture-token-" + "x".repeat(40) },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId, surfaceTargets: { [surfaceId]: targetInfo.targetId }, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const start = performance.now();
  phase("connect-owned");
  const connection = await bounded(connectLauncherBrowserHost(descriptor, 5_000, surfaceId), "connect-owned");
  report.acquisitionMs = Math.round(performance.now() - start);
  try {
    phase("owned-input");
    const observed = connection.browser.contexts().flatMap(value => value.pages());
    check(observed.length === 1 && observed[0] === connection.page, "Connection acquired unrelated tabs");
    await connection.page.locator("#text").fill("対象タブだけを操作");
    check(await connection.page.locator("#text").inputValue() === "対象タブだけを操作", "Owned input failed");
    await connection.page.locator("#button").click();
    check(await connection.page.locator("#button").textContent() === "clicked", "Owned click failed");
    const attachment = join(root, "日本語 空白 attachment.txt");
    writeFileSync(attachment, "Windows native path fixture");
    await connection.page.locator("#file").setInputFiles(attachment);
    check(await connection.page.locator("#file").evaluate((input: HTMLInputElement) => input.files?.[0]?.name) === basename(attachment), "Native Windows attachment path failed");
    check(!busyFinished, "The busy fixture finished before owned-page work was verified");
    report.ownedPages = observed.length;
    report.busyUnrelatedRendererPreserved = true;
    report.ownedWorkFinishedWhileUnrelatedBusyMs = Math.round(performance.now() - busyStart);
    report.inputClickAndWindowsAttachment = "PASS";
  } finally { phase("disconnect-owned"); await bounded(connection.browser.close(), "disconnect-owned"); }
  check(!owned.isClosed() && !unrelated.isClosed(), "Disconnect closed browser-owned pages");
  await bounded(busy, "busy-fixture-completion");
  await debuggerSession.detach();
  check(await owned.locator("#button").textContent() === "clicked", "Owned page did not survive disconnect");
  report.disconnectPreservedPages = true;

  // A disposable loopback CDP peer accepts the WebSocket but deliberately withholds
  // Browser.getVersion. Cancellation must close this initial handshake promptly.
  phase("cancel-initial-handshake");
  let handshakeMessages = 0;
  silentServer = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/silent` });
      if (server.upgrade(request, { data: undefined })) return;
      return new Response("not found", { status: 404 });
    }, websocket: { message() { handshakeMessages++; } },
  });
  const silentDescriptor = join(root, "silent-browser.json");
  const silentEndpoint = `http://127.0.0.1:${silentServer.port}`;
  const silentMetadata = JSON.parse(readFileSync(descriptor, "utf8"));
  silentMetadata.endpoint = silentEndpoint;
  writeFileSync(silentDescriptor, JSON.stringify(silentMetadata), { mode: 0o600 });
  const inFlightAbort = new AbortController();
  const abortStart = performance.now();
  const connecting = connectLauncherBrowserHost(silentDescriptor, 5_000, surfaceId, inFlightAbort.signal);
  setTimeout(() => inFlightAbort.abort(), 100);
  let handshakeAborted = false;
  try { await bounded(connecting, "cancel-handshake", 2_000); }
  catch (error) { handshakeAborted = error instanceof DOMException && error.name === "AbortError"; }
  check(handshakeAborted, "Initial handshake did not honour cancellation");
  check(handshakeMessages > 0, "Cancellation fixture did not reach the CDP handshake");
  report.cancelledHandshakeMs = Math.round(performance.now() - abortStart);
  const afterAbort = await bounded(connectLauncherBrowserHost(descriptor, 5_000, surfaceId), "after-cancel");
  await afterAbort.browser.close();
  report.reconnectAfterCancellation = "PASS";

  // A disappeared native target is a preparation failure; preserve its classified
  // error and release the failed connection before another acquisition starts.
  const missingDescriptor = join(root, "missing-target.json");
  const missingMetadata = JSON.parse(readFileSync(descriptor, "utf8"));
  missingMetadata.surfaceTargets[surfaceId] = "missing-isolated-target";
  writeFileSync(missingDescriptor, JSON.stringify(missingMetadata), { mode: 0o600 });
  let missingRejected = false;
  try { await bounded(connectLauncherBrowserHost(missingDescriptor, 2_000, surfaceId), "missing-target"); }
  catch (error) { missingRejected = error instanceof Error && error.message.startsWith("Could not connect Playwright to the launcher browser:"); }
  check(missingRejected, "Missing target did not preserve its preparation failure classification");
  report.missingTargetCleanup = "PASS";

  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  try { await connectLauncherBrowserHost(descriptor, 5_000, surfaceId, controller.signal); }
  catch (error) { cancelled = error instanceof DOMException && error.name === "AbortError"; }
  check(cancelled, "Cancelled acquisition was not cancelled");
  report.cancellation = "PASS";
  report.status = "ISOLATED_OWNED_CDP_SMOKE_OK";
} catch (error) {
  report.status = "FAILED";
  report.error = error instanceof Error ? error.message : String(error);
  report.protocol = protocol.slice(-30);
  process.exitCode = 1;
} finally {
  silentServer?.stop(true);
  fixtureServer?.stop(true);
  await bounded(Promise.resolve(context?.close()), "context-cleanup", 5_000).catch(() => {});
  rmSync(root, { recursive: true, force: true });
  LauncherOwnedCdpTransport.prototype.send = originalSend;
  LauncherOwnedCdpTransport.prototype.open = originalOpen;
}
if (output) writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
