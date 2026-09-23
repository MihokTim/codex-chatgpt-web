import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeMetadata, tail } from "../scripts/collect-codex-incident";

test("incident collector reads only a bounded tail, dropping the first partial record", () => {
  const root = mkdtempSync(join(tmpdir(), "incident-test-"));
  try {
    const file = join(root, "source.log");
    writeFileSync(file, "DO-NOT-READ-PREFIX" + "x".repeat(1_000_000) + "\nlast-record\n");
    expect(tail(file, 40)).toBe("last-record\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native incident projection keeps correlation and failure markers without message or tool payloads", () => {
  const record = nativeMetadata('2026-09-21T11:00:00.000Z info [AppServerConnection] Sending server response tool=read_thread threadId=thread_123 requestId=req_456 durationMs=12 prompt="SECRET PROMPT" result="data:image/png;base64,SECRET" authorization=SECRET');
  expect(record).toMatchObject({ at: "2026-09-21T11:00:00.000Z", tool: "read_thread", threadId: "thread_123", requestId: "req_456", durationMs: "12", markers: ["read_thread", "Sending server response"] });
  expect(JSON.stringify(record)).not.toContain("SECRET");
  expect(JSON.stringify(record)).not.toContain("data:image");
});
