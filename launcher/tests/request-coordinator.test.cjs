const test = require("node:test");
const assert = require("node:assert/strict");
const { RequestCoordinator } = require("../electron/request-coordinator.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { backendRequestLimitEvidence } = require("../electron/backend-request-evidence.cjs");

test("passive maintenance HTTP evidence is sanitized and cannot be confused with a task Send", () => {
  const tabs = new Map([["task", { traceId: "task-owner", workStage: "compacting", view: { webContents: { id: 12 } } }]]);
  const details = { url: "https://chatgpt.com/backend-api/conversation/private-id?token=secret", method: "GET",
    statusCode: 429, webContentsId: 11, responseHeaders: { "Retry-After": ["60"], "Set-Cookie": ["private"] } };
  assert.deepEqual(backendRequestLimitEvidence(details, 11, tabs), {
    source: "http", surface: "maintenance", category: "conversation", method: "GET", status: 429, retryAfterMs: 60_000,
  });
  assert.equal(backendRequestLimitEvidence({ ...details, statusCode: 403 }, 11, tabs), undefined);
  assert.equal(backendRequestLimitEvidence({ ...details, webContentsId: 99 }, 11, tabs), undefined);
  assert.equal(backendRequestLimitEvidence({ ...details, webContentsId: 12 }, 11, tabs).traceId, "task-owner");
  assert.doesNotMatch(JSON.stringify(backendRequestLimitEvidence(details, 11, tabs)), /private|secret|cookie/i);
});

test("all helpers and compaction share pacing, category cooldowns and deduplicated evidence", () => {
  let now = 1_000;
  const coordinator = new RequestCoordinator({ now: () => now, spacingMs: 1_500 });
  assert.deepEqual(coordinator.acquire("helper-A", "send"), { granted: true });
  assert.deepEqual(coordinator.acquire("compact-B", "send"), { granted: false, retryAt: 2_500, reason: "send-spacing" });
  const evidence = { id: "http-limit-1", source: "http", category: "generation", status: 429, retryAfterMs: 90_000 };
  coordinator.report("helper-A", evidence);
  now += 1_000;
  assert.equal(coordinator.report("helper-A", evidence), 91_000);
  assert.equal(coordinator.acquire("compact-B", "send").retryAt, 91_000);
  assert.equal(coordinator.acquire("new-C", "open").granted, false);
  assert.equal(coordinator.acquire("helper-A", "authentication").granted, true);
  now = 91_000;
  assert.equal(coordinator.acquire("compact-B", "send").granted, true);
  assert.equal(coordinator.acquire("helper-A", "send").retryAt, 92_500);
});

test("an unattributed dialog on a maintenance or other page does not globally throttle healthy work", () => {
  const coordinator = new RequestCoordinator({ now: () => 100, spacingMs: 0 });
  coordinator.report("maintenance", { id: "dialog-limit", source: "dialog", category: "unknown" });
  assert.equal(coordinator.acquire("maintenance", "open").granted, false);
  assert.equal(coordinator.acquire("healthy-task", "send").granted, true);
  assert.equal(coordinator.acquire("healthy-task", "open").granted, true);
  coordinator.report("helper-A", { id: "auth-limit", source: "http", category: "authentication", status: 429 });
  assert.equal(coordinator.acquire("healthy-task", "authentication").granted, false);
  assert.equal(coordinator.acquire("healthy-task", "send").granted, true);
});

test("control traffic and tab metadata require the exact owned tab and valid fields", async () => {
  const tab = { id: "tab", traceId: "owner-trace", helperPid: process.pid, status: "running" };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]), getBrowserInteractionMode: () => "automatic", snapshot: () => ({}),
  });
  const server = await new BrowserControlServer({ logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host, getPreferences: () => ({}) }).start();
  const { endpoint, token } = server.descriptor();
  const request = (route, body, auth = token) => fetch(`${endpoint}/v1/${route}`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const owner = { traceId: tab.traceId, helperPid: process.pid };
  try {
    assert.equal((await request("traffic/acquire", { ...owner, intent: "send" }, "invalid")).status, 401);
    assert.equal((await request("traffic/acquire", { ...owner, helperPid: process.pid + 1, intent: "send" })).status, 400);
    assert.equal((await request("traffic/acquire", { ...owner, intent: "send" })).status, 200);
    assert.equal((await request("turn/heartbeat", { ...owner, taskIdentity: { threadId: "task-id", agentName: "Worker" }, workStage: "compacting" })).status, 200);
    assert.deepEqual(tab.taskIdentity, { threadId: "task-id", agentName: "Worker" });
    assert.equal(tab.workStage, "compacting");
    assert.equal((await request("turn/heartbeat", { ...owner, taskIdentity: { prompt: "not metadata" } })).status, 400);
    assert.equal((await request("traffic/report", { ...owner, evidence: {
      id: "invalid-evidence", source: "http", category: "generation", status: 429, url: "private-url",
    } })).status, 400);
  } finally { await server.close(); }
});
