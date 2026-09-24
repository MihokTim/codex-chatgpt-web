import { isDeepStrictEqual } from "node:util";
import { namespacedToolName, type CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import { hasCompleteNativeToolHistory, nativeToolResultProof } from "./failed-thinking-recovery";
import type { ChatGptTurnSession } from "./turn-execution";

/** Prove that a fresh summary can replace this source without losing or replaying local work. */
export function hasCompleteCompactionHistory(parsed: CodexParsedRequest, source: ChatGptTurnSession): boolean {
  const delivered = source.deliveredToolResultProofs();
  if (!delivered) return false;
  const proofs = new Map(delivered);
  const calls = parsed.context.messages.flatMap(message => message.role === "assistant"
    ? message.content.filter(part => part.type === "toolCall") : []);
  for (const pending of source.outstanding()) {
    const matchingCalls = calls.filter(call => call.id === pending.callId);
    const matchingResults = parsed.context.messages.filter(message => message.role === "toolResult"
      && message.toolCallId === pending.callId);
    if (matchingCalls.length !== 1 || matchingResults.length !== 1) return false;
    const call = matchingCalls[0]!;
    const result = matchingResults[0]!;
    if (result.role !== "toolResult"
      || namespacedToolName(call.namespace, call.name) !== pending.wireName
      || namespacedToolName(result.toolNamespace, result.toolName) !== pending.wireName
      || !isDeepStrictEqual(call.arguments, pending.freeform ? { input: pending.input ?? "" } : pending.arguments ?? {})) return false;
    proofs.set(pending.callId, nativeToolResultProof(result));
  }
  return hasCompleteNativeToolHistory(parsed, proofs, source.issuedToolCallProofs());
}

/**
 * Automatic compaction already owns the completed native tool results. Feeding them back into
 * the nearly full source just to ask it to stop starts another unnecessary reasoning phase.
 * Retire at this boundary and summarize the canonical history in a fresh, tool-free context.
 */
export async function retireActiveCompactionBoundary(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  retire: () => Promise<unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  return source.runExclusive(async () => {
    signal.throwIfAborted();
    if (!source.isActive() || source.runtime.mode !== "tools" || !source.outstanding().length) return false;
    if (!hasCompleteCompactionHistory(parsed, source)) {
      throw new ChatGptWebAdapterError(
        "Codex context handoff is missing or conflicts with completed tool history. Resume from the latest saved work.",
        { status: 409, errorType: "invalid_request_error", code: "compaction_history_incomplete", retryable: false },
      );
    }
    // Retirement revokes the old browser capability and waits for its physical release. Never
    // completeTool here: the effects already happened in Codex and must only be summarized.
    await retire();
    signal.throwIfAborted();
    return true;
  });
}
