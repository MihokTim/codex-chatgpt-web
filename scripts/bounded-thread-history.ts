import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HISTORY_REPLY_BYTES = 256 * 1024;
const RAW_ITEM_BYTES = 32 * 1024;
const MAX_SQL_JSON_BYTES = 8 * 1024 * 1024;
const PAGE_SOURCE_BYTES = 256 * 1024;
const CURSOR_PREFIX = "bounded-history-v1:";
export interface HistoryArgs { threadId: string; hostId?: string; cursor?: string; turnLimit?: number; includeOutputs?: boolean; maxOutputCharsPerItem?: number }
type Row = Record<string, any>;

// This reads a persisted projection, not the live Desktop conversation manager.
// No rollout, image result, or attachment body is loaded into the JS process.
export function boundedThreadHistory(args: HistoryArgs, home = process.env.CODEX_HOME || join(homedir(), ".codex")): Row | null {
  if (args.hostId != null && args.hostId !== "local") return null;
  if (typeof args.threadId !== "string" || !/^[a-z0-9-]{1,100}$/i.test(args.threadId)) return null;
  const statePath = join(home, "state_5.sqlite");
  if (!existsSync(statePath)) throw new Error("Local history metadata is unavailable; unsafe Desktop fallback was not attempted");
  const state = new Database(statePath, { readonly: true });
  let history: Database | undefined;
  try {
    state.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    const thread = state.query(`SELECT id, substr(name,1,2000) AS name, substr(title,1,2000) AS title,
      substr(preview,1,2000) AS preview, substr(cwd,1,4000) AS cwd, created_at, updated_at,
      rollout_path, history_mode FROM threads WHERE id=?`).get(args.threadId) as Row | null;
    // ChatGPT conversations and remote tasks retain the native implementation.
    if (!thread) return null;
    history = new Database(join(home, "thread_history_1.sqlite"), { readonly: true });
    history.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    const limit = integer(args.turnLimit, 1, 10, 1);
    const chars = integer(args.maxOutputCharsPerItem, 0, 20000, 2000);
    let anchor: Row | null = null;
    if (args.cursor != null) {
      let cursor = args.cursor;
      if (cursor.startsWith(CURSOR_PREFIX)) {
        const parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString());
        if (parsed.threadId !== args.threadId) throw new Error("History cursor belongs to another task");
        cursor = parsed.turnId;
      } else if (cursor.startsWith("{")) {
        const parsed = JSON.parse(cursor);
        if (parsed.includeAnchor !== false) throw new Error("Unsupported native history cursor");
        cursor = parsed.turnId;
      }
      if (typeof cursor !== "string") throw new Error("Invalid history cursor");
      anchor = history.query("SELECT rollout_ordinal FROM thread_turns WHERE thread_id=? AND turn_id=?").get(args.threadId, cursor) as Row | null;
      if (!anchor) throw new Error("Unknown history cursor; unsafe Desktop fallback was not attempted");
    }
    const rows = history.query(`SELECT turn_id, rollout_ordinal, status, started_at, completed_at, duration_ms,
      substr(error_json,1,2000) AS error_excerpt FROM thread_turns WHERE thread_id=? AND rollout_ordinal<?
      ORDER BY rollout_ordinal DESC LIMIT ?`).all(args.threadId, anchor?.rollout_ordinal ?? Number.MAX_SAFE_INTEGER, limit + 1) as Row[];
    const turns = rows.slice(0, limit);
    const totals = turns.map(turn => history!.query(`SELECT count(*) AS count, coalesce(sum(octet_length(item_json)),0) AS bytes,
      coalesce(max(octet_length(item_json)),0) AS largest, coalesce(sum(item_type='imageGeneration'),0) AS images
      FROM thread_items WHERE thread_id=? AND turn_id=?`).get(args.threadId, turn.turn_id) as Row);
    let rolloutBytes: number | null = null;
    try { rolloutBytes = statSync(thread.rollout_path).size; } catch { /* Cache may outlive the source. */ }
    const projection = history.query("SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id=?").get(args.threadId) as Row | null;
    const projectionCaughtUp = rolloutBytes != null && projection != null
      ? projection.next_rollout_byte_offset === rolloutBytes : null;
    const sourceBytes = totals.reduce((sum, row) => sum + row.bytes, 0);
    // A stale or unverifiable projection cannot prove that Desktop's live full-item read is safe.
    const shouldGuard = projectionCaughtUp !== true || args.cursor?.startsWith(CURSOR_PREFIX) || sourceBytes > PAGE_SOURCE_BYTES
      || totals.some(row => row.images > 0 || row.largest > RAW_ITEM_BYTES)
      || (thread.history_mode !== "paginated" && (rolloutBytes ?? 0) > PAGE_SOURCE_BYTES);
    if (!shouldGuard) return null;
    const nextCursor = rows.length > limit && turns.length ? CURSOR_PREFIX + Buffer.from(JSON.stringify({ threadId: args.threadId, turnId: turns.at(-1)!.turn_id })).toString("base64url") : null;
    const result: Row = {
      schemaVersion: 1,
      source: "bounded_local_persisted_history",
      warning: "Persisted snapshot, not a live task-status query. Media bodies are omitted. Text, item count, and total response bytes are bounded. Read saved artifacts separately when needed.",
      thread: { id: thread.id, kind: "codex", hostId: "local", title: thread.name ?? thread.title, preview: thread.preview,
        cwd: thread.cwd, createdAt: thread.created_at, updatedAt: thread.updated_at, status: { type: "unknown", reason: "persisted_snapshot" } },
      page: { order: "newest_first", limit, nextCursor, hasMore: nextCursor !== null },
      safety: { mediaBodiesOmitted: true, maxResponseBytes: HISTORY_REPLY_BYTES, selectedStoredBytes: sourceBytes,
        rolloutBytes, projectionByteOffset: projection?.next_rollout_byte_offset ?? null,
        projectionCaughtUp },
      turns: [],
    };
    let budget = HISTORY_REPLY_BYTES - Buffer.byteLength(JSON.stringify(result)) - 16384;
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index]!;
      const output: Row = { id: turn.turn_id, status: turn.status, startedAt: turn.started_at, completedAt: turn.completed_at,
        durationMs: turn.duration_ms, errorExcerpt: turn.error_excerpt, items: [], totalItems: totals[index]!.count, omittedItems: 0 };
      const metadata = history.query(`SELECT substr(item_id,1,200) AS id, substr(item_type,1,100) AS type,
        rollout_ordinal, octet_length(item_json) AS storedBytes FROM thread_items
        WHERE thread_id=? AND turn_id=? ORDER BY rollout_ordinal LIMIT 300`).all(args.threadId, turn.turn_id) as Row[];
      for (const meta of metadata) {
        if (budget < 1024) break;
        const selected = history.query(`SELECT
          CASE WHEN item_type!='imageGeneration' AND octet_length(item_json)<=? THEN item_json END AS small,
          ${["status", "text", "phase", "revisedPrompt", "savedPath", "command", "cwd", "tool", "server", "name", "path", "query", "prompt", "aggregatedOutput"].map(key => `CASE WHEN octet_length(item_json)<=${MAX_SQL_JSON_BYTES} THEN substr(json_extract(item_json,'$.${key}'),1,?) END AS ${key}`).join(",")}
          FROM thread_items WHERE thread_id=? AND turn_id=? AND item_id=?`).get(RAW_ITEM_BYTES,
          ...Array(14).fill(Math.min(chars, 2000)), args.threadId, turn.turn_id, meta.id) as Row;
        let item: Row;
        if (selected.small != null) {
          item = sanitizeItem(JSON.parse(selected.small), args.includeOutputs === true, chars);
        } else {
          item = { type: meta.type, id: meta.id, storedBytes: meta.storedBytes, truncated: true };
          for (const [key, value] of Object.entries(selected)) {
            if (key === "small" || value == null || (key === "aggregatedOutput" && !args.includeOutputs)) continue;
            item[key === "aggregatedOutput" ? "outputExcerpt" : key] = value;
          }
          if (meta.type === "userMessage" && meta.storedBytes <= MAX_SQL_JSON_BYTES) {
            const parts = history.query(`SELECT substr(json_extract(j.value,'$.type'),1,100) AS type,
              CASE WHEN json_extract(j.value,'$.type')='text' THEN substr(json_extract(j.value,'$.text'),1,?) END AS text
              FROM thread_items t, json_each(t.item_json,'$.content') j WHERE t.thread_id=? AND t.turn_id=? AND t.item_id=? LIMIT 12`)
              .all(Math.min(chars, 2000), args.threadId, turn.turn_id, meta.id) as Row[];
            item.content = parts.map(p => p.type === "text" ? p : { type: p.type, bodyOmitted: true });
          }
          if (meta.type === "imageGeneration") item.resultOmitted = true;
        }
        const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes > budget) break;
        output.items.push(item); budget -= bytes;
      }
      output.omittedItems = output.totalItems - output.items.length;
      result.turns.push(output);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > HISTORY_REPLY_BYTES) throw new Error("Bounded history response exceeded its hard byte limit");
    return result;
  } finally { history?.close(); state.close(); }
}

