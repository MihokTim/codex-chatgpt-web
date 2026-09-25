import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSupersededError } from "../src/adapters/chatgpt-web/adapter-error";
import { cancelStructuredCompactionNativeTurn } from "../src/adapters/chatgpt-web/compaction-handoff";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

for (const scenario of ["exhaustion", "native-cancel"] as const) {
  test(`preparation retries stay bounded and stop on owner cancellation: ${scenario}`, async () => {
    const id = randomUUID();
    const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://prep-${id}`,
      chatgptWeb: { localToolsEnabled: false, solAvailable: true } };
    const parsed = parseRequest({ model: "gpt-5.6-sol", stream: true, reasoning: { effort: "high" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: id }) },
      input: [{ type: "message", role: "user", content: "Only answer after preparation succeeds.",
        internal_chat_message_metadata_passthrough: { turn_id: id } }],
    });
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const original = worker.run;
    let starts = 0;
    let markStarted!: () => void;
    const started = new Promise<void>(done => { markStarted = done; });
    worker.run = async () => { starts++; markStarted(); throw new Error("ChatGPT browser stage timed out: browser_page"); };
    const adapter = createChatGptWebAdapter(provider);
    const events: AdapterEvent[] = [];
    try {
      const running = adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
      await started;
      if (scenario === "native-cancel") {
        await cancelStructuredCompactionNativeTurn(id, id, chatGptTurnSupersededError());
        await expect(running).rejects.toMatchObject({ code: "client_cancelled" });
        expect(starts).toBe(1);
      } else {
        await running;
        expect(starts).toBe(4);
        expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
        const replay: AdapterEvent[] = [];
        await adapter.runTurn!(parsed, { headers: new Headers() }, event => replay.push(event));
        expect(replay.at(-1)).toMatchObject({ type: "error", retryable: false });
        expect(starts).toBe(4);
      }
    } finally {
      worker.run = original;
      await chatGptTurnSessions.retireAndWait(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`);
    }
  }, 8_000);
}
