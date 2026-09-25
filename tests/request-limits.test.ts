import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Page, Request, Response } from "playwright-core";
import { ChatGptRequestMonitor, parseRequestLimitEvidence, requestCategory, retryAfterMilliseconds } from "../src/adapters/chatgpt-web/request-limits";
import { ChatGptUsageAccountCache } from "../src/adapters/chatgpt-web/limits";
import { cancellableDelay } from "../src/adapters/chatgpt-web/request-scheduling";
import { browserTaskLabel, browserTaskTooltip, browserTabsOverview } from "../launcher/src/browser-tab-label";
import { copyFor } from "../launcher/src/i18n";
import type { BrowserTabState } from "../launcher/src/types";

test("Retry-After respects seconds and HTTP dates, rejecting malformed or unbounded values", () => {
  const now = Date.parse("2026-09-25T00:00:00Z");
  expect(retryAfterMilliseconds("120", now)).toBe(120_000);
  expect(retryAfterMilliseconds("Fri, 25 Sep 2026 00:02:00 GMT", now)).toBe(120_000);
  expect(retryAfterMilliseconds("Thu, 24 Sep 2026 23:59:00 GMT", now)).toBe(0);
  for (const value of [undefined, "", "-1", "1.5", "NaN", "1000000000000", "tomorrow"]) {
    expect(retryAfterMilliseconds(value, now)).toBeUndefined();
  }
});

test("request categories and wire evidence never export arbitrary URLs or payload fields", () => {
  expect(requestCategory("https://chatgpt.com/backend-api/f/conversation?secret=private", "POST")).toBe("generation");
  expect(requestCategory("https://chatgpt.com/backend-api/conversation/private-id", "GET")).toBe("conversation");
  expect(requestCategory("https://chatgpt.com/api/auth/session", "GET")).toBe("authentication");
  expect(requestCategory("https://chatgpt.com.example/api/auth/session", "GET")).toBeUndefined();
  expect(requestCategory("data:secret", "GET")).toBeUndefined();
  const evidence = { id: "evidence-1", source: "http", category: "generation", status: 429, retryAfterMs: 20_000 } as const;
  expect(parseRequestLimitEvidence(evidence)).toEqual(evidence);
  for (const invalid of [{ ...evidence, url: "https://example.com/private" }, { ...evidence, status: 200 },
    { ...evidence, source: "dialog" }, { ...evidence, retryAfterMs: -1 }, { ...evidence, id: "bad\nvalue" }]) {
    expect(() => parseRequestLimitEvidence(invalid)).toThrow("Invalid request-limit evidence");
  }
});

test("HTTP rejection belongs to its page and current Send, while auxiliary limits stay separate", async () => {
  const frame = {};
  const context = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame, context: () => context }) as unknown as Page;
  const reports: unknown[] = [];
  const monitor = new ChatGptRequestMonitor("test-request-owner", async evidence => { reports.push(evidence); });
  const request = (url: string, ownFrame = frame): Request => ({
    frame: () => ownFrame, method: () => "POST", url: () => url,
  }) as Request;
  const respond = (req: Request, status: number): void => {
    (page as unknown as EventEmitter).emit("response", {
      request: () => req, status: () => status, headers: () => ({ "retry-after": "45" }),
    } as unknown as Response);
  };
  monitor.bind(page);
  monitor.beginSend();
  const previous = request("https://chatgpt.com/backend-api/f/conversation");
  (page as unknown as EventEmitter).emit("request", previous);
  monitor.beginSend();
  respond(previous, 429);
  expect(monitor.failure()).toBeUndefined();
  const otherFrame = request("https://chatgpt.com/backend-api/f/conversation", {});
  (page as unknown as EventEmitter).emit("request", otherFrame);
  respond(otherFrame, 429);
  const auth = request("https://chatgpt.com/api/auth/session");
  (page as unknown as EventEmitter).emit("request", auth);
  respond(auth, 429);
  expect(monitor.failure()).toBeUndefined();
  const owned = request("https://chatgpt.com/backend-api/f/conversation");
  (page as unknown as EventEmitter).emit("request", owned);
  respond(owned, 429);
  expect(monitor.failure()?.requestLimit).toMatchObject({ source: "http", category: "generation", status: 429, retryAfterMs: 45_000 });
  expect(monitor.failure()?.retryable).toBe(false);
  await monitor.close();
  expect(reports).toHaveLength(3);
  expect((page as unknown as EventEmitter).listenerCount("request")).toBe(0);
  expect((page as unknown as EventEmitter).listenerCount("response")).toBe(0);
});

