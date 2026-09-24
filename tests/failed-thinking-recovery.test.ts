import { expect, test } from "bun:test";
import type { CodexParsedRequest, CodexToolResultMessage } from "../src/types";
import { FailedThinkingRecoveryPolicy, hasCompleteRecoveryHistory, nativeToolResultProof } from "../src/adapters/chatgpt-web/failed-thinking-recovery";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { hasCompleteCompactionHistory } from "../src/adapters/chatgpt-web/compaction-source-history";

function fixture() {
  const session = new ChatGptTurnSession({ mode: "read-only", browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} });
  const result: CodexToolResultMessage = { role: "toolResult", toolCallId: "completed-write", toolName: "exec_command",
    content: "saved change once", isError: false, timestamp: 3 };
  session.setOutstanding([{ callId: result.toolCallId, wireName: result.toolName, arguments: {}, freeform: false }]);
  session.markResultDelivered(result.toolCallId, nativeToolResultProof(result));
  const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: {},
    context: { messages: [result] }, _rawBody: { input: [
      { type: "function_call", call_id: result.toolCallId, name: result.toolName, arguments: "{}" },
      { type: "function_call_output", call_id: result.toolCallId, output: result.content },
    ] } };
  return { session, parsed, result };
}

test("recovery requires all completed result proofs and rejects missing, changed or duplicate history", () => {
  const { session, parsed } = fixture();
  expect(hasCompleteRecoveryHistory(parsed, session)).toBeTrue();
  for (const mutate of [
    (p: CodexParsedRequest) => { p.context.messages = []; },
    (p: CodexParsedRequest) => { (p.context.messages[0] as CodexToolResultMessage).content = "different result"; },
    (p: CodexParsedRequest) => { p.context.messages.push(p.context.messages[0]!); },
    (p: CodexParsedRequest) => { (p._rawBody as { input: unknown[] }).input.pop(); },
    (p: CodexParsedRequest) => { (p._rawBody as { input: unknown[] }).input.push({ type: "function_call", call_id: "still-running" }); },
    (p: CodexParsedRequest) => { p._rawBody = undefined; },
  ]) {
    const altered = structuredClone(parsed); mutate(altered);
    expect(hasCompleteRecoveryHistory(altered, session)).toBeFalse();
  }
  session.setOutstanding([{ callId: "pending-write", wireName: "exec_command", freeform: false }]);
  expect(hasCompleteRecoveryHistory(parsed, session)).toBeFalse();
});

test.each(["arguments", "name", "kind", "malformed", "output-kind"])("recovery rejects a changed completed call: %s", change => {
  const { parsed, session } = fixture();
  const input = (parsed._rawBody as { input: Array<Record<string, unknown>> }).input;
  if (change === "arguments") input[0]!.arguments = '{"target":"different"}';
  if (change === "name") input[0]!.name = "other_tool";
  if (change === "kind") { input[0]!.type = "custom_tool_call"; input[0]!.input = ""; }
  if (change === "malformed") input[0]!.arguments = "{invalid";
  if (change === "output-kind") input[1]!.type = "custom_tool_call_output";
  expect(hasCompleteRecoveryHistory(parsed, session)).toBeFalse();
  expect(hasCompleteCompactionHistory(parsed, session)).toBeFalse();
});

test("recovery preserves the native prefix, shares cleanup, and cannot spend a second recovery", async () => {
  const { parsed, session } = fixture();
  const policy = new FailedThinkingRecoveryPolicy();
  let cleanup = 0;
  let finish!: () => void;
  const first = policy.reserve("epoch", parsed, session, async () => { cleanup++; await new Promise<void>(r => { finish = r; }); });
  const duplicate = policy.reserve("epoch", parsed, session, async () => { throw new Error("duplicate cleanup"); });
  expect(first).toBe(duplicate);
  await Promise.resolve(); expect(cleanup).toBe(1); finish(); await first;
  expect(() => policy.assertHistory("epoch", parsed)).not.toThrow();
  const later = structuredClone(parsed);
  (later._rawBody as { input: unknown[] }).input.push({ type: "message", role: "assistant", content: "continued" });
  expect(() => policy.assertHistory("epoch", later)).not.toThrow();
  (later._rawBody as { input: unknown[] }).input.shift();
  expect(() => policy.assertHistory("epoch", later)).toThrow("stale or changed");
  expect(policy.reserve("epoch", parsed, fixture().session, async () => {})).toBeUndefined();
});

test("failed cleanup remains terminal and never opens a second preparation", async () => {
  const { parsed, session } = fixture(); const policy = new FailedThinkingRecoveryPolicy();
  const ready = policy.reserve("cancelled", parsed, session, async () => { throw new Error("user stopped"); });
  await expect(ready!).rejects.toThrow("user stopped");
  expect(policy.reserve("cancelled", parsed, session, async () => {})).toBe(ready);
});

test("a retired replacement cannot be recreated and missing delivery proofs cannot recover", async () => {
  const { parsed, session } = fixture();
  const policy = new FailedThinkingRecoveryPolicy();
  await policy.reserve("once", parsed, session, async () => {});
  expect(() => policy.startReplacement("once")).not.toThrow();
  expect(() => policy.startReplacement("once")).toThrow("already started");
  expect(() => policy.startReplacement("unknown")).toThrow("already started");
  session.setOutstanding([{ callId: "unproven", wireName: "exec_command", freeform: false }]);
  session.markResultDelivered("unproven");
  expect(hasCompleteRecoveryHistory(parsed, session)).toBeFalse();
});

test("recovery capacity reports exhaustion without evicting old replay fences", async () => {
  const { parsed, session } = fixture();
  const policy = new FailedThinkingRecoveryPolicy();
  expect(policy.capacity()).toEqual({ used: 0, limit: 512, remaining: 512 });
  for (let index = 0; index < 512; index++) await policy.reserve(`epoch-${index}`, parsed, session, async () => {});
  expect(policy.capacity()).toEqual({ used: 512, limit: 512, remaining: 0 });
  expect(policy.reserve("overflow", parsed, session, async () => { throw new Error("must not start"); })).toBeUndefined();
  const original = policy.entry("epoch-0")!;
  expect(policy.reserve("epoch-0", parsed, session, async () => {})).toBe(original.ready);
  policy.startReplacement("epoch-0");
  expect(() => policy.startReplacement("epoch-0")).toThrow("already started");
});
