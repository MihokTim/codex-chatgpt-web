import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { cancelStructuredCompactionNativeTurn } from "../src/adapters/chatgpt-web/compaction-handoff";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "cgw-compact-boundary-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function scenario(large = false) {
  const id = randomUUID();
  const socket = defaultBrokerEndpoint(join(root, id));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://compaction-boundary-${id}`,
    chatgptWeb: { brokerSocketPath: socket, browserHost: "launcher", browserHostDescriptorPath: join(root, `${id}-launcher.json`),
      localToolsEnabled: true, solAvailable: true, proAvailable: true, experimentalBiggerContext: true,
      threadEnvironmentStatePath: join(root, `${id}.json`) },
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
  const turns: BrowserTurn[] = [];
  const prompts: string[] = [];
  const retiring = gate(); const released = gate();
  let delivered = 0;
  worker.run = async turn => {
    turns.push(turn);
    const prepared = await turn.prepare();
    try {
      if (turn.compaction) {
        expect(turn.capabilities.localToolsEnabled).toBeFalse();
        expect(turn.conversationKey).toBeUndefined();
        prompts.push(prepared.multipart?.parts.join("\n") ?? prepared.text);
        return "Saved once; inspect the saved change next.";
      }
      turn.onSendActivated?.(); turn.onSubmitted?.();
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("Missing native token");
      const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
      const invocation = callTurnBroker(socket, { method: "invoke", bindingId, wireName: "exec_command", freeform: false, arguments: { cmd: "save-once" } });
      void invocation.then(() => { delivered++; }, () => {});
      const progress = turn.externalProgress!;
      let snapshot = progress.snapshot();
      while (!snapshot.lastToolBatchRevision) snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
      await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
      await new Promise<void>(resolve => turn.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
      retiring.resolve();
      await released.promise;
      throw turn.abortSignal!.reason;
    } finally { prepared.release(); }
  };
  const adapter = createChatGptWebAdapter(provider);
  const run = async (parsed: CodexParsedRequest, signal?: AbortSignal) => {
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: signal }, event => events.push(event));
    return events;
  };
  const first = await run(initial);
  const call = first.find(event => event.type === "tool_call_start");
  expect(call?.type).toBe("tool_call_start");
  if (call?.type !== "tool_call_start") throw new Error("Missing native tool call");
  const raw = structuredClone(initial._rawBody) as { input: unknown[] };
  raw.input.push(
    { type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify({ cmd: "save-once" }) },
    { type: "function_call_output", call_id: call.id, output: "saved change once" + (large ? " x".repeat(90_000) : "") },
  );
  const compact = parseRequest(raw); compact._compactionRequest = true;
  const key = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(initial)}`;
  const session = chatGptTurnSessions.find(key)!;
  let releases = 0;
  session.runtime.releaseRetainedConversation = async () => { releases++; };
  return { id, compact, raw, run, turns, prompts, retiring, released, session,
    delivered: () => delivered, releases: () => releases,
    async close() {
      released.resolve(); await chatGptTurnSessions.retireAndWait(key);
      worker.run = original; await TurnBroker.forSocket(socket).close();
    },
  };
}

test.each([false, true])("compaction retires before returning a completed tool result to a full source (large=%s)", async large => {
  const s = await scenario(large);
  try {
    const one = s.run(s.compact); const two = s.run(s.compact);
    await s.retiring.promise;
    expect(s.turns).toHaveLength(1);
    expect(s.delivered()).toBe(0);
    s.released.resolve();
    for (const events of await Promise.all([one, two])) expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(s.turns).toHaveLength(2);
    expect(s.releases()).toBe(1);
    expect(s.prompts[0]).toContain("saved change once");
    expect(s.prompts[0]).toContain("save-once");
    expect(s.prompts[0]).toContain("Save the change once");
    expect(s.turns[1]!.modelId).toBe(s.turns[0]!.modelId);
    expect(s.delivered()).toBe(0);
    expect((await s.run(s.compact)).at(-1)).toMatchObject({ type: "done" });
    expect(s.turns).toHaveLength(2);
  } finally { await s.close(); }
});

for (const malformed of ["missing-output", "duplicate-output", "changed-call", "orphan-output"] as const) {
  test(`compaction refuses incomplete canonical tool evidence: ${malformed}`, async () => {
    const s = await scenario();
    try {
      if (malformed === "missing-output") s.raw.input.pop();
      if (malformed === "duplicate-output") s.raw.input.push(s.raw.input.at(-1));
      if (malformed === "changed-call") (s.raw.input.at(-2) as { arguments: string }).arguments = '{"cmd":"different"}';
      if (malformed === "orphan-output") s.raw.input.push({ type: "function_call_output", call_id: "orphan", output: "unknown" });
      const compact = parseRequest(s.raw); compact._compactionRequest = true;
      s.released.resolve();
      const events = await s.run(compact);
      expect(events.at(-1)).toMatchObject({ type: "error", code: "compaction_history_incomplete", retryable: false });
      expect((await s.run(compact)).at(-1)).toMatchObject({ type: "error", code: "compaction_history_incomplete" });
      expect(s.turns).toHaveLength(1);
      expect(s.delivered()).toBe(0);
    } finally { await s.close(); }
  });
}

test("native cancellation during compaction retirement prevents the fresh summary", async () => {
  const s = await scenario();
  try {
    const pending = s.run(s.compact);
    await s.retiring.promise;
    const cancelled = cancelStructuredCompactionNativeTurn(s.id, s.id, new Error("operator cancelled"));
    s.released.resolve(); await cancelled.settlement;
    expect((await pending).at(-1)).toMatchObject({ type: "error", retryable: false });
    expect(s.turns).toHaveLength(1);
  } finally { await s.close(); }
});
