import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeCodexRetryInstruction } from "../src/adapters/chatgpt-web/codex-rollout-environment";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { parseRequest } from "../src/responses/parser";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const threadId = "01a0d366-51ab-7820-89aa-d33a3713f8e6";
const sourceTurn = "01a0d393-99fa-7181-9008-a806950fb67a";
const retryTurn = "01a0d3c4-e63e-74e0-a5f6-5e5798d04f09";
const interimTurn = "01a0d3c3-bc03-7f82-8ce3-0171eb892000";
const cwd = resolve(process.cwd());
const event = (type: string, turn_id: string, more = {}) => ({ type: "event_msg", payload: { type, turn_id, ...more } });
const context = (turn_id: string) => ({ type: "turn_context", payload: {
  turn_id, cwd, workspace_roots: [cwd], sandbox_policy: { type: "danger-full-access" },
  permission_profile: { type: "disabled" },
} });
const failed = (turn: string) => event("task_complete", turn, {
  error: { message: "Selected model is at capacity. Please try a different model.", codex_error_info: "server_overloaded" },
});

function fixture() {
  const codexHome = mkdtempSync(join(tmpdir(), "cgw-native-retry-"));
  roots.push(codexHome);
  const rollout = join(codexHome, "sessions", "2026", "09", "24", `rollout-2026-09-24T21-31-33-${threadId}.jsonl`);
  mkdirSync(dirname(rollout), { recursive: true });
  const instruction = {
    type: "message", role: "user", id: "msg_original", content: [{ type: "input_text", text: "Continue the repair" }],
    internal_chat_message_metadata_passthrough: { turn_id: sourceTurn },
  };
  const wire = {
    model: "chatgpt-web/pro", stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn", thread_id: threadId, turn_id: retryTurn, sandbox: "none", workspaces: { [cwd]: {} },
    }) },
    input: [structuredClone(instruction)],
  };
  const rows: any[] = [
    { type: "session_meta", payload: { id: threadId, source: "vscode" } },
    event("task_started", sourceTurn), context(sourceTurn), { type: "response_item", payload: instruction },
    { type: "response_item", payload: { type: "function_call", name: "read_file", arguments: "{}", call_id: "read" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: "already read" } },
    failed(sourceTurn), event("task_started", retryTurn), context(retryTurn),
  ];
  const save = () => writeFileSync(rollout, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  save();
  return { codexHome, rollout, wire, rows, save, instruction };
}

test("a native failed-task retry rebinds only the verified instruction and keeps a new execution identity", () => {
  const f = fixture();
  const request = parseRequest(f.wire);
  expect(() => extractChatGptTurnUserRevision(request)).toThrow("conflicts");
  expect(normalizeCodexRetryInstruction(request, f.codexHome)).toBe(true);
  expect(extractChatGptTurnUserRevision(request)).toEqual(f.instruction.content);
  expect(f.wire.input[0]!.internal_chat_message_metadata_passthrough.turn_id).toBe(sourceTurn);
  const prior = parseRequest({ ...f.wire, client_metadata: { "x-codex-turn-metadata": JSON.stringify({
    request_kind: "turn", thread_id: threadId, turn_id: sourceTurn, sandbox: "none",
  }) } });
  expect(chatGptTurnExecutionKey(request)).not.toBe(chatGptTurnExecutionKey(prior));
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome).resolve(request).cwd).toBe(cwd);
  expect(normalizeCodexRetryInstruction(request, f.codexHome)).toBe(false);
});

test.each([false, true])("adjacent failed retries can carry the same original instruction (old bridge conflict=%s)", conflict => {
  const f = fixture();
  const outcome = conflict ? event("task_complete", interimTurn, { error: {
    codex_error_info: "other", message: JSON.stringify({ error: {
      message: "ChatGPT web current user message conflicts with native Codex turn_id metadata",
    } }),
  } }) : failed(interimTurn);
  f.rows.splice(-2, 0, event("task_started", interimTurn), context(interimTurn), outcome);
  f.save();
  expect(normalizeCodexRetryInstruction(parseRequest(f.wire), f.codexHome)).toBe(true);
});

test("HTTP retry authenticates native history before constructing the adapter", () => {
  const f = fixture();
  const script = `
    import { strict as assert } from "node:assert";
    import { responseRequest } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
    import { defaultConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
    import { extractChatGptTurnUserRevision } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/environment.ts", import.meta.url).href)};
    const config = defaultConfig("browser-only");
    config.proAvailable = true;
    let starts = 0;
    const wire = ${JSON.stringify(f.wire)};
    const request = () => new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify(wire), headers: { "content-type": "application/json" },
    });
    const adapter = () => ({ name: "retry-test", runTurn: async (parsed, _incoming, emit) => {
      starts++;
      assert.deepEqual(extractChatGptTurnUserRevision(parsed), wire.input[0].content);
      emit({ type: "text_delta", text: "resumed" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } });
    const response = await responseRequest(request(), config, adapter, { rememberState: false });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "completed");
    assert.equal(starts, 1);
    wire.input[0].content[0].text = "unproven replacement";
    assert.equal((await responseRequest(request(), config, adapter)).status, 400);
    assert.equal(starts, 1);
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    env: { ...process.env, CODEX_HOME: f.codexHome, CODEX_SQLITE_HOME: f.codexHome },
    encoding: "utf8", timeout: 15_000,
  });
  expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
});

test.each(["success", "aborted", "active-source", "changed-content", "different-item", "newer-instruction",
  "other-thread", "wrong-current-turn", "already-completed", "missing-start", "unrelated-failure", "duplicate-item",
  "wrong-source-turn", "compaction"])("native retry rejects %s", mutation => {
  const f = fixture();
  if (mutation === "success") f.rows[6] = event("task_complete", sourceTurn, { error: null });
  if (mutation === "aborted") f.rows.splice(6, 0, event("turn_aborted", sourceTurn));
  if (mutation === "active-source") f.rows.splice(6, 1);
  if (mutation === "changed-content") f.wire.input[0]!.content[0]!.text = "Run a different command";
  if (mutation === "different-item") f.wire.input[0]!.id = "msg_another";
  if (mutation === "newer-instruction") f.rows.splice(6, 0, { type: "response_item", payload: {
    ...f.instruction, id: "msg_newer", content: "Changed instruction",
  } });
  if (mutation === "other-thread") f.rows[0].payload.id = interimTurn;
  if (mutation === "wrong-current-turn") f.rows.at(-1).payload.turn_id = interimTurn;
  if (mutation === "already-completed") f.rows.push(failed(retryTurn));
  if (mutation === "missing-start") f.rows.splice(-2, 1);
  if (mutation === "unrelated-failure") f.rows[6].payload.error.codex_error_info = "other";
  if (mutation === "duplicate-item") f.wire.input.push(structuredClone(f.wire.input[0]!));
  if (mutation === "wrong-source-turn") f.wire.input[0]!.internal_chat_message_metadata_passthrough.turn_id = interimTurn;
  f.save();
  const request = parseRequest(f.wire);
  if (mutation === "compaction") request._compactionRequest = true;
  expect(normalizeCodexRetryInstruction(request, f.codexHome)).toBe(false);
  expect(() => extractChatGptTurnUserRevision(request)).toThrow("conflicts");
});
