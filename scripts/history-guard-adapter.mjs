import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// Read beside this module, not from tool-supplied paths or commands.
const config = JSON.parse(readFileSync(new URL("./history-guard-config.json", import.meta.url), "utf8"));
const helper = fileURLToPath(new URL("./bounded-thread-history.ts", import.meta.url));
function project(args, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(config.bun, ["run", helper], {
      windowsHide: true, timeout: 15000, maxBuffer: 768 * 1024, signal,
    }, (error, stdout) => {
      try {
        const reply = JSON.parse(stdout);
        if (reply.error) reject(new Error(reply.error));
        else if (error) reject(new Error("Bounded history worker failed"));
        else resolve(reply.result);
      } catch { reject(new Error("Bounded history worker unavailable; full-history fallback was blocked")); }
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(args));
  });
}
export async function protectLocalHistoryRead(name, args, signal) {
  if (name !== "read_thread" && name !== "wait_threads") return null;
  try {
    if (name === "read_thread") {
      const result = await project(args ?? {}, signal);
      return result == null ? null : { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
    }
    // wait_threads also requests full items in Desktop 26.915.4065.0.
    // Do not fake live status or completion from a persisted SQLite snapshot.
    const targets = args?.targets;
    if (!Array.isArray(targets) || targets.length > 8) return null;
    const snapshots = [];
    for (const target of targets) {
      const result = await project({ threadId: target.threadId, hostId: target.hostId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1000 }, signal);
      if (result != null) snapshots.push(result);
    }
    if (snapshots.length === 0) return null;
    return { isError: true, content: [{ type: "text", text: JSON.stringify({
      error: "unsafe_full_history_wait_blocked", eventWaitPerformed: false,
      message: "Desktop wait_threads would load oversized/media-bearing history. Use bounded read_thread for these tasks and inspect persisted artifacts; these snapshots do not prove live completion.",
      snapshots: snapshots.map(snapshot => ({ thread: snapshot.thread, safety: snapshot.safety,
        latestPersistedTurn: snapshot.turns[0] ? { id: snapshot.turns[0].id, status: snapshot.turns[0].status } : null })),
    }) }] };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { isError: true, content: [{ type: "text", text: JSON.stringify({
      error: "bounded_history_unavailable", message: String(error?.message ?? "History projection failed"),
      unsafeFallbackAttempted: false,
    }) }] };
  }
}
