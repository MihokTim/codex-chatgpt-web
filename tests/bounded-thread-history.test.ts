import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedThreadHistory, HISTORY_REPLY_BYTES } from "../scripts/bounded-thread-history";
import { readFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { patchHistoryServer } from "../scripts/install-history-read-guard";

function fixture(items: Record<string, unknown>[][]) {
  const home = mkdtempSync(join(tmpdir(), "bounded-history-test-"));
  const rollout = join(home, "fixture.jsonl"); writeFileSync(rollout, "synthetic");
  const state = new Database(join(home, "state_5.sqlite"));
  state.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,preview TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,rollout_path TEXT,history_mode TEXT)");
  state.query("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run("test-thread", "Synthetic", "Title", "preview", home, 1, 2, rollout, "paginated"); state.close();
  const db = new Database(join(home, "thread_history_1.sqlite"));
  db.exec("CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,started_at INTEGER,completed_at INTEGER,duration_ms INTEGER,error_json TEXT,PRIMARY KEY(thread_id,turn_id));CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_type TEXT,rollout_ordinal INTEGER,item_json TEXT,PRIMARY KEY(thread_id,turn_id,item_id));CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_byte_offset INTEGER)");
  db.query("INSERT INTO thread_history_projection_state VALUES(?,?)").run("test-thread", statSync(rollout).size);
  for (let i = 0; i < items.length; i++) {
    db.query("INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?)").run("test-thread", `turn-${i}`, i, "completed", 1, 2, 1, null);
    for (let j = 0; j < items[i]!.length; j++) {
      const item = { id: `item-${i}-${j}`, ...items[i]![j] };
      db.query("INSERT INTO thread_items VALUES(?,?,?,?,?,?)").run("test-thread", `turn-${i}`, item.id, String((item as any).type), j, JSON.stringify(item));
    }
  }
  db.close();
  return { home, close: () => rmSync(home, { recursive: true, force: true }) };
}

test("media result is omitted before IPC regardless of includeOutputs; saved path survives", () => {
  const f = fixture([[{ type: "imageGeneration", result: "BLOB-SENTINEL".repeat(100000), status: "completed", savedPath: "C:/art/result.png", revisedPrompt: "A fixture" }]]);
  try {
    for (const includeOutputs of [false, true]) {
      const result = boundedThreadHistory({ threadId: "test-thread", includeOutputs, maxOutputCharsPerItem: 1500 }, f.home)!;
      expect(result.turns[0].items[0].savedPath).toBe("C:/art/result.png");
      expect(result.turns[0].items[0].resultOmitted).toBe(true);
      expect(JSON.stringify(result)).not.toContain("BLOB-SENTINEL");
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(5000);
      expect(result.safety.projectionCaughtUp).toBe(true);
    }
  } finally { f.close(); }
});
test("paging uses guarded cursors and refuses cross-task or unknown anchors", () => {
  const f = fixture(Array.from({ length: 3 }, () => [{ type: "imageGeneration", result: "small", savedPath: "artifact.png" }]));
  try {
    const page = boundedThreadHistory({ threadId: "test-thread", turnLimit: 1 }, f.home)!;
    expect(page.turns[0].id).toBe("turn-2");
    const next = boundedThreadHistory({ threadId: "test-thread", cursor: page.page.nextCursor }, f.home)!;
    expect(next.turns[0].id).toBe("turn-1");
    expect(() => boundedThreadHistory({ threadId: "test-thread", cursor: "unknown" }, f.home)).toThrow("Unknown history cursor");
    const cursor = "bounded-history-v1:" + Buffer.from(JSON.stringify({ threadId: "another", turnId: "turn-1" })).toString("base64url");
    expect(() => boundedThreadHistory({ threadId: "test-thread", cursor }, f.home)).toThrow("another task");
  } finally { f.close(); }
});
test("small text-only local task and remote task pass through; cached results never claim live status", () => {
  const f = fixture([[{ type: "agentMessage", text: "Hello" }]]);
  try {
    expect(boundedThreadHistory({ threadId: "test-thread" }, f.home)).toBeNull();
    expect(boundedThreadHistory({ threadId: "test-thread", hostId: "remote" }, f.home)).toBeNull();
    expect(boundedThreadHistory({ threadId: "unknown" }, f.home)).toBeNull();
  } finally { f.close(); }
});
test("large user/agent text and tool outputs respect limits; inline media omitted", () => {
  const f = fixture([[{ type: "userMessage", content: [{ type: "text", text: "x".repeat(50000) }, { type: "image", url: "data:image/png;base64,PRIVATE-MEDIA" }] },
    { type: "agentMessage", text: "y".repeat(50000) }, { type: "commandExecution", aggregatedOutput: "OUTPUT-SENTINEL".repeat(4000), command: "test", status: "completed" }]]);
  try {
    const hidden = boundedThreadHistory({ threadId: "test-thread", includeOutputs: false, maxOutputCharsPerItem: 100 }, f.home)!;
    expect(hidden.turns[0].items[0].content[0].text.length).toBe(100);
    expect(hidden.turns[0].items[1].text.length).toBe(100);
    expect(JSON.stringify(hidden)).not.toContain("PRIVATE-MEDIA");
    expect(JSON.stringify(hidden)).not.toContain("OUTPUT-SENTINEL");
    expect(hidden.thread.status.type).toBe("unknown");
    const shown = boundedThreadHistory({ threadId: "test-thread", includeOutputs: true, maxOutputCharsPerItem: 100 }, f.home)!;
    expect(shown.turns[0].items[2].outputExcerpt.length).toBe(100);
  } finally { f.close(); }
});
test("total UTF-8 bytes and item count bounded under large pages", () => {
  const f = fixture(Array.from({ length: 10 }, () => Array.from({ length: 100 }, () => ({ type: "agentMessage", text: "日本語".repeat(1000) }))));
  try {
    const result = boundedThreadHistory({ threadId: "test-thread", turnLimit: 10, maxOutputCharsPerItem: 20000 }, f.home)!;
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(HISTORY_REPLY_BYTES);
    expect(result.turns.reduce((n: number, t: any) => n + t.omittedItems, 0)).toBeGreaterThan(0);
    expect(result.turns.length).toBe(10);
  } finally { f.close(); }
});
test("missing local cache fails closed and invalid limits do not reach Desktop", () => {
  const f = fixture([[{ type: "imageGeneration", result: "test" }]]);
  try {
    expect(() => boundedThreadHistory({ threadId: "test-thread", turnLimit: 99 }, f.home)).toThrow("Invalid history limit");
    expect(() => boundedThreadHistory({ threadId: "test-thread" }, join(f.home, "missing"))).toThrow("unavailable");
  } finally { f.close(); }
});

const stockServer = join(homedir(), ".codex/plugins/cache/openai-bundled/codex-app-tools/0.1.4/server.mjs");
test.skipIf(process.env.CODEX_HISTORY_GUARD_MCP_TEST !== "1")("real MCP server intercepts large reads before Desktop RPC and passes unrelated tools unchanged", async () => {
  const f = fixture([[{ type: "imageGeneration", result: "MEDIA-PAYLOAD".repeat(100000), savedPath: "fixture.png" }]]);
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\history-guard-test-${crypto.randomUUID()}` : join(f.home, "test.sock");
  const source = readFileSync(stockServer, "utf8");
  const receipt = source.startsWith("// Local bounded-history guard") ? JSON.parse(readFileSync(join(homedir(), ".codex/plugins/cache/openai-bundled/codex-app-tools/0.1.4/history-guard-receipt.json"), "utf8")) : null;
  const original = receipt ? readFileSync(join(receipt.backup, "server.mjs"), "utf8") : source;
  writeFileSync(join(f.home, "server.mjs"), patchHistoryServer(original));
  for (const file of ["history-guard-adapter.mjs", "bounded-thread-history.ts"]) copyFileSync(join(import.meta.dir, "../scripts", file), join(f.home, file));
  writeFileSync(join(f.home, "history-guard-config.json"), JSON.stringify({ bun: process.execPath }));
  const forwarded: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const host = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0), req = JSON.parse(buffer.subarray(4, length + 4).toString()); buffer = buffer.subarray(length + 4);
        if (req.method === "tools/call") forwarded.push(req.params.tool);
        const result = req.method === "tools/list" ? { tools: ["read_thread", "wait_threads", "get_usage_limits"].map(name => ({ name, namespace: "codex_app", inputSchema: { type: "object" } })) }
          : { success: true, contentItems: [{ type: "inputText", text: "FORWARDED" }] };
        const data = Buffer.from(JSON.stringify({ id: req.id, jsonrpc: "2.0", result })), frame = Buffer.alloc(data.length + 4);
        frame.writeUInt32LE(data.length, 0); data.copy(frame, 4); socket.write(frame);
      }
    });
  });
  await new Promise<void>(resolve => host.listen(pipe, resolve));
  const client = new Client({ name: "fixture", version: "1" });
  const command = receipt ? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe") : process.execPath;
  const testedServer = receipt ? stockServer : join(f.home, "server.mjs");
  const transport = new StdioClientTransport({ command, args: [testedServer, "--interaction-client-id", "test-caller"],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined)), CODEX_HOME: f.home, CODEX_APP_TOOLS_PIPE_PATH: pipe }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const read = await client.callTool({ name: "read_thread", arguments: { threadId: "test-thread", includeOutputs: false, maxOutputCharsPerItem: 1500 } });
    expect(read.isError).toBe(false); expect(JSON.stringify(read)).toContain("resultOmitted"); expect(JSON.stringify(read)).not.toContain("MEDIA-PAYLOAD"); expect(forwarded).toEqual([]);
    const wait = await client.callTool({ name: "wait_threads", arguments: { targets: [{ threadId: "test-thread" }], timeoutMs: 0 } });
    expect(wait.isError).toBe(true); expect(JSON.stringify(wait)).toContain("unsafe_full_history_wait_blocked"); expect(forwarded).toEqual([]);
    await client.callTool({ name: "get_usage_limits", arguments: {} });
    await client.callTool({ name: "read_thread", arguments: { threadId: "test-thread", hostId: "remote" } });
    expect(forwarded).toEqual(["get_usage_limits", "read_thread"]);
  } finally {
    await client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => host.close(() => resolve())); f.close();
  }
}, 30000);
