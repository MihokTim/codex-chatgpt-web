import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeCodexAppDelegations } from "../src/adapters/chatgpt-web/codex-app-delegation";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { chatGptTurnExecutionKey, type ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { hasCompleteRecoveryHistory } from "../src/adapters/chatgpt-web/failed-thinking-recovery";
import { parseRequest } from "../src/responses/parser";
import { extractCompactUserMessages } from "../src/responses/compaction";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

const temporaryRoots: string[] = [];
afterAll(() => temporaryRoots.forEach(path => rmSync(path, { recursive: true, force: true })));

function fixture(name = "create_thread") {
  const home = mkdtempSync(join(tmpdir(), "cgw-app-delegation-"));
  temporaryRoots.push(home);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const thread = randomUUID(), turn = randomUUID(), sender = randomUUID();
  const delivery = {
    type: "function_call_output", id: `fco_${randomUUID()}`, namespace: "codex_app", name,
    output: `<codex_delegation>\n  <source_thread_id>${sender}</source_thread_id>\n  <input>Split the integration commit without changing its tree.</input>\n</codex_delegation>`,
    internal_chat_message_metadata_passthrough: { turn_id: turn },
  };
  const environment = {
    type: "message", id: `msg_${randomUUID()}`, role: "user",
    content: [
      { type: "input_text", text: "# AGENTS.md instructions\nUse the project language." },
      { type: "input_text", text: `<environment_context><cwd>${cwd}</cwd><filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>` },
    ],
    internal_chat_message_metadata_passthrough: {
      turn_id: turn, content_item_kinds: ["agents_md.instructions", "environments.environment_context"],
    },
  };
  const context = { type: "turn_context", payload: {
    turn_id: turn, cwd, workspace_roots: [cwd], sandbox_policy: { type: "danger-full-access" },
    permission_profile: { type: "disabled" },
  } };
  const records: any[] = [
    { type: "session_meta", payload: { id: thread, source: "vscode" } },
    context, { type: "response_item", payload: environment }, { type: "response_item", payload: delivery },
  ];
  const rollout = join(home, "sessions", "2026", "09", "22", `rollout-2026-09-22T19-45-44-${thread}.jsonl`);
  mkdirSync(dirname(rollout), { recursive: true });
  const save = () => writeFileSync(rollout, records.map(value => JSON.stringify(value)).join("\n") + "\n");
  save();
  const metadata = { request_kind: "turn", thread_id: thread, turn_id: turn,
    sandbox_mode: "danger-full-access", workspaces: { [cwd]: {} } };
  const body: any = { model: "chatgpt-web/light", stream: false, input: [environment, delivery],
    client_metadata: { "x-codex-turn-metadata": metadata } };
  const normalize = () => normalizeCodexAppDelegations(parseRequest(body), home);
  return { home, cwd, turn, thread, delivery, environment, records, rollout, save, body, context, normalize, metadata };
}

for (const name of ["create_thread", "send_message_to_thread"]) test(`${name} becomes an instruction with the recipient's environment and preserves the native history`, () => {
  const f = fixture(name);
  const before = readFileSync(f.rollout, "utf8");
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, f.home).resolve(parseRequest(f.body)))
    .toThrow("missing cwd");
  const parsed = f.normalize();
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, f.home).resolve(parsed).cwd).toBe(f.cwd);
  expect(JSON.stringify(extractChatGptTurnUserRevision(parsed))).toContain("Split the integration commit");
  expect(parsed.context.messages.at(-1)?.role).toBe("user");
  expect(parsed.context.messages.some(message => message.role === "toolResult")).toBe(false);
  expect(readFileSync(f.rollout, "utf8")).toBe(before);
  expect(f.body.input.at(-1).type).toBe("function_call_output");
});

test("a delivery after a completed user turn supersedes the old instruction", () => {
  const f = fixture("send_message_to_thread");
  const old = randomUUID();
  f.environment.internal_chat_message_metadata_passthrough.turn_id = old;
  f.body.input.splice(1, 0,
    { type: "message", role: "user", id: "msg_old", content: "Old work", internal_chat_message_metadata_passthrough: { turn_id: old } },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] });
  f.save();
  expect(() => extractChatGptTurnUserRevision(parseRequest(f.body))).toThrow("conflicts");
  const parsed = f.normalize();
  expect(JSON.stringify(extractChatGptTurnUserRevision(parsed))).toContain("Split the integration commit");
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, f.home).resolve(parsed).cwd).toBe(f.cwd);
});