test("six sequential usage receipts share identity verification without surviving cookie changes or expiry", async () => {
  let now = 0;
  let identity = "session-A";
  let calls = 0;
  const cache = new ChatGptUsageAccountCache(() => now, 100);
  const fingerprint = async () => identity;
  const load = async () => { calls++; return { accountKey: identity, planType: "pro", personal: true, needsAttention: false }; };
  for (let part = 0; part < 6; part++) expect((await cache.read(fingerprint, load)).accountKey).toBe("session-A");
  expect(calls).toBe(1);
  identity = "session-B";
  expect((await cache.read(fingerprint, load)).accountKey).toBe("session-B");
  expect(calls).toBe(2);
  now = 101;
  await Promise.all([cache.read(fingerprint, load), cache.read(fingerprint, load)]);
  expect(calls).toBe(3);
});

test.each(["accepted", "no-semantic-acceptance", "no-http-acceptance", "stale", "unknown", "wrong-frame",
  "generation-rejected", "auth-rejected", "ambiguous", "no-progress", "next-send", "rebind", "report-failed"])(
  "a dialog can preserve only its proven accepted response after an auxiliary GET limit: %s", async scenario => {
    const frame = {};
    const page = Object.assign(new EventEmitter(), { mainFrame: () => frame, context: () => ({}) }) as unknown as Page;
    let now = 1_000;
    const reports: unknown[] = [];
    const monitor = new ChatGptRequestMonitor("dialog-correlation-fixture", async evidence => {
      if (evidence.source === "dialog" && scenario === "report-failed") throw new Error("fixture coordinator offline");
      reports.push(evidence);
    }, () => now);
    const emit = (pathname: string, method: string, status: number, ownFrame = frame) => {
      const req = { frame: () => ownFrame, method: () => method, url: () => `https://chatgpt.com${pathname}` } as Request;
      (page as unknown as EventEmitter).emit("request", req);
      (page as unknown as EventEmitter).emit("response", {
        request: () => req, status: () => status, headers: () => ({}),
      } as unknown as Response);
    };
    try {
      monitor.bind(page);
      monitor.beginSend();
      if (scenario !== "no-http-acceptance") emit("/backend-api/f/conversation", "POST", 200);
      if (scenario !== "no-semantic-acceptance") monitor.markSubmitted();
      if (scenario !== "unknown") emit("/backend-api/conversation/fixture", "GET", 429, scenario === "wrong-frame" ? {} : frame);
      if (scenario === "stale") now += 5_001;
      if (scenario === "generation-rejected") emit("/backend-api/f/conversation", "POST", 429);
      if (scenario === "auth-rejected") emit("/api/auth/session", "GET", 401);
      if (scenario === "ambiguous") emit("/backend-api/something-else", "POST", 429);
      const dialog = { id: "fixture-dialog-limit", source: "dialog", category: "unknown" } as const;
      const observed = await monitor.observeAcceptedResponseAfterDialog(dialog, async () => {
        if (scenario === "next-send") monitor.beginSend();
        if (scenario === "rebind") monitor.bind(Object.assign(new EventEmitter(), { mainFrame: () => frame }) as unknown as Page);
        return scenario !== "no-progress";
      });
      expect(observed).toBe(scenario === "accepted");
      if (scenario === "accepted") {
        expect(reports).toContainEqual(dialog);
        expect(monitor.failure()).toBeUndefined();
        expect(await monitor.observeAcceptedResponseAfterDialog({ ...dialog, id: "second-dialog-limit" }, async () => true)).toBe(false);
        monitor.endSend();
        expect(await monitor.observeAcceptedResponseAfterDialog(dialog, async () => true)).toBe(false);
      }
      if (scenario === "generation-rejected") expect(monitor.failure()?.requestLimit?.category).toBe("generation");
    } finally { await monitor.close(); }
    expect((page as unknown as EventEmitter).listenerCount("request")).toBe(0);
    expect((page as unknown as EventEmitter).listenerCount("response")).toBe(0);
  },
);

