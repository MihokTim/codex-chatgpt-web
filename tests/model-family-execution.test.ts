import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";
import { defaultConfig } from "../src/config";
import { chatGptTurnExecutionKey, chatGptTurnRoundKey } from "../src/adapters/chatgpt-web/turn-execution";
import { isAcceptedCompactionContinuation, rememberCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import { encodeCompactionSummary } from "../src/responses/compaction";

function routed(model: string) {
  const parsed = parseRequest({
    model, reasoning: { effort: "max" }, stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "family-task", turn_id: "family-turn" }) },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue the task" }],
      internal_chat_message_metadata_passthrough: { turn_id: "family-turn" } }],
  });
  routeChatGptWebRequest(parsed, { ...defaultConfig("browser-only"), proAvailable: true });
  return parsed;
}

test("named Pro models share a backend but never execution or round replay keys", () => {
  const v56 = routed("chatgpt-web/gpt-5.6-pro");
  const v6 = routed("chatgpt-web/gpt-6-pro");
  expect(v56.modelId).toBe(v6.modelId);
  expect(v56.options.reasoning).toBe(v6.options.reasoning);
  expect(chatGptTurnExecutionKey(v56)).not.toBe(chatGptTurnExecutionKey(v6));
  expect(chatGptTurnRoundKey(v56)).not.toBe(chatGptTurnRoundKey(v6));
  expect(chatGptTurnExecutionKey(v6)).toBe(chatGptTurnExecutionKey(routed("chatgpt-web/gpt-6-pro")));
});

test("a completed checkpoint only authenticates continuations of its producing model family", () => {
  const v56 = routed("chatgpt-web/gpt-5.6-pro");
  const v6 = routed("chatgpt-web/gpt-6-pro");
  const identity = { threadId: "family-task", turnId: "family-turn" };
  const source = { turnId: "family-turn", content: [{ type: "input_text", text: "Continue the task" }] };
  const summary = "A completed checkpoint from GPT-5.6 Pro";
  rememberCompactionContinuation({ ...v56, _compactionRequest: true }, identity, [source], summary);
  for (const parsed of [v56, v6]) parsed._rawBody = {
    input: [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
  };
  expect(isAcceptedCompactionContinuation(v56, identity, source)).toBe(true);
  expect(isAcceptedCompactionContinuation(v6, identity, source)).toBe(false);
});
