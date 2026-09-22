import { expect, test } from "bun:test";
import { HttpTurnCounter, responseRequest } from "../src/server";
import { defaultConfig } from "../src/config";

test.each(["win32", "darwin"] as const)("%s records a source failure separately from client abort with bounded metadata", async platform => {
  const records: Record<string, unknown>[] = [];
  const turns = new HttpTurnCounter(() => {}, record => records.push(record));
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(async (_signal, identity, diagnostics) => {
    identity({ threadId: "native_thread", turnId: "native_turn" });
    diagnostics.bindRoute("chatgpt-web/light", "abcdef123456");
    diagnostics.adapter({ type: "text_delta", text: "PRIVATE ANSWER" });
    return new Response(new ReadableStream({ start(controller) { source = controller; } }));
  }, undefined, platform, "responses");
  const reader = response.body!.getReader();
  source.enqueue(new TextEncoder().encode("private wire payload"));
  await reader.read();
  source.error(new Error("PRIVATE EXCEPTION"));
  await expect(reader.read()).rejects.toThrow("PRIVATE EXCEPTION");
  await Bun.sleep(10);
  expect(turns.count()).toBe(0);
  expect(records.filter(r => r.phase === "end")).toHaveLength(1);
  expect(records.at(-1)).toMatchObject({ reason: "source_error", modelRoute: "chatgpt-web/light",
    traceId: "abcdef123456", threadId: "native_thread", turnId: "native_turn", chunks: 1,
    clientAborted: false, nativeReceiptConfirmed: false, adapterCounts: { text_delta: 1 } });
  expect(JSON.stringify(records)).not.toMatch(/PRIVATE|private wire/);
});

test.each(["win32", "darwin"] as const)("%s records request disconnect before release without exposing abort reason", async platform => {
  const records: Record<string, unknown>[] = [];
  const turns = new HttpTurnCounter(() => {}, record => records.push(record));
  const client = new AbortController();
  const response = await turns.track(async () => new Response(new ReadableStream()), client.signal, platform, "responses");
  client.abort("PRIVATE ABORT REASON");
  await Bun.sleep(10);
  expect(response.body).not.toBeNull();
  expect(turns.count()).toBe(0);
  expect(records.filter(r => r.phase === "client_abort_signal")).toHaveLength(1);
  expect(records.at(-1)).toMatchObject({ phase: "end", reason: "aborted", clientAborted: true });
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
});

test("actual response handler links terminal failure and HTTP replay to the same trace and distinct requests", async () => {
  const records: Record<string, unknown>[] = [];
  const turns = new HttpTurnCounter(() => {}, record => records.push(record));
  const config = { ...defaultConfig("browser-only"), proAvailable: true };
  let executions = 0;
  const request = () => new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    model: "chatgpt-web/light", stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "diagnostic_thread", turn_id: "diagnostic_turn" }) },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE PROMPT" }], internal_chat_message_metadata_passthrough: { turn_id: "diagnostic_turn" } }],
  }) });
  const send = () => turns.track((signal, onTurnIdentity, diagnostics) => responseRequest(new Request(request(), { signal }), config, () => ({
    name: "diagnostic-test", async runTurn(_parsed, _request, emit) {
      executions++;
      emit({ type: "heartbeat" });
      emit({ type: "error", message: "PRIVATE DIAGNOSTIC FAILURE", status: 502, code: "chatgpt_turn_identity_conflict", errorType: "upstream_error", retryable: false });
    },
  }), { onTurnIdentity, diagnostics }), undefined, "win32", "responses");
  const first = await send();
  expect(await first.text()).toContain("PRIVATE DIAGNOSTIC FAILURE");
  const retry = await send();
  expect(retry.status).toBe(400);
  await retry.text();
  await Bun.sleep(10);
  expect(executions).toBe(1);
  const ends = records.filter(r => r.phase === "end");
  expect(ends).toHaveLength(2);
  expect(ends[0]).toMatchObject({ httpTurnId: 1, sseTerminal: "failed", errorCode: "chatgpt_turn_identity_conflict", originalStatus: 502 });
  expect(ends[1]).toMatchObject({ httpTurnId: 2, httpStatus: 400, traceId: ends[0]!.traceId });
  expect(records.some(r => r.phase === "terminal_failure_replay")).toBeTrue();
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
});

test("Windows source completion never asserts native receipt, even if the client has not read yet", async () => {
  const records: Record<string, unknown>[] = [];
  const turns = new HttpTurnCounter(() => {}, record => records.push(record));
  const response = await turns.track(async () => new Response("not-yet-read"), undefined, "win32", "responses");
  await Bun.sleep(10);
  expect(records.at(-1)).toMatchObject({ phase: "end", reason: "source_eof", nativeReceiptConfirmed: false });
  expect(await response.text()).toBe("not-yet-read");
});

test("a throwing lifecycle diagnostic sink cannot change a successful response", async () => {
  const turns = new HttpTurnCounter(() => {}, () => { throw new Error("broken sink"); });
  const response = await turns.track(async () => new Response("ok"), undefined, "darwin", "responses");
  expect(await response.text()).toBe("ok");
  expect(turns.count()).toBe(0);
});
