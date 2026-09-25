import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError, chatGptFailedThinkingError, chatGptStoppedThinkingError, chatGptTurnSupersededError } from "../src/adapters/chatgpt-web/adapter-error";
import { cancelStructuredCompactionNativeTurn, runStructuredCompactionOnce } from "../src/adapters/chatgpt-web/compaction-handoff";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace, chatGptWebTraceId } from "../src/adapters/chatgpt-web/index";
import { failedThinkingRecoveryPolicy } from "../src/adapters/chatgpt-web/failed-thinking-recovery";
import { chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "cgw-recovery-integration-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
type ToolCall = Extract<AdapterEvent, { type: "tool_call_start" }>;
const toolCalls = (events: AdapterEvent[]) => events.filter((event): event is ToolCall => event.type === "tool_call_start");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function nativeCall(turn: BrowserTurn, socket: string, token: string, command: string): Promise<BrokerToolResult> {
  const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
  const progress = turn.externalProgress!;
  const revision = progress.snapshot().lastToolBatchRevision;
  const invocation = callTurnBroker<BrokerToolResult>(socket, {
    method: "invoke", bindingId, wireName: "exec_command", freeform: false, arguments: { cmd: command },
  }, 10_000);
  let current = progress.snapshot();
  while (current.lastToolBatchRevision <= revision) current = await progress.waitForChange(current.revision, turn.abortSignal);
  await progress.acknowledgeToolBatch(current.lastToolBatchRevision);
  return await invocation;
}

function completedRequest(request: CodexParsedRequest, call: ToolCall, command: string, output: string): CodexParsedRequest {
  const raw = structuredClone(request._rawBody) as { input: unknown[] };
  raw.input.push(
    { type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify({ cmd: command }) },
    { type: "function_call_output", call_id: call.id, output: JSON.stringify({ output, exit_code: 0 }) },
  );
  return parseRequest(raw);
}

async function scenario(options: { accepted?: boolean; afterResult?: () => void; secondTool?: boolean; secondFailure?: boolean; partial?: boolean; otherError?: boolean; serverError?: boolean } = {}) {
  const id = randomUUID();
  const socket = process.platform === "win32" ? defaultBrokerEndpoint(join(root, id), "win32") : join(root, `${id}.sock`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://failed-thinking-${id}`,
    chatgptWeb: { brokerSocketPath: socket, localToolsEnabled: true, solAvailable: true, proAvailable: true,
      extraHighAvailable: true, threadEnvironmentStatePath: join(root, `${id}.json`) },
  };
  const initial = parseRequest({ model: "gpt-5.6-sol", stream: true, reasoning: { effort: "max" },
    prompt_cache_key: id, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: id }) },
    tools: [{ type: "function", name: "exec_command", description: "Execute local tool", parameters: { type: "object" } }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>` }], internal_chat_message_metadata_passthrough: { turn_id: id } },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Save the change once, then inspect the result." }], internal_chat_message_metadata_passthrough: { turn_id: id } },
    ],
  });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const original = worker.run;
  const prompts: string[] = [];
  const turns: BrowserTurn[] = [];
  const oldResult = deferred();
  const allowFailure = deferred();
  const failure = options.serverError
    ? new ChatGptWebAdapterError("Something went wrong", { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true })
    : options.otherError ? chatGptStoppedThinkingError() : chatGptFailedThinkingError();
  worker.run = async turn => {
    const index = turns.push(turn);
    const prepared = await turn.prepare();
    prompts.push(prepared.text);
    const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
    if (!token) throw new Error("Missing native token in test prompt");
    turn.onSendActivated?.();
    if (options.accepted !== false) turn.onSubmitted?.();
    try {
      if (index === 1) {
        const result = await nativeCall(turn, socket, token, "save-once");
        expect(result.structuredContent).toEqual({ output: "saved change once", exit_code: 0 });
        oldResult.resolve();
        await allowFailure.promise;
        options.afterResult?.();
        if (options.partial) turn.onTextDelta("Partial final answer");
        throw failure;
      }
      expect(index).toBe(2);
      expect(prepared.text).toContain("recovery continuation");
      expect(prepared.text).toContain("saved change once");
      expect(prepared.text).toContain("save-once");
      expect(turn.modelId).toBe(turns[0]!.modelId);
      expect(turn.reasoning).toBe(turns[0]!.reasoning);
      if (options.secondTool) await nativeCall(turn, socket, token, "inspect-existing");
      if (options.secondFailure) throw chatGptFailedThinkingError();
      turn.onTextDelta("Continued from saved work");
      return "Continued from saved work";
    } finally { prepared.release(); }
  };
  const adapter = createChatGptWebAdapter(provider);
  const run = async (request: CodexParsedRequest, signal?: AbortSignal) => {
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), abortSignal: signal }, event => events.push(event));
    return events;
  };
  const first = await run(initial);
  expect(toolCalls(first)).toHaveLength(1);
  const next = completedRequest(initial, toolCalls(first)[0]!, "save-once", "saved change once");
  const key = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(initial)}`;
  const session = chatGptTurnSessions.find(key)!;
  return { id, provider, initial, next, first, run, turns, prompts, oldResult, allowFailure, session, key,
    async close() {
      allowFailure.resolve();
      await chatGptTurnSessions.retireAndWait(key);
      worker.run = original;
      await TurnBroker.forSocket(socket).close();
    },
  };
}

test("failed-thinking recovery rejects changed arguments for an issued tool", async () => {
  const s = await scenario();
  try {
    const raw = structuredClone(s.next._rawBody) as { input: Array<Record<string, unknown>> };
    raw.input.at(-2)!.arguments = JSON.stringify({ cmd: "save-once-to-another-target" });
    const pending = s.run(parseRequest(raw));
    await s.oldResult.promise;
    s.allowFailure.resolve();
    const events = await pending;
    expect(s.turns).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
  } finally { await s.close(); }
});

test.each([false, true])("response recovery keeps completed tools and shares concurrent reconnects (serverError=%s)", async serverError => {
  const s = await scenario({ secondTool: true, serverError });
  try {
    const one = s.run(s.next);
    const two = s.run(s.next);
    await s.oldResult.promise;
    s.allowFailure.resolve();
    const results = await Promise.all([one, two]);
    expect(s.turns).toHaveLength(2);
    for (const events of results) {
      expect(toolCalls(events)).toHaveLength(1);
      expect(toolCalls(events)[0]!.id).not.toBe(toolCalls(s.first)[0]!.id);
      expect(events.some(event => event.type === "error")).toBeFalse();
    }
    expect(toolCalls(results[0]!)[0]!.id).toBe(toolCalls(results[1]!)[0]!.id);
    const last = completedRequest(s.next, toolCalls(results[0]!)[0]!, "inspect-existing", "verified saved work");
    const final = await s.run(last);
    expect(toolCalls(final)).toHaveLength(0);
    expect(final.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(s.prompts[1]).toContain(toolCalls(s.first)[0]!.id);
    await expect(s.run(s.initial)).rejects.toMatchObject({ code: "chatgpt_recovery_history_mismatch" });
    expect(s.turns).toHaveLength(2);
    await chatGptTurnSessions.retireAndWait(s.key);
    await expect(s.run(last)).rejects.toMatchObject({ code: "chatgpt_recovery_already_used" });
    expect(s.turns).toHaveLength(2);
  } finally { await s.close(); }
});

test("failed-thinking adapter stops at the second failure even after new completed tools", async () => {
  const s = await scenario({ secondTool: true, secondFailure: true });
  try {
    const continuation = s.run(s.next);
    await s.oldResult.promise; s.allowFailure.resolve();
    const middle = await continuation;
    const last = completedRequest(s.next, toolCalls(middle)[0]!, "inspect-existing", "verified saved work");
    for (let attempt = 0; attempt < 3; attempt++) {
      const events = await s.run(last);
      expect(events.at(-1)).toMatchObject({ type: "error", code: "chatgpt_failed_thinking", retryable: false });
      expect(toolCalls(events)).toHaveLength(0);
    }
    expect(s.turns).toHaveLength(2);
  } finally { await s.close(); }
});

for (const blocked of ["partial-final", "unaccepted", "other-error", "missing-history", "superseded", "native-cancel", "compaction-active"] as const) {
  test.each([false, true])(`response recovery refuses unsafe recovery: ${blocked} (serverError=%s)`, async serverError => {
    const s = await scenario({ partial: blocked === "partial-final", accepted: blocked !== "unaccepted", otherError: blocked === "other-error", serverError: blocked === "other-error" ? false : serverError });
    const finishCompaction = deferred();
    let compaction: Promise<string> | undefined;
    try {
      const request = structuredClone(s.next);
      if (blocked === "missing-history") (request._rawBody as { input: unknown[] }).input.pop();
      const run = s.run(request);
      await s.oldResult.promise;
      if (blocked === "superseded") s.session.supersededError = chatGptTurnSupersededError();
      if (blocked === "native-cancel") cancelStructuredCompactionNativeTurn(s.id, s.id, chatGptTurnSupersededError());
      if (blocked === "compaction-active") {
        compaction = runStructuredCompactionOnce(`recovery-guard-${s.id}`, {
          ownerKey: `${chatGptWebExecutionNamespace(s.provider)}:${chatGptThreadOwnershipKey(s.initial)}`, traceIds: [],
        }, async () => { await finishCompaction.promise; return "summary"; });
      }
      s.allowFailure.resolve();
      const events = await run;
      expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
      expect(s.turns).toHaveLength(1);
      expect(toolCalls(events)).toHaveLength(0);
    } finally {
      finishCompaction.resolve(); await compaction; await s.close();
    }
  });
}

test("failed-thinking adapter waits for release and respects cancellation during recovery cleanup", async () => {
  const s = await scenario();
  const releasing = deferred(); const released = deferred();
  s.session.runtime.releaseRetainedConversation = async () => { releasing.resolve(); await released.promise; };
  try {
    const pending = s.run(s.next);
    const observed = pending.then(() => undefined, error => error);
    await s.oldResult.promise; s.allowFailure.resolve(); await releasing.promise;
    expect(s.turns).toHaveLength(1);
    cancelStructuredCompactionNativeTurn(s.id, s.id, chatGptTurnSupersededError());
    released.resolve();
    expect(await observed).toMatchObject({ code: "client_cancelled" });
    await expect(s.run(s.next)).rejects.toMatchObject({ code: "client_cancelled" });
    expect(s.turns).toHaveLength(1);
  } finally { released.resolve(); await s.close(); }
});

test("HTTP disconnect does not automatically start a recovery behind the detached observer", async () => {
  const s = await scenario();
  const disconnect = new AbortController();
  try {
    const pending = s.run(s.next, disconnect.signal);
    const observed = pending.then(() => undefined, error => error);
    await s.oldResult.promise; disconnect.abort();
    expect(await observed).toMatchObject({ name: "AbortError" });
    s.allowFailure.resolve(); await s.session.browserOutcome;
    expect(s.turns).toHaveLength(1);
    const events = await s.run(s.next);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(s.turns).toHaveLength(2);
  } finally { await s.close(); }
});

for (const reconnectDuringCleanup of [false, true]) {
  test(`HTTP disconnect during recovery cleanup preserves the shared continuation (concurrent=${reconnectDuringCleanup})`, async () => {
    const s = await scenario();
    const releasing = deferred(); const released = deferred();
    const disconnect = new AbortController();
    s.session.runtime.releaseRetainedConversation = async () => { releasing.resolve(); await released.promise; };
    try {
      const observed = s.run(s.next, disconnect.signal).then(() => undefined, error => error);
      await s.oldResult.promise; s.allowFailure.resolve(); await releasing.promise;
      const reconnect = reconnectDuringCleanup ? s.run(s.next) : undefined;
      disconnect.abort();
      expect(await observed).toMatchObject({ name: "AbortError" });
      expect(s.turns).toHaveLength(1);
      released.resolve();
      if (!reconnect) {
        const key = `${chatGptWebExecutionNamespace(s.provider)}:${chatGptWebTraceId(s.provider, s.next)}`;
        await failedThinkingRecoveryPolicy.entry(key)!.ready;
        // Finishing cleanup alone must not launch a model with no observer attached.
        expect(s.turns).toHaveLength(1);
      }
      const events = await (reconnect ?? s.run(s.next));
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(toolCalls(events)).toHaveLength(0);
      expect(s.turns).toHaveLength(2);
      expect(s.prompts[1]).toContain("saved change once");
    } finally { released.resolve(); await s.close(); }
  });
}
