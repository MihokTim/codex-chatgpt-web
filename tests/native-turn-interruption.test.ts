import { expect, test } from "bun:test";
import {
  ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions,
  type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { compactRequest, HttpTurnCounter, responseRequest } from "../src/server";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function runtime(physicalSettlement = Promise.resolve()): ChatGptTurnRuntime {
  return {
    mode: "read-only", browser: Promise.resolve("finished"), physicalSettlement,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel: () => {},
  };
}

test("native Interrupt fences an unregistered turn waiting behind physical cleanup", async () => {
  const sessions = new ChatGptTurnSessions();
  const release = deferred<void>();
  sessions.getOrCreate("old", () => runtime(release.promise), "old-trace", "owner", "old-turn", "child");
  let starts = 0;
  const pending = sessions.getOrCreateAfterOwnerRetirement(
    "queued", "owner", () => { starts++; return runtime(); }, "queued-trace", undefined, "queued-turn", "child",
  );
  const reason = new DOMException("explicit child Interrupt", "AbortError");
  expect(sessions.cancelNativeTurn("child", "queued-turn", reason).cancelled).toBe(0);
  release.resolve();
  await expect(pending).rejects.toBe(reason);
  expect(starts).toBe(0);

  // A new turn in that child and the same turn id in another child remain independent.
  expect(await sessions.getOrCreateAfterOwnerRetirement(
    "next", "owner", () => runtime(), undefined, undefined, "next-turn", "child",
  )).toBeDefined();
  expect(sessions.getOrCreate("peer", () => runtime(), undefined, "peer-owner", "queued-turn", "peer-child")).toBeDefined();
  sessions.clear();
});

test("native Interrupt stays terminal after session removal, cache clear, and changed execution keys", async () => {
  const sessions = new ChatGptTurnSessions();
  const reason = new DOMException("explicit Interrupt", "AbortError");
  sessions.getOrCreate("original", () => runtime(), "trace", "owner", "turn", "thread");
  await sessions.cancelNativeTurn("thread", "turn", reason).settlement;
  sessions.clear();
  let starts = 0;
  expect(() => sessions.getOrCreate(
    "post-compaction-key", () => { starts++; return runtime(); }, undefined, "owner", "turn", "thread",
  )).toThrow(reason);
  expect(starts).toBe(0);
});

test("completed parent response and detached observers do not cancel a child", async () => {
  const sessions = new ChatGptTurnSessions();
  let childCancelled = false;
  const childResult = deferred<string>();
  const child = sessions.getOrCreate("child", () => ({
    ...runtime(childResult.promise.then(() => {})), browser: childResult.promise,
    cancel: () => { childCancelled = true; },
  }), "child-trace", "child-owner", "child-turn", "child-thread");
  const parent = sessions.getOrCreate("parent", () => runtime(), "parent-trace", "parent-owner", "parent-turn", "parent-thread");
  const detach = child.attachObserver();
  expect(detach()).toBe(0);
  await parent.browserOutcome;
  await sessions.cancelNativeTurn("parent-thread", "parent-turn", new Error("stop parent only")).settlement;
  expect(childCancelled).toBeFalse();
  expect(child.isActive()).toBeTrue();
  childResult.resolve("independent completion");
  expect(await child.browserOutcome).toEqual({ type: "final", answer: "independent completion" });
  sessions.clear();
});

const identity = { threadId: "thread_unsent_interrupt", turnId: "turn_unsent_interrupt" };
function body() {
  return {
    model: "chatgpt-web/high", stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: identity.threadId, turn_id: identity.turnId }) },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "cancel before submission" }],
      internal_chat_message_metadata_passthrough: { turn_id: identity.turnId } }],
  };
}

