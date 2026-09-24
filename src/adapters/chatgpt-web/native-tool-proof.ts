import { createHash } from "node:crypto";
import { namespacedToolName } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function proof(kind: string, name: string, arguments_: unknown): string {
  // Object key order is not part of a JSON tool invocation; array order and text are.
  const canonical = JSON.stringify([kind, name, arguments_], (_key, value: unknown) =>
    record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Capture the call before it leaves the broker, not from a later claimed history. */
export function issuedToolCallProof(request: BrokerToolRequest): string {
  const kind = request.freeform ? "custom_tool_call"
    : request.wireName === "tool_search" ? "tool_search_call" : "function_call";
  return proof(kind, request.wireName, request.freeform ? request.input ?? "" : request.arguments ?? {});
}

/** Reject malformed call evidence even when the general history parser tolerates it. */
export function nativeToolCallProof(item: Record<string, unknown>): string | undefined {
  if (item.type === "tool_search_call") {
    return record(item.arguments) ? proof(item.type, "tool_search", item.arguments) : undefined;
  }
  if (typeof item.name !== "string" || !item.name
    || (item.namespace != null && typeof item.namespace !== "string")) return undefined;
  const namespace = typeof item.namespace === "string" ? item.namespace : undefined;
  const name = namespacedToolName(namespace, item.name);
  if (item.type === "custom_tool_call") {
    return typeof item.input === "string" ? proof(item.type, name, item.input) : undefined;
  }
  if (item.type !== "function_call" || typeof item.arguments !== "string") return undefined;
  try {
    const arguments_: unknown = JSON.parse(item.arguments.trim() || "{}");
    return record(arguments_) ? proof(item.type, name, arguments_) : undefined;
  } catch { return undefined; }
}

export const NATIVE_TOOL_OUTPUT_TYPES: Readonly<Record<string, string>> = {
  function_call: "function_call_output",
  custom_tool_call: "custom_tool_call_output",
  tool_search_call: "tool_search_output",
};
