import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptFailedThinkingError, chatGptStoppedThinkingError, chatGptTurnSupersededError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { nativeToolResultProof } from "../src/adapters/chatgpt-web/failed-thinking-recovery";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

for (const scenario of ["recover", "second-failure", "missing-history", "changed-history", "cancelled", "superseded", "other-error"] as const) {
  test(`structured compaction failed-thinking recovery: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-compact-failed-thinking-"));
    const id = randomUUID();
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web", baseUrl: `browser://compact-failed-${id}`,
      chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
        brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true, solAvailable: true, proAvailable: true },
    };
    const raw = { model: "gpt-5.6-sol", stream: true, reasoning: { effort: "max" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: id }) },
      input: [
        { type: "message", role: "user", content: "Save once, then inspect", internal_chat_message_metadata_passthrough: { turn_id: id } },
        { type: "function_call", call_id: "call_saved", name: "exec_command", arguments: '{"cmd":"save-once"}' },
        { type: "function_call_output", call_id: "call_saved", output: "saved once" },
      ],
    };
    const parsed = parseRequest(raw);
    const namespace = chatGptWebExecutionNamespace(provider);
    const key = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
    const failure = scenario === "other-error" ? chatGptStoppedThinkingError() : chatGptFailedThinkingError();
    let releases = 0;
    const source = chatGptTurnSessions.getOrCreate(key, () => ({
      mode: "read-only", browser: Promise.reject(failure), physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), usageInput: parsed,
      submission: { phase: "accepted" }, conversationKey: chatGptConversationKey(parsed, namespace),
      releaseRetainedConversation: async () => { releases++; }, cancel() {},
    }));
    const result = parsed.context.messages.find(message => message.role === "toolResult")!;
    if (result.role !== "toolResult") throw new Error("Missing result fixture");
    source.setOutstanding([{ callId: "call_saved", wireName: "exec_command", freeform: false, arguments: { cmd: "save-once" } }]);
    source.markResultDelivered("call_saved", nativeToolResultProof(result));
    await source.browserOutcome;
    if (scenario === "cancelled") source.cancel();
    if (scenario === "superseded") source.supersededError = chatGptTurnSupersededError();
    if (scenario === "missing-history") raw.input.pop();
    if (scenario === "changed-history") raw.input.at(-1)!.output = "different";
    const compact = parseRequest(raw); compact._compactionRequest = true;
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const original = worker.run;
    let freshStarts = 0;
    worker.run = async turn => {
      // A failed retained source/handoff must surface its original cause before rebuilding.
      if (turn.requireRetainedConversation) throw failure;
      freshStarts++;
      expect(releases).toBe(1);
      expect(turn.compaction).toBeTrue();
      expect(turn.capabilities.localToolsEnabled).toBeFalse();
      const prepared = await turn.prepare();
      expect(prepared.text).toContain("saved once");
      prepared.release();
      if (scenario === "second-failure") throw chatGptFailedThinkingError();
      return "Saved once; inspect next.";
    };
    const adapter = createChatGptWebAdapter(provider);
    const run = async () => {
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(compact, { headers: new Headers() }, event => events.push(event));
      return events;
    };
    try {
      const results = await Promise.all([run(), run()]);
      const again = await run();
      for (const events of [...results, again]) {
        expect(events.at(-1)).toMatchObject(scenario === "recover"
          ? { type: "done", endTurn: true }
          : { type: "error", code: failure.code, retryable: false });
      }
      expect(freshStarts).toBe(scenario === "recover" || scenario === "second-failure" ? 1 : 0);
      expect(releases).toBe(1);
    } finally {
      worker.run = original;
      await chatGptTurnSessions.retireAndWait(key);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
