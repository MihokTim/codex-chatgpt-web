import { createHash } from "node:crypto";
import type { CodexParsedRequest, CodexToolResultMessage } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptTurnSession } from "./turn-execution";

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function nativeToolResultProof(message: CodexToolResultMessage): string {
  // Timestamps are transport metadata; content, tool identity and error state are evidence.
  return digest([message.toolName, message.toolNamespace ?? null, message.content, message.isError]);
}

function nativeInput(parsed: CodexParsedRequest): unknown[] | undefined {
  const body = parsed._rawBody as { input?: unknown } | undefined;
  return Array.isArray(body?.input) ? body.input : undefined;
}

/** Fail closed unless every issued tool result is still present in canonical native history. */
export function hasCompleteRecoveryHistory(parsed: CodexParsedRequest, session: ChatGptTurnSession): boolean {
  const proofs = session.completedToolResultProofs();
  return proofs !== undefined && hasCompleteNativeToolHistory(parsed, proofs);
}

export function hasCompleteNativeToolHistory(parsed: CodexParsedRequest, proofs: ReadonlyMap<string, string>): boolean {
  const input = nativeInput(parsed);
  if (!input?.length) return false;
  const results = new Map<string, string>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult") continue;
    if (results.has(message.toolCallId)) return false;
    results.set(message.toolCallId, nativeToolResultProof(message));
  }
  if ([...proofs].some(([id, proof]) => results.get(id) !== proof)) return false;
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== "object") continue;
    const item = value as { type?: string; call_id?: unknown };
    const isCall = ["function_call", "custom_tool_call", "tool_search_call"].includes(item.type ?? "");
    const isOutput = ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type ?? "");
    if (!isCall && !isOutput) continue;
    if (typeof item.call_id !== "string" || !item.call_id) return false;
    const set = isCall ? calls : outputs;
    if (set.has(item.call_id)) return false;
    set.add(item.call_id);
  }
  return [...calls].every(id => outputs.has(id)) && [...outputs].every(id => calls.has(id))
    && [...proofs.keys()].every(id => calls.has(id) && outputs.has(id));
}

interface RecoveryEntry {
  source: WeakRef<ChatGptTurnSession>;
  inputLength: number;
  inputHash: string;
  ready: Promise<void>;
  replacementStarted: boolean;
}

/** One recovery per physical context epoch, shared by all HTTP reconnect observers. */
export class FailedThinkingRecoveryPolicy {
  private readonly entries = new Map<string, RecoveryEntry>();

  entry(key: string): RecoveryEntry | undefined { return this.entries.get(key); }

  startReplacement(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.replacementStarted) {
      throw new ChatGptWebAdapterError(
        "The one automatic ChatGPT continuation was already started and its session is no longer available. Resume explicitly from the latest saved work.",
        { status: 409, errorType: "invalid_request_error", code: "chatgpt_recovery_already_used", retryable: false },
      );
    }
    // The session registry can expire a completed response. Its eviction must never replenish
    // this budget or let a delayed native reconnect create a third physical browser response.
    entry.replacementStarted = true;
  }

  assertHistory(key: string, parsed: CodexParsedRequest): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const input = nativeInput(parsed);
    if (!input || input.length < entry.inputLength || digest(input.slice(0, entry.inputLength)) !== entry.inputHash) {
      throw new ChatGptWebAdapterError(
        "A stale or changed native request cannot restart the recovered ChatGPT task. Resume from the latest saved tool results.",
        { status: 409, errorType: "invalid_request_error", code: "chatgpt_recovery_history_mismatch", retryable: false },
      );
    }
  }

  reserve(key: string, parsed: CodexParsedRequest, source: ChatGptTurnSession, prepare: () => Promise<void>): Promise<void> | undefined {
    const previous = this.entries.get(key);
    if (previous) return previous.source.deref() === source ? previous.ready : undefined;
    const input = nativeInput(parsed);
    // Keep fences for the process lifetime. Never evict one and silently permit stale replay.
    if (!input?.length || this.entries.size >= 512) return undefined;
    const ready = Promise.resolve().then(prepare);
    void ready.catch(() => {});
    this.entries.set(key, { source: new WeakRef(source), inputLength: input.length, inputHash: digest(input), ready, replacementStarted: false });
    return ready;
  }
}

export const failedThinkingRecoveryPolicy = new FailedThinkingRecoveryPolicy();