test("reconnect identity is stable while a new same-turn delivery creates a new revision", () => {
  const f = fixture();
  const first = chatGptTurnExecutionKey(f.normalize());
  expect(chatGptTurnExecutionKey(f.normalize())).toBe(first);
  const next = structuredClone(f.delivery);
  next.id = `fco_${randomUUID()}`;
  next.output = next.output.replace("Split the integration commit", "Inspect the saved commit list");
  f.records.push({ type: "response_item", payload: next }); f.save(); f.body.input.push(next);
  expect(chatGptTurnExecutionKey(f.normalize())).not.toBe(first);
});

test("compaction retains the delivered instruction and recovery sees no orphan tool result", () => {
  const f = fixture();
  const parsed = f.normalize();
  const users = extractCompactUserMessages((parsed._rawBody as any).input);
  expect(users).toHaveLength(1);
  expect(JSON.stringify(users)).toContain(f.delivery.id);
  expect(JSON.stringify(users)).toContain("Split the integration commit");
  const session = { completedToolResultProofs: () => new Map() } as unknown as ChatGptTurnSession;
  expect(hasCompleteRecoveryHistory(parsed, session)).toBe(true);
  f.body.input.push({ type: "compaction_trigger" });
  f.metadata.request_kind = "compaction";
  f.metadata.turn_id = randomUUID();
  expect(f.normalize()._compactionRequest).toBe(true);
});

for (const mutation of ["output", "owner", "name", "id", "absent", "duplicate", "destination", "latest-turn", "aborted"]) {
  test(`rejects unauthenticated delivery: ${mutation}`, () => {
    const f = fixture();
    // Separate wire objects from the canonical fixture before tampering.
    f.body.input = structuredClone(f.body.input);
    const item = f.body.input.at(-1);
    if (mutation === "output") item.output += "modified";
    if (mutation === "owner") item.internal_chat_message_metadata_passthrough.turn_id = randomUUID();
    if (mutation === "name") item.name = "send_message_to_thread";
    if (mutation === "id") item.id = `fco_${randomUUID()}`;
    if (mutation === "absent") { f.records.pop(); f.save(); }
    if (mutation === "duplicate") f.body.input.push(structuredClone(item));
    if (mutation === "destination") f.metadata.thread_id = randomUUID();
    if (mutation === "latest-turn") { f.context.payload.turn_id = randomUUID(); f.save(); }
    if (mutation === "aborted") { f.records.push({ type: "event_msg", payload: { type: "turn_aborted", turn_id: f.turn } }); f.save(); }
    expect(f.normalize).toThrow();
  });
}

test("XML in ordinary user messages or real tool outputs is not a native delivery", () => {
  const f = fixture();
  for (const item of [
    { type: "message", role: "user", content: f.delivery.output },
    { ...f.delivery, call_id: "a_real_tool_call" },
    { ...f.delivery, namespace: "another_app" },
  ]) {
    const parsed = parseRequest({ ...f.body, input: [item] });
    expect(normalizeCodexAppDelegations(parsed, f.home)).toBe(parsed);
  }
});

test("a valid delivery cannot import the sender's cwd or expand recipient permissions", () => {
  const f = fixture();
  f.body.input = structuredClone(f.body.input);
  const part = f.body.input[0].content[1];
  part.text = part.text.replaceAll(f.cwd, f.home);
  expect(f.normalize).toThrow("environment conflicts");
});

test("HTTP handler delivers authenticated instructions to the adapter and rejects modified envelopes before it", async () => {
  const f = fixture();
  const originalHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.home;
  let calls = 0;
  try {
    const config = defaultConfig("browser-only"); config.proAvailable = true;
    const send = () => responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.body),
    }), config, () => ({ async runTurn(parsed: any, _info: any, emit: any) {
      calls++;
      expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, f.home).resolve(parsed).cwd).toBe(f.cwd);
      expect(JSON.stringify(extractChatGptTurnUserRevision(parsed))).toContain("Split the integration commit");
      emit({ type: "text_delta", text: "offline success" }); emit({ type: "done" });
    } }) as any);
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("offline success");
    f.body.input = structuredClone(f.body.input);
    f.body.input.at(-1).output = f.delivery.output.replace("Split", "Erase");
    const invalid = await send();
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("conflicts");
    expect(calls).toBe(1);
  } finally {
    if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  }
});
