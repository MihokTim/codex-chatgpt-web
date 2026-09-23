import { getNativeCodexHome } from "../../native-codex-home";
import { parseRequest } from "../../responses/parser";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptRootThreadMetadata,
  extractChatGptThreadSpawnLineage,
  extractChatGptTurnIdentity,
} from "./environment";
import { resolveChatGptRequestEnvironment } from "./codex-rollout-environment";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

const NATIVE_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ID = new RegExp(`^${NATIVE_ID}$`, "i");
const ITEM_ID = new RegExp(`^fco_${NATIVE_ID}$`, "i");
const ENVELOPE = new RegExp(`^<codex_delegation>\\s*<source_thread_id>(${NATIVE_ID})</source_thread_id>\\s*<input>([\\s\\S]+)</input>\\s*</codex_delegation>$`, "i");

/** App-created tasks receive native deliveries, not results of a tool the recipient called. */
export function normalizeCodexAppDelegations(
  parsed: CodexParsedRequest,
  codexHome = getNativeCodexHome(),
): CodexParsedRequest {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const deliveries = input.flatMap(value => {
    const item = record(value);
    // Actual tool results, including arbitrary XML in their output, retain their ordinary role.
    if (item?.type !== "function_call_output" || item.namespace !== "codex_app"
      || (item.name !== "create_thread" && item.name !== "send_message_to_thread")
      || item.call_id != null) return [];
    const owner = record(item.internal_chat_message_metadata_passthrough)?.turn_id;
    if (typeof item.id !== "string" || !ITEM_ID.test(item.id)
      || typeof owner !== "string" || !ID.test(owner)
      || typeof item.output !== "string" || !ENVELOPE.test(item.output)) {
      throw new Error("Codex app delegation has an invalid native envelope");
    }
    return [item];
  });
  if (deliveries.length === 0) return parsed;
  const identity = extractChatGptTurnIdentity(parsed);
  const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
  if (!lineage || !identity.turnId) throw new Error("Codex app delegation requires native destination metadata");
  const verified = new Set(deliveries);
  const normalized = parseRequest({
    ...body,
    input: input.map(value => {
      const item = record(value);
      if (!item || !verified.has(item)) return value;
      // Preserve the complete source envelope, native id and turn ownership in the instruction.
      // Only the in-memory provider input changes; the canonical Codex history stays untouched.
      return {
        type: "message", id: item.id, role: "user",
        content: [{ type: "input_text", text: item.output }],
        internal_chat_message_metadata_passthrough: item.internal_chat_message_metadata_passthrough,
      };
    }),
  });
  normalized._replayPrefixLen = parsed._replayPrefixLen;
  resolveChatGptRequestEnvironment(normalized, { codexHome, nativeDelegations: deliveries });
  return normalized;
}
