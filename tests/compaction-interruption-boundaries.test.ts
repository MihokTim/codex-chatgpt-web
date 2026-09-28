import { expect, spyOn, test } from "bun:test";
import {
  requestRetainedCompactionHandoff, settleActiveCompactionSource, settleActiveZeroRiskCompactionSource,
  cancelStructuredCompactionNativeTurn, nativeTurnInterruptionError, runStructuredCompactionOnce,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { CodexParsedRequest } from "../src/types";
import { defaultConfig } from "../src/config";
import { interruptActiveTurn } from "../src/service";

const parsed: CodexParsedRequest = {
  modelId: "gpt-5.6-sol", stream: false, options: {}, context: { messages: [] }, _compactionRequest: true,
};

test("an interrupted compaction identity cannot restart after the 30 minute cache TTL", async () => {
  const reason = new DOMException("stop before long cleanup", "AbortError");
  const owner = { ownerKey: "long-cleanup", traceIds: [], nativeThreadId: "child-long-cleanup", nativeTurnId: "stopped-turn" };
  cancelStructuredCompactionNativeTurn(owner.nativeThreadId, owner.nativeTurnId, reason);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
  let starts = 0;
  try {
    expect(nativeTurnInterruptionError(owner.nativeThreadId, owner.nativeTurnId)).toBe(reason);
    await expect(runStructuredCompactionOnce("late-after-interrupt", owner, async () => {
      starts++;
      return "must not be submitted";
    })).rejects.toBe(reason);
    expect(starts).toBe(0);
    expect(await runStructuredCompactionOnce("independent-after-interrupt", {
      ...owner, nativeTurnId: "new-turn",
    }, async () => "new authorized turn")).toBe("new authorized turn");
  } finally {
    clock.mockRestore();
  }
});

function source(token: Promise<string>, cancel: (reason?: Error) => void, manual = false) {
  return new ChatGptTurnSession({
    mode: "tools", token, externalProgress: { recordToolResult() {} } as never,
    browser: new Promise<string>(() => {}), physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), conversationKey: "retained-child",
    ...(manual ? { manualControl: { surfaceNonce: "nonce" } } : {}), cancel,
  });
}

test.each([false, true])("explicit compaction cancellation does not wait for a late token (manual=%s)", async manual => {
  let supplyToken!: (token: string) => void;
  const token = new Promise<string>(resolve => { supplyToken = resolve; });
  const controller = new AbortController();
  const reason = new DOMException("stop this child", "AbortError");
  let cancelled: Error | undefined;
  let requests = 0;
  const session = source(token, error => { cancelled = error; }, manual);
  const broker = { requestCompaction() { requests++; return 0; }, revoke() {} };
  const settle = manual ? settleActiveZeroRiskCompactionSource : settleActiveCompactionSource;
  const pending = settle(parsed, session, broker as never, controller.signal);
  // Enter the exclusive callback and suspend specifically on token registration.
  await Promise.resolve();
  controller.abort(reason);
  try {
    await expect(pending).rejects.toBe(reason);
    expect(cancelled).toBe(reason);
  } finally {
    supplyToken("late-token");
  }
  await Promise.resolve();
  expect(requests).toBe(0);
});

test.each([false, true])("compaction cancellation stops the next canonical tool delivery (manual=%s)", async manual => {
  const controller = new AbortController();
  const reason = new DOMException("stop between results", "AbortError");
  const session = source(Promise.resolve("token"), () => {}, manual);
  session.setOutstanding(["one", "two"].map(callId => ({ callId, wireName: "exec_command", freeform: false })));
  const request: CodexParsedRequest = {
    ...parsed,
    context: { messages: ["one", "two"].map(toolCallId => ({
      role: "toolResult", toolCallId, toolName: "exec_command", content: "canonical", isError: false, timestamp: 1,
    })) },
  };
  const delivered: string[] = [];
  const broker = {
    requestCompaction() { return 0; }, revoke() {},
    async completeTool(_token: string, id: string) { delivered.push(id); controller.abort(reason); },
  };
  const settle = manual ? settleActiveZeroRiskCompactionSource : settleActiveCompactionSource;
  await expect(settle(request, session, broker as never, controller.signal)).rejects.toBe(reason);
  expect(delivered).toEqual(["one"]);
});

test("already cancelled retained compaction never registers a transaction or starts a browser", async () => {
  const controller = new AbortController();
  const reason = new DOMException("stop before retained send", "AbortError");
  controller.abort(reason);
  let starts = 0;
  const worker = { run() { starts++; throw new Error("browser must not start"); } };
  const broker = { beginCompactionTransaction() { starts++; throw new Error("transaction must not start"); } };
  await expect(requestRetainedCompactionHandoff(
    worker as never, parsed, source(Promise.resolve("token"), () => {}), broker as never,
    {} as never, "cancelled-trace", controller.signal,
  )).rejects.toBe(reason);
  expect(starts).toBe(0);
});

test.each([undefined, 1, -1, "1", null])("service interrupt validates and retains detached compaction receipt: %s", async count => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ status: "ok", cancelled_http_turns: 0, cancelled_browser_turns: 0,
      ...(count !== undefined ? { cancelled_compaction_runs: count } : {}) }),
  });
  try {
    const receipt = interruptActiveTurn({ ...defaultConfig("browser-only"), port: server.port! }, {
      threadId: "thread_receipt", turnId: "turn_receipt",
    });
    if (count === undefined || count === 1) {
      expect(await receipt).toEqual({ cancelledHttpTurns: 0, cancelledBrowserTurns: 0, cancelledCompactionRuns: count ?? 0 });
    } else {
      await expect(receipt).rejects.toThrow("invalid interrupt acknowledgement");
    }
  } finally {
    await server.stop(true);
  }
});
