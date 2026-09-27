import { expect, test } from "bun:test";
import { requestPreparationProgress } from "../src/adapters/chatgpt-web/request-progress";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

test("normal task waits report the retry time once and report resumption without claiming a send", () => {
  const messages: string[] = [];
  const stages: string[] = [];
  const progress = requestPreparationProgress(text => messages.push(text), stage => stages.push(stage), () => 1_000);
  progress("send");
  progress("request_wait", 2_500); // ordinary send spacing is silent
  expect(messages).toEqual([]);
  progress("request_wait", 301_000);
  progress("request_wait", 301_000);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(new Date(301_000).toLocaleTimeString("ja-JP"));
  progress("request_wait", 331_000); // a genuine extension is reported
  progress("send");
  progress("file_attachment");
  expect(messages).toHaveLength(3);
  expect(messages[2]).toContain("送信準備を再開");
  expect(stages).toHaveLength(7);
});

test("compaction progress hooks still receive scheduler deadlines even when nothing is announced", () => {
  const received: Array<[string, number | undefined]> = [];
  const progress = requestPreparationProgress(() => {}, (stage, until) => received.push([stage, until]), () => 0);
  progress("request_wait", 600_000);
  progress("request_wait", 600_000);
  progress("send");
  expect(received).toEqual([["request_wait", 600_000], ["request_wait", 600_000], ["send", undefined]]);
});

test("a normal non-compaction turn streams its wait status through the adapter", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: "browser://request-progress-fixture",
    chatgptWeb: { localToolsEnabled: false, solAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const original = worker.run;
  worker.run = async (turn: BrowserTurn) => {
    expect(turn.compaction).not.toBe(true);
    expect(turn.onPreparationProgress).toBeDefined();
    await turn.onPreparationProgress!("request_wait", Date.now() + 300_000);
    await turn.onPreparationProgress!("send");
    turn.onTextDelta("ready");
    return "ready";
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!({
      modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
      context: { messages: [{ role: "user", content: "request progress regression", timestamp: 1 }] },
      _rawBody: { input: [{ type: "message", role: "user",
        content: [{ type: "input_text", text: "request progress regression" }],
        internal_chat_message_metadata_passthrough: { turn_id: "request-progress-turn" },
      }], client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "request-progress-thread", turn_id: "request-progress-turn",
      }) } },
    }, { headers: new Headers() }, event => events.push(event));
    const status = events.filter(event => event.type === "text_delta" && event.phase === "commentary"
      && event.text.startsWith("ChatGPTへの送信準備"));
    expect(status).toHaveLength(2);
    expect(status[0]).toMatchObject({ type: "text_delta", text: expect.stringContaining("次の試行予定") });
    expect(status[1]).toMatchObject({ type: "text_delta", text: expect.stringContaining("再開しました") });
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally { worker.run = original; }
});
