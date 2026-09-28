import { ChatGptWebAdapterError } from "./adapter-error";

/** Process-lifetime cancellation authority, bounded independently of replay-cache lifetime. */
export class NativeTurnInterruptions {
  private readonly reasons = new Map<string, Error>();
  private saturated = false;

  constructor(private readonly capacity = 4_096) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Native interruption capacity must be positive");
  }

  private key(threadId: string, turnId: string): string {
    if (!threadId.trim() || !turnId.trim()) throw new Error("Native interruption requires non-empty native thread and turn ids");
    return JSON.stringify([threadId, turnId]);
  }

  remember(threadId: string, turnId: string, reason: Error): void {
    const key = this.key(threadId, turnId);
    if (this.reasons.has(key)) return;
    if (this.reasons.size === this.capacity) {
      // Never evict an old cancellation and thereby authorize a delayed replay. Continue
      // delivering targeted cancellation, but refuse new starts until an idle restart.
      this.saturated = true;
      return;
    }
    this.reasons.set(key, reason);
  }

  interruption(threadId: string, turnId: string): Error | undefined {
    return this.reasons.get(this.key(threadId, turnId));
  }

  startError(threadId: string, turnId: string): Error | undefined {
    return this.interruption(threadId, turnId) ?? (this.saturated ? new ChatGptWebAdapterError(
      "Native turn interruption tracking is full. Save the current work and restart the bridge when it is idle.",
      { status: 409, errorType: "invalid_request_error", code: "native_interrupt_tracking_full", retryable: false },
    ) : undefined);
  }
}
