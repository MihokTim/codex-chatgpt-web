import { expect, test } from "bun:test";
import { TerminalFailureReplays } from "../src/responses/terminal-failure-replay";
import { defaultConfig, providerConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { ChatGptBrowserWorker, chatGptAssistantIdentityAfterUser, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent } from "../src/types";

const terminal: AdapterEvent = {
  type: "error", message: "Observation failed", status: 502,
  errorType: "server_error", code: "chatgpt_submitted_turn_failed", retryable: false,
};

test("terminal replay requires explicit failure classification and expires without retaining request bodies", async () => {
  let now = 1_000;
  const cache = new TerminalFailureReplays(100, 2, () => now);
  cache.remember(undefined, terminal);
  cache.remember("transient", { ...terminal, retryable: true });
  cache.remember("unknown", { type: "error", message: "Unknown" });
  cache.remember("done", { type: "done", stopReason: "stop" });
  for (const key of [undefined, "transient", "unknown", "done"]) expect(cache.response(key)).toBeUndefined();
  cache.remember("first", terminal);
  expect(cache.response("first")?.status).toBe(400);
  expect(await cache.response("first")!.json()).toEqual({ error: {
    type: "server_error", code: terminal.code, message: terminal.message, original_status: 502, retryable: false,
  } });
  cache.remember("second", terminal);
  cache.remember("third", terminal);
  expect(cache.response("first")).toBeUndefined();
  now = 1_100;
  expect(cache.response("second")).toBeUndefined();
  expect(cache.response("third")).toBeUndefined();
});

function body(thread: string, turn: string, model = "chatgpt-web/pro") {
  return {
    model, stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Test terminal failure" }],
      internal_chat_message_metadata_passthrough: { turn_id: turn } }],
  };
}
const request = (value: unknown) => new Request("http://127.0.0.1/v1/responses", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});

test.each(["submitted", "selection", "identity"])("production adapter stops retries after a %s failure without resubmitting", async kind => {
  const config = defaultConfig("browser-only");
  config.proAvailable = true;
  const worker = ChatGptBrowserWorker.forProvider(providerConfig(config));
  const originalRun = worker.run;
  let starts = 0;
  worker.run = async (turn: BrowserTurn) => {
    starts++;
    if (kind === "selection") throw new ChatGptWebAdapterError("Model controls are unavailable", { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false });
    await turn.onSendActivated?.();
    turn.onSubmitted?.();
    if (kind === "identity") chatGptAssistantIdentityAfterUser({
      turnIdentities: ["submitted-user", "remounted-answer", "replacement-answer"],
      userIdentities: ["submitted-user"],
      responseIdentities: ["remounted-answer", "replacement-answer"],
    }, "submitted-user");
    throw new Error("ChatGPT exposed 2 new conversation turns for one submitted message");
  };
  const input = body(`terminal_${kind}`, `turn_${kind}`);
  try {
    const first = await responseRequest(request(input), config);
    expect(first.status).toBe(200);
    const sse = await first.text();
    expect(sse).toContain("response.failed");
    expect(sse).not.toContain("response.completed");
    const code = kind === "submitted" ? "chatgpt_submitted_turn_failed"
      : kind === "selection" ? "upstream_server_error" : "chatgpt_turn_identity_conflict";
    expect(sse).toContain(code);
    const replay = await responseRequest(request(input), config, () => { throw new Error("Replay must stop before adapter construction"); });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code, retryable: false, original_status: 502 } });
    expect(starts).toBe(1);
    // A new user turn on the same task may proceed normally.
    worker.run = async turn => { starts++; turn.onTextDelta("new turn succeeds"); return "new turn succeeds"; };
    const next = await responseRequest(request(body(`terminal_${kind}`, `turn_${kind}_next`)), config);
    expect(await next.text()).toContain("response.completed");
    expect(starts).toBe(2);
  } finally {
    worker.run = originalRun;
    chatGptTurnSessions.clear();
  }
});

test("terminal replay is scoped to provider, route, native task, turn and canonical instruction", async () => {
  const config = defaultConfig("browser-only");
  config.proAvailable = true;
  const input = body("scope_thread", "scope_turn");
  let starts = 0;
  const adapter = () => ({ name: "test", runTurn: async (_parsed: unknown, _incoming: unknown, emit: (event: AdapterEvent) => void) => {
    starts++; emit(terminal);
  } });
  await (await responseRequest(request(input), config, adapter)).text();
  // Native reconnects may include commentary or a tool result that was emitted before failure.
  for (const suffix of [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Previously emitted commentary" }] },
    { type: "function_call_output", call_id: "call_test", output: "already completed tool result" },
  ]) {
    expect((await responseRequest(request({ ...input, input: [...input.input, suffix] }), config, adapter)).status).toBe(400);
  }
  const newInstruction = body("scope_thread", "scope_turn");
  newInstruction.input[0]!.content[0]!.text = "A new explicit user instruction";
  const variants = [body("other_thread", "scope_turn"), body("scope_thread", "other_turn"),
    body("scope_thread", "scope_turn", "chatgpt-web/light"),
    newInstruction,
  ];
  for (const variant of variants) {
    expect((await responseRequest(request(variant), config, adapter)).status).toBe(200);
  }
  expect((await responseRequest(request(input), { ...config, experimentalBiggerContext: true }, adapter)).status).toBe(200);
  expect(starts).toBe(6);
});

test("a retryable provider failure still starts a fresh browser and can recover", async () => {
  const config = defaultConfig("browser-only");
  config.proAvailable = true;
  const worker = ChatGptBrowserWorker.forProvider(providerConfig(config));
  const originalRun = worker.run;
  let starts = 0;
  worker.run = async turn => {
    if (++starts === 1) throw new ChatGptWebAdapterError("Temporarily busy", {
      status: 503, errorType: "server_error", code: "server_is_overloaded", retryable: true,
    });
    turn.onTextDelta("Recovered");
    return "Recovered";
  };
  try {
    const input = body("retryable_thread", "retryable_turn");
    expect(await (await responseRequest(request(input), config)).text()).toContain("server_is_overloaded");
    const second = await responseRequest(request(input), config);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("response.completed");
    expect(starts).toBe(2);
  } finally { worker.run = originalRun; chatGptTurnSessions.clear(); }
});
