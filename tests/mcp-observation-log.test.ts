import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as z from "zod/v4";
import { createMcpObservationLog } from "../src/adapters/chatgpt-web/mcp-observation-log";
import { observeMcpToolCalls } from "../src/adapters/chatgpt-web/mcp-observation";

function rows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("private per-process receipt files contain only allowlisted telemetry", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-log-"));
  const stderr: string[] = [];
  const log = createMcpObservationLog({ directory: join(root, "logs"), stderr: line => stderr.push(line) });
  const secret = "private-token-command-path-日本語-\uFFFD";
  try {
    log.write({ event: "call_received", tool: secret, call: 1, arguments: { token: secret }, request_id: secret });
    log.write({ event: "reply_sent", tool: "codex_exec", call: 1, is_error: true, outcome: "result", content: secret });
    log.write({ event: "transport_closed", tracked_calls: 0 });
    const content = readFileSync(log.filePath, "utf8");
    const result = rows(log.filePath);
    expect(result.map(row => row.event)).toEqual(["observation_started", "call_received", "reply_sent", "transport_closed"]);
    expect(result.map(row => row.seq)).toEqual([0, 1, 2, 3]);
    expect(result[1]).toMatchObject({ tool: "unknown", call: 1 });
    expect(result[2]).toMatchObject({ is_error: true, outcome: "result" });
    expect(result.every(row => Number.isFinite(Date.parse(String(row.at))))).toBeTrue();
    expect(content).not.toContain(secret);
    expect(stderr.join("\n")).not.toContain(secret);
    expect(content).not.toContain("request_id");
    if (process.platform !== "win32") expect(statSync(log.filePath).mode & 0o077).toBe(0);
  } finally { log.close(); rmSync(root, { recursive: true, force: true }); }
});

test("byte limit explicitly marks the observation gap and does not overwrite evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-cap-"));
  const first = createMcpObservationLog({ directory: root, maxBytes: 512, stderr: () => {} });
  const second = createMcpObservationLog({ directory: root, maxBytes: 512, stderr: () => {} });
  try {
    for (let call = 1; call <= 100; call += 1) first.write({ event: "call_received", tool: "codex_exec", call });
    expect(statSync(first.filePath).size).toBeLessThanOrEqual(512);
    expect(rows(first.filePath).at(-1)).toMatchObject({ event: "observation_stopped", reason: "capacity_reached" });
    expect(first.filePath).not.toBe(second.filePath);
    expect(rows(second.filePath)).toHaveLength(1);
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test("unwritable file sink and throwing stderr preserve real MCP validation and handler results", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-sink-error-"));
  const blockedDirectory = join(root, "not-a-directory");
  writeFileSync(blockedDirectory, "preserve me");
  const log = createMcpObservationLog({ directory: blockedDirectory, stderr: () => { throw new Error("sink down"); } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "log-test", version: "1" });
  let executions = 0;
  server.registerTool("codex_exec", { inputSchema: { fixture: z.literal("test") } }, async () => {
    executions += 1;
    return { content: [{ type: "text", text: "unchanged-result" }] };
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    await server.connect(observeMcpToolCalls(serverTransport, new Set(["codex_exec"]), log.write));
    await client.connect(clientTransport);
    const invalid = await client.callTool({ name: "codex_exec", arguments: {} });
    expect(invalid.isError).toBeTrue();
    expect(executions).toBe(0);
    const valid = await client.callTool({ name: "codex_exec", arguments: { fixture: "test" } });
    expect(valid.content).toEqual([{ type: "text", text: "unchanged-result" }]);
    expect(executions).toBe(1);
    expect(readFileSync(blockedDirectory, "utf8")).toBe("preserve me");
  } finally {
    await client.close(); await server.close(); log.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("real stdio CLI persists pre-handler validation receipts without a live broker", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-stdio-log-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dir, "../src/cli.ts"), "mcp"],
    env: { CODEX_CHATGPT_WEB_HOME: root },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "isolated-observation-test", version: "1" });
  try {
    await client.connect(transport);
    const inventory = await client.listTools();
    const descriptor = inventory.tools.find(tool => tool.name === "codex_exec");
    expect(descriptor?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    const invalid = await client.callTool({ name: "codex_exec", arguments: {} });
    expect(invalid.isError).toBeTrue();
    const folder = join(root, "diagnostics", "mcp");
    const files = readdirSync(folder);
    expect(files).toHaveLength(1);
    const events = rows(join(folder, files[0]));
    expect(events.map(event => event.event)).toEqual(["observation_started", "call_received", "reply_sent"]);
    expect(events[2]).toMatchObject({ tool: "codex_exec", is_error: true });
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
