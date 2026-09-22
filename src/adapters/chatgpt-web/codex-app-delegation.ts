import { getCodexHome } from "../../codex-integration-shared";
import { resolve, toNamespacedPath } from "node:path";
import { parseRequest } from "../../responses/parser";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptCompactionSourceRevision,
  extractChatGptRootThreadMetadata,
  extractChatGptThreadSpawnLineage,
  extractChatGptTurnIdentity,
  extractChatGptTurnEnvironment,
  hasCurrentChatGptEnvironmentContext,
} from "./environment";
import { resolveCurrentCodexRolloutEnvironment } from "./codex-rollout-environment";

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
  codexHome = getCodexHome(),
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
  const compactionSourceTurnId = normalized._compactionRequest
    ? extractChatGptCompactionSourceRevision(normalized).turnId : undefined;
  const environment = resolveCurrentCodexRolloutEnvironment({
    codexHome, lineage, turnId: identity.turnId, tools: parsed.context.tools, nativeDelegations: deliveries,
    ...(compactionSourceTurnId ? { compactionSourceTurnId } : {}),
  });
  if (!environment) throw new Error("Codex app delegation requires its native destination rollout");
  if (hasCurrentChatGptEnvironmentContext(normalized)) {
    const claim = extractChatGptTurnEnvironment(normalized);
    const paths = (values: string[]) => values.map(value => process.platform === "win32"
      ? toNamespacedPath(resolve(value)).toLowerCase() : resolve(value)).sort();
    const samePaths = (left: string[], right: string[]) => JSON.stringify(paths(left)) === JSON.stringify(paths(right));
    if (!samePaths([claim.cwd], [environment.cwd]) || !samePaths(claim.roots, environment.roots)
      || !samePaths(claim.writableRoots, environment.writableRoots)
      || claim.sandboxPolicy.type !== environment.sandboxPolicy.type
      || (claim.sandboxPolicy.type !== "dangerFullAccess" && environment.sandboxPolicy.type !== "dangerFullAccess"
        && claim.sandboxPolicy.networkAccess !== environment.sandboxPolicy.networkAccess)) {
      throw new Error("Codex app delegation environment conflicts with its native destination");
    }
  }
  return normalized;
}