test("dialog observation propagates cancellation and cannot outlive a send or a late rejection", async () => {
  const page = Object.assign(new EventEmitter(), { mainFrame: () => page, context: () => ({}) }) as unknown as Page;
  let release!: () => void;
  const monitor = new ChatGptRequestMonitor("late-dialog-fixture", evidence => evidence.source === "dialog"
    ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
  const emit = (pathname: string, method: string, status: number) => {
    const req = { frame: () => page, method: () => method, url: () => `https://chatgpt.com${pathname}` } as unknown as Request;
    (page as unknown as EventEmitter).emit("request", req);
    (page as unknown as EventEmitter).emit("response", { request: () => req, status: () => status, headers: () => ({}) });
  };
  const prime = () => {
    monitor.beginSend(); monitor.markSubmitted();
    emit("/backend-api/f/conversation", "POST", 200);
    emit("/backend-api/conversation/fixture", "GET", 429);
  };
  const evidence = { id: "cancel-dialog-limit", source: "dialog", category: "unknown" } as const;
  try {
    monitor.bind(page); prime();
    const abort = new DOMException("owner cancelled", "AbortError");
    await expect(monitor.observeAcceptedResponseAfterDialog(evidence, async () => { throw abort; })).rejects.toBe(abort);
    prime();
    const pending = monitor.observeAcceptedResponseAfterDialog(evidence, async () => true);
    await Promise.resolve();
    emit("/backend-api/f/conversation", "POST", 429);
    release();
    expect(await pending).toBe(false);
    expect(monitor.failure()?.requestLimit?.category).toBe("generation");
  } finally { await monitor.close(); }
});

test("distinct auxiliary GET limits preserve the same accepted response more than once", async () => {
  const page = Object.assign(new EventEmitter(), { mainFrame: () => page, context: () => ({}) }) as unknown as Page;
  let now = 1_000;
  let observations = 0;
  let generationRequests = 0;
  const reports: Array<{ source: string }> = [];
  const monitor = new ChatGptRequestMonitor("repeated-dialog-fixture", async evidence => { reports.push(evidence); }, () => now);
  const emit = (pathname: string, method: string, status: number) => {
    const req = { frame: () => page, method: () => method, url: () => `https://chatgpt.com${pathname}` } as unknown as Request;
    if (method === "POST") generationRequests++;
    (page as unknown as EventEmitter).emit("request", req);
    const response = { request: () => req, status: () => status, headers: () => ({}) };
    (page as unknown as EventEmitter).emit("response", response);
    return response;
  };
  const dialog = { id: "repeated-dialog-limit", source: "dialog", category: "unknown" } as const;
  const observe = async () => { observations++; return true; };
  try {
    monitor.bind(page); monitor.beginSend(); monitor.markSubmitted();
    emit("/backend-api/f/conversation", "POST", 200);
    const firstResponse = emit("/backend-api/conversation/fixture", "GET", 429);
    expect(await monitor.observeAcceptedResponseAfterDialog(dialog, observe)).toBe(true);
    expect(await monitor.observeAcceptedResponseAfterDialog(dialog, observe)).toBe(false);
    (page as unknown as EventEmitter).emit("response", firstResponse);
    expect(await monitor.observeAcceptedResponseAfterDialog(dialog, observe)).toBe(false);
    now += 300;
    emit("/backend-api/conversation/fixture", "GET", 429);
    expect(await monitor.observeAcceptedResponseAfterDialog({ ...dialog, id: "next-dialog-limit" }, observe)).toBe(true);
    now += 7 * 60_000;
    emit("/backend-api/conversation/fixture", "GET", 429);
    expect(await monitor.observeAcceptedResponseAfterDialog({ ...dialog, id: "later-dialog-limit" }, observe)).toBe(true);
    expect(observations).toBe(3);
    expect(generationRequests).toBe(1);
    expect(reports.filter(evidence => evidence.source === "dialog")).toHaveLength(3);
    expect(reports.filter(evidence => evidence.source === "http")).toHaveLength(3);
    expect(monitor.failure()).toBeUndefined();
  } finally { await monitor.close(); }
});

test.each(["no-progress", "generation-rejected", "auth-rejected", "ambiguous", "stale"])(
  "a second auxiliary limit still requires current response evidence: %s", async scenario => {
    const page = Object.assign(new EventEmitter(), { mainFrame: () => page, context: () => ({}) }) as unknown as Page;
    let now = 1_000;
    let observations = 0;
    const monitor = new ChatGptRequestMonitor("second-dialog-guard-fixture", async () => {}, () => now);
    const emit = (pathname: string, method: string, status: number) => {
      const req = { frame: () => page, method: () => method, url: () => `https://chatgpt.com${pathname}` } as unknown as Request;
      (page as unknown as EventEmitter).emit("request", req);
      (page as unknown as EventEmitter).emit("response", { request: () => req, status: () => status, headers: () => ({}) });
    };
    const dialog = { id: "guarded-dialog-limit", source: "dialog", category: "unknown" } as const;
    try {
      monitor.bind(page); monitor.beginSend(); monitor.markSubmitted();
      emit("/backend-api/f/conversation", "POST", 200);
      emit("/backend-api/conversation/fixture", "GET", 429);
      expect(await monitor.observeAcceptedResponseAfterDialog(dialog, async () => true)).toBe(true);
      emit("/backend-api/conversation/fixture", "GET", 429);
      if (scenario === "stale") now += 5_001;
      if (scenario === "generation-rejected") emit("/backend-api/f/conversation", "POST", 429);
      if (scenario === "auth-rejected") emit("/api/auth/session", "GET", 401);
      if (scenario === "ambiguous") emit("/backend-api/other", "POST", 429);
      expect(await monitor.observeAcceptedResponseAfterDialog(dialog, async () => {
        observations++; return scenario !== "no-progress";
      })).toBe(false);
      expect(observations).toBe(scenario === "no-progress" ? 1 : 0);
    } finally { await monitor.close(); }
  },
);

test("a fresh auxiliary rejection during observation is retained without parallel observation", async () => {
  const page = Object.assign(new EventEmitter(), { mainFrame: () => page, context: () => ({}) }) as unknown as Page;
  const monitor = new ChatGptRequestMonitor("concurrent-dialog-fixture", async () => {});
  const emit = (pathname: string, method: string, status: number) => {
    const req = { frame: () => page, method: () => method, url: () => `https://chatgpt.com${pathname}` } as unknown as Request;
    (page as unknown as EventEmitter).emit("request", req);
    (page as unknown as EventEmitter).emit("response", { request: () => req, status: () => status, headers: () => ({}) });
  };
  const dialog = { id: "concurrent-dialog-limit", source: "dialog", category: "unknown" } as const;
  let completeObservation!: (observed: boolean) => void;
  let parallelObservations = 0;
  try {
    monitor.bind(page); monitor.beginSend(); monitor.markSubmitted();
    emit("/backend-api/f/conversation", "POST", 200);
    emit("/backend-api/conversation/fixture", "GET", 429);
    const first = monitor.observeAcceptedResponseAfterDialog(dialog, () => new Promise(resolve => { completeObservation = resolve; }));
    emit("/backend-api/conversation/fixture", "GET", 429);
    expect(await monitor.observeAcceptedResponseAfterDialog(dialog, async () => { parallelObservations++; return true; })).toBe(false);
    expect(parallelObservations).toBe(0);
    completeObservation(true);
    expect(await first).toBe(true);
    expect(await monitor.observeAcceptedResponseAfterDialog(dialog, async () => true)).toBe(true);
    expect(await monitor.observeAcceptedResponseAfterDialog(dialog, async () => true)).toBe(false);
  } finally { await monitor.close(); }
});

test("usage cache refuses a mid-verification account switch and does not cache failures", async () => {
  let identity = "A";
  const cache = new ChatGptUsageAccountCache();
  await expect(cache.read(async () => identity, async () => {
    identity = "B";
    return { accountKey: "A", planType: "pro", personal: true, needsAttention: false };
  })).rejects.toThrow("account changed");
  await expect(cache.read(async () => identity, async () => { throw new Error("signed out"); })).rejects.toThrow("signed out");
  const result = await cache.read(async () => identity,
    async () => ({ accountKey: "B", planType: "pro", personal: true, needsAttention: false }));
  expect(result.accountKey).toBe("B");
});

test("request waiting is immediately cancellable", async () => {
  const controller = new AbortController();
  const pending = cancellableDelay(60_000, controller.signal);
  const reason = new Error("owner cancelled");
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

test("task tabs use trusted metadata and distinguish generation, retained state and native agents", () => {
  const copy = copyFor("ja");
  const tab: BrowserTabState = { id: "test-tab", traceId: "test-trace", title: "ChatGPT 3", status: "running",
    loading: false, active: true, closable: true, taskIdentity: { threadId: "parent-id" }, workStage: "compacting" };
  expect(browserTaskLabel(tab, copy)).toBe("親タスク · 圧縮中");
  const retained: BrowserTabState = { ...tab, id: "retained", status: "ready", workStage: "retained",
    taskIdentity: { threadId: "child-id", parentThreadId: "parent-id", agentName: "TestAgent" } };
  expect(browserTaskLabel(retained, copy)).toBe("TestAgent · 完了保持");
  expect(browserTaskTooltip(retained, copy)).toContain("child-id");
  expect(browserTabsOverview([tab, retained], copy)).toContain("稼働中 1・完了保持 1");
  expect(browserTabsOverview([tab, retained], copy)).toContain("ネイティブ担当");
});
