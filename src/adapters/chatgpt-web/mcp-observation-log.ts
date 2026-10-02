import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

const EVENTS = new Set([
  "call_received", "reply_sent", "reply_send_failed", "uncorrelated_call", "transport_closed",
]);
const TOOLS = new Set([
  "codex_turn_start", "codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image",
  "codex_tool_inventory", "codex_tool_call", "codex_turn_complete", "unknown",
]);

export interface McpObservationLog {
  readonly filePath: string;
  write(event: Record<string, unknown>): void;
  close(): void;
}

/**
 * A process-owned, append-only UTF-8 receipt log. Never serialize arguments,
 * tokens, paths, request IDs, result content, or arbitrary error strings.
 * The byte ceiling is per process; reaching it leaves an explicit gap marker.
 * File/stderr failures are observational and cannot change a tool response.
 */
export function createMcpObservationLog(options: {
  directory: string;
  maxBytes?: number;
  stderr?: (line: string) => void;
}): McpObservationLog {
  const maxBytes = options.maxBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) {
    throw new Error("MCP observation log maxBytes must be an integer of at least 512");
  }
  const filePath = join(options.directory, `mcp-${process.pid}-${randomBytes(8).toString("hex")}.jsonl`);
  const stderr = options.stderr ?? (line => console.error(line));
  let fd: number | undefined;
  let bytes = 0;
  let seq = 0;
  const close = (): void => {
    if (fd === undefined) return;
    const owned = fd;
    fd = undefined;
    try { closeSync(owned); } catch { /* Best-effort observation only. */ }
  };
  const encode = (event: Record<string, unknown>): string => JSON.stringify({
    version: 1, at: new Date().toISOString(), pid: process.pid, seq: seq++, ...event,
  }) + "\n";
  const emitStderr = (line: string): void => {
    try { stderr(`[chatgpt-web-mcp] transport=${line.trimEnd()}`); } catch { /* Preserve transport. */ }
  };
  const append = (line: string): void => {
    if (fd === undefined) return;
    const buffer = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written === 0) throw new Error("No observation bytes written");
      offset += written;
    }
    bytes += buffer.length;
  };
  const unavailable = (reason: "open_failed" | "write_failed"): void => {
    close();
    emitStderr(encode({ event: "observation_unavailable", reason }));
  };
  try {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    // Keep the exclusive descriptor: later appends never follow a replaced path.
    fd = openSync(filePath, "wx", 0o600);
    const started = encode({ event: "observation_started", max_bytes: maxBytes });
    append(started);
    emitStderr(started);
  } catch { unavailable("open_failed"); }

  return {
    filePath,
    close,
    write(event) {
      if (typeof event.event !== "string" || !EVENTS.has(event.event)) return;
      const safe: Record<string, unknown> = { event: event.event };
      if (typeof event.tool === "string") safe.tool = TOOLS.has(event.tool) ? event.tool : "unknown";
      for (const key of ["call", "elapsed_ms", "tracked_calls"]) {
        const value = event[key];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
      }
      if (typeof event.is_error === "boolean") safe.is_error = event.is_error;
      if (event.outcome === "result" || event.outcome === "protocol_error") safe.outcome = event.outcome;
      if (event.reason === "duplicate_id" || event.reason === "tracking_limit") safe.reason = event.reason;
      const line = encode(safe);
      emitStderr(line);
      if (fd !== undefined) {
        try {
          // Reserve enough room to report that observation stopped, rather than
          // making absent events look like proof of absent tool calls.
          if (bytes + Buffer.byteLength(line, "utf8") > maxBytes - 256) {
            const stopped = encode({ event: "observation_stopped", reason: "capacity_reached" });
            append(stopped);
            emitStderr(stopped);
            close();
          } else append(line);
        } catch { unavailable("write_failed"); }
      }
      if (event.event === "transport_closed") close();
    },
  };
}