function integer(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid history limit");
  return value;
}

function sanitizeItem(raw: Row, includeOutputs: boolean, chars: number): Row {
  const out: Row = { type: raw.type, id: raw.id };
  // Explicit scalar allowlist: unknown item variants never copy arbitrary media or tool payloads.
  for (const key of ["text", "status", "phase", "command", "cwd", "exitCode", "durationMs", "server", "tool", "name", "path", "savedPath", "query", "model", "reasoningEffort", "success", "prompt", "revisedPrompt"]) {
    const value = raw[key];
    if (typeof value === "string") { out[key] = value.slice(0, chars); if (value.length > chars) out.truncated = true; }
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  if (raw.type === "userMessage") out.content = (raw.content ?? []).slice(0, 12).map((part: Row) => part.type === "text"
    ? { type: "text", text: String(part.text ?? "").slice(0, chars), truncated: String(part.text ?? "").length > chars }
    : { type: part.type, bodyOmitted: true, ...typeof part.path === "string" ? { path: part.path.slice(0, 4000) } : {} });
  if (Array.isArray(raw.summary)) out.summary = raw.summary.slice(0, 8).map((s: unknown) => String(s).slice(0, chars));
  if (raw.arguments != null) out.argumentsExcerpt = JSON.stringify(raw.arguments).slice(0, chars);
  if (includeOutputs) for (const key of ["aggregatedOutput", "output"]) if (raw[key] != null) {
    const text = typeof raw[key] === "string" ? raw[key] : JSON.stringify(raw[key]);
    out.output = { text: text.slice(0, chars), truncated: text.length > chars, originalChars: text.length };
  }
  return out;
}

if (import.meta.main) {
  try {
    const input = await Bun.stdin.text();
    if (input.length > 16000) throw new Error("History arguments too large");
    console.log(JSON.stringify({ result: boundedThreadHistory(JSON.parse(input)) }));
  } catch (error) { console.log(JSON.stringify({ error: error instanceof Error ? error.message : "History projection failed" })); process.exitCode = 1; }
}