test.each(["responses", "compact"] as const)("Interrupt during %s identity binding never constructs an adapter (Windows lifecycle)", async endpoint => {
  const turns = new HttpTurnCounter();
  await turns.cancelTurn(identity);
  let starts = 0;
  const handler = endpoint === "responses" ? responseRequest : compactRequest;
  const response = await turns.track((signal, bindIdentity) => handler(new Request(`http://localhost/v1/${endpoint}`, {
    method: "POST", body: JSON.stringify(body()), signal,
    headers: { "content-type": "application/json" },
  }), defaultConfig("browser-only"), () => {
    starts++;
    throw new Error("interrupted request must not construct an adapter");
  }, { onTurnIdentity: bindIdentity }), undefined, "win32");
  expect(response.status).toBe(499);
  expect(starts).toBe(0);
  expect(turns.count()).toBe(0);
});

test("the routed Web adapter receives the original explicit cancellation reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Codex turn interrupted", "AbortError");
  let observed: unknown;
  const response = await responseRequest(new Request("http://localhost/v1/responses", {
    method: "POST", body: JSON.stringify(body()), signal: controller.signal,
    headers: { "content-type": "application/json" },
  }), defaultConfig("browser-only"), () => ({
    name: "interrupt-reason-test",
    async runTurn(_parsed, incoming, emit) {
      controller.abort(reason);
      observed = incoming.abortSignal?.reason;
      emit({ type: "done" });
    },
  }));
  await response.text();
  expect(observed).toBe(reason);
});


test("interruption capacity rejects a replacement before retiring its live instruction predecessor", async () => {
  const sessions = new ChatGptTurnSessions(30 * 60_000, 256, 1);
  const active = deferred<string>();
  let cancelled = false;
  let starts = 0;
  const old = sessions.getOrCreate("old", () => ({
    ...runtime(active.promise.then(() => {})), browser: active.promise,
    cancel: () => { cancelled = true; active.resolve("cancelled"); },
  }), "trace", "owner", "old-turn", "thread", "old-instruction");
  sessions.cancelNativeTurn("other", "first", new Error("first stop"));
  sessions.cancelNativeTurn("other", "overflow", new Error("second stop"));
  await expect(sessions.getOrCreateAfterOwnerRetirement(
    "replacement", "owner", () => { starts++; return runtime(); }, undefined, undefined, "new-turn", "thread",
    { current: "new-instruction", predecessors: new Set(["old-instruction"]) },
  )).rejects.toThrow("interruption tracking is full");
  expect(cancelled).toBeFalse();
  expect(starts).toBe(0);
  expect(old.isActive()).toBeTrue();
  expect(old.supersededError).toBeUndefined();
  expect(await sessions.getOrCreateAfterOwnerRetirement(
    "old", "owner", () => { throw new Error("must reuse"); }, undefined, undefined, "old-turn", "thread",
  )).toBe(old);
  active.resolve("finished");
  await old.browserOutcome;
  sessions.clear();
});

test("interruption capacity refuses new starts without evicting old stops or cancelling live peers", async () => {
  const sessions = new ChatGptTurnSessions(30 * 60_000, 256, 1);
  const active = deferred<string>();
  let peerCancelled = false;
  const peer = sessions.getOrCreate("live-peer", () => ({
    ...runtime(active.promise.then(() => {})), browser: active.promise,
    cancel: () => { peerCancelled = true; },
  }), "peer", "peer-owner", "peer-turn", "peer-thread");
  const first = new DOMException("first stop", "AbortError");
  sessions.cancelNativeTurn("thread", "first-turn", first);
  sessions.cancelNativeTurn("thread", "overflow-turn", new Error("second stop"));
  expect(() => sessions.getOrCreate("first-replay", () => runtime(), undefined, "owner", "first-turn", "thread")).toThrow(first);
  for (const turn of ["overflow-turn", "new-turn"]) {
    expect(() => sessions.getOrCreate(turn, () => runtime(), undefined, "owner", turn, "thread"))
      .toThrow("interruption tracking is full");
  }
  expect(sessions.getOrCreate("live-peer", () => { throw new Error("must reuse"); }, "peer", "peer-owner", "peer-turn", "peer-thread")).toBe(peer);
  expect(peerCancelled).toBeFalse();
  active.resolve("peer finished");
  await peer.browserOutcome;
  sessions.clear();
});
